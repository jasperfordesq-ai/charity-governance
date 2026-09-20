-- The seven integration lifecycle events declared by the migration before this
-- one. The CHECK constraint deciding which event types may be recorded, and
-- whether each needs a subject user, has to admit them or every one of those
-- writes would fail at the database.
--
-- ALL SEVEN GO IN THE NO-SUBJECT BRANCH, and that is a statement about what
-- these events are, not a convenience. `subjectUserId` names the PERSON an
-- event happened TO — whose access changed, whose session was revoked. Nothing
-- here is about a person in that sense:
--
--   INTEGRATION_CONNECTED / _DISCONNECTED / _SITE_SELECTED /
--   _PUBLISH_TARGET_CHANGED   the subject is the integration and the site.
--   INTEGRATION_REAUTHORISATION_REQUIRED   nobody did it; an unused
--                             authorisation lapsed at Atlassian.
--   DOCUMENT_PUBLICATION_DEAD_LETTERED     the subject is a document.
--   CONFLUENCE_ERASURE_REQUESTED           the subject is a page. The person
--                             who ASKED is the actor, and is recorded in
--                             `actorUserId`; putting them in `subjectUserId`
--                             would read as the erasure being about them.
--
-- Naming a user on any of these would imply somebody was responsible for, or
-- the object of, something they were not — which in an audit log is worse than
-- recording nothing.
--
-- CAUGHT BY security-audit-subject-check-coverage.test.ts BEFORE THIS EVER RAN,
-- which is the fourth time that test has paid for itself. The defect it exists
-- to catch is precisely this one: on 2026-08-30 INVITE_LINK_REISSUED was added
-- to the enum without widening this constraint, and every invitation reissue
-- failed at the database for twenty days before anybody noticed.
--
-- Written as DROP IF EXISTS + ADD so it is safe to apply by hand ahead of the
-- deploy that carries it, and harmless when the deploy applies it again.
ALTER TABLE "SecurityAuditEvent"
    DROP CONSTRAINT IF EXISTS "SecurityAuditEvent_subject_check";

ALTER TABLE "SecurityAuditEvent"
    ADD CONSTRAINT "SecurityAuditEvent_subject_check" CHECK (
        (
            "type" IN (
                'MEMBER_SUSPENDED'::"SecurityAuditEventType",
                'MEMBER_REACTIVATED'::"SecurityAuditEventType",
                'MEMBER_REMOVED'::"SecurityAuditEventType",
                'MEMBER_ROLE_CHANGED'::"SecurityAuditEventType",
                'OWNERSHIP_TRANSFERRED'::"SecurityAuditEventType",
                'OWNERSHIP_RECOVERED'::"SecurityAuditEventType",
                'SESSION_REVOKED'::"SecurityAuditEventType",
                'ALL_SESSIONS_REVOKED'::"SecurityAuditEventType",
                'SESSION_REPLAY_DETECTED'::"SecurityAuditEventType"
            )
            AND "subjectUserId" IS NOT NULL
        )
        OR
        (
            "type" IN (
                'ORGANISATION_SUSPENDED'::"SecurityAuditEventType",
                'ORGANISATION_REACTIVATED'::"SecurityAuditEventType",
                'ORGANISATION_CLOSED'::"SecurityAuditEventType",
                'ORGANISATION_CONFIGURATION_CHANGED'::"SecurityAuditEventType",
                'INVITE_REVOKED'::"SecurityAuditEventType",
                'INVITE_LINK_REISSUED'::"SecurityAuditEventType",
                'INTEGRATION_CONNECTED'::"SecurityAuditEventType",
                'INTEGRATION_SITE_SELECTED'::"SecurityAuditEventType",
                'INTEGRATION_DISCONNECTED'::"SecurityAuditEventType",
                'INTEGRATION_PUBLISH_TARGET_CHANGED'::"SecurityAuditEventType",
                'INTEGRATION_REAUTHORISATION_REQUIRED'::"SecurityAuditEventType",
                'DOCUMENT_PUBLICATION_DEAD_LETTERED'::"SecurityAuditEventType",
                'CONFLUENCE_ERASURE_REQUESTED'::"SecurityAuditEventType"
            )
        )
    );
