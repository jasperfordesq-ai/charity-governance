-- Account MFA events concern the enrolled or recovered person, so they require
-- subjectUserId just like session and membership events. Keep the no-subject
-- organisation and integration event branch intact.
ALTER TABLE "SecurityAuditEvent"
  DROP CONSTRAINT IF EXISTS "SecurityAuditEvent_subject_check";

ALTER TABLE "SecurityAuditEvent"
  ADD CONSTRAINT "SecurityAuditEvent_subject_check" CHECK (
    (
      "type" IN (
        'SECOND_FACTOR_ENROLLED'::"SecurityAuditEventType",
        'SECOND_FACTOR_REMOVED'::"SecurityAuditEventType",
        'SECOND_FACTOR_RECOVERY_USED'::"SecurityAuditEventType",
        'MEMBER_SUSPENDED'::"SecurityAuditEventType",
        'MEMBER_REACTIVATED'::"SecurityAuditEventType",
        'MEMBER_REMOVED'::"SecurityAuditEventType",
        'MEMBER_ROLE_CHANGED'::"SecurityAuditEventType",
        'OWNERSHIP_TRANSFERRED'::"SecurityAuditEventType",
        'OWNERSHIP_RECOVERED'::"SecurityAuditEventType",
        'SESSION_REVOKED'::"SecurityAuditEventType",
        'ALL_SESSIONS_REVOKED'::"SecurityAuditEventType",
        'SESSION_REPLAY_DETECTED'::"SecurityAuditEventType"
      ) AND "subjectUserId" IS NOT NULL
    ) OR (
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
