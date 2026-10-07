BEGIN;
-- A publication row is evidence that a Confluence page or attachment may
-- exist, including when a timed-out worker has not recorded its result.
-- Only a stable, identified copy with an explicit retained-copy decision can
-- coexist with a primary claim. The separate Confluence erasure workflow
-- starts after local document removal, so forbidding every mirror row here
-- would make that workflow unreachable. This does not authorize copy erasure,
-- primary byte action, or recovery enforcement.
CREATE FUNCTION "DocumentPurgeClaim_publication_fence_fn"() RETURNS trigger AS $$
DECLARE copy_decision TEXT;
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  SELECT "dispositionPlan"::jsonb #>> '{CONFLUENCE,disposition}' INTO copy_decision
    FROM "DocumentPurgeAuthorization"
    WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId";
  IF EXISTS (SELECT 1 FROM "DocumentPublication"
    WHERE "organisationId"=NEW."organisationId"
      AND "documentId"=NEW."documentId"
      AND (state NOT IN ('PROCESSED','RETIRED') OR "claimedAt" IS NOT NULL
        OR "cloudId" IS NULL OR "pageId" IS NULL
        OR "erasureRequestedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'Primary purge requires reconciliation of unresolved publication';
  END IF;
  IF EXISTS (SELECT 1 FROM "DocumentPublication"
    WHERE "organisationId"=NEW."organisationId"
      AND "documentId"=NEW."documentId")
    AND copy_decision IS DISTINCT FROM 'RETAIN_APPROVED' THEN
    RAISE EXCEPTION 'Primary purge requires approved retention of identified external copy';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentPurgeClaim_publication_fence"
  BEFORE INSERT ON "DocumentPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPurgeClaim_publication_fence_fn"();

-- Every publication creation/requeue/claim/record operation participates in
-- the same organisation lock as the purge claim. After the claim, only the
-- existing identified copy may be retired/reconciled/explicitly erased; it
-- cannot be republished or redirected. Ordinary no-page orphan cleanup is
-- retained until recovery enforcement is activated.
CREATE FUNCTION "DocumentPublication_purge_fence_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM 1 FROM "Organisation" WHERE id=OLD."organisationId" FOR UPDATE;
    IF OLD."pageId" IS NOT NULL OR OLD."claimedAt" IS NOT NULL
      OR EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
        WHERE "organisationId"=OLD."organisationId")
      OR EXISTS (SELECT 1 FROM "DocumentPurgeClaim"
        WHERE "organisationId"=OLD."organisationId"
          AND "documentId"=OLD."documentId") THEN
      RAISE EXCEPTION 'Document publication evidence cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW."organisationId" IS DISTINCT FROM OLD."organisationId"
      OR NEW."documentId" IS DISTINCT FROM OLD."documentId"
      OR NEW.provider IS DISTINCT FROM OLD.provider THEN
      RAISE EXCEPTION 'Document publication identity cannot be changed';
    END IF;
  END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document publication organisation is unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM "DocumentPurgeClaim"
    WHERE "organisationId"=NEW."organisationId"
      AND "documentId"=NEW."documentId") THEN
    IF TG_OP='INSERT' THEN
      RAISE EXCEPTION 'Document publication is fenced by primary purge';
    END IF;
    IF NEW.state<>'RETIRED'
      OR NEW."cloudId" IS DISTINCT FROM OLD."cloudId"
      OR NEW."spaceId" IS DISTINCT FROM OLD."spaceId"
      OR NEW."pageId" IS DISTINCT FROM OLD."pageId"
      OR NEW."pageTitle" IS DISTINCT FROM OLD."pageTitle"
      OR NEW."attachmentId" IS DISTINCT FROM OLD."attachmentId"
      OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" THEN
      RAISE EXCEPTION 'Document publication is fenced by primary purge';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentPublication_purge_fence"
  BEFORE INSERT OR UPDATE OR DELETE ON "DocumentPublication"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPublication_purge_fence_fn"();
COMMIT;
