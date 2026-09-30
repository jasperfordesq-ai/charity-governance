BEGIN;
CREATE TABLE "DocumentPurgeClaim" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL,
  "authorizationId" TEXT NOT NULL UNIQUE,
  "documentId" TEXT NOT NULL UNIQUE,
  "deletionId" TEXT NOT NULL UNIQUE,
  "actorUserId" TEXT NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("authorizationId","organisationId"),
  UNIQUE ("deletionId","organisationId"),
  FOREIGN KEY ("authorizationId","organisationId") REFERENCES "DocumentPurgeAuthorization"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("deletionId","organisationId") REFERENCES "DocumentStorageDeletion"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX "DocumentPurgeClaim_organisationId_claimedAt_id_idx" ON "DocumentPurgeClaim"("organisationId","claimedAt",id);
CREATE FUNCTION "DocumentPurgeClaim_guard_fn"() RETURNS trigger AS $$
DECLARE auth "DocumentPurgeAuthorization"%ROWTYPE; doc "Document"%ROWTYPE;
  policy "DataRetentionPolicyRevision"%ROWTYPE; observed TIMESTAMP(3);
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Purge claims are append-only'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purge claim requires the active charity owner'; END IF;
  SELECT * INTO auth FROM "DocumentPurgeAuthorization" WHERE id=NEW."authorizationId"
    AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR auth."actorUserId" <> NEW."actorUserId" OR auth."documentId" <> NEW."documentId"
    OR EXISTS (SELECT 1 FROM "DocumentPurgeAuthorizationWithdrawal" WHERE "authorizationId"=auth.id) THEN
    RAISE EXCEPTION 'Purge claim requires matching unwithdrawn Owner authority';
  END IF;
  SELECT * INTO doc FROM "Document" WHERE id=NEW."documentId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR doc."deletedAt" IS NULL OR doc."deletionHold" OR doc."lifecycleStatus" <> 'DRAFT'
    OR doc."approvalAsserted" OR doc."approvedByResolutionId" IS NOT NULL THEN
    RAISE EXCEPTION 'Purge claim requires an unheld removed draft';
  END IF;
  IF doc."updatedAt" IS DISTINCT FROM auth."documentRevision" OR doc."fileUrl" IS DISTINCT FROM auth."storagePath"
    OR doc."storageProvider" IS DISTINCT FROM auth.provider OR doc."recoverySha256" IS DISTINCT FROM auth.sha256
    OR doc."fileSize" IS DISTINCT FROM auth."fileSize" OR doc."recoveryUntil" IS DISTINCT FROM auth."recoveryUntil" THEN
    RAISE EXCEPTION 'Purge claim requires the authorized revision and object';
  END IF;
  SELECT * INTO policy FROM "DataRetentionPolicyRevision" WHERE id=auth."policyId"
    AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR policy.state <> 'APPROVED' OR policy."recordClass" <> 'VAULT_DRAFT'
    OR policy."retentionMode"='PERMANENT'
    OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=policy.id) THEN
    RAISE EXCEPTION 'Purge claim requires a current approved draft policy';
  END IF;
  -- Read time after competing locks resolve; expiry is inclusive for purge.
  observed := timezone('UTC', clock_timestamp());
  IF observed < doc."recoveryUntil" OR (policy."retentionMode"='AFTER_ANCHOR' AND
    (policy."retentionAnchor" IS DISTINCT FROM 'CREATED_AT' OR policy."retentionDays" IS NULL
      OR observed < doc."createdAt" + policy."retentionDays" * INTERVAL '1 day')) THEN
    RAISE EXCEPTION 'Purge claim must wait for retention and recovery expiry';
  END IF;
  IF EXISTS (SELECT 1 FROM "DocumentStandardLink" WHERE "documentId"=doc.id)
    OR EXISTS (SELECT 1 FROM "ConfluenceReference" WHERE "documentId"=doc.id)
    OR EXISTS (SELECT 1 FROM "Document" WHERE "supersededByDocumentId"=doc.id) THEN
    RAISE EXCEPTION 'Purge claim requires linked evidence review';
  END IF;
  IF EXISTS (SELECT 1 FROM "DocumentStorageDeletion" WHERE id=NEW."deletionId") THEN
    RAISE EXCEPTION 'Purge claim cannot reuse a storage job';
  END IF;
  NEW."transactionId" := txid_current(); NEW."claimedAt" := observed;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentPurgeClaim_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DocumentPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPurgeClaim_guard_fn"();

CREATE FUNCTION "DocumentPurgeClaim_dispatch_fn"() RETURNS trigger AS $$
DECLARE auth "DocumentPurgeAuthorization"%ROWTYPE;
BEGIN
  SELECT * INTO STRICT auth FROM "DocumentPurgeAuthorization" WHERE id=NEW."authorizationId";
  -- Worker cannot see this job until the claim, audit and deletion commit together.
  INSERT INTO "DocumentStorageDeletion" (id,"organisationId","storagePath","sourceDocumentId",provider,reason,"requestedById","updatedAt")
    VALUES (NEW."deletionId",NEW."organisationId",auth."storagePath",NEW."documentId",auth.provider,btrim(auth.reason),NEW."actorUserId",NEW."claimedAt");
  INSERT INTO "DocumentControlAudit" (id,"organisationId","documentId","actorUserId",kind,previous,next,reason,"occurredAt")
    VALUES (NEW.id,NEW."organisationId",NEW."documentId",NEW."actorUserId",'RECORD_DELETE','RECOVERABLE','PRIMARY_PURGE_PENDING',btrim(auth.reason),NEW."claimedAt");
  DELETE FROM "Document" WHERE id=NEW."documentId" AND "organisationId"=NEW."organisationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Purge document disappeared before atomic handoff'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentPurgeClaim_dispatch" AFTER INSERT ON "DocumentPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPurgeClaim_dispatch_fn"();

CREATE FUNCTION "DocumentPurgeClaim_storage_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF NEW."storagePath" IS DISTINCT FROM OLD."storagePath"
    AND EXISTS (SELECT 1 FROM "DocumentPurgeClaim" WHERE "deletionId"=OLD.id) THEN
    RAISE EXCEPTION 'A purge claim cannot redirect its authorized storage path';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentPurgeClaim_storage_guard" BEFORE UPDATE ON "DocumentStorageDeletion"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPurgeClaim_storage_guard_fn"();

-- Existing provider, tenant, source-document and request identity guards remain.

CREATE OR REPLACE FUNCTION "Document_recovery_state_guard_fn"() RETURNS trigger AS $$
DECLARE policy "DataRetentionPolicyRevision"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."deletedAt" IS NOT NULL THEN RAISE EXCEPTION 'A document must begin active'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."deletedAt" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "DocumentPurgeClaim" claim JOIN "DocumentPurgeAuthorization" auth ON auth.id=claim."authorizationId"
      WHERE claim."documentId"=OLD.id AND claim."organisationId"=OLD."organisationId"
        AND claim."transactionId"=txid_current() AND auth."documentRevision"=OLD."updatedAt"
    ) THEN
      RAISE EXCEPTION 'Recoverable documents require an authorized purge transition';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL THEN
    IF OLD."deletionHold" OR OLD."lifecycleStatus" <> 'DRAFT' OR OLD."storageProvider" IS NULL
      OR OLD."approvedByResolutionId" IS NOT NULL OR OLD."approvalAsserted"
      OR EXISTS (SELECT 1 FROM "DocumentStandardLink" WHERE "documentId" = OLD."id")
      OR EXISTS (SELECT 1 FROM "ConfluenceReference" WHERE "documentId" = OLD."id")
      OR EXISTS (SELECT 1 FROM "Document" WHERE "supersededByDocumentId" = OLD."id") THEN
      RAISE EXCEPTION 'Document requires custody, hold or linked evidence review before removal';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = NEW."deletedById"
      AND "organisationId" = OLD."organisationId" AND "role" IN ('OWNER','ADMIN') AND "lifecycleStatus" = 'ACTIVE') THEN
      RAISE EXCEPTION 'Document removal requires an active charity administrator';
    END IF;
    SELECT * INTO policy FROM "DataRetentionPolicyRevision"
      WHERE "id" = NEW."recoveryPolicyId" AND "organisationId" = OLD."organisationId" FOR UPDATE;
    IF NOT FOUND OR policy."state" <> 'APPROVED' OR policy."recordClass" <> 'VAULT_DRAFT'
      OR policy."retentionMode" = 'PERMANENT'
      OR EXISTS (SELECT 1 FROM "DataRetentionPolicyWithdrawal" WHERE "policyId" = policy."id") THEN
      RAISE EXCEPTION 'An approved current draft recovery policy is required';
    END IF;
    IF policy."retentionMode" = 'AFTER_ANCHOR' AND
      (policy."retentionAnchor" <> 'CREATED_AT' OR OLD."createdAt" + policy."retentionDays" * INTERVAL '1 day' > NEW."deletedAt") THEN
      RAISE EXCEPTION 'Document retention period has not been satisfied';
    END IF;
    IF NEW."removedFromRevision" IS DISTINCT FROM OLD."updatedAt"
      OR NEW."recoveryUntil" IS DISTINCT FROM NEW."deletedAt" + policy."recoveryDays" * INTERVAL '1 day'
      OR NEW."deletedAt" < timezone('UTC', statement_timestamp()) - INTERVAL '1 minute'
      OR NEW."deletedAt" > timezone('UTC', statement_timestamp()) + INTERVAL '1 minute' THEN
      RAISE EXCEPTION 'Document removal revision or recovery deadline is invalid';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['recoverySha256','deletedAt','deletedById','removedFromRevision','removalEvidenceRef','recoveryUntil','recoveryPolicyId','visibility','contentAccessClass','memberReviewedSha256','externalPublicationApproved','externalPublicationSiteId','externalPublicationSpaceId','updatedAt'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['recoverySha256','deletedAt','deletedById','removedFromRevision','removalEvidenceRef','recoveryUntil','recoveryPolicyId','visibility','contentAccessClass','memberReviewedSha256','externalPublicationApproved','externalPublicationSiteId','externalPublicationSpaceId','updatedAt']) THEN
      RAISE EXCEPTION 'Document removal must preserve its record and stored file';
    END IF;
  ELSIF OLD."deletedAt" IS NOT NULL THEN
    IF NEW."deletedAt" IS NULL THEN
      IF timezone('UTC', statement_timestamp()) >= OLD."recoveryUntil" THEN
        RAISE EXCEPTION 'Document recovery window has expired';
      END IF;
      IF (to_jsonb(NEW) - ARRAY['recoverySha256','deletedAt','deletedById','removedFromRevision','removalEvidenceRef','recoveryUntil','recoveryPolicyId','updatedAt'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['recoverySha256','deletedAt','deletedById','removedFromRevision','removalEvidenceRef','recoveryUntil','recoveryPolicyId','updatedAt']) THEN
        RAISE EXCEPTION 'Document restoration must preserve content and restricted access';
      END IF;
    ELSIF (to_jsonb(NEW) - ARRAY['deletionHold','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deletionHold','updatedAt']) THEN
      RAISE EXCEPTION 'Recoverable document contents and removal facts cannot be rewritten';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION "DocumentPurgeAuthorizationWithdrawal_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Purge authorization withdrawals are append-only'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purge withdrawal requires the active charity owner'; END IF;
  -- Cancellation and irreversible claim share this authorization lock.
  PERFORM 1 FROM "DocumentPurgeAuthorization" WHERE id=NEW."authorizationId"
    AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purge authorization not found in this charity'; END IF;
  IF EXISTS (SELECT 1 FROM "DocumentPurgeClaim" WHERE "authorizationId"=NEW."authorizationId") THEN
    RAISE EXCEPTION 'Purge has been claimed; cancellation cannot recall storage dispatch';
  END IF;
  NEW."occurredAt" := timezone('UTC', statement_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
