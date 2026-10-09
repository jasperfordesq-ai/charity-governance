import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prepareDocumentRecoveryFacts, type DocumentRecoveryFacts } from './document-recovery-preparation.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const controlIdentity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const captureInput = z.object({ installationId: controlIdentity, operationId: controlIdentity,
  writerEpoch: z.number().int().positive().max(2147483647), authorizationId: identity,
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
const policySelect = { id: true, organisationId: true, recordClass: true, revision: true,
  state: true, retentionMode: true, retentionAnchor: true, retentionDays: true, retentionYears: true,
  recoveryDays: true, createdById: true, createdAt: true, approvedById: true,
  approvedAt: true, approvalEvidenceRef: true } as const;
const documentSelect = { id: true, organisationId: true, updatedAt: true, createdAt: true,
  lifecycleStatus: true, deletedAt: true, deletionHold: true, approvalAsserted: true,
  approvedByResolutionId: true, deletedById: true, removedFromRevision: true,
  removalEvidenceRef: true, recoveryPolicyId: true, recoveryUntil: true,
  recoverySha256: true, fileUrl: true, storageProvider: true, fileSize: true } as const;
const authorizationSelect = { id: true, organisationId: true, documentId: true,
  documentRevision: true, policyId: true, actorUserId: true, evidenceRef: true,
  reason: true, storagePath: true, provider: true, sha256: true, fileSize: true,
  recoveryUntil: true, dispositionPlan: true, authorizedAt: true,
  claim: { select: { id: true } }, withdrawal: { select: { id: true } } } as const;

/** Inactive local candidate capture. Nothing here reserves the independent
 * writer, publishes facts, authorizes a claim or dispatches the byte worker. */
export class DocumentRecoveryPreparationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async capture(organisationId: string, actorUserId: string, raw: unknown) {
    const input = captureInput.parse(raw);
    return this.prisma.$transaction(async tx => {
      await lockOrganisationForUpdate(tx, organisationId);
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actorUserId} AND "organisationId"=${organisationId} FOR SHARE`;
      const actor = await tx.user.findFirst({ where: { id: actorUserId, organisationId,
        lifecycleStatus: 'ACTIVE', role: 'OWNER' }, select: { id: true } });
      if (!actor) throw new Error('Document recovery preparation requires active charity Owner');

      const existing = await tx.documentRecoveryPreparation.findUnique({
        where: { organisationId_operationId: { organisationId, operationId: input.operationId } } });
      if (existing) {
        const prepared = prepareDocumentRecoveryFacts(JSON.parse(existing.facts));
        const facts = JSON.parse(prepared.body) as DocumentRecoveryFacts;
        if (prepared.body !== existing.facts || prepared.digest !== existing.factsDigest
          || facts.organisationId !== organisationId || facts.actorUserId !== actorUserId
          || facts.installationId !== input.installationId || facts.operationId !== input.operationId
          || facts.writerEpoch !== input.writerEpoch || facts.sourceRevision !== input.sourceRevision
          || facts.authorization.id !== input.authorizationId) {
          throw new Error('Document recovery operation identity changed');
        }
        return { id: existing.id, digest: existing.factsDigest,
          replayed: true, actionAuthorized: false as const };
      }

      const auth = await tx.documentPurgeAuthorization.findFirst({
        where: { id: input.authorizationId, organisationId }, select: authorizationSelect });
      if (!auth || auth.claim || auth.withdrawal || auth.actorUserId !== actorUserId) {
        throw new Error('Document recovery preparation requires unclaimed unwithdrawn Owner review');
      }
      const { claim: _claim, withdrawal: _withdrawal, ...authorization } = auth;
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${auth.documentId} AND "organisationId"=${organisationId} FOR UPDATE`;
      const document = await tx.document.findFirst({ where: { id: auth.documentId, organisationId,
        deletedAt: { not: null } }, select: documentSelect });
      if (!document || document.deletionHold || document.lifecycleStatus !== 'DRAFT'
        || document.approvalAsserted || document.approvedByResolutionId) {
        throw new Error('Document recovery preparation requires an eligible removed draft');
      }
      const policies = await tx.dataRetentionPolicyRevision.findMany({ where: { organisationId,
        recordClass: 'VAULT_DRAFT', state: 'APPROVED', withdrawal: { is: null } },
        take: 2, select: policySelect });
      if (policies.length !== 1 || policies[0]!.id !== auth.policyId) {
        throw new Error('Document recovery preparation policy changed');
      }
      const removalPolicy = await tx.dataRetentionPolicyRevision.findFirst({ where: {
        id: document.recoveryPolicyId ?? '', organisationId }, select: policySelect });
      if (!removalPolicy) throw new Error('Document recovery preparation removal policy missing');
      const removalPolicyWithdrawal = await tx.dataRetentionPolicyWithdrawal.findFirst({ where: {
        policyId: removalPolicy.id, organisationId },
        select: { id: true, organisationId: true, policyId: true, actorUserId: true,
          reason: true, evidenceRef: true, occurredAt: true } });
      const standards = await tx.documentStandardLink.count({ where: { documentId: document.id } });
      const references = await tx.confluenceReference.count({ where: { documentId: document.id } });
      const replacements = await tx.document.count({ where: { organisationId,
        supersededByDocumentId: document.id } });
      if (standards || references || replacements) {
        throw new Error('Document recovery preparation requires linked evidence review');
      }
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC',clock_timestamp())::timestamp(3) AS now`;
      const rawFacts = { format: 1, action: 'DOCUMENT_PURGE_PREPARATION',
        installationId: input.installationId, organisationId, operationId: input.operationId,
        writerEpoch: input.writerEpoch, actorUserId, preparedAt: clock!.now,
        sourceRevision: input.sourceRevision, document, authorization,
        policy: policies[0], removalPolicy, removalPolicyWithdrawal };
      const prepared = prepareDocumentRecoveryFacts(JSON.parse(JSON.stringify(rawFacts)));
      const facts = JSON.parse(prepared.body) as DocumentRecoveryFacts;
      const row = await tx.documentRecoveryPreparation.create({ data: { organisationId,
        installationId: facts.installationId, operationId: facts.operationId,
        writerEpoch: facts.writerEpoch, authorizationId: facts.authorization.id,
        actorUserId, facts: prepared.body, factsDigest: prepared.digest },
        select: { id: true, factsDigest: true } });
      return { id: row.id, digest: row.factsDigest,
        replayed: false, actionAuthorized: false as const };
    }, { isolationLevel: 'ReadCommitted' });
  }
}
