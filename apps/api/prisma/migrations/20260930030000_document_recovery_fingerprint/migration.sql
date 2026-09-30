BEGIN;
ALTER TABLE "Document" ADD COLUMN "recoverySha256" TEXT;
-- There are no supported removed rows before the recovery workflow ships.
-- Refuse an unsupported pre-existing removal rather than inventing a digest.
ALTER TABLE "Document" ADD CONSTRAINT "Document_recovery_digest_valid" CHECK (
  ("deletedAt" IS NULL AND "recoverySha256" IS NULL)
  OR ("deletedAt" IS NOT NULL AND "recoverySha256" IS NOT NULL AND "recoverySha256" ~ '^[a-f0-9]{64}$')
);
ALTER TABLE "DocumentControlAudit" DROP CONSTRAINT "DocumentControlAudit_kind_valid";
ALTER TABLE "DocumentControlAudit" ADD CONSTRAINT "DocumentControlAudit_kind_valid" CHECK ("kind" IN (
  'LIFECYCLE','PUBLICATION','PUBLICATION_TARGET','BOARD_APPROVAL','METADATA','UPLOAD','RECORD_DELETE',
  'STANDARD_LINK','STANDARD_UNLINK','REPLACEMENT','DELETION_HOLD','CONFLUENCE_REFERENCE','STORAGE_PROVIDER',
  'CONTENT_ACCESS','RECORD_REMOVE','RECORD_RESTORE'
));
CREATE OR REPLACE FUNCTION "Document_recovery_state_guard_fn"() RETURNS trigger AS $$
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

COMMIT;
