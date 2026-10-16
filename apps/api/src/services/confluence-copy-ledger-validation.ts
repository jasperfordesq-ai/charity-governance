import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { prepareConfluenceCopyLocalLedger, CONFLUENCE_COPY_LEDGER_MAX_BYTES } from './confluence-copy-ledger-snapshot.js';
import { prepareConfluenceCopyRecoveryFacts, assertConfluenceCopyRecoveryProgression,
  type ConfluenceCopyRecoveryFacts } from './confluence-copy-recovery-facts.js';
import { validateConfluenceCopyRecoveryCapture } from './confluence-copy-recovery-capture.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext } from './recovery-preparation-envelope.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), controlId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const time = z.string().datetime({ precision: 3 }), hash = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.string().regex(/^[a-f0-9]{40}$/);
const captureSchema = z.object({ id, organisationId: controlId, reviewId: id, installationId: controlId,
  operationId: controlId, writerEpoch: z.number().int().positive().max(2147483647), sourceRevision: source,
  actorUserId: id, factsRevision: z.number().int().min(1).max(10000), previousFactsDigest: hash.nullable(),
  capturedAt: time, facts: z.string(), factsDigest: hash, recordedAt: time }).strict();
const planSchema = z.object({ id, organisationId: controlId, captureId: id, actorUserId: id, writerId: controlId,
  keyId: z.string(), keyEvidenceRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/),
  expectedGeneration: z.number().int().min(0).max(9999), expectedDigest: hash.nullable(), recordedAt: time,
}).strict().refine(value => (value.expectedGeneration === 0) === (value.expectedDigest === null));
const receiptSchema = z.object({ id, organisationId: controlId, planId: id, actorUserId: id, envelopeDigest: hash,
  entryGeneration: z.number().int().min(1).max(10000), entryDigest: hash,
  verifiedHeadRevision: z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/), recordedAt: time }).strict();
type Row = Record<string,unknown> & { id: string; organisationId: string };

function uniqueBy(rows: Row[], key: string) {
  const result = new Map<string,Row>();
  for (const row of rows) {
    if (typeof row[key] !== 'string' || result.has(row[key])) throw new Error();
    result.set(row[key],row);
  }
  return result;
}

/** Validates immutable local record shapes, links and historical capture
 * lineage only. This does NOT authenticate a journal/prefix, attest completeness
 * in time, prove external receipt observations or authorise current permission.
 * Original rows are returned unchanged; validation frames are never history.
 */
export function validateConfluenceCopyLedgerRows(body: string, rawContext: RecoveryEnvelopeContext) {
  return validateLedgerRows(body,rawContext,false);
}

/** V2 validation frame only: historical capture epochs stay original. This is
 * never the legacy V1 current-epoch reader or independently verified history. */
export function validateConfluenceExecutionLedgerLegacyRows(body: string, rawContext: RecoveryEnvelopeContext) {
  return { ...validateLedgerRows(body,rawContext,true), historicalEpochsAllowed: true as const };
}

function validateLedgerRows(body: string, rawContext: RecoveryEnvelopeContext, historicalEpochs: boolean) {
  try {
    if (typeof body !== 'string' || Buffer.byteLength(body,'utf8') > CONFLUENCE_COPY_LEDGER_MAX_BYTES) throw new Error();
    const context = validateRecoveryEnvelopeContext(rawContext);
    const prepared = prepareConfluenceCopyLocalLedger(JSON.parse(body)), ledger = prepared.ledger;
    if (body !== prepared.body || ledger.installationId !== context.installationId
      || ledger.organisationId !== context.organisationId || ledger.declaredSourceRevision !== context.sourceRevision) throw new Error();
    const t = ledger.tables;
    const reviews = uniqueBy(t.ConfluenceRetainedCopyReview!,'id');
    const scopes = uniqueBy(t.ConfluenceSyntheticCopyScope!,'reviewId');
    const permissions = uniqueBy(t.ConfluenceRetainedCopyPermission!,'reviewId');
    const reviewWithdrawals = uniqueBy(t.ConfluenceRetainedCopyReviewWithdrawal!,'reviewId');
    const permissionWithdrawals = uniqueBy(t.ConfluenceRetainedCopyPermissionWithdrawal!,'permissionId');
    for (const group of [scopes,permissions,reviewWithdrawals]) for (const reviewId of group.keys()) if (!reviews.has(reviewId)) throw new Error();
    const permissionIds = new Set([...permissions.values()].map(value => value.id));
    for (const permissionId of permissionWithdrawals.keys()) if (!permissionIds.has(permissionId)) throw new Error();

    const byReview = new Map<string,ConfluenceCopyRecoveryFacts>();
    for (const [reviewId,review] of reviews) {
      const permission = permissions.get(reviewId) ?? null;
      // Reuse the strict record/link/time validator. This transient frame is
      // not a capture and is never returned, stored, signed or published.
      const checked = prepareConfluenceCopyRecoveryFacts({ format: 1, kind: 'CONFLUENCE_COPY_DECISION_STATE_V1',
        installationId: ledger.installationId, organisationId: ledger.organisationId, operationId: 'ledger-row-validation',
        writerEpoch: context.writerEpoch, sourceRevision: ledger.declaredSourceRevision,
        factsRevision: 1, previousFactsDigest: null, capturedAt: ledger.capturedAt, review,
        scope: scopes.get(reviewId) ?? null, permission, reviewWithdrawal: reviewWithdrawals.get(reviewId) ?? null,
        permissionWithdrawal: permission ? permissionWithdrawals.get(permission.id) ?? null : null });
      byReview.set(reviewId,JSON.parse(checked.body) as ConfluenceCopyRecoveryFacts);
    }

    const captures = t.ConfluenceCopyRecoveryCapture!.map(row => captureSchema.parse(row));
    const captureIds = new Map(captures.map(row => [row.id,row]));
    const captureOperations = new Set<string>();
    const lineages = new Map<string,typeof captures>();
    for (const row of captures) {
      if (captureOperations.has(row.operationId) || row.installationId !== context.installationId
        || (historicalEpochs ? row.writerEpoch > context.writerEpoch : row.writerEpoch !== context.writerEpoch) || row.recordedAt < row.capturedAt || row.recordedAt > ledger.capturedAt) throw new Error();
      captureOperations.add(row.operationId);
      const facts = validateConfluenceCopyRecoveryCapture({ ...row, capturedAt: new Date(row.capturedAt) });
      const latest = byReview.get(row.reviewId);
      if (!latest) throw new Error();
      for (const name of ['review','scope','permission','reviewWithdrawal','permissionWithdrawal'] as const) {
        if (facts[name] !== null && !isDeepStrictEqual(facts[name],latest[name])) throw new Error();
      }
      const recordedTimes = { scope: latest.scope?.registeredAt, permission: latest.permission?.issuedAt,
        reviewWithdrawal: latest.reviewWithdrawal?.occurredAt, permissionWithdrawal: latest.permissionWithdrawal?.occurredAt };
      for (const name of ['scope','permission','reviewWithdrawal','permissionWithdrawal'] as const) {
        if (facts[name] === null && recordedTimes[name] && recordedTimes[name]! < row.capturedAt) throw new Error();
      }
      const group = lineages.get(row.reviewId) ?? []; group.push(row); lineages.set(row.reviewId,group);
    }
    for (const group of lineages.values()) {
      group.sort((a,b) => a.factsRevision - b.factsRevision);
      if (group[0]!.factsRevision !== 1) throw new Error();
      for (let index = 1; index < group.length; index++) assertConfluenceCopyRecoveryProgression(group[index - 1]!.facts,group[index]!.facts);
    }

    const plans = t.ConfluenceCopyPublicationPlan!.map(row => planSchema.parse(row));
    const planIds = new Map(plans.map(row => [row.id,row]));
    if (new Set(plans.map(row => row.captureId)).size !== plans.length) throw new Error();
    for (const row of plans) {
      const capture = captureIds.get(row.captureId);
      if (!capture || row.recordedAt < capture.recordedAt || row.recordedAt > ledger.capturedAt) throw new Error();
      validateRecoveryEnvelopeContext({ installationId: capture.installationId, organisationId: capture.organisationId,
        operationId: capture.operationId, writerEpoch: capture.writerEpoch, sourceRevision: capture.sourceRevision, keyId: row.keyId });
    }
    const receipts = t.ConfluenceCopyPublicationReceipt!.map(row => receiptSchema.parse(row));
    if (new Set(receipts.map(row => row.planId)).size !== receipts.length) throw new Error();
    for (const row of receipts) {
      const plan = planIds.get(row.planId);
      if (!plan || row.entryGeneration !== plan.expectedGeneration + 1
        || row.recordedAt < plan.recordedAt || row.recordedAt > ledger.capturedAt) throw new Error();
    }
    return { ledger, ledgerRowsVerified: true as const,
      actionAuthorized: false as const, currentHistoryVerified: false as const, reopeningAuthorised: false as const };
  } catch { throw new Error('Invalid Confluence ledger relationships; preserve original evidence for reconciliation'); }
}
