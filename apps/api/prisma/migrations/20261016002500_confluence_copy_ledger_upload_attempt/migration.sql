BEGIN;
CREATE TABLE public."ConfluenceCopyLedgerUploadAttempt" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "candidateId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL, "observedControl" JSONB NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfluenceLedgerUpload_candidate_key" UNIQUE("candidateId"),
  CONSTRAINT "ConfluenceLedgerUpload_id_org_key" UNIQUE(id,"organisationId"),
  CONSTRAINT "ConfluenceLedgerUpload_candidate_fkey" FOREIGN KEY("candidateId","organisationId")
    REFERENCES public."ConfluenceCopyLedgerCandidate"(id,"organisationId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE FUNCTION public."ConfluenceLedgerUpload_guard_fn"() RETURNS trigger AS $$
DECLARE saved RECORD; h JSONB;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Confluence ledger upload attempts are append-only'; END IF;
  IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN
    RAISE EXCEPTION 'Confluence ledger upload attempt requires repeatable source binding';
  END IF;
  IF current_setting('synchronous_commit')<>'on' OR current_setting('fsync')<>'on'
    OR current_setting('full_page_writes')<>'on' THEN RAISE EXCEPTION 'Confluence ledger upload attempt requires durable WAL settings'; END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=NEW."organisationId" AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence ledger upload attempt requires active charity Owner'; END IF;
  PERFORM 1 FROM public."User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence ledger upload attempt requires active charity Owner'; END IF;
  IF EXISTS (SELECT 1 FROM public."DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Confluence ledger upload attempt requires reviewed independent recovery integration';
  END IF;
  SELECT c."actorUserId",c."recordedAt",o."observedControl",o."operationId",o."factsDigest"
    INTO saved FROM public."ConfluenceCopyLedgerCandidate" c JOIN public."ConfluenceCopyLedgerCapture" o
    ON o.id=c."captureId" AND o."organisationId"=c."organisationId"
    WHERE c.id=NEW."candidateId" AND c."organisationId"=NEW."organisationId" FOR SHARE OF c,o;
  IF NOT FOUND OR saved."actorUserId"<>NEW."actorUserId" THEN RAISE EXCEPTION 'Confluence ledger upload attempt requires original candidate actor'; END IF;
  h:=NEW."observedControl";
  IF h IS DISTINCT FROM (saved."observedControl" || jsonb_build_object('revision',h->'revision',
      'activeOperation',jsonb_build_object('operationId',saved."operationId",'preparationDigest',saved."factsDigest")))
    OR jsonb_typeof(h->'revision') IS DISTINCT FROM 'string'
    OR length(h->>'revision') NOT BETWEEN 1 AND 1024 OR (h->>'revision')!~'^[!-~]+$'
    OR EXISTS (SELECT 1 FROM public."ConfluenceCopyLedgerProgress" WHERE "candidateId"=NEW."candidateId") THEN
    RAISE EXCEPTION 'Confluence ledger upload attempt requires original reserved unpublished binding';
  END IF;
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  IF NEW."recordedAt"<saved."recordedAt" THEN RAISE EXCEPTION 'Confluence ledger upload attempt clock precedes candidate'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
CREATE TRIGGER "ConfluenceLedgerUpload_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."ConfluenceCopyLedgerUploadAttempt"
  FOR EACH ROW EXECUTE FUNCTION public."ConfluenceLedgerUpload_guard_fn"();
CREATE TRIGGER "ConfluenceLedgerUpload_no_truncate" BEFORE TRUNCATE ON public."ConfluenceCopyLedgerUploadAttempt"
  FOR EACH STATEMENT EXECUTE FUNCTION public."ConfluenceLedgerUpload_guard_fn"();
COMMIT;
