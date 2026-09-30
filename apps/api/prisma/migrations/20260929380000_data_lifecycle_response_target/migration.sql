-- A case-specific operational target. Existing requests have no inferred date.
ALTER TABLE "DataLifecycleRequest" ADD COLUMN "targetResponseAt" TIMESTAMP(3);
ALTER TABLE "DataLifecycleRequest" ADD CONSTRAINT "DataLifecycleRequest_target_after_receipt"
  CHECK ("targetResponseAt" IS NULL OR "targetResponseAt" >= "receivedAt") NOT VALID;
CREATE INDEX "DataLifecycleRequest_organisationId_targetResponseAt_id_idx"
  ON "DataLifecycleRequest"("organisationId", "targetResponseAt", "id");

CREATE TABLE "DataLifecycleTargetEvent" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "previousTargetAt" TIMESTAMP(3),
  "nextTargetAt" TIMESTAMP(3),
  "reason" TEXT NOT NULL,
  "evidenceRef" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataLifecycleTargetEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataLifecycleTargetEvent_requestId_organisationId_fkey"
    FOREIGN KEY ("requestId", "organisationId")
    REFERENCES "DataLifecycleRequest"("id", "organisationId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DataLifecycleTargetEvent_reason_valid"
    CHECK (char_length("reason") BETWEEN 10 AND 500),
  CONSTRAINT "DataLifecycleTargetEvent_evidenceRef_valid"
    CHECK ("evidenceRef" IS NULL OR "evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$')
);
CREATE INDEX "DataLifecycleTargetEvent_organisationId_requestId_occurredAt_id_idx"
  ON "DataLifecycleTargetEvent"("organisationId", "requestId", "occurredAt", "id");

CREATE FUNCTION "DataLifecycleTargetEvent_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Data lifecycle target history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataLifecycleTargetEvent_append_only"
  BEFORE UPDATE OR DELETE ON "DataLifecycleTargetEvent"
  FOR EACH ROW EXECUTE FUNCTION "DataLifecycleTargetEvent_append_only_fn"();
