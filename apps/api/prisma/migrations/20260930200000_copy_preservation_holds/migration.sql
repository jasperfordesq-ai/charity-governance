BEGIN;
-- Preservation scope survives primary disposal. No provider action is dispatched.

CREATE TABLE "DocumentCopyHoldEvent" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "authorizationId" TEXT NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('VERSIONS','CONFLUENCE','EXPORTS','AUDIT','BACKUPS')),
  "scopeRef" TEXT NOT NULL CHECK ("scopeRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  "observationRevision" INTEGER NOT NULL CHECK ("observationRevision" >= 0),
  held BOOLEAN NOT NULL, "actorUserId" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentCopyHold_authorization_fkey" FOREIGN KEY ("authorizationId","organisationId") REFERENCES "DocumentPurgeAuthorization"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DocumentCopyHold_scope_revision_key" UNIQUE ("authorizationId",area,"scopeRef",revision)
);
CREATE INDEX "DocumentCopyHoldEvent_history_idx" ON "DocumentCopyHoldEvent"("organisationId","authorizationId","occurredAt",id);
CREATE FUNCTION "DocumentCopyHoldEvent_guard_fn"() RETURNS trigger AS $$
DECLARE previous "DocumentCopyHoldEvent"%ROWTYPE; observed_revision INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Copy hold history is append-only'; END IF;
  -- Same lock order as copy-authority and disposition writes.
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role IN ('OWNER','ADMIN') AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Copy hold requires active charity administrator'; END IF;
  PERFORM 1 FROM "DocumentPurgeAuthorization" WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Copy hold requires same-charity authorization'; END IF;
  PERFORM 1 FROM "DocumentPurgeClaim" WHERE "authorizationId"=NEW."authorizationId" AND "organisationId"=NEW."organisationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Copy hold requires committed primary claim'; END IF;
  SELECT COALESCE(max(revision),0) INTO observed_revision FROM "DocumentPurgeDispositionEvent"
    WHERE "authorizationId"=NEW."authorizationId" AND area=NEW.area AND "scopeRef"=NEW."scopeRef";
  IF NEW."observationRevision"<>observed_revision THEN
    RAISE EXCEPTION 'Copy hold requires current scope observation';
  END IF;
  -- A newly discovered scope may be preserved before its first observation.
  SELECT * INTO previous FROM "DocumentCopyHoldEvent" WHERE "authorizationId"=NEW."authorizationId"
    AND area=NEW.area AND "scopeRef"=NEW."scopeRef" ORDER BY revision DESC LIMIT 1;
  IF NEW.revision<>COALESCE(previous.revision,0)+1 THEN
    RAISE EXCEPTION 'Copy hold revision changed; refresh review';
  END IF;
  IF NEW.held=COALESCE(previous.held,false) THEN
    RAISE EXCEPTION 'Copy hold must change current hold state';
  END IF;
  NEW."occurredAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentCopyHoldEvent_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DocumentCopyHoldEvent"
  FOR EACH ROW EXECUTE FUNCTION "DocumentCopyHoldEvent_guard_fn"();

ALTER TABLE "DocumentCopyDispositionAuthority" ADD COLUMN "holdRevision" INTEGER NOT NULL DEFAULT 0 CHECK ("holdRevision">=0);
CREATE FUNCTION "DocumentCopyDispositionAuthority_hold_fn"() RETURNS trigger AS $$
DECLARE current_hold "DocumentCopyHoldEvent"%ROWTYPE;
BEGIN
  -- Withdrawals remain possible while preservation is required.
  IF NEW.state='WITHDRAWN' THEN RETURN NEW; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "DocumentPurgeAuthorization" WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  SELECT * INTO current_hold FROM "DocumentCopyHoldEvent" WHERE "authorizationId"=NEW."authorizationId"
    AND area=NEW.area AND "scopeRef"=NEW."scopeRef" ORDER BY revision DESC LIMIT 1;
  IF COALESCE(current_hold.held,false) OR NEW."holdRevision"<>COALESCE(current_hold.revision,0) THEN
    RAISE EXCEPTION 'Copy authority requires current unheld scope revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentCopyDispositionAuthority_hold" BEFORE INSERT ON "DocumentCopyDispositionAuthority"
  FOR EACH ROW EXECUTE FUNCTION "DocumentCopyDispositionAuthority_hold_fn"();

CREATE TABLE "ComplaintCopyHoldEvent" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "authorizationId" TEXT NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('SNAPSHOTS','EXPORTS','AUDIT','BACKUPS','OTHER_COPIES')),
  "scopeRef" TEXT NOT NULL CHECK ("scopeRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  "observationRevision" INTEGER NOT NULL CHECK ("observationRevision" >= 0),
  held BOOLEAN NOT NULL, "actorUserId" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComplaintCopyHold_authorization_fkey" FOREIGN KEY ("authorizationId","organisationId") REFERENCES "ComplaintPurgeAuthorization"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ComplaintCopyHold_scope_revision_key" UNIQUE ("authorizationId",area,"scopeRef",revision)
);
CREATE INDEX "ComplaintCopyHoldEvent_history_idx" ON "ComplaintCopyHoldEvent"("organisationId","authorizationId","occurredAt",id);
CREATE FUNCTION "ComplaintCopyHoldEvent_guard_fn"() RETURNS trigger AS $$
DECLARE previous "ComplaintCopyHoldEvent"%ROWTYPE; observed_revision INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Copy hold history is append-only'; END IF;
  -- Same lock order as copy-authority and disposition writes.
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role IN ('OWNER','ADMIN') AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Copy hold requires active charity administrator'; END IF;
  PERFORM 1 FROM "ComplaintPurgeAuthorization" WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Copy hold requires same-charity authorization'; END IF;
  PERFORM 1 FROM "ComplaintPurgeClaim" WHERE "authorizationId"=NEW."authorizationId" AND "organisationId"=NEW."organisationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Copy hold requires committed primary claim'; END IF;
  SELECT COALESCE(max(revision),0) INTO observed_revision FROM "ComplaintPurgeDispositionEvent"
    WHERE "authorizationId"=NEW."authorizationId" AND area=NEW.area AND "scopeRef"=NEW."scopeRef";
  IF NEW."observationRevision"<>observed_revision THEN
    RAISE EXCEPTION 'Copy hold requires current scope observation';
  END IF;
  -- A newly discovered scope may be preserved before its first observation.
  SELECT * INTO previous FROM "ComplaintCopyHoldEvent" WHERE "authorizationId"=NEW."authorizationId"
    AND area=NEW.area AND "scopeRef"=NEW."scopeRef" ORDER BY revision DESC LIMIT 1;
  IF NEW.revision<>COALESCE(previous.revision,0)+1 THEN
    RAISE EXCEPTION 'Copy hold revision changed; refresh review';
  END IF;
  IF NEW.held=COALESCE(previous.held,false) THEN
    RAISE EXCEPTION 'Copy hold must change current hold state';
  END IF;
  NEW."occurredAt":=timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintCopyHoldEvent_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ComplaintCopyHoldEvent"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintCopyHoldEvent_guard_fn"();

ALTER TABLE "ComplaintCopyDispositionAuthority" ADD COLUMN "holdRevision" INTEGER NOT NULL DEFAULT 0 CHECK ("holdRevision">=0);
CREATE FUNCTION "ComplaintCopyDispositionAuthority_hold_fn"() RETURNS trigger AS $$
DECLARE current_hold "ComplaintCopyHoldEvent"%ROWTYPE;
BEGIN
  -- Withdrawals remain possible while preservation is required.
  IF NEW.state='WITHDRAWN' THEN RETURN NEW; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "ComplaintPurgeAuthorization" WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  SELECT * INTO current_hold FROM "ComplaintCopyHoldEvent" WHERE "authorizationId"=NEW."authorizationId"
    AND area=NEW.area AND "scopeRef"=NEW."scopeRef" ORDER BY revision DESC LIMIT 1;
  IF COALESCE(current_hold.held,false) OR NEW."holdRevision"<>COALESCE(current_hold.revision,0) THEN
    RAISE EXCEPTION 'Copy authority requires current unheld scope revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintCopyDispositionAuthority_hold" BEFORE INSERT ON "ComplaintCopyDispositionAuthority"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintCopyDispositionAuthority_hold_fn"();

COMMIT;
