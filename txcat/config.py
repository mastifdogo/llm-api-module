from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_CATEGORIES = [
    "Income:Salary",
    "Income:Interest",
    "Income:Other",
    "Expenses:Groceries",
    "Expenses:Dining",
    "Expenses:Fuel",
    "Expenses:Transportation",
    "Expenses:Utilities",
    "Expenses:Internet & Phone",
    "Expenses:Rent & Mortgage",
    "Expenses:Insurance",
    "Expenses:Healthcare",
    "Expenses:Subscriptions",
    "Expenses:Shopping",
    "Expenses:Entertainment",
    "Expenses:Travel",
    "Expenses:Bank Fees",
    "Expenses:Taxes",
    "Expenses:Office & Software",
    "Transfers",
    "Uncategorized",
]

UNCATEGORIZED = "Uncategorized"


@dataclass
class Config:
    provider: str = "anthropic"  # "anthropic" | "ollama"
    model: str = ""  # empty = provider default
    anthropic_api_key: str = ""
    ollama_url: str = "http://localhost:11434"
    categories: list[str] = field(default_factory=lambda: list(DEFAULT_CATEGORIES))
    db_path: str = "/var/lib/txcat/txcat.db"
    batch_size: int = 40
    # Confirmed payees with at least this many matching confirmations skip the LLM.
    memory_min_hits: int = 1
    # Suggestions below this confidence are flagged for review.
    review_threshold: float = 0.6
    host: str = "0.0.0.0"
    port: int = 8765
    api_token: str = ""  # if set, HTTP clients must send "Authorization: Bearer <token>"
    timeout: float = 120.0
    extra_instructions: str = ""  # bookkeeping-specific hints appended to the prompt

    @property
    def resolved_model(self) -> str:
        if self.model:
            return self.model
        return "claude-opus-5-5" if self.provider == "anthropic" else "llama3.1:8b"


ENV_MAP = {
    "TXCAT_PROVIDER": "provider",
    "TXCAT_MODEL": "model",
    "ANTHROPIC_API_KEY": "anthropic_api_key",
    "TXCAT_OLLAMA_URL": "ollama_url",
    "TXCAT_DB_PATH": "db_path",
    "TXCAT_HOST": "host",
    "TXCAT_PORT": "port",
    "TXCAT_API_TOKEN": "api_token",
    "TXCAT_BATCH_SIZE": "batch_size",
    "TXCAT_REVIEW_THRESHOLD": "review_threshold",
}


def load_config(path: str | os.PathLike | None = None) -> Config:
    """Load config from TOML (path, $TXCAT_CONFIG, or /etc/txcat/config.toml), then env overrides."""
    cfg = Config()
    candidates = [path, os.environ.get("TXCAT_CONFIG"), "/etc/txcat/config.toml"]
    for p in candidates:
        if p and Path(p).is_file():
            with open(p, "rb") as f:
                data = tomllib.load(f)
            for key, value in data.items():
                if hasattr(cfg, key):
                    setattr(cfg, key, value)
            break
        if p and p == path:
            raise FileNotFoundError(f"config file not found: {p}")

    for env, attr in ENV_MAP.items():
        if env in os.environ:
            current = getattr(cfg, attr)
            raw = os.environ[env]
            setattr(cfg, attr, type(current)(raw) if not isinstance(current, str) else raw)

    if UNCATEGORIZED not in cfg.categories:
        cfg.categories.append(UNCATEGORIZED)
    return cfg
