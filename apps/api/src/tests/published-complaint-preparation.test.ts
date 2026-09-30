import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecoveryAuthorityJournal, type AuthorityCheckpoint } from '../services/recovery-authority-journal.js';
import { preserveRecoveryPreparation, type RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';
import { readPublishedComplaintPreparation } from '../services/published-complaint-preparation.js';
import { prepareComplaintRecoveryFacts } from '../services/complaint-recovery-preparation.js';
import { complaintPreparationFixture } from './complaint-preparation-fixture.js';

test('published complaint preparation joins independently verified history to exact encrypted evidence', async () => {
  const binding = { installationId: 'install', organisationId: 'charity' };
  const context = { ...binding, operationId: 'operation', writerEpoch: 1, sourceRevision: 'a'.repeat(40),
    keyId: 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
  const initial = { ...binding, generation: 0, digest: null };
  const rows = new Map<string, string>();
  const journal = new RecoveryAuthorityJournal({
    async read(key) { return rows.get(key) ?? null; },
    async create(key, body) { if (rows.has(key)) return false; rows.set(key, body); return true; },
  }, binding, initial);
  let head = { ...initial, digest: null as string | null, revision: 'version-0' };
  let version = 0, advanceDuringOpen = false;
  const publisher = {
    async readHead() { return { ...head }; },
    async compareAndSwap(revision: string, next: AuthorityCheckpoint) {
      if (head.revision !== revision) return false;
      head = { ...next, revision: `version-${++version}` }; return true;
    },
  };
  const keys: RecoveryDataKeys = {
    async generate() { return { key: Buffer.alloc(32, 7), keyId: context.keyId, wrappedKey: Buffer.from('synthetic').toString('base64') }; },
    async unwrap() {
      if (advanceDuringOpen) head = { ...head, revision: `version-${++version}` };
      return { key: Buffer.alloc(32, 7), keyId: context.keyId };
    },
  };
  let envelope: string | null = null;
  const store = {
    async readReplay() { return envelope; },
    async createReplay(_operation: string, value: string) { if (envelope !== null) return false; envelope = value; return true; },
  };
  const body = prepareComplaintRecoveryFacts(complaintPreparationFixture()).body;
  const candidate = await preserveRecoveryPreparation(body, context, keys, store);
  const read = () => readPublishedComplaintPreparation(journal, publisher, context, keys, store);
  await assert.rejects(read, /not published/);
  await journal.appendPublished({ operationId: context.operationId, kind: 'COMPLAINT_PREPARATION_V1',
    factsDigest: candidate.digest, expectedGeneration: 0, expectedDigest: null }, publisher);
  const verified = await read();
  assert.equal(verified.body, body); assert.equal(verified.envelopeDigest, candidate.digest);
  assert.equal(verified.actionAuthorized, false);
  advanceDuringOpen = true;
  await assert.rejects(read, /changed while reading/);
  advanceDuringOpen = false;
  envelope = null;
  await assert.rejects(read, /unresolved/);
  assert.equal(envelope, null);
});
