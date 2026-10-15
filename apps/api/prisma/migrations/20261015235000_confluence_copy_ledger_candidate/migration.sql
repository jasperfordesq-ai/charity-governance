BEGIN;
CREATE TABLE public."ConfluenceCopyLedgerCandidate" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL,
  "captureId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  envelope TEXT NOT NULL CHECK (octet_length(envelope) BETWEEN 1 AND 201326592),
  "envelopeDigest" TEXT NOT NULL CHECK ("envelopeDigest" ~ '^[a-f0-9]{64}$'),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfluenceLedgerCandidate_capture_key" UNIQUE("captureId"),
  CONSTRAINT "ConfluenceLedgerCandidate_id_org_key" UNIQUE(id,"organisationId"),
  CONSTRAINT "ConfluenceLedgerCandidate_capture_fkey" FOREIGN KEY("captureId","organisationId")
    REFERENCES public."ConfluenceCopyLedgerCapture"(id,"organisationId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE FUNCTION public."ConfluenceLedgerCandidate_guard_fn"() RETURNS trigger AS $$
DECLARE original public."ConfluenceCopyLedgerCapture"%ROWTYPE; payload JSONB; sealed JSONB;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Confluence ledger candidates are append-only'; END IF;
  IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN
    RAISE EXCEPTION 'Confluence ledger candidate requires repeatable source binding';
  END IF;
  IF current_setting('synchronous_commit')<>'on' OR current_setting('fsync')<>'on'
    OR current_setting('full_page_writes')<>'on' THEN
    RAISE EXCEPTION 'Confluence ledger candidate requires durable WAL settings';
  END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=NEW."organisationId" AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence ledger candidate requires active charity Owner'; END IF;
  PERFORM 1 FROM public."User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence ledger candidate requires active charity Owner'; END IF;
  IF EXISTS (SELECT 1 FROM public."DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Confluence ledger candidate requires reviewed independent recovery integration';
  END IF;
  SELECT * INTO original FROM public."ConfluenceCopyLedgerCapture"
    WHERE id=NEW."captureId" AND "organisationId"=NEW."organisationId" FOR SHARE;
  IF NOT FOUND OR original."actorUserId"<>NEW."actorUserId" THEN
    RAISE EXCEPTION 'Confluence ledger candidate requires exact original actor and capture';
  END IF;
  payload:=NEW.envelope::jsonb; sealed:=payload->'sealed';
  IF NEW."envelopeDigest"<>encode(sha256(convert_to(NEW.envelope,'UTF8')),'hex')
    OR payload IS DISTINCT FROM jsonb_build_object('format',1,'kind','CONFLUENCE_COPY_LEDGER_ARCHIVE_V1',
      'binding',jsonb_build_object('context',original.context,'observedControl',original."observedControl"),
      'wrappedKey',payload->'wrappedKey','sealed',sealed)
    OR sealed IS DISTINCT FROM jsonb_build_object('generation',original.context->'writerEpoch',
      'iv',sealed->'iv','tag',sealed->'tag','ciphertext',sealed->'ciphertext')
    OR jsonb_typeof(payload->'wrappedKey') IS DISTINCT FROM 'string'
    OR length(payload->>'wrappedKey') NOT BETWEEN 1 AND 8192
    OR jsonb_typeof(sealed->'iv') IS DISTINCT FROM 'string'
    OR length(sealed->>'iv') NOT BETWEEN 1 AND 16
    OR jsonb_typeof(sealed->'tag') IS DISTINCT FROM 'string'
    OR length(sealed->>'tag') NOT BETWEEN 1 AND 24
    OR jsonb_typeof(sealed->'ciphertext') IS DISTINCT FROM 'string'
    OR length(sealed->>'ciphertext') NOT BETWEEN 1 AND 178956972 THEN
    RAISE EXCEPTION 'Confluence ledger candidate hash or original envelope binding is invalid';
  END IF;
  -- SQL binds immutable declared metadata; application readback must still
  -- authenticate AES-GCM, canonical bytes and original plaintext before upload.
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  IF NEW."recordedAt"<original."recordedAt" THEN RAISE EXCEPTION 'Confluence ledger candidate clock precedes capture'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
CREATE TRIGGER "ConfluenceLedgerCandidate_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."ConfluenceCopyLedgerCandidate"
  FOR EACH ROW EXECUTE FUNCTION public."ConfluenceLedgerCandidate_guard_fn"();
CREATE TRIGGER "ConfluenceLedgerCandidate_no_truncate" BEFORE TRUNCATE ON public."ConfluenceCopyLedgerCandidate"
  FOR EACH STATEMENT EXECUTE FUNCTION public."ConfluenceLedgerCandidate_guard_fn"();
COMMIT;
