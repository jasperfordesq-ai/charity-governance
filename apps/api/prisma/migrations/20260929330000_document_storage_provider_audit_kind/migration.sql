-- Keep actor-bound custody verification in the append-only document history.
ALTER TABLE "DocumentControlAudit" DROP CONSTRAINT "DocumentControlAudit_kind_valid";
ALTER TABLE "DocumentControlAudit" ADD CONSTRAINT "DocumentControlAudit_kind_valid"
  CHECK ("kind" IN (
    'LIFECYCLE', 'PUBLICATION', 'BOARD_APPROVAL', 'METADATA', 'UPLOAD',
    'RECORD_DELETE', 'STANDARD_LINK', 'STANDARD_UNLINK', 'REPLACEMENT',
    'DELETION_HOLD', 'CONFLUENCE_REFERENCE', 'STORAGE_PROVIDER'
  ));
