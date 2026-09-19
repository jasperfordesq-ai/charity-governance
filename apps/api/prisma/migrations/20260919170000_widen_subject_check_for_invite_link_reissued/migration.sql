-- INVITE_LINK_REISSUED was added to "SecurityAuditEventType" on 2026-08-30
-- (20260830180000_add_invite_link_reissued_audit) but the CHECK constraint that
-- decides which event types may be recorded without a subject user was never
-- widened to admit it. Every attempt to reissue an invitation link has therefore
-- failed at the database with a CHECK violation since that date; the first one
-- anybody noticed was 2026-09-19.
--
-- A reissue is about an invitation, not a user, so it belongs in the no-subject
-- branch next to INVITE_REVOKED. Everything else in the constraint is unchanged.
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
                'ALL_SESSIONS_REVOKED'::"SecurityAuditEventType"
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
