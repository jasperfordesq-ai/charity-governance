import { z } from 'zod';
import { AppError } from '../utils/app-error.js';
import { createConfluenceClient } from './confluence-client.js';
import { getPage } from './confluence-pages.js';
import { listAttachments, listAttachmentVersions } from './confluence-attachments.js';
import { listConfluencePageVersions } from './confluence-page-versions.js';
import { observeAttachmentVersionBytes } from './confluence-attachment-observation.js';
import { readAttachmentVersionBytes } from './confluence-attachment-readback.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const inputSchema = z.object({
  cloudId: z.string().uuid(), pageId: id, spaceId: id,
  siteHostname: z.string().max(80).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/),
  maxAttachments: z.number().int().min(1).max(100).default(100),
  maxTotalBytes: z.number().int().min(1).max(MAX_TOTAL_BYTES).default(MAX_TOTAL_BYTES),
}).strict();

function invalid(): AppError {
  return new AppError(502, 'CONFLUENCE_COPY_INVENTORY_UNVERIFIED',
    'The exact Confluence copy did not yield a stable bounded inventory and version-byte observation.');
}

/** Read-only facts for one exact page. This does not establish tenant/synthetic
 * authority, local source bytes, a disposal policy or all provider-held copies.
 * Its eventual caller must derive the target and credentials from checked
 * server-side publication/connection state, never request-supplied identifiers.
 */
export async function collectRetainedConfluenceCopyInventory(
  raw: unknown,
  deps: { getAccessToken: () => Promise<string>; fetch?: typeof globalThis.fetch; signal?: AbortSignal; now?: () => Date },
) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success || typeof deps.getAccessToken !== 'function') {
    throw new AppError(400, 'CONFLUENCE_COPY_INVENTORY_INPUT_INVALID', 'An exact Confluence target and bounded read limits are required.');
  }
  const input = parsed.data;
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(deps.signal ? [deps.signal] : [])]);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const fetchBound: typeof globalThis.fetch = async (url, init) => {
    signal.throwIfAborted();
    const response = await fetchImpl(url, { ...init,
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
    if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
    return response;
  };
  const getAccessToken = async () => {
    signal.throwIfAborted(); const token = await deps.getAccessToken(); signal.throwIfAborted(); return token;
  };
  const client = createConfluenceClient({ cloudId: input.cloudId, getAccessToken }, { fetch: fetchBound });
  const readState = async () => {
    signal.throwIfAborted();
    const page = await getPage(client, input.pageId);
    if (!page || page.id !== input.pageId || page.spaceId !== input.spaceId || page.status !== 'current'
      || !Number.isSafeInteger(page.version) || page.version < 1) throw invalid();
    const pageVersions = await listConfluencePageVersions(client, input.pageId, 1000, signal);
    if (pageVersions[pageVersions.length - 1] !== page.version) throw invalid();
    const listed = await listAttachments(client, input.pageId, signal);
    if (listed.length > input.maxAttachments) throw invalid();
    const seen = new Set<string>();
    const attachments = listed.map((a) => {
      if (!id.safeParse(a.id).success || seen.has(a.id) || !Number.isSafeInteger(a.versionNumber)
        || a.versionNumber! < 1 || !Number.isSafeInteger(a.fileSize) || a.fileSize < 0) throw invalid();
      seen.add(a.id);
      return { id: a.id, title: a.title, currentVersion: a.versionNumber!, sizeBytes: a.fileSize };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    signal.throwIfAborted();
    return { title: page.title, currentPageVersion: page.version, pageVersions, attachments };
  };
  const initial = await readState();
  const fingerprint = JSON.stringify(initial);
  let downloadedBytes = 0;
  const attachments: Array<{ id: string; currentVersion: number; versions: Array<{ number: number; sha256: string; sizeBytes: number }> }> = [];
  for (const attachment of initial.attachments) {
    signal.throwIfAborted();
    const remaining = input.maxTotalBytes - downloadedBytes;
    if (remaining <= 0) throw invalid();
    const observation = await observeAttachmentVersionBytes({
      cloudId: input.cloudId, siteHostname: input.siteHostname, pageId: input.pageId,
      attachmentId: attachment.id, getAccessToken, fetch: fetchBound, maxTotalBytes: remaining,
      operations: { readAttachmentVersionBytes: async (request) => {
        signal.throwIfAborted();
        const available = input.maxTotalBytes - downloadedBytes;
        if (available <= 0) throw invalid();
        const result = await readAttachmentVersionBytes({ ...request,
          maxBytes: Math.min(request.maxBytes ?? available, available) });
        signal.throwIfAborted();
        if (!Number.isSafeInteger(result.byteLength) || result.byteLength < 0 || result.byteLength > available) throw invalid();
        downloadedBytes += result.byteLength; // Includes every repeated-current download.
        return result;
      } },
    });
    if (observation.currentVersionNumber !== attachment.currentVersion || observation.title !== attachment.title
      || observation.versions.find((v) => v.number === attachment.currentVersion)?.byteLength !== attachment.sizeBytes) throw invalid();
    attachments.push({ id: attachment.id, currentVersion: observation.currentVersionNumber,
      versions: observation.versions.map((v) => ({ number: v.number, sha256: v.sha256, sizeBytes: v.byteLength })) });
  }
  if (JSON.stringify(await readState()) !== fingerprint) throw invalid();
  // The first attachment's history can change while later files are read.
  // Revisit every recorded history after all byte observations have completed.
  for (const attachment of attachments) {
    signal.throwIfAborted();
    const history = await listAttachmentVersions(client, attachment.id, 32);
    const numbers = history.map((v) => v.number).sort((a, b) => a - b);
    if (JSON.stringify(numbers) !== JSON.stringify(attachment.versions.map((v) => v.number))) throw invalid();
  }
  if (JSON.stringify(await readState()) !== fingerprint) throw invalid();
  signal.throwIfAborted();
  const observedAt = (deps.now ?? (() => new Date()))();
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) throw invalid();
  return {
    cloudId: input.cloudId, siteHostname: input.siteHostname, pageId: input.pageId, spaceId: input.spaceId,
    inventory: { observedAt: observedAt.toISOString(), status: 'CURRENT' as const, complete: true as const,
      currentPageVersion: initial.currentPageVersion, pageVersions: initial.pageVersions, attachments },
    downloadedBytes, actionAuthorized: false as const, allCopiesVerified: false as const,
    sourceVerified: false as const,
  };
}
