import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { currentAccessTokenForOrganisation } from './confluence-connection.service.js';
import {
  observeAttachmentVersionBytes,
  type AttachmentObservationOperations,
  type AttachmentVersionObservation,
} from './confluence-attachment-observation.js';

const OPERATION_ID = /^[0-9a-f]{32}$/;
const SITE_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.atlassian\.net$/;

function invalidBinding(): AppError {
  return new AppError(409, 'CONFLUENCE_UPLOAD_OBSERVATION_BINDING_INVALID',
    'The saved upload intent is not bound to the connected Confluence site.');
}

function invalidAttachment(): AppError {
  return new AppError(502, 'CONFLUENCE_UPLOAD_OBSERVATION_ATTACHMENT_INVALID',
    'The observed attachment title does not match the saved upload intent.');
}

function connectedHostname(config: unknown, cloudId: string): string {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw invalidBinding();
  const values = config as Record<string, unknown>;
  if (values.siteId !== cloudId || typeof values.siteUrl !== 'string') throw invalidBinding();
  let siteUrl: URL;
  try {
    siteUrl = new URL(values.siteUrl);
  } catch {
    throw invalidBinding();
  }
  if (siteUrl.protocol !== 'https:' || siteUrl.username !== '' || siteUrl.password !== ''
    || siteUrl.port !== '' || !SITE_HOST.test(siteUrl.hostname)) throw invalidBinding();
  return siteUrl.hostname;
}

/**
 * Read-only review of one saved upload attempt. Tenant, cloud site, page,
 * operation ID and expected digest come from the immutable local intent, not
 * the caller. The caller supplies only the provider attachment ID to inspect.
 * This is a candidate observation, never retry, erasure or all-copy authority.
 */
export async function observeSavedConfluenceUpload(
  prisma: PrismaClient,
  input: { organisationId: string; operationId: string; attachmentId: string; maxTotalBytes?: number },
  deps: {
    getAccessToken?: () => Promise<string>;
    fetch?: typeof globalThis.fetch;
    operations?: Partial<AttachmentObservationOperations>;
  } = {},
): Promise<AttachmentVersionObservation & { uploadOperationId: string }> {
  if (!OPERATION_ID.test(input.operationId) || typeof input.organisationId !== 'string'
    || input.organisationId.length === 0) throw invalidBinding();
  const intent = await prisma.documentPublicationUploadIntent.findFirst({
    where: { id: input.operationId, organisationId: input.organisationId },
    select: { id: true, cloudId: true, pageId: true, filename: true, sha256: true },
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
  const observation = await observeAttachmentVersionBytes({
    cloudId: intent.cloudId,
    pageId: intent.pageId,
    attachmentId: input.attachmentId,
    siteHostname,
    getAccessToken,
    expectedUpload: { operationId: intent.id, sha256: intent.sha256 },
    ...(input.maxTotalBytes === undefined ? {} : { maxTotalBytes: input.maxTotalBytes }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.operations === undefined ? {} : { operations: deps.operations }),
  });
  await assertCurrentConnection();
  if (observation.title !== intent.filename) throw invalidAttachment();
  return { ...observation, uploadOperationId: intent.id };
}
