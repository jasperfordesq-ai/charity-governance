-- Administrative deletion holds are explicit and default off. They do not
-- define a retention period or assert that a legal hold has been approved.
ALTER TABLE "Document" ADD COLUMN "deletionHold" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "DocumentControlAudit" DROP CONSTRAINT "DocumentControlAudit_kind_valid";
ALTER TABLE "DocumentControlAudit" ADD CONSTRAINT "DocumentControlAudit_kind_valid"
  CHECK ("kind" IN ('LIFECYCLE', 'PUBLICATION', 'BOARD_APPROVAL', 'METADATA', 'UPLOAD', 'RECORD_DELETE', 'STANDARD_LINK', 'STANDARD_UNLINK', 'REPLACEMENT', 'DELETION_HOLD'));
