"""Parse bank/credit-card statements (CSV, OFX/QFX, JSON) into Transactions."""
from __future__ import annotations

import csv
import io
import json
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .models import Transaction

DATE_FORMATS = ["%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y", "%Y/%m/%d", "%d-%m-%Y", "%b %d, %Y", "%d %b %Y"]

# Header aliases, matched case-insensitively after stripping punctuation.
DATE_COLS = {"date", "transactiondate", "postingdate", "posteddate", "transdate", "postdate"}
DESC_COLS = {"description", "name", "details", "transactiondescription", "narrative", "merchant", "payee"}
MEMO_COLS = {"memo", "notes", "reference", "extendeddescription"}
AMOUNT_COLS = {"amount", "transactionamount", "amountcad", "amountusd", "value"}
DEBIT_COLS = {"debit", "withdrawal", "withdrawals", "moneyout", "debitamount", "paidout"}
CREDIT_COLS = {"credit", "deposit", "deposits", "moneyin", "creditamount", "paidin"}
ID_COLS = {"id", "transactionid", "fitid", "referencenumber"}


class StatementParseError(ValueError):
    pass


def _norm(header: str) -> str:
    return re.sub(r"[^a-z]", "", header.lower())


def parse_date(value: str) -> str:
    value = value.strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    raise StatementParseError(f"unrecognized date: {value!r}")


def parse_amount(value: str) -> Decimal | None:
    value = value.strip()
    if not value:
        return None
    negative = value.startswith("(") and value.endswith(")")
    cleaned = re.sub(r"[^0-9.\-]", "", value)
    if not cleaned or cleaned in {"-", "."}:
        return None
    try:
        amount = Decimal(cleaned)
    except InvalidOperation as e:
        raise StatementParseError(f"unrecognized amount: {value!r}") from e
    return -abs(amount) if negative else amount


def _find(headers: dict[str, str], aliases: set[str]) -> str | None:
    for norm, original in headers.items():
        if norm in aliases:
            return original
    return None


def parse_csv(text: str, account: str = "") -> list[Transaction]:
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    if not reader.fieldnames:
        raise StatementParseError("CSV has no header row")
    headers = {_norm(h): h for h in reader.fieldnames if h}
    date_col = _find(headers, DATE_COLS)
    desc_col = _find(headers, DESC_COLS)
    amount_col = _find(headers, AMOUNT_COLS)
    debit_col = _find(headers, DEBIT_COLS)
    credit_col = _find(headers, CREDIT_COLS)
    memo_col = _find(headers, MEMO_COLS)
    id_col = _find(headers, ID_COLS)
    if not date_col or not desc_col or not (amount_col or debit_col or credit_col):
        raise StatementParseError(
            f"could not identify date/description/amount columns in headers: {reader.fieldnames}"
        )

    txns: list[Transaction] = []
    for row in reader:
        if not (row.get(date_col) or "").strip():
            continue
        if amount_col:
            amount = parse_amount(row.get(amount_col) or "")
        else:
            debit = parse_amount(row.get(debit_col) or "") if debit_col else None
            credit = parse_amount(row.get(credit_col) or "") if credit_col else None
            amount = (abs(credit) if credit else Decimal(0)) - (abs(debit) if debit else Decimal(0))
        if amount is None:
            continue
        txns.append(
            Transaction(
                date=parse_date(row[date_col]),
                description=(row.get(desc_col) or "").strip(),
                amount=amount,
                id=(row.get(id_col) or "").strip() if id_col else "",
                memo=(row.get(memo_col) or "").strip() if memo_col else "",
                account=account,
            )
        )
    return txns


_OFX_TXN = re.compile(r"<STMTTRN>(.*?)(?:</STMTTRN>|(?=<STMTTRN>)|(?=</BANKTRANLIST>))", re.S | re.I)


def _ofx_field(block: str, tag: str) -> str:
    m = re.search(rf"<{tag}>([^<\r\n]*)", block, re.I)
    return m.group(1).strip() if m else ""


def parse_ofx(text: str, account: str = "") -> list[Transaction]:
    """Parse OFX 1.x (SGML) or 2.x (XML) / QFX statements."""
    if not account:
        account = _ofx_field(text, "ACCTID")
    txns = []
    for block in _OFX_TXN.findall(text):
        raw_date = _ofx_field(block, "DTPOSTED")[:8]
        amount = parse_amount(_ofx_field(block, "TRNAMT"))
        if not raw_date or amount is None:
            continue
        name = _ofx_field(block, "NAME")
        memo = _ofx_field(block, "MEMO")
        txns.append(
            Transaction(
                date=datetime.strptime(raw_date, "%Y%m%d").date().isoformat(),
                description=name or memo,
                amount=amount,
                id=_ofx_field(block, "FITID"),
                payee=name,
                memo=memo if name else "",
                account=account,
            )
        )
    return txns


def parse_json(text: str, account: str = "") -> list[Transaction]:
    data = json.loads(text)
    if isinstance(data, dict):
        data = data.get("transactions", [])
    txns = []
    for item in data:
        t = Transaction.from_dict(item)
        t.account = t.account or account
        txns.append(t)
    return txns


def parse_statement(source: str | Path, content: str | None = None, account: str = "") -> list[Transaction]:
    """Parse a statement, choosing the format from the file extension or content sniffing."""
    name = str(source)
    if content is None:
        content = Path(source).read_text(encoding="utf-8-sig", errors="replace")
    ext = Path(name).suffix.lower()
    head = content.lstrip()[:200].upper()
    if ext in {".ofx", ".qfx", ".qbo"} or "OFXHEADER" in head or "<OFX>" in head:
        return parse_ofx(content, account)
    if ext == ".json" or head.startswith(("[", "{")):
        return parse_json(content, account)
    return parse_csv(content, account)
