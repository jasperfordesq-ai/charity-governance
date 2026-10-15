BEGIN;
CREATE TABLE public."ConfluenceCopyLedgerProgress" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "candidateId" TEXT NOT NULL, "actorUserId" TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('PUBLISHED','ACKNOWLEDGED')),
  "entryGeneration" INTEGER NOT NULL CHECK ("entryGeneration" BETWEEN 1 AND 10000),
  "entryDigest" TEXT NOT NULL CHECK ("entryDigest" ~ '^[a-f0-9]{64}$'),
  "envelopeDigest" TEXT NOT NULL CHECK ("envelopeDigest" ~ '^[a-f0-9]{64}$'),
  "observedRevision" TEXT NOT NULL CHECK (length("observedRevision") BETWEEN 1 AND 1024 AND "observedRevision" ~ '^[!-~]+$'),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfluenceLedgerProgress_candidate_stage_key" UNIQUE("candidateId",stage),
  CONSTRAINT "ConfluenceLedgerProgress_id_org_key" UNIQUE(id,"organisationId"),
  CONSTRAINT "ConfluenceLedgerProgress_candidate_fkey" FOREIGN KEY("candidateId","organisationId")
    REFERENCES public."ConfluenceCopyLedgerCandidate"(id,"organisationId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE FUNCTION public."ConfluenceLedgerProgress_guard_fn"() RETURNS trigger AS $$
DECLARE saved RECORD; published public."ConfluenceCopyLedgerProgress"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Confluence ledger progress is append-only'; END IF;
  IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN
    RAISE EXCEPTION 'Confluence ledger progress requires repeatable source binding';
  END IF;
  IF current_setting('synchronous_commit')<>'on' OR current_setting('fsync')<>'on'
    OR current_setting('full_page_writes')<>'on' THEN RAISE EXCEPTION 'Confluence ledger progress requires durable WAL settings'; END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=NEW."organisationId" AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence ledger progress requires active charity Owner'; END IF;
  PERFORM 1 FROM public."User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence ledger progress requires active charity Owner'; END IF;
  IF EXISTS (SELECT 1 FROM public."DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Confluence ledger progress requires reviewed independent recovery integration';
  END IF;
  SELECT c."actorUserId",c."envelopeDigest",c."recordedAt",o."observedControl"
    INTO saved FROM public."ConfluenceCopyLedgerCandidate" c JOIN public."ConfluenceCopyLedgerCapture" o
    ON o.id=c."captureId" AND o."organisationId"=c."organisationId"
    WHERE c.id=NEW."candidateId" AND c."organisationId"=NEW."organisationId" FOR SHARE OF c,o;
  IF NOT FOUND OR saved."actorUserId"<>NEW."actorUserId" OR saved."envelopeDigest"<>NEW."envelopeDigest"
    OR (saved."observedControl"->>'generation')::integer+1<>NEW."entryGeneration" THEN
    RAISE EXCEPTION 'Confluence ledger progress does not match original candidate';
  END IF;
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  IF NEW."recordedAt"<saved."recordedAt" THEN RAISE EXCEPTION 'Confluence ledger progress clock precedes candidate'; END IF;
  IF NEW.stage='ACKNOWLEDGED' THEN
    SELECT * INTO published FROM public."ConfluenceCopyLedgerProgress" WHERE "candidateId"=NEW."candidateId" AND stage='PUBLISHED' FOR SHARE;
    IF NOT FOUND OR published."organisationId"<>NEW."organisationId" OR published."actorUserId"<>NEW."actorUserId"
      OR published."entryGeneration"<>NEW."entryGeneration" OR published."entryDigest"<>NEW."entryDigest"
      OR published."envelopeDigest"<>NEW."envelopeDigest" OR published."recordedAt">NEW."recordedAt" THEN
      RAISE EXCEPTION 'Confluence ledger acknowledgement requires exact committed publication progress';
    END IF;
  END IF;
  -- These immutable declared observations are not SQL proof of remote history.
  -- Application observation must authenticate current full archive evidence.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
CREATE TRIGGER "ConfluenceLedgerProgress_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."ConfluenceCopyLedgerProgress"
  FOR EACH ROW EXECUTE FUNCTION public."ConfluenceLedgerProgress_guard_fn"();
CREATE TRIGGER "ConfluenceLedgerProgress_no_truncate" BEFORE TRUNCATE ON public."ConfluenceCopyLedgerProgress"
  FOR EACH STATEMENT EXECUTE FUNCTION public."ConfluenceLedgerProgress_guard_fn"();
COMMIT;
