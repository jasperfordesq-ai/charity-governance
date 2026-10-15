BEGIN;
ALTER TABLE "ConfluenceCopyRecoveryCapture" ADD CONSTRAINT "ConfluenceCopyCapture_id_org_key" UNIQUE(id,"organisationId");
CREATE TABLE "ConfluenceCopyPublicationPlan" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "captureId" TEXT NOT NULL UNIQUE,
  "actorUserId" TEXT NOT NULL,
  "writerId" TEXT NOT NULL CHECK ("writerId" ~ '^[A-Za-z0-9_-]{1,120}$'),
  "keyId" TEXT NOT NULL CHECK ("keyId" ~ '^arn:aws:kms:eu-west-1:[0-9]{12}:key/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  "keyEvidenceRef" TEXT NOT NULL CHECK ("keyEvidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  "expectedGeneration" INTEGER NOT NULL CHECK ("expectedGeneration" BETWEEN 0 AND 9999),
  "expectedDigest" TEXT CHECK ("expectedDigest" ~ '^[a-f0-9]{64}$'),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("expectedGeneration"=0)=("expectedDigest" IS NULL)),
  CONSTRAINT "ConfluenceCopyPlan_id_org_key" UNIQUE(id,"organisationId"),
  CONSTRAINT "ConfluenceCopyPlan_capture_org_key" UNIQUE("captureId","organisationId"),
  CONSTRAINT "ConfluenceCopyPlan_capture_fkey" FOREIGN KEY("captureId","organisationId")
    REFERENCES "ConfluenceCopyRecoveryCapture"(id,"organisationId") ON DELETE RESTRICT
);
CREATE TABLE "ConfluenceCopyPublicationReceipt" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "planId" TEXT NOT NULL UNIQUE,
  "actorUserId" TEXT NOT NULL,
  "envelopeDigest" TEXT NOT NULL CHECK ("envelopeDigest" ~ '^[a-f0-9]{64}$'),
  "entryGeneration" INTEGER NOT NULL CHECK ("entryGeneration" BETWEEN 1 AND 10000),
  "entryDigest" TEXT NOT NULL CHECK ("entryDigest" ~ '^[a-f0-9]{64}$'),
  "verifiedHeadRevision" TEXT NOT NULL CHECK (length("verifiedHeadRevision") BETWEEN 1 AND 1024 AND "verifiedHeadRevision" ~ '^[!-~]+$'),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfluenceCopyReceipt_plan_org_key" UNIQUE("planId","organisationId"),
  CONSTRAINT "ConfluenceCopyReceipt_plan_fkey" FOREIGN KEY("planId","organisationId")
    REFERENCES "ConfluenceCopyPublicationPlan"(id,"organisationId") ON DELETE RESTRICT
);

CREATE FUNCTION "ConfluenceCopyPublication_guard_fn"() RETURNS trigger AS $$
DECLARE capture public."ConfluenceCopyRecoveryCapture"%ROWTYPE;
  plan public."ConfluenceCopyPublicationPlan"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Confluence publication plans and receipts are append-only'; END IF;
  PERFORM 1 FROM public."Organisation" WHERE id=NEW."organisationId" AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence publication requires active charity Owner'; END IF;
  PERFORM 1 FROM public."User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Confluence publication requires active charity Owner'; END IF;
  IF TG_TABLE_NAME='ConfluenceCopyPublicationPlan' THEN
    SELECT * INTO capture FROM public."ConfluenceCopyRecoveryCapture"
      WHERE id=NEW."captureId" AND "organisationId"=NEW."organisationId";
    IF NOT FOUND THEN RAISE EXCEPTION 'Confluence publication requires original charity capture'; END IF;
  ELSE
    SELECT * INTO plan FROM public."ConfluenceCopyPublicationPlan"
      WHERE id=NEW."planId" AND "organisationId"=NEW."organisationId";
    IF NOT FOUND OR NEW."entryGeneration"<>plan."expectedGeneration"+1 THEN
      RAISE EXCEPTION 'Confluence publication receipt requires exact plan generation';
    END IF;
  END IF;
  -- A receipt is a local observation. SQL does not authenticate independent
  -- history or grant release, provider execution, activation or reopening.
  NEW."recordedAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "ConfluenceCopyPlan_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ConfluenceCopyPublicationPlan"
  FOR EACH ROW EXECUTE FUNCTION "ConfluenceCopyPublication_guard_fn"();
CREATE TRIGGER "ConfluenceCopyPlan_truncate_guard" BEFORE TRUNCATE ON "ConfluenceCopyPublicationPlan"
  FOR EACH STATEMENT EXECUTE FUNCTION "ConfluenceCopyPublication_guard_fn"();
CREATE TRIGGER "ConfluenceCopyReceipt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ConfluenceCopyPublicationReceipt"
  FOR EACH ROW EXECUTE FUNCTION "ConfluenceCopyPublication_guard_fn"();
CREATE TRIGGER "ConfluenceCopyReceipt_truncate_guard" BEFORE TRUNCATE ON "ConfluenceCopyPublicationReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION "ConfluenceCopyPublication_guard_fn"();
COMMIT;
