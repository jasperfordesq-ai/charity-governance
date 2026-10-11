import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

/**
 * Whether a document disposal case is complete across every copy, not only
 * the primary file. The contract: primary-file absence is one outcome;
 * versions, managed Confluence copies, recipient exports, logs/audit and
 * backups are tracked separately, and the case stays incomplete while any
 * applicable target lacks disposition evidence.
 *
 * A copy area the disposal plan marks DISPOSE or RETAIN_APPROVED needs at
 * least one recorded scope, and every scope's latest reviewer observation must
 * be resolved:
 * - VERIFIED_ABSENT or NOT_APPLICABLE (a recorded fact);
 * - RETAINED_APPROVED whose follow-up review is not yet due and whose scoped
 *   authority, if it has one, is still current and unexpired.
 * NEEDS_REVIEW, PENDING_DISPOSAL and FAILED are unresolved, as is any
 * observation recorded under authority that has since been withdrawn or
 * replaced. A NOT_APPLICABLE area is resolved unless an observation says
 * otherwise. The primary file must have its reconciled completion.
 *
 * A scope is a reviewer's controlled reference: whether the recorded scopes
 * cover every real copy in an area is the reviewer's attestation, not
 * something this evaluator can know. It reads evidence only; it never
 * deletes, retains or releases anything.
 */
export const COPY_AREAS = ['VERSIONS', 'CONFLUENCE', 'EXPORTS', 'AUDIT', 'BACKUPS'] as const;
export type CopyArea = typeof COPY_AREAS[number];
type PlanDisposition = 'DISPOSE' | 'RETAIN_APPROVED' | 'NOT_APPLICABLE';
export type UnresolvedReason = 'NO_SCOPE_RECORDED' | 'NEEDS_REVIEW' | 'PENDING_DISPOSAL' | 'FAILED'
  | 'REVIEW_OVERDUE' | 'AUTHORITY_CHANGED' | 'AUTHORITY_EXPIRED' | 'CONTRADICTS_PLAN';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const scopeRef = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,119}$/);
const area = z.enum(COPY_AREAS);
const disposition = z.enum(['DISPOSE', 'RETAIN_APPROVED', 'NOT_APPLICABLE']);
const store = z.object({ disposition, evidenceRef: scopeRef }).strict();
const planSchema = z.object({ PRIMARY: store.extend({ disposition: z.literal('DISPOSE') }),
  VERSIONS: store, CONFLUENCE: store, EXPORTS: store, AUDIT: store, BACKUPS: store }).strict();
const observationSchema = z.object({ id, area, scopeRef, revision: z.number().int().positive(),
  status: z.enum(['NEEDS_REVIEW', 'PENDING_DISPOSAL', 'FAILED', 'VERIFIED_ABSENT', 'RETAINED_APPROVED', 'NOT_APPLICABLE']),
  copyAuthorityId: id.nullable(), nextReviewAt: z.date().nullable(),
  observedAt: z.date().optional(), evidenceRef: scopeRef.optional() }).strict();
const authoritySchema = z.object({ id, area, scopeRef, revision: z.number().int().positive(),
  state: z.enum(['AUTHORIZED', 'WITHDRAWN']), validUntil: z.date().nullable(),
  disposition: disposition.nullable().optional(), evidenceRef: scopeRef.optional() }).strict();
const holdSchema = z.object({ area, scopeRef, revision: z.number().int().positive(), held: z.boolean() }).strict();

export type CompletenessInput = {
  plan: unknown;
  primaryCompletionRecorded: boolean;
  observations: unknown[];
  authorities: unknown[];
  holds: unknown[];
  now: Date;
};

function latest<T extends { area: string; scopeRef: string; revision: number }>(rows: T[]) {
  const byScope = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.area}\u0000${row.scopeRef}`;
    const seen = byScope.get(key);
    if (seen && seen.revision === row.revision) throw new Error('Copy evidence has a duplicate revision');
    if (!seen || row.revision > seen.revision) byScope.set(key, row);
  }
  return byScope;
}

/** Pure: same evidence and time, same answer and digest. */
export function evaluateDocumentDisposalCompleteness(input: CompletenessInput) {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) throw new Error('Completeness time is invalid');
  const plan = planSchema.parse(input.plan);
  const observations = latest(input.observations.map((row) => observationSchema.parse(row)));
  const authorities = latest(input.authorities.map((row) => authoritySchema.parse(row)));
  const holds = latest(input.holds.map((row) => holdSchema.parse(row)));
  const now = input.now.getTime();
  const areas = COPY_AREAS.map((name) => {
    const planned: PlanDisposition = plan[name].disposition;
    const scopes = [...observations.values()].filter((row) => row.area === name)
      .sort((a, b) => (a.scopeRef < b.scopeRef ? -1 : a.scopeRef > b.scopeRef ? 1 : 0));
    const unresolved: Array<{ scopeRef: string | null; reason: UnresolvedReason }> = [];
    if (planned !== 'NOT_APPLICABLE' && scopes.length === 0) unresolved.push({ scopeRef: null, reason: 'NO_SCOPE_RECORDED' });
    for (const scope of scopes) {
      const key = `${name}\u0000${scope.scopeRef}`;
      const authority = authorities.get(key) ?? null;
      const reason = ((): UnresolvedReason | null => {
        if (scope.status === 'NEEDS_REVIEW' || scope.status === 'PENDING_DISPOSAL' || scope.status === 'FAILED') {
          return scope.status;
        }
        // Recorded under authority that is no longer the scope's current one
        // (withdrawn, replaced, or granted only after the observation).
        if ((authority?.id ?? null) !== scope.copyAuthorityId) return 'AUTHORITY_CHANGED';
        if (scope.copyAuthorityId === null && ((scope.status === 'VERIFIED_ABSENT' && planned !== 'DISPOSE')
          || (scope.status === 'RETAINED_APPROVED' && planned !== 'RETAIN_APPROVED')
          || (scope.status === 'NOT_APPLICABLE' && planned !== 'NOT_APPLICABLE'))) {
          return 'CONTRADICTS_PLAN';
        }
        if (scope.status === 'RETAINED_APPROVED') {
          if (scope.nextReviewAt === null || scope.nextReviewAt.getTime() <= now) return 'REVIEW_OVERDUE';
          if (authority && (authority.state !== 'AUTHORIZED' || authority.validUntil === null
            || authority.validUntil.getTime() <= now)) {
            return 'AUTHORITY_EXPIRED';
          }
        }
        return null;
      })();
      if (reason) unresolved.push({ scopeRef: scope.scopeRef, reason });
    }
    return { area: name, plan: planned, scopes: scopes.length,
      resolved: scopes.length - unresolved.filter((u) => u.scopeRef !== null).length, unresolved };
  });
  const complete = input.primaryCompletionRecorded && areas.every((a) => a.unresolved.length === 0);
  // Bound to the exact evidence rows relied on, never their content.
  const evidence = {
    format: 1, primaryCompletionRecorded: input.primaryCompletionRecorded,
    plan: Object.fromEntries(COPY_AREAS.map((name) => [name, plan[name].disposition])),
    scopes: [...observations.values()].sort((a, b) => (`${a.area}:${a.scopeRef}` < `${b.area}:${b.scopeRef}` ? -1 : 1))
      .map((row) => {
        const key = `${row.area}\u0000${row.scopeRef}`;
        return { area: row.area, scopeRef: row.scopeRef, observationId: row.id, revision: row.revision,
          status: row.status, authorityId: authorities.get(key)?.id ?? null,
          holdRevision: holds.get(key)?.revision ?? 0 };
      }),
  };
  const digest = createHash('sha256').update(JSON.stringify(evidence), 'utf8').digest('hex');
  const byScope = <T extends { area: string; scopeRef: string }>(rows: Iterable<T>) => [...rows]
    .sort((a, b) => (`${a.area}:${a.scopeRef}` < `${b.area}:${b.scopeRef}` ? -1 : 1));
  // The exact latest rows the judgement rests on, for a caller that must
  // publish them in full.
  const relied = { observations: byScope(observations.values()), authorities: byScope(authorities.values()) };
  return { complete, primaryCompletionRecorded: input.primaryCompletionRecorded, areas, digest, relied,
    actionAuthorized: false as const };
}

/** Under recovery enforcement, copy observations and authorities may be
 * recorded only once the authorization's primary file has its reconciled
 * completion (the database gate enforces the same). Holds stay frozen. */
export async function documentPrimaryCompleted(tx: Pick<PrismaClient, 'documentPurgeClaim' | 'documentBytePrimaryCompletion'>,
  organisationId: string, authorizationId: string): Promise<boolean> {
  const claim = await tx.documentPurgeClaim.findFirst({ where: { authorizationId, organisationId },
    select: { deletionId: true } });
  if (!claim) return false;
  const completion = await tx.documentBytePrimaryCompletion.findUnique({ where: { deletionId: claim.deletionId },
    select: { organisationId: true } });
  return completion?.organisationId === organisationId;
}

const MAX_EVIDENCE_ROWS = 1000;

/** The local half: one serializable read of the authorization, its primary
 * completion and every copy evidence row, evaluated against database time. */
export async function readDocumentDisposalCompleteness(prisma: PrismaClient,
  raw: { organisationId: string; authorizationId: string }) {
  const scope = z.object({ organisationId: id, authorizationId: id }).strict().parse(raw);
  return prisma.$transaction(async (tx) => {
    const authorization = await tx.documentPurgeAuthorization.findFirst({
      where: { id: scope.authorizationId, organisationId: scope.organisationId },
      select: { id: true, dispositionPlan: true, claim: { select: { deletionId: true } } },
    });
    if (!authorization?.claim) throw new Error('Document disposal has no committed claim');
    const where = { organisationId: scope.organisationId, authorizationId: authorization.id };
    const [completion, job, observations, authorities, holds, clock] = await Promise.all([
      tx.documentBytePrimaryCompletion.findUnique({ where: { deletionId: authorization.claim.deletionId },
        select: { organisationId: true, scope: true } }),
      tx.documentStorageDeletion.findUnique({ where: { id: authorization.claim.deletionId },
        select: { organisationId: true, state: true } }),
      tx.documentPurgeDispositionEvent.findMany({ where, take: MAX_EVIDENCE_ROWS + 1,
        select: { id: true, area: true, scopeRef: true, revision: true, status: true,
          copyAuthorityId: true, nextReviewAt: true, observedAt: true, evidenceRef: true } }),
      tx.documentCopyDispositionAuthority.findMany({ where, take: MAX_EVIDENCE_ROWS + 1,
        select: { id: true, area: true, scopeRef: true, revision: true, state: true, validUntil: true,
          disposition: true, evidenceRef: true } }),
      tx.documentCopyHoldEvent.findMany({ where, take: MAX_EVIDENCE_ROWS + 1,
        select: { area: true, scopeRef: true, revision: true, held: true } }),
      tx.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC', statement_timestamp()) AS now`,
    ]);
    if (observations.length > MAX_EVIDENCE_ROWS || authorities.length > MAX_EVIDENCE_ROWS
      || holds.length > MAX_EVIDENCE_ROWS) {
      throw new Error('Document disposal evidence exceeds the bounded review size');
    }
    const primaryCompletionRecorded = completion !== null && completion.organisationId === scope.organisationId
      && completion.scope === 'PRIMARY_ACTIVE_OBJECT_ONLY'
      && job?.organisationId === scope.organisationId && job.state === 'PROCESSED';
    return { authorizationId: authorization.id, deletionId: authorization.claim.deletionId,
      ...evaluateDocumentDisposalCompleteness({ plan: authorization.dispositionPlan, primaryCompletionRecorded,
        observations, authorities, holds, now: clock[0]!.now }) };
  }, { isolationLevel: 'Serializable' });
}
