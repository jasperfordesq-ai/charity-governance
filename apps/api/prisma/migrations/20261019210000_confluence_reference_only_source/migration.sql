BEGIN;
-- These are integration subjects, not user-security subjects. Preserve the
-- user-subject requirements for every existing authentication/team event.
ALTER TABLE "SecurityAuditEvent" DROP CONSTRAINT "SecurityAuditEvent_subject_check";
ALTER TABLE "SecurityAuditEvent" ADD CONSTRAINT "SecurityAuditEvent_subject_check" CHECK (
  ("type" IN (
    'ACTION_APPROVAL_REFUSED'::"SecurityAuditEventType",'SECOND_FACTOR_ENROLLED'::"SecurityAuditEventType",'SECOND_FACTOR_REMOVED'::"SecurityAuditEventType",
    'SECOND_FACTOR_RECOVERY_USED'::"SecurityAuditEventType",'MEMBER_SUSPENDED'::"SecurityAuditEventType",'MEMBER_REACTIVATED'::"SecurityAuditEventType",
    'MEMBER_REMOVED'::"SecurityAuditEventType",'MEMBER_ROLE_CHANGED'::"SecurityAuditEventType",'OWNERSHIP_TRANSFERRED'::"SecurityAuditEventType",'OWNERSHIP_RECOVERED'::"SecurityAuditEventType",
    'SESSION_REVOKED'::"SecurityAuditEventType",'ALL_SESSIONS_REVOKED'::"SecurityAuditEventType",'SESSION_REPLAY_DETECTED'::"SecurityAuditEventType"
  ) AND "subjectUserId" IS NOT NULL)
  OR "type" IN (
    'ORGANISATION_SUSPENDED'::"SecurityAuditEventType",'ORGANISATION_REACTIVATED'::"SecurityAuditEventType",'ORGANISATION_CLOSED'::"SecurityAuditEventType",
    'ORGANISATION_CONFIGURATION_CHANGED'::"SecurityAuditEventType",'INVITE_REVOKED'::"SecurityAuditEventType",'INVITE_LINK_REISSUED'::"SecurityAuditEventType",
    'INTEGRATION_CONNECTED'::"SecurityAuditEventType",'INTEGRATION_SITE_SELECTED'::"SecurityAuditEventType",'INTEGRATION_DISCONNECTED'::"SecurityAuditEventType",
    'INTEGRATION_PUBLISH_TARGET_CHANGED'::"SecurityAuditEventType",'INTEGRATION_ENVIRONMENT_DECLARED'::"SecurityAuditEventType",
    'INTEGRATION_REAUTHORISATION_REQUIRED'::"SecurityAuditEventType",'DOCUMENT_PUBLICATION_DEAD_LETTERED'::"SecurityAuditEventType",
    'CONFLUENCE_ERASURE_REQUESTED'::"SecurityAuditEventType",'CONFLUENCE_ERASURE_REVIEW_RECORDED'::"SecurityAuditEventType",
    'CONFLUENCE_CITATION_REVIEW_RECORDED'::"SecurityAuditEventType",'CONFLUENCE_SOURCE_REGISTERED'::"SecurityAuditEventType",'CONFLUENCE_SOURCE_REMOVED'::"SecurityAuditEventType"
  )
);

ALTER TABLE "ConfluenceReference" ADD COLUMN "referenceKind" TEXT NOT NULL DEFAULT 'VAULT_EVIDENCE';
ALTER TABLE "ConfluenceReference" ALTER COLUMN "documentId" DROP NOT NULL;
ALTER TABLE "ConfluenceReference" ADD CONSTRAINT "ConfluenceReference_anchor_shape"
  CHECK (("referenceKind"='VAULT_EVIDENCE' AND "documentId" IS NOT NULL)
      OR ("referenceKind"='CONFLUENCE_SOURCE' AND "documentId" IS NULL));
CREATE UNIQUE INDEX "ConfluenceSource_registration_request_key"
  ON "SecurityAuditEvent" ("organisationId", (context->>'referenceId'))
  WHERE type='CONFLUENCE_SOURCE_REGISTERED';

-- Existing tenant FK and live-Document guard remain in place for file anchors.
-- The recovery gate already freezes INSERT/UPDATE/DELETE by organisation,
-- independently of documentId. It must apply to both anchor shapes.
-- Source facts are historical identities, never silently re-anchored/recited.
CREATE FUNCTION "ConfluenceReference_source_identity_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF OLD."referenceKind"='CONFLUENCE_SOURCE' OR NEW."referenceKind"='CONFLUENCE_SOURCE' THEN
    IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
      RAISE EXCEPTION 'Confluence source citation identity cannot be rewritten';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ConfluenceReference_source_identity_guard"
  BEFORE UPDATE ON "ConfluenceReference" FOR EACH ROW
  EXECUTE FUNCTION "ConfluenceReference_source_identity_guard_fn"();
COMMIT;
