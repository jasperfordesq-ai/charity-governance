-- A separate append-only access ledger survives later draft-record deletion.
-- The row records preparation for HTTP delivery, never receipt or file bytes.
CREATE TABLE "DocumentDownloadPreparationAudit" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "visibility" "DocumentVisibility" NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentDownloadPreparationAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DocumentDownloadPreparationAudit_organisationId_occurredAt_id_idx"
  ON "DocumentDownloadPreparationAudit"("organisationId", "occurredAt", "id");
CREATE INDEX "DocumentDownloadPreparationAudit_organisationId_documentId_occurredAt_idx"
  ON "DocumentDownloadPreparationAudit"("organisationId", "documentId", "occurredAt");

CREATE FUNCTION "reject_document_download_audit_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Document download preparation audit is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "DocumentDownloadPreparationAudit_append_only"
  BEFORE UPDATE OR DELETE ON "DocumentDownloadPreparationAudit"
  FOR EACH ROW EXECUTE FUNCTION "reject_document_download_audit_mutation"();
