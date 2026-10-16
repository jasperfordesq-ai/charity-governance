BEGIN;
-- Preserve prior migration checksums. PostgreSQL JSONB renders a numeric value
-- such as 1e63 as 64 decimal digits, so a text regex alone cannot prove a hash
-- was a JSON string. Existing guards separately validate counters and binding.
-- Validate existing evidence; never silently rewrite an immutable capture.
ALTER TABLE public."ConfluenceCopyLedgerCapture"
  ADD CONSTRAINT "Confluence ledger capture control types" CHECK (
    (jsonb_typeof("observedControl"->'digest') IN ('string','null')) IS TRUE
  );
COMMIT;
