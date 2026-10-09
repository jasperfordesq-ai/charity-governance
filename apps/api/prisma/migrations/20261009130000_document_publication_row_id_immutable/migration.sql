BEGIN;
-- The existing purge fence freezes a publication's charity, document and
-- provider. Its row ID also anchors append-only upload/page-create intents;
-- changing it would detach those facts without changing the remote copy.
CREATE FUNCTION "DocumentPublication_row_id_immutable_fn"() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Document publication row ID cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "A_DocumentPublication_row_id_immutable"
  BEFORE UPDATE OF id ON "DocumentPublication"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPublication_row_id_immutable_fn"();
COMMIT;
