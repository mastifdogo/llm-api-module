# LLM API: a Ledger module

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
- **Bills from email:** checks a mailbox on a schedule (IMAP, read-only), reads bills and receipts
  out of the emails and their PDFs, keeps a list of bills to be paid, and matches each bill to the
  bank transaction that pays it. See [Bills](#bills).

## Install

Needs **Ledger 0.7.0 or newer** (for dashboard to-dos and notifications and the sidebar icon).

The sidebar entry asks for the `robot` icon. Ledger versions whose icon set doesn't include it show
the generic module icon instead. The module's id stays `categorizer` (its page is
`/apps/categorizer` and its data lives in the `mod_categorizer` schema), so renaming it kept all
existing data.

1. Publish a release of this repository. Ledger installs the **latest GitHub Release**:
   bump `version` in `ledger-module.json`, then
   ```sh
   git tag v1.2.0 && git push origin v1.2.0
   ```
   and create a release from the tag on GitHub (not a draft or pre-release).
2. In Ledger, open **Settings → Modules**, enter `mastifdogo/llm-api-module` and press **Add**.
   **LLM API** appears in the sidebar with a robot icon (you can hide or reorder it under Settings → Sidebar).
   Updates install on Ledger's update schedule, or with **Update modules now**.
3. Open **LLM API → Settings**:
   - **Claude:** paste an Anthropic API key, or (to keep it out of the database and its backups)
     add `CATEGORIZER_API_KEY=sk-ant-...` to `/etc/ledger/ledger.env` and run
     `systemctl restart ledger`. The default model is `claude-opus-5-5` at low effort, which
     works well for this kind of classification.
   - **Ollama:** choose *Ollama*, set the server URL (e.g. `http://192.168.1.20:11434`) and a model
     you have pulled. Larger models (14B and up) categorise noticeably better than small ones.
   - Press **Test connection**.

### Accounts it expects

The module creates no accounts. It works with your chart of accounts:

- **Statement accounts:** the bank account (asset) or credit card (liability) each statement
  belongs to, e.g. `1000 Chequing` or `2100 Visa`.
- **Categories:** your expense, revenue and other accounts. The model only suggests active
  accounts in the statement account's currency (CAD or USD).
- **Accounts payable** (optional, liability, e.g. `2000 Accounts payable`): choose it under
  Settings → Email to post approved bills there. One per currency is needed if you get bills in
  both.

### On Ledger's dashboard

- A **notification** per statement that has transactions waiting to be posted
  ("march.csv: 12 transactions to post"; a warning when some need review). It goes away once
  everything is posted, skipped or discarded.
- A **to-do** per unpaid bill, with its due date ("Review bill: Rogers 85.50 CAD", then "Pay
  Rogers 85.50 CAD" after approval). It's ticked when the payment is posted, and removed when the
  bill is ignored or deleted.
- A red **notification** when the scheduled email check fails, cleared by the next good check.

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

## Bills

**Set up:** *Settings → Email*. Enter the IMAP server, user name and password, a folder (or Gmail
label), and how often to check (0 turns scheduled checks off; **Check email now** on the Bills tab
always works).

| Provider | Server | Password |
|---|---|---|
| Gmail | `imap.gmail.com` | an [app password](https://myaccount.google.com/apppasswords) (needs 2-step verification) |
| Outlook.com / Microsoft 365 | `outlook.office365.com` | your password, if IMAP and basic sign-in are allowed |
| iCloud | `imap.mail.me.com` | an app-specific password |
| Fastmail | `imap.fastmail.com` | an app password |
| Proton Mail | Proton Bridge, e.g. `127.0.0.1` port `1143` | the Bridge password |

Implicit TLS on port 993 is used, except for a bridge running on the same machine. The mailbox
is opened read-only: nothing is marked as read, moved or deleted. To keep the password out of
the database and its backups, set `CATEGORIZER_IMAP_PASSWORD=...` in `/etc/ledger/ledger.env`
and restart Ledger.

**What happens on each check:**
1. New messages from the folder are read. The first check goes back 30 days (configurable).
   Each message is looked at once.
2. Only messages containing one of the keywords (invoice, bill, statement, amount due, receipt,
   ...) go to the model. A mail filter that puts bills in their own folder or label keeps
   everything else out.
3. The model reads the email and its PDF attachment (PDFs need Claude; local models only see the
   email text) and returns the vendor, invoice number, dates, amount and a suggested account.
4. Reminders for a bill that's already listed (same vendor and invoice number, or same amount and
   due date) are skipped.

**Review on the Bills tab:** fix anything that's wrong, then **Approve**. You can also upload a
bill (PDF or saved `.eml`) or add one by hand.

**Accounting:**
- *With an accounts payable account* (Settings → Email): approving a bill posts
  Dr *bill's account* / Cr *payables* on the bill date. The bank payment later books
  Dr *payables* / Cr *bank*.
- *Without one:* bills are only tracked, and the payment books straight to the bill's account.
- *Receipts* (already paid, e.g. an online order) are never posted on their own. They tell the
  matching bank transaction which account to use.

**Matching:** when a statement is categorised (or a new bill arrives), each unposted outgoing
transaction with **exactly** a bill's amount, dated from a week before the bill date to 45 days
after the due date (receipts: a few days around the purchase), is linked to it. A matching vendor
name raises the confidence. Matched rows show **Bill nn%**, use the payables (or bill) account,
and aren't sent to the model. Posting a matched row marks the bill **paid**. On a bill, **Not this
one** unlinks a wrong match, and **This is the payment** links one by hand.

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
| `GET`/`PUT` | `/mail/settings`; `POST /mail/test`, `POST /mail/check`, `GET /mail/log` | mailbox settings (the password is never returned), a connection test, a check now, the messages looked at |
| `GET`/`POST` | `/bills?status=unpaid\|new\|open\|paid\|ignored`, `/bills` | list; add by hand `{vendor, amount, due_date, ...}` |
| `POST` | `/bills/upload` | `{filename, content_base64}`: a PDF or `.eml` |
| `GET`/`PATCH`/`DELETE` | `/bills/:id` | one bill with its payment; edit fields or `status`; delete |
| `GET` | `/bills/:id/document` | the stored PDF, base64 |
| `POST` | `/bills/:id/approve`, `/unapprove` | approve (posts to payables if configured); undo (reverses that entry) |
| `GET`/`POST` | `/bills/:id/candidates`, `/match {transaction_id}`, `/unmatch` | manual matching |

## Privacy

With Claude, each transaction's date, description, memo and amount, your account codes, names and
descriptions, and descriptions of recent entries on the statement account are sent to the
Anthropic API. With email checks on, emails that pass the keyword filter (sender, subject, text
and PDF attachments) are sent too. With Ollama or another server on your network, nothing leaves
it. Emails that don't pass the filter are never sent anywhere. Bill PDFs and email text are stored
in the Ledger database.

## Notes on Ledger's module guidelines

- **No dependencies:** only Node built-ins. `server.mjs` imports its own files from `lib/`, which
  install with the release archive.
- **Long timeouts for the LLM:** requests to the model may take up to 180 s, and IMAP up to
  60 s, because classifying a batch of 40 transactions or reading a PDF takes longer than the
  usual 10 s limit for outbound calls.
- **Secrets:** the API key and mailbox password are stored in the module's `settings` table (or
  read from `/etc/ledger/ledger.env`). They are never returned by the API or logged.
- **Layout:** the page works from about 260 px wide (Ledger's side-by-side panes) up to full
  width, in light and dark mode.

## Layout

```
ledger-module.json     manifest
server.mjs             routes, background categorisation, posting
lib/parse.mjs          CSV / OFX parsing, amounts, dates, payee keys
lib/categorize.mjs     prompt, schema, rules, batching
lib/llm.mjs            Anthropic / Ollama / OpenAI-compatible clients (built-in fetch, no dependencies)
lib/bill-routes.mjs    mailbox checks and schedule, bill routes, matching bills to transactions
lib/bills.mjs          bill extraction prompt, duplicates, match scoring
lib/imap.mjs           minimal read-only IMAP client
lib/mime.mjs           email (MIME) parser
lib/dashboard.mjs      notifications and to-dos on Ledger's dashboard
ui/index.html          the page shown in Ledger
migrations/            the module's tables (schema mod_categorizer)
test/                  unit tests: npm test (Node 22+)
```

Ledger installs modules without a build step or `npm install`, so the module has no dependencies.

## Development

Run Ledger (0.7.0+) from a checkout with `MODULES_DIR` pointing at a directory that contains this
repository (or a symlink to it) named `categorizer`; see Ledger's `docs/MODULES.md`. Apply
`migrations/*.sql` in order to the `mod_categorizer` schema. To try it without spending API
credit, point **Server URL** at a local stub that answers like the Messages API. `npm test` runs
the unit tests (Node 22+).
