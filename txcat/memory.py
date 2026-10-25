"""SQLite store of user-confirmed categorizations.

Confirmed categories are used two ways: an exact payee match skips the LLM entirely,
and recent confirmations are fed to the LLM as examples of how you categorize.
"""
from __future__ import annotations

import os
import re
import sqlite3
import threading
from datetime import datetime, timezone

from .models import Transaction

_STRIP = [
    re.compile(r"\b(pos|debit|credit|purchase|preauth|pre-auth|visa|mc|card|ach|eft|online|recurring)\b"),
    re.compile(r"#?\d{3,}"),  # store numbers, card suffixes, reference numbers
    re.compile(r"\b\d{1,2}/\d{1,2}(/\d{2,4})?\b"),  # embedded dates
    re.compile(r"[^a-z& ]"),
]


def normalize_payee(text: str) -> str:
    """Reduce a raw bank description to a stable key, e.g. 'POS SHELL #1234 TORONTO' -> 'shell toronto'."""
    s = text.lower()
    for pattern in _STRIP:
        s = pattern.sub(" ", s)
    return " ".join(s.split())[:60]


class Memory:
    def __init__(self, path: str):
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS confirmations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    payee_key TEXT NOT NULL,
                    description TEXT NOT NULL,
                    amount TEXT NOT NULL,
                    category TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_conf_payee ON confirmations(payee_key);
                """
            )

    def record(self, txn: Transaction, category: str) -> None:
        key = normalize_payee(txn.payee or txn.description)
        with self._lock:
            self._conn.execute(
                "INSERT INTO confirmations (payee_key, description, amount, category, created_at) VALUES (?,?,?,?,?)",
                (key, txn.description, str(txn.amount), category, datetime.now(timezone.utc).isoformat()),
            )
            self._conn.commit()

    def lookup(self, txn: Transaction) -> tuple[str, int, int] | None:
        """Return (category, hits_for_that_category, total_hits) for this payee, or None."""
        key = normalize_payee(txn.payee or txn.description)
        if not key:
            return None
        with self._lock:
            rows = self._conn.execute(
                "SELECT category, COUNT(*) AS n, MAX(id) AS latest FROM confirmations "
                "WHERE payee_key = ? GROUP BY category ORDER BY n DESC, latest DESC",
                (key,),
            ).fetchall()
        if not rows:
            return None
        total = sum(r[1] for r in rows)
        return rows[0][0], rows[0][1], total

    def examples(self, limit: int = 60) -> list[tuple[str, str, str]]:
        """Most recent distinct (description, amount, category) confirmations, one per payee."""
        with self._lock:
            return self._conn.execute(
                "SELECT description, amount, category FROM confirmations WHERE id IN ("
                " SELECT MAX(id) FROM confirmations GROUP BY payee_key"
                ") ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()

    def close(self) -> None:
        self._conn.close()
