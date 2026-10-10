BEGIN;
-- One append-only provider observation for a committed possible-I/O marker.
-- It records only that the primary active object was observed absent after
-- the marker; it is not proof that versions, copies, exports or backups are
-- gone, it changes no deletion job and it relaxes no byte fence. The job
-- remains PENDING and every completion path still needs a separate permit.
CREATE TABLE "DocumentByteProviderObservation" (
  id TEXT PRIMARY KEY,
  "leaseId" TEXT NOT NULL UNIQUE REFERENCES "DocumentByteExecutionLease"(id) ON DELETE RESTRICT,
  "attemptId" TEXT NOT NULL UNIQUE REFERENCES "DocumentByteProviderAttempt"(id) ON DELETE RESTRICT,
  "organisationId" TEXT NOT NULL REFERENCES "Organisation"(id) ON DELETE RESTRICT,
  "deletionId" TEXT NOT NULL UNIQUE,
  "decisionEntryDigest" TEXT NOT NULL CHECK ("decisionEntryDigest" ~ '^[a-f0-9]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome = 'PRIMARY_ACTIVE_OBJECT_ABSENT'),
  "providerObservedAt" TIMESTAMP(3) NOT NULL,
  "observedTransactionId" BIGINT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocumentByteProviderObservation_deletion_fkey"
    FOREIGN KEY ("deletionId","organisationId")
    REFERENCES "DocumentStorageDeletion"(id,"organisationId") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "DocumentByteProviderObservation_deletion_org_key"
  ON "DocumentByteProviderObservation"("deletionId","organisationId");
CREATE INDEX "DocumentByteProviderObservation_org_recorded_idx"
  ON "DocumentByteProviderObservation"("organisationId","recordedAt","leaseId");

CREATE FUNCTION "DocumentByteProviderObservation_guard_fn"() RETURNS trigger AS $$
DECLARE lease_row "DocumentByteExecutionLease"%ROWTYPE;
  attempt_row "DocumentByteProviderAttempt"%ROWTYPE;
  candidate "DocumentBytePermitCandidateBinding"%ROWTYPE;
  job "DocumentStorageDeletion"%ROWTYPE;
  enforcement "DocumentRecoveryEnforcement"%ROWTYPE;
  observed_now TIMESTAMP(3);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Document byte provider observations are append-only';
  END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document byte observation organisation is unavailable'; END IF;
  SELECT * INTO lease_row FROM "DocumentByteExecutionLease" WHERE id=NEW."leaseId" FOR UPDATE;
  IF lease_row.id IS NULL THEN RAISE EXCEPTION 'Document byte observation lease is unavailable'; END IF;
  SELECT * INTO attempt_row FROM "DocumentByteProviderAttempt" WHERE id=NEW."attemptId";
  SELECT * INTO candidate FROM "DocumentBytePermitCandidateBinding"
    WHERE id=lease_row."candidateBindingId";
  SELECT * INTO job FROM "DocumentStorageDeletion" WHERE id=lease_row."deletionId"
    AND "organisationId"=lease_row."organisationId" FOR UPDATE;
  SELECT * INTO enforcement FROM "DocumentRecoveryEnforcement"
    WHERE "organisationId"=lease_row."organisationId";
  observed_now := timezone('UTC',clock_timestamp());
  -- The marker must already be durable in an earlier transaction: an
  -- observation can never stand in for the possible-I/O record it follows.
  IF attempt_row.id IS NULL OR attempt_row."leaseId"<>lease_row.id
    OR attempt_row.id<>NEW."leaseId"
    OR attempt_row."organisationId"<>NEW."organisationId"
    OR attempt_row."deletionId"<>NEW."deletionId"
    OR attempt_row."decisionEntryDigest"<>NEW."decisionEntryDigest"
    OR attempt_row."startedTransactionId"=txid_current()
    OR lease_row.state<>'CLAIMED' OR lease_row."claimedAt" IS NULL
    OR lease_row."organisationId"<>NEW."organisationId"
    OR lease_row."deletionId"<>NEW."deletionId"
    OR lease_row."decisionEntryDigest"<>NEW."decisionEntryDigest"
    OR candidate.id IS NULL OR candidate."organisationId"<>NEW."organisationId"
    OR candidate."deletionId"<>NEW."deletionId"
    OR enforcement.id IS NULL OR enforcement."writerId"<>candidate."writerId"
    OR enforcement."writerEpoch"<>candidate."writerEpoch"
    OR job.id IS NULL OR job.state<>'PENDING' OR job.attempts<>0
    OR job."claimedAt" IS DISTINCT FROM lease_row."claimedAt"
    OR job."processedAt" IS NOT NULL OR job."deadLetteredAt" IS NOT NULL
    OR job.provider<>candidate.provider OR job."storagePath"<>candidate."storagePath"
    OR job."targetRef" IS NOT NULL
    OR NEW.outcome<>'PRIMARY_ACTIVE_OBJECT_ABSENT'
    OR NEW."providerObservedAt" IS NULL
    OR NEW."providerObservedAt" < attempt_row."startedAt"
    OR NEW."providerObservedAt" > observed_now THEN
    RAISE EXCEPTION 'Document byte observation attempt or target is stale';
  END IF;
  NEW."observedTransactionId" := txid_current();
  NEW."recordedAt" := observed_now;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentByteProviderObservation_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "DocumentByteProviderObservation"
  FOR EACH ROW EXECUTE FUNCTION "DocumentByteProviderObservation_guard_fn"();

-- Runtime has no direct table writes. The same one-use capability that
-- started the attempt must be presented; a second observation is refused.
CREATE FUNCTION public."DocumentByteProviderObservation_recordAbsent"(lease_id TEXT,
  attempt TEXT, observed_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE lease_row public."DocumentByteExecutionLease"%ROWTYPE;
  target_org TEXT;
BEGIN
  IF attempt IS NULL
    OR attempt !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'Invalid document byte attempt capability';
  END IF;
  IF observed_at IS NULL OR NOT isfinite(observed_at) THEN
    RAISE EXCEPTION 'Invalid document byte provider observation time';
  END IF;
  SELECT "organisationId" INTO target_org FROM public."DocumentByteExecutionLease" WHERE id=lease_id;
  IF target_org IS NULL THEN RAISE EXCEPTION 'Document byte observation lease unavailable'; END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=target_org FOR UPDATE;
  SELECT * INTO lease_row FROM public."DocumentByteExecutionLease" WHERE id=lease_id FOR UPDATE;
  IF lease_row.id IS NULL OR lease_row."organisationId"<>target_org
    OR lease_row."attemptHash"<>encode(sha256(convert_to(attempt,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'Document byte attempt capability does not match';
  END IF;
  INSERT INTO public."DocumentByteProviderObservation"
    (id,"leaseId","attemptId","organisationId","deletionId","decisionEntryDigest",
      outcome,"providerObservedAt","observedTransactionId","recordedAt")
    VALUES (lease_row.id,lease_row.id,lease_row.id,lease_row."organisationId",
      lease_row."deletionId",lease_row."decisionEntryDigest",'PRIMARY_ACTIVE_OBJECT_ABSENT',
      timezone('UTC',observed_at),txid_current(),timezone('UTC',clock_timestamp()));
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public."DocumentByteProviderObservation_recordAbsent"(TEXT,TEXT,TIMESTAMPTZ) FROM PUBLIC;
COMMIT;
