import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { RecoveryAuthorityJournal, validateRecoveryAuthorityEntry } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { inspectConfluenceExecutionArchiveV2, openConfluenceExecutionArchiveV2,
 type ConfluenceExecutionArchiveV2Binding, type ConfluenceExecutionArchiveV2HistoryObjects } from './confluence-execution-archive-v2.js';
import { inspectConfluenceCopyLedgerEnvelope, openConfluenceCopyLedgerArchive } from './confluence-copy-ledger-envelope.js';
import { inspectConfluenceCopyRecoveryEnvelope, openConfluenceCopyRecoveryFacts } from './confluence-copy-recovery-envelope.js';
import { assertConfluenceCopyHistoricalProgression, type ConfluenceCopyRecoveryFacts } from './confluence-copy-recovery-facts.js';
import { validateConfluenceCopyLedgerRows } from './confluence-copy-ledger-validation.js';
import { prepareConfluenceExecutionLedgerV2 } from './confluence-execution-ledger-v2.js';

type Objects = ConfluenceExecutionArchiveV2HistoryObjects
 & { readConfluenceCopyLedgerHistory(operationId:string):Promise<string|null>;
     readConfluenceCopyStateHistory(operationId:string):Promise<string|null> };
type Entry = ReturnType<typeof validateRecoveryAuthorityEntry>;
type Tables = ReturnType<typeof prepareConfluenceExecutionLedgerV2>['ledger']['tables'];
const policySchema = z.array(z.object({ writerEpoch: z.number().int().positive().max(2147483647),
 writerId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/), keyIds: z.array(z.string()).min(1).max(32) }).strict()).min(1).max(128);
export type ConfluenceExecutionWriterPolicy = z.infer<typeof policySchema>;
const hash = (body: string) => createHash('sha256').update(body,'utf8').digest('hex');
const noAuthority = { currentHistoryVerified: false as const, actionAuthorized: false as const,
 reopeningAuthorised: false as const, independentlyPreserved: false as const, transportStateReconciled: false as const };
function canonical(value: unknown): string {
 const visit = (item: unknown): unknown => Array.isArray(item) ? item.map(visit) : item !== null && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a < b ? -1 : a === b ? 0 : 1).map(([k,v]) => [k,visit(v)])) : item;
 return JSON.stringify(visit(value));
}
function policyFor(raw: ConfluenceExecutionWriterPolicy, current: ReturnType<typeof validateRecoveryControl>) {
 const policy = policySchema.parse(raw); let prior = 0;
 for (const item of policy) {
  if (item.writerEpoch <= prior || item.writerEpoch > current.writerEpoch || new Set(item.keyIds).size !== item.keyIds.length) throw new Error();
  prior = item.writerEpoch;
  for (const keyId of item.keyIds) validateRecoveryEnvelopeContext({ installationId: current.installationId,
   organisationId: current.organisationId, operationId: 'policy-check', writerEpoch: item.writerEpoch, sourceRevision: '0'.repeat(40), keyId });
 }
 const last = policy.at(-1)!;
 if (last.writerEpoch !== current.writerEpoch || last.writerId !== current.writerId) throw new Error();
 return new Map(policy.map(item => [item.writerEpoch,item]));
}
function bindingOf(raw: ConfluenceExecutionArchiveV2Binding) {
 const context = validateRecoveryEnvelopeContext(raw.context), observedControl = validateRecoveryControl(raw.observedControl);
 if (context.installationId !== observedControl.installationId || context.organisationId !== observedControl.organisationId
  || context.writerEpoch !== observedControl.writerEpoch || observedControl.activeOperation !== null || observedControl.generation >= 10000) throw new Error();
 return { context, observedControl };
}
function sameWriter(current: ReturnType<typeof validateRecoveryControl>, binding: ReturnType<typeof bindingOf>) {
 return current.installationId === binding.context.installationId && current.organisationId === binding.context.organisationId
  && current.writerEpoch === binding.context.writerEpoch && current.writerId === binding.observedControl.writerId;
}
function headSource(control: Pick<RecoveryControlStore,'readControl'>) {
 return { async readHead() { const value = validateRecoveryControl(await control.readControl());
  return { installationId: value.installationId, organisationId: value.organisationId,
   generation: value.generation, digest: value.digest, revision: value.revision }; } };
}
type Published = { entry: Entry; body: string; context: RecoveryEnvelopeContext; writerId: string };
function matchPublished(tables: Tables, published: Map<number,Published>) {
 const index = (name: string, field: string) => new Map(tables[name]!.map(row => [row[field],row]));
 const captures = index('ConfluenceCopyRecoveryCapture','operationId'), capturesById = index('ConfluenceCopyRecoveryCapture','id');
 const plans = index('ConfluenceCopyPublicationPlan','captureId'), plansById = index('ConfluenceCopyPublicationPlan','id');
 const receipts = index('ConfluenceCopyPublicationReceipt','planId');
 for (const { entry, body, context, writerId } of published.values()) {
  const capture = captures.get(entry.operationId), plan = capture ? plans.get(capture.id) : undefined;
  const receipt = plan ? receipts.get(plan.id) : undefined;
  if (!capture || !plan || !receipt || capture.facts !== body || capture.factsDigest !== hash(body)
   || capture.sourceRevision !== context.sourceRevision || capture.writerEpoch !== context.writerEpoch
   || plan.keyId !== context.keyId || plan.writerId !== writerId || plan.expectedGeneration !== entry.generation - 1
   || plan.expectedDigest !== entry.previousDigest || receipt.entryGeneration !== entry.generation
   || receipt.entryDigest !== entry.digest || receipt.envelopeDigest !== entry.factsDigest) throw new Error();
 }
 for (const receipt of tables.ConfluenceCopyPublicationReceipt!) {
  const p = typeof receipt.entryGeneration === 'number' ? published.get(receipt.entryGeneration) : undefined;
  const plan = plansById.get(receipt.planId), capture = plan ? capturesById.get(plan.captureId) : undefined;
  if (!p || capture?.operationId !== p.entry.operationId) throw new Error();
 }
}
/** Policy is separately trusted operator custody input, never inferred from a
 * recovered archive. Historical validation does not authorise writer changes. */
async function payloads(entries: Entry[], current: ReturnType<typeof validateRecoveryControl>, keys: RecoveryDataKeys,
 objects: Objects, rawPolicy: ConfluenceExecutionWriterPolicy, started: number) {
 const policy = policyFor(rawPolicy,current), published = new Map<number,Published>();
 const latest = new Map<string,string>(), decisionRecords = new Map<string,string>();
 let priorRows = new Map<string,string>(), priorTime = '', priorEpoch = 0, v2Seen = false;
 let envelopeBytes = 0, retainedBytes = 0, archiveCount = 0;
 let lastArchiveBody: string | null = null, lastArchiveEntry: Entry | null = null;
 function checkContext(context: RecoveryEnvelopeContext, entry: Entry) {
  const writer = policy.get(context.writerEpoch);
  if (!writer || !writer.keyIds.includes(context.keyId) || context.installationId !== current.installationId
   || context.organisationId !== current.organisationId || context.operationId !== entry.operationId
   || context.writerEpoch < priorEpoch) throw new Error();
  priorEpoch = context.writerEpoch; return writer;
 }
 function checkRows(body: string, context: RecoveryEnvelopeContext, v2: boolean) {
  const checked = v2 ? prepareConfluenceExecutionLedgerV2(JSON.parse(body),context) : validateConfluenceCopyLedgerRows(body,context);
  if (v2 && 'body' in checked && checked.body !== body) throw new Error();
  if (checked.ledger.capturedAt < priorTime || (v2Seen && !v2)) throw new Error();
  const rows = new Map<string,string>();
  for (const [name,group] of Object.entries(checked.ledger.tables)) for (const row of group) rows.set(`${name}:${row.id}`,hash(canonical(row)));
  for (const [id,digest] of priorRows) if (rows.get(id) !== digest) throw new Error();
  matchPublished(checked.ledger.tables,published);
  priorRows = rows; priorTime = checked.ledger.capturedAt; v2Seen ||= v2;
 }
 for (const entry of entries) {
  if (performance.now() - started > 120000) throw new Error();
  const v2 = entry.kind === 'CONFLUENCE_EXECUTION_LEDGER_ARCHIVE_V2', v1 = entry.kind === 'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1';
  if (!v2 && !v1 && entry.kind !== 'CONFLUENCE_COPY_DECISION_STATE_V1') throw new Error();
  // V2 keys include epoch. Resolve using the bounded trusted epoch policy, never
  // a latest-only lookup or an untrusted current database record. Exactly one
  // matching immutable object may exist for this operation across approved epochs.
  let envelope: string | null = null;
  if (v2) {
   for (const item of policy.values()) {
    if (performance.now() - started > 120000) throw new Error();
    const candidate = await objects.readExecutionLedgerV2At({ installationId: current.installationId,
     organisationId: current.organisationId, operationId: entry.operationId, writerEpoch: item.writerEpoch });
    if (candidate !== null) { if (envelope !== null) throw new Error(); envelope = candidate; }
   }
  } else envelope = v1 ? await objects.readConfluenceCopyLedgerHistory(entry.operationId) : await objects.readConfluenceCopyStateHistory(entry.operationId);
  if (envelope === null) throw new Error();
  envelopeBytes += Buffer.byteLength(envelope,'utf8');
  if (envelopeBytes > 512 * 1024 * 1024 || hash(envelope) !== entry.factsDigest) throw new Error();
  if (v2 || v1) {
   const archive = v2 ? inspectConfluenceExecutionArchiveV2(envelope) : inspectConfluenceCopyLedgerEnvelope(envelope);
   const context = archive.context, writer = checkContext(context,entry), observed = validateRecoveryControl(archive.observedControl);
   if (observed.activeOperation !== null || observed.writerId !== writer.writerId || observed.writerEpoch !== context.writerEpoch
    || observed.generation !== entry.generation - 1 || observed.digest !== entry.previousDigest) throw new Error();
   const opened = v2 ? await openConfluenceExecutionArchiveV2(envelope,archive,keys) : await openConfluenceCopyLedgerArchive(envelope,archive,keys);
   checkRows(opened.body,context,v2); archiveCount++; lastArchiveBody = opened.body; lastArchiveEntry = entry;
  } else {
   const context = inspectConfluenceCopyRecoveryEnvelope(envelope), writer = checkContext(context,entry);
   const { body } = await openConfluenceCopyRecoveryFacts(envelope,context,keys), facts = JSON.parse(body) as ConfluenceCopyRecoveryFacts;
   const previous = latest.get(facts.review.id);
   if (previous) assertConfluenceCopyHistoricalProgression(previous,body);
   else if (facts.factsRevision !== 1 || facts.previousFactsDigest !== null) throw new Error();
   for (const name of ['review','scope','permission','reviewWithdrawal','permissionWithdrawal'] as const) {
    const record = facts[name]; if (!record) continue;
    const id = `${name}:${record.id}`, digest = hash(canonical(record)), prior = decisionRecords.get(id);
    if (prior && prior !== digest) throw new Error(); decisionRecords.set(id,digest);
   }
   retainedBytes += Buffer.byteLength(body,'utf8') - (previous ? Buffer.byteLength(previous,'utf8') : 0);
   if (retainedBytes > 128 * 1024 * 1024) throw new Error(); latest.set(facts.review.id,body);
   published.set(entry.generation,{ entry,body,context,writerId: writer.writerId });
  }
 }
 return { published, archiveCount, envelopeBytes, lastArchiveBody, lastArchiveEntry, checkRows };
}
/** Authenticated observed-head payload proof only; not whole-backend recovery,
 * provider custody, all-writer fencing, SQL restore or reopening authority. */
export async function readPublishedConfluenceExecutionV2(journal: RecoveryAuthorityJournal, control: Pick<RecoveryControlStore,'readControl'>,
 raw: ConfluenceExecutionArchiveV2Binding, keys: RecoveryDataKeys, objects: Objects, policy: ConfluenceExecutionWriterPolicy) {
 try {
  const started = performance.now(), binding = bindingOf(raw), trustedPolicy = policySchema.parse(policy),
   before = validateRecoveryControl(await control.readControl());
  if (!sameWriter(before,binding) || before.generation !== binding.observedControl.generation + 1) throw new Error();
  const source = headSource(control), history = await journal.readPublishedHistory(source);
  if (history.revision !== before.revision) throw new Error();
  const entry = history.entries.at(-1);
  if (!entry || entry.kind !== 'CONFLUENCE_EXECUTION_LEDGER_ARCHIVE_V2' || entry.operationId !== binding.context.operationId
   || entry.digest !== before.digest || entry.previousDigest !== binding.observedControl.digest) throw new Error();
  const state = await payloads(history.entries,before,keys,objects,trustedPolicy,started);
  const envelope = await objects.readExecutionLedgerV2(binding.context);
  if (envelope === null || hash(envelope) !== entry.factsDigest) throw new Error();
  const opened = await openConfluenceExecutionArchiveV2(envelope,binding,keys);
  if (opened.body !== state.lastArchiveBody) throw new Error();
  const finalHistory = await journal.inspectCurrent(source), after = validateRecoveryControl(await control.readControl());
  if (performance.now() - started > 120000 || finalHistory.revision !== history.revision || canonical(after) !== canonical(before)) throw new Error();
  return { body: opened.body, archiveAtObservedHead: true as const, candidatePrefixVerified: false as const,
   archivePrefixVerified: true as const, decisionEntriesVerified: state.published.size, archiveEntriesVerified: state.archiveCount,
   entryGeneration: entry.generation, entryDigest: entry.digest, envelopeDigest: entry.factsDigest, revision: history.revision, ...noAuthority };
 } catch { throw new Error('Confluence execution V2 current prefix is unresolved; preserve original evidence'); }
}
export async function verifyConfluenceExecutionV2Candidate(journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
 preparationDigest: string, raw: ConfluenceExecutionArchiveV2Binding, keys: RecoveryDataKeys, objects: Objects, policy: ConfluenceExecutionWriterPolicy) {
 try {
  const started = performance.now(), binding = bindingOf(raw), trustedPolicy = policySchema.parse(policy),
   before = validateRecoveryControl(await control.readControl());
  if (!/^[a-f0-9]{64}$/.test(preparationDigest) || !sameWriter(before,binding)
   || before.activeOperation?.operationId !== binding.context.operationId || before.activeOperation.preparationDigest !== preparationDigest) throw new Error();
  const envelope = await objects.readExecutionLedgerV2(binding.context);
  if (envelope === null) throw new Error();
  const opened = await openConfluenceExecutionArchiveV2(envelope,binding,keys);
  if (hash(opened.body) !== preparationDigest) throw new Error();
  const request = { operationId: binding.context.operationId, writerId: binding.observedControl.writerId,
   writerEpoch: binding.context.writerEpoch, preparationDigest, envelopeDigest: hash(envelope),
   expectedGeneration: binding.observedControl.generation, expectedDigest: binding.observedControl.digest };
  const history = await journal.readConfluenceExecutionV2AppendHistory(request,control);
  if (history.revision !== before.revision) throw new Error();
  const state = await payloads(history.entries,before,keys,objects,trustedPolicy,started);
  const permitted = policyFor(trustedPolicy,before).get(binding.context.writerEpoch);
  if (!permitted?.keyIds.includes(binding.context.keyId) || state.envelopeBytes + Buffer.byteLength(envelope,'utf8') > 512 * 1024 * 1024) throw new Error();
  state.checkRows(opened.body,binding.context,true);
  const finalHistory = await journal.readConfluenceExecutionV2AppendHistory(request,control), after = validateRecoveryControl(await control.readControl());
  if (performance.now() - started > 120000 || history.revision !== finalHistory.revision || canonical(after) !== canonical(before)) throw new Error();
  return { candidatePrefixVerified: true as const, envelopeDigest: request.envelopeDigest,
   candidateEntryPresent: finalHistory.candidateEntry !== null, candidateHeadPublished: finalHistory.candidateHeadPublished,
   decisionEntriesVerified: state.published.size, archiveEntriesVerified: state.archiveCount, ...noAuthority };
 } catch { throw new Error('Confluence execution V2 candidate prefix is unresolved; preserve original evidence'); }
}
/** No missing-object creation, implicit reservation acquisition or slot release. */
export async function publishVerifiedConfluenceExecutionV2(journal: RecoveryAuthorityJournal, control: RecoveryControlStore,
 preparationDigest: string, raw: ConfluenceExecutionArchiveV2Binding, keys: RecoveryDataKeys, objects: Objects, policy: ConfluenceExecutionWriterPolicy) {
 const binding = bindingOf(raw), trustedPolicy = policySchema.parse(policy), before = validateRecoveryControl(await control.readControl());
 const candidate = await verifyConfluenceExecutionV2Candidate(journal,control,preparationDigest,binding,keys,objects,trustedPolicy);
 const after = validateRecoveryControl(await control.readControl());
 if (canonical(after) !== canonical(before)) throw new Error('Confluence V2 control changed during authentication');
 const receipt = await journal.appendReservedConfluenceExecutionV2({ operationId: binding.context.operationId,
  writerId: binding.observedControl.writerId, writerEpoch: binding.context.writerEpoch, preparationDigest,
  envelopeDigest: candidate.envelopeDigest, expectedGeneration: binding.observedControl.generation,
  expectedDigest: binding.observedControl.digest },control);
 return { ...receipt, candidatePrefixVerified: true as const, ...noAuthority };
}
