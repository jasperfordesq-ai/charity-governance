import { RecoveryAuthorityJournal } from '../../services/recovery-authority-journal.js';
import { reserveRecoveryOperation, type RecoveryControlValue } from '../../services/recovery-operation-reservation.js';
import { prepareConfluenceCopyLocalLedger, CONFLUENCE_COPY_LEDGER_TABLES } from '../../services/confluence-copy-ledger-snapshot.js';
import { sealConfluenceCopyLedgerArchive } from '../../services/confluence-copy-ledger-envelope.js';
import { publishVerifiedConfluenceCopyLedger, readPublishedConfluenceCopyLedger } from '../../services/published-confluence-copy-ledger.js';
import { recoveryContextFixture as context } from './confluence-copy-recovery-facts.js';
import type { RecoveryDataKeys } from '../../services/recovery-preparation-envelope.js';

export async function publishedLedgerFixture() {
  const identity = { installationId: context.installationId, organisationId: context.organisationId };
  const initial = { format: 2 as const, ...identity, writerId: 'writer-a', writerEpoch: context.writerEpoch,
    generation: 0, digest: null, activeOperation: null, revision: 'revision-0' };
  const state = { current: structuredClone(initial) as RecoveryControlValue & { revision: string },
    version: 0, loseEntryAck: false, loseHeadAck: false, mutateWhileOpen: false };
  const control = { readControl: async () => structuredClone(state.current),
    compareAndSwapControl: async (revision: string,next: RecoveryControlValue) => {
      if (state.current.revision !== revision) return false;
      state.current = { ...next, revision: `revision-${++state.version}` };
      if (state.loseHeadAck) { state.loseHeadAck = false; throw new Error('Synthetic lost head acknowledgement'); }
      return true;
    } };
  const prepared = prepareConfluenceCopyLocalLedger({ format: 1, kind: 'CONFLUENCE_COPY_LOCAL_LEDGER_V1', ...identity,
    actorUserId: 'owner-a', declaredSourceRevision: context.sourceRevision, capturedAt: '2026-10-15T22:00:00.000Z',
    tables: Object.fromEntries(CONFLUENCE_COPY_LEDGER_TABLES.map(name => [name,[]])) });
  const binding = { context, observedControl: structuredClone(initial) };
  const keys: RecoveryDataKeys = { generate: async () => ({ key: Buffer.alloc(32,17), keyId: context.keyId, wrappedKey: 'dGVzdA==' }),
    unwrap: async () => {
      if (state.mutateWhileOpen) state.current.revision = 'changed-while-opening';
      return { key: Buffer.alloc(32,17), keyId: context.keyId };
    } };
  const original = await sealConfluenceCopyLedgerArchive(prepared.body,binding,keys);
  let envelope: string | null = original.envelope;
  const objects = { readConfluenceCopyLedger: async () => envelope };
  const rows = new Map<string,string>();
  const journal = new RecoveryAuthorityJournal({ read: async key => rows.get(key) ?? null,
    create: async (key,body) => {
      if (rows.has(key)) return false;
      rows.set(key,body);
      if (state.loseEntryAck) { state.loseEntryAck = false; throw new Error('Synthetic lost entry acknowledgement'); }
      return true;
    } },identity,{ ...identity, generation: 0, digest: null });
  const reserve = () => reserveRecoveryOperation({ ...identity, operationId: context.operationId, writerId: 'writer-a',
    writerEpoch: context.writerEpoch, preparationDigest: prepared.digest, expectedGeneration: 0, expectedDigest: null },control);
  const publish = () => publishVerifiedConfluenceCopyLedger(journal,control,prepared.digest,binding,keys,objects);
  const read = () => readPublishedConfluenceCopyLedger(journal,control,binding,keys,objects);
  return { state, prepared, binding, original, keys, rows, journal, control, reserve, publish, read, objects,
    replace: (body: string | null) => { envelope = body; } };
}
