from __future__ import annotations

import argparse
import csv
import json
import logging
import sys

from .categorizer import Categorizer
from .config import UNCATEGORIZED, load_config
from .models import Transaction
from .parsers import StatementParseError, parse_amount, parse_date, parse_statement

OUTPUT_FIELDS = ["id", "date", "description", "amount", "suggested_category", "confidence",
                 "needs_review", "reason", "alternatives", "category"]


def cmd_categorize(cat: Categorizer, args) -> int:
    txns = parse_statement(args.statement, account=args.account)
    if not txns:
        print("no transactions found", file=sys.stderr)
        return 1
    suggestions = cat.categorize(txns)
    rows = []
    for t, s in zip(txns, suggestions):
        rows.append({
            "id": t.id, "date": t.date, "description": t.description, "amount": str(t.amount),
            "suggested_category": s.category, "confidence": s.confidence,
            "needs_review": cat.needs_review(s), "reason": s.reason,
            "alternatives": "; ".join(s.alternatives),
            # Pre-filled so you can edit this column and feed the file back with `txcat learn`.
            "category": s.category,
        })

    out = open(args.output, "w", newline="") if args.output else sys.stdout
    try:
        if args.format == "json":
            json.dump(rows, out, indent=2)
            out.write("\n")
        elif args.format == "csv":
            writer = csv.DictWriter(out, fieldnames=OUTPUT_FIELDS)
            writer.writeheader()
            writer.writerows(rows)
        else:
            for r in rows:
                flag = "?" if r["needs_review"] else " "
                print(f"{flag} {r['date']}  {r['amount']:>10}  {r['description'][:40]:<40}  "
                      f"{r['suggested_category']:<28} {r['confidence']:.2f}  {r['reason']}", file=out)
    finally:
        if args.output:
            out.close()
    review = sum(r["needs_review"] for r in rows)
    print(f"{len(rows)} transactions, {review} flagged for review", file=sys.stderr)
    return 0


def cmd_learn(cat: Categorizer, args) -> int:
    """Read a reviewed CSV (from `categorize --format csv`) and record the final 'category' column."""
    count = 0
    with open(args.reviewed, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            category = (row.get("category") or "").strip()
            if not category or category == UNCATEGORIZED:
                continue
            txn = Transaction(date=parse_date(row["date"]), description=row["description"],
                              amount=parse_amount(row["amount"]), id=row.get("id", ""))
            cat.confirm(txn, category)
            count += 1
    print(f"recorded {count} confirmations", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="txcat", description="LLM category suggestions for statement transactions")
    p.add_argument("-c", "--config", help="path to config.toml (default: $TXCAT_CONFIG or /etc/txcat/config.toml)")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="command", required=True)

    c = sub.add_parser("categorize", help="suggest categories for a statement file (CSV, OFX/QFX, JSON)")
    c.add_argument("statement")
    c.add_argument("-f", "--format", choices=["table", "csv", "json"], default="table")
    c.add_argument("-o", "--output")
    c.add_argument("--account", default="")

    l = sub.add_parser("learn", help="record confirmed categories from a reviewed CSV")
    l.add_argument("reviewed")

    sub.add_parser("serve", help="run the HTTP API")
    sub.add_parser("categories", help="list configured categories")

    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load_config(args.config)

    if args.command == "categories":
        print("\n".join(cfg.categories))
        return 0

    cat = Categorizer(cfg)
    try:
        if args.command == "categorize":
            return cmd_categorize(cat, args)
        if args.command == "learn":
            return cmd_learn(cat, args)
        from .server import serve
        serve(cat)
        return 0
    except (StatementParseError, ValueError, FileNotFoundError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
