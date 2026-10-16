import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import { ConfluenceRetainedCopyReviewService } from '../apps/api/dist/services/confluence-retained-copy-review.service.js';
import { registerSyntheticConfluenceScope } from '../apps/api/dist/services/confluence-synthetic-scope.js';
import { ConfluenceRetainedCopyPermissionService } from '../apps/api/dist/services/confluence-retained-copy-permission.service.js';
import { ConfluenceCopyExecutionClaimService } from '../apps/api/dist/services/confluence-copy-execution-claim.js';
import { recoveryFactsFixture } from '../apps/api/dist/tests/fixtures/confluence-copy-recovery-facts.js';
import { PURGE_RESTORE_SNAPSHOT_SQL, assertPurgeRestoreLedger } from './purge-restore-reconciliation.mjs';

/** Runs only after the existing proof in its UUID disposable database. */
export async function runConfluenceExecutionClaimPostgresProof(prisma,url) {
  const target=new URL(url);
  assert.equal(target.hostname,'127.0.0.1');
  assert.equal(target.username,'postgres');
  assert.match(target.pathname,/^\/copy_ledger_[a-f0-9]{32}$/);
  const [database]=await prisma.$queryRaw`SELECT current_database() AS name,current_user AS role`;
  assert.equal(database.name,target.pathname.slice(1));assert.equal(database.role,'postgres');
  await prisma.organisation.update({where:{id:'org-a'},data:{lifecycleStatus:'ACTIVE'}});
  const doc=await prisma.document.findUniqueOrThrow({where:{id:'doc-a'}});
  const pub=await prisma.documentPublication.findUniqueOrThrow({where:{id:'pub-a'}});
  const connection=await prisma.organisationIntegration.findUniqueOrThrow({where:{organisationId_provider:{organisationId:'org-a',provider:'CONFLUENCE'}}});
  const now=Date.now(), review=recoveryFactsFixture().review.review;
  review.reviewedAt=new Date(now).toISOString();review.expiresAt=new Date(now+3600000).toISOString();
  review.snapshot.sourceRevision=doc.updatedAt.toISOString();review.snapshot.publicationRevision=pub.updatedAt.toISOString();
  review.snapshot.inventory.observedAt=new Date(now).toISOString();
  const recorded=await new ConfluenceRetainedCopyReviewService(prisma).record('org-a','owner-a',review);
  const scopeInput={organisationId:'org-a',reviewId:recorded.id,expectedSnapshotSha256:recorded.snapshotSha256,
    approvedById:'owner-a',evidenceRef:'SYNTHETIC-CLAIM-SCOPE',disposalPolicyEvidenceRef:'SYNTHETIC-CLAIM-DISPOSAL',expiresAt:new Date(now+3500000).toISOString()};
  const preview=await registerSyntheticConfluenceScope(prisma,scopeInput);
  const registered=await registerSyntheticConfluenceScope(prisma,scopeInput,preview.confirmationSha256);
  const scope=await prisma.confluenceSyntheticCopyScope.findUniqueOrThrow({where:{id:registered.scopeId}});
  const permissions=new ConfluenceRetainedCopyPermissionService(prisma,{observeSource:async()=>({
    actorUserId:'owner-a',snapshot:review.snapshot,sourceBytesObserved:true,actionAuthorized:false,syntheticVerified:false,allCopiesVerified:false,
    connection:{integrationId:connection.id,connectedAt:connection.connectedAt.toISOString(),cloudId:review.snapshot.cloudId,siteOrigin:review.snapshot.siteOrigin},
  })});
  const {permission}=await permissions.issue('org-a','owner-a',recorded.id,{scopeId:scope.id,expectedSnapshotSha256:recorded.snapshotSha256,
    evidenceRef:'SYNTHETIC-CLAIM-PERMISSION',reason:'Synthetic one-use claim proof only, no provider request',
    attestation:'AUTHORISE PURGE OF THIS SYNTHETIC CONFLUENCE COPY; RETAIN PRIMARY',scopeEvidenceRef:scope.evidenceRef,
    disposalPolicyEvidenceRef:scope.disposalPolicyEvidenceRef,expiresAt:new Date(now+3400000).toISOString()});
  const service=new ConfluenceCopyExecutionClaimService(prisma);
  const input={permissionId:permission.id,operationId:'claim-race-a',expectedSnapshotSha256:recorded.snapshotSha256,
    evidenceRef:'SYNTHETIC-CLAIM-EXECUTION',reason:'Synthetic local consumption remains quarantined for independent history'};
  const before=(await prisma.$queryRaw(Prisma.raw(PURGE_RESTORE_SNAPSHOT_SQL)))[0].snapshot;
  const raced=await Promise.allSettled([service.claim('org-a','owner-a',input),service.claim('org-a','owner-a',{...input,operationId:'claim-race-b'})]);
  assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(await prisma.confluenceCopyExecutionClaim.count(),1);
  const row=await prisma.confluenceCopyExecutionClaim.findFirstOrThrow();
  assert.equal(row.phase,'QUARANTINED');assert.equal(row.providerIOAuthorised,false);
  const previousArchive=await prisma.confluenceCopyLedgerCapture.findFirstOrThrow({where:{organisationId:'org-a'}});
  await assert.rejects(prisma.confluenceCopyLedgerCapture.create({data:{...previousArchive,id:'claims-omitted-archive'}}),
    /compatible independent archive/);
  const restarted=new PrismaClient({datasources:{db:{url}}});
  try {
    const receipt=await new ConfluenceCopyExecutionClaimService(restarted).receipt('org-a','owner-a',row.operationId);
    assert.equal(receipt.claim.id,row.id);assert.equal(receipt.providerIOAuthorised,false);
    await assert.rejects(new ConfluenceCopyExecutionClaimService(restarted).claim('org-a','owner-a',input));
  } finally {await restarted.$disconnect();}
  for (const [org,actor] of [['org-a','member-a'],['org-b','owner-a']]) await assert.rejects(service.claim(org,actor,{...input,operationId:'forbidden'}));
  await assert.rejects(service.receipt('org-a','member-a',row.operationId));
  const clone={...row,id:'other-claim',operationId:'other-claim'};
  await assert.rejects(prisma.$transaction(async tx=>{
    await tx.$executeRaw`SET LOCAL synchronous_commit = off`;
    await tx.confluenceCopyExecutionClaim.create({data:clone});
  }),/durable WAL/);
  await assert.rejects(prisma.confluenceCopyExecutionClaim.update({where:{id:row.id},data:{phase:'QUARANTINED'}}),/append-only/);
  await assert.rejects(prisma.confluenceCopyExecutionClaim.delete({where:{id:row.id}}),/append-only/);
  await assert.rejects(prisma.$executeRaw`TRUNCATE public."ConfluenceCopyExecutionClaim"`,/append-only/);
  const after=(await prisma.$queryRaw(Prisma.raw(PURGE_RESTORE_SNAPSHOT_SQL)))[0].snapshot;
  assert.equal(after.format,14);
  assert.throws(()=>assertPurgeRestoreLedger(after,before),{code:'PURGE_RESTORE_RECONCILIATION_REQUIRED'});
  assert.equal(assertPurgeRestoreLedger(after,after).confluenceExecutionClaimsCompared,true);
  return {racingClaims:2,committedClaims:1,restartedReceipt:true,olderRestoreRefused:true,providerRequests:0};
}
