BEGIN;
-- Internal invoker-owned maintenance only. No role grants, SECURITY DEFINER,
-- runtime route, provider action or reopening capability is introduced.
CREATE FUNCTION public."ConfluenceCopyLedgerRecovery_assert"(charity_id TEXT) RETURNS VOID AS $$
DECLARE item TEXT[]; metadata TEXT[][]:=ARRAY[
  ARRAY['ConfluenceRetainedCopyReview','ConfluenceRetainedCopyReview_guard','ConfluenceRetainedCopyReview_no_truncate'],
  ARRAY['ConfluenceSyntheticCopyScope','ConfluenceSyntheticCopyScope_guard','ConfluenceSyntheticCopyScope_no_truncate'],
  ARRAY['ConfluenceRetainedCopyPermission','ConfluenceRetainedCopyPermission_guard','ConfluenceRetainedCopyPermission_no_truncate'],
  ARRAY['ConfluenceRetainedCopyReviewWithdrawal','ConfluenceRetainedCopyReviewWithdrawal_guard','ConfluenceRetainedCopyReviewWithdrawal_no_truncate'],
  ARRAY['ConfluenceRetainedCopyPermissionWithdrawal','ConfluenceRetainedCopyPermissionWithdrawal_guard','ConfluenceRetainedCopyPermissionWithdrawal_no_truncate'],
  ARRAY['ConfluenceCopyRecoveryCapture','ConfluenceCopyRecoveryCapture_guard','ConfluenceCopyRecoveryCapture_truncate_guard'],
  ARRAY['ConfluenceCopyPublicationPlan','ConfluenceCopyPlan_guard','ConfluenceCopyPlan_truncate_guard'],
  ARRAY['ConfluenceCopyPublicationReceipt','ConfluenceCopyReceipt_guard','ConfluenceCopyReceipt_truncate_guard']];
BEGIN
  FOREACH item SLICE 1 IN ARRAY metadata LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass(format('public.%I',item[1]))
      AND pg_get_userbyid(relowner)=current_user) THEN
      RAISE EXCEPTION 'Complete Confluence replay requires the maintenance table owner';
    END IF;
  END LOOP;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Complete Confluence replay requires fresh read-committed snapshots';
  END IF;
  IF current_setting('synchronous_commit')<>'on' OR current_setting('fsync')<>'on'
    OR current_setting('full_page_writes')<>'on' THEN
    RAISE EXCEPTION 'Complete Confluence replay requires durable WAL settings';
  END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=charity_id AND "lifecycleStatus"='SUSPENDED' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complete Confluence replay requires a quarantined charity'; END IF;
  LOCK TABLE public."ConfluenceRetainedCopyReview",public."ConfluenceSyntheticCopyScope",public."ConfluenceRetainedCopyPermission",
    public."ConfluenceRetainedCopyReviewWithdrawal",public."ConfluenceRetainedCopyPermissionWithdrawal",
    public."ConfluenceCopyRecoveryCapture",public."ConfluenceCopyPublicationPlan",public."ConfluenceCopyPublicationReceipt" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
    AND backend_type='client backend') THEN
    RAISE EXCEPTION 'Complete Confluence replay requires exclusive maintenance client access';
  END IF;
  FOREACH item SLICE 1 IN ARRAY metadata LOOP
    IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass(format('public.%I',item[1])) AND NOT tgisinternal)<>2
      OR (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass(format('public.%I',item[1])) AND NOT tgisinternal
        AND tgname IN (item[2],item[3]) AND tgenabled='O')<>2
      OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(format('public.%I',item[1])) AND tgisinternal AND tgenabled<>'O')
      OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass(format('public.%I',item[1])) AND NOT convalidated) THEN
      RAISE EXCEPTION 'Complete Confluence replay requires exact enabled guards and foreign keys';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
REVOKE ALL ON FUNCTION public."ConfluenceCopyLedgerRecovery_assert"(TEXT) FROM PUBLIC;

CREATE FUNCTION public."ConfluenceCopyLedgerRecovery_rows"(charity_id TEXT) RETURNS JSONB AS $$
DECLARE table_name TEXT; date_keys TEXT[]; row_count BIGINT; row_bytes BIGINT;
  total_bytes BIGINT:=0; group_rows JSONB; result JSONB:='{}'::jsonb;
  tables TEXT[]:=ARRAY['ConfluenceRetainedCopyReview','ConfluenceSyntheticCopyScope','ConfluenceRetainedCopyPermission',
    'ConfluenceRetainedCopyReviewWithdrawal','ConfluenceRetainedCopyPermissionWithdrawal','ConfluenceCopyRecoveryCapture',
    'ConfluenceCopyPublicationPlan','ConfluenceCopyPublicationReceipt'];
BEGIN
  PERFORM public."ConfluenceCopyLedgerRecovery_assert"(charity_id);
  -- Preflight every group before materialising any complete record bodies.
  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format('SELECT count(*),coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM public.%I t WHERE "organisationId"=$1',table_name)
      INTO row_count,row_bytes USING charity_id;
    total_bytes:=total_bytes+row_bytes;
    IF row_count>10000 OR total_bytes>125829120 THEN RAISE EXCEPTION 'Complete Confluence replay snapshot capacity exceeded'; END IF;
  END LOOP;
  FOREACH table_name IN ARRAY tables LOOP
    date_keys:=CASE table_name WHEN 'ConfluenceRetainedCopyReview' THEN ARRAY['reviewedAt','expiresAt','recordedAt']
      WHEN 'ConfluenceSyntheticCopyScope' THEN ARRAY['registeredAt','expiresAt']
      WHEN 'ConfluenceRetainedCopyPermission' THEN ARRAY['connectionGeneration','issuedAt','expiresAt']
      WHEN 'ConfluenceCopyRecoveryCapture' THEN ARRAY['capturedAt','recordedAt']
      WHEN 'ConfluenceCopyPublicationPlan' THEN ARRAY['recordedAt']
      WHEN 'ConfluenceCopyPublicationReceipt' THEN ARRAY['recordedAt'] ELSE ARRAY['occurredAt'] END;
    EXECUTE format('SELECT coalesce(jsonb_agg(public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),$2) ORDER BY id COLLATE "C"),''[]''::jsonb) FROM public.%I t WHERE "organisationId"=$1',table_name)
      INTO group_rows USING charity_id,date_keys;
    result:=result||jsonb_build_object(table_name,group_rows);
  END LOOP;
  IF octet_length(result::text)>134217728 THEN RAISE EXCEPTION 'Complete Confluence replay snapshot capacity exceeded'; END IF;
  RETURN result;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
REVOKE ALL ON FUNCTION public."ConfluenceCopyLedgerRecovery_rows"(TEXT) FROM PUBLIC;

-- Caller separately authenticates the exact complete archive/current prefix and
-- validates immutable semantics. SQL proves local isolation/snapshot/FKs and
-- exact insert/readback only. Four transport tables and reopening remain outside.
CREATE FUNCTION public."ConfluenceCopyLedgerRecovery_replay"(charity_id TEXT, expected_rows JSONB, proposed_inserts JSONB)
RETURNS INTEGER AS $$
DECLARE table_name TEXT; date_keys TEXT[]; item JSONB; raw_record JSONB;
  typed_record JSONB; stored_record JSONB; inserted INTEGER:=0; affected INTEGER;
  tables TEXT[]:=ARRAY['ConfluenceRetainedCopyReview','ConfluenceSyntheticCopyScope','ConfluenceRetainedCopyPermission',
    'ConfluenceRetainedCopyReviewWithdrawal','ConfluenceRetainedCopyPermissionWithdrawal','ConfluenceCopyRecoveryCapture',
    'ConfluenceCopyPublicationPlan','ConfluenceCopyPublicationReceipt'];
  guards TEXT[]:=ARRAY['ConfluenceRetainedCopyReview_guard','ConfluenceSyntheticCopyScope_guard','ConfluenceRetainedCopyPermission_guard',
    'ConfluenceRetainedCopyReviewWithdrawal_guard','ConfluenceRetainedCopyPermissionWithdrawal_guard','ConfluenceCopyRecoveryCapture_guard',
    'ConfluenceCopyPlan_guard','ConfluenceCopyReceipt_guard'];
BEGIN
  PERFORM public."ConfluenceCopyLedgerRecovery_assert"(charity_id);
  IF jsonb_typeof(expected_rows) IS DISTINCT FROM 'object' OR jsonb_typeof(proposed_inserts) IS DISTINCT FROM 'array'
    OR octet_length(expected_rows::text)>134217728 OR octet_length(proposed_inserts::text)>134217728 THEN
    RAISE EXCEPTION 'Invalid or over-capacity complete Confluence replay input';
  END IF;
  IF jsonb_array_length(proposed_inserts)>80000 THEN RAISE EXCEPTION 'Complete Confluence replay row capacity exceeded'; END IF;
  IF public."ConfluenceCopyLedgerRecovery_rows"(charity_id) IS DISTINCT FROM expected_rows THEN
    RAISE EXCEPTION 'Complete Confluence replay local records changed';
  END IF;
  IF jsonb_array_length(proposed_inserts)=0 THEN RETURN 0; END IF;
  FOR index IN 1..8 LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',tables[index],guards[index]);
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(proposed_inserts) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (item-ARRAY['table','record'])<>'{}'::jsonb
      OR jsonb_typeof(item->'record') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid complete Confluence replay item'; END IF;
    table_name:=item->>'table';
    IF table_name IS NULL OR NOT table_name=ANY(tables) THEN RAISE EXCEPTION 'Unsupported complete Confluence replay table'; END IF;
    date_keys:=CASE table_name WHEN 'ConfluenceRetainedCopyReview' THEN ARRAY['reviewedAt','expiresAt','recordedAt']
      WHEN 'ConfluenceSyntheticCopyScope' THEN ARRAY['registeredAt','expiresAt']
      WHEN 'ConfluenceRetainedCopyPermission' THEN ARRAY['connectionGeneration','issuedAt','expiresAt']
      WHEN 'ConfluenceCopyRecoveryCapture' THEN ARRAY['capturedAt','recordedAt']
      WHEN 'ConfluenceCopyPublicationPlan' THEN ARRAY['recordedAt']
      WHEN 'ConfluenceCopyPublicationReceipt' THEN ARRAY['recordedAt'] ELSE ARRAY['occurredAt'] END;
    raw_record:=item->'record';
    IF raw_record->>'organisationId' IS DISTINCT FROM charity_id OR coalesce(raw_record->>'id','') !~ '^[A-Za-z0-9_-]{1,200}$' THEN
      RAISE EXCEPTION 'Complete Confluence replay row scope mismatch';
    END IF;
    EXECUTE format('SELECT public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(v),$2) FROM jsonb_populate_record(NULL::public.%I,$1) v',table_name)
      INTO typed_record USING raw_record,date_keys;
    IF typed_record IS DISTINCT FROM raw_record THEN RAISE EXCEPTION 'Complete Confluence replay row fields or dates are not exact'; END IF;
    EXECUTE format('INSERT INTO public.%I SELECT * FROM jsonb_populate_record(NULL::public.%I,$1)',table_name,table_name) USING raw_record;
    GET DIAGNOSTICS affected=ROW_COUNT;
    IF affected<>1 THEN RAISE EXCEPTION 'Complete Confluence replay insert count mismatch'; END IF;
    EXECUTE format('SELECT public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),$2) FROM public.%I t WHERE id=$1',table_name)
      INTO stored_record USING raw_record->>'id',date_keys;
    IF stored_record IS DISTINCT FROM raw_record THEN RAISE EXCEPTION 'Complete Confluence replay readback changed'; END IF;
    inserted:=inserted+1;
  END LOOP;
  FOR index IN 1..8 LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',tables[index],guards[index]);
  END LOOP;
  RETURN inserted;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
REVOKE ALL ON FUNCTION public."ConfluenceCopyLedgerRecovery_replay"(TEXT,JSONB,JSONB) FROM PUBLIC;
COMMIT;
