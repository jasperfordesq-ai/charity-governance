BEGIN;

ALTER TABLE "Document"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "deletedById" TEXT,
  ADD COLUMN "removedFromRevision" TIMESTAMP(3),
  ADD COLUMN "removalEvidenceRef" TEXT,
  ADD COLUMN "recoveryUntil" TIMESTAMP(3),
  ADD COLUMN "recoveryPolicyId" TEXT;
ALTER TABLE "Document" ADD CONSTRAINT "Document_recovery_policy_fkey"
  FOREIGN KEY ("recoveryPolicyId", "organisationId")
  REFERENCES "DataRetentionPolicyRevision"("id", "organisationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_recovery_state_valid" CHECK (
  ("deletedAt" IS NULL AND "deletedById" IS NULL AND "removedFromRevision" IS NULL
    AND "removalEvidenceRef" IS NULL AND "recoveryUntil" IS NULL AND "recoveryPolicyId" IS NULL)
  OR ("deletedAt" IS NOT NULL AND "deletedById" IS NOT NULL AND "removedFromRevision" IS NOT NULL
    AND "removalEvidenceRef" IS NOT NULL AND "removalEvidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'
    AND "recoveryUntil" IS NOT NULL AND "recoveryUntil" > "deletedAt" AND "recoveryPolicyId" IS NOT NULL
    AND "visibility" = 'RESTRICTED' AND "contentAccessClass" = 'UNASSESSED'
    AND "memberReviewedSha256" IS NULL AND NOT "externalPublicationApproved"
    AND "externalPublicationSiteId" IS NULL AND "externalPublicationSpaceId" IS NULL)
);

CREATE FUNCTION "Document_recovery_state_guard_fn"() RETURNS trigger AS $$
DECLARE policy "DataRetentionPolicyRevision"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."deletedAt" IS NOT NULL THEN RAISE EXCEPTION 'A document must begin active'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."deletedAt" IS NOT NULL THEN
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
    IF (to_jsonb(NEW) - ARRAY['deletedAt','deletedById','removedFromRevision','removalEvidenceRef','recoveryUntil','recoveryPolicyId','visibility','contentAccessClass','memberReviewedSha256','externalPublicationApproved','externalPublicationSiteId','externalPublicationSpaceId','updatedAt'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deletedAt','deletedById','removedFromRevision','removalEvidenceRef','recoveryUntil','recoveryPolicyId','visibility','contentAccessClass','memberReviewedSha256','externalPublicationApproved','externalPublicationSiteId','externalPublicationSpaceId','updatedAt']) THEN
      RAISE EXCEPTION 'Document removal must preserve its record and stored file';
    END IF;
  ELSIF OLD."deletedAt" IS NOT NULL THEN
    IF NEW."deletedAt" IS NULL THEN
      IF timezone('UTC', statement_timestamp()) >= OLD."recoveryUntil" THEN
        RAISE EXCEPTION 'Document recovery window has expired';
      END IF;
      IF (to_jsonb(NEW) - ARRAY['deletedAt','deletedById','removedFromRevision','removalEvidenceRef','recoveryUntil','recoveryPolicyId','updatedAt'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deletedAt','deletedById','removedFromRevision','removalEvidenceRef','recoveryUntil','recoveryPolicyId','updatedAt']) THEN
        RAISE EXCEPTION 'Document restoration must preserve content and restricted access';
      END IF;
    ELSIF (to_jsonb(NEW) - ARRAY['deletionHold','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deletionHold','updatedAt']) THEN
      RAISE EXCEPTION 'Recoverable document contents and removal facts cannot be rewritten';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Document_recovery_state_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "Document_recovery_state_guard_fn"();

-- These links can be inserted after an application precheck. Lock the target
-- to serialize against removal, which requires the absence of these links.
CREATE FUNCTION "Document_recovery_reference_guard_fn"() RETURNS trigger AS $$
DECLARE target_id TEXT; removed_at TIMESTAMP(3);
BEGIN
  IF TG_TABLE_NAME = 'Document' THEN target_id := NEW."supersededByDocumentId";
  ELSE target_id := NEW."documentId";
  END IF;
  IF target_id IS NULL THEN RETURN NEW; END IF;
  SELECT "deletedAt" INTO removed_at FROM "Document"
    WHERE "id" = target_id AND "organisationId" = NEW."organisationId" FOR SHARE;
  IF FOUND AND removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Recoverable documents cannot receive new evidence references' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ConfluenceReference_recovery_guard"
  BEFORE INSERT OR UPDATE OF "documentId", "organisationId" ON "ConfluenceReference"
  FOR EACH ROW EXECUTE FUNCTION "Document_recovery_reference_guard_fn"();
CREATE TRIGGER "Document_replacement_recovery_guard"
  BEFORE INSERT OR UPDATE OF "supersededByDocumentId", "organisationId" ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "Document_recovery_reference_guard_fn"();

COMMIT;
