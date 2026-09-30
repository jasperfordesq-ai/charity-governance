BEGIN;
CREATE TABLE "ComplaintRecoveryPreparation" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "writerEpoch" INTEGER NOT NULL CHECK ("writerEpoch">0),
  "authorizationId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  facts TEXT NOT NULL CHECK (octet_length(facts) BETWEEN 1 AND 32768),
  "factsDigest" TEXT NOT NULL CHECK ("factsDigest" ~ '^[a-f0-9]{64}$'),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organisationId","operationId"),
  FOREIGN KEY ("authorizationId","organisationId") REFERENCES "ComplaintPurgeAuthorization"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ComplaintRecoveryPreparation_organisationId_recordedAt_id_idx"
  ON "ComplaintRecoveryPreparation"("organisationId","recordedAt",id);
CREATE FUNCTION "ComplaintRecoveryPreparation_guard_fn"() RETURNS trigger AS $$
DECLARE payload JSONB; auth "ComplaintPurgeAuthorization"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Recovery preparations are append-only'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recovery preparation requires active charity Owner'; END IF;
  SELECT * INTO auth FROM "ComplaintPurgeAuthorization" WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR auth."actorUserId"<>NEW."actorUserId"
    OR EXISTS (SELECT 1 FROM "ComplaintPurgeAuthorizationWithdrawal" WHERE "authorizationId"=auth.id)
    OR EXISTS (SELECT 1 FROM "ComplaintPurgeClaim" WHERE "authorizationId"=auth.id) THEN
    RAISE EXCEPTION 'Recovery preparation requires unclaimed unwithdrawn Owner review';
  END IF;
  payload:=NEW.facts::jsonb;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object'
    OR payload->>'format' IS DISTINCT FROM '1'
    OR payload->>'action' IS DISTINCT FROM 'COMPLAINT_PURGE_PREPARATION'
    OR payload->>'organisationId' IS DISTINCT FROM NEW."organisationId"
    OR payload->>'installationId' IS DISTINCT FROM NEW."installationId"
    OR payload->>'operationId' IS DISTINCT FROM NEW."operationId"
    OR payload->>'writerEpoch' IS DISTINCT FROM NEW."writerEpoch"::text
    OR payload->>'actorUserId' IS DISTINCT FROM NEW."actorUserId"
    OR payload#>>'{authorization,id}' IS DISTINCT FROM auth.id
    OR NEW."factsDigest"<>encode(sha256(convert_to(NEW.facts,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'Recovery preparation identity or digest mismatch';
  END IF;
  -- No state transition, claim insertion, job dispatch or execution permit.
  -- Full typed validation and fresh source capture also belong to the service.
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintRecoveryPreparation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ComplaintRecoveryPreparation"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecoveryPreparation_guard_fn"();
COMMIT;
