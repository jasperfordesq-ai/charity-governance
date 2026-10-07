BEGIN;
-- A committed, one-use marker before the first provider call. A marker is
-- not proof that the call reached the provider or that bytes were removed.
-- Its presence requires UNKNOWN reconciliation after a crash or timeout.
CREATE TABLE "DocumentByteProviderAttempt" (
  id TEXT PRIMARY KEY,
  "leaseId" TEXT NOT NULL UNIQUE REFERENCES "DocumentByteExecutionLease"(id) ON DELETE RESTRICT,
  "organisationId" TEXT NOT NULL REFERENCES "Organisation"(id) ON DELETE RESTRICT,
  "deletionId" TEXT NOT NULL UNIQUE,
  "decisionEntryDigest" TEXT NOT NULL CHECK ("decisionEntryDigest" ~ '^[a-f0-9]{64}$'),
  "startedTransactionId" BIGINT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocumentByteProviderAttempt_deletion_fkey"
    FOREIGN KEY ("deletionId","organisationId")
    REFERENCES "DocumentStorageDeletion"(id,"organisationId") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "DocumentByteProviderAttempt_deletion_org_key"
  ON "DocumentByteProviderAttempt"("deletionId","organisationId");
CREATE INDEX "DocumentByteProviderAttempt_org_started_idx"
  ON "DocumentByteProviderAttempt"("organisationId","startedAt","leaseId");

CREATE FUNCTION "DocumentByteProviderAttempt_guard_fn"() RETURNS trigger AS $$
DECLARE lease_row "DocumentByteExecutionLease"%ROWTYPE;
  candidate "DocumentBytePermitCandidateBinding"%ROWTYPE;
  job "DocumentStorageDeletion"%ROWTYPE;
  enforcement "DocumentRecoveryEnforcement"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Document byte provider attempts are append-only';
  END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document byte attempt organisation is unavailable'; END IF;
  SELECT * INTO lease_row FROM "DocumentByteExecutionLease" WHERE id=NEW."leaseId" FOR UPDATE;
  IF lease_row.id IS NULL THEN RAISE EXCEPTION 'Document byte attempt lease is unavailable'; END IF;
  SELECT * INTO candidate FROM "DocumentBytePermitCandidateBinding"
    WHERE id=lease_row."candidateBindingId";
  SELECT * INTO job FROM "DocumentStorageDeletion" WHERE id=lease_row."deletionId"
    AND "organisationId"=lease_row."organisationId" FOR UPDATE;
  SELECT * INTO enforcement FROM "DocumentRecoveryEnforcement"
    WHERE "organisationId"=lease_row."organisationId";
  IF lease_row.state<>'CLAIMED' OR lease_row."claimedAt" IS NULL
    OR lease_row."insertTransactionId"<>lease_row."claimTransactionId"
    OR lease_row."claimTransactionId"=txid_current()
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
    OR timezone('UTC',clock_timestamp()) < lease_row."claimedAt"
    OR timezone('UTC',clock_timestamp()) - lease_row."claimedAt" > INTERVAL '120 seconds' THEN
    RAISE EXCEPTION 'Document byte attempt lease or target is stale';
  END IF;
  NEW."startedTransactionId" := txid_current();
  NEW."startedAt" := timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentByteProviderAttempt_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "DocumentByteProviderAttempt"
  FOR EACH ROW EXECUTE FUNCTION "DocumentByteProviderAttempt_guard_fn"();

-- Runtime has no direct table writes. The capability is checked without
-- storing its plaintext; a second call cannot create another marker.
CREATE FUNCTION public."DocumentByteProviderAttempt_start"(lease_id TEXT, attempt TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE lease_row public."DocumentByteExecutionLease"%ROWTYPE;
  target_org TEXT;
BEGIN
  IF attempt !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'Invalid document byte attempt capability';
  END IF;
  SELECT "organisationId" INTO target_org FROM public."DocumentByteExecutionLease" WHERE id=lease_id;
  IF target_org IS NULL THEN RAISE EXCEPTION 'Document byte attempt lease unavailable'; END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=target_org FOR UPDATE;
  SELECT * INTO lease_row FROM public."DocumentByteExecutionLease" WHERE id=lease_id FOR UPDATE;
  IF lease_row.id IS NULL OR lease_row."organisationId"<>target_org
    OR lease_row."attemptHash"<>encode(sha256(convert_to(attempt,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'Document byte attempt capability does not match';
  END IF;
  INSERT INTO public."DocumentByteProviderAttempt"
    (id,"leaseId","organisationId","deletionId","decisionEntryDigest",
      "startedTransactionId","startedAt")
    VALUES (lease_row.id,lease_row.id,lease_row."organisationId",lease_row."deletionId",
      lease_row."decisionEntryDigest",txid_current(),timezone('UTC',clock_timestamp()));
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public."DocumentByteProviderAttempt_start"(TEXT,TEXT) FROM PUBLIC;
COMMIT;
