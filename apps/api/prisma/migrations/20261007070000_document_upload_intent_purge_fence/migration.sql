BEGIN;
-- An upload intent is committed before provider I/O. A RESERVED intent can
-- still materialise bytes after its request times out, and CLEANUP_PENDING
-- may be racing a separate eraser. The original ATTACHED intent for the
-- exact document is historical evidence and does not block its own purge.
CREATE FUNCTION "DocumentPurgeClaim_upload_intent_fence_fn"() RETURNS trigger AS $$
DECLARE target_provider TEXT; target_path TEXT;
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  SELECT provider, "storagePath" INTO target_provider, target_path
    FROM "DocumentPurgeAuthorization"
    WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId";
  IF target_provider IS NULL OR target_path IS NULL THEN
    RAISE EXCEPTION 'Primary purge upload target is unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM "DocumentUploadIntent"
    WHERE "organisationId"=NEW."organisationId"
      AND provider=target_provider AND "storagePath"=target_path
      AND (state<>'ATTACHED' OR "documentId" IS DISTINCT FROM NEW."documentId")) THEN
    RAISE EXCEPTION 'Primary purge requires reconciliation of unresolved upload intent';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentPurgeClaim_upload_intent_fence"
  BEFORE INSERT ON "DocumentPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPurgeClaim_upload_intent_fence_fn"();

-- Serialise a new reservation for the exact primary target with the claim.
-- No lock is held across provider I/O. A reservation that wins first remains
-- visible and blocks the claim; a claim that wins first rejects the new
-- reservation before any bytes are written.
CREATE FUNCTION "DocumentUploadIntent_purge_fence_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document upload intent organisation is unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM "DocumentPurgeClaim" claim
    JOIN "DocumentPurgeAuthorization" auth ON auth.id=claim."authorizationId"
    WHERE claim."organisationId"=NEW."organisationId"
      AND auth.provider=NEW.provider AND auth."storagePath"=NEW."storagePath") THEN
    RAISE EXCEPTION 'Document upload intent is fenced by primary purge';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentUploadIntent_purge_fence"
  BEFORE INSERT ON "DocumentUploadIntent"
  FOR EACH ROW EXECUTE FUNCTION "DocumentUploadIntent_purge_fence_fn"();

-- Do not silently grandfather an unresolved matching reservation on a host
-- with earlier primary claims. Investigate it before applying this fence.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DocumentPurgeClaim" claim
    JOIN "DocumentPurgeAuthorization" auth ON auth.id=claim."authorizationId"
    JOIN "DocumentUploadIntent" intent
      ON intent."organisationId"=claim."organisationId"
      AND intent.provider=auth.provider
      AND intent."storagePath"=auth."storagePath"
    WHERE intent.state<>'ATTACHED'
      OR intent."documentId" IS DISTINCT FROM claim."documentId") THEN
    RAISE EXCEPTION 'Existing primary purge has unresolved upload intent';
  END IF;
END;
$$;
COMMIT;
