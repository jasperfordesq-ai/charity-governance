import assert from 'node:assert/strict';

export async function proveDocumentPolicyConflict(sql,plan,orderedRace) {
  const approve=id=>`INSERT INTO "DataRetentionPolicyRevision" (id,"organisationId","recordClass",revision,state,"retentionMode","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef")
    SELECT '${id}','retention-a','VAULT_DRAFT',max(revision)+1,'APPROVED','REVIEW_REQUIRED',30,'owner-a','owner-a',now(),'POLICY-CONFLICT-001'
    FROM "DataRetentionPolicyRevision" WHERE "organisationId"='retention-a' AND "recordClass"='VAULT_DRAFT';`;
  const withdraw=id=>`INSERT INTO "DataRetentionPolicyWithdrawal" (id,"organisationId","policyId","actorUserId",reason,"evidenceRef") VALUES ('withdraw-${id}','retention-a','${id}','owner-a','Resolve synthetic duplicate approval','POLICY-CONFLICT-002');`;
  sql(approve('unique-policy'));sql(approve('removal-competitor'));
  sql(`INSERT INTO "Document" (id,"organisationId",name,category,"fileUrl","fileSize","mimeType","updatedAt","lifecycleStatus","storageProvider")
    VALUES ('policy-conflict-doc','retention-a','Synthetic policy conflict','OTHER','retention-a/conflict.pdf',12,'application/pdf',now(),'DRAFT','local');`);
  const remove=`UPDATE "Document" SET "deletedAt"=timezone('UTC',statement_timestamp()),"deletedById"='owner-a',"removedFromRevision"="updatedAt","removalEvidenceRef"='REMOVE-CONFLICT-001',"recoveryPolicyId"='unique-policy',"recoveryUntil"=timezone('UTC',statement_timestamp())+INTERVAL '30 days',"recoverySha256"=repeat('a',64),"updatedAt"=timezone('UTC',statement_timestamp()) WHERE id='policy-conflict-doc';`;
  sql(remove,/approved current draft recovery policy/);
  assert.equal(sql(`SELECT "deletedAt" IS NULL FROM "Document" WHERE id='policy-conflict-doc';`),'t');
  sql(withdraw('removal-competitor'));sql(remove);
  // Expire only this disposable fixture. Normal data cannot bypass the guard.
  sql(`ALTER TABLE "Document" DISABLE TRIGGER "Document_recovery_state_guard";
    UPDATE "Document" SET "deletedAt"="deletedAt"-INTERVAL '31 days',"recoveryUntil"="recoveryUntil"-INTERVAL '31 days' WHERE id='policy-conflict-doc';
    ALTER TABLE "Document" ENABLE TRIGGER "Document_recovery_state_guard";`);
  const authorize=`INSERT INTO "DocumentPurgeAuthorization" (id,"organisationId","documentId","documentRevision","policyId","actorUserId","evidenceRef",reason,"storagePath",provider,sha256,"fileSize","recoveryUntil","dispositionPlan")
    SELECT 'policy-conflict-auth',"organisationId",id,"updatedAt",'unique-policy','owner-a','AUTH-CONFLICT-001','Reviewed synthetic ambiguity resolution',"fileUrl","storageProvider","recoverySha256","fileSize","recoveryUntil",'${JSON.stringify(plan)}'::jsonb FROM "Document" WHERE id='policy-conflict-doc';`;
  sql(approve('authority-competitor'));sql(authorize,/current approved draft policy/);
  sql(withdraw('authority-competitor'));sql(authorize);
  const claim=`INSERT INTO "DocumentPurgeClaim" (id,"organisationId","authorizationId","documentId","deletionId","actorUserId") VALUES ('policy-conflict-claim','retention-a','policy-conflict-auth','policy-conflict-doc','policy-conflict-job','owner-a');`;
  sql(approve('claim-competitor'));sql(claim,/current approved draft policy/);
  assert.equal(sql(`SELECT count(*) FROM "Document" WHERE id='policy-conflict-doc'; SELECT count(*) FROM "DocumentStorageDeletion" WHERE id='policy-conflict-job';`),'1\n0');
  sql(withdraw('claim-competitor'));
  await orderedRace(approve('racing-policy'),claim,/current approved draft policy/);
  sql(withdraw('racing-policy'));
  assert.equal(sql(`BEGIN; ${claim} SELECT count(*) FROM "Document" WHERE id='policy-conflict-doc'; SELECT count(*) FROM "DocumentStorageDeletion" WHERE id='policy-conflict-job'; ROLLBACK;`),'0\n1');
  assert.equal(sql(`SELECT count(*) FROM "DocumentPurgeClaim" WHERE id='policy-conflict-claim';`),'0');
}
