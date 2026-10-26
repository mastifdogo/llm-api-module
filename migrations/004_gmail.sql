-- Gmail (through the Apps Script bridge) identifies messages by text ids, not IMAP UIDs.
ALTER TABLE mail_seen ALTER COLUMN uid TYPE text USING uid::text;
