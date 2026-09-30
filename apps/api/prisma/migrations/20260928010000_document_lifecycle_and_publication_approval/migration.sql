-- Existing files need individual review; newly uploaded files begin as DRAFT in application code.
CREATE TYPE "DocumentLifecycleStatus" AS ENUM ('UNREVIEWED', 'DRAFT', 'CURRENT', 'SUPERSEDED', 'RETIRED', 'HISTORICAL');
ALTER TYPE "DocumentPublicationTerminalReason" ADD VALUE IF NOT EXISTS 'PERMANENT_APPROVAL_REQUIRED';
ALTER TABLE "Document" ADD COLUMN "lifecycleStatus" "DocumentLifecycleStatus" NOT NULL DEFAULT 'UNREVIEWED';
ALTER TABLE "Document" ADD COLUMN "externalPublicationApproved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Document" ADD CONSTRAINT "Document_publication_requires_current"
    CHECK (NOT "externalPublicationApproved" OR "lifecycleStatus" = 'CURRENT');
CREATE INDEX "Document_organisationId_lifecycleStatus_idx" ON "Document"("organisationId", "lifecycleStatus");

CREATE TABLE "DocumentControlAudit" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "previous" TEXT NOT NULL,
    "next" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentControlAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DocumentControlAudit_kind_valid" CHECK ("kind" IN ('LIFECYCLE', 'PUBLICATION', 'BOARD_APPROVAL', 'METADATA', 'UPLOAD', 'RECORD_DELETE', 'STANDARD_LINK', 'STANDARD_UNLINK', 'REPLACEMENT')),
    CONSTRAINT "DocumentControlAudit_reason_bounded" CHECK (char_length("reason") BETWEEN 10 AND 500)
);
CREATE INDEX "DocumentControlAudit_organisationId_documentId_occurredAt_idx"
    ON "DocumentControlAudit"("organisationId", "documentId", "occurredAt");
CREATE FUNCTION "DocumentControlAudit_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'DocumentControlAudit is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentControlAudit_append_only" BEFORE UPDATE OR DELETE ON "DocumentControlAudit"
    FOR EACH ROW EXECUTE FUNCTION "DocumentControlAudit_append_only_fn"();
