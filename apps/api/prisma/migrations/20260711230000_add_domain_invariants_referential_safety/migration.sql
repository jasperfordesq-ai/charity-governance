BEGIN;

-- Production deploys run migrations only after every runtime writer is
-- quiesced. Fail closed instead of waiting indefinitely if that operational
-- contract is violated by an unexpected session.
SET LOCAL lock_timeout = '15s';

-- Block concurrent writers before inspecting legacy rows. This keeps the
-- fail-closed preflight and the constraints installed from one stable set of
-- rows while still allowing ordinary readers to continue. ConflictRecord is
-- deliberately locked before BoardMember to match the primary application
-- removal write order and reduce lock inversion risk; this is not an online
-- migration contract.
LOCK TABLE "ConflictRecord" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "BoardMember" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "FundraisingRecord" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "AnnualReportReadiness" IN SHARE ROW EXCLUSIVE MODE;

-- Do not invent or rewrite governance history. Any legacy contradiction must
-- be reviewed and corrected deliberately before this migration can proceed.
DO $preflight$
DECLARE
    invalid_board_chronology BIGINT;
    invalid_conduct_evidence BIGINT;
    invalid_induction_evidence BIGINT;
    invalid_fundraising_chronology BIGINT;
    invalid_filing_evidence BIGINT;
    invalid_conflict_scope BIGINT;
BEGIN
    SELECT COUNT(*) INTO invalid_board_chronology
    FROM "BoardMember"
    WHERE "termEndDate" IS NOT NULL
      AND "termEndDate" < "appointedDate";

    SELECT COUNT(*) INTO invalid_conduct_evidence
    FROM "BoardMember"
    WHERE "conductSigned" <> ("conductSignedDate" IS NOT NULL);

    SELECT COUNT(*) INTO invalid_induction_evidence
    FROM "BoardMember"
    WHERE "inductionCompleted" <> ("inductionDate" IS NOT NULL);

    SELECT COUNT(*) INTO invalid_fundraising_chronology
    FROM "FundraisingRecord"
    WHERE "startDate" IS NOT NULL
      AND "endDate" IS NOT NULL
      AND "endDate" < "startDate";

    SELECT COUNT(*) INTO invalid_filing_evidence
    FROM "AnnualReportReadiness"
    WHERE "filingStatus" = 'FILED'::"AnnualReportFilingStatus"
      AND "filedDate" IS NULL;

    SELECT COUNT(*) INTO invalid_conflict_scope
    FROM "ConflictRecord" AS conflict
    LEFT JOIN "BoardMember" AS member
      ON member."id" = conflict."boardMemberId"
    WHERE conflict."boardMemberId" IS NOT NULL
      AND (
        member."id" IS NULL
        OR member."organisationId" IS DISTINCT FROM conflict."organisationId"
      );

    IF invalid_board_chronology > 0
       OR invalid_conduct_evidence > 0
       OR invalid_induction_evidence > 0
       OR invalid_fundraising_chronology > 0
       OR invalid_filing_evidence > 0
       OR invalid_conflict_scope > 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
                'P1-09 domain-invariant preflight failed: board_chronology=%s, conduct_evidence=%s, induction_evidence=%s, fundraising_chronology=%s, filing_evidence=%s, conflict_scope=%s',
                invalid_board_chronology,
                invalid_conduct_evidence,
                invalid_induction_evidence,
                invalid_fundraising_chronology,
                invalid_filing_evidence,
                invalid_conflict_scope
            ),
            DETAIL = 'No legacy row was changed and the migration was rolled back atomically.',
            HINT = 'Keep every runtime stopped. Follow the P1-09 failed-migration recovery procedure: prove this transaction left no target objects, remediate the counted records under an approved governance-data process, resolve this exact migration as rolled back, then rerun the controlled deploy.';
    END IF;
END;
$preflight$;

-- The five named checks are database backstops for every write path, including
-- imports, maintenance SQL, and future application regressions.
ALTER TABLE "BoardMember"
    ADD CONSTRAINT "BoardMember_term_chronology_check"
        CHECK ("termEndDate" IS NULL OR "termEndDate" >= "appointedDate"),
    ADD CONSTRAINT "BoardMember_conduct_signed_date_equivalence_check"
        CHECK ("conductSigned" = ("conductSignedDate" IS NOT NULL)),
    ADD CONSTRAINT "BoardMember_induction_date_equivalence_check"
        CHECK ("inductionCompleted" = ("inductionDate" IS NOT NULL));

ALTER TABLE "FundraisingRecord"
    ADD CONSTRAINT "FundraisingRecord_date_chronology_check"
        CHECK (
            "endDate" IS NULL
            OR "startDate" IS NULL
            OR "endDate" >= "startDate"
        );

ALTER TABLE "AnnualReportReadiness"
    ADD CONSTRAINT "AnnualReportReadiness_filed_date_required_check"
        CHECK (
            "filingStatus" <> 'FILED'::"AnnualReportFilingStatus"
            OR "filedDate" IS NOT NULL
        );

-- A redundant-looking composite unique key is intentional: it gives the
-- tenant-scoped ConflictRecord reference an exact PostgreSQL target.
ALTER TABLE "BoardMember"
    ADD CONSTRAINT "BoardMember_id_organisationId_key"
        UNIQUE ("id", "organisationId");

ALTER TABLE "ConflictRecord"
    DROP CONSTRAINT "ConflictRecord_boardMemberId_fkey";

DROP INDEX "ConflictRecord_boardMemberId_idx";
CREATE INDEX "ConflictRecord_boardMemberId_organisationId_idx"
    ON "ConflictRecord"("boardMemberId", "organisationId");

-- RESTRICT preserves linked conflict history. The application must detach the
-- optional board-member pointer explicitly before removing a board member; the
-- ConflictRecord row itself is never deleted or silently rewritten by the FK.
ALTER TABLE "ConflictRecord"
    ADD CONSTRAINT "ConflictRecord_boardMemberId_organisationId_fkey"
        FOREIGN KEY ("boardMemberId", "organisationId")
        REFERENCES "BoardMember"("id", "organisationId")
        ON DELETE RESTRICT
        ON UPDATE RESTRICT;

COMMIT;
