import assert from 'node:assert/strict';

// Called only inside the disposable, fully migrated retention proof. Policy
// insertion, authorisation and claim all use the normal calendar-mode guards.
export function proveDocumentCalendarClaim(sql, plan) {
  const fixture = createdAt => `BEGIN;
    INSERT INTO "Organisation" (id,name,"updatedAt") VALUES ('calendar-chain','Synthetic calendar claim',now());
    INSERT INTO "User" (id,email,name,"passwordHash",role,"organisationId","updatedAt") VALUES
      ('calendar-chain-owner','calendar-chain@example.invalid','Synthetic owner','fixture-password-hash','OWNER','calendar-chain',now());
    INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,state,"retentionMode","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef") VALUES
      ('calendar-chain-original','calendar-chain','VAULT_DRAFT',1,'APPROVED','REVIEW_REQUIRED',30,'calendar-chain-owner','calendar-chain-owner',now(),'CALENDAR-ORIGINAL-001');
    INSERT INTO "Document" (id,"organisationId",name,category,"fileUrl","fileSize","mimeType","createdAt","updatedAt","lifecycleStatus","storageProvider") VALUES
      ('calendar-chain-doc','calendar-chain','Synthetic calendar draft','OTHER','calendar-chain/file.pdf',4,'application/pdf',${createdAt},now(),'DRAFT','local');
    UPDATE "Document" SET "deletedAt"=timezone('UTC',statement_timestamp()),"deletedById"='calendar-chain-owner',
      "removedFromRevision"="updatedAt","removalEvidenceRef"='CALENDAR-REMOVE-001',"recoveryPolicyId"='calendar-chain-original',
      "recoveryUntil"=timezone('UTC',statement_timestamp())+INTERVAL '30 days',"recoverySha256"=repeat('a',64),
      "updatedAt"=timezone('UTC',statement_timestamp()) WHERE id='calendar-chain-doc';
    -- Age only the disposable recovery clock; no claim/authority guard is disabled.
    ALTER TABLE "Document" DISABLE TRIGGER "Document_recovery_state_guard";
    UPDATE "Document" SET "deletedAt"="deletedAt"-INTERVAL '31 days',"recoveryUntil"="recoveryUntil"-INTERVAL '31 days' WHERE id='calendar-chain-doc';
    ALTER TABLE "Document" ENABLE TRIGGER "Document_recovery_state_guard";
    INSERT INTO "DataRetentionPolicyWithdrawal" (id,"organisationId","policyId","actorUserId",reason,"evidenceRef") VALUES
      ('calendar-chain-withdrawal','calendar-chain','calendar-chain-original','calendar-chain-owner','Replace synthetic review rule with calendar term','CALENDAR-REPLACE-001');
    INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,state,"retentionMode","retentionAnchor","retentionDays","retentionYears","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef") VALUES
      ('calendar-chain-policy','calendar-chain','VAULT_DRAFT',2,'APPROVED','AFTER_CALENDAR_YEARS','CREATED_AT',NULL,6,30,'calendar-chain-owner','calendar-chain-owner',now(),'CALENDAR-POLICY-001');
    INSERT INTO "DocumentPurgeAuthorization" (id,"organisationId","documentId","documentRevision","policyId","actorUserId","evidenceRef",reason,"storagePath",provider,sha256,"fileSize","recoveryUntil","dispositionPlan")
      SELECT 'calendar-chain-auth',"organisationId",id,"updatedAt",'calendar-chain-policy','calendar-chain-owner','CALENDAR-AUTH-001',
        'Reviewed synthetic calendar claim with all normal guards',"fileUrl","storageProvider","recoverySha256","fileSize","recoveryUntil",'${JSON.stringify(plan)}'::jsonb
      FROM "Document" WHERE id='calendar-chain-doc';`;
  const claim = `INSERT INTO "DocumentPurgeClaim" (id,"organisationId","authorizationId","documentId","deletionId","actorUserId") VALUES
    ('calendar-chain-claim','calendar-chain','calendar-chain-auth','calendar-chain-doc','calendar-chain-job','calendar-chain-owner');`;
  const rows = `SELECT count(*) FROM "Document" WHERE id='calendar-chain-doc';
    SELECT count(*) FROM "DocumentPurgeClaim" WHERE id='calendar-chain-claim';
    SELECT count(*) FROM "DocumentStorageDeletion" WHERE id='calendar-chain-job'
      AND "organisationId"='calendar-chain' AND "sourceDocumentId"='calendar-chain-doc'
      AND "storagePath"='calendar-chain/file.pdf' AND provider='local' AND "requestedById"='calendar-chain-owner';
    SELECT count(*) FROM "DocumentControlAudit" WHERE id='calendar-chain-claim'
      AND "organisationId"='calendar-chain' AND "documentId"='calendar-chain-doc'
      AND "actorUserId"='calendar-chain-owner' AND kind='RECORD_DELETE';`;
  const enabled = `SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'O'
    AND tgrelid IN ('"Document"'::regclass,'"DocumentPurgeAuthorization"'::regclass,
      '"DocumentPurgeClaim"'::regclass,'"DataRetentionPolicyRevision"'::regclass);`;
  // Relative fixtures remain valid when this suite runs in later years.
  const early = `(date_trunc('year',timezone('UTC',now()))-INTERVAL '1 year')::timestamp(3)`;
  const elapsed = `(date_trunc('year',timezone('UTC',now()))-INTERVAL '7 years')::timestamp(3)`;
  sql(`${fixture(early)} ${claim} ROLLBACK;`, /must wait for calendar-year retention expiry/);
  sql(`${fixture(elapsed)} UPDATE "Document" SET "deletionHold"=true WHERE id='calendar-chain-doc';
    ${claim} ROLLBACK;`, /unheld removed draft/);
  sql(`${fixture(elapsed)} INSERT INTO "DocumentPurgeAuthorizationWithdrawal"
    (id,"organisationId","authorizationId","actorUserId",reason,"evidenceRef") VALUES
    ('calendar-chain-cancel','calendar-chain','calendar-chain-auth','calendar-chain-owner',
      'Cancel the synthetic calendar disposal authority','CALENDAR-CANCEL-001');
    ${claim} ROLLBACK;`, /unwithdrawn Owner authority/);
  assert.equal(sql(`${fixture(elapsed)} ${enabled} ${claim} ${rows} ROLLBACK;`), '0\n0\n1\n1\n1');
  assert.equal(sql(rows), '0\n0\n0\n0');
  assert.equal(sql(enabled), '0');
}
