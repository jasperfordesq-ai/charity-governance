import type { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { readVerifiedConfluenceCopyLedgerArchive,
  type ConfluenceCopyLedgerArchiveBinding, type ConfluenceCopyLedgerObjects } from './confluence-copy-ledger-envelope.js';
import { validateConfluenceCopyLedgerRows } from './confluence-copy-ledger-validation.js';
import { verifyConfluenceCopyLedgerPrefix, verifyConfluenceCopyLedgerCandidate } from './confluence-copy-ledger-prefix.js';
import type { ConfluenceCopyRecoveryObjects } from './confluence-copy-recovery-envelope.js';

type Objects = Pick<ConfluenceCopyLedgerObjects,'readConfluenceCopyLedger'>
  & Partial<Pick<ConfluenceCopyRecoveryObjects,'readConfluenceCopyState'>>;
const noAuthority = { currentHistoryVerified: false as const, reopeningAuthorised: false as const, actionAuthorized: false as const };
function archiveBinding(raw: ConfluenceCopyLedgerArchiveBinding) {
  const context = validateRecoveryEnvelopeContext(raw.context), observedControl = validateRecoveryControl(raw.observedControl);
  if (context.installationId !== observedControl.installationId || context.organisationId !== observedControl.organisationId
    || context.writerEpoch !== observedControl.writerEpoch || observedControl.activeOperation !== null
    || observedControl.generation >= 10000) throw new Error('Confluence ledger archive requires its original unoccupied observed head');
  return { context, observedControl };
}
function sameWriter(current: ReturnType<typeof validateRecoveryControl>, binding: ReturnType<typeof archiveBinding>) {
  return current.installationId === binding.context.installationId && current.organisationId === binding.context.organisationId
    && current.writerId === binding.observedControl.writerId && current.writerEpoch === binding.context.writerEpoch;
}

/** Inactive publication of one previously preserved archive. Caller must retain
 * the exact original body/binding durably before I/O. The declared observed
 * control is a predecessor binding, not proof of a complete payload history.
 * Missing objects are never created here. No slot release or restore follows.
 */
export async function publishVerifiedConfluenceCopyLedger(journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  preparationDigest: string, raw: ConfluenceCopyLedgerArchiveBinding, keys: RecoveryDataKeys, objects: Objects) {
  const binding = archiveBinding(raw), { context, observedControl } = binding;
  const before = validateRecoveryControl(await control.readControl());
  if (!/^[a-f0-9]{64}$/.test(preparationDigest) || !sameWriter(before,binding)
    || before.activeOperation?.operationId !== context.operationId || before.activeOperation.preparationDigest !== preparationDigest
    || before.generation < observedControl.generation || before.generation > observedControl.generation + 1) {
    throw new Error('Confluence ledger publication reservation/head does not match');
  }
  const candidate = await verifyConfluenceCopyLedgerCandidate(journal,control,preparationDigest,binding,keys,objects);
  const after = validateRecoveryControl(await control.readControl());
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Confluence ledger control changed during authentication');
  const receipt = await journal.appendReservedConfluenceCopyLedger({ operationId: context.operationId,
    writerId: observedControl.writerId, writerEpoch: context.writerEpoch, preparationDigest,
    envelopeDigest: candidate.envelopeDigest, expectedGeneration: observedControl.generation, expectedDigest: observedControl.digest },control);
  return { ...receipt, candidatePrefixVerified: true as const, ...noAuthority };
}

/** Authenticates this exact archive only when it is the current journal head,
 * including supported single-key/epoch Confluence payload history and original
 * ledger relationships. Any later entry requires a newer archive/reconciliation.
 * Other protocols, host isolation/custody and restored local state remain
 * outside this reader; no global history or reopening authority is emitted.
 */
export async function readPublishedConfluenceCopyLedger(journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  raw: ConfluenceCopyLedgerArchiveBinding, keys: RecoveryDataKeys, objects: Objects) {
  const binding = archiveBinding(raw), { context, observedControl } = binding;
  const before = validateRecoveryControl(await control.readControl());
  if (!sameWriter(before,binding) || before.generation !== observedControl.generation + 1) {
    throw new Error('Confluence ledger archive is not at the current writer/head');
  }
  const source = { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
  const published = await journal.readPublishedEntry(context.operationId,'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1',source);
  if (published.revision !== before.revision || published.entry.generation !== before.generation
    || published.entry.digest !== before.digest || published.entry.previousDigest !== observedControl.digest) {
    throw new Error('Confluence ledger archive does not match the latest exact head/predecessor');
  }
  const opened = await readVerifiedConfluenceCopyLedgerArchive(published.entry.factsDigest,binding,keys,objects);
  validateConfluenceCopyLedgerRows(opened.body,context);
  const prefix = await verifyConfluenceCopyLedgerPrefix(journal,control,context,opened.body,keys,objects);
  const finalHistory = await journal.inspectCurrent(source);
  const after = validateRecoveryControl(await control.readControl());
  if (finalHistory.revision !== published.revision || JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('Confluence ledger current head/control changed while authenticating archive');
  }
  return { body: opened.body, archiveAtObservedHead: true as const, ledgerRowsVerified: true as const, entryGeneration: published.entry.generation,
    entryDigest: published.entry.digest, envelopeDigest: published.entry.factsDigest, revision: published.revision, ...prefix, ...noAuthority };
}
