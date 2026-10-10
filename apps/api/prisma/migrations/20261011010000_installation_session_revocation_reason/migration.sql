-- Revocation by the installation operator after a suspected signing-secret
-- exposure: every live session at once. Distinct from an administrator
-- revoking one member's sessions, so the evidence says which.
ALTER TYPE "AuthSessionRevocationReason" ADD VALUE IF NOT EXISTS 'INSTALLATION_SESSIONS_REVOKED';

-- Bulk revocation alone races refresh: a refresh that revoked its old row can
-- still insert its replacement after the bulk update has run. A session row
-- inherits its family's start, so refusing any insert whose family started at
-- or before the cutoff ends every older family, whichever path inserts it.
-- New sign-ins start new families after the cutoff and are unaffected.
-- The row always exists, so every insert locks it: moving the cutoff waits
-- for inserts in flight and blocks new ones until the revocation commits.
CREATE TABLE "InstallationSessionCutoff" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  "userFamiliesBefore" TIMESTAMP(3) NOT NULL,
  "operatorFamiliesBefore" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
INSERT INTO "InstallationSessionCutoff" (id, "userFamiliesBefore", "operatorFamiliesBefore", "updatedAt")
  VALUES (1, '-infinity', '-infinity', timezone('UTC', clock_timestamp()));

CREATE FUNCTION "AuthSession_family_cutoff_fn"() RETURNS trigger AS $$
DECLARE cutoff TIMESTAMP(3);
BEGIN
  SELECT "userFamiliesBefore" INTO cutoff FROM "InstallationSessionCutoff" WHERE id = 1 FOR SHARE;
  IF cutoff IS NULL THEN RAISE EXCEPTION 'Installation session cutoff is missing'; END IF;
  IF NEW."familyCreatedAt" <= cutoff THEN
    RAISE EXCEPTION 'Session family predates an installation-wide revocation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AuthSession_family_cutoff"
  BEFORE INSERT ON "AuthSession"
  FOR EACH ROW EXECUTE FUNCTION "AuthSession_family_cutoff_fn"();

CREATE FUNCTION "PlatformOperatorSession_family_cutoff_fn"() RETURNS trigger AS $$
DECLARE cutoff TIMESTAMP(3);
BEGIN
  SELECT "operatorFamiliesBefore" INTO cutoff FROM "InstallationSessionCutoff" WHERE id = 1 FOR SHARE;
  IF cutoff IS NULL THEN RAISE EXCEPTION 'Installation session cutoff is missing'; END IF;
  IF NEW."familyCreatedAt" <= cutoff THEN
    RAISE EXCEPTION 'Session family predates an installation-wide revocation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PlatformOperatorSession_family_cutoff"
  BEFORE INSERT ON "PlatformOperatorSession"
  FOR EACH ROW EXECUTE FUNCTION "PlatformOperatorSession_family_cutoff_fn"();

CREATE FUNCTION "InstallationSessionCutoff_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW."userFamiliesBefore" < OLD."userFamiliesBefore"
    OR NEW."operatorFamiliesBefore" < OLD."operatorFamiliesBefore" THEN
    RAISE EXCEPTION 'An installation session cutoff only moves forward';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InstallationSessionCutoff_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "InstallationSessionCutoff"
  FOR EACH ROW EXECUTE FUNCTION "InstallationSessionCutoff_guard_fn"();
