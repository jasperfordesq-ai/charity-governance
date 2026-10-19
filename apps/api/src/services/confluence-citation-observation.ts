import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { getPage, isPageInTrash } from './confluence-pages.js';
import type { ConfluenceErasureObservationDeps } from './confluence-erasure-observation.js';

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const confluenceCitationObservationSelect = { id: true, documentId: true, cloudId: true, pageId: true,
  pageVersion: true, citedAt: true, updatedAt: true } as const;
export const confluenceCitationTargetDigest = (reference: unknown) => createHash('sha256').update(JSON.stringify(reference)).digest('hex');
export const liveCitationAnchor = (organisationId: string) => ({ OR: [
  { referenceKind: 'CONFLUENCE_SOURCE', documentId: null },
  { document: { organisationId, deletedAt: null } },
] });

/** A citation is evidence identity, never an instruction to dispose of content.
 * Observe only its page: citations do not record an attachment inventory. */
export async function observeConfluenceCitation(
  prisma: PrismaClient,
  input: { organisationId: string; referenceId: string; controlPageId: string },
  deps: Pick<ConfluenceErasureObservationDeps, 'getConnection' | 'getPage' | 'isPageInTrash'>,
) {
  if (!identifier.test(input.referenceId) || !identifier.test(input.controlPageId)) {
    throw new AppError(400, 'CONFLUENCE_OBSERVATION_INPUT_INVALID', 'Plain citation and control-page identifiers are required.');
  }
  const where = { id: input.referenceId, organisationId: input.organisationId,
    ...liveCitationAnchor(input.organisationId) };
  const select = confluenceCitationObservationSelect;
  const reference = await prisma.confluenceReference.findFirst({ where, select });
  if (!reference) throw new AppError(404, 'CONFLUENCE_REFERENCE_NOT_FOUND', 'That live-document citation was not found.');
  if (!identifier.test(reference.pageId) || reference.pageId === input.controlPageId) {
    throw new AppError(409, 'CONFLUENCE_OBSERVATION_TARGET_UNSUPPORTED', 'Choose a separate accessible control page.');
  }
  const snapshot = JSON.stringify(reference);
  const targetDigest = confluenceCitationTargetDigest(reference);
  const result = (status: 'VISIBLE' | 'TRASHED' | 'NOT_OBSERVED' | 'UNKNOWN', reason: string | null,
    controlPageReadable = false) => ({ referenceId: reference.id, targetDigest,
    checkedAt: new Date().toISOString(), status, reason, controlPageId: input.controlPageId,
    controlPageReadable, scope: 'CITED_PAGE_ONLY' as const, attachmentsObserved: false,
    permanentErasureVerified: false, allCopiesVerified: false, jobCreated: false,
    citationUpdated: false, providerMutationIssued: false, actionAuthorized: false });
  try {
    const connection = await deps.getConnection();
    if (!connection) return result('UNKNOWN', 'NOT_CONNECTED');
    if (connection.cloudId !== reference.cloudId) return result('UNKNOWN', 'CONNECTION_CHANGED');
    const startedAt = Date.now();
    let requests = 0;
    const reader: typeof connection.client = { request: async spec => {
      if (spec.method !== 'GET' || ++requests > 256 || Date.now() - startedAt > 30000) throw new Error('Read observation refused');
      return connection.client.request(spec);
    } };
    const readPage = deps.getPage ?? getPage;
    const control = await readPage(reader, input.controlPageId);
    if (!control || control.id !== input.controlPageId || control.status !== 'current') return result('UNKNOWN', 'CONTROL_UNAVAILABLE');
    const page = await readPage(reader, reference.pageId);
    if (page && page.id !== reference.pageId) return result('UNKNOWN', 'IDENTITY_MISMATCH');
    if (page && page.status !== 'current') return result('UNKNOWN', 'PAGE_STATE_UNVERIFIED');
    const status = page ? 'VISIBLE' : await (deps.isPageInTrash ?? isPageInTrash)(reader, reference.pageId)
      ? 'TRASHED' : 'NOT_OBSERVED';
    const after = await deps.getConnection();
    if (!after || after.cloudId !== connection.cloudId || after.generation !== connection.generation) return result('UNKNOWN', 'CONNECTION_CHANGED');
    const current = await prisma.confluenceReference.findFirst({ where, select });
    if (!current || JSON.stringify(current) !== snapshot) return result('UNKNOWN', 'TARGET_CHANGED');
    return result(status, status === 'NOT_OBSERVED' ? 'ABSENCE_OR_ACCESS_RESTRICTION' : null, true);
  } catch {
    return result('UNKNOWN', 'READ_FAILED');
  }
}
