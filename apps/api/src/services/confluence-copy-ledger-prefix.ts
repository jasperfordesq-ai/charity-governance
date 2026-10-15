import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RecoveryAuthorityJournal, validateRecoveryAuthorityEntry } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { inspectConfluenceCopyLedgerEnvelope, readVerifiedConfluenceCopyLedgerArchive,
  openConfluenceCopyLedgerArchive, type ConfluenceCopyLedgerArchiveBinding,
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

function checkArchive(body: string, context: RecoveryEnvelopeContext, published: Map<number,Published>,
  priorRows: Map<string,string>, priorTime: string, writerId: string) {
  const checked = validateConfluenceCopyLedgerRows(body,context);
  if (checked.ledger.capturedAt < priorTime) throw new Error();
  const rowHashes = new Map<string,string>();
  for (const [name,rows] of Object.entries(checked.ledger.tables)) for (const row of rows) rowHashes.set(`${name}:${row.id}`,hash(JSON.stringify(row)));
  for (const [id,digest] of priorRows) if (rowHashes.get(id) !== digest) throw new Error();
  matchPublished(checked.ledger.tables,published,writerId);
  return { rowHashes, capturedAt: checked.ledger.capturedAt };
}

async function verifyPayloads(entries: Entry[], context: RecoveryEnvelopeContext, writerId: string,
  keys: RecoveryDataKeys, objects: Objects, startedAt: number) {
  try {
    let envelopeBytes = 0, retainedDecisionBytes = 0, archiveCount = 0;
    const published = new Map<number,Published>(), latest = new Map<string,string>();
    let priorArchiveRows = new Map<string,string>(), priorArchiveTime = '';
    let lastArchiveBody: string | null = null, lastArchiveEntry: Entry | null = null;
    for (const entry of entries) {
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
        if (archive.observedControl.activeOperation !== null || archive.observedControl.writerId !== writerId
          || archive.observedControl.generation !== entry.generation - 1 || archive.observedControl.digest !== entry.previousDigest) throw new Error();
        const opened = await readVerifiedConfluenceCopyLedgerArchive(entry.factsDigest,archive,keys,
          { readConfluenceCopyLedger: async () => envelope });
        const checked = checkArchive(opened.body,current,published,priorArchiveRows,priorArchiveTime,writerId);
        priorArchiveRows = checked.rowHashes; priorArchiveTime = checked.capturedAt; archiveCount++;
        lastArchiveBody = opened.body; lastArchiveEntry = entry;
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
    return { published, priorArchiveRows, priorArchiveTime, archiveCount, envelopeBytes, lastArchiveBody, lastArchiveEntry };
  } catch { throw new Error('Confluence archive prefix verification is unresolved; preserve original evidence'); }
}

function headSource(control: RecoveryControlStore) {
  return { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
}
function requireBinding(before: ReturnType<typeof validateRecoveryControl>, context: RecoveryEnvelopeContext) {
  if (before.installationId !== context.installationId || before.organisationId !== context.organisationId
    || before.writerEpoch !== context.writerEpoch) throw new Error();
}
const noAuthority = { currentHistoryVerified: false as const, actionAuthorized: false as const, reopeningAuthorised: false as const };

/** Full supported single-key/epoch Confluence prefix only, not global history,
 * SQL restore, provider custody or current execution/reopening authority. */
export async function verifyConfluenceCopyLedgerPrefix(journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  rawContext: RecoveryEnvelopeContext, expectedBody: string, keys: RecoveryDataKeys, objects: Objects) {
  try {
    const startedAt = performance.now(), context = validateRecoveryEnvelopeContext(rawContext);
    const before = validateRecoveryControl(await control.readControl()); requireBinding(before,context);
    validateConfluenceCopyLedgerRows(expectedBody,context);
    const source = headSource(control), history = await journal.readPublishedHistory(source);
    if (history.revision !== before.revision || history.entries.at(-1)?.operationId !== context.operationId
      || history.entries.at(-1)?.kind !== 'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1') throw new Error();
    const state = await verifyPayloads(history.entries,context,before.writerId,keys,objects,startedAt);
    if (state.lastArchiveBody !== expectedBody || state.lastArchiveEntry?.digest !== before.digest) throw new Error();
    const finalHead = await journal.inspectCurrent(source), after = validateRecoveryControl(await control.readControl());
    if (performance.now() - startedAt > 120000 || finalHead.revision !== history.revision || JSON.stringify(after) !== JSON.stringify(before)) throw new Error();
    return { archivePrefixVerified: true as const, decisionEntriesVerified: state.published.size,
      archiveEntriesVerified: state.archiveCount, ...noAuthority };
  } catch { throw new Error('Confluence archive prefix verification is unresolved; preserve original evidence'); }
}

/** Authenticate original candidate and the complete published predecessor
 * prefix BEFORE append. Exact matching pending/head-published candidates are
 * inspected separately and never counted as predecessor publication evidence.
 * No write, candidate reconstruction, slot release or authority follows here.
 */
export async function verifyConfluenceCopyLedgerCandidate(journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
  preparationDigest: string, raw: ConfluenceCopyLedgerArchiveBinding, keys: RecoveryDataKeys, objects: Objects) {
  try {
    const startedAt = performance.now(), context = validateRecoveryEnvelopeContext(raw.context);
    const observed = validateRecoveryControl(raw.observedControl), before = validateRecoveryControl(await control.readControl());
    requireBinding(before,context); requireBinding(observed,context);
    if (observed.activeOperation !== null || observed.writerId !== before.writerId
      || before.activeOperation?.operationId !== context.operationId || before.activeOperation.preparationDigest !== preparationDigest) throw new Error();
    const envelope = await objects.readConfluenceCopyLedger(context.operationId);
    if (envelope === null) throw new Error();
    const opened = await openConfluenceCopyLedgerArchive(envelope,{ context, observedControl: observed },keys);
    if (hash(opened.body) !== preparationDigest) throw new Error();
    const request = { operationId: context.operationId, writerId: observed.writerId, writerEpoch: context.writerEpoch,
      preparationDigest, envelopeDigest: hash(envelope), expectedGeneration: observed.generation, expectedDigest: observed.digest };
    const history = await journal.readConfluenceCopyLedgerAppendHistory(request,control);
    if (history.revision !== before.revision) throw new Error();
    const state = await verifyPayloads(history.entries,context,before.writerId,keys,objects,startedAt);
    if (state.envelopeBytes + Buffer.byteLength(envelope,'utf8') > 512 * 1024 * 1024) throw new Error();
    checkArchive(opened.body,context,state.published,state.priorArchiveRows,state.priorArchiveTime,before.writerId);
    const finalHistory = await journal.readConfluenceCopyLedgerAppendHistory(request,control);
    const after = validateRecoveryControl(await control.readControl());
    if (performance.now() - startedAt > 120000 || finalHistory.revision !== history.revision || JSON.stringify(after) !== JSON.stringify(before)) throw new Error();
    return { candidatePrefixVerified: true as const, envelopeDigest: request.envelopeDigest,
      candidateEntryPresent: finalHistory.candidateEntry !== null, candidateHeadPublished: finalHistory.candidateHeadPublished,
      decisionEntriesVerified: state.published.size, archiveEntriesVerified: state.archiveCount, ...noAuthority };
  } catch { throw new Error('Confluence archive candidate prefix verification is unresolved; preserve original evidence'); }
}
