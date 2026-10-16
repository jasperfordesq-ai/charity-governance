import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { RecoveryAuthorityJournal } from '../services/recovery-authority-journal.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { fixture as decisionHistory } from './fixtures/confluence-copy-decision-history.js';
import { executionLedgerFixture } from './fixtures/confluence-execution-ledger-v2.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
import { prepareConfluenceCopyRecoveryFacts, assertConfluenceCopyRecoveryProgression } from '../services/confluence-copy-recovery-facts.js';
import { sealConfluenceCopyRecoveryFacts } from '../services/confluence-copy-recovery-envelope.js';
import { prepareConfluenceCopyLocalLedger } from '../services/confluence-copy-ledger-snapshot.js';
import { sealConfluenceCopyLedgerArchive } from '../services/confluence-copy-ledger-envelope.js';
import { prepareConfluenceExecutionLedgerV2 } from '../services/confluence-execution-ledger-v2.js';
import { sealConfluenceExecutionArchiveV2 } from '../services/confluence-execution-archive-v2.js';
import { readPublishedConfluenceExecutionV2, verifyConfluenceExecutionV2Candidate,
 publishVerifiedConfluenceExecutionV2 } from '../services/confluence-execution-v2-prefix.js';

const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const laterKey = 'arn:aws:kms:eu-west-1:123456789012:key/33333333-3333-3333-3333-333333333333';
async function setup(mixed = false, rotateOnly = false) {
 const f = await decisionHistory(), raw = executionLedgerFixture();
 const archives = new Map<string,string>(), legacy = new Map<string,string>();
 const key = (n: number) => `authority/${context.installationId}/${context.organisationId}/${String(n).padStart(10,'0')}.json`;
 function entry(n: number, operationId: string, kind: string, factsDigest: string, previousDigest: string | null) {
  const unsigned = { format: 1, installationId: context.installationId, organisationId: context.organisationId,
   generation: n, previousDigest, operationId, kind, factsDigest };
  const value = { ...unsigned, digest: hash(JSON.stringify(unsigned)) }; f.entries.set(key(n), JSON.stringify(value)); return value;
 }
 const first = JSON.parse(f.entries.get(key(1))!);
 const { writerEpoch: _epoch, captureOperationId: _op, ...old } = structuredClone(raw);
 old.capturedAt = '2026-10-15T18:05:03.000Z';
 old.format = 1; old.kind = 'CONFLUENCE_COPY_LOCAL_LEDGER_V1';
 for (const name of ['ConfluenceCopyExecutionClaim','ConfluenceCopyExecutionRequest','ConfluenceCopyExecutionOutcome']) delete old.tables[name];
 old.tables.ConfluenceRetainedCopyReviewWithdrawal = []; old.tables.ConfluenceRetainedCopyPermissionWithdrawal = [];
 old.tables.ConfluenceCopyRecoveryCapture!.pop();
 const receipt1 = raw.tables.ConfluenceCopyPublicationReceipt![0]!;
 Object.assign(receipt1, { envelopeDigest: first.factsDigest, entryDigest: first.digest });
 Object.assign(old.tables.ConfluenceCopyPublicationReceipt![0]!, receipt1);
 const oldBinding = { context: { ...context, operationId: 'archive-legacy' },
  observedControl: { ...f.state.current, generation: 1, digest: first.digest } };
 const oldSealed = await sealConfluenceCopyLedgerArchive(prepareConfluenceCopyLocalLedger(old).body, oldBinding, f.keys);
 legacy.set('archive-legacy', oldSealed.envelope);
 const oldEntry = entry(2, 'archive-legacy', 'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1', oldSealed.digest, first.digest);
 const currentContext = { ...context, operationId: 'archive-v2', writerEpoch: mixed && !rotateOnly ? 2 : 1, keyId: mixed ? laterKey : context.keyId };
 const secondFacts = { ...f.values[1]!, writerEpoch: currentContext.writerEpoch };
 const secondPlain = prepareConfluenceCopyRecoveryFacts(secondFacts);
 const secondSealed = await sealConfluenceCopyRecoveryFacts(secondPlain.body,
  { ...currentContext, operationId: 'state-2' }, f.keys);
 f.objects.set('state-2', secondSealed.envelope);
 const second = entry(3, 'state-2', 'CONFLUENCE_COPY_DECISION_STATE_V1', secondSealed.digest, oldEntry.digest);
 Object.assign(raw.tables.ConfluenceCopyRecoveryCapture![1]!, { writerEpoch: currentContext.writerEpoch,
  facts: secondPlain.body, factsDigest: secondPlain.digest });
 raw.tables.ConfluenceCopyPublicationPlan!.push({ ...raw.tables.ConfluenceCopyPublicationPlan![0]!, id: 'plan-2', captureId: 'capture-2',
  writerId: mixed && !rotateOnly ? 'writer-b' : 'writer-a', keyId: currentContext.keyId, expectedGeneration: 2, expectedDigest: oldEntry.digest,
  recordedAt: '2026-10-15T18:07:01.000Z' });
 raw.tables.ConfluenceCopyPublicationReceipt!.push({ ...receipt1, id: 'receipt-2', planId: 'plan-2', entryGeneration: 3,
  entryDigest: second.digest, envelopeDigest: secondSealed.digest, recordedAt: '2026-10-15T18:07:02.000Z' });
 raw.writerEpoch = currentContext.writerEpoch; raw.captureOperationId = currentContext.operationId;
 const binding = { context: currentContext, observedControl: { ...f.state.current, writerId: mixed && !rotateOnly ? 'writer-b' : 'writer-a',
  writerEpoch: currentContext.writerEpoch, generation: 3, digest: second.digest } };
 const policy = mixed && !rotateOnly ? [{ writerEpoch: 1, writerId: 'writer-a', keyIds: [context.keyId] },
  { writerEpoch: 2, writerId: 'writer-b', keyIds: [laterKey] }] : [{ writerEpoch: 1, writerId: 'writer-a', keyIds: mixed ? [context.keyId,laterKey] : [context.keyId] }];
 async function save() {
  const plain = prepareConfluenceExecutionLedgerV2(raw, binding.context);
  const sealed = await sealConfluenceExecutionArchiveV2(plain.body, binding, f.keys);
  archives.set(binding.context.operationId, sealed.envelope);
  const latest = entry(4, binding.context.operationId, 'CONFLUENCE_EXECUTION_LEDGER_ARCHIVE_V2', sealed.digest, second.digest);
  f.state.current = { ...binding.observedControl, generation: 4, digest: latest.digest, revision: 'current-v2' };
  return { plain, sealed, latest };
 }
 const saved = await save();
 const objects = { readConfluenceCopyStateHistory: async (op: string) => f.objects.get(op) ?? null,
  readConfluenceCopyLedgerHistory: async (op: string) => legacy.get(op) ?? null,
  readExecutionLedgerV2: async (ctx: typeof context) => archives.get(ctx.operationId) ?? null,
  readExecutionLedgerV2At: async (ctx: {writerEpoch:number;operationId:string}) => ctx.writerEpoch === binding.context.writerEpoch ? archives.get(ctx.operationId) ?? null : null };
 const read = () => readPublishedConfluenceExecutionV2(f.journal, f.control, binding, f.keys, objects, policy);
 return { f, raw, binding, policy, archives, legacy, key, entry, save, saved, objects, read };
}

test('V2 current read authenticates legacy archive, original decisions and all eleven groups across approved epochs/keys', async () => {
 const h = await setup(true), result = await h.read();
 assert.equal(result.body, h.saved.plain.body); assert.equal(result.decisionEntriesVerified, 2);
 assert.equal(result.archiveEntriesVerified, 2); assert.equal(result.archiveAtObservedHead, true);
 assert.equal(result.currentHistoryVerified, false); assert.equal(result.actionAuthorized, false);
 assert.equal(result.reopeningAuthorised, false);
 // Existing V1 progression stays single-epoch.
 assert.throws(() => assertConfluenceCopyRecoveryProgression(h.raw.tables.ConfluenceCopyRecoveryCapture![0]!.facts as string,
  h.raw.tables.ConfluenceCopyRecoveryCapture![1]!.facts as string));
});
test('V2 refuses missing historical payloads and unapproved key/writer/epoch policy', async () => {
 const h = await setup(true);
 const valid = structuredClone(h.policy);
 for (const wrong of [[valid[1]!], [{ ...valid[0]!, keyIds: [laterKey] }, valid[1]!],
  [valid[0]!, { ...valid[1]!, writerId: 'other-writer' }], [valid[1]!, valid[0]!]]) {
  await assert.rejects(readPublishedConfluenceExecutionV2(h.f.journal,h.f.control,h.binding,h.f.keys,h.objects,wrong));
 }
 const original = h.f.objects.get('state-1')!; h.f.objects.delete('state-1'); await assert.rejects(h.read);
 h.f.objects.set('state-1', original); h.legacy.clear(); await assert.rejects(h.read);
});
test('V2 refuses a signed latest archive omitting decision bookkeeping', async () => {
 const h = await setup();
 h.raw.tables.ConfluenceCopyRecoveryCapture = []; h.raw.tables.ConfluenceCopyPublicationPlan = [];
 h.raw.tables.ConfluenceCopyPublicationReceipt = []; await h.save(); await assert.rejects(h.read);
});
test('V2 refuses changing control and verification deadline', async t => {
 const h = await setup(); const original = h.objects.readConfluenceCopyStateHistory;
 h.objects.readConfluenceCopyStateHistory = async op => { const body = await original(op); h.f.state.current.revision = 'changed'; return body; };
 await assert.rejects(h.read); h.objects.readConfluenceCopyStateHistory = original;
 h.f.state.current.revision = 'current-v2'; let elapsed = 0; t.mock.method(performance,'now',() => elapsed);
 h.objects.readConfluenceCopyStateHistory = async op => { const body = await original(op); elapsed = 120001; return body; };
 await assert.rejects(h.read);
});
function candidate(h: Awaited<ReturnType<typeof setup>>, pending = false) {
 if (!pending) h.f.entries.delete(h.key(4));
 const preparationDigest = h.saved.plain.digest;
 h.f.state.current = { ...h.binding.observedControl,
  activeOperation: { operationId: h.binding.context.operationId, preparationDigest }, revision: 'reserved-v2' };
 const verify = () => verifyConfluenceExecutionV2Candidate(h.f.journal,h.f.control,preparationDigest,h.binding,h.f.keys,h.objects,h.policy);
 return { verify, preparationDigest };
}
test('V2 candidate authenticates prior mixed prefix without counting its pending entry as published', async () => {
 for (const pending of [false,true]) {
  const h = await setup(true), c = candidate(h,pending), before = [...h.f.entries.values()];
  const result = await c.verify(); assert.equal(result.candidatePrefixVerified,true);
  assert.equal(result.candidateEntryPresent,pending); assert.equal(result.candidateHeadPublished,false);
  assert.equal(result.archiveEntriesVerified,1); assert.deepEqual([...h.f.entries.values()],before);
 }
});
test('V2 publication requires reservation, refuses generic bypass and resumes exact lost head acknowledgement', async () => {
 const h = await setup(true), c = candidate(h); let writes = 0, lose = true;
 const control = { readControl: h.f.control.readControl,
  compareAndSwapControl: async (revision: string, next: Omit<typeof h.f.state.current,'revision'>) => {
   if (revision !== h.f.state.current.revision) return false;
   h.f.state.current = { ...next, revision: `published-${++writes}` };
   if (lose) { lose = false; throw new Error('PRIVATE-LOST-HEAD-ACK'); } return true;
  } };
 const { RecoveryAuthorityJournal } = await import('../services/recovery-authority-journal.js');
 const journal = new RecoveryAuthorityJournal({ read: async key => h.f.entries.get(key) ?? null,
  create: async (key, body) => { if (h.f.entries.has(key)) return false; h.f.entries.set(key,body); return true; } },
  { installationId: context.installationId, organisationId: context.organisationId },
  { installationId: context.installationId, organisationId: context.organisationId, generation: 0, digest: null });
 const input = { operationId: h.binding.context.operationId, kind: 'CONFLUENCE_EXECUTION_LEDGER_ARCHIVE_V2' as const,
  factsDigest: h.saved.sealed.digest, expectedGeneration: 3, expectedDigest: h.binding.observedControl.digest };
 await assert.rejects(journal.append(input));
 await assert.rejects(journal.appendPublished(input, { readHead: async () => h.f.state.current,
  compareAndSwap: async () => { throw new Error('Generic path must not write'); } }));
 const publish = () => publishVerifiedConfluenceExecutionV2(journal,control,c.preparationDigest,h.binding,h.f.keys,h.objects,h.policy);
 await assert.rejects(publish); const result = await publish();
 assert.equal(result.headPublished,true); assert.equal(result.replayed,true); assert.equal(writes,1);
 assert.equal(h.f.state.current.activeOperation?.operationId,h.binding.context.operationId);
});

async function nextArchive(h: Awaited<ReturnType<typeof setup>>, change?: (raw: ReturnType<typeof executionLedgerFixture>) => void) {
 const raw = structuredClone(h.raw), binding = { context: { ...h.binding.context, operationId: 'archive-next-v2' },
  observedControl: structuredClone(h.f.state.current) };
 raw.captureOperationId = binding.context.operationId; raw.capturedAt = '2026-10-15T23:00:00.000Z'; change?.(raw);
 const plain = prepareConfluenceExecutionLedgerV2(raw,binding.context), sealed = await sealConfluenceExecutionArchiveV2(plain.body,binding,h.f.keys);
 h.archives.set(binding.context.operationId,sealed.envelope);
 const latest = h.entry(binding.observedControl.generation+1,binding.context.operationId,'CONFLUENCE_EXECUTION_LEDGER_ARCHIVE_V2',sealed.digest,binding.observedControl.digest);
 h.f.state.current = { ...binding.observedControl, generation: latest.generation, digest: latest.digest, revision: 'next-v2-head' };
 return () => readPublishedConfluenceExecutionV2(h.f.journal,h.f.control,binding,h.f.keys,h.objects,h.policy);
}
test('successive V2 archives preserve original claims, requests and outcomes without rewriting or omission', async () => {
 const valid = await setup(true); assert.equal((await (await nextArchive(valid))()).archiveEntriesVerified,3);
 for (const change of [
  (raw: ReturnType<typeof executionLedgerFixture>) => { raw.tables.ConfluenceCopyExecutionOutcome = []; },
  (raw: ReturnType<typeof executionLedgerFixture>) => { raw.tables.ConfluenceCopyExecutionClaim![0]!.reason = 'A changed original claim reason'; },
  (raw: ReturnType<typeof executionLedgerFixture>) => {
   raw.tables.ConfluenceCopyExecutionClaim = []; raw.tables.ConfluenceCopyExecutionRequest = []; raw.tables.ConfluenceCopyExecutionOutcome = [];
  }]) {
  const h = await setup(); await assert.rejects(await nextArchive(h,change));
 }
});
test('V2 refuses a legacy downgrade after execution history and a later non-archive head', async () => {
 const h = await setup();
 const { writerEpoch: _epoch, captureOperationId: _op, ...raw } = structuredClone(h.raw);
 raw.format = 1; raw.kind = 'CONFLUENCE_COPY_LOCAL_LEDGER_V1'; raw.capturedAt = '2026-10-15T22:30:00.000Z';
 for (const name of ['ConfluenceCopyExecutionClaim','ConfluenceCopyExecutionRequest','ConfluenceCopyExecutionOutcome']) delete raw.tables[name];
 const binding = { context: { ...context, operationId: 'downgrade-v1' }, observedControl: structuredClone(h.f.state.current) };
 const sealed = await sealConfluenceCopyLedgerArchive(prepareConfluenceCopyLocalLedger(raw).body,binding,h.f.keys);
 h.legacy.set(binding.context.operationId,sealed.envelope);
 const downgrade = h.entry(5,binding.context.operationId,'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1',sealed.digest,h.f.state.current.digest);
 h.f.state.current = { ...h.f.state.current,generation: 5,digest: downgrade.digest,revision: 'downgraded' };
 await assert.rejects(await nextArchive(h));
 const later = await setup(); const entry = later.entry(5,'later-unrelated','DISPOSAL_RESULT','f'.repeat(64),later.f.state.current.digest);
 later.f.state.current = { ...later.f.state.current,generation: 5,digest: entry.digest,revision: 'unrelated' };
 await assert.rejects(later.read);
});
test('V2 pending suffix or replacement ciphertext cannot be reconciled as the original candidate', async () => {
 const changed = await setup(), c = candidate(changed,true);
 const replaced = await sealConfluenceExecutionArchiveV2(changed.saved.plain.body,changed.binding,changed.f.keys);
 changed.archives.set(changed.binding.context.operationId,replaced.envelope); await assert.rejects(c.verify);
 const extra = await setup(), e = candidate(extra,true);
 extra.entry(5,'extra-pending','DISPOSAL_RESULT','f'.repeat(64),extra.saved.latest.digest); await assert.rejects(e.verify);
 const missing = await setup(), m = candidate(missing); missing.archives.clear(); await assert.rejects(m.verify);
});

test('V2 permits independently approved key rotation within one epoch and refuses duplicate object locators', async () => {
 const rotated = await setup(true,true); assert.equal((await rotated.read()).archiveAtObservedHead,true);
 const duplicate = await setup(true);
 duplicate.objects.readExecutionLedgerV2At = async ctx => duplicate.archives.get(ctx.operationId) ?? null;
 await assert.rejects(duplicate.read);
});

test('mixed-key prefix reads through the actual S3 adapter without weakening legacy current-key readers', async t => {
 const h = await setup(true), rows = new Map(h.f.entries), calls: string[] = [];
 for (const [operation,body] of h.f.objects) rows.set(`confluence-copy-state/${context.installationId}/${context.organisationId}/${operation}.json`,body);
 for (const [operation,body] of h.legacy) rows.set(`confluence-copy-ledger/${context.installationId}/${context.organisationId}/${operation}.json`,body);
 for (const [operation,body] of h.archives) rows.set(`confluence-execution-ledger-v2/${context.installationId}/${context.organisationId}/2/${operation}.json`,body);
 const config = { bucket: 'synthetic-prefix-transport-test',accountId: '123456789012',
  kmsKeyArn: 'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-2222-2222-222222222222',
  replayKeyArn: laterKey,installationId: context.installationId,organisationId: context.organisationId };
 const credentials = { accessKeyId: 'synthetic',secretAccessKey: 'synthetic' }, client = new S3Client({ region: 'eu-west-1',credentials });
 t.mock.method(client,'send',async (command: unknown) => {
  assert.ok(command instanceof GetObjectCommand); assert.equal(command.input.ExpectedBucketOwner,config.accountId);
  const key = command.input.Key!; calls.push(key); const body = rows.get(key);
  if (body === undefined) throw { name: 'NoSuchKey',$metadata: { httpStatusCode: 404 } };
  return { VersionId: 'synthetic-version',ServerSideEncryption: 'aws:kms',SSEKMSKeyId: config.kmsKeyArn,
   ContentLength: Buffer.byteLength(body),Body: Readable.from([Buffer.from(body)]) };
 });
 const objects = new S3AuthorityObjectStore(config,credentials,client);
 const journal = new RecoveryAuthorityJournal(objects,{ installationId: context.installationId,organisationId: context.organisationId },
  { installationId: context.installationId,organisationId: context.organisationId,generation: 0,digest: null });
 assert.equal((await readPublishedConfluenceExecutionV2(journal,h.f.control,h.binding,h.f.keys,objects,h.policy)).archiveAtObservedHead,true);
 assert.ok(calls.some(key => key.endsWith('/1/archive-v2.json'))); assert.ok(calls.some(key => key.endsWith('/2/archive-v2.json')));
 await assert.rejects(objects.readConfluenceCopyState('state-1'));
 await assert.rejects(objects.readConfluenceCopyLedger('archive-legacy'));
 assert.ok((await objects.readConfluenceCopyStateHistory('state-1')));
});

test('V2 candidate uses one policy snapshot rather than accepting keys added during asynchronous reads', async () => {
 const h = await setup(); h.binding.context.keyId = laterKey;
 const sealed = await sealConfluenceExecutionArchiveV2(h.saved.plain.body,h.binding,h.f.keys);
 h.archives.set(h.binding.context.operationId,sealed.envelope);
 const c = candidate(h), original = h.objects.readConfluenceCopyStateHistory;
 h.objects.readConfluenceCopyStateHistory = async operation => {
  h.policy[0]!.keyIds.push(laterKey); return original(operation);
 };
 await assert.rejects(c.verify);
 assert.equal(h.f.entries.size,3);
});
