import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RecoveryAuthorityJournal, validateRecoveryAuthorityEntry } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { inspectConfluenceCopyLedgerEnvelope, readVerifiedConfluenceCopyLedgerArchive,
  type ConfluenceCopyLedgerObjects } from './confluence-copy-ledger-envelope.js';
import { inspectConfluenceCopyRecoveryEnvelope, readVerifiedConfluenceCopyRecoveryFacts,
  type ConfluenceCopyRecoveryObjects } from './confluence-copy-recovery-envelope.js';
import { assertConfluenceCopyRecoveryProgression, type ConfluenceCopyRecoveryFacts } from './confluence-copy-recovery-facts.js';
import { validateConfluenceCopyLedgerRows } from './confluence-copy-ledger-validation.js';

type Objects = Pick<ConfluenceCopyLedgerObjects,'readConfluenceCopyLedger'>
  & Partial<Pick<ConfluenceCopyRecoveryObjects,'readConfluenceCopyState'>>;
type Entry = ReturnType<typeof validateRecoveryAuthorityEntry>;
type Tables = ReturnType<typeof validateConfluenceCopyLedgerRows>['ledger']['tables'];
type Published = { entry: Entry; plainDigest: string; keyId: string; sourceRevision: string };
const hash = (value: string) => createHash('sha256').update(value,'utf8').digest('hex');
function index(rows: Tables[string], field: string) {
  return new Map(rows.map(row => { if (typeof row[field] !== 'string') throw new Error(); return [row[field],row] as const; }));
}
function matchPublished(tables: Tables, published: Map<number,Published>, writerId: string) {
  const captures = index(tables.ConfluenceCopyRecoveryCapture!,'operationId');
  const captureIds = index(tables.ConfluenceCopyRecoveryCapture!,'id');
  const plans = index(tables.ConfluenceCopyPublicationPlan!,'captureId');
  const planIds = index(tables.ConfluenceCopyPublicationPlan!,'id');
  const receipts = index(tables.ConfluenceCopyPublicationReceipt!,'planId');
  for (const { entry, plainDigest, keyId, sourceRevision } of published.values()) {
    const capture = captures.get(entry.operationId), plan = capture ? plans.get(capture.id) : undefined;
    const receipt = plan ? receipts.get(plan.id) : undefined;
    if (!capture || !plan || !receipt || capture.factsDigest !== plainDigest || capture.sourceRevision !== sourceRevision
      || plan.keyId !== keyId || plan.writerId !== writerId || plan.expectedGeneration !== entry.generation - 1
      || plan.expectedDigest !== entry.previousDigest || receipt.entryGeneration !== entry.generation
      || receipt.entryDigest !== entry.digest || receipt.envelopeDigest !== entry.factsDigest) throw new Error();
  }
  // Locally recorded observations must themselves refer to an authenticated
  // earlier decision publication, not a future/missing/other-kind entry.
  for (const receipt of tables.ConfluenceCopyPublicationReceipt!) {
    if (typeof receipt.entryGeneration !== 'number' || !published.has(receipt.entryGeneration)) throw new Error();
    const plan = typeof receipt.planId === 'string' ? planIds.get(receipt.planId) : undefined;
    const capture = plan && typeof plan.captureId === 'string' ? captureIds.get(plan.captureId) : undefined;
    if (capture?.operationId !== published.get(receipt.entryGeneration)!.entry.operationId) throw new Error();
  }
}

/** Full supported Confluence metadata/payload prefix only. Same approved key
 * and epoch are required; all other journal protocols refuse. This is neither
 * a global all-writer history attestation nor SQL restore/execution authority.
 */
export async function verifyConfluenceCopyLedgerPrefix(journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  rawContext: RecoveryEnvelopeContext, expectedBody: string, keys: RecoveryDataKeys, objects: Objects) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext), before = validateRecoveryControl(await control.readControl());
    if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
      || before.writerEpoch !== context.writerEpoch) throw new Error();
    const source = { async readHead() {
      const value = validateRecoveryControl(await control.readControl());
      return { installationId: value.installationId, organisationId: value.organisationId,
        generation: value.generation, digest: value.digest, revision: value.revision };
    } };
    const history = await journal.readPublishedHistory(source), startedAt = performance.now();
    if (history.revision !== before.revision || history.entries.at(-1)?.operationId !== context.operationId
      || history.entries.at(-1)?.kind !== 'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1') throw new Error();
    let envelopeBytes = 0, retainedDecisionBytes = 0, archiveCount = 0;
    const published = new Map<number,Published>(), latest = new Map<string,string>();
    let priorArchiveRows = new Map<string,string>(), priorArchiveTime = '';
    for (const entry of history.entries) {
      if (performance.now() - startedAt > 120000) throw new Error();
      if (entry.kind !== 'CONFLUENCE_COPY_DECISION_STATE_V1' && entry.kind !== 'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1') throw new Error();
      const envelope = entry.kind === 'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1'
        ? await objects.readConfluenceCopyLedger(entry.operationId)
        : objects.readConfluenceCopyState ? await objects.readConfluenceCopyState(entry.operationId) : null;
      if (envelope === null) throw new Error();
      envelopeBytes += Buffer.byteLength(envelope,'utf8');
      if (envelopeBytes > 512 * 1024 * 1024 || hash(envelope) !== entry.factsDigest) throw new Error();
      const archive = entry.kind === 'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1' ? inspectConfluenceCopyLedgerEnvelope(envelope) : null;
      const current = archive?.context ?? inspectConfluenceCopyRecoveryEnvelope(envelope);
      if (current.installationId !== context.installationId || current.organisationId !== context.organisationId
        || current.operationId !== entry.operationId || current.writerEpoch !== context.writerEpoch || current.keyId !== context.keyId) throw new Error();
      if (archive) {
        if (archive.observedControl.activeOperation !== null || archive.observedControl.writerId !== before.writerId
          || archive.observedControl.generation !== entry.generation - 1 || archive.observedControl.digest !== entry.previousDigest) throw new Error();
        const opened = await readVerifiedConfluenceCopyLedgerArchive(entry.factsDigest,archive,keys,
          { readConfluenceCopyLedger: async () => envelope });
        const checked = validateConfluenceCopyLedgerRows(opened.body,current);
        if (checked.ledger.capturedAt < priorArchiveTime) throw new Error();
        const rowHashes = new Map<string,string>();
        for (const [name,rows] of Object.entries(checked.ledger.tables)) for (const row of rows) rowHashes.set(`${name}:${row.id}`,hash(JSON.stringify(row)));
        for (const [id,digest] of priorArchiveRows) if (rowHashes.get(id) !== digest) throw new Error();
        matchPublished(checked.ledger.tables,published,before.writerId);
        if (entry.generation === before.generation && (opened.body !== expectedBody || entry.digest !== before.digest)) throw new Error();
        priorArchiveRows = rowHashes; priorArchiveTime = checked.ledger.capturedAt; archiveCount++;
      } else {
        const opened = await readVerifiedConfluenceCopyRecoveryFacts(entry.factsDigest,current,keys,
          { readConfluenceCopyState: async () => envelope });
        const facts = JSON.parse(opened.body) as ConfluenceCopyRecoveryFacts, previous = latest.get(facts.review.id);
        if (previous) assertConfluenceCopyRecoveryProgression(previous,opened.body);
        else if (facts.factsRevision !== 1) throw new Error();
        retainedDecisionBytes += Buffer.byteLength(opened.body,'utf8') - (previous ? Buffer.byteLength(previous,'utf8') : 0);
        if (retainedDecisionBytes > 128 * 1024 * 1024) throw new Error();
        latest.set(facts.review.id,opened.body);
        published.set(entry.generation,{ entry, plainDigest: hash(opened.body), keyId: current.keyId, sourceRevision: current.sourceRevision });
      }
    }
    const finalHead = await journal.inspectCurrent(source), after = validateRecoveryControl(await control.readControl());
    if (performance.now() - startedAt > 120000 || finalHead.revision !== history.revision || JSON.stringify(after) !== JSON.stringify(before)) throw new Error();
    return { archivePrefixVerified: true as const, decisionEntriesVerified: published.size, archiveEntriesVerified: archiveCount,
      currentHistoryVerified: false as const, actionAuthorized: false as const, reopeningAuthorised: false as const };
  } catch { throw new Error('Confluence archive prefix verification is unresolved; preserve original evidence'); }
}
