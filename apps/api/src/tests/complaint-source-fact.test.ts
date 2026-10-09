import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareComplaintSourceFact } from '../services/complaint-source-fact.js';

function fixture() {
  return { format: 1, kind: 'COMPLAINT_SOURCE_FACT', installationId: 'install',
    organisationId: 'charity', operationId: 'create-1', writerEpoch: 1,
    sourceRevision: 'a'.repeat(40), mode: 'CREATE', previousRecordRevision: null,
    recordedAt: '2026-10-09T02:00:00.000Z', record: {
      id: 'case-1', organisationId: 'charity', receivedDate: '2026-10-01T00:00:00.000Z',
      source: 'Synthetic form', summary: 'Synthetic private complaint narrative',
      actionTaken: null, outcome: null, status: 'OPEN', reviewedByBoard: false,
      boardMinuteReference: null, revision: 1, removedAt: null, removalId: null,
      createdAt: '2026-10-09T01:00:00.000Z', updatedAt: '2026-10-09T01:00:00.000Z',
    } };
}

test('complaint source fact captures exact versioned case fields without authorizing binding', () => {
  const value = fixture();
  const first = prepareComplaintSourceFact(value);
  assert.equal(first.bindingAuthorized, false);
  assert.ok(first.body.includes('Synthetic private complaint narrative'));
  assert.equal(prepareComplaintSourceFact(JSON.parse(first.body)).digest, first.digest);
  assert.notEqual(prepareComplaintSourceFact({ ...value,
    record: { ...value.record, summary: 'Corrected synthetic narrative' } }).digest, first.digest);
  const correction = prepareComplaintSourceFact({ ...value, operationId: 'update-2',
    mode: 'UPDATE', previousRecordRevision: 1,
    record: { ...value.record, revision: 2, summary: 'Corrected synthetic narrative' } });
  assert.equal(JSON.parse(correction.body).record.revision, 2);
});

test('complaint source fact refuses foreign, skipped, malformed and extra fields', () => {
  const value = fixture();
  for (const bad of [
    { ...value, record: { ...value.record, organisationId: 'other' } },
    { ...value, mode: 'UPDATE', previousRecordRevision: 1, record: { ...value.record, revision: 3 } },
    { ...value, record: { ...value.record, removedAt: value.record.updatedAt } },
    { ...value, record: { ...value.record, updatedAt: '2026-10-08T01:00:00.000Z' } },
    { ...value, extra: 'plaintext' },
    { ...value, record: { ...value.record, summary: 'x'.repeat(3001) } },
  ]) assert.throws(() => prepareComplaintSourceFact(bad), /Invalid complaint source fact/);
});
