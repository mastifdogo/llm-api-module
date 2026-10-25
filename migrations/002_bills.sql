-- Bills found in email (or uploaded), and their link to statement transactions.

CREATE TABLE bills (
    id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind             text        NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill', 'receipt')),
    status           text        NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'open', 'paid', 'ignored')),
    vendor           text        NOT NULL DEFAULT '',
    invoice_number   text        NOT NULL DEFAULT '',
    bill_date        date,
    due_date         date,
    amount_cents     bigint      CHECK (amount_cents IS NULL OR amount_cents > 0),
    currency         text        NOT NULL DEFAULT 'CAD',
    account_code     text,                         -- the expense (or other) account the bill is for
    confidence       real,
    summary          text        NOT NULL DEFAULT '',
    error            text,
    -- Where it came from
    source           text        NOT NULL CHECK (source IN ('email', 'upload')),
    message_id       text,
    mail_from        text        NOT NULL DEFAULT '',
    mail_subject     text        NOT NULL DEFAULT '',
    mail_date        timestamptz,
    body_text        text        NOT NULL DEFAULT '',
    document_name    text,
    document_type    text,
    document         bytea,
    -- Accounting
    journal_entry_id bigint,                       -- Dr account / Cr ap_account, when posted on approval
    ap_account       text,                         -- the payable account credited by journal_entry_id
    paid_entry_id    bigint,                       -- the payment entry (from a matched transaction)
    paid_at          timestamptz,
    updated_by       text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bills_message_id ON bills (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX bills_status ON bills (status);

-- Every message looked at, so each is processed once (bill or not).
CREATE TABLE mail_seen (
    folder       text        NOT NULL,
    uidvalidity  bigint      NOT NULL,
    uid          bigint      NOT NULL,
    outcome      text        NOT NULL,             -- bill | receipt | duplicate | not_bill | filtered | too_large | error
    bill_id      bigint      REFERENCES bills (id) ON DELETE SET NULL,
    subject      text        NOT NULL DEFAULT '',
    seen_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (folder, uidvalidity, uid)
);

ALTER TABLE transactions ADD COLUMN bill_id bigint REFERENCES bills (id) ON DELETE SET NULL;
-- A bill you said this transaction does not pay, so it isn't matched again.
ALTER TABLE transactions ADD COLUMN rejected_bill_id bigint;
ALTER TABLE transactions DROP CONSTRAINT transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check CHECK (source IN ('', 'llm', 'rule', 'error', 'bill'));
