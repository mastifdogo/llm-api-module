from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from decimal import Decimal


@dataclass
class Transaction:
    date: str  # ISO 8601 (YYYY-MM-DD)
    description: str
    amount: Decimal  # negative = money out, positive = money in
    id: str = ""
    payee: str = ""
    memo: str = ""
    account: str = ""

    def __post_init__(self) -> None:
        self.amount = Decimal(str(self.amount))
        if not self.id:
            raw = f"{self.date}|{self.description}|{self.amount}|{self.memo}"
            self.id = hashlib.sha1(raw.encode()).hexdigest()[:12]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["amount"] = str(self.amount)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Transaction":
        known = {k: d[k] for k in ("date", "description", "amount", "id", "payee", "memo", "account") if k in d}
        return cls(**known)


@dataclass
class Suggestion:
    transaction_id: str
    category: str
    confidence: float  # 0.0 - 1.0
    reason: str = ""
    source: str = "llm"  # "llm" | "memory" | "fallback"
    alternatives: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)
