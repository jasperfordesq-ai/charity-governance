BEGIN;
-- The local half of a reconciled primary-object completion. A row may exist
-- only alongside the exact deletion job's move to PROCESSED in the same
-- transaction, after a recorded provider observation for the same claimed
-- lease. It certifies the primary active object only: versions, Confluence
-- copies, exports and backups are not covered, and the recovery operation
-- reservation is not released by it. No production worker calls it.
CREATE TABLE "DocumentBytePrimaryCompletion" (
  id TEXT PRIMARY KEY,
  "leaseId" TEXT NOT NULL UNIQUE REFERENCES "DocumentByteExecutionLease"(id) ON DELETE RESTRICT,
  "observationId" TEXT NOT NULL UNIQUE REFERENCES "DocumentByteProviderObservation"(id) ON DELETE RESTRICT,
  "organisationId" TEXT NOT NULL REFERENCES "Organisation"(id) ON DELETE RESTRICT,
  "deletionId" TEXT NOT NULL UNIQUE,
  "decisionEntryDigest" TEXT NOT NULL CHECK ("decisionEntryDigest" ~ '^[a-f0-9]{64}$'),
  "completionEntryDigest" TEXT NOT NULL CHECK ("completionEntryDigest" ~ '^[a-f0-9]{64}$'),
  "completionEnvelopeDigest" TEXT NOT NULL CHECK ("completionEnvelopeDigest" ~ '^[a-f0-9]{64}$'),
  "completionBodyDigest" TEXT NOT NULL CHECK ("completionBodyDigest" ~ '^[a-f0-9]{64}$'),
  scope TEXT NOT NULL CHECK (scope = 'PRIMARY_ACTIVE_OBJECT_ONLY'),
  "completedTransactionId" BIGINT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocumentBytePrimaryCompletion_deletion_fkey"
    FOREIGN KEY ("deletionId","organisationId")
    REFERENCES "DocumentStorageDeletion"(id,"organisationId") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "DocumentBytePrimaryCompletion_deletion_org_key"
  ON "DocumentBytePrimaryCompletion"("deletionId","organisationId");
CREATE INDEX "DocumentBytePrimaryCompletion_org_recorded_idx"
  ON "DocumentBytePrimaryCompletion"("organisationId","recordedAt","leaseId");

CREATE FUNCTION "DocumentBytePrimaryCompletion_guard_fn"() RETURNS trigger AS $$
DECLARE lease_row "DocumentByteExecutionLease"%ROWTYPE;
  attempt_row "DocumentByteProviderAttempt"%ROWTYPE;
  observation_row "DocumentByteProviderObservation"%ROWTYPE;
  candidate "DocumentBytePermitCandidateBinding"%ROWTYPE;
  job "DocumentStorageDeletion"%ROWTYPE;
  enforcement "DocumentRecoveryEnforcement"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Document byte primary completions are append-only';
  END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document byte completion organisation is unavailable'; END IF;
  SELECT * INTO lease_row FROM "DocumentByteExecutionLease" WHERE id=NEW."leaseId" FOR UPDATE;
  IF lease_row.id IS NULL THEN RAISE EXCEPTION 'Document byte completion lease is unavailable'; END IF;
  SELECT * INTO attempt_row FROM "DocumentByteProviderAttempt" WHERE id=lease_row.id;
  SELECT * INTO observation_row FROM "DocumentByteProviderObservation" WHERE id=NEW."observationId";
  SELECT * INTO candidate FROM "DocumentBytePermitCandidateBinding"
    WHERE id=lease_row."candidateBindingId";
  SELECT * INTO job FROM "DocumentStorageDeletion" WHERE id=lease_row."deletionId"
    AND "organisationId"=lease_row."organisationId" FOR UPDATE;
  SELECT * INTO enforcement FROM "DocumentRecoveryEnforcement"
    WHERE "organisationId"=lease_row."organisationId";
  -- The observation must already be durable in an earlier transaction, and
  -- the job must still be the exact pending claim the lease consumed.
  IF NEW.id<>lease_row.id OR NEW."observationId"<>lease_row.id
    OR attempt_row.id IS NULL OR attempt_row."leaseId"<>lease_row.id
    OR observation_row.id IS NULL OR observation_row."leaseId"<>lease_row.id
    OR observation_row."attemptId"<>attempt_row.id
    OR observation_row."organisationId"<>NEW."organisationId"
    OR observation_row."deletionId"<>NEW."deletionId"
    OR observation_row."decisionEntryDigest"<>NEW."decisionEntryDigest"
    OR observation_row.outcome<>'PRIMARY_ACTIVE_OBJECT_ABSENT'
    OR observation_row."observedTransactionId"=txid_current()
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
    OR job."activeObjectAbsentAt" IS NOT NULL
    OR job.provider<>candidate.provider OR job."storagePath"<>candidate."storagePath"
    OR job."targetRef" IS NOT NULL
    OR NEW.scope<>'PRIMARY_ACTIVE_OBJECT_ONLY' THEN
    RAISE EXCEPTION 'Document byte completion observation, lease or target is stale';
  END IF;
  NEW."completedTransactionId" := txid_current();
  NEW."recordedAt" := timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentBytePrimaryCompletion_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "DocumentBytePrimaryCompletion"
  FOR EACH ROW EXECUTE FUNCTION "DocumentBytePrimaryCompletion_guard_fn"();

-- A completion row cannot survive commit unless its job was processed in the
-- same transaction; the job cannot be processed without the row (byte fence).
CREATE FUNCTION "DocumentBytePrimaryCompletion_commit_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "DocumentStorageDeletion"
    WHERE id=NEW."deletionId" AND "organisationId"=NEW."organisationId"
      AND state='PROCESSED' AND "processedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Document byte completion must process its job in the same transaction';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "DocumentBytePrimaryCompletion_commit_guard"
  AFTER INSERT ON "DocumentBytePrimaryCompletion" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "DocumentBytePrimaryCompletion_commit_guard_fn"();

-- Runtime has no direct table writes. The one-use capability that claimed and
-- started the attempt must be presented again, with the digests of the
-- independent completion entry the caller has just authenticated.
CREATE FUNCTION public."DocumentBytePrimaryCompletion_record"(lease_id TEXT, attempt TEXT,
  completion_entry TEXT, completion_envelope TEXT, completion_body TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE lease_row public."DocumentByteExecutionLease"%ROWTYPE;
  observation_row public."DocumentByteProviderObservation"%ROWTYPE;
  target_org TEXT;
  completed_at TIMESTAMP(3);
BEGIN
  IF attempt IS NULL
    OR attempt !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'Invalid document byte attempt capability';
  END IF;
  IF completion_entry IS NULL OR completion_entry !~ '^[a-f0-9]{64}$'
    OR completion_envelope IS NULL OR completion_envelope !~ '^[a-f0-9]{64}$'
    OR completion_body IS NULL OR completion_body !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid document byte completion digest';
  END IF;
  SELECT "organisationId" INTO target_org FROM public."DocumentByteExecutionLease" WHERE id=lease_id;
  IF target_org IS NULL THEN RAISE EXCEPTION 'Document byte completion lease unavailable'; END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=target_org FOR UPDATE;
  SELECT * INTO lease_row FROM public."DocumentByteExecutionLease" WHERE id=lease_id FOR UPDATE;
  IF lease_row.id IS NULL OR lease_row."organisationId"<>target_org
    OR lease_row."attemptHash"<>encode(sha256(convert_to(attempt,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'Document byte attempt capability does not match';
  END IF;
  SELECT * INTO observation_row FROM public."DocumentByteProviderObservation" WHERE "leaseId"=lease_row.id;
  IF observation_row.id IS NULL THEN
    RAISE EXCEPTION 'Document byte completion requires a recorded provider observation';
  END IF;
  INSERT INTO public."DocumentBytePrimaryCompletion"
    (id,"leaseId","observationId","organisationId","deletionId","decisionEntryDigest",
      "completionEntryDigest","completionEnvelopeDigest","completionBodyDigest",
      scope,"completedTransactionId","recordedAt")
    VALUES (lease_row.id,lease_row.id,observation_row.id,lease_row."organisationId",
      lease_row."deletionId",lease_row."decisionEntryDigest",completion_entry,
      completion_envelope,completion_body,'PRIMARY_ACTIVE_OBJECT_ONLY',
      txid_current(),timezone('UTC',clock_timestamp()));
  completed_at := timezone('UTC',clock_timestamp());
  -- A processed job carries no claim or retry time; the completion row keeps
  -- the lease that claimed it.
  UPDATE public."DocumentStorageDeletion" SET state='PROCESSED', "processedAt"=completed_at,
    "activeObjectAbsentAt"=observation_row."providerObservedAt", "claimedAt"=NULL,
    "nextAttemptAt"=NULL, "updatedAt"=completed_at
    WHERE id=lease_row."deletionId" AND "organisationId"=target_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document byte completion job unavailable'; END IF;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public."DocumentBytePrimaryCompletion_record"(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- The byte fence keeps denying every update to an enforced purge-claim job
-- except two exact transitions: the first claim backed by a lease consumed in
-- this transaction (unchanged), and the completion of that claim backed by a
-- completion row inserted in this transaction for the same lease, claim and
-- recorded observation.
CREATE OR REPLACE FUNCTION "DocumentRecoveryByteFence_fn"() RETURNS trigger AS $$
DECLARE claim_org TEXT;
  claim_id TEXT;
BEGIN
  SELECT claim."organisationId", claim.id INTO claim_org, claim_id
    FROM "DocumentPurgeClaim" claim WHERE claim."deletionId"=OLD.id;
  IF claim_org IS NOT NULL THEN
    PERFORM 1 FROM "Organisation" WHERE id=claim_org FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
      WHERE "organisationId"=claim_org) THEN
      IF OLD.state='PENDING' AND NEW.state='PENDING' AND OLD.attempts=0
        AND OLD."claimedAt" IS NULL AND NEW."claimedAt" IS NOT NULL
        AND to_jsonb(NEW)-'claimedAt'-'updatedAt' = to_jsonb(OLD)-'claimedAt'-'updatedAt'
        AND EXISTS (SELECT 1 FROM "DocumentByteExecutionLease" lease
          JOIN "DocumentBytePermitCandidateBinding" candidate
            ON candidate.id=lease."candidateBindingId"
          WHERE lease."deletionId"=OLD.id AND lease."organisationId"=claim_org
            AND candidate."claimId"=claim_id
            AND lease.state='CLAIMED' AND lease."claimTransactionId"=txid_current()
            AND lease."claimedAt"=NEW."claimedAt") THEN
        RETURN NEW;
      END IF;
      -- The completion guard has already bound the row to this pending,
      -- claimed, zero-attempt job under the organisation lock, and its commit
      -- guard means a row from another transaction implies a processed job.
      -- The state constraint clears the claim and retry time. What is left
      -- is that nothing else changes and the job records the observed time.
      IF OLD.state='PENDING' AND NEW.state='PROCESSED'
        AND to_jsonb(NEW)-'state'-'processedAt'-'activeObjectAbsentAt'-'claimedAt'-'nextAttemptAt'-'updatedAt'
          = to_jsonb(OLD)-'state'-'processedAt'-'activeObjectAbsentAt'-'claimedAt'-'nextAttemptAt'-'updatedAt'
        AND EXISTS (SELECT 1 FROM "DocumentBytePrimaryCompletion" completion
          JOIN "DocumentByteProviderObservation" observation
            ON observation.id=completion."observationId"
          WHERE completion."deletionId"=OLD.id
            AND observation."providerObservedAt"=NEW."activeObjectAbsentAt"
            AND NEW."processedAt">=observation."recordedAt") THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Document recovery byte execution requires independent permit';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMIT;
