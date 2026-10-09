BEGIN;
-- A reservation precedes provider I/O. Refuse new reservations under a
-- recovery binding before any new bytes can be written. Existing intent
-- updates remain available for reconciliation of earlier attempts.
CREATE FUNCTION "DocumentUploadIntent_source_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document upload intent organisation is unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
    WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Document upload reservation requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "A_DocumentUploadIntent_source_recovery_gate"
  BEFORE INSERT ON "DocumentUploadIntent"
  FOR EACH ROW EXECUTE FUNCTION "DocumentUploadIntent_source_recovery_gate_fn"();

-- A reservation may commit before its provider write starts. Binding must
-- wait until that upload either attaches or its cleanup has completed.
-- The same Organisation lock serialises this check with new reservations.
CREATE FUNCTION "DocumentRecoveryEnforcement_upload_quiescence_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DocumentUploadIntent" intent
    LEFT JOIN "DocumentStorageDeletion" cleanup ON cleanup.id=intent."cleanupDeletionId"
    WHERE intent."organisationId"=NEW."organisationId"
      AND (intent.state='RESERVED'
        OR (intent.state='CLEANUP_PENDING' AND
          (cleanup.id IS NULL OR cleanup.state<>'PROCESSED' OR cleanup."processedAt" IS NULL)))) THEN
    RAISE EXCEPTION 'Document recovery binding requires reconciled upload intents';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "A_DocumentRecoveryEnforcement_upload_quiescence"
  BEFORE INSERT ON "DocumentRecoveryEnforcement"
  FOR EACH ROW EXECUTE FUNCTION "DocumentRecoveryEnforcement_upload_quiescence_fn"();

-- Source edits have no independently committed full-document replay fact.
-- DELETE is governed by the distinct recovery execution and purge controls.
CREATE FUNCTION "Document_source_recovery_gate_fn"() RETURNS trigger AS $$
DECLARE charity_id TEXT;
BEGIN
  charity_id := CASE WHEN TG_OP='INSERT' THEN NEW."organisationId" ELSE OLD."organisationId" END;
  PERFORM 1 FROM "Organisation" WHERE id=charity_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
    WHERE "organisationId"=charity_id) THEN
    RAISE EXCEPTION 'Document source change requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "A_Document_source_recovery_gate"
  BEFORE INSERT OR UPDATE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "Document_source_recovery_gate_fn"();
COMMIT;
