-- Existing and newly uploaded documents must be reviewed before Member access.
CREATE TYPE "DocumentVisibility" AS ENUM ('RESTRICTED', 'MEMBER_VISIBLE');
ALTER TABLE "Document" ADD COLUMN "visibility" "DocumentVisibility" NOT NULL DEFAULT 'RESTRICTED';
CREATE INDEX "Document_organisationId_visibility_idx" ON "Document"("organisationId", "visibility");

CREATE TABLE "DocumentVisibilityAudit" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "previous" "DocumentVisibility" NOT NULL,
    "next" "DocumentVisibility" NOT NULL,
    "reason" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentVisibilityAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DocumentVisibilityAudit_reason_bounded" CHECK (char_length("reason") BETWEEN 10 AND 500)
);
CREATE INDEX "DocumentVisibilityAudit_organisationId_documentId_occurredAt_idx"
    ON "DocumentVisibilityAudit"("organisationId", "documentId", "occurredAt");
CREATE FUNCTION "DocumentVisibilityAudit_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'DocumentVisibilityAudit is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentVisibilityAudit_append_only" BEFORE UPDATE OR DELETE ON "DocumentVisibilityAudit"
    FOR EACH ROW EXECUTE FUNCTION "DocumentVisibilityAudit_append_only_fn"();
