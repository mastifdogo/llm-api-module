-- Runs once, as the module's own role, in its own schema (mod_categorizer).

-- Provider settings edited on the module's page. The API key lives here
-- unless CATEGORIZER_API_KEY / ANTHROPIC_API_KEY is set in /etc/ledger/ledger.env.
CREATE TABLE settings (
    key   text PRIMARY KEY,
    value text NOT NULL
);

-- One uploaded statement file.
CREATE TABLE statements (
    id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    filename        text        NOT NULL,
    account_code    text        NOT NULL,         -- the bank / card account the statement is for
    format          text        NOT NULL,         -- csv | ofx
    status          text        NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'categorizing', 'ready', 'error')),
    error           text,
    duplicates      integer     NOT NULL DEFAULT 0, -- rows skipped because they were uploaded before
    uploaded_by     text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    categorized_at  timestamptz
);

-- Transactions staged for review. Posted rows are kept so a re-upload of an
-- overlapping statement does not post them twice (fingerprint).
CREATE TABLE transactions (
    id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    statement_id     bigint      NOT NULL REFERENCES statements (id) ON DELETE CASCADE,
    line_no          integer     NOT NULL,
    account_code     text        NOT NULL,
    fingerprint      text        NOT NULL,
    tx_date          date        NOT NULL,
    description      text        NOT NULL,
    memo             text        NOT NULL DEFAULT '',
    amount_cents     bigint      NOT NULL,       -- signed, from the statement account's side: + money in, - money out
    fitid            text        NOT NULL DEFAULT '',
    suggested_code   text,
    confidence       real,
    reason           text        NOT NULL DEFAULT '',
    source           text        NOT NULL DEFAULT ''
                     CHECK (source IN ('', 'llm', 'rule', 'error')),
    chosen_code      text,
    status           text        NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'posting', 'posted', 'skipped')),
    journal_entry_id bigint,
    error            text,
    posted_by        text,
    posted_at        timestamptz,
    CONSTRAINT transactions_fingerprint_unique UNIQUE (account_code, fingerprint)
);
CREATE INDEX transactions_statement ON transactions (statement_id, line_no);

-- Payee -> account rules learned when you post transactions.
CREATE TABLE rules (
    payee_key    text        PRIMARY KEY,
    account_code text        NOT NULL,
    example      text        NOT NULL,
    hits         integer     NOT NULL DEFAULT 1,
    updated_by   text        NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
