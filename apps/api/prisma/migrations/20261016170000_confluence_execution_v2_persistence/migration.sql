-- Preserve earlier checksums and V1 behaviour. V2 stores exact eleven-group
-- snapshots and exact version-bound ciphertext; no provider action is enabled.
BEGIN;
CREATE OR REPLACE FUNCTION public."ConfluenceLedgerCapture_guard_fn"() RETURNS trigger AS $$
DECLARE payload JSONB; actual JSONB; expected JSONB; c JSONB; h JSONB; maximum_count BIGINT; total_bytes BIGINT; v2 BOOLEAN; extra JSONB;
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
  v2:=coalesce(payload->'format'='2'::jsonb AND payload->>'kind'='CONFLUENCE_EXECUTION_LEDGER_V2',false);
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
    UNION ALL SELECT count(*) AS n,coalesce(sum(octet_length(to_jsonb(t)::text)),0) AS bytes FROM public."ConfluenceCopyPublicationReceipt" t WHERE "organisationId"=NEW."organisationId"
    UNION ALL SELECT count(*),coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM public."ConfluenceCopyExecutionClaim" t WHERE "organisationId"=NEW."organisationId" AND v2
    UNION ALL SELECT count(*),coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM public."ConfluenceCopyExecutionRequest" t WHERE "organisationId"=NEW."organisationId" AND v2
    UNION ALL SELECT count(*),coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM public."ConfluenceCopyExecutionOutcome" t WHERE "organisationId"=NEW."organisationId" AND v2) sizes;
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
  IF v2 THEN
    SELECT jsonb_build_object(
      'ConfluenceCopyExecutionClaim',coalesce((SELECT jsonb_agg(public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),ARRAY['claimedAt']) ORDER BY id) FROM public."ConfluenceCopyExecutionClaim" t WHERE "organisationId"=NEW."organisationId"),'[]'::jsonb),
      'ConfluenceCopyExecutionRequest',coalesce((SELECT jsonb_agg(public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),ARRAY['preparedAt']) ORDER BY id) FROM public."ConfluenceCopyExecutionRequest" t WHERE "organisationId"=NEW."organisationId"),'[]'::jsonb),
      'ConfluenceCopyExecutionOutcome',coalesce((SELECT jsonb_agg(public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),ARRAY['reportedAt']) ORDER BY id) FROM public."ConfluenceCopyExecutionOutcome" t WHERE "organisationId"=NEW."organisationId"),'[]'::jsonb)) INTO extra;
    actual:=actual||extra;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(actual) AS tables(name,rows)
    CROSS JOIN LATERAL jsonb_array_elements(tables.rows) AS records(row_data)
    CROSS JOIN LATERAL jsonb_each(records.row_data) AS fields(name,value)
    WHERE fields.name IN ('reviewedAt','recordedAt','registeredAt','issuedAt','occurredAt','capturedAt','connectionGeneration','claimedAt','preparedAt','reportedAt')
      AND (fields.value#>>'{}')::timestamp>NEW."capturedAt") THEN
    RAISE EXCEPTION 'Confluence ledger capture clock precedes source records';
  END IF;
  expected:=jsonb_build_object('format',CASE WHEN v2 THEN 2 ELSE 1 END,'kind',CASE WHEN v2 THEN 'CONFLUENCE_EXECUTION_LEDGER_V2' ELSE 'CONFLUENCE_COPY_LOCAL_LEDGER_V1' END,'installationId',c->'installationId',
    'organisationId',NEW."organisationId",'actorUserId',NEW."actorUserId",'declaredSourceRevision',c->'sourceRevision',
    'capturedAt',to_char(NEW."capturedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'tables',actual);
  IF v2 THEN expected:=expected||jsonb_build_object('writerEpoch',c->'writerEpoch','captureOperationId',NEW."operationId"); END IF;
  IF payload<>expected THEN RAISE EXCEPTION 'Confluence ledger capture does not match complete current source rows'; END IF;
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
CREATE OR REPLACE FUNCTION public."ConfluenceLedgerCandidate_guard_fn"() RETURNS trigger AS $$
DECLARE original public."ConfluenceCopyLedgerCapture"%ROWTYPE; payload JSONB; sealed JSONB; v2 BOOLEAN;
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
  v2:=coalesce(original.facts::jsonb->'format'='2'::jsonb AND original.facts::jsonb->>'kind'='CONFLUENCE_EXECUTION_LEDGER_V2',false);
  payload:=NEW.envelope::jsonb; sealed:=payload->'sealed';
  IF NEW."envelopeDigest"<>encode(sha256(convert_to(NEW.envelope,'UTF8')),'hex')
    OR payload IS DISTINCT FROM jsonb_build_object('format',CASE WHEN v2 THEN 2 ELSE 1 END,'kind',CASE WHEN v2 THEN 'CONFLUENCE_EXECUTION_LEDGER_ARCHIVE_V2' ELSE 'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1' END,
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
CREATE OR REPLACE FUNCTION public."ConfluenceCopyClaim_archive_guard_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM public."Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public."ConfluenceCopyExecutionClaim" WHERE "organisationId"=NEW."organisationId")
    AND NOT coalesce(NEW.facts::jsonb->'format'='2'::jsonb AND NEW.facts::jsonb->>'kind'='CONFLUENCE_EXECUTION_LEDGER_V2',false) THEN
    RAISE EXCEPTION 'Confluence execution claims require compatible independent archive integration';
  END IF;
  -- The capture guard independently verifies all eleven exact source groups.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
COMMIT;
