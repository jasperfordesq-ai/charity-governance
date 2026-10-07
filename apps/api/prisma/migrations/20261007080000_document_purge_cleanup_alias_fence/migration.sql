BEGIN;
-- A different cleanup job for the same provider key could otherwise erase
-- the primary bytes while the purge-claim job is held by the byte fence.
-- Treat even a processed historical alias as unresolved target identity:
-- provider versions and key reuse need review before another purge claim.
CREATE FUNCTION "DocumentPurgeClaim_cleanup_alias_fence_fn"() RETURNS trigger AS $$
DECLARE target_provider TEXT; target_path TEXT;
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  SELECT provider, "storagePath" INTO target_provider, target_path
    FROM "DocumentPurgeAuthorization"
    WHERE id=NEW."authorizationId" AND "organisationId"=NEW."organisationId";
  IF target_provider IS NULL OR target_path IS NULL THEN
    RAISE EXCEPTION 'Primary purge cleanup target is unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM "DocumentStorageDeletion" job
    WHERE job."organisationId"=NEW."organisationId"
      AND job.provider=target_provider AND job."storagePath"=target_path
      AND job.id<>NEW."deletionId") THEN
    RAISE EXCEPTION 'Primary purge requires reconciliation of matching cleanup job';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentPurgeClaim_cleanup_alias_fence"
  BEFORE INSERT ON "DocumentPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPurgeClaim_cleanup_alias_fence_fn"();

-- The claim's own AFTER INSERT dispatcher may create its exact job. Every
-- other insertion or corrected-path update serializes with the claim on the
-- organisation row and cannot target that provider key after claim commit.
CREATE FUNCTION "DocumentStorageDeletion_purge_alias_fence_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.provider IS NOT DISTINCT FROM OLD.provider
      AND NEW."storagePath" IS NOT DISTINCT FROM OLD."storagePath" THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cleanup job organisation is unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM "DocumentPurgeClaim" claim
    JOIN "DocumentPurgeAuthorization" auth ON auth.id=claim."authorizationId"
    WHERE claim."organisationId"=NEW."organisationId"
      AND auth.provider=NEW.provider AND auth."storagePath"=NEW."storagePath"
      AND claim."deletionId"<>NEW.id) THEN
    RAISE EXCEPTION 'Cleanup job is fenced by primary purge target';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DocumentStorageDeletion_purge_alias_fence"
  BEFORE INSERT OR UPDATE ON "DocumentStorageDeletion"
  FOR EACH ROW EXECUTE FUNCTION "DocumentStorageDeletion_purge_alias_fence_fn"();

-- Never grandfather a historical alias beside an existing claim.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DocumentPurgeClaim" claim
    JOIN "DocumentPurgeAuthorization" auth ON auth.id=claim."authorizationId"
    JOIN "DocumentStorageDeletion" job
      ON job."organisationId"=claim."organisationId"
      AND job.provider=auth.provider AND job."storagePath"=auth."storagePath"
      AND job.id<>claim."deletionId") THEN
    RAISE EXCEPTION 'Existing primary purge has matching cleanup job';
  END IF;
END;
$$;
COMMIT;
