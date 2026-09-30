-- Historical claims cannot be assigned a risk revision without inventing
-- evidence. Existing risks begin at revision 1; new edits increment it.
ALTER TABLE "RiskRecord"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "RiskRecord"
  ADD CONSTRAINT "RiskRecord_revision_positive" CHECK ("revision" >= 1);

CREATE FUNCTION "guard_risk_record_revision"() RETURNS trigger AS $$
BEGIN
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Risk edit must advance its revision exactly once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RiskRecord_revision_on_update"
  BEFORE UPDATE ON "RiskRecord"
  FOR EACH ROW EXECUTE FUNCTION "guard_risk_record_revision"();

-- New claims capture the locked risk row's integer revision at recording.
ALTER TABLE "RiskControlVerification"
  ADD COLUMN "riskRevision" INTEGER;

CREATE INDEX "RiskControlVerification_review_attention_idx"
  ON "RiskControlVerification"("organisationId", "riskId", "controlReference", "sequence" DESC);

CREATE FUNCTION "guard_risk_control_claim_revision"() RETURNS trigger AS $$
BEGIN
  IF NEW."riskRevision" IS NULL THEN
    RAISE EXCEPTION 'New control claims require the observed risk revision';
  END IF;
  PERFORM 1 FROM "RiskRecord"
    WHERE "id" = NEW."riskId"
      AND "organisationId" = NEW."organisationId"
      AND "revision" = NEW."riskRevision"
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Control claim risk revision does not match the current risk';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RiskControlVerification_revision_on_insert"
  BEFORE INSERT ON "RiskControlVerification"
  FOR EACH ROW EXECUTE FUNCTION "guard_risk_control_claim_revision"();
