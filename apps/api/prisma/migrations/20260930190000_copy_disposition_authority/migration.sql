BEGIN;
-- Scoped review history only. Existing observations continue using their original
-- plan until the separate authority-binding and current-policy/hold checks land.

CREATE TABLE "DocumentCopyDispositionAuthority" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "authorizationId" TEXT NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('VERSIONS','CONFLUENCE','EXPORTS','AUDIT','BACKUPS')),
  "scopeRef" TEXT NOT NULL CHECK ("scopeRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  revision INTEGER NOT NULL CHECK (revision > 0), "previousId" TEXT,
  "observationRevision" INTEGER NOT NULL CHECK ("observationRevision" > 0),
  state TEXT NOT NULL CHECK (state IN ('AUTHORIZED','WITHDRAWN')),
  disposition TEXT CHECK (disposition IN ('DISPOSE','RETAIN_APPROVED','NOT_APPLICABLE')),
  "actorUserId" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  "retentionEvidenceRef" TEXT, "holdEvidenceRef" TEXT, "validUntil" TIMESTAMP(3),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentCopyAuthority_authorization_fkey" FOREIGN KEY ("authorizationId","organisationId") REFERENCES "DocumentPurgeAuthorization"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DocumentCopyAuthority_scope_revision_key" UNIQUE ("authorizationId",area,"scopeRef",revision)
);
CREATE INDEX "DocumentCopyDispositionAuthority_history_idx" ON "DocumentCopyDispositionAuthority"("organisationId","authorizationId","occurredAt",id);
CREATE FUNCTION "DocumentCopyDispositionAuthority_guard_fn"() RETURNS trigger AS $$
DECLARE previous "DocumentCopyDispositionAuthority"%ROWTYPE; observed_revision INTEGER; recorded_now TIMESTAMP(3);
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Copy authority is append-only'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Copy authority requires active charity owner'; END IF;
  PERFORM 1 FROM "DocumentPurgeAuthorization" WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Copy authority requires same-charity authorization'; END IF;
  PERFORM 1 FROM "DocumentPurgeClaim" WHERE "authorizationId"=NEW."authorizationId" AND "organisationId"=NEW."organisationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Copy authority requires committed primary claim'; END IF;
  SELECT COALESCE(max(revision),0) INTO observed_revision FROM "DocumentPurgeDispositionEvent"
    WHERE "authorizationId"=NEW."authorizationId" AND area=NEW.area AND "scopeRef"=NEW."scopeRef";
  IF observed_revision=0 OR NEW."observationRevision"<>observed_revision THEN
    RAISE EXCEPTION 'Copy authority requires current scope observation';
  END IF;
  SELECT * INTO previous FROM "DocumentCopyDispositionAuthority" WHERE "authorizationId"=NEW."authorizationId"
    AND area=NEW.area AND "scopeRef"=NEW."scopeRef" ORDER BY revision DESC LIMIT 1;
  IF NEW.revision<>COALESCE(previous.revision,0)+1 OR NEW."previousId" IS DISTINCT FROM previous.id THEN
    RAISE EXCEPTION 'Copy authority revision changed; refresh review';
  END IF;
  recorded_now:=timezone('UTC',clock_timestamp());
  IF NEW.state='AUTHORIZED' THEN
    IF NEW.disposition IS NULL OR NEW."retentionEvidenceRef" IS NULL OR NEW."holdEvidenceRef" IS NULL
      OR NEW."retentionEvidenceRef" !~ '^[A-Z0-9][A-Z0-9-]{2,119}$'
      OR NEW."holdEvidenceRef" !~ '^[A-Z0-9][A-Z0-9-]{2,119}$' THEN
      RAISE EXCEPTION 'Copy authority requires separate retention and hold review references';
    END IF;
    IF NEW."validUntil" IS NULL OR NEW."validUntil"<=recorded_now THEN
      RAISE EXCEPTION 'Copy authority requires a future expiry';
    END IF;
  ELSE
    IF previous.state IS DISTINCT FROM 'AUTHORIZED' THEN
      RAISE EXCEPTION 'Copy withdrawal requires existing active authority';
    END IF;
    IF NEW.disposition IS NOT NULL OR NEW."retentionEvidenceRef" IS NOT NULL
      OR NEW."holdEvidenceRef" IS NOT NULL OR NEW."validUntil" IS NOT NULL THEN
      RAISE EXCEPTION 'Copy withdrawal cannot grant a disposition';
    END IF;
  END IF;
  NEW."occurredAt":=recorded_now;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentCopyDispositionAuthority_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DocumentCopyDispositionAuthority"
  FOR EACH ROW EXECUTE FUNCTION "DocumentCopyDispositionAuthority_guard_fn"();

CREATE TABLE "ComplaintCopyDispositionAuthority" (
  id TEXT PRIMARY KEY, "organisationId" TEXT NOT NULL, "authorizationId" TEXT NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('SNAPSHOTS','EXPORTS','AUDIT','BACKUPS','OTHER_COPIES')),
  "scopeRef" TEXT NOT NULL CHECK ("scopeRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  revision INTEGER NOT NULL CHECK (revision > 0), "previousId" TEXT,
  "observationRevision" INTEGER NOT NULL CHECK ("observationRevision" > 0),
  state TEXT NOT NULL CHECK (state IN ('AUTHORIZED','WITHDRAWN')),
  disposition TEXT CHECK (disposition IN ('DISPOSE','RETAIN_APPROVED','NOT_APPLICABLE')),
  "actorUserId" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  "retentionEvidenceRef" TEXT, "holdEvidenceRef" TEXT, "validUntil" TIMESTAMP(3),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComplaintCopyAuthority_authorization_fkey" FOREIGN KEY ("authorizationId","organisationId") REFERENCES "ComplaintPurgeAuthorization"(id,"organisationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ComplaintCopyAuthority_scope_revision_key" UNIQUE ("authorizationId",area,"scopeRef",revision)
);
CREATE INDEX "ComplaintCopyDispositionAuthority_history_idx" ON "ComplaintCopyDispositionAuthority"("organisationId","authorizationId","occurredAt",id);
CREATE FUNCTION "ComplaintCopyDispositionAuthority_guard_fn"() RETURNS trigger AS $$
DECLARE previous "ComplaintCopyDispositionAuthority"%ROWTYPE; observed_revision INTEGER; recorded_now TIMESTAMP(3);
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Copy authority is append-only'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Copy authority requires active charity owner'; END IF;
  PERFORM 1 FROM "ComplaintPurgeAuthorization" WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Copy authority requires same-charity authorization'; END IF;
  PERFORM 1 FROM "ComplaintPurgeClaim" WHERE "authorizationId"=NEW."authorizationId" AND "organisationId"=NEW."organisationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Copy authority requires committed primary claim'; END IF;
  SELECT COALESCE(max(revision),0) INTO observed_revision FROM "ComplaintPurgeDispositionEvent"
    WHERE "authorizationId"=NEW."authorizationId" AND area=NEW.area AND "scopeRef"=NEW."scopeRef";
  IF observed_revision=0 OR NEW."observationRevision"<>observed_revision THEN
    RAISE EXCEPTION 'Copy authority requires current scope observation';
  END IF;
  SELECT * INTO previous FROM "ComplaintCopyDispositionAuthority" WHERE "authorizationId"=NEW."authorizationId"
    AND area=NEW.area AND "scopeRef"=NEW."scopeRef" ORDER BY revision DESC LIMIT 1;
  IF NEW.revision<>COALESCE(previous.revision,0)+1 OR NEW."previousId" IS DISTINCT FROM previous.id THEN
    RAISE EXCEPTION 'Copy authority revision changed; refresh review';
  END IF;
  recorded_now:=timezone('UTC',clock_timestamp());
  IF NEW.state='AUTHORIZED' THEN
    IF NEW.disposition IS NULL OR NEW."retentionEvidenceRef" IS NULL OR NEW."holdEvidenceRef" IS NULL
      OR NEW."retentionEvidenceRef" !~ '^[A-Z0-9][A-Z0-9-]{2,119}$'
      OR NEW."holdEvidenceRef" !~ '^[A-Z0-9][A-Z0-9-]{2,119}$' THEN
      RAISE EXCEPTION 'Copy authority requires separate retention and hold review references';
    END IF;
    IF NEW."validUntil" IS NULL OR NEW."validUntil"<=recorded_now THEN
      RAISE EXCEPTION 'Copy authority requires a future expiry';
    END IF;
  ELSE
    IF previous.state IS DISTINCT FROM 'AUTHORIZED' THEN
      RAISE EXCEPTION 'Copy withdrawal requires existing active authority';
    END IF;
    IF NEW.disposition IS NOT NULL OR NEW."retentionEvidenceRef" IS NOT NULL
      OR NEW."holdEvidenceRef" IS NOT NULL OR NEW."validUntil" IS NOT NULL THEN
      RAISE EXCEPTION 'Copy withdrawal cannot grant a disposition';
    END IF;
  END IF;
  NEW."occurredAt":=recorded_now;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ComplaintCopyDispositionAuthority_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ComplaintCopyDispositionAuthority"
  FOR EACH ROW EXECUTE FUNCTION "ComplaintCopyDispositionAuthority_guard_fn"();

COMMIT;
