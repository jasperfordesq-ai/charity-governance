BEGIN;
-- A separately authenticated final decision may be bound by the privileged
-- installer only. A row is a one-use SQL claim capability, not provider-byte
-- authority. The worker still needs an independent current-head check.
CREATE TABLE "DocumentByteExecutionLease" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL REFERENCES "Organisation"(id) ON DELETE RESTRICT,
  "candidateBindingId" TEXT NOT NULL UNIQUE REFERENCES "DocumentBytePermitCandidateBinding"(id) ON DELETE RESTRICT,
  "deletionId" TEXT NOT NULL UNIQUE,
  "decisionEntryDigest" TEXT NOT NULL CHECK ("decisionEntryDigest" ~ '^[a-f0-9]{64}$'),
  "decisionEnvelopeDigest" TEXT NOT NULL CHECK ("decisionEnvelopeDigest" ~ '^[a-f0-9]{64}$'),
  "decisionBodyDigest" TEXT NOT NULL CHECK ("decisionBodyDigest" ~ '^[a-f0-9]{64}$'),
  "localCopyObservationDigest" TEXT NOT NULL CHECK ("localCopyObservationDigest" ~ '^[a-f0-9]{64}$'),
  "localHoldObservationDigest" TEXT NOT NULL CHECK ("localHoldObservationDigest" ~ '^[a-f0-9]{64}$'),
  "providerInventoryDigest" TEXT NOT NULL CHECK ("providerInventoryDigest" ~ '^[a-f0-9]{64}$'),
  "attemptHash" TEXT NOT NULL CHECK ("attemptHash" ~ '^[a-f0-9]{64}$'),
  "insertTransactionId" BIGINT NOT NULL DEFAULT txid_current(),
  state TEXT NOT NULL DEFAULT 'READY' CHECK (state IN ('READY','CLAIMED')),
  "claimTransactionId" BIGINT,
  "claimedAt" TIMESTAMP(3),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentByteExecutionLease_deletion_fkey" FOREIGN KEY ("deletionId","organisationId")
    REFERENCES "DocumentStorageDeletion"(id,"organisationId") ON DELETE RESTRICT,
  CONSTRAINT "DocumentByteExecutionLease_claim_state_check" CHECK (
    (state='READY' AND "claimTransactionId" IS NULL AND "claimedAt" IS NULL)
    OR (state='CLAIMED' AND "claimTransactionId" IS NOT NULL AND "claimedAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "DocumentByteExecutionLease_attemptHash_key" ON "DocumentByteExecutionLease"("attemptHash");
CREATE INDEX "DocumentByteExecutionLease_org_recorded_idx" ON "DocumentByteExecutionLease"("organisationId","recordedAt",id);

CREATE FUNCTION "DocumentByteExecutionLease_guard_fn"() RETURNS trigger AS $$
DECLARE candidate "DocumentBytePermitCandidateBinding"%ROWTYPE;
  job "DocumentStorageDeletion"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Document byte execution leases are immutable outside exact claim'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document byte lease organisation is unavailable'; END IF;
  SELECT * INTO candidate FROM "DocumentBytePermitCandidateBinding" WHERE id=NEW."candidateBindingId";
  SELECT * INTO job FROM "DocumentStorageDeletion" WHERE id=NEW."deletionId"
    AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF candidate.id IS NULL OR job.id IS NULL
    OR candidate."organisationId"<>NEW."organisationId"
    OR candidate."deletionId"<>NEW."deletionId"
    OR job.state<>'PENDING' OR job.attempts<>0 OR job."claimedAt" IS NOT NULL
    OR job."processedAt" IS NOT NULL OR job."deadLetteredAt" IS NOT NULL
    OR job.provider<>candidate.provider OR job."storagePath"<>candidate."storagePath"
    OR NEW.state<>'READY' OR NEW."claimTransactionId" IS NOT NULL OR NEW."claimedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Document byte lease requires exact pending candidate and job';
  END IF;
  NEW."recordedAt" := timezone('UTC',clock_timestamp());
  NEW."insertTransactionId" := txid_current();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentByteExecutionLease_guard"
  BEFORE INSERT OR DELETE ON "DocumentByteExecutionLease"
  FOR EACH ROW EXECUTE FUNCTION "DocumentByteExecutionLease_guard_fn"();

CREATE FUNCTION "DocumentByteExecutionLease_update_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF OLD.state<>'READY' OR NEW.state<>'CLAIMED'
    OR NEW."claimTransactionId"<>txid_current() OR NEW."claimedAt" IS NULL
    OR to_jsonb(NEW)-'state'-'claimTransactionId'-'claimedAt'
      <> to_jsonb(OLD)-'state'-'claimTransactionId'-'claimedAt' THEN
    RAISE EXCEPTION 'Document byte lease cannot be changed outside exact claim';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentByteExecutionLease_update_guard"
  BEFORE UPDATE ON "DocumentByteExecutionLease"
  FOR EACH ROW EXECUTE FUNCTION "DocumentByteExecutionLease_update_guard_fn"();

-- An unused READY lease cannot survive commit. The privileged binder must
-- recheck current local facts under the organisation lock, insert and consume
-- in one transaction; no time gap may admit a new copy or hold.
CREATE FUNCTION "DocumentByteExecutionLease_commit_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "DocumentByteExecutionLease"
    WHERE id=NEW.id AND state='CLAIMED'
      AND "insertTransactionId"="claimTransactionId") THEN
    RAISE EXCEPTION 'Document byte lease must be consumed in its insertion transaction';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "DocumentByteExecutionLease_commit_guard"
  AFTER INSERT ON "DocumentByteExecutionLease" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "DocumentByteExecutionLease_commit_guard_fn"();

-- The sole reachable security-definer function is schema-qualified and has
-- no dynamic SQL or ambient search path. Runtime never receives table writes.
CREATE FUNCTION public."DocumentByteExecutionLease_claim"(lease_id TEXT, attempt TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target_org TEXT;
  lease_row public."DocumentByteExecutionLease"%ROWTYPE;
  candidate public."DocumentBytePermitCandidateBinding"%ROWTYPE;
  job public."DocumentStorageDeletion"%ROWTYPE;
  claim_time TIMESTAMP(3);
BEGIN
  IF attempt !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'Invalid document byte claim capability';
  END IF;
  SELECT "organisationId" INTO target_org FROM public."DocumentByteExecutionLease" WHERE id=lease_id;
  IF target_org IS NULL THEN RAISE EXCEPTION 'Document byte lease unavailable'; END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=target_org FOR UPDATE;
  SELECT * INTO lease_row FROM public."DocumentByteExecutionLease" WHERE id=lease_id FOR UPDATE;
  SELECT * INTO candidate FROM public."DocumentBytePermitCandidateBinding"
    WHERE id=lease_row."candidateBindingId";
  SELECT * INTO job FROM public."DocumentStorageDeletion" WHERE id=lease_row."deletionId"
    AND "organisationId"=target_org FOR UPDATE;
  IF lease_row.id IS NULL OR lease_row.state<>'READY'
    OR lease_row."insertTransactionId"<>txid_current()
    OR lease_row."organisationId"<>target_org OR candidate.id IS NULL
    OR candidate."organisationId"<>target_org OR candidate."deletionId"<>job.id
    OR job.id IS NULL OR job.state<>'PENDING' OR job.attempts<>0
    OR job."claimedAt" IS NOT NULL OR job."processedAt" IS NOT NULL
    OR job."deadLetteredAt" IS NOT NULL OR job.provider<>candidate.provider
    OR job."storagePath"<>candidate."storagePath"
    OR lease_row."attemptHash"<>encode(sha256(convert_to(attempt,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'Document byte lease is stale or capability does not match';
  END IF;
  claim_time := timezone('UTC',clock_timestamp());
  UPDATE public."DocumentByteExecutionLease" SET state='CLAIMED',
    "claimTransactionId"=txid_current(), "claimedAt"=claim_time WHERE id=lease_id;
  UPDATE public."DocumentStorageDeletion" SET "claimedAt"=claim_time,
    "updatedAt"=claim_time WHERE id=job.id;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public."DocumentByteExecutionLease_claim"(TEXT,TEXT) FROM PUBLIC;

-- Preserve the original byte fence for every update except the exact first
-- job claim backed by a lease consumed in this transaction.
CREATE OR REPLACE FUNCTION "DocumentRecoveryByteFence_fn"() RETURNS trigger AS $$
DECLARE claim_org TEXT;
BEGIN
  SELECT claim."organisationId" INTO claim_org
    FROM "DocumentPurgeClaim" claim WHERE claim."deletionId"=OLD.id;
  IF claim_org IS NOT NULL THEN
    PERFORM 1 FROM "Organisation" WHERE id=claim_org FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
      WHERE "organisationId"=claim_org) THEN
      IF OLD.state<>'PENDING' OR NEW.state<>'PENDING' OR OLD.attempts<>0
        OR OLD."claimedAt" IS NOT NULL OR NEW."claimedAt" IS NULL
        OR to_jsonb(NEW)-'claimedAt'-'updatedAt' <> to_jsonb(OLD)-'claimedAt'-'updatedAt'
        OR NOT EXISTS (SELECT 1 FROM "DocumentByteExecutionLease" lease
          JOIN "DocumentBytePermitCandidateBinding" candidate
            ON candidate.id=lease."candidateBindingId"
          WHERE lease."deletionId"=OLD.id AND lease."organisationId"=claim_org
            AND candidate."claimId"=(SELECT id FROM "DocumentPurgeClaim" WHERE "deletionId"=OLD.id)
            AND lease.state='CLAIMED' AND lease."claimTransactionId"=txid_current()
            AND lease."claimedAt"=NEW."claimedAt") THEN
        RAISE EXCEPTION 'Document recovery byte execution requires independent permit';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMIT;
