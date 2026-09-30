BEGIN;
-- Inactive terminal local evidence. Never clears an independent reservation.
CREATE TABLE "ComplaintRecoveryCancellation" (
  id TEXT PRIMARY KEY,
  "primaryPreparationId" TEXT UNIQUE REFERENCES "ComplaintRecoveryPreparation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "holdPreparationId" TEXT UNIQUE REFERENCES "ComplaintHoldRecoveryPreparation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorUserId" TEXT NOT NULL,
  "writerId" TEXT NOT NULL CHECK ("writerId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "reasonCode" TEXT NOT NULL CHECK ("reasonCode" IN ('OPERATOR_CANCELLED','DEPENDENCIES_CHANGED')),
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("primaryPreparationId" IS NOT NULL)::int + ("holdPreparationId" IS NOT NULL)::int = 1)
);
CREATE FUNCTION "ComplaintRecoveryCancellation_guard_fn"() RETURNS trigger AS $$
DECLARE org TEXT; installation TEXT; epoch INTEGER; target_authorization TEXT; event TEXT;
BEGIN
  -- Checks after waiting on the charity lock must see the competing commit.
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Recovery cancellation boundary requires read committed isolation';
  END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Recovery cancellations are append-only'; END IF;
  IF (NEW."primaryPreparationId" IS NULL) = (NEW."holdPreparationId" IS NULL) THEN
    RAISE EXCEPTION 'Cancellation requires exactly one original preparation';
  END IF;
  IF NEW."primaryPreparationId" IS NOT NULL THEN
    SELECT "organisationId","installationId","writerEpoch","authorizationId"
      INTO org,installation,epoch,target_authorization FROM "ComplaintRecoveryPreparation" WHERE id=NEW."primaryPreparationId";
  ELSE
    SELECT "organisationId","installationId","writerEpoch",facts::jsonb#>>'{decision,id}'
      INTO org,installation,epoch,event FROM "ComplaintHoldRecoveryPreparation" WHERE id=NEW."holdPreparationId";
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cancellation requires original preparation'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=org FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=org AND "lifecycleStatus"='ACTIVE'
    AND (role='OWNER' OR (NEW."holdPreparationId" IS NOT NULL AND role='ADMIN')) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cancellation requires current charity authority'; END IF;
  PERFORM 1 FROM "ComplaintRecoveryEnforcement" WHERE "organisationId"=org AND "installationId"=installation
    AND "writerEpoch"=epoch AND "writerId"=NEW."writerId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Cancellation requires exact enforced writer'; END IF;
  IF NEW."primaryPreparationId" IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "ComplaintRecoveryExecution" WHERE "preparationId"=NEW."primaryPreparationId")
      OR EXISTS (SELECT 1 FROM "ComplaintRecoveryOutcome" WHERE "preparationId"=NEW."primaryPreparationId")
      OR EXISTS (SELECT 1 FROM "ComplaintPurgeClaim" WHERE "authorizationId"=target_authorization) THEN
      RAISE EXCEPTION 'Executed recovery operation cannot be cancelled';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "ComplaintHoldRecoveryOutcome" WHERE "preparationId"=NEW."holdPreparationId")
      OR EXISTS (SELECT 1 FROM "ComplaintHoldEvent" WHERE id=event) THEN
      RAISE EXCEPTION 'Executed recovery operation cannot be cancelled';
    END IF;
  END IF;
  NEW."transactionId":=txid_current(); NEW."recordedAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintRecoveryCancellation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ComplaintRecoveryCancellation"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecoveryCancellation_guard_fn"();

-- Serializes every prepared execution/outcome against cancellation, including a
-- process that verified remote state before the cancellation committed locally.
CREATE FUNCTION "ComplaintRecoveryCancellation_execution_guard_fn"() RETURNS trigger AS $$
DECLARE org TEXT; cancelled BOOLEAN;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Recovery cancellation boundary requires read committed isolation';
  END IF;
  IF TG_TABLE_NAME='ComplaintHoldRecoveryOutcome' THEN
    SELECT "organisationId" INTO org FROM "ComplaintHoldRecoveryPreparation" WHERE id=NEW."preparationId";
  ELSE
    SELECT "organisationId" INTO org FROM "ComplaintRecoveryPreparation" WHERE id=NEW."preparationId";
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Execution requires original preparation'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=org FOR UPDATE;
  IF TG_TABLE_NAME='ComplaintHoldRecoveryOutcome' THEN
    SELECT EXISTS (SELECT 1 FROM "ComplaintRecoveryCancellation" WHERE "holdPreparationId"=NEW."preparationId") INTO cancelled;
  ELSE
    SELECT EXISTS (SELECT 1 FROM "ComplaintRecoveryCancellation" WHERE "primaryPreparationId"=NEW."preparationId") INTO cancelled;
  END IF;
  IF cancelled THEN RAISE EXCEPTION 'Cancelled recovery operation cannot execute'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "A_recovery_cancellation" BEFORE INSERT ON "ComplaintRecoveryExecution"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecoveryCancellation_execution_guard_fn"();
CREATE TRIGGER "A_recovery_cancellation" BEFORE INSERT ON "ComplaintRecoveryOutcome"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecoveryCancellation_execution_guard_fn"();
CREATE TRIGGER "A_recovery_cancellation" BEFORE INSERT ON "ComplaintHoldRecoveryOutcome"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecoveryCancellation_execution_guard_fn"();
COMMIT;
