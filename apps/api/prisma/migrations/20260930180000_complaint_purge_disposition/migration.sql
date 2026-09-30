BEGIN;
CREATE TABLE "ComplaintPurgeDispositionEvent" (
  id TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL,
  "authorizationId" TEXT NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('SNAPSHOTS','EXPORTS','AUDIT','BACKUPS','OTHER_COPIES')),
  "scopeRef" TEXT NOT NULL CHECK ("scopeRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('NEEDS_REVIEW','PENDING_DISPOSAL','FAILED','VERIFIED_ABSENT','RETAINED_APPROVED','NOT_APPLICABLE')),
  "actorUserId" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  "observedAt" TIMESTAMP(3) NOT NULL,
  "nextReviewAt" TIMESTAMP(3),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComplaintPurgeDisposition_authorization_fkey" FOREIGN KEY ("authorizationId","organisationId") REFERENCES "ComplaintPurgeAuthorization"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ComplaintPurgeDisposition_scope_revision_key" ON "ComplaintPurgeDispositionEvent"("authorizationId",area,"scopeRef",revision);
CREATE INDEX "ComplaintPurgeDisposition_history_idx" ON "ComplaintPurgeDispositionEvent"("organisationId","authorizationId","occurredAt",id);
CREATE FUNCTION "ComplaintPurgeDispositionEvent_guard_fn"() RETURNS trigger AS $$
DECLARE auth "ComplaintPurgeAuthorization"%ROWTYPE; claim_time TIMESTAMP(3);
  previous_revision INTEGER; planned TEXT; recorded_now TIMESTAMP(3);
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Complaint purge disposition evidence is append-only'; END IF;
  -- Same lock ordering as Owner authorization/claim. Serialize corrections
  -- against concurrent submissions and an Owner's demotion/transfer.
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint purge disposition requires the active charity owner'; END IF;
  SELECT * INTO auth FROM "ComplaintPurgeAuthorization" WHERE id=NEW."authorizationId"
    AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint purge disposition authorization not found'; END IF;
  SELECT "claimedAt" INTO claim_time FROM "ComplaintPurgeClaim" WHERE "authorizationId"=auth.id AND "organisationId"=NEW."organisationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint purge disposition requires a committed purge claim'; END IF;
  SELECT COALESCE(max(revision),0) INTO previous_revision FROM "ComplaintPurgeDispositionEvent"
    WHERE "authorizationId"=auth.id AND area=NEW.area AND "scopeRef"=NEW."scopeRef";
  IF NEW.revision <> previous_revision + 1 THEN RAISE EXCEPTION 'Complaint purge disposition revision changed; refresh history'; END IF;
  planned := auth."dispositionPlan"->NEW.area->>'disposition';
  IF (NEW.status IN ('PENDING_DISPOSAL','VERIFIED_ABSENT') AND planned IS DISTINCT FROM 'DISPOSE')
    OR (NEW.status='RETAINED_APPROVED' AND planned IS DISTINCT FROM 'RETAIN_APPROVED')
    OR (NEW.status='NOT_APPLICABLE' AND planned IS DISTINCT FROM 'NOT_APPLICABLE') THEN
    RAISE EXCEPTION 'Complaint purge disposition cannot contradict the authorized plan';
  END IF;
  recorded_now := timezone('UTC', clock_timestamp());
  IF NEW."observedAt" < claim_time OR NEW."observedAt" > recorded_now THEN
    RAISE EXCEPTION 'Complaint purge disposition observation must be between claim and recording';
  END IF;
  IF (NEW.status IN ('NEEDS_REVIEW','PENDING_DISPOSAL','FAILED','RETAINED_APPROVED') AND NEW."nextReviewAt" IS NULL)
    OR (NEW."nextReviewAt" IS NOT NULL AND NEW."nextReviewAt" <= recorded_now) THEN
    RAISE EXCEPTION 'Complaint purge disposition requires a future follow-up review date';
  END IF;
  NEW."occurredAt" := recorded_now;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintPurgeDispositionEvent_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "ComplaintPurgeDispositionEvent" FOR EACH ROW EXECUTE FUNCTION "ComplaintPurgeDispositionEvent_guard_fn"();
COMMIT;

