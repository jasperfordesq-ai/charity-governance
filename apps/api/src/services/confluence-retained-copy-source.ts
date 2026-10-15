import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DOCUMENT_UPLOAD_MAX_FILE_SIZE } from './document-upload-limits.js';
import { AppError } from '../utils/app-error.js';
import { StorageService } from './storage.service.js';
import { currentAccessTokenForOrganisation } from './confluence-connection.service.js';
import { collectRetainedConfluenceCopyInventory } from './confluence-retained-copy-inventory.js';
import { parseRetainedConfluenceCopySnapshot } from './confluence-retained-copy-review.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/);
const inputSchema = z.object({ organisationId: id, actorUserId: id, publicationId: id }).strict();
const targetSchema = z.object({ cloudId: z.string().uuid(), spaceId: id.max(64), pageId: id.max(64),
  siteHostname: z.string().max(80).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/) }).strict();

function unavailable(): never {
  throw new AppError(409, 'CONFLUENCE_COPY_SOURCE_UNVERIFIED',
    'The exact retained source, publication or connected authorisation is unavailable or changed.');
}
function timestamp(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) unavailable();
  return value.toISOString();
}
function origin(config: unknown, cloudId: string): string {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) unavailable();
  const values = config as Record<string, unknown>;
  if (values.siteId !== cloudId || typeof values.siteUrl !== 'string') unavailable();
  let parsed: URL;
  try { parsed = new URL(values.siteUrl); } catch { unavailable(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || parsed.pathname !== '/' || parsed.search || parsed.hash) unavailable();
  return parsed.origin;
}

/** Read-only observation under an authenticated tenant context. The caller
 * supplies a publication ID, never provider addresses, storage paths or hashes.
 * No transaction/row lock is held across HTTP or storage reads; repeated state
 * and byte checks detect changes, but are not an atomic provider snapshot or
 * a durable execution fence. This function has no HTTP route or erasure caller.
 */
export async function observeRetainedConfluenceCopySource(
  prisma: PrismaClient, raw: unknown,
  deps: {
    downloadFile?: StorageService['downloadFile'];
    getAccessToken?: () => Promise<string>;
    collectInventory?: typeof collectRetainedConfluenceCopyInventory;
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
  } = {},
) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, 'CONFLUENCE_COPY_SOURCE_INPUT_INVALID', 'An authenticated charity, actor and publication are required.');
  const input = parsed.data;
  const checkCancelled = () => deps.signal?.throwIfAborted();
  const load = async () => {
    checkCancelled();
    const organisation = await prisma.organisation.findFirst({ where: { id: input.organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    const actor = await prisma.user.findFirst({ where: { id: input.actorUserId,
      organisationId: input.organisationId, lifecycleStatus: 'ACTIVE', role: 'OWNER' }, select: { id: true } });
    if (!organisation || !actor) throw new AppError(403, 'CONFLUENCE_COPY_SOURCE_OWNER_REQUIRED', 'An active charity Owner is required.');
    const publication = await prisma.documentPublication.findFirst({
      where: { id: input.publicationId, organisationId: input.organisationId, provider: 'confluence' },
      select: { id: true, documentId: true, state: true, cloudId: true, spaceId: true, pageId: true,
        attachmentId: true, updatedAt: true, erasureDeletionId: true, claimedAt: true },
    });
    if (!publication || publication.state !== 'RETIRED' || publication.erasureDeletionId !== null || publication.claimedAt !== null) unavailable();
    const source = await prisma.document.findFirst({
      where: { id: publication.documentId, organisationId: input.organisationId },
      select: { id: true, updatedAt: true, deletedAt: true, lifecycleStatus: true, deletionHold: true,
        externalPublicationApproved: true, fileUrl: true, fileSize: true, storageProvider: true },
    });
    if (!source || source.deletedAt !== null || source.lifecycleStatus !== 'RETIRED' || source.deletionHold
      || source.externalPublicationApproved || !['local', 'supabase'].includes(source.storageProvider ?? '')
      || !Number.isSafeInteger(source.fileSize) || source.fileSize < 0 || source.fileSize > DOCUMENT_UPLOAD_MAX_FILE_SIZE) unavailable();
    const connection = await prisma.organisationIntegration.findUnique({
      where: { organisationId_provider: { organisationId: input.organisationId, provider: 'CONFLUENCE' } },
      select: { id: true, status: true, config: true, connectedAt: true, grantedScopes: true },
    });
    if (!connection || connection.status !== 'CONNECTED' || !publication.cloudId
      || !connection.grantedScopes.includes('read:page:confluence')
      || !connection.grantedScopes.includes('read:attachment:confluence')) unavailable();
    const siteOrigin = origin(connection.config, publication.cloudId);
    const target = targetSchema.safeParse({ cloudId: publication.cloudId, spaceId: publication.spaceId,
      pageId: publication.pageId, siteHostname: new URL(siteOrigin).hostname });
    if (!target.success) unavailable();
    const connectionGeneration = timestamp(connection.connectedAt);
    const sourceRevision = timestamp(source.updatedAt);
    const publicationRevision = timestamp(publication.updatedAt);
    checkCancelled();
    return { source, publication, siteOrigin, target: target.data,
      fingerprint: JSON.stringify({ source: { ...source, updatedAt: sourceRevision },
        publication: { ...publication, updatedAt: publicationRevision },
        connectionId: connection.id, connectionGeneration, siteOrigin, target: target.data,
        scopes: [...connection.grantedScopes].sort() }) };
  };
  const initial = await load();
  const assertCurrent = async () => { if ((await load()).fingerprint !== initial.fingerprint) unavailable(); };
  const storage = new StorageService();
  const download = deps.downloadFile ?? storage.downloadFile.bind(storage);
  const readSource = async () => {
    await assertCurrent();
    const bytes = await download(input.organisationId, initial.source.fileUrl, initial.source.storageProvider!);
    checkCancelled();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== initial.source.fileSize) unavailable();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await assertCurrent(); return sha256;
  };
  const sourceSha256 = await readSource();
  const getAccessToken = async () => {
    await assertCurrent();
    const token = await (deps.getAccessToken?.() ?? currentAccessTokenForOrganisation(prisma, { organisationId: input.organisationId }));
    await assertCurrent(); return token;
  };
  const observation = await (deps.collectInventory ?? collectRetainedConfluenceCopyInventory)(initial.target, {
    getAccessToken, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.signal ? { signal: deps.signal } : {}),
  });
  await assertCurrent();
  if (observation.cloudId !== initial.target.cloudId || observation.spaceId !== initial.target.spaceId
    || observation.pageId !== initial.target.pageId || observation.siteHostname !== initial.target.siteHostname
    || observation.actionAuthorized !== false || observation.allCopiesVerified !== false
    || observation.sourceVerified !== false) unavailable();
  if (initial.publication.attachmentId !== null
    && !observation.inventory.attachments.some((a) => a.id === initial.publication.attachmentId)) unavailable();
  if (await readSource() !== sourceSha256) unavailable();
  const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT timezone('UTC', statement_timestamp())::timestamp(3) AS now`;
  const observedAt = timestamp(clock?.now);
  if (timestamp(initial.source.updatedAt) > observedAt || timestamp(initial.publication.updatedAt) > observedAt) unavailable();
  await assertCurrent();
  checkCancelled();
  return {
    snapshot: parseRetainedConfluenceCopySnapshot({ organisationId: input.organisationId, documentId: initial.source.id,
      sourceRevision: timestamp(initial.source.updatedAt), sourceSha256, lifecycleStatus: 'RETIRED',
      deletionHold: false, externalPublicationApproved: false, publicationId: initial.publication.id,
      publicationRevision: timestamp(initial.publication.updatedAt), publicationState: 'RETIRED',
      cloudId: initial.target.cloudId, siteOrigin: initial.siteOrigin, spaceId: initial.target.spaceId,
      pageId: initial.target.pageId, inventory: { ...observation.inventory, observedAt } }),
    actorUserId: input.actorUserId, sourceBytesObserved: true as const,
    syntheticVerified: false as const, allCopiesVerified: false as const, actionAuthorized: false as const,
  };
}
