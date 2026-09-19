-- SESSION_REPLAY_DETECTED records that a session family was quarantined after
-- an already-used refresh token was presented again. Like a revocation, it is
-- about a specific family, and the family id belongs in "subjectSessionId"
-- where it can be read alongside SESSION_REVOKED rather than buried in the
-- context blob.
--
-- The existing constraint permitted "subjectSessionId" on exactly one type, so
-- writing the new event with one failed at the database. This was caught by the
-- live connector suite on the first run after the audit row was added: the
-- disconnect test replays a revoked token and got a 500 instead of a 401.
--
-- Written as DROP IF EXISTS + ADD so it is safe to apply by hand ahead of the
-- deploy that carries it, and harmless when the deploy applies it again.
ALTER TABLE "SecurityAuditEvent"
    DROP CONSTRAINT IF EXISTS "SecurityAuditEvent_session_subject_check";

ALTER TABLE "SecurityAuditEvent"
    ADD CONSTRAINT "SecurityAuditEvent_session_subject_check" CHECK (
        (
            "type" IN (
                'SESSION_REVOKED'::"SecurityAuditEventType",
                'SESSION_REPLAY_DETECTED'::"SecurityAuditEventType"
            )
            AND "subjectSessionId" IS NOT NULL
        )
        OR
        (
            "type" NOT IN (
                'SESSION_REVOKED'::"SecurityAuditEventType",
                'SESSION_REPLAY_DETECTED'::"SecurityAuditEventType"
            )
            AND "subjectSessionId" IS NULL
        )
    );
