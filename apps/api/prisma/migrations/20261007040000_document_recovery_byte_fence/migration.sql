BEGIN;
-- The current cleanup worker has no independently authenticated document
-- outcome check. Never activate document enforcement while an older purge
-- job can already be in flight; a later migration must add an exact byte
-- execution permit before any guarded purge job may advance.
CREATE OR REPLACE FUNCTION "DocumentRecoveryEnforcement_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Document recovery enforcement cannot be changed'; END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM "DocumentPurgeClaim" claim
    JOIN "DocumentStorageDeletion" job ON job.id=claim."deletionId"
    WHERE claim."organisationId"=NEW."organisationId"
      AND (job.state<>'PROCESSED' OR job."processedAt" IS NULL)
  ) THEN
    RAISE EXCEPTION 'Document recovery enforcement requires no unfinished legacy purge jobs';
  END IF;
  NEW."recordedAt" := timezone('UTC',clock_timestamp());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Every existing updater of a purge-claim deletion job, including direct SQL,
-- must take the same organisation row lock as enforcement and purge claims.
-- If enforcement wins, the job remains pending. If the worker wins, its
-- claimedAt remains set until the external attempt finishes; enforcement
-- then refuses the unfinished job. The ordinary unbound worker is unchanged.
CREATE FUNCTION "DocumentRecoveryByteFence_fn"() RETURNS trigger AS $$
DECLARE claim_org TEXT;
BEGIN
  SELECT claim."organisationId" INTO claim_org
    FROM "DocumentPurgeClaim" claim WHERE claim."deletionId"=OLD.id;
  IF claim_org IS NOT NULL THEN
    PERFORM 1 FROM "Organisation" WHERE id=claim_org FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
      WHERE "organisationId"=claim_org) THEN
      RAISE EXCEPTION 'Document recovery byte execution requires independent permit';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentRecoveryByteFence" BEFORE UPDATE ON "DocumentStorageDeletion"
  FOR EACH ROW EXECUTE FUNCTION "DocumentRecoveryByteFence_fn"();
COMMIT;
