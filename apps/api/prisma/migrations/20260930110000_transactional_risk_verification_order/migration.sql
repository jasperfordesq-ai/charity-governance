-- Preserve the existing integer cursor and every historical row. Unlike SERIAL,
-- this allocator commits in the same MVCC transaction as its evidence row, so
-- the read-only snapshot-bound backup can capture both consistently.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE "RiskControlVerification" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE "RiskControlVerificationCounter" (
  "id" INTEGER NOT NULL PRIMARY KEY CHECK ("id" = 1),
  "value" INTEGER NOT NULL CHECK ("value" >= 0)
);
INSERT INTO "RiskControlVerificationCounter" ("id", "value")
SELECT 1, GREATEST(
  COALESCE((SELECT MAX("sequence") FROM "RiskControlVerification"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END
   FROM "RiskControlVerification_sequence_seq")
);

CREATE FUNCTION "RiskControlVerification_next_order"() RETURNS INTEGER
LANGUAGE plpgsql VOLATILE AS $$
DECLARE allocated INTEGER;
BEGIN
  UPDATE public."RiskControlVerificationCounter"
  SET "value" = "value" + 1
  WHERE "id" = 1 AND "value" < 2147483647
  RETURNING "value" INTO allocated;
  IF allocated IS NULL THEN
    RAISE EXCEPTION 'Risk verification ordering counter missing or exhausted';
  END IF;
  RETURN allocated;
END;
$$;

ALTER TABLE "RiskControlVerification" ALTER COLUMN "sequence"
  SET DEFAULT public."RiskControlVerification_next_order"();
-- Application callers omit this column; old and new clients use the new
-- default. Remove only the now-unreferenced allocator, never audit records.
DROP SEQUENCE "RiskControlVerification_sequence_seq";
COMMIT;
