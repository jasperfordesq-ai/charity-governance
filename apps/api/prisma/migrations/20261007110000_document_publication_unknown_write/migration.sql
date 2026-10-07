ALTER TYPE "DocumentPublicationTerminalReason" ADD VALUE IF NOT EXISTS 'REMOTE_WRITE_OUTCOME_UNKNOWN';

-- A timeout or unreadable response can conceal a completed page/attachment
-- write. Keep the uncertainty on the row until a future evidenced recovery
-- transition exists. Retirement of an identified page remains possible, but
-- it must preserve the terminal reason as historical evidence.
CREATE FUNCTION "DocumentPublication_unknown_write_fence_fn"() RETURNS trigger AS $$
BEGIN
  IF OLD."terminalReason"::text = 'REMOTE_WRITE_OUTCOME_UNKNOWN'
    AND (NEW.state::text NOT IN ('DEAD_LETTER', 'RETIRED')
      OR NEW."terminalReason" IS DISTINCT FROM OLD."terminalReason") THEN
    RAISE EXCEPTION 'Ambiguous Confluence write requires verified reconciliation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentPublication_unknown_write_fence"
  BEFORE UPDATE ON "DocumentPublication"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPublication_unknown_write_fence_fn"();

CREATE FUNCTION "DocumentPublication_unknown_write_delete_fence_fn"() RETURNS trigger AS $$
BEGIN
  IF OLD."terminalReason"::text = 'REMOTE_WRITE_OUTCOME_UNKNOWN' THEN
    RAISE EXCEPTION 'Ambiguous Confluence write evidence cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentPublication_unknown_write_delete_fence"
  BEFORE DELETE ON "DocumentPublication"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPublication_unknown_write_delete_fence_fn"();
