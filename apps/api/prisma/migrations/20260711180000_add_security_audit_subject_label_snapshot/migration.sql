-- Security audit subjects must remain human-readable after a user or
-- invitation changes. Persist the display label as immutable event evidence
-- instead of resolving the current User row when the browser reads history.

BEGIN;

ALTER TABLE "SecurityAuditEvent"
    ADD COLUMN "subjectLabel" TEXT;

-- The existing append-only trigger correctly rejects application rewrites.
-- Disable it only inside this migration transaction for the one-time backfill;
-- a failed migration rolls this state back with the rest of the transaction.
ALTER TABLE "SecurityAuditEvent"
    DISABLE TRIGGER "SecurityAuditEvent_append_only";

WITH "subject_label_backfill" AS (
    SELECT
        event."id",
        COALESCE(
            CASE
                WHEN event."subjectUserId" IS NOT NULL THEN COALESCE(
                    NULLIF(BTRIM(LEFT(BTRIM(REGEXP_REPLACE(COALESCE(subject_user."name", ''), '[[:cntrl:]]', ' ', 'g')), 160)), ''),
                    NULLIF(BTRIM(LEFT(BTRIM(REGEXP_REPLACE(COALESCE(subject_user."email", ''), '[[:cntrl:]]', ' ', 'g')), 160)), ''),
                    'Team member'
                )
            END,
            CASE
                WHEN event."type" = 'INVITE_REVOKED'::"SecurityAuditEventType" THEN COALESCE(
                    NULLIF(
                        BTRIM(LEFT(
                            'Invitation for ' || BTRIM(REGEXP_REPLACE(COALESCE(invite."email", ''), '[[:cntrl:]]', ' ', 'g')),
                            160
                        )),
                        'Invitation for '
                    ),
                    'Pending invitation'
                )
            END,
            NULLIF(BTRIM(LEFT(BTRIM(REGEXP_REPLACE(COALESCE(organisation."name", ''), '[[:cntrl:]]', ' ', 'g')), 160)), ''),
            'Organisation'
        ) AS "subjectLabel"
    FROM "SecurityAuditEvent" AS event
    LEFT JOIN "User" AS subject_user
        ON subject_user."id" = event."subjectUserId"
       AND subject_user."organisationId" = event."organisationId"
    LEFT JOIN "TeamInvite" AS invite
        ON invite."id" = event."context" ->> 'inviteId'
       AND invite."organisationId" = event."organisationId"
    LEFT JOIN "Organisation" AS organisation
        ON organisation."id" = event."organisationId"
)
UPDATE "SecurityAuditEvent" AS event
SET "subjectLabel" = backfill."subjectLabel"
FROM "subject_label_backfill" AS backfill
WHERE event."id" = backfill."id";

ALTER TABLE "SecurityAuditEvent"
    ENABLE TRIGGER "SecurityAuditEvent_append_only";

ALTER TABLE "SecurityAuditEvent"
    ALTER COLUMN "subjectLabel" SET NOT NULL,
    ADD CONSTRAINT "SecurityAuditEvent_subject_label_check" CHECK (
        CHAR_LENGTH("subjectLabel") BETWEEN 1 AND 160
        AND "subjectLabel" = BTRIM("subjectLabel")
        AND "subjectLabel" !~ '[[:cntrl:]]'
    );

COMMENT ON COLUMN "SecurityAuditEvent"."subjectLabel" IS
    'Immutable bounded display snapshot of the event subject at occurrence time.';

COMMIT;
