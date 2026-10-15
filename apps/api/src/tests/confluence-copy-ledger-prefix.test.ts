import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { fixture as decisionHistory } from './fixtures/confluence-copy-decision-history.js';
import { ledgerFixture } from './fixtures/confluence-copy-ledger.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';
import { prepareConfluenceCopyLocalLedger } from '../services/confluence-copy-ledger-snapshot.js';
import { sealConfluenceCopyLedgerArchive } from '../services/confluence-copy-ledger-envelope.js';
import { readPublishedConfluenceCopyLedger } from '../services/published-confluence-copy-ledger.js';
import { verifyConfluenceCopyLedgerPrefix, verifyConfluenceCopyLedgerCandidate } from '../services/confluence-copy-ledger-prefix.js';
import { publishVerifiedConfluenceCopyLedger } from '../services/published-confluence-copy-ledger.js';

const hash = (body: string) => createHash('sha256').update(body).digest('hex');
async function setup(earlierArchive = false, changeLatest?: (raw: ReturnType<typeof ledgerFixture>['raw']) => void,
  changeEarlier?: (raw: ReturnType<typeof ledgerFixture>['raw']) => void) {
  const f = await decisionHistory(), ledger = ledgerFixture();
  const rows = () => [...f.entries.values()].map(body => JSON.parse(body));
  const firstEntry = rows()[0]!, secondEntry = rows()[1]!;
  const firstReceipt = ledger.raw.tables.ConfluenceCopyPublicationReceipt![0]!;
  Object.assign(firstReceipt,{ envelopeDigest: firstEntry.factsDigest, entryDigest: firstEntry.digest });
  const archives = new Map<string,string>();
  const key = (generation: number) => `authority/${context.installationId}/${context.organisationId}/${String(generation).padStart(10,'0')}.json`;
  function entry(generation: number, operationId: string, kind: string, factsDigest: string, previousDigest: string) {
    const unsigned = { format: 1, installationId: context.installationId, organisationId: context.organisationId,
      generation, previousDigest, operationId, kind, factsDigest };
    return { ...unsigned, digest: hash(JSON.stringify(unsigned)) };
  }
  if (earlierArchive) {
    const old = structuredClone(ledger.raw);
    old.capturedAt = '2026-10-15T18:05:03.000Z';
    old.tables.ConfluenceRetainedCopyReviewWithdrawal = []; old.tables.ConfluenceRetainedCopyPermissionWithdrawal = [];
    old.tables.ConfluenceCopyRecoveryCapture!.pop();
    changeEarlier?.(old);
    const oldContext = { ...context, operationId: 'archive-earlier' };
    const oldBinding = { context: oldContext, observedControl: { ...f.state.current, generation: 1, digest: firstEntry.digest } };
    const encrypted = await sealConfluenceCopyLedgerArchive(prepareConfluenceCopyLocalLedger(old).body,oldBinding,f.keys);
    archives.set(oldContext.operationId,encrypted.envelope);
    const oldEntry = entry(2,oldContext.operationId,'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1',encrypted.digest,firstEntry.digest);
    f.entries.set(key(2),JSON.stringify(oldEntry));
    const shifted = entry(3,secondEntry.operationId,secondEntry.kind,secondEntry.factsDigest,oldEntry.digest);
    f.entries.set(key(3),JSON.stringify(shifted));
    Object.assign(secondEntry,shifted);
    Object.assign(f.state.current,{ generation: 3, digest: shifted.digest });
  }
  ledger.raw.tables.ConfluenceCopyPublicationPlan!.push({ ...ledger.raw.tables.ConfluenceCopyPublicationPlan![0]!,
    id: 'plan-2', captureId: 'capture-2', expectedGeneration: secondEntry.generation - 1,
    expectedDigest: secondEntry.previousDigest, recordedAt: '2026-10-15T18:07:01.000Z' });
  ledger.raw.tables.ConfluenceCopyPublicationReceipt!.push({ ...firstReceipt, id: 'receipt-2', planId: 'plan-2',
    entryGeneration: secondEntry.generation, entryDigest: secondEntry.digest, envelopeDigest: secondEntry.factsDigest,
    recordedAt: '2026-10-15T18:07:02.000Z' });
  changeLatest?.(ledger.raw);
  const binding = { context: { ...context, operationId: 'archive-latest' }, observedControl: structuredClone(f.state.current) };
  const encrypted = await sealConfluenceCopyLedgerArchive(ledger.body(),binding,f.keys);
  archives.set(binding.context.operationId,encrypted.envelope);
  const latest = entry(f.state.current.generation + 1,binding.context.operationId,'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1',encrypted.digest,f.state.current.digest!);
  f.entries.set(key(latest.generation),JSON.stringify(latest));
  Object.assign(f.state.current,{ generation: latest.generation, digest: latest.digest, revision: 'synthetic-current-archive' });
  const objects = { readConfluenceCopyState: async (operation: string) => f.objects.get(operation) ?? null,
    readConfluenceCopyLedger: async (operation: string) => archives.get(operation) ?? null };
  const read = () => readPublishedConfluenceCopyLedger(f.journal,f.control,binding,f.keys,objects);
  const prefix = () => verifyConfluenceCopyLedgerPrefix(f.journal,f.control,binding.context,ledger.body(),f.keys,objects);
  return { f, ledger, archives, binding, objects, read, prefix };
}

test('current archive verifies both published decision payloads and exact original capture/plan/receipt links', async () => {
  const f = await setup(); const result = await f.prefix();
  assert.equal(result.archivePrefixVerified,true); assert.equal(result.decisionEntriesVerified,2);
  assert.equal(result.archiveEntriesVerified,1); assert.equal(result.currentHistoryVerified,false);
  assert.equal((await f.read()).archivePrefixVerified,true);
});

test('multiple archives preserve every immutable earlier row while allowing later withdrawals', async () => {
  const f = await setup(true), result = await f.read();
  assert.equal(result.archivePrefixVerified,true); assert.equal(result.archiveEntriesVerified,2);
});

test('signed current archive that drops all publication bookkeeping is refused against actual prefix', async () => {
  const f = await setup(false,raw => {
    raw.tables.ConfluenceCopyRecoveryCapture = []; raw.tables.ConfluenceCopyPublicationPlan = []; raw.tables.ConfluenceCopyPublicationReceipt = [];
  });
  await assert.rejects(f.read,/prefix/);
});

test('receipt digest contradictions and prior-archive immutable metadata rewrites refuse', async () => {
  const badReceipt = await setup(false,raw => { raw.tables.ConfluenceCopyPublicationReceipt![0]!.envelopeDigest = 'f'.repeat(64); });
  await assert.rejects(badReceipt.read,/prefix/);
  const rewritten = await setup(true,undefined,raw => { raw.tables.ConfluenceCopyPublicationPlan![0]!.keyEvidenceRef = 'EARLIER-KEY-EVIDENCE'; });
  await assert.rejects(rewritten.read,/prefix/);
});

test('missing earlier decision or archive bytes cannot be replaced by the complete latest archive', async () => {
  const missingDecision = await setup(); missingDecision.f.objects.delete('state-1'); await assert.rejects(missingDecision.read,/prefix/);
  const missingArchive = await setup(true); missingArchive.archives.delete('archive-earlier'); await assert.rejects(missingArchive.read,/prefix/);
});

test('absent decision-store support and a changing control refuse without partial proof', async () => {
  const f = await setup();
  await assert.rejects(readPublishedConfluenceCopyLedger(f.f.journal,f.f.control,f.binding,f.f.keys,
    { readConfluenceCopyLedger: f.objects.readConfluenceCopyLedger }),/prefix/);
  const original = f.objects.readConfluenceCopyState;
  f.objects.readConfluenceCopyState = async operation => {
    const body = await original(operation); f.f.state.current.revision = 'changed-during-prefix'; return body;
  };
  await assert.rejects(f.read,/prefix|changed/);
});

test('monotonic processing budget refuses partial proof even without wall-clock advance', async t => {
  const f = await setup(); let elapsed = 0;
  t.mock.method(performance,'now',() => elapsed);
  const original = f.objects.readConfluenceCopyState;
  f.objects.readConfluenceCopyState = async operation => { const body = await original(operation); elapsed = 120001; return body; };
  await assert.rejects(f.prefix,/prefix/);
});

function candidate(f: Awaited<ReturnType<typeof setup>>, pending = false) {
  const generation = f.f.state.current.generation;
  const key = `authority/${context.installationId}/${context.organisationId}/${String(generation).padStart(10,'0')}.json`;
  const entry = f.f.entries.get(key)!;
  if (!pending) f.f.entries.delete(key);
  const preparationDigest = hash(f.ledger.body());
  f.f.state.current = { ...f.binding.observedControl,
    activeOperation: { operationId: f.binding.context.operationId, preparationDigest }, revision: 'candidate-reservation' };
  return { entry, key, verify: () => verifyConfluenceCopyLedgerCandidate(f.f.journal,f.f.control,preparationDigest,f.binding,f.f.keys,f.objects),
    publish: () => publishVerifiedConfluenceCopyLedger(f.f.journal,f.f.control,preparationDigest,f.binding,f.f.keys,f.objects) };
}

test('candidate validates all prior payloads before any archive entry exists', async () => {
  const f = await setup(true), c = candidate(f), before = [...f.f.entries.values()];
  const result = await c.verify();
  assert.equal(result.candidatePrefixVerified,true); assert.equal(result.candidateEntryPresent,false);
  assert.deepEqual([...f.f.entries.values()],before); assert.equal(result.currentHistoryVerified,false);
});

test('candidate with dropped original bookkeeping refuses before any journal append', async () => {
  const f = await setup(false,raw => {
    raw.tables.ConfluenceCopyRecoveryCapture = []; raw.tables.ConfluenceCopyPublicationPlan = []; raw.tables.ConfluenceCopyPublicationReceipt = [];
  });
  const c = candidate(f), before = [...f.f.entries.values()];
  await assert.rejects(c.publish,/candidate|prefix/); assert.deepEqual([...f.f.entries.values()],before);
});

test('exact pending entry is reverified without treating it as a published archive', async () => {
  const f = await setup(true), c = candidate(f,true), before = [...f.f.entries.values()];
  const result = await c.verify(); assert.equal(result.candidateEntryPresent,true);
  assert.equal(result.candidateHeadPublished,false); assert.deepEqual([...f.f.entries.values()],before);
});

test('pending different operation or replaced original ciphertext refuses without metadata rewrite', async () => {
  const f = await setup(), c = candidate(f,true);
  const original = c.entry;
  const changed = JSON.parse(original); delete changed.digest; changed.operationId = 'other-operation';
  f.f.entries.set(c.key,JSON.stringify({ ...changed, digest: hash(JSON.stringify(changed)) }));
  await assert.rejects(c.verify,/candidate|prefix|identity|pending/);
  f.f.entries.set(c.key,original);
  const replacement = await sealConfluenceCopyLedgerArchive(f.ledger.body(),f.binding,f.f.keys);
  f.archives.set(f.binding.context.operationId,replacement.envelope);
  await assert.rejects(c.verify,/candidate|prefix|identity|facts/);
  assert.equal(f.f.entries.get(c.key),original);
});

test('a second pending entry beyond the exact archive stops candidate reconciliation', async () => {
  const f = await setup(true), c = candidate(f,true), pending = JSON.parse(c.entry);
  const unsigned = { ...pending, generation: pending.generation + 1, previousDigest: pending.digest,
    operationId: 'extra-pending-operation', kind: 'DISPOSAL_RESULT', factsDigest: 'f'.repeat(64) };
  delete unsigned.digest;
  const key = `authority/${context.installationId}/${context.organisationId}/${String(unsigned.generation).padStart(10,'0')}.json`;
  f.f.entries.set(key,JSON.stringify({ ...unsigned, digest: hash(JSON.stringify(unsigned)) }));
  const before = [...f.f.entries.values()];
  await assert.rejects(c.verify,/candidate|prefix/); assert.deepEqual([...f.f.entries.values()],before);
});

test('already head-published original candidate still rechecks predecessor payloads under its occupied slot', async () => {
  const f = await setup(true), digest = hash(f.ledger.body()), before = [...f.f.entries.values()];
  // Synthetic occupied-slot setup for a lost head acknowledgement; no release.
  f.f.state.current.activeOperation = { operationId: f.binding.context.operationId, preparationDigest: digest };
  const result = await verifyConfluenceCopyLedgerCandidate(f.f.journal,f.f.control,digest,f.binding,f.f.keys,f.objects);
  assert.equal(result.candidateHeadPublished,true); assert.equal(result.candidateEntryPresent,true);
  assert.deepEqual([...f.f.entries.values()],before); assert.equal(result.actionAuthorized,false);
});
