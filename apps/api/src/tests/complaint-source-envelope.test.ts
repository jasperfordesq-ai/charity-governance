import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { prepareComplaintSourceFact } from '../services/complaint-source-fact.js';
import { openComplaintSourceFact, sealComplaintSourceFact } from '../services/complaint-source-envelope.js';
import type { RecoveryDataKeys } from '../services/recovery-preparation-envelope.js';

const keyId = 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111';
function fixture() {
  const context = { installationId: 'install', organisationId: 'charity', operationId: 'snapshot-1',
    writerEpoch: 1, sourceRevision: 'a'.repeat(40), keyId };
  const body = prepareComplaintSourceFact({ format: 1, kind: 'COMPLAINT_SOURCE_FACT',
    installationId: context.installationId, organisationId: context.organisationId,
    operationId: context.operationId, writerEpoch: context.writerEpoch,
    sourceRevision: context.sourceRevision, mode: 'BASELINE', previousRecordRevision: null,
    recordedAt: '2026-10-09T02:00:00.000Z', record: {
      id: 'case-1', organisationId: 'charity', receivedDate: '2026-10-01T00:00:00.000Z',
      source: 'Synthetic form', summary: 'Synthetic private complaint narrative',
      actionTaken: null, outcome: null, status: 'OPEN', reviewedByBoard: false,
      boardMinuteReference: null, revision: 3, removedAt: null, removalId: null,
      createdAt: '2026-10-09T01:00:00.000Z', updatedAt: '2026-10-09T01:00:00.000Z',
    } }).body;
  const retained = new Map<string, Buffer>(); const delivered: Buffer[] = [];
  const keys: RecoveryDataKeys = {
    async generate() { const key = randomBytes(32), wrappedKey = randomBytes(48).toString('base64');
      retained.set(wrappedKey, Buffer.from(key)); delivered.push(key); return { key, keyId, wrappedKey }; },
    async unwrap(wrappedKey) { const key = Buffer.from(retained.get(wrappedKey)!);
      delivered.push(key); return { key, keyId }; },
  };
  return { context, body, keys, delivered };
}

test('synthetic complaint source envelope hides narrative and binds exact context', async () => {
  const f = fixture();
  const sealed = await sealComplaintSourceFact(f.body, f.context, f.keys);
  assert.equal(sealed.bindingAuthorized, false);
  assert.ok(!sealed.envelope.includes('Synthetic private complaint narrative'));
  assert.equal((await openComplaintSourceFact(sealed.envelope, f.context, f.keys)).body, f.body);
  assert.ok(f.delivered.every(key => key.every(byte => byte === 0)));
  await assert.rejects(() => openComplaintSourceFact(sealed.envelope,
    { ...f.context, organisationId: 'other' }, f.keys), /could not be decrypted/);
  const altered = JSON.parse(sealed.envelope);
  altered.sealed.ciphertext = 'AAAA' + altered.sealed.ciphertext.slice(4);
  await assert.rejects(() => openComplaintSourceFact(JSON.stringify(altered), f.context, f.keys), /could not be decrypted/);
});
