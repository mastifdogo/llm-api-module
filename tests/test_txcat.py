import json
import threading
import urllib.request
from decimal import Decimal
from http.server import ThreadingHTTPServer

import pytest

from txcat.categorizer import Categorizer
from txcat.config import Config
from txcat.llm import LLMError
from txcat.memory import Memory, normalize_payee
from txcat.models import Transaction
from txcat.parsers import parse_statement
from txcat.server import make_handler

CSV = """Date,Description,Debit,Credit
03/01/2026,POS SHELL #1234 TORONTO,45.10,
03/02/2026,PAYROLL ACME CORP,,2500.00
03/03/2026,NETFLIX.COM,16.99,
"""

OFX = """OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>12345</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260305120000<TRNAMT>-82.40<FITID>A1<NAME>LOBLAWS 1021<MEMO>GROCERY
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260306<TRNAMT>12.00<FITID>A2<NAME>INTEREST
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
"""


class FakeBackend:
    def __init__(self, mapping=None, fail=False):
        self.mapping = mapping or {}
        self.fail = fail
        self.calls = []

    def complete_json(self, system, user, schema):
        self.calls.append((system, user, schema))
        if self.fail:
            raise LLMError("boom")
        txns = json.loads(user.split("\n\n", 1)[1])
        return {"suggestions": [
            {"id": t["id"], "category": self.mapping.get(t["description"], "Uncategorized"),
             "confidence": 0.9, "reason": "fake", "alternatives": []}
            for t in txns
        ]}


@pytest.fixture
def cfg():
    return Config(db_path=":memory:", batch_size=2)


def test_parse_csv_debit_credit():
    txns = parse_statement("s.csv", CSV)
    assert [t.amount for t in txns] == [Decimal("-45.10"), Decimal("2500.00"), Decimal("-16.99")]
    assert txns[0].date == "2026-03-01"


def test_parse_ofx_sgml():
    txns = parse_statement("s.ofx", OFX)
    assert len(txns) == 2
    assert txns[0].amount == Decimal("-82.40") and txns[0].id == "A1" and txns[0].account == "12345"
    assert txns[1].date == "2026-03-06"


def test_normalize_payee():
    assert normalize_payee("POS SHELL #1234 TORONTO") == normalize_payee("SHELL 5678 TORONTO")


def test_llm_batches_and_validates(cfg):
    backend = FakeBackend({"NETFLIX.COM": "Expenses:Subscriptions", "PAYROLL ACME CORP": "Not A Category"})
    cat = Categorizer(cfg, backend, Memory(":memory:"))
    out = cat.categorize(parse_statement("s.csv", CSV))
    assert len(backend.calls) == 2  # batch_size=2
    assert out[2].category == "Expenses:Subscriptions"
    assert out[1].category == "Uncategorized"  # invalid category rejected
    assert "enum" in json.dumps(backend.calls[0][2])


def test_memory_short_circuits_llm(cfg):
    backend = FakeBackend()
    cat = Categorizer(cfg, backend, Memory(":memory:"))
    cat.confirm(Transaction("2026-02-01", "POS SHELL #9999 TORONTO", "-30"), "Expenses:Fuel")
    out = cat.categorize(parse_statement("s.csv", CSV))
    assert out[0].category == "Expenses:Fuel" and out[0].source == "memory"
    sent = "".join(c[1] for c in backend.calls)
    assert "SHELL" not in sent
    assert "Expenses:Fuel" in backend.calls[0][0]  # confirmations shown as examples


def test_llm_failure_falls_back(cfg):
    cat = Categorizer(cfg, FakeBackend(fail=True), Memory(":memory:"))
    out = cat.categorize(parse_statement("s.csv", CSV))
    assert all(s.source == "fallback" and cat.needs_review(s) for s in out)


def test_confirm_rejects_unknown_category(cfg):
    cat = Categorizer(cfg, FakeBackend(), Memory(":memory:"))
    with pytest.raises(ValueError):
        cat.confirm(Transaction("2026-01-01", "x", "-1"), "Nope")


def test_http_api(cfg):
    cfg.api_token = "secret"
    cat = Categorizer(cfg, FakeBackend({"NETFLIX.COM": "Expenses:Subscriptions"}), Memory(":memory:"))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cat))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_port}"

    def post(path, body, ctype="application/json", token="secret"):
        req = urllib.request.Request(base + path, data=body, method="POST",
                                     headers={"Content-Type": ctype, "Authorization": f"Bearer {token}"})
        return json.load(urllib.request.urlopen(req))

    try:
        with pytest.raises(urllib.error.HTTPError) as e:
            post("/categorize", b"{}", token="wrong")
        assert e.value.code == 401

        res = post("/categorize?filename=s.csv", CSV.encode(), ctype="text/csv")
        assert res["count"] == 3
        assert res["results"][2]["suggestion"]["category"] == "Expenses:Subscriptions"

        txn = res["results"][0]["transaction"]
        assert post("/feedback", json.dumps({"transaction": txn, "category": "Expenses:Fuel"}).encode()) == {"recorded": 1}
        res = post("/categorize", json.dumps({"transactions": [txn]}).encode())
        assert res["results"][0]["suggestion"]["source"] == "memory"
    finally:
        httpd.shutdown()
