-- Disposable migration regression fixture only, not an operator recovery path.
-- Application rollback does not need this: the forward default keeps the same
-- integer column and works with clients compiled before the migration.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE "RiskControlVerification" IN ACCESS EXCLUSIVE MODE;
CREATE SEQUENCE "RiskControlVerification_sequence_seq" AS INTEGER
  OWNED BY "RiskControlVerification"."sequence";
SELECT setval('"RiskControlVerification_sequence_seq"', GREATEST(
  1,
  COALESCE((SELECT MAX("sequence") FROM "RiskControlVerification"), 0),
  (SELECT "value" FROM "RiskControlVerificationCounter" WHERE "id" = 1)
), true);
ALTER TABLE "RiskControlVerification" ALTER COLUMN "sequence"
  SET DEFAULT nextval('"RiskControlVerification_sequence_seq"'::regclass);
DROP FUNCTION "RiskControlVerification_next_order"();
DROP TABLE "RiskControlVerificationCounter";
COMMIT;
