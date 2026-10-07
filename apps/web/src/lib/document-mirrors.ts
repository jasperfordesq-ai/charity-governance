/**
 * The Confluence mirror state for the documents currently on screen.
 *
 * ## Why this is fetched separately from the documents themselves
 *
 * A document's response is CharityPilot's own authoritative record. The mirror
 * is an observation of somebody else's system, possibly a reconcile interval
 * out of date. The API keeps them apart deliberately (see
 * `document-mirror.service.ts`), and this module keeps the screen's behaviour
 * consistent with that: **a failure to read mirrors must never stop the
 * documents rendering.** `loadDocumentMirrors` resolves to an empty map on any
 * failure rather than throwing, and the list shows documents with no mirror
 * chip — which is the honest degradation, because "we could not ask" is not
 * "there is no Confluence page".
 *
 * The chip is simply absent in that case. It does NOT fall back to "Not
 * published", which would be a claim.
 */
import { api } from './api';
import type { ConfluenceMirror, ConfluencePublicationState, ConfluenceRemoteState } from './integration-status';

const PUBLICATION_STATES: readonly ConfluencePublicationState[] = [
  'NOT_PUBLISHED',
  'PENDING',
  'PUBLISHED',
  'FAILED',
  'RETIRED',
];

const REMOTE_STATES: readonly ConfluenceRemoteState[] = [
  'VISIBLE',
  'ARCHIVED',
  'TRASHED',
  'GONE',
  'UNKNOWN',
];

/** How many ids the API will accept on one request. Mirrors its own cap. */
export const MIRROR_REQUEST_MAX_IDS = 100;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * One mirror, validated, or null.
 *
 * Strict on the two enums and lenient on everything else. An unrecognised
 * publication state is dropped rather than rendered: a future API value this
 * build has never heard of must not be shown to a trustee as though this
 * screen understood it.
 */
export function parseDocumentMirror(value: unknown): ConfluenceMirror | null {
  const record = asRecord(value);
  if (record === null) return null;

  const publication = record.publication;
  if (typeof publication !== 'string') return null;
  if (!PUBLICATION_STATES.includes(publication as ConfluencePublicationState)) return null;

  const remoteRecord = asRecord(record.remote);
  const destinationRecord = asRecord(record.publishDestination);
  const publishDestination = destinationRecord && asNullableString(destinationRecord.siteId)
    && asNullableString(destinationRecord.spaceId) && asNullableString(destinationRecord.spaceKey)
    ? { siteId: String(destinationRecord.siteId), spaceId: String(destinationRecord.spaceId),
      spaceKey: String(destinationRecord.spaceKey),
      spaceName: typeof destinationRecord.spaceName === 'string' ? destinationRecord.spaceName : '',
      siteUrl: asNullableString(destinationRecord.siteUrl) }
    : null;
  let remote: ConfluenceMirror['remote'] = null;
  if (remoteRecord !== null) {
    const state = remoteRecord.state;
    // An unrecognised remote state reads as "not checked" rather than being
    // invented into one of ours. Showing the wrong one of TRASHED and GONE is
    // the single worst thing this screen could do.
    if (typeof state === 'string' && REMOTE_STATES.includes(state as ConfluenceRemoteState)) {
      remote = {
        state: state as ConfluenceRemoteState,
        title: asNullableString(remoteRecord.title),
        version: typeof remoteRecord.version === 'number' ? remoteRecord.version : null,
        lastReconciledAt: asNullableString(remoteRecord.lastReconciledAt),
        reconcileError: asNullableString(remoteRecord.reconcileError),
      };
    }
  }

  return {
    publication: publication as ConfluencePublicationState,
    writeOutcomeUnknown: record.writeOutcomeUnknown === true,
    // A URL requires both a recorded page ID and a usable site address. An
    // older API omits pageRecorded; a missing URL in that case is unknown,
    // never evidence that no page was created.
    pageRecorded: asNullableString(record.pageUrl) !== null
      ? true
      : typeof record.pageRecorded === 'boolean' ? record.pageRecorded : null,
    pageSiteMatchesConnection: asNullableString(record.pageUrl) !== null
      ? true
      : typeof record.pageSiteMatchesConnection === 'boolean' ? record.pageSiteMatchesConnection : null,
    recordedPageMatchesDestination: typeof record.recordedPageMatchesDestination === 'boolean'
      ? record.recordedPageMatchesDestination : null,
    connectionAvailable: typeof record.connectionAvailable === 'boolean' ? record.connectionAvailable : null,
    approvalDestinationCurrent: typeof record.approvalDestinationCurrent === 'boolean'
      ? record.approvalDestinationCurrent : null,
    publishDestination,
    pageUrl: asNullableString(record.pageUrl),
    remote,
  };
}

/** The `{ mirrors: { [documentId]: mirror } }` payload, as a map. */
export function parseDocumentMirrors(payload: unknown): Map<string, ConfluenceMirror> {
  const mirrors = new Map<string, ConfluenceMirror>();
  const record = asRecord(payload);
  const raw = asRecord(record?.mirrors);
  if (raw === null) return mirrors;

  for (const [documentId, value] of Object.entries(raw)) {
    if (documentId.length === 0) continue;
    const mirror = parseDocumentMirror(value);
    if (mirror !== null) mirrors.set(documentId, mirror);
  }
  return mirrors;
}

/**
 * Reads the mirrors for the documents on screen.
 *
 * **Never throws.** See the module header: the documents list must render
 * whether or not Confluence state can be read, and an empty map renders no
 * chips rather than wrong ones.
 */
export async function loadDocumentMirrors(
  documentIds: string[],
): Promise<Map<string, ConfluenceMirror>> {
  const ids = documentIds.filter((id) => id.length > 0).slice(0, MIRROR_REQUEST_MAX_IDS);
  if (ids.length === 0) return new Map();

  try {
    const response = await api.get('/documents/confluence-mirrors', {
      params: { ids: ids.join(',') },
    });
    return parseDocumentMirrors(response.data);
  } catch {
    // Swallowed on purpose. A charity with no Confluence integration gets an
    // ordinary answer here, but a network failure, a 500 or a logged-out
    // session must not take the documents list down with it.
    return new Map();
  }
}
