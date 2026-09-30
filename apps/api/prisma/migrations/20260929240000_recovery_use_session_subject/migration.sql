-- Recovery-code use may identify the session family created by sign-in or
-- used for password change. Removal can record the same event without a
-- family. Revocation and replay events still require a family; every other
-- security event still forbids one.
ALTER TABLE "SecurityAuditEvent"
  DROP CONSTRAINT IF EXISTS "SecurityAuditEvent_session_subject_check";

ALTER TABLE "SecurityAuditEvent"
  ADD CONSTRAINT "SecurityAuditEvent_session_subject_check" CHECK (
    (
      "type" IN (
        'SESSION_REVOKED'::"SecurityAuditEventType",
        'SESSION_REPLAY_DETECTED'::"SecurityAuditEventType"
      ) AND "subjectSessionId" IS NOT NULL
    ) OR (
      "type" = 'SECOND_FACTOR_RECOVERY_USED'::"SecurityAuditEventType"
    ) OR (
      "type" NOT IN (
        'SESSION_REVOKED'::"SecurityAuditEventType",
        'SESSION_REPLAY_DETECTED'::"SecurityAuditEventType",
        'SECOND_FACTOR_RECOVERY_USED'::"SecurityAuditEventType"
      ) AND "subjectSessionId" IS NULL
    )
  );
