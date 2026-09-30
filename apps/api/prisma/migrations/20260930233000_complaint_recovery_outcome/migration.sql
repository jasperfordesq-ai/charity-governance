BEGIN;
-- Inactive recovery integration: this records a committed primary claim only.
-- It grants no remote publication, reservation release or reopening permission.
CREATE TABLE "ComplaintRecoveryOutcome" (
  id TEXT PRIMARY KEY,
  "preparationId" TEXT NOT NULL UNIQUE REFERENCES "ComplaintRecoveryPreparation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "claimId" TEXT NOT NULL UNIQUE REFERENCES "ComplaintPurgeClaim"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION "ComplaintRecoveryOutcome_guard_fn"() RETURNS trigger AS $$
DECLARE preparation "ComplaintRecoveryPreparation"%ROWTYPE; claim "ComplaintPurgeClaim"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Recovery outcomes are append-only'; END IF;
  SELECT * INTO preparation FROM "ComplaintRecoveryPreparation" WHERE id=NEW."preparationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Recovery outcome requires original preparation'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=preparation."organisationId" FOR UPDATE;
  SELECT * INTO claim FROM "ComplaintPurgeClaim" WHERE id=NEW."claimId";
  IF NOT FOUND OR claim."transactionId"<>txid_current()
    OR claim."organisationId"<>preparation."organisationId"
    OR claim."authorizationId"<>preparation."authorizationId"
    OR claim."actorUserId"<>preparation."actorUserId"
    OR claim."complaintId" IS DISTINCT FROM (preparation.facts::jsonb#>>'{complaint,id}')
    OR EXISTS (SELECT 1 FROM "ComplaintRecord" WHERE id=claim."complaintId") THEN
    RAISE EXCEPTION 'Recovery outcome requires matching primary claim in the same transaction';
  END IF;
  NEW."transactionId":=txid_current();
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintRecoveryOutcome_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ComplaintRecoveryOutcome"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecoveryOutcome_guard_fn"();
COMMIT;
