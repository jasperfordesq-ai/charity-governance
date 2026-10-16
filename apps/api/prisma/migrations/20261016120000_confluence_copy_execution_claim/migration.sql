BEGIN;
CREATE TABLE public."ConfluenceCopyExecutionClaim" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL,
  "permissionId" TEXT NOT NULL UNIQUE,
  "operationId" TEXT NOT NULL CHECK ("operationId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "actorUserId" TEXT NOT NULL,
  "snapshotSha256" TEXT NOT NULL CHECK ("snapshotSha256" ~ '^[a-f0-9]{64}$'),
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  phase TEXT NOT NULL DEFAULT 'QUARANTINED' CHECK (phase='QUARANTINED'),
  "providerIOAuthorised" BOOLEAN NOT NULL DEFAULT false CHECK (NOT "providerIOAuthorised"),
  "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(id,"organisationId"), UNIQUE("organisationId","operationId"), UNIQUE("permissionId","organisationId"),
  FOREIGN KEY("permissionId","organisationId") REFERENCES public."ConfluenceRetainedCopyPermission"(id,"organisationId") ON DELETE RESTRICT
);
CREATE FUNCTION public."ConfluenceCopyExecutionClaim_guard_fn"() RETURNS trigger AS $$
DECLARE p public."ConfluenceRetainedCopyPermission"%ROWTYPE;
  scope public."ConfluenceSyntheticCopyScope"%ROWTYPE;
  connection public."OrganisationIntegration"%ROWTYPE;
  review public."ConfluenceRetainedCopyReview"%ROWTYPE;
  clock TIMESTAMP(3);
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Confluence execution claims are append-only'; END IF;
  IF current_setting('fsync')<>'on' OR current_setting('synchronous_commit') NOT IN ('on','remote_apply','remote_write') THEN
    RAISE EXCEPTION 'Confluence execution claim requires durable WAL';
  END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=NEW."organisationId" AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence execution claim requires an active charity'; END IF;
  PERFORM 1 FROM public."User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence execution claim requires an active Owner'; END IF;
  IF EXISTS (SELECT 1 FROM public."DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Confluence execution claim requires independent history integration';
  END IF;
  SELECT * INTO p FROM public."ConfluenceRetainedCopyPermission" WHERE id=NEW."permissionId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence execution permission unavailable'; END IF;
  PERFORM public."ConfluenceCopyPermission_current_review"(p."reviewId",p."organisationId");
  SELECT * INTO scope FROM public."ConfluenceSyntheticCopyScope" WHERE id=p."scopeId" AND "organisationId"=p."organisationId" FOR UPDATE;
  SELECT * INTO review FROM public."ConfluenceRetainedCopyReview" WHERE id=p."reviewId" AND "organisationId"=p."organisationId";
  SELECT * INTO connection FROM public."OrganisationIntegration" WHERE id=p."integrationId" AND "organisationId"=p."organisationId" FOR UPDATE;
  clock := timezone('UTC',clock_timestamp());
  IF p."expiresAt"<=clock OR scope."expiresAt" IS NULL OR scope."expiresAt"<=clock OR review."expiresAt"<=clock
    OR NEW."snapshotSha256" IS DISTINCT FROM p."snapshotSha256"
    OR EXISTS (SELECT 1 FROM public."ConfluenceRetainedCopyPermissionWithdrawal" WHERE "permissionId"=p.id)
    OR connection.id IS NULL OR connection.provider<>'CONFLUENCE' OR connection.status<>'CONNECTED'
    OR connection."connectedAt" IS DISTINCT FROM p."connectionGeneration"
    OR connection.config->>'siteId' IS DISTINCT FROM review.review->'snapshot'->>'cloudId'
    OR (connection.config->>'siteUrl' IS DISTINCT FROM review.review->'snapshot'->>'siteOrigin'
      AND connection.config->>'siteUrl' IS DISTINCT FROM (review.review->'snapshot'->>'siteOrigin')||'/')
    OR NOT (ARRAY['read:page:confluence','read:attachment:confluence']::TEXT[] <@ connection."grantedScopes") THEN
    RAISE EXCEPTION 'Confluence execution claim requires current unwithdrawn permission and exact grant';
  END IF;
  NEW."claimedAt" := clock;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
CREATE TRIGGER "ConfluenceCopyExecutionClaim_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."ConfluenceCopyExecutionClaim"
  FOR EACH ROW EXECUTE FUNCTION public."ConfluenceCopyExecutionClaim_guard_fn"();
CREATE TRIGGER "ConfluenceCopyExecutionClaim_no_truncate" BEFORE TRUNCATE ON public."ConfluenceCopyExecutionClaim"
  FOR EACH STATEMENT EXECUTE FUNCTION public."ConfluenceCopyExecutionClaim_guard_fn"();
-- V1 archives contain eight decision/publication groups, not consumption.
-- Do not publish a new supposedly complete archive that omits a local claim.
CREATE FUNCTION public."ConfluenceCopyClaim_archive_guard_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM public."Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public."ConfluenceCopyExecutionClaim" WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Confluence execution claims require compatible independent archive integration';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
CREATE TRIGGER "A_ConfluenceCopyLedgerCapture_execution_claim" BEFORE INSERT ON public."ConfluenceCopyLedgerCapture"
  FOR EACH ROW EXECUTE FUNCTION public."ConfluenceCopyClaim_archive_guard_fn"();
COMMIT;
