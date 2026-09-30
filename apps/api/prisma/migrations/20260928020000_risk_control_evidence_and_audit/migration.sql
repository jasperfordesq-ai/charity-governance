CREATE TABLE "RiskChangeAudit" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "riskId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "action" TEXT NOT NULL,
  "beforeState" JSONB,
  "afterState" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiskChangeAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RiskChangeAudit_action_valid" CHECK (
    ("action" = 'CREATE' AND "beforeState" IS NULL AND "afterState" IS NOT NULL) OR
    ("action" = 'UPDATE' AND "beforeState" IS NOT NULL AND "afterState" IS NOT NULL) OR
    ("action" = 'DELETE' AND "beforeState" IS NOT NULL AND "afterState" IS NULL)
  )
);
CREATE INDEX "RiskChangeAudit_organisationId_occurredAt_idx"
  ON "RiskChangeAudit"("organisationId", "occurredAt");
CREATE INDEX "RiskChangeAudit_organisationId_riskId_occurredAt_idx"
  ON "RiskChangeAudit"("organisationId", "riskId", "occurredAt");

CREATE TABLE "RiskControlVerification" (
  "id" TEXT NOT NULL,
  "sequence" SERIAL NOT NULL,
  "organisationId" TEXT NOT NULL,
  "riskId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "controlReference" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "evidenceReference" TEXT,
  "affectedRelease" TEXT,
  "reason" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiskControlVerification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RiskControlVerification_valid" CHECK (
    "state" IN ('VERIFIED', 'WITHDRAWN')
    AND char_length("controlReference") BETWEEN 2 AND 120
    AND char_length("reason") BETWEEN 10 AND 500
    AND char_length("actorUserId") > 0
    AND ("affectedRelease" IS NULL OR char_length("affectedRelease") BETWEEN 1 AND 200)
    AND (
      ("state" = 'VERIFIED' AND "verifiedAt" IS NOT NULL AND "evidenceReference" IS NOT NULL
        AND char_length("evidenceReference") BETWEEN 3 AND 500)
      OR ("state" = 'WITHDRAWN' AND "verifiedAt" IS NULL)
    )
  )
);
CREATE UNIQUE INDEX "RiskControlVerification_sequence_key"
  ON "RiskControlVerification"("sequence");
CREATE INDEX "RiskControlVerification_organisationId_riskId_occurredAt_idx"
  ON "RiskControlVerification"("organisationId", "riskId", "occurredAt");
CREATE INDEX "RiskControlVerification_organisationId_riskId_sequence_idx"
  ON "RiskControlVerification"("organisationId", "riskId", "sequence");
CREATE INDEX "RiskControlVerification_organisationId_sequence_idx"
  ON "RiskControlVerification"("organisationId", "sequence");

CREATE FUNCTION "RiskEvidence_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Risk evidence is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "RiskChangeAudit_append_only" BEFORE UPDATE OR DELETE ON "RiskChangeAudit"
  FOR EACH ROW EXECUTE FUNCTION "RiskEvidence_append_only_fn"();
CREATE TRIGGER "RiskControlVerification_append_only" BEFORE UPDATE OR DELETE ON "RiskControlVerification"
  FOR EACH ROW EXECUTE FUNCTION "RiskEvidence_append_only_fn"();
