BEGIN;
CREATE TABLE public."ConfluenceCopyExecutionRequest" (
 id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "claimId" TEXT NOT NULL,
 "requestKey" TEXT NOT NULL CHECK ("requestKey" ~ '^[A-Za-z0-9_-]{1,120}$'),
 "actorUserId" TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('TRASH','PURGE')),
 "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
 reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
 phase TEXT NOT NULL DEFAULT 'QUARANTINED' CHECK (phase='QUARANTINED'),
 "providerIOAuthorised" BOOLEAN NOT NULL DEFAULT false CHECK (NOT "providerIOAuthorised"),
 "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(id,"organisationId"), UNIQUE("organisationId","requestKey"), UNIQUE("claimId",action),
 FOREIGN KEY("claimId","organisationId") REFERENCES public."ConfluenceCopyExecutionClaim"(id,"organisationId") ON DELETE RESTRICT
);
CREATE TABLE public."ConfluenceCopyExecutionOutcome" (
 id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "requestId" TEXT NOT NULL UNIQUE,
 "requestOutcome" TEXT NOT NULL CHECK ("requestOutcome" IN ('ACKNOWLEDGED','REFUSED','UNRESOLVED')),
 "reportingBasis" TEXT NOT NULL DEFAULT 'APPLICATION_REPORT' CHECK ("reportingBasis"='APPLICATION_REPORT'),
 "automaticRetryAllowed" BOOLEAN NOT NULL DEFAULT false CHECK (NOT "automaticRetryAllowed"),
 "providerAbsenceVerified" BOOLEAN NOT NULL DEFAULT false CHECK (NOT "providerAbsenceVerified"),
 "allCopiesVerified" BOOLEAN NOT NULL DEFAULT false CHECK (NOT "allCopiesVerified"),
 "providerIOAuthorised" BOOLEAN NOT NULL DEFAULT false CHECK (NOT "providerIOAuthorised"),
 "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "recordedByDatabaseRole" TEXT NOT NULL DEFAULT CURRENT_USER,
 UNIQUE("requestId","organisationId"),
 FOREIGN KEY("requestId","organisationId") REFERENCES public."ConfluenceCopyExecutionRequest"(id,"organisationId") ON DELETE RESTRICT
);
CREATE FUNCTION public."ConfluenceCopyExecutionRequest_guard_fn"() RETURNS trigger AS $$
DECLARE claim public."ConfluenceCopyExecutionClaim"%ROWTYPE;
 p public."ConfluenceRetainedCopyPermission"%ROWTYPE;
 scope public."ConfluenceSyntheticCopyScope"%ROWTYPE;
 review public."ConfluenceRetainedCopyReview"%ROWTYPE;
 connection public."OrganisationIntegration"%ROWTYPE;
 clock TIMESTAMP(3);
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Confluence execution journal is append-only'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Confluence execution request requires Read Committed';
 END IF;
 IF current_setting('fsync')<>'on' OR current_setting('synchronous_commit') NOT IN ('on','remote_apply','remote_write') THEN
  RAISE EXCEPTION 'Confluence execution journal requires durable WAL';
 END IF;
 PERFORM 1 FROM public."Organisation" WHERE id=NEW."organisationId" AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Confluence execution request requires an active charity'; END IF;
 PERFORM 1 FROM public."User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
  AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Confluence execution request requires an active Owner'; END IF;
 IF EXISTS (SELECT 1 FROM public."DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId") THEN
  RAISE EXCEPTION 'Confluence execution request requires independent history integration';
 END IF;
 SELECT * INTO claim FROM public."ConfluenceCopyExecutionClaim" WHERE id=NEW."claimId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
 IF NOT FOUND OR claim."actorUserId" IS DISTINCT FROM NEW."actorUserId" THEN
  RAISE EXCEPTION 'Confluence execution request requires its exact initiating claim Owner';
 END IF;
 SELECT * INTO p FROM public."ConfluenceRetainedCopyPermission" WHERE id=claim."permissionId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Confluence execution request permission unavailable'; END IF;
 PERFORM public."ConfluenceCopyPermission_current_review"(p."reviewId",p."organisationId");
 SELECT * INTO scope FROM public."ConfluenceSyntheticCopyScope" WHERE id=p."scopeId" AND "organisationId"=p."organisationId" FOR UPDATE;
 SELECT * INTO review FROM public."ConfluenceRetainedCopyReview" WHERE id=p."reviewId" AND "organisationId"=p."organisationId";
 SELECT * INTO connection FROM public."OrganisationIntegration" WHERE id=p."integrationId" AND "organisationId"=p."organisationId" FOR UPDATE;
 clock := timezone('UTC',clock_timestamp());
 IF clock<claim."claimedAt" OR p."expiresAt"<=clock OR scope."expiresAt" IS NULL OR scope."expiresAt"<=clock OR review."expiresAt"<=clock
  OR claim."snapshotSha256" IS DISTINCT FROM p."snapshotSha256"
  OR EXISTS (SELECT 1 FROM public."ConfluenceRetainedCopyPermissionWithdrawal" WHERE "permissionId"=p.id)
  OR connection.id IS NULL OR connection.provider<>'CONFLUENCE' OR connection.status<>'CONNECTED'
  OR connection."connectedAt" IS DISTINCT FROM p."connectionGeneration"
  OR connection.config->>'siteId' IS DISTINCT FROM review.review->'snapshot'->>'cloudId'
  OR (connection.config->>'siteUrl' IS DISTINCT FROM review.review->'snapshot'->>'siteOrigin'
   AND connection.config->>'siteUrl' IS DISTINCT FROM (review.review->'snapshot'->>'siteOrigin')||'/')
  OR NOT (ARRAY['read:page:confluence','read:attachment:confluence']::TEXT[] <@ connection."grantedScopes") THEN
  RAISE EXCEPTION 'Confluence execution request requires current exact unwithdrawn authority';
 END IF;
 NEW."preparedAt" := clock;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
CREATE FUNCTION public."ConfluenceCopyExecutionOutcome_guard_fn"() RETURNS trigger AS $$
DECLARE prepared public."ConfluenceCopyExecutionRequest"%ROWTYPE;
 clock TIMESTAMP(3);
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Confluence execution journal is append-only'; END IF;
 IF current_setting('fsync')<>'on' OR current_setting('synchronous_commit') NOT IN ('on','remote_apply','remote_write') THEN
  RAISE EXCEPTION 'Confluence execution journal requires durable WAL';
 END IF;
 -- Persist a report even after Owner/permission withdrawal. This is internal
 -- observation persistence, not a new approval or dispatch authorisation.
 PERFORM 1 FROM public."Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
 SELECT * INTO prepared FROM public."ConfluenceCopyExecutionRequest" WHERE id=NEW."requestId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Confluence execution outcome requires its exact tenant request'; END IF;
 clock := timezone('UTC',clock_timestamp());
 IF clock<prepared."preparedAt" THEN RAISE EXCEPTION 'Confluence execution outcome clock precedes preparation'; END IF;
 NEW."reportedAt" := clock;
 NEW."recordedByDatabaseRole" := current_user;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
CREATE TRIGGER "ConfluenceCopyExecutionRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."ConfluenceCopyExecutionRequest"
 FOR EACH ROW EXECUTE FUNCTION public."ConfluenceCopyExecutionRequest_guard_fn"();
CREATE TRIGGER "ConfluenceCopyExecutionRequest_no_truncate" BEFORE TRUNCATE ON public."ConfluenceCopyExecutionRequest"
 FOR EACH STATEMENT EXECUTE FUNCTION public."ConfluenceCopyExecutionRequest_guard_fn"();
CREATE TRIGGER "ConfluenceCopyExecutionOutcome_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."ConfluenceCopyExecutionOutcome"
 FOR EACH ROW EXECUTE FUNCTION public."ConfluenceCopyExecutionOutcome_guard_fn"();
CREATE TRIGGER "ConfluenceCopyExecutionOutcome_no_truncate" BEFORE TRUNCATE ON public."ConfluenceCopyExecutionOutcome"
 FOR EACH STATEMENT EXECUTE FUNCTION public."ConfluenceCopyExecutionOutcome_guard_fn"();
COMMIT;
