import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { lockOrganisationForUpdate } from './organisation-lock.js';
import { assertConfluenceCopyRecoveryProgression, prepareConfluenceCopyRecoveryFacts,
  CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES, type ConfluenceCopyRecoveryFacts } from './confluence-copy-recovery-facts.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const inputSchema = z.object({ installationId: identity, operationId: identity,
  writerEpoch: z.number().int().positive().max(2147483647),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  reviewId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict();

// Internal, inactive local capture. This is neither a reserved writer nor an
// authenticated current head, and there is no provider or external-store I/O.
export class ConfluenceCopyRecoveryCaptureStore {
  constructor(private readonly prisma: PrismaClient) {}

  async capture(organisationId: string, actorUserId: string, raw: unknown) {
    const input = inputSchema.parse(raw);
    return this.prisma.$transaction(async tx => {
      await lockOrganisationForUpdate(tx, organisationId);
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId}
        AND "organisationId"=${organisationId} FOR SHARE`;
      const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId,
        role: 'OWNER', lifecycleStatus: 'ACTIVE' }, select: { id: true } });
      const organisation = await tx.organisation.findFirst({ where: { id: organisationId,
        lifecycleStatus: 'ACTIVE' }, select: { id: true } });
      if (!actor || !organisation) throw new Error('Confluence recovery capture requires active charity Owner');

      const existing = await tx.confluenceCopyRecoveryCapture.findUnique({
        where: { organisationId_operationId: { organisationId, operationId: input.operationId } } });
      if (existing) {
        const facts = validateConfluenceCopyRecoveryCapture(existing);
        if (existing.actorUserId !== actorUserId || facts.review.id !== input.reviewId
          || facts.installationId !== input.installationId || facts.writerEpoch !== input.writerEpoch
          || facts.sourceRevision !== input.sourceRevision || facts.organisationId !== organisationId
          || facts.operationId !== input.operationId) throw new Error('Confluence recovery capture operation identity changed');
        return this.result(existing, true);
      }

      // Decision writers and maintenance scope registration use this same
      // Organisation lock. Read only the five immutable decision records;
      // never include integration credentials or primary/provider contents.
      const review = await tx.confluenceRetainedCopyReview.findFirst({ where: {
        id: input.reviewId, organisationId } });
      if (!review) throw new Error('Confluence recovery capture review not found in charity');
      const reviewWithdrawal = await tx.confluenceRetainedCopyReviewWithdrawal.findFirst({
        where: { organisationId, reviewId: review.id } });
      const scope = await tx.confluenceSyntheticCopyScope.findFirst({
        where: { organisationId, reviewId: review.id } });
      const permission = await tx.confluenceRetainedCopyPermission.findFirst({
        where: { organisationId, reviewId: review.id } });
      const permissionWithdrawal = permission ? await tx.confluenceRetainedCopyPermissionWithdrawal.findFirst({
        where: { organisationId, permissionId: permission.id } }) : null;
      const previous = await tx.confluenceCopyRecoveryCapture.findFirst({ where: {
        organisationId, reviewId: review.id }, orderBy: { factsRevision: 'desc' } });
      if (previous) validateConfluenceCopyRecoveryCapture(previous);
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT timezone('UTC',clock_timestamp())::timestamp(3) AS now`;
      if (!clock) throw new Error('Confluence recovery capture clock unavailable');
      const prepared = prepareConfluenceCopyRecoveryFacts(JSON.parse(JSON.stringify({
        format: 1, kind: 'CONFLUENCE_COPY_DECISION_STATE_V1', organisationId,
        installationId: input.installationId, operationId: input.operationId,
        writerEpoch: input.writerEpoch, sourceRevision: input.sourceRevision,
        factsRevision: previous ? previous.factsRevision + 1 : 1,
        previousFactsDigest: previous?.factsDigest ?? null, capturedAt: clock.now,
        review, reviewWithdrawal, scope, permission, permissionWithdrawal,
      })));
      if (previous) assertConfluenceCopyRecoveryProgression(previous.facts, prepared.body);
      const facts = JSON.parse(prepared.body) as ConfluenceCopyRecoveryFacts;
      const saved = await tx.confluenceCopyRecoveryCapture.create({ data: {
        organisationId, actorUserId, reviewId: review.id, installationId: input.installationId,
        operationId: input.operationId, writerEpoch: input.writerEpoch, sourceRevision: input.sourceRevision,
        factsRevision: facts.factsRevision, previousFactsDigest: facts.previousFactsDigest,
        capturedAt: new Date(facts.capturedAt), facts: prepared.body, factsDigest: prepared.digest,
      } });
      validateConfluenceCopyRecoveryCapture(saved);
      return this.result(saved, false);
    }, { isolationLevel: 'ReadCommitted' });
  }

  private result(row: { id: string; facts: string; factsDigest: string }, replayed: boolean) {
    return { id: row.id, body: row.facts, digest: row.factsDigest, replayed,
      actionAuthorized: false as const, currentHistoryVerified: false as const, reopeningAuthorised: false as const };
  }
}

export function validateConfluenceCopyRecoveryCapture(row: { facts: string; factsDigest: string; organisationId: string;
  reviewId: string; installationId: string; operationId: string; writerEpoch: number;
  sourceRevision: string; factsRevision: number; previousFactsDigest: string | null; capturedAt: Date }) {
  try {
    if (Buffer.byteLength(row.facts,'utf8') > CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES) throw new Error();
    const prepared = prepareConfluenceCopyRecoveryFacts(JSON.parse(row.facts));
    const facts = JSON.parse(prepared.body) as ConfluenceCopyRecoveryFacts;
    if (prepared.body !== row.facts || prepared.digest !== row.factsDigest
      || facts.organisationId !== row.organisationId || facts.review.id !== row.reviewId
      || facts.installationId !== row.installationId || facts.operationId !== row.operationId
      || facts.writerEpoch !== row.writerEpoch || facts.sourceRevision !== row.sourceRevision
      || facts.factsRevision !== row.factsRevision || facts.previousFactsDigest !== row.previousFactsDigest
      || facts.capturedAt !== row.capturedAt.toISOString()) throw new Error();
    return facts;
  } catch { throw new Error('Invalid stored Confluence recovery capture'); }
}
