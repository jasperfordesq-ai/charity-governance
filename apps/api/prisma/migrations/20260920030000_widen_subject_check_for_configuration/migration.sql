-- ORGANISATION_CONFIGURATION_CHANGED was declared by the migration before this
-- one. The CHECK constraint deciding which event types may be recorded, and
-- whether each needs a subject user, has to admit it or every configuration
-- change would fail at the database.
--
-- It belongs in the branch that requires NO subject user, beside the other
-- organisation-level events. The subject of a configuration change is the
-- charity, not a person: nobody's access changes, and naming a user would
-- imply one was responsible for a decision taken about them.
--
-- Caught by security-audit-subject-check-coverage.test.ts before this ever ran,
-- which is the third time that test has paid for itself.
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
                'INVITE_LINK_REISSUED'::"SecurityAuditEventType"
            )
        )
    );
