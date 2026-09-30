-- A reviewer-recorded response fact. Existing cases have no inferred response.
ALTER TABLE "DataLifecycleRequest" ADD COLUMN "responseSentAt" TIMESTAMP(3);
ALTER TABLE "DataLifecycleRequest" ADD CONSTRAINT "DataLifecycleRequest_response_after_receipt"
  CHECK ("responseSentAt" IS NULL OR "responseSentAt" >= "receivedAt") NOT VALID;

CREATE TABLE "DataLifecycleResponseEvent" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "previousResponseAt" TIMESTAMP(3),
  "nextResponseAt" TIMESTAMP(3),
  "reason" TEXT NOT NULL,
  "evidenceRef" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataLifecycleResponseEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataLifecycleResponseEvent_requestId_organisationId_fkey"
    FOREIGN KEY ("requestId", "organisationId")
    REFERENCES "DataLifecycleRequest"("id", "organisationId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DataLifecycleResponseEvent_reason_valid"
    CHECK (char_length("reason") BETWEEN 10 AND 500),
  CONSTRAINT "DataLifecycleResponseEvent_evidenceRef_valid"
    CHECK ("evidenceRef" IS NULL OR "evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  CONSTRAINT "DataLifecycleResponseEvent_evidence_required"
    CHECK ("nextResponseAt" IS NULL OR "evidenceRef" IS NOT NULL)
);
CREATE INDEX "DataLifecycleResponseEvent_organisationId_requestId_occurredAt_id_idx"
  ON "DataLifecycleResponseEvent"("organisationId", "requestId", "occurredAt", "id");

CREATE FUNCTION "DataLifecycleResponseEvent_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Data lifecycle response history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataLifecycleResponseEvent_append_only"
  BEFORE UPDATE OR DELETE ON "DataLifecycleResponseEvent"
  FOR EACH ROW EXECUTE FUNCTION "DataLifecycleResponseEvent_append_only_fn"();
