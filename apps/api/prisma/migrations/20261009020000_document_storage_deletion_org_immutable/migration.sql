BEGIN;
-- A cleanup job's charity is part of its target identity. The purge alias
-- fence has a fast path for updates that keep provider/path unchanged; without
-- this invariant, an unclaimed job could be moved from another charity onto
-- an already protected provider key. Composite links that cascade on update
-- must never be used as a way to transfer disposal authority.
CREATE FUNCTION "DocumentStorageDeletion_organisation_immutable_fn"()
RETURNS trigger AS $$
BEGIN
  IF NEW."organisationId" IS DISTINCT FROM OLD."organisationId" THEN
    RAISE EXCEPTION 'Storage deletion organisation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentStorageDeletion_organisation_immutable"
  BEFORE UPDATE OF "organisationId" ON "DocumentStorageDeletion"
  FOR EACH ROW EXECUTE FUNCTION "DocumentStorageDeletion_organisation_immutable_fn"();
COMMIT;
