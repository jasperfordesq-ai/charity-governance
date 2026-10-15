import { createHash } from 'node:crypto';
import type { RecoveryAuthorityJournal } from './recovery-authority-journal.js';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';
import { validateRecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { inspectConfluenceCopyRecoveryEnvelope, openConfluenceCopyRecoveryFacts, CONFLUENCE_COPY_RECOVERY_MAX_ENVELOPE_BYTES,
  type ConfluenceCopyRecoveryObjects } from './confluence-copy-recovery-envelope.js';
import { assertConfluenceCopyRecoveryProgression, prepareConfluenceCopyRecoveryFacts, CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES,
  type ConfluenceCopyRecoveryFacts } from './confluence-copy-recovery-facts.js';

const MAX_RETAINED_BYTES = 128 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 512 * 1024 * 1024;
const hash = (body: string) => createHash('sha256').update(body,'utf8').digest('hex');
const noAuthority = { actionAuthorized: false as const, currentHistoryVerified: false as const, reopeningAuthorised: false as const };

/** Decision-state protocol verifier only. Unsupported kinds/epoch transitions
 * refuse; they are never silently filtered. No SQL restore, source/copy writer
 * proof, permission execution, reservation release or reopening follows here.
 * Key allowlist must come from separately trusted operator policy, not backup.
 */
export async function readConfluenceCopyDecisionHistory(journal: RecoveryAuthorityJournal,
  control: RecoveryControlStore, keys: RecoveryDataKeys,
  objects: Pick<ConfluenceCopyRecoveryObjects,'readConfluenceCopyState'>,
  allowedKeyIds: readonly string[], restoredCaptures: readonly { body: string; digest: string }[] = []) {
  const before = validateRecoveryControl(await control.readControl());
  if (!allowedKeyIds.length || allowedKeyIds.length > 32 || restoredCaptures.length > 10000) {
    throw new Error('Confluence history verification policy or restored-state capacity is invalid');
  }
  const allowed = new Set(allowedKeyIds);
  for (const keyId of allowed) validateRecoveryEnvelopeContext({ installationId: before.installationId,
    organisationId: before.organisationId, operationId: 'key-policy-check', writerEpoch: before.writerEpoch,
    sourceRevision: '0'.repeat(40), keyId });
  const restored = new Map<string,{ body: string; digest: string }>();
  let restoredBytes = 0;
  for (const local of restoredCaptures) {
    restoredBytes += Buffer.byteLength(local.body,'utf8');
    if (restoredBytes > MAX_RETAINED_BYTES || Buffer.byteLength(local.body,'utf8') > CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES) {
      throw new Error('Restored Confluence evidence exceeds verification capacity');
    }
    let prepared;
    try { prepared = prepareConfluenceCopyRecoveryFacts(JSON.parse(local.body)); }
    catch { throw new Error('Invalid restored Confluence evidence'); }
    const facts = JSON.parse(prepared.body) as ConfluenceCopyRecoveryFacts;
    if (prepared.body !== local.body || prepared.digest !== local.digest || restored.has(facts.operationId)
      || facts.installationId !== before.installationId || facts.organisationId !== before.organisationId) {
      throw new Error('Invalid restored Confluence evidence');
    }
    restored.set(facts.operationId,local);
  }
  const source = { async readHead() {
    const value = validateRecoveryControl(await control.readControl());
    return { installationId: value.installationId, organisationId: value.organisationId,
      generation: value.generation, digest: value.digest, revision: value.revision };
  } };
  const history = await journal.readPublishedHistory(source);
  if (history.revision !== before.revision) throw new Error('Confluence history control changed before payload verification');
  const latest = new Map<string,{ reviewId: string; body: string; digest: string; operationId: string;
    factsRevision: number; entryGeneration: number; entryDigest: string; envelopeDigest: string }>();
  const recordDigests = new Map<string,string>();
  let envelopeBytes = 0, retainedBytes = 0;
  for (const entry of history.entries) {
    if (entry.kind !== 'CONFLUENCE_COPY_DECISION_STATE_V1') throw new Error('Unsupported journal kind requires its reviewed recovery protocol');
    const envelope = await objects.readConfluenceCopyState(entry.operationId);
    if (envelope === null) throw new Error('Confluence history payload is missing; backup reconstruction is forbidden');
    envelopeBytes += Buffer.byteLength(envelope,'utf8');
    if (envelopeBytes > MAX_ENVELOPE_BYTES || Buffer.byteLength(envelope,'utf8') > CONFLUENCE_COPY_RECOVERY_MAX_ENVELOPE_BYTES) {
      throw new Error('Confluence history exceeds payload verification capacity');
    }
    if (hash(envelope) !== entry.factsDigest) throw new Error('Confluence history payload digest mismatch');
    const context = inspectConfluenceCopyRecoveryEnvelope(envelope);
    if (!allowed.has(context.keyId) || context.installationId !== before.installationId
      || context.organisationId !== before.organisationId || context.operationId !== entry.operationId
      || context.writerEpoch !== before.writerEpoch) throw new Error('Confluence history key/binding/epoch is not approved');
    const { body } = await openConfluenceCopyRecoveryFacts(envelope,context,keys);
    const facts = JSON.parse(body) as ConfluenceCopyRecoveryFacts;
    const digest = hash(body), previous = latest.get(facts.review.id);
    for (const name of ['review','reviewWithdrawal','scope','permission','permissionWithdrawal'] as const) {
      const record = facts[name];
      if (!record) continue;
      const key = `${name}:${record.id}`, recordDigest = hash(JSON.stringify(record));
      const oldDigest = recordDigests.get(key);
      if (oldDigest && oldDigest !== recordDigest) throw new Error('Confluence history rewrote a globally immutable decision record');
      recordDigests.set(key,recordDigest);
    }
    if (previous) assertConfluenceCopyRecoveryProgression(previous.body,body);
    else if (facts.factsRevision !== 1 || facts.previousFactsDigest !== null) throw new Error('Confluence history is missing the initial decision state');
    const local = restored.get(entry.operationId);
    if (local && (local.body !== body || local.digest !== digest)) throw new Error('Restored Confluence evidence contradicts independent history');
    restored.delete(entry.operationId);
    retainedBytes += Buffer.byteLength(body,'utf8') - (previous ? Buffer.byteLength(previous.body,'utf8') : 0);
    if (retainedBytes > MAX_RETAINED_BYTES) throw new Error('Confluence latest states exceed verification capacity');
    latest.set(facts.review.id,{ reviewId: facts.review.id, body, digest, operationId: facts.operationId,
      factsRevision: facts.factsRevision, entryGeneration: entry.generation, entryDigest: entry.digest, envelopeDigest: entry.factsDigest });
  }
  if (restored.size) throw new Error('Restored Confluence evidence is absent from independent history');
  const after = await journal.inspectCurrent(source);
  const finalControl = validateRecoveryControl(await control.readControl());
  if (after.revision !== history.revision || JSON.stringify(finalControl) !== JSON.stringify(before)) {
    throw new Error('Confluence history control changed during payload verification');
  }
  return { scope: 'CONFLUENCE_DECISION_STATES_ONLY' as const, confluencePayloadsVerified: true as const,
    generation: after.generation, digest: after.digest, revision: after.revision,
    latestStates: [...latest.values()].sort((a,b) => a.reviewId < b.reviewId ? -1 : a.reviewId === b.reviewId ? 0 : 1),
    ...noAuthority };
}
