-- Transfers between your own accounts: the two statement rows of one transfer
-- (or a row and the journal entry that already records it) are linked so the
-- transfer is posted once.

ALTER TABLE transactions ADD COLUMN transfer_tx_id bigint REFERENCES transactions (id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN transfer_entry_id bigint;        -- an existing journal entry this row duplicates
ALTER TABLE transactions ADD COLUMN rejected_transfer_tx bigint;     -- "not a transfer": don't link these two again
ALTER TABLE transactions ADD COLUMN rejected_transfer_entry bigint;
CREATE INDEX transactions_transfer ON transactions (transfer_tx_id) WHERE transfer_tx_id IS NOT NULL;

ALTER TABLE transactions DROP CONSTRAINT transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check CHECK (source IN ('', 'llm', 'rule', 'error', 'bill', 'transfer'));
