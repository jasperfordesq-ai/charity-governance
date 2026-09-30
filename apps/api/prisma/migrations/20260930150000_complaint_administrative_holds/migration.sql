BEGIN;
CREATE TABLE "ComplaintHoldEvent" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "complaintId" TEXT NOT NULL,
  revision INTEGER NOT NULL, "recordRevision" INTEGER NOT NULL, held BOOLEAN NOT NULL,
  "actorUserId" TEXT NOT NULL, "evidenceRef" TEXT NOT NULL, reason TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organisationId", "complaintId", revision),
  CHECK (revision > 0 AND "recordRevision" > 0 AND
    "evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$' AND
    char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]')
);
CREATE INDEX "ComplaintHoldEvent_history_idx" ON "ComplaintHoldEvent"("organisationId","occurredAt",id);

CREATE FUNCTION "ComplaintHoldEvent_insert_fn"() RETURNS trigger AS $$
DECLARE complaint "ComplaintRecord"%ROWTYPE; previous "ComplaintHoldEvent"%ROWTYPE;
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  SELECT * INTO complaint FROM "ComplaintRecord" WHERE id=NEW."complaintId"
    AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND OR complaint.revision<>NEW."recordRevision" THEN
    RAISE EXCEPTION 'Complaint hold requires current same-charity record revision';
  END IF;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND "lifecycleStatus"='ACTIVE' AND role IN ('OWNER','ADMIN') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint hold requires active charity administrator'; END IF;
  SELECT * INTO previous FROM "ComplaintHoldEvent" WHERE "organisationId"=NEW."organisationId"
    AND "complaintId"=NEW."complaintId" ORDER BY revision DESC LIMIT 1;
  IF NEW.revision<>COALESCE(previous.revision,0)+1 THEN
    RAISE EXCEPTION 'Complaint hold revision conflict';
  END IF;
  IF NEW.held=COALESCE(previous.held,false) THEN
    RAISE EXCEPTION 'Complaint hold must change the current hold state';
  END IF;
  NEW."occurredAt" := timezone('UTC',clock_timestamp())::timestamp(3);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintHoldEvent_insert" BEFORE INSERT ON "ComplaintHoldEvent"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintHoldEvent_insert_fn"();
CREATE TRIGGER "ComplaintHoldEvent_append_only" BEFORE UPDATE OR DELETE ON "ComplaintHoldEvent"
  FOR EACH ROW EXECUTE FUNCTION "DataRetentionPolicy_append_only_fn"();

CREATE FUNCTION "ComplaintRemoval_hold_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "ComplaintRecord" WHERE id=NEW."complaintId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF COALESCE((SELECT held FROM "ComplaintHoldEvent" WHERE "organisationId"=NEW."organisationId"
    AND "complaintId"=NEW."complaintId" ORDER BY revision DESC LIMIT 1),false) THEN
    RAISE EXCEPTION 'Complaint administrative hold blocks removal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintRemoval_hold" BEFORE INSERT ON "ComplaintRemoval"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRemoval_hold_fn"();

CREATE FUNCTION "ComplaintRecord_hold_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF EXISTS (SELECT 1 FROM "ComplaintHoldEvent" WHERE "complaintId"=NEW.id) THEN
      RAISE EXCEPTION 'Complaint identity with retained hold history cannot be reused';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR (OLD."removedAt" IS NULL AND NEW."removedAt" IS NOT NULL) THEN
    IF COALESCE((SELECT held FROM "ComplaintHoldEvent" WHERE "organisationId"=OLD."organisationId"
      AND "complaintId"=OLD.id ORDER BY revision DESC LIMIT 1),false) THEN
      RAISE EXCEPTION 'Complaint administrative hold blocks removal or purge';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintRecord_hold" BEFORE INSERT OR UPDATE OR DELETE ON "ComplaintRecord"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintRecord_hold_fn"();
COMMIT;
