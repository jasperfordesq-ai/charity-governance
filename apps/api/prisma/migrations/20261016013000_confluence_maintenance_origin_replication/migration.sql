BEGIN;
-- Preserve earlier checksums. Enabled catalogue flags are insufficient in a
-- replica-mode session: FK/ordinary triggers do not fire. Refuse, never reset
-- an ambient replication mode or silently weaken historical replay checks.
CREATE OR REPLACE FUNCTION public."ConfluenceCopyLedgerRecovery_assert"(charity_id TEXT) RETURNS VOID AS $$
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
  IF current_setting('session_replication_role')<>'origin' THEN
    RAISE EXCEPTION 'Confluence replay requires the origin replication role';
  END IF;
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


CREATE OR REPLACE FUNCTION public."ConfluenceCopyRecovery_replay"(charity_id TEXT, expected_rows JSONB, proposed_inserts JSONB)
RETURNS INTEGER AS $$
DECLARE table_name TEXT; date_keys TEXT[]; item JSONB; raw_record JSONB;
  typed_record JSONB; stored_record JSONB; inserted INTEGER:=0; affected INTEGER;
  tables TEXT[]:=ARRAY['ConfluenceRetainedCopyReview','ConfluenceSyntheticCopyScope','ConfluenceRetainedCopyPermission',
    'ConfluenceRetainedCopyReviewWithdrawal','ConfluenceRetainedCopyPermissionWithdrawal'];
BEGIN
  -- Check invoker ownership before any lock, catalog-dependent DDL or data read.
  FOREACH table_name IN ARRAY tables LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass(format('public.%I',table_name))
      AND pg_get_userbyid(relowner)=current_user) THEN
      RAISE EXCEPTION 'Confluence replay requires the maintenance table owner';
    END IF;
  END LOOP;
  IF current_setting('session_replication_role')<>'origin' THEN
    RAISE EXCEPTION 'Confluence replay requires the origin replication role';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Confluence replay requires fresh read-committed snapshots';
  END IF;
  IF jsonb_typeof(expected_rows) IS DISTINCT FROM 'object' OR jsonb_typeof(proposed_inserts) IS DISTINCT FROM 'array'
    OR octet_length(expected_rows::text)>134217728 OR octet_length(proposed_inserts::text)>134217728 THEN
    RAISE EXCEPTION 'Invalid or over-capacity Confluence replay input';
  END IF;
  IF jsonb_array_length(proposed_inserts)>50000 THEN RAISE EXCEPTION 'Confluence replay row capacity exceeded'; END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=charity_id AND "lifecycleStatus"='SUSPENDED' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence replay requires a quarantined charity'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
    AND backend_type='client backend') THEN
    RAISE EXCEPTION 'Confluence replay requires exclusive maintenance client access';
  END IF;
  LOCK TABLE public."ConfluenceRetainedCopyReview",public."ConfluenceSyntheticCopyScope",public."ConfluenceRetainedCopyPermission",
    public."ConfluenceRetainedCopyReviewWithdrawal",public."ConfluenceRetainedCopyPermissionWithdrawal" IN ACCESS EXCLUSIVE MODE;
  FOREACH table_name IN ARRAY tables LOOP
    IF (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass(format('public.%I',table_name)) AND NOT tgisinternal)<>2
      OR (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass(format('public.%I',table_name)) AND NOT tgisinternal
        AND tgname IN (table_name||'_guard',table_name||'_no_truncate') AND tgenabled='O')<>2
      OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(format('public.%I',table_name)) AND tgisinternal AND tgenabled<>'O') THEN
      RAISE EXCEPTION 'Confluence replay requires exact enabled guards and foreign keys';
    END IF;
  END LOOP;
  IF public."ConfluenceCopyRecovery_rows"(charity_id) IS DISTINCT FROM expected_rows THEN
    RAISE EXCEPTION 'Confluence replay local decisions changed';
  END IF;
  IF jsonb_array_length(proposed_inserts)=0 THEN RETURN 0; END IF;
  -- Historical evidence cannot pass ordinary current-time/active-Owner stamping.
  -- Only this invoker-owned exclusive transaction pauses the five exact guards;
  -- FK/CHECK/unique constraints and no-truncate guards remain enabled throughout.
  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',table_name,table_name||'_guard');
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(proposed_inserts) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (item-ARRAY['table','record'])<>'{}'::jsonb
      OR jsonb_typeof(item->'record') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid Confluence replay item'; END IF;
    table_name:=CASE item->>'table' WHEN 'reviews' THEN tables[1] WHEN 'scopes' THEN tables[2]
      WHEN 'permissions' THEN tables[3] WHEN 'reviewWithdrawals' THEN tables[4] WHEN 'permissionWithdrawals' THEN tables[5] END;
    IF table_name IS NULL THEN RAISE EXCEPTION 'Unsupported Confluence replay table'; END IF;
    date_keys:=CASE item->>'table' WHEN 'reviews' THEN ARRAY['reviewedAt','expiresAt','recordedAt']
      WHEN 'scopes' THEN ARRAY['registeredAt','expiresAt'] WHEN 'permissions' THEN ARRAY['connectionGeneration','issuedAt','expiresAt']
      ELSE ARRAY['occurredAt'] END;
    raw_record:=item->'record';
    IF raw_record->>'organisationId' IS DISTINCT FROM charity_id OR coalesce(raw_record->>'id','') !~ '^[A-Za-z0-9_-]{1,200}$' THEN
      RAISE EXCEPTION 'Confluence replay row scope mismatch';
    END IF;
    EXECUTE format('SELECT public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(v),$2) FROM jsonb_populate_record(NULL::public.%I,$1) v',table_name)
      INTO typed_record USING raw_record,date_keys;
    IF typed_record IS DISTINCT FROM raw_record THEN RAISE EXCEPTION 'Confluence replay row fields or dates are not exact'; END IF;
    EXECUTE format('INSERT INTO public.%I SELECT * FROM jsonb_populate_record(NULL::public.%I,$1)',table_name,table_name) USING raw_record;
    GET DIAGNOSTICS affected=ROW_COUNT;
    IF affected<>1 THEN RAISE EXCEPTION 'Confluence replay insert did not affect exactly one row'; END IF;
    EXECUTE format('SELECT public."ConfluenceCopyCapture_timestamp_row"(to_jsonb(t),$2) FROM public.%I t WHERE id=$1',table_name)
      INTO stored_record USING raw_record->>'id',date_keys;
    IF stored_record IS DISTINCT FROM raw_record THEN RAISE EXCEPTION 'Confluence replay readback changed'; END IF;
    inserted:=inserted+1;
  END LOOP;
  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I',table_name,table_name||'_guard');
  END LOOP;
  RETURN inserted;
END;
$$ LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp;
REVOKE ALL ON FUNCTION public."ConfluenceCopyRecovery_replay"(TEXT,JSONB,JSONB) FROM PUBLIC;
COMMIT;
