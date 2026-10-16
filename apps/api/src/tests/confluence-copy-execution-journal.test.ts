import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfluenceCopyExecutionJournalService } from '../services/confluence-copy-execution-journal.js';
const input = { claimId: 'claim-a', requestKey: 'request-a', action: 'TRASH', evidenceRef: 'SYNTHETIC-REQUEST',
  reason: 'Prepare the exact synthetic request without provider execution' };
test('request preparation binds trusted tenant/actor and never authorises IO', async () => {
  let written: unknown;
  const service = new ConfluenceCopyExecutionJournalService({ confluenceCopyExecutionRequest: { create: async ({ data }: {data: unknown}) => {
    written = data; return { id: 'request-row', requestKey: 'request-a', action: 'TRASH', phase: 'QUARANTINED' };
  } } } as never);
  const result = await service.prepare('org-a','owner-a',input);
  assert.deepEqual(written, { organisationId: 'org-a', actorUserId: 'owner-a', ...input });
  assert.equal(result.providerIOAuthorised, false);
  assert.equal(result.currentSourceChecked, false);
});
test('uncertain request and outcome responses redact private details and require receipt reconciliation', async () => {
  const fail = async () => { throw new Error('PRIVATE-TRANSPORT-CREDENTIAL'); };
  const service = new ConfluenceCopyExecutionJournalService({ confluenceCopyExecutionRequest: {create: fail}, confluenceCopyExecutionOutcome: {create: fail} } as never);
  for (const operation of [() => service.prepare('org-a','owner-a',input), () => service.recordOutcome('org-a', { requestId: 'request-row', requestOutcome: 'UNRESOLVED',
    automaticRetryAllowed: false, providerAbsenceVerified: false, allCopiesVerified: false })]) {
    await assert.rejects(operation, (error: unknown) => {
      assert.equal((error as {code: string}).code, 'CONFLUENCE_COPY_EXECUTION_JOURNAL_UNRESOLVED');
      assert.equal(String(error).includes('PRIVATE-TRANSPORT-CREDENTIAL'), false); return true;
    });
  }
});
test('outcome input cannot carry absence claims, retries or raw provider details', async () => {
  let calls = 0;
  const service = new ConfluenceCopyExecutionJournalService({ confluenceCopyExecutionOutcome: {create: async () => { calls++; return {id:'outcome-a'}; }} } as never);
  const valid = {requestId:'request-row',requestOutcome:'ACKNOWLEDGED',automaticRetryAllowed:false,providerAbsenceVerified:false,allCopiesVerified:false};
  for (const change of [{automaticRetryAllowed:true},{providerAbsenceVerified:true},{allCopiesVerified:true},{requestOutcome:'PURGED'},{rawError:'private'}]) {
    await assert.rejects(service.recordOutcome('org-a',{...valid,...change}));
  }
  assert.equal(calls,0);
  assert.equal((await service.recordOutcome('org-a',valid)).providerIOAuthorised,false);
  assert.equal(calls,1);
});

test('request input cannot override tenant/actor, provider target or introduce retry authority', async () => {
  let writes=0;
  const service=new ConfluenceCopyExecutionJournalService({confluenceCopyExecutionRequest:{create:async()=>{writes++;return {};}}} as never);
  for (const change of [{organisationId:'foreign'},{actorUserId:'foreign'},{pageId:'other-target'},{automaticRetryAllowed:true},{action:'RETRY'}]) {
    await assert.rejects(service.prepare('org-a','owner-a',{...input,...change}));
  }
  assert.equal(writes,0);
});
