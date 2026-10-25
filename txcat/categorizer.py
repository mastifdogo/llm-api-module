from __future__ import annotations

import json
import logging

from .config import UNCATEGORIZED, Config
from .llm import Backend, LLMError, make_backend
from .memory import Memory
from .models import Suggestion, Transaction

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a bookkeeping assistant. You assign each bank or credit-card \
transaction to exactly one category from the chart of accounts below.

Chart of accounts:
{categories}

How to decide:
- Amounts are signed: negative is money leaving the account, positive is money coming in. \
Income categories fit positive amounts; expense categories fit negative amounts. Refunds \
(positive amounts from a merchant) belong in that merchant's usual expense category.
- Bank descriptions are terse and noisy (store numbers, city names, processor prefixes like \
SQ*, TST*, PAYPAL*). Identify the underlying merchant before choosing.
- Movements between the owner's own accounts, credit-card payments and e-transfers to self \
are "Transfers".
- If you genuinely cannot tell, use "{uncategorized}" with low confidence rather than guessing.
- confidence is your probability (0 to 1) that the category is the one the bookkeeper would pick.
- reason is one short phrase naming the merchant or clue you relied on.
- alternatives lists up to two other plausible categories, most likely first (may be empty).
{examples}{extra}"""


def _schema(categories: list[str]) -> dict:
    return {
        "type": "object",
        "properties": {
            "suggestions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "category": {"type": "string", "enum": categories},
                        "confidence": {"type": "number"},
                        "reason": {"type": "string"},
                        "alternatives": {"type": "array", "items": {"type": "string", "enum": categories}},
                    },
                    "required": ["id", "category", "confidence", "reason", "alternatives"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["suggestions"],
        "additionalProperties": False,
    }


class Categorizer:
    def __init__(self, cfg: Config, backend: Backend | None = None, memory: Memory | None = None):
        self.cfg = cfg
        self._backend = backend
        self.memory = memory if memory is not None else Memory(cfg.db_path)

    @property
    def backend(self) -> Backend:
        # Created lazily so memory-only runs and feedback calls don't need LLM credentials.
        if self._backend is None:
            self._backend = make_backend(self.cfg)
        return self._backend

    def categorize(self, txns: list[Transaction]) -> list[Suggestion]:
        results: dict[str, Suggestion] = {}
        pending: list[Transaction] = []
        for t in txns:
            s = self._from_memory(t)
            if s:
                results[t.id] = s
            else:
                pending.append(t)

        size = max(1, self.cfg.batch_size)
        for i in range(0, len(pending), size):
            batch = pending[i : i + size]
            for s in self._from_llm(batch):
                results[s.transaction_id] = s
        return [results[t.id] for t in txns]

    def confirm(self, txn: Transaction, category: str) -> None:
        """Record the category the bookkeeper actually chose, so future suggestions learn from it."""
        if category not in self.cfg.categories:
            raise ValueError(f"unknown category {category!r}")
        self.memory.record(txn, category)

    def needs_review(self, s: Suggestion) -> bool:
        return s.category == UNCATEGORIZED or s.confidence < self.cfg.review_threshold

    def _from_memory(self, t: Transaction) -> Suggestion | None:
        hit = self.memory.lookup(t)
        if not hit:
            return None
        category, hits, total = hit
        # Only trust memory when this payee is consistently filed the same way.
        if (
            category == UNCATEGORIZED
            or category not in self.cfg.categories
            or hits < self.cfg.memory_min_hits
            or hits / total < 0.8
        ):
            return None
        confidence = min(0.99, 0.85 + 0.03 * hits)
        return Suggestion(t.id, category, round(confidence, 2), f"confirmed {hits}x for this payee", "memory")

    def _build_system(self) -> str:
        examples = self.memory.examples()
        ex_text = ""
        if examples:
            lines = "\n".join(f"- {d} ({a}) -> {c}" for d, a, c in examples)
            ex_text = f"\nPast categorizations confirmed by this bookkeeper (follow their conventions):\n{lines}\n"
        extra = f"\nAdditional instructions:\n{self.cfg.extra_instructions}\n" if self.cfg.extra_instructions else ""
        return SYSTEM_PROMPT.format(
            categories="\n".join(f"- {c}" for c in self.cfg.categories),
            uncategorized=UNCATEGORIZED,
            examples=ex_text,
            extra=extra,
        )

    def _from_llm(self, batch: list[Transaction]) -> list[Suggestion]:
        payload = [
            {k: v for k, v in {
                "id": t.id,
                "date": t.date,
                "description": t.description,
                "memo": t.memo,
                "amount": str(t.amount),
                "account": t.account,
            }.items() if v}
            for t in batch
        ]
        user = (
            "Categorize each of these transactions. Return one suggestion per id.\n\n"
            + json.dumps(payload, indent=1)
        )
        try:
            data = self.backend.complete_json(self._build_system(), user, _schema(self.cfg.categories))
        except LLMError as e:
            log.error("LLM batch failed: %s", e)
            return [Suggestion(t.id, UNCATEGORIZED, 0.0, f"error: {e}", "fallback") for t in batch]

        by_id = {}
        for item in data.get("suggestions", []):
            if not isinstance(item, dict) or "id" not in item:
                continue
            category = item.get("category", UNCATEGORIZED)
            if category not in self.cfg.categories:
                category = UNCATEGORIZED
            try:
                confidence = max(0.0, min(1.0, float(item.get("confidence", 0))))
            except (TypeError, ValueError):
                confidence = 0.0
            alts = [a for a in item.get("alternatives", []) if a in self.cfg.categories and a != category][:2]
            by_id[str(item["id"])] = Suggestion(
                str(item["id"]), category, round(confidence, 2), str(item.get("reason", "")), "llm", alts
            )
        return [
            by_id.get(t.id) or Suggestion(t.id, UNCATEGORIZED, 0.0, "model returned no suggestion", "fallback")
            for t in batch
        ]
