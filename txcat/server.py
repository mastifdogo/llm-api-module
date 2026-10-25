"""Small JSON HTTP API so the bookkeeping app (or a cron job / n8n / script) can request suggestions.

Endpoints:
  GET  /health                 -> {"status": "ok", ...}
  GET  /categories             -> {"categories": [...]}
  POST /categorize             -> suggestions for transactions or a raw statement
  POST /feedback               -> record the category the bookkeeper actually chose
"""
from __future__ import annotations

import hmac
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import __version__
from .categorizer import Categorizer
from .models import Transaction
from .parsers import StatementParseError, parse_statement

log = logging.getLogger(__name__)
MAX_BODY = 20 * 1024 * 1024


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def handle_categorize(cat: Categorizer, body: bytes, content_type: str, query: dict) -> dict:
    if "json" in content_type:
        data = _json(body)
        if "transactions" in data:
            txns = [Transaction.from_dict(t) for t in data["transactions"]]
        elif "statement" in data:
            txns = parse_statement(data.get("filename", "statement.csv"), data["statement"], data.get("account", ""))
        else:
            raise ApiError(400, "body must contain 'transactions' or 'statement'")
    else:
        # Raw CSV/OFX upload: POST /categorize?filename=march.ofx with the file as the body.
        filename = query.get("filename", ["statement.csv"])[0]
        txns = parse_statement(filename, body.decode("utf-8-sig", errors="replace"), query.get("account", [""])[0])

    suggestions = cat.categorize(txns)
    return {
        "count": len(txns),
        "results": [
            {"transaction": t.to_dict(), "suggestion": s.to_dict(), "needs_review": cat.needs_review(s)}
            for t, s in zip(txns, suggestions)
        ],
    }


def handle_feedback(cat: Categorizer, body: bytes) -> dict:
    data = _json(body)
    items = data.get("confirmations", [data] if "category" in data else [])
    if not items:
        raise ApiError(400, "body must contain 'transaction' + 'category', or 'confirmations': [...]")
    for item in items:
        if "transaction" not in item or "category" not in item:
            raise ApiError(400, "each confirmation needs 'transaction' and 'category'")
        try:
            cat.confirm(Transaction.from_dict(item["transaction"]), item["category"])
        except ValueError as e:
            raise ApiError(400, str(e)) from e
    return {"recorded": len(items)}


def _json(body: bytes) -> dict:
    try:
        data = json.loads(body or b"{}")
    except json.JSONDecodeError as e:
        raise ApiError(400, f"invalid JSON: {e}") from e
    if not isinstance(data, dict):
        raise ApiError(400, "JSON body must be an object")
    return data


def make_handler(cat: Categorizer):
    token = cat.cfg.api_token

    class Handler(BaseHTTPRequestHandler):
        server_version = f"txcat/{__version__}"

        def _send(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            if not token:
                return True
            header = self.headers.get("Authorization", "")
            return hmac.compare_digest(header.encode(), f"Bearer {token}".encode())

        def _dispatch(self, method: str) -> None:
            url = urlparse(self.path)
            try:
                if url.path == "/health" and method == "GET":
                    return self._send(200, {"status": "ok", "version": __version__,
                                            "provider": cat.cfg.provider, "model": cat.cfg.resolved_model})
                if not self._authorized():
                    raise ApiError(401, "missing or invalid bearer token")
                if url.path == "/categories" and method == "GET":
                    return self._send(200, {"categories": cat.cfg.categories})
                if method == "POST" and url.path in ("/categorize", "/feedback"):
                    length = int(self.headers.get("Content-Length") or 0)
                    if length > MAX_BODY:
                        raise ApiError(413, "request body too large")
                    body = self.rfile.read(length)
                    if url.path == "/categorize":
                        ctype = self.headers.get("Content-Type", "")
                        return self._send(200, handle_categorize(cat, body, ctype, parse_qs(url.query)))
                    return self._send(200, handle_feedback(cat, body))
                raise ApiError(404, "not found")
            except ApiError as e:
                self._send(e.status, {"error": str(e)})
            except StatementParseError as e:
                self._send(422, {"error": str(e)})
            except Exception:
                log.exception("unhandled error")
                self._send(500, {"error": "internal error"})

        def do_GET(self) -> None:
            self._dispatch("GET")

        def do_POST(self) -> None:
            self._dispatch("POST")

        def log_message(self, fmt: str, *args) -> None:
            log.info("%s %s", self.address_string(), fmt % args)

    return Handler


def serve(cat: Categorizer) -> None:
    httpd = ThreadingHTTPServer((cat.cfg.host, cat.cfg.port), make_handler(cat))
    log.info("txcat listening on http://%s:%d (provider=%s model=%s)",
             cat.cfg.host, cat.cfg.port, cat.cfg.provider, cat.cfg.resolved_model)
    if not cat.cfg.api_token:
        log.warning("TXCAT_API_TOKEN is not set; the API is open to anything that can reach this port")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
