BEGIN;
CREATE TABLE "DocumentPurgeAuthorizationWithdrawal" (
  "id" TEXT PRIMARY KEY,
  "organisationId" TEXT NOT NULL,
  "authorizationId" TEXT NOT NULL UNIQUE,
  "actorUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL CHECK (char_length(btrim("reason")) BETWEEN 10 AND 500 AND "reason" !~ '[[:cntrl:]]'),
  "evidenceRef" TEXT NOT NULL CHECK ("evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentPurgeAuthorizationWithdrawal_authorizationId_organ_fkey"
    FOREIGN KEY ("authorizationId","organisationId") REFERENCES "DocumentPurgeAuthorization"("id","organisationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DocumentPurgeAuthorizationWithdrawal_authorizationId_organi_key" UNIQUE ("authorizationId","organisationId")
);
CREATE INDEX "DocumentPurgeAuthorizationWithdrawal_organisationId_occurre_idx"
  ON "DocumentPurgeAuthorizationWithdrawal"("organisationId","occurredAt","id");
CREATE FUNCTION "DocumentPurgeAuthorizationWithdrawal_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Purge authorization withdrawals are append-only'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId"
    AND role='OWNER' AND "lifecycleStatus"='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purge withdrawal requires the active charity owner'; END IF;
  -- Claim must lock this same authorization and refuse an existing withdrawal.
  -- No claim consumer exists in this migration; nothing can dispatch disposal.
  PERFORM 1 FROM "DocumentPurgeAuthorization" WHERE id=NEW."authorizationId"
    AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purge authorization not found in this charity'; END IF;
  NEW."occurredAt" := timezone('UTC', statement_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentPurgeAuthorizationWithdrawal_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "DocumentPurgeAuthorizationWithdrawal" FOR EACH ROW EXECUTE FUNCTION "DocumentPurgeAuthorizationWithdrawal_guard_fn"();
COMMIT;
