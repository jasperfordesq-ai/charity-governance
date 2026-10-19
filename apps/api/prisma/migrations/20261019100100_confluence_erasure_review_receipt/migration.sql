-- Original request identity survives unknown acknowledgement. These audit rows
-- are reports, never provider authority or independent recovery evidence.
ALTER TABLE "SecurityAuditEvent" DROP CONSTRAINT "SecurityAuditEvent_subject_check";
ALTER TABLE "SecurityAuditEvent" ADD CONSTRAINT "SecurityAuditEvent_subject_check" CHECK (
  (
    "type" IN (
      'ACTION_APPROVAL_REFUSED'::"SecurityAuditEventType",
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
      'INTEGRATION_ENVIRONMENT_DECLARED'::"SecurityAuditEventType",
      'INTEGRATION_REAUTHORISATION_REQUIRED'::"SecurityAuditEventType",
      'DOCUMENT_PUBLICATION_DEAD_LETTERED'::"SecurityAuditEventType",
      'CONFLUENCE_ERASURE_REQUESTED'::"SecurityAuditEventType",
      'CONFLUENCE_ERASURE_REVIEW_RECORDED'::"SecurityAuditEventType"
    )
  )
);

CREATE UNIQUE INDEX "ConfluenceErasureReview_request_key"
  ON "SecurityAuditEvent" ("organisationId", ("context"->>'clientRequestId'))
  WHERE "context"->>'kind' = 'CONFLUENCE_ERASURE_REVIEW_V1';
