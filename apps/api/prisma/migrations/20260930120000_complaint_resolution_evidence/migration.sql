BEGIN;

ALTER TABLE "ComplaintRecord" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ComplaintRecord" ADD CONSTRAINT "ComplaintRecord_revision_positive" CHECK ("revision" > 0);

CREATE FUNCTION "ComplaintRecord_revision_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM "ComplaintResolutionEvidence" WHERE "complaintId" = NEW.id) THEN
      RAISE EXCEPTION 'A complaint identity with retained resolution evidence cannot be reused';
    END IF;
    NEW."revision" := 1;
  ELSE
    IF NEW."id" <> OLD."id" OR NEW."organisationId" <> OLD."organisationId" THEN
      RAISE EXCEPTION 'Complaint identity and charity cannot change';
    END IF;
    NEW."revision" := OLD."revision" + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintRecord_revision"
  BEFORE INSERT OR UPDATE ON "ComplaintRecord"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecord_revision_fn"();

CREATE TABLE "ComplaintResolutionEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organisationId" TEXT NOT NULL,
  "complaintId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "recordRevision" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "evidenceRef" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComplaintResolutionEvidence_revision_key" UNIQUE ("organisationId", "complaintId", "revision"),
  CONSTRAINT "ComplaintResolutionEvidence_input_valid" CHECK (
    "revision" > 0 AND "recordRevision" > 0 AND
    "evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$' AND
    char_length(btrim("reason")) BETWEEN 10 AND 500 AND "reason" !~ '[[:cntrl:]]' AND
    (("state" = 'RECORDED' AND "resolvedAt" IS NOT NULL) OR
     ("state" = 'WITHDRAWN' AND "resolvedAt" IS NULL))
  )
);
CREATE INDEX "ComplaintResolutionEvidence_history_idx"
  ON "ComplaintResolutionEvidence"("organisationId", "complaintId", "occurredAt", "id");

CREATE FUNCTION "ComplaintResolutionEvidence_insert_fn"() RETURNS trigger AS $$
DECLARE complaint "ComplaintRecord"%ROWTYPE; previous_revision INTEGER; previous_state TEXT;
BEGIN
  -- Follow the register service's charity-first locking order. The complaint
  -- lock serializes competing reviews with corrections, reopening and removal.
  PERFORM 1 FROM "Organisation" WHERE id = NEW."organisationId" FOR UPDATE;
  SELECT * INTO complaint FROM "ComplaintRecord"
    WHERE id = NEW."complaintId" AND "organisationId" = NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR complaint.revision <> NEW."recordRevision" THEN
    RAISE EXCEPTION 'Complaint resolution requires the current same-charity record revision';
  END IF;
  PERFORM 1 FROM "User" WHERE id = NEW."actorUserId" AND "organisationId" = NEW."organisationId"
    AND "lifecycleStatus" = 'ACTIVE' AND role IN ('OWNER', 'ADMIN') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint resolution requires an active charity administrator'; END IF;
  SELECT revision, state INTO previous_revision, previous_state FROM "ComplaintResolutionEvidence"
    WHERE "organisationId" = NEW."organisationId" AND "complaintId" = NEW."complaintId"
    ORDER BY revision DESC LIMIT 1;
  IF NEW.revision <> COALESCE(previous_revision, 0) + 1 THEN
    RAISE EXCEPTION 'Complaint resolution evidence revision conflict';
  END IF;
  NEW."occurredAt" := timezone('UTC', clock_timestamp())::timestamp(3);
  IF NEW.state = 'RECORDED' AND (complaint.status <> 'CLOSED' OR
    NEW."resolvedAt" < complaint."receivedDate" OR NEW."resolvedAt" > NEW."occurredAt") THEN
    RAISE EXCEPTION 'Resolution requires a closed complaint and a date between receipt and now';
  END IF;
  IF NEW.state = 'WITHDRAWN' AND previous_state IS DISTINCT FROM 'RECORDED' THEN
    RAISE EXCEPTION 'Only recorded resolution evidence can be withdrawn';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintResolutionEvidence_insert"
  BEFORE INSERT ON "ComplaintResolutionEvidence"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintResolutionEvidence_insert_fn"();
CREATE TRIGGER "ComplaintResolutionEvidence_append_only"
  BEFORE UPDATE OR DELETE ON "ComplaintResolutionEvidence"
  FOR EACH ROW EXECUTE FUNCTION "DataRetentionPolicy_append_only_fn"();

COMMIT;
