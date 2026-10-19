import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import type { ConfluenceClient } from './confluence-client.js';
import { getPage } from './confluence-pages.js';
import { isPageInTrash } from './confluence-pages.js';
import { getAttachment, listTrashedAttachmentIds } from './confluence-attachments.js';
import { parseConfluenceErasureTarget } from './confluence-erasure-target.js';

type Connection = { cloudId: string; generation: string; client: ConfluenceClient };
export type ConfluenceErasureObservationDeps = {
  getConnection: () => Promise<Connection | null>;
  getPage?: typeof getPage;
  isPageInTrash?: typeof isPageInTrash;
  getAttachment?: typeof getAttachment;
  listTrashedAttachmentIds?: typeof listTrashedAttachmentIds;
};
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function confluenceErasureTargetDigest(raw: unknown) {
  return createHash('sha256').update(JSON.stringify(parseConfluenceErasureTarget(raw))).digest('hex');
}

/** Recorded targets only. Missing content can be hidden by permissions, so no
 * observation here asserts purge, completeness or authority to close a job. */
export async function observeConfluenceErasure(
  prisma: PrismaClient,
  input: { organisationId: string; deletionId: string; controlPageId: string },
  deps: ConfluenceErasureObservationDeps,
) {
  if (!identifier.test(input.deletionId) || !identifier.test(input.controlPageId)) {
    throw new AppError(400, 'CONFLUENCE_OBSERVATION_INPUT_INVALID', 'Plain recorded-target and control-page identifiers are required.');
  }
  const where = { id: input.deletionId, organisationId: input.organisationId, provider: 'confluence' };
  const row = await prisma.documentStorageDeletion.findFirst({ where, select: { id: true, targetRef: true } });
  if (!row) throw new AppError(404, 'CONFLUENCE_ERASURE_TARGET_NOT_FOUND', 'The recorded Confluence deletion target was not found.');
  const target = parseConfluenceErasureTarget(row.targetRef);
  if (!identifier.test(target.pageId) || target.attachmentIds.length > 100
    || target.attachmentIds.some(id => !identifier.test(id))
    || new Set(target.attachmentIds).size !== target.attachmentIds.length
    || target.pageId === input.controlPageId) {
    throw new AppError(409, 'CONFLUENCE_OBSERVATION_TARGET_UNSUPPORTED', 'Review the recorded target and choose a separate accessible control page.');
  }
  const targetDigest = confluenceErasureTargetDigest(target);
  const result = (status: 'VISIBLE' | 'TRASHED' | 'NOT_OBSERVED' | 'UNKNOWN', reason: string | null,
    controlPageReadable = false) => ({ deletionId: row.id, targetDigest, checkedAt: new Date().toISOString(),
    status, reason, controlPageId: input.controlPageId, controlPageReadable,
    scope: 'RECORDED_TARGET_IDS_ONLY' as const, permanentErasureVerified: false,
    allCopiesVerified: false, jobUpdated: false, providerMutationIssued: false, actionAuthorized: false });
  try {
    const connection = await deps.getConnection();
    if (!connection) return result('UNKNOWN', 'NOT_CONNECTED');
    if (connection.cloudId !== target.cloudId) return result('UNKNOWN', 'CONNECTION_CHANGED');
    const startedAt = Date.now();
    let requests = 0;
    const reader: ConfluenceClient = { request: async spec => {
      if (spec.method !== 'GET' || ++requests > 256 || Date.now() - startedAt > 30000) throw new Error('Read observation refused');
      return connection.client.request(spec);
    } };
    const readPage = deps.getPage ?? getPage;
    const control = await readPage(reader, input.controlPageId);
    if (!control || control.id !== input.controlPageId || control.status !== 'current') return result('UNKNOWN', 'CONTROL_UNAVAILABLE');
    const page = await readPage(reader, target.pageId);
    if (page && page.id !== target.pageId) return result('UNKNOWN', 'IDENTITY_MISMATCH');
    if (page && page.status !== 'current') return result('UNKNOWN', 'PAGE_STATE_UNVERIFIED');
    let status: 'VISIBLE' | 'TRASHED' | 'NOT_OBSERVED' = page ? 'VISIBLE' : 'NOT_OBSERVED';
    if (!page && await (deps.isPageInTrash ?? isPageInTrash)(reader, target.pageId)) status = 'TRASHED';
    for (const id of target.attachmentIds) {
      if (await (deps.getAttachment ?? getAttachment)(reader, id)) status = 'VISIBLE';
    }
    if (target.attachmentIds.length) {
      const trashed = await (deps.listTrashedAttachmentIds ?? listTrashedAttachmentIds)(reader);
      if (status !== 'VISIBLE' && trashed.some(id => target.attachmentIds.includes(id))) status = 'TRASHED';
    }
    const after = await deps.getConnection();
    if (!after || after.cloudId !== connection.cloudId || after.generation !== connection.generation) return result('UNKNOWN', 'CONNECTION_CHANGED');
    const current = await prisma.documentStorageDeletion.findFirst({ where, select: { id: true, targetRef: true } });
    if (!current || JSON.stringify(parseConfluenceErasureTarget(current.targetRef)) !== JSON.stringify(target)) return result('UNKNOWN', 'TARGET_CHANGED');
    // A legitimate control excludes an entirely broken connection, not a
    // permission-masked 404 for this particular target. Keep that limit explicit.
    return result(status, status === 'NOT_OBSERVED' ? 'ABSENCE_OR_ACCESS_RESTRICTION' : null, true);
  } catch {
    // Provider bodies/URLs/credentials never become dashboard diagnostics.
    return result('UNKNOWN', 'READ_FAILED');
  }
}
