BEGIN;
CREATE TABLE public."ConfluenceCopyLedgerCapture" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL REFERENCES public."Organisation"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "operationId" TEXT NOT NULL CHECK ("operationId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "actorUserId" TEXT NOT NULL, context JSONB NOT NULL, "observedControl" JSONB NOT NULL,
  facts TEXT NOT NULL CHECK (octet_length(facts) BETWEEN 1 AND 134217728),
  "factsDigest" TEXT NOT NULL CHECK ("factsDigest" ~ '^[a-f0-9]{64}$'),
  "capturedAt" TIMESTAMP(3) NOT NULL, "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfluenceLedgerCapture_org_operation_key" UNIQUE("organisationId","operationId"),
  CONSTRAINT "ConfluenceLedgerCapture_id_org_key" UNIQUE(id,"organisationId")
);
CREATE FUNCTION public."ConfluenceLedgerCapture_guard_fn"() RETURNS trigger AS $$
DECLARE payload JSONB; actual JSONB; expected JSONB; c JSONB; h JSONB; maximum_count BIGINT; total_bytes BIGINT;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Confluence ledger captures are append-only'; END IF;
  IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN
    RAISE EXCEPTION 'Confluence ledger capture requires one repeatable source snapshot';
  END IF;
  IF current_setting('synchronous_commit')<>'on' OR current_setting('fsync')<>'on'
    OR current_setting('full_page_writes')<>'on' THEN
    RAISE EXCEPTION 'Confluence ledger capture requires durable WAL settings';
  END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=NEW."organisationId" AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence ledger capture requires active charity Owner'; END IF;
  PERFORM 1 FROM public."User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence ledger capture requires active charity Owner'; END IF;
  IF EXISTS (SELECT 1 FROM public."DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Confluence ledger capture requires reviewed independent recovery integration';
  END IF;
  c:=NEW.context; h:=NEW."observedControl"; payload:=NEW.facts::jsonb;
  IF c<>jsonb_build_object('installationId',c->'installationId','organisationId',to_jsonb(NEW."organisationId"),
      'operationId',to_jsonb(NEW."operationId"),'writerEpoch',c->'writerEpoch','sourceRevision',c->'sourceRevision','keyId',c->'keyId')
    OR coalesce(c->>'installationId','')!~'^[A-Za-z0-9_-]{1,120}$'
    OR jsonb_typeof(c->'installationId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(c->'sourceRevision') IS DISTINCT FROM 'string'
    OR jsonb_typeof(c->'keyId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(c->'writerEpoch') IS DISTINCT FROM 'number'
    OR coalesce(c->>'sourceRevision','')!~'^[a-f0-9]{40}$'
    OR coalesce(c->>'keyId','')!~'^arn:aws:kms:eu-west-1:[0-9]{12}:key/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR (c->>'writerEpoch')::bigint NOT BETWEEN 1 AND 2147483647
    OR h<>jsonb_build_object('format',2,'installationId',c->'installationId','organisationId',c->'organisationId',
      'writerId',h->'writerId','writerEpoch',c->'writerEpoch','generation',h->'generation','digest',h->'digest',
      'activeOperation','null'::jsonb,'revision',h->'revision')
    OR coalesce(h->>'writerId','')!~'^[A-Za-z0-9_-]{1,120}$'
    OR jsonb_typeof(h->'writerId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(h->'revision') IS DISTINCT FROM 'string'
    OR jsonb_typeof(h->'generation') IS DISTINCT FROM 'number'
    OR (h->>'generation')::bigint NOT BETWEEN 0 AND 9999
    OR ((h->>'generation')::bigint=0)<>(h->'digest'='null'::jsonb)
    OR (h->'digest'<>'null'::jsonb AND coalesce(h->>'digest','')!~'^[a-f0-9]{64}$')
    OR length(coalesce(h->>'revision','')) NOT BETWEEN 1 AND 1024
    OR coalesce(h->>'revision','')!~'^[!-~]+$'
    OR NEW."factsDigest"<>encode(sha256(convert_to(NEW.facts,'UTF8')),'hex')
    OR NEW."capturedAt">timezone('UTC',clock_timestamp()) THEN
    RAISE EXCEPTION 'Confluence ledger capture binding or original facts are invalid';
  END IF;
  SELECT max(n),sum(bytes) INTO maximum_count,total_bytes FROM (
    SELECT count(*) AS n,coalesce(sum(octet_length(to_jsonb(t)::text)),0) AS bytes FROM public."ConfluenceRetainedCopyReview" t WHERE "organisationId"=NEW."organisationId"
    UNION ALL SELECT count(*) AS n,coalesce(sum(octet_length(to_jsonb(t)::text)),0) AS bytes FROM public."ConfluenceRetainedCopyReviewWithdrawal" t WHERE "organisationId"=NEW."organisationId"
    UNION ALL SELECT count(*) AS n,coalesce(sum(octet_length(to_jsonb(t)::text)),0) AS bytes FROM public."ConfluenceSyntheticCopyScope" t WHERE "organisationId"=NEW."organisationId"
    UNION ALL SELECT count(*) AS n,coalesce(sum(octet_length(to_jsonb(t)::text)),0) AS bytes FROM public."ConfluenceRetainedCopyPermission" t WHERE "organisationId"=NEW."organisationId"
    UNION ALL SELECT count(*) AS n,coalesce(sum(octet_length(to_jsonb(t)::text)),0) AS bytes FROM public."ConfluenceRetainedCopyPermissionWithdrawal" t WHERE "organisationId"=NEW."organisationId"
    UNION ALL SELECT count(*) AS n,coalesce(sum(octet_length(to_jsonb(t)::text)),0) AS bytes FROM public."ConfluenceCopyRecoveryCapture" t WHERE "organisationId"=NEW."organisationId"
    UNION ALL SELECT count(*) AS n,coalesce(sum(octet_length(to_jsonb(t)::text)),0) AS bytes FROM public."ConfluenceCopyPublicationPlan" t WHERE "organisationId"=NEW."organisationId"
    UNION ALL SELECT count(*) AS n,coalesce(sum(octet_length(to_jsonb(t)::text)),0) AS bytes FROM public."ConfluenceCopyPublicationReceipt" t WHERE "organisationId"=NEW."organisationId") sizes;
  IF maximum_count>10000 OR total_bytes>125829120 THEN RAISE EXCEPTION 'Confluence ledger snapshot exceeds bounded capacity'; END IF;
  SELECT jsonb_build_object(
    'ConfluenceRetainedCopyReview',coalesce((SELECT jsonb_agg(public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),ARRAY['reviewedAt','expiresAt','recordedAt']) ORDER BY id) FROM public."ConfluenceRetainedCopyReview" t WHERE "organisationId"=NEW."organisationId"),'[]'::jsonb),
    'ConfluenceRetainedCopyReviewWithdrawal',coalesce((SELECT jsonb_agg(public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),ARRAY['occurredAt']) ORDER BY id) FROM public."ConfluenceRetainedCopyReviewWithdrawal" t WHERE "organisationId"=NEW."organisationId"),'[]'::jsonb),
    'ConfluenceSyntheticCopyScope',coalesce((SELECT jsonb_agg(public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),ARRAY['registeredAt','expiresAt']) ORDER BY id) FROM public."ConfluenceSyntheticCopyScope" t WHERE "organisationId"=NEW."organisationId"),'[]'::jsonb),
    'ConfluenceRetainedCopyPermission',coalesce((SELECT jsonb_agg(public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),ARRAY['connectionGeneration','issuedAt','expiresAt']) ORDER BY id) FROM public."ConfluenceRetainedCopyPermission" t WHERE "organisationId"=NEW."organisationId"),'[]'::jsonb),
    'ConfluenceRetainedCopyPermissionWithdrawal',coalesce((SELECT jsonb_agg(public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),ARRAY['occurredAt']) ORDER BY id) FROM public."ConfluenceRetainedCopyPermissionWithdrawal" t WHERE "organisationId"=NEW."organisationId"),'[]'::jsonb),
    'ConfluenceCopyRecoveryCapture',coalesce((SELECT jsonb_agg(public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),ARRAY['capturedAt','recordedAt']) ORDER BY id) FROM public."ConfluenceCopyRecoveryCapture" t WHERE "organisationId"=NEW."organisationId"),'[]'::jsonb),
    'ConfluenceCopyPublicationPlan',coalesce((SELECT jsonb_agg(public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),ARRAY['recordedAt']) ORDER BY id) FROM public."ConfluenceCopyPublicationPlan" t WHERE "organisationId"=NEW."organisationId"),'[]'::jsonb),
    'ConfluenceCopyPublicationReceipt',coalesce((SELECT jsonb_agg(public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),ARRAY['recordedAt']) ORDER BY id) FROM public."ConfluenceCopyPublicationReceipt" t WHERE "organisationId"=NEW."organisationId"),'[]'::jsonb)) INTO actual;
  IF EXISTS (SELECT 1 FROM jsonb_each(actual) AS tables(name,rows)
    CROSS JOIN LATERAL jsonb_array_elements(tables.rows) AS records(row_data)
    CROSS JOIN LATERAL jsonb_each(records.row_data) AS fields(name,value)
    WHERE fields.name IN ('reviewedAt','recordedAt','registeredAt','issuedAt','occurredAt','capturedAt','connectionGeneration')
      AND (fields.value#>>'{}')::timestamp>NEW."capturedAt") THEN
    RAISE EXCEPTION 'Confluence ledger capture clock precedes source records';
  END IF;
  expected:=jsonb_build_object('format',1,'kind','CONFLUENCE_COPY_LOCAL_LEDGER_V1','installationId',c->'installationId',
    'organisationId',NEW."organisationId",'actorUserId',NEW."actorUserId",'declaredSourceRevision',c->'sourceRevision',
    'capturedAt',to_char(NEW."capturedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'tables',actual);
  IF payload<>expected THEN RAISE EXCEPTION 'Confluence ledger capture does not match complete current source rows'; END IF;
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
CREATE TRIGGER "ConfluenceLedgerCapture_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."ConfluenceCopyLedgerCapture"
  FOR EACH ROW EXECUTE FUNCTION public."ConfluenceLedgerCapture_guard_fn"();
CREATE TRIGGER "ConfluenceLedgerCapture_no_truncate" BEFORE TRUNCATE ON public."ConfluenceCopyLedgerCapture"
  FOR EACH STATEMENT EXECUTE FUNCTION public."ConfluenceLedgerCapture_guard_fn"();
CREATE FUNCTION public."ConfluenceLedgerCapture_binding_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."ConfluenceCopyLedgerCapture" WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Document recovery binding requires reviewed original archive dispatch history';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
CREATE TRIGGER "A_DocumentRecoveryEnforcement_ledger_capture_quiescence" BEFORE INSERT OR UPDATE ON public."DocumentRecoveryEnforcement"
  FOR EACH ROW EXECUTE FUNCTION public."ConfluenceLedgerCapture_binding_guard_fn"();
COMMIT;
