# txcat — LLM category suggestions for bookkeeping

A small service for your bookkeeping LXC. You give it a bank or credit-card statement and it
suggests a category for each transaction, with a confidence score and a short reason. When
you confirm categories, it learns from them:

- **Payees you've confirmed before** are matched straight from a local SQLite store, with no LLM call.
- **Recent confirmations** are added to the prompt as examples, so the model follows your conventions.
- **Low-confidence or unknown** transactions are marked `needs_review`, so you only check the doubtful ones.

It reads **CSV** (most bank exports: detects date/description/amount or debit/credit columns),
**OFX/QFX/QBO**, and **JSON**. It can call **Claude** (Anthropic API) or a **local model through
Ollama** if you want statements to stay on your network.

## Install (Debian/Ubuntu LXC)

```bash
git clone <this repo> /root/txcat && cd /root/txcat
sudo ./deploy/install.sh
sudo nano /etc/txcat/txcat.env        # ANTHROPIC_API_KEY=sk-ant-...  (an API token is generated for you)
sudo nano /etc/txcat/config.toml      # your chart of accounts, provider, etc.
sudo systemctl start txcat
curl -s localhost:8765/health
```

To use a local model instead, set `provider = "ollama"`, `ollama_url = "http://<ollama-host>:11434"`
and `model = "<a model you've pulled>"`. Larger models (e.g. 14B+) categorize much better than small ones.

## CLI workflow

```bash
txcat categorize march.csv                       # table; "?" marks rows needing review
txcat categorize march.ofx -f csv -o march-review.csv
# open march-review.csv, fix the "category" column where it's wrong, then:
txcat learn march-review.csv                     # teaches txcat your choices
txcat categories                                 # list configured categories
```

## HTTP API

Send `Authorization: Bearer $TXCAT_API_TOKEN` on everything except `/health`.

**Upload a raw statement file:**

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/csv" \
     --data-binary @march.csv "http://bookkeeping-lxc:8765/categorize?filename=march.csv"
```

**Or send transactions your app has already parsed:**

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"transactions":[{"date":"2026-03-01","description":"POS SHELL #1234","amount":"-45.10"}]}' \
     http://bookkeeping-lxc:8765/categorize
```

Response:

```json
{"count": 1, "results": [{
  "transaction": {"date": "2026-03-01", "description": "POS SHELL #1234", "amount": "-45.10", "id": "…", …},
  "suggestion":  {"transaction_id": "…", "category": "Expenses:Fuel", "confidence": 0.93,
                  "reason": "Shell gas station", "source": "llm", "alternatives": ["Expenses:Transportation"]},
  "needs_review": false
}]}
```

`source` is `llm`, `memory` (a confirmed payee) or `fallback` (the LLM call failed; the reason says why).

**Record what the bookkeeper actually chose** (single item, or `{"confirmations": [...]}` for many):

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"transaction":{"date":"2026-03-01","description":"POS SHELL #1234","amount":"-45.10"},"category":"Expenses:Fuel"}' \
     http://bookkeeping-lxc:8765/feedback
```

Or from Python, in-process:

```python
from txcat import Categorizer, Transaction
from txcat.config import load_config

cat = Categorizer(load_config())
[s] = cat.categorize([Transaction("2026-03-01", "NETFLIX.COM", "-16.99")])
cat.confirm(Transaction("2026-03-01", "NETFLIX.COM", "-16.99"), "Expenses:Subscriptions")
```

## Configuration

See [`config.example.toml`](config.example.toml). The most important setting is `categories`.
Use the exact account names from your bookkeeping software so suggestions can be applied
directly. The model can only answer with one of these names (constrained JSON output).
Environment variables override the file: `TXCAT_PROVIDER`, `TXCAT_MODEL`, `ANTHROPIC_API_KEY`,
`TXCAT_OLLAMA_URL`, `TXCAT_DB_PATH`, `TXCAT_HOST`, `TXCAT_PORT`, `TXCAT_API_TOKEN`,
`TXCAT_BATCH_SIZE`, `TXCAT_REVIEW_THRESHOLD`.

With the Claude backend, the default model is `claude-opus-5-5` at low effort, which works well
for classification. Requests also turn on Anthropic's server-side refusal fallback
(`fallbacks: "default"`): if the model declines a batch, the API re-runs it on another model
instead of returning an error. Set `model` to use a different Claude model.

## Privacy

With `provider = "anthropic"`, each transaction's date, description, memo, amount and account
label are sent to the Anthropic API. With `provider = "ollama"`, nothing leaves your network.

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[anthropic,dev]'
.venv/bin/pytest
```
