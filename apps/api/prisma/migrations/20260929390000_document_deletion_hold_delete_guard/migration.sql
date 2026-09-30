-- A placed administrative hold must survive a direct row deletion, not only
-- the ordinary Vault API's conditional delete. This does not determine why a
-- hold was placed or define a retention period.
CREATE FUNCTION "Document_deletion_hold_delete_guard_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."deletionHold" THEN
    RAISE EXCEPTION 'Document deletion hold forbids record removal'
      USING ERRCODE = '23514', CONSTRAINT = 'Document_deletion_hold_delete_guard';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "Document_deletion_hold_delete_guard"
  BEFORE DELETE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "Document_deletion_hold_delete_guard_fn"();
