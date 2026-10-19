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
    'CONFLUENCE_CITATION_REVIEW_RECORDED'::"SecurityAuditEventType",'CONFLUENCE_SOURCE_REGISTERED'::"SecurityAuditEventType",'CONFLUENCE_SOURCE_REMOVED'::"SecurityAuditEventType",
    'CONFLUENCE_SOURCE_INSTRUCTION_RECORDED'::"SecurityAuditEventType",
    'CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN'::"SecurityAuditEventType",
    'CONFLUENCE_SOURCE_FOLLOWUP_RECORDED'::"SecurityAuditEventType"
  )
);

CREATE UNIQUE INDEX "ConfluenceSourceInstruction_request_key"
  ON "SecurityAuditEvent" ("organisationId", type, (context->>'clientRequestId'))
  WHERE type IN ('CONFLUENCE_SOURCE_INSTRUCTION_RECORDED','CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN','CONFLUENCE_SOURCE_FOLLOWUP_RECORDED');
CREATE UNIQUE INDEX "ConfluenceSourceInstruction_withdrawal_key"
  ON "SecurityAuditEvent" ("organisationId", (context->>'instructionId'))
  WHERE type='CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN';

CREATE FUNCTION "ConfluenceSourceInstruction_guard_fn"() RETURNS trigger AS $$
DECLARE original "SecurityAuditEvent"%ROWTYPE;
BEGIN
  PERFORM id FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  PERFORM id FROM "User" WHERE id=NEW."actorUserId" AND "organisationId"=NEW."organisationId" FOR UPDATE;
  IF NEW."actorKind" <> 'USER' OR NOT EXISTS (
    SELECT 1 FROM "User" u JOIN "Organisation" o ON o.id=u."organisationId"
      WHERE u.id=NEW."actorUserId" AND u."organisationId"=NEW."organisationId"
        AND u.role='OWNER' AND u."lifecycleStatus"='ACTIVE' AND o."lifecycleStatus"='ACTIVE'
  ) THEN RAISE EXCEPTION 'Source instruction requires active charity Owner'; END IF;
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement" WHERE "organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Source instruction requires independent recovery authority';
  END IF;
  IF (NEW.context->>'format') IS DISTINCT FROM '1'
    OR COALESCE(NEW.context->>'clientRequestId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR COALESCE(NEW.context->>'inputDigest','') !~ '^[a-f0-9]{64}$'
    OR (NEW.context->'input'->>'clientRequestId') IS DISTINCT FROM (NEW.context->>'clientRequestId')
    OR (NEW.context->'input'->>'reason') IS DISTINCT FROM NEW.reason
    OR (NEW.context->'providerMutationIssued') IS DISTINCT FROM 'false'::jsonb
    OR (NEW.context->'jobCreated') IS DISTINCT FROM 'false'::jsonb
    OR (NEW.context->'actionAuthorized') IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'Invalid source instruction envelope'; END IF;

  IF NEW.type='CONFLUENCE_SOURCE_INSTRUCTION_RECORDED' THEN
    IF (NEW.context->>'kind') IS DISTINCT FROM 'CONFLUENCE_SOURCE_INSTRUCTION_V1'
      OR (NEW.context->>'authorityAssessment') IS DISTINCT FROM 'OWNER_RECORDED'
      OR (NEW.context->'input'->'assessmentConfirmed') IS DISTINCT FROM 'true'::jsonb
      OR NOT EXISTS (SELECT 1 FROM "ConfluenceReference" r
        WHERE r.id=NEW.context->>'referenceId' AND r."organisationId"=NEW."organisationId"
          AND r.id=NEW.context->'citation'->>'id'
          AND r."cloudId"=NEW.context->'citation'->>'cloudId'
          AND r."pageId"=NEW.context->'citation'->>'pageId'
          AND r."pageVersion"::text=NEW.context->'citation'->>'pageVersion'
          AND r."documentId" IS NOT DISTINCT FROM (NEW.context->'citation'->>'documentId')
          AND (r."referenceKind"='CONFLUENCE_SOURCE' OR EXISTS (
            SELECT 1 FROM "Document" d WHERE d.id=r."documentId" AND d."organisationId"=r."organisationId" AND d."deletedAt" IS NULL)))
    THEN RAISE EXCEPTION 'Source instruction target is not a current same-charity citation'; END IF;
  ELSE
    SELECT * INTO original FROM "SecurityAuditEvent" WHERE id=NEW.context->>'instructionId'
      AND "organisationId"=NEW."organisationId" AND type='CONFLUENCE_SOURCE_INSTRUCTION_RECORDED';
    IF NOT FOUND OR (NEW.context->>'instructionDigest') IS DISTINCT FROM (original.context->>'inputDigest')
      OR NEW."occurredAt" < original."occurredAt" THEN
      RAISE EXCEPTION 'Source instruction original identity differs';
    END IF;
    IF NEW.type='CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN' AND (
      (NEW.context->>'kind') IS DISTINCT FROM 'CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWAL_V1'
      OR (NEW.context->'input'->>'expectedInstructionDigest') IS DISTINCT FROM (original.context->>'inputDigest')
    ) THEN RAISE EXCEPTION 'Source instruction withdrawal identity differs'; END IF;
    IF NEW.type='CONFLUENCE_SOURCE_FOLLOWUP_RECORDED' AND (
      (NEW.context->>'kind') IS DISTINCT FROM 'CONFLUENCE_SOURCE_FOLLOWUP_V1'
      OR (NEW.context->'observation'->>'targetDigest') IS DISTINCT FROM (original.context->'input'->>'expectedTargetDigest')
    ) THEN RAISE EXCEPTION 'Source instruction follow-up target differs'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ConfluenceSourceInstruction_guard" BEFORE INSERT ON "SecurityAuditEvent"
  FOR EACH ROW WHEN (NEW.type IN ('CONFLUENCE_SOURCE_INSTRUCTION_RECORDED','CONFLUENCE_SOURCE_INSTRUCTION_WITHDRAWN','CONFLUENCE_SOURCE_FOLLOWUP_RECORDED'))
  EXECUTE FUNCTION "ConfluenceSourceInstruction_guard_fn"();
COMMIT;
