BEGIN;
-- Keep the preflight and trigger installation in one stable DML window.
LOCK TABLE "DocumentRecoveryEnforcement", "DocumentPublication",
  "DocumentPublicationUploadIntent", "DocumentPublicationPageCreateIntent"
  IN SHARE ROW EXCLUSIVE MODE;
-- Rows survive deletion of their Document so that remote erasure can still
-- identify old pages. A surviving live Document must nevertheless agree on
-- charity; investigate any mismatch before adding the insert-time fence.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DocumentPublication" publication
    JOIN "Document" document ON document.id=publication."documentId"
    WHERE publication."organisationId"<>document."organisationId") THEN
    RAISE EXCEPTION 'Existing document publication charity mismatch requires review';
  END IF;
END;
$$;
-- The normal remote-write guards retain a publication row alongside each
-- append-only intent. An orphan can still exist after a privileged repair or
-- malformed restore; never bind while that possible-copy evidence remains.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement" binding
    WHERE EXISTS (SELECT 1 FROM "DocumentPublicationUploadIntent" intent
      WHERE intent."organisationId"=binding."organisationId")
      OR EXISTS (SELECT 1 FROM "DocumentPublicationPageCreateIntent" intent
        WHERE intent."organisationId"=binding."organisationId")) THEN
    RAISE EXCEPTION 'Existing document recovery binding has publication intent history requiring review';
  END IF;
END;
$$;
-- No independently authenticated Confluence copy inventory or replay stream
-- exists yet. Refuse an already-bound charity with publication evidence rather
-- than silently grandfathering a host-loss gap during this migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DocumentPublication" publication
    JOIN "DocumentRecoveryEnforcement" binding
      ON binding."organisationId"=publication."organisationId") THEN
    RAISE EXCEPTION 'Existing document recovery binding has publication history requiring review';
  END IF;
END;
$$;

-- The same Organisation lock serializes new publication rows with binding.
-- An existing row may be PENDING, mid-write, ambiguous, published or retired;
-- all need an independently recoverable copy baseline before activation.
CREATE FUNCTION "DocumentRecoveryEnforcement_publication_quiescence_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DocumentPublication"
    WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Document recovery binding requires independent publication history';
  END IF;
  IF EXISTS (SELECT 1 FROM "DocumentPublicationUploadIntent"
    WHERE "organisationId"=NEW."organisationId")
    OR EXISTS (SELECT 1 FROM "DocumentPublicationPageCreateIntent"
      WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Document recovery binding requires independent publication intent history';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "A_DocumentRecoveryEnforcement_publication_quiescence"
  BEFORE INSERT ON "DocumentRecoveryEnforcement"
  FOR EACH ROW EXECUTE FUNCTION "DocumentRecoveryEnforcement_publication_quiescence_fn"();

-- A future bound charity cannot create a page-producing queue row by direct
-- SQL or alter/erase its local copy identity before the independent protocol
-- is implemented. Existing unbound publication and erasure paths are intact.
CREATE FUNCTION "DocumentPublication_recovery_gate_fn"() RETURNS trigger AS $$
DECLARE charity_id TEXT; source_charity TEXT;
BEGIN
  charity_id := CASE WHEN TG_OP='DELETE' THEN OLD."organisationId" ELSE NEW."organisationId" END;
  PERFORM 1 FROM "Organisation" WHERE id=charity_id FOR UPDATE;
  IF TG_OP='INSERT' THEN
    SELECT "organisationId" INTO source_charity FROM "Document"
      WHERE id=NEW."documentId" AND "deletedAt" IS NULL FOR SHARE;
    IF source_charity IS NULL OR source_charity<>NEW."organisationId" THEN
      RAISE EXCEPTION 'Document publication requires a live same-charity source';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
    WHERE "organisationId"=charity_id) THEN
    RAISE EXCEPTION 'Document publication change requires independent recovery authority';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "A_DocumentPublication_recovery_gate"
  BEFORE INSERT OR UPDATE OR DELETE ON "DocumentPublication"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPublication_recovery_gate_fn"();
COMMIT;
