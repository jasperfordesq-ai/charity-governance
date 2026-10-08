import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { currentAccessTokenForOrganisation } from './confluence-connection.service.js';
import { createConfluenceClient } from './confluence-client.js';
import { getPageStorage } from './confluence-pages.js';
import { confluencePageCreateOperationMarker } from './confluence-page-operation-marker.js';

const OPERATION_ID = /^[0-9a-f]{32}$/;
const PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SITE_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.atlassian\.net$/;
const MAX_BODY_BYTES = 1024 * 1024;

function invalidBinding(): AppError {
  return new AppError(409, 'CONFLUENCE_PAGE_OBSERVATION_BINDING_INVALID',
    'The saved page-create intent is not bound to the connected Confluence site.');
}

function invalidCandidate(): AppError {
  return new AppError(502, 'CONFLUENCE_PAGE_OBSERVATION_CANDIDATE_INVALID',
    'Confluence did not return a stable page matching the saved create intent.');
}

function connectedHostname(config: unknown, cloudId: string): string {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw invalidBinding();
  const values = config as Record<string, unknown>;
  if (values.siteId !== cloudId || typeof values.siteUrl !== 'string') throw invalidBinding();
  let siteUrl: URL;
  try { siteUrl = new URL(values.siteUrl); } catch { throw invalidBinding(); }
  if (siteUrl.protocol !== 'https:' || siteUrl.username !== '' || siteUrl.password !== ''
    || siteUrl.port !== '' || !SITE_HOST.test(siteUrl.hostname)) throw invalidBinding();
  return siteUrl.hostname;
}

/**
 * Read-only content candidate for one immutable page-create intent. A matching
 * title, parent and body digest do not identify the operation that created a
 * page. An exact trailing marker is only a candidate until actual provider
 * storage and version-history behavior is validated on the C01 test site.
 * Never use this result to adopt a page, retry a write, erase content or
 * close all-copy work.
 */
export async function observeSavedConfluencePageCreate(
  prisma: PrismaClient,
  input: { organisationId: string; operationId: string; pageId: string },
  deps: { getAccessToken?: () => Promise<string>; fetch?: typeof globalThis.fetch } = {},
): Promise<{
  pageCreateOperationId: string; cloudId: string; pageId: string;
  siteHostname: string; version: number; bodySha256: string;
  contentCandidate: true; operationMarkerCandidate: boolean;
  operationIdentityVerified: false; actionAuthorized: false;
}> {
  if (typeof input.organisationId !== 'string' || input.organisationId.length === 0
    || !OPERATION_ID.test(input.operationId) || !PAGE_ID.test(input.pageId)) throw invalidBinding();
  const intent = await prisma.documentPublicationPageCreateIntent.findFirst({
    where: { id: input.operationId, organisationId: input.organisationId },
    select: { id: true, cloudId: true, spaceId: true, parentPageId: true,
      title: true, bodySha256: true },
  });
  if (intent === null) throw invalidBinding();
  const integration = await prisma.organisationIntegration.findUnique({
    where: { organisationId_provider: { organisationId: input.organisationId, provider: 'CONFLUENCE' } },
    select: { id: true, status: true, config: true },
  });
  if (integration?.status !== 'CONNECTED') throw invalidBinding();
  const siteHostname = connectedHostname(integration.config, intent.cloudId);
  const assertCurrentConnection = async (): Promise<void> => {
    const current = await prisma.organisationIntegration.findUnique({
      where: { organisationId_provider: { organisationId: input.organisationId, provider: 'CONFLUENCE' } },
      select: { id: true, status: true, config: true },
    });
    if (current?.id !== integration.id || current.status !== 'CONNECTED'
      || connectedHostname(current.config, intent.cloudId) !== siteHostname) throw invalidBinding();
  };
  const getAccessToken = async (): Promise<string> => {
    await assertCurrentConnection();
    const token = await (deps.getAccessToken?.()
      ?? currentAccessTokenForOrganisation(prisma, { organisationId: input.organisationId }));
    await assertCurrentConnection();
    return token;
  };
  const client = createConfluenceClient({ cloudId: intent.cloudId, getAccessToken },
    deps.fetch === undefined ? {} : { fetch: deps.fetch });
  const read = async () => {
    await assertCurrentConnection();
    const result = await getPageStorage(client, input.pageId);
    await assertCurrentConnection();
    if (result === null || result.page.spaceId !== intent.spaceId
      || result.page.title !== intent.title || result.parentId !== intent.parentPageId
      || !Number.isSafeInteger(result.page.version) || result.page.version < 1) throw invalidCandidate();
    const bytes = Buffer.byteLength(result.bodyStorage, 'utf8');
    if (bytes > MAX_BODY_BYTES) throw invalidCandidate();
    const digest = createHash('sha256').update(result.bodyStorage, 'utf8').digest('hex');
    if (digest !== intent.bodySha256) throw invalidCandidate();
    const marker = confluencePageCreateOperationMarker(intent.id);
    const operationMarkerCandidate = result.bodyStorage.endsWith(marker)
      && result.bodyStorage.indexOf(marker) === result.bodyStorage.length - marker.length;
    return { version: result.page.version, digest, operationMarkerCandidate };
  };
  const first = await read();
  const second = await read();
  if (second.version !== first.version || second.digest !== first.digest
    || second.operationMarkerCandidate !== first.operationMarkerCandidate) throw invalidCandidate();
  return { pageCreateOperationId: intent.id, cloudId: intent.cloudId, pageId: input.pageId,
    siteHostname, version: first.version, bodySha256: first.digest,
    contentCandidate: true, operationMarkerCandidate: first.operationMarkerCandidate,
    operationIdentityVerified: false, actionAuthorized: false };
}
