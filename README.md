# Statement Categorizer: a Ledger module

A module for [Ledger (Bookeeping)](https://github.com/mastifdogo/Bookeeping). You upload a bank or
credit-card statement and an LLM suggests an account from your chart of accounts for each
transaction. You check the suggestions, then post them as journal entries.

- **Formats:** CSV exports (columns are found from the header, or guessed from the data when there's
  no header; single amount or debit/credit columns) and **OFX / QFX / QBO**.
- **Models:** **Claude** (Anthropic API), or a **local model** through **Ollama** or any
  OpenAI-compatible server (LM Studio, llama.cpp, vLLM) so statements stay on your network.
- **Uses your books:** the prompt includes your chart of accounts and how you booked similar
  transactions from the same bank account before. The model can only answer with one of your real
  account codes (the response is constrained to a JSON schema).
- **Learns:** each posted transaction teaches a payee rule (`SHELL #1234 TORONTO` → `SHELL TORONTO`
  → Fuel). Payees with a rule are categorised without calling the model.
- **Safe to re-upload:** transactions already uploaded for that account are skipped, so overlapping
  statements don't post anything twice. Nothing is posted until you press **Post**.
- Low-confidence suggestions are marked **Needs review**; **Select confident** + **Post selected**
  takes care of the rest.

## Install

1. Publish a release of this repository. Ledger installs the **latest GitHub Release**:
   ```sh
   git tag v1.0.0 && git push origin v1.0.0
   ```
   then create a release from the tag on GitHub (not a draft or pre-release).
2. In Ledger, open **Modules**, enter `mastifdogo/llm-api-module` and install. **Categorize**
   appears in the sidebar.
3. Open **Categorize → Settings**:
   - **Claude:** paste an Anthropic API key, or (to keep it out of the database and its backups)
     add `CATEGORIZER_API_KEY=sk-ant-...` to `/etc/ledger/ledger.env` and run
     `systemctl restart ledger`. The default model is `claude-opus-5-5` at low effort, which
     works well for this kind of classification.
   - **Ollama:** choose *Ollama*, set the server URL (e.g. `http://192.168.1.20:11434`) and a model
     you have pulled. Larger models (14B and up) categorise noticeably better than small ones.
   - Press **Test connection**.

Needs Ledger 0.6.0 or newer.

## Use

1. **Upload:** choose the file and the bank or card account it belongs to. For credit-card
   exports that show purchases as positive numbers, tick *flip signs*.
2. Suggestions appear within a few seconds to a minute (40 transactions per request by default).
3. **Review:** change any account in the drop-down (your choice is kept, even if you re-run the
   suggestions), skip rows you don't want to book, then **Post selected**.

Each posted transaction becomes a two-line entry: the statement account on one side, the chosen
account on the other, dated with the transaction date, with the bank's description and its OFX
transaction ID (or `categorizer <statement>/<row>`) as the reference.

Money in → debit the statement account. Money out → credit it. So a purchase on a card
(liability) account credits the card, and a deposit to chequing debits chequing.

## API

All routes are under `/api/v1/m/categorizer` and use your Ledger login.

| Method | Path | |
|---|---|---|
| `POST` | `/statements` | `{filename, content, account_code, flip_signs?, date_order?: "auto"\|"mdy"\|"dmy"}` stages a statement and starts categorising it |
| `GET` | `/statements`, `/statements/:id` | list; one statement with its transactions |
| `POST` | `/statements/:id/categorize` | `{all?: true}` asks the model again (only unposted rows) |
| `POST` | `/statements/:id/post` | `{ids?: [...]}` posts rows that have an account |
| `DELETE` | `/statements/:id` | discards unposted rows |
| `PATCH` | `/transactions/:id` | `{account_code?, status?: "new"\|"skipped"}` |
| `POST` | `/transactions/bulk` | the same for `{ids: [...]}` |
| `POST` | `/suggest` | `{account_code, transactions: [{date, description, amount, memo?}]}` returns suggestions without storing anything (for scripts or other modules) |
| `GET`/`DELETE` | `/rules`, `/rules/:key` | learned payee rules |
| `GET`/`PUT` | `/settings`; `POST /settings/test` | provider settings (the API key is never returned) |

## Privacy

With Claude, each transaction's date, description, memo and amount, your account codes, names and
descriptions, and descriptions of recent entries on the statement account are sent to the
Anthropic API. With Ollama or another server on your network, nothing leaves it.

## Layout

```
ledger-module.json     manifest
server.mjs             routes, background categorisation, posting
lib/parse.mjs          CSV / OFX parsing, amounts, dates, payee keys
lib/categorize.mjs     prompt, schema, rules, batching
lib/llm.mjs            Anthropic / Ollama / OpenAI-compatible clients (built-in fetch, no dependencies)
ui/index.html          the page shown in Ledger
migrations/            the module's tables (schema mod_categorizer)
test/                  unit tests: npm test (Node 22+)
```

Ledger installs modules without a build step or `npm install`, so the module has no dependencies.

## Development

Run Ledger from a checkout with `MODULES_DIR` pointing at a directory that contains a **copy** of
this repository named `categorizer` (see Ledger's `docs/MODULES.md`), and apply
`migrations/001_init.sql` to the `mod_categorizer` schema. To try it without spending API credit,
point **Server URL** at a local stub that answers like the Messages API.
