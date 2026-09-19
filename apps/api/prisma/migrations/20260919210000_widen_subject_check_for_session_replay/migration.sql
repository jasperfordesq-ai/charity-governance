-- SESSION_REPLAY_DETECTED was declared by the migration before this one. The
-- CHECK constraint deciding which event types may be recorded, and whether
-- each needs a subject user, has to admit it or every replay quarantine would
-- fail at the database.
--
-- A replay is always about a specific person's session, so it belongs in the
-- branch that requires a subject user, next to SESSION_REVOKED. Everything
-- else in the constraint is unchanged.
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
                'INVITE_REVOKED'::"SecurityAuditEventType",
                'INVITE_LINK_REISSUED'::"SecurityAuditEventType"
            )
        )
    );
