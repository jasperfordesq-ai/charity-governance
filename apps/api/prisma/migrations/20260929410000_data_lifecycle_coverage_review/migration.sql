CREATE TYPE "DataLifecycleCoverageArea" AS ENUM (
  'ACCOUNT_AUTH', 'GOVERNANCE_RECORDS', 'VAULT_FILES', 'EXTERNAL_COPIES',
  'EXPORTS', 'AUDIT_LOGS', 'BACKUPS', 'BILLING_PROVIDER'
);
CREATE TYPE "DataLifecycleCoverageDisposition" AS ENUM (
  'IN_SCOPE', 'NEEDS_FOLLOW_UP', 'NOT_APPLICABLE'
);

CREATE TABLE "DataLifecycleCoverageEvent" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "area" "DataLifecycleCoverageArea" NOT NULL,
  "disposition" "DataLifecycleCoverageDisposition" NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "evidenceRef" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataLifecycleCoverageEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataLifecycleCoverageEvent_requestId_organisationId_fkey"
    FOREIGN KEY ("requestId", "organisationId")
    REFERENCES "DataLifecycleRequest"("id", "organisationId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DataLifecycleCoverageEvent_reason_valid"
    CHECK (char_length("reason") BETWEEN 10 AND 500),
  CONSTRAINT "DataLifecycleCoverageEvent_evidenceRef_valid"
    CHECK ("evidenceRef" IS NULL OR "evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$')
);
CREATE INDEX "DataLifecycleCoverageEvent_organisationId_requestId_area_occurredAt_id_idx"
  ON "DataLifecycleCoverageEvent"("organisationId", "requestId", "area", "occurredAt", "id");
CREATE INDEX "DataLifecycleCoverageEvent_organisationId_requestId_occurredAt_id_idx"
  ON "DataLifecycleCoverageEvent"("organisationId", "requestId", "occurredAt", "id");

CREATE FUNCTION "DataLifecycleCoverageEvent_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Data lifecycle coverage history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataLifecycleCoverageEvent_append_only"
  BEFORE UPDATE OR DELETE ON "DataLifecycleCoverageEvent"
  FOR EACH ROW EXECUTE FUNCTION "DataLifecycleCoverageEvent_append_only_fn"();
