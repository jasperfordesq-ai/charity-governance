import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecoveryAuthorityJournal } from '../services/recovery-authority-journal.js';
import { reserveRecoveryOperation, type RecoveryControlStore, type RecoveryControlValue } from '../services/recovery-operation-reservation.js';

const binding = { installationId: 'install', organisationId: 'charity' };
const initial = { ...binding, generation: 0, digest: null };
const reservation = { ...binding, writerId: 'host-a', writerEpoch: 1, operationId: 'operation',
  preparationDigest: 'a'.repeat(64), expectedGeneration: 0, expectedDigest: null };
const publication = { operationId: reservation.operationId, writerId: reservation.writerId,
  writerEpoch: reservation.writerEpoch, preparationDigest: reservation.preparationDigest,
  envelopeDigest: 'b'.repeat(64), expectedGeneration: 0, expectedDigest: null };
function fixture() {
  const rows = new Map<string, string>(); let version = 0, loseAck = false;
  let control: RecoveryControlValue & { revision: string } = { format: 2, ...initial,
    writerId: 'host-a', writerEpoch: 1, activeOperation: null, revision: 'version-0' };
  const store: RecoveryControlStore = {
    async readControl() { return structuredClone(control); },
    async compareAndSwapControl(revision, next) {
      if (revision !== control.revision) return false;
      control = { ...structuredClone(next), revision: `version-${++version}` };
      if (loseAck) { loseAck = false; throw new Error('lost acknowledgement'); }
      return true;
    },
  };
  const journal = new RecoveryAuthorityJournal({ async read(key) { return rows.get(key) ?? null; },
    async create(key, body) { if (rows.has(key)) return false; rows.set(key, body); return true; },
  }, binding, initial);
  return { journal, store, rows, current: () => control, loseAck: () => { loseAck = true; } };
}

test('complaint publication requires the same reservation and keeps it occupied after journal publication', async () => {
  const f = fixture();
  await assert.rejects(() => f.journal.appendReservedComplaintPreparation(publication, f.store), /reservation/);
  assert.equal(f.rows.size, 0);
  await reserveRecoveryOperation(reservation, f.store);
  const receipt = await f.journal.appendReservedComplaintPreparation(publication, f.store);
  assert.equal(receipt.actionAuthorized, false); assert.equal(receipt.headPublished, true);
  assert.equal(f.current().generation, 1);
  assert.equal(f.current().activeOperation?.preparationDigest, reservation.preparationDigest);
  const entry = JSON.parse([...f.rows.values()][0]!);
  assert.equal(entry.kind, 'COMPLAINT_PREPARATION_V1');
  assert.equal(entry.factsDigest, publication.envelopeDigest);
  assert.equal((await f.journal.appendReservedComplaintPreparation(publication, f.store)).replayed, true);
  await assert.rejects(() => reserveRecoveryOperation({ ...reservation, operationId: 'other',
    expectedGeneration: 1, expectedDigest: receipt.digest }, f.store), /occupied/);
});

test('unknown control publication resumes exact journal bytes and refuses changed payload or stale writer', async () => {
  const f = fixture(); await reserveRecoveryOperation(reservation, f.store); f.loseAck();
  await assert.rejects(() => f.journal.appendReservedComplaintPreparation(publication, f.store), /unknown/);
  const original = [...f.rows.values()];
  assert.equal((await f.journal.appendReservedComplaintPreparation(publication, f.store)).replayed, true);
  assert.deepEqual([...f.rows.values()], original);
  await assert.rejects(() => f.journal.appendReservedComplaintPreparation({ ...publication,
    envelopeDigest: 'c'.repeat(64) }, f.store), /different facts/);
  for (const altered of [{ ...publication, writerId: 'old-host' }, { ...publication, writerEpoch: 2 },
    { ...publication, preparationDigest: 'd'.repeat(64) }, { ...publication, operationId: 'different' }]) {
    await assert.rejects(() => f.journal.appendReservedComplaintPreparation(altered, f.store), /reservation/);
  }
  assert.deepEqual([...f.rows.values()], original);
});
