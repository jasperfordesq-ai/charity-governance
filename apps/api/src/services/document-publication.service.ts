import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { formatProviderError } from '../utils/provider-errors.js';
import type { ConfluenceClient } from './confluence-client.js';
import { createConfluenceClient } from './confluence-client.js';
import {
  currentAccessTokenForOrganisation,
  type ConfluenceConnectionClient,
  type ConfluenceConnectionDeps,
} from './confluence-connection.service.js';
import {
  createPage as createPageDefault,
  findPageByTitle as findPageByTitleDefault,
  setContentProperty as setContentPropertyDefault,
  type ConfluencePage,
  type CreatePageInput,
} from './confluence-pages.js';
import {
  uploadAttachment as uploadAttachmentDefault,
  type ConfluenceAttachment,
  type UploadAttachmentInput,
} from './confluence-attachments.js';
import {
  confluencePublishTargetForOrganisation,
  type ConfluencePublishTarget,
  type PublishTargetClient,
} from './confluence-publish-target.service.js';
import {
  CHARITYPILOT_PROPERTY_KEY,
  publicationBody,
  publicationProperty,
  publicationTitle,
  type PublicationDocument,
} from './confluence-document-mapping.js';
import { parseConfluenceErasureTarget, type ConfluenceErasureTarget } from './confluence-erasure-target.js';

/**
 * The publish worker: the sequence that turns a `DocumentPublication` row into
 * a page in a charity's own Confluence site, and the outbox that runs it.
 *
 * ## The hazard this module exists to manage
 *
 * `createPage` is deliberately **non-idempotent** (`confluence-pages.ts` says
 * so and pins it), because a retried create after a dropped connection or a
 * 429 produces **two pages for one board resolution, with nothing saying which
 * is real.** This module puts that call behind a retrying outbox, so the
 * sequence here is **create-or-adopt**, never create-and-retry:
 *
 * 1. A page id this row already recorded is adopted outright — no lookup, no
 *    create.
 * 2. Otherwise `findPageByTitle`. Found → adopt it.
 * 3. Otherwise `createPage`. On `CONFLUENCE_CONFLICT` (409) — which Confluence
 *    also uses for a duplicate title, exactly the case where a previous
 *    attempt already succeeded — **re-read by title once** and adopt what that
 *    attempt made. Only if the re-read finds nothing is the 409 genuine, and
 *    it dead-letters.
 *
 * **The upstream error body is never read to disambiguate.** The adopt
 * decision comes entirely from an independent re-read. Reading the body would
 * carve a hole in the containment rule that exists because a proxy once put a
 * live authorization code in an error body.
 *
 * ## The page id is recorded before the attachment upload
 *
 * {@link PublicationAttempt.recordPage} is called the moment a page id is
 * known and **before** anything is uploaded to it. A page id learned and then
 * lost is the one way this pipeline duplicates: `findPageByTitle` is a search,
 * and a page created seconds ago is not promised to be visible to it yet, so a
 * crash between create and attach must not depend on the search to recover.
 * The row remembers instead.
 *
 * That write deliberately carries **no abort guard**: recording a page that
 * exists is fail-safe in the only direction that matters, and refusing to
 * record it because the attempt ran out of time is precisely how the id gets
 * lost.
 *
 * ## The document can vanish mid-attempt — the other half of a two-file ruling
 *
 * `document.service.ts`'s `retireConfluencePublication` is the owner's
 * 2026-09-19 ruling that an ordinary deletion must leave a published
 * Confluence page in place: it retires (never erases) a publication row that
 * already names a page. But a worker still inside this module's `createPage`
 * HTTP call when the document is deleted has issued no database write yet, so
 * `retireConfluencePublication`'s row lock closes on nothing — both of its
 * passes see `pageId` still null, and it can only park the row (stop the
 * retry loop; `claimedAt` is deliberately left alone, because an attempt may
 * still be holding it). This worker then lands the page id moments later,
 * on a row `remove()` has already finished with and will never revisit.
 *
 * So this module retires the row itself: {@link
 * DocumentPublicationService.retirePublicationIfDocumentGone} runs
 * immediately after `recordPage` succeeds, the one moment that holds both
 * facts at once — the page id just written, and the document's absence.
 * Between the two files, every ordering the delete and the publish worker can
 * race in ends the same way: retired, never erased, never stranded PENDING.
 *
 * ## The target is validated with the parser that will read it
 *
 * Phase 5's `parseConfluenceErasureTarget` is the arbiter of what an erasure
 * target may be, and its `isNonEmptyString` refuses an untrimmed id
 * **permanently**. An untrimmed id written here would publish happily, read
 * `PROCESSED`, and only fail when a charity asked for erasure — *after* the
 * authoritative Irish copy was already gone, blaming the wrong phase. So the
 * ids this worker is about to store go through that same parser first, and a
 * publish that cannot produce a valid target fails **as a publish**, which is
 * recoverable: the charity is simply not mirrored yet.
 *
 * ## Permanent versus transient
 *
 * Permanent, dead-lettering on the first attempt, because retrying acquires
 * none of the things missing: no live connection or no chosen destination, a
 * 403 on a write, an unresolved 409, an ambiguous title, a page recorded on a
 * site the charity has left, an over-ceiling content property, and a target
 * the erasure parser refuses.
 *
 * Everything else — transport, 5xx, 429, a timeout, a refresh already in
 * flight, a 401 on one request — is transient and goes back through the
 * ordinary claim/backoff loop. A predicate that answered "permanent" to
 * everything would satisfy each permanent test above while turning a
 * five-minute Atlassian blip into dead-letters a human clears by hand, so
 * {@link PERMANENT_PUBLICATION_TERMINAL_REASONS} is pinned in both directions.
 */

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

export type DocumentPublicationState = 'PENDING' | 'DEAD_LETTER' | 'PROCESSED' | 'RETIRED';

/**
 * Task 1 shipped these six and no more. A permanent condition maps onto one of
 * them; adding a seventh means a migration and a reason, so a condition with
 * no home here stays transient and exhausts its attempts instead — which is
 * honest (an attempt really was made, five times) rather than inventing
 * vocabulary an operator has never seen.
 */
export type DocumentPublicationTerminalReason =
  | 'MAX_ATTEMPTS_EXHAUSTED'
  | 'PERMANENT_CONNECTION_UNAVAILABLE'
  | 'PERMANENT_PERMISSION_DENIED'
  | 'PERMANENT_CONFLICT_UNRESOLVED'
  | 'PERMANENT_CONTENT_PROPERTY_REJECTED'
  | 'PERMANENT_TARGET_REF_REJECTED';

export type DocumentPublicationRecord = {
  id: string;
  organisationId: string;
  documentId: string;
  provider: string;
  /** The site the page went to. Recorded, never re-resolved — see the erasure target. */
  cloudId: string | null;
  spaceId: string | null;
  pageId: string | null;
  attachmentId: string | null;
  pageTitle: string | null;
  publishedAt: Date | null;
  state: DocumentPublicationState;
  attempts: number;
  claimedAt: Date | null;
  nextAttemptAt: Date | null;
  deadLetteredAt: Date | null;
  terminalReason: DocumentPublicationTerminalReason | null;
  alertClaimToken: string | null;
  alertClaimedAt: Date | null;
  alertedAt: Date | null;
  lastError?: string | null;
  lastAttemptAt?: Date | null;
  processedAt?: Date | null;
  /** Set only by retirement — see `retirePublicationIfDocumentGone` and `document.service.ts`'s `retireConfluencePublication`. */
  retiredAt?: Date | null;
  retiredStoragePath?: string | null;
  createdAt?: Date;
};

const PUBLICATION_CLAIM_STALE_AFTER_MS = 15 * 60 * 1000;
const PUBLICATION_ALERT_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;
const PUBLICATION_RETRY_BASE_MS = 5 * 60 * 1000;
const PUBLICATION_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

export const DOCUMENT_PUBLICATION_MAX_ATTEMPTS = 5;

/**
 * See {@link DocumentPublicationService.retirePublicationIfDocumentGone} for
 * why this message exists alongside `document.service.ts`'s
 * `RETIRED_PUBLICATION_MESSAGE` rather than sharing it: the two are the same
 * ruling, told from the two different moments it can be discovered.
 */
const PUBLICATION_RETIRED_MID_ATTEMPT_MESSAGE =
  'The document was deleted in CharityPilot while this page was being published. The Confluence ' +
  'page was deliberately left in place; destroying it is a separate, explicitly authorised erasure.';

/**
 * One attempt downloads up to 10 MB from Supabase and pushes it to Atlassian,
 * so the deletion pipeline's 10-second bound is far too tight here. This is a
 * bound, not a promise: the Confluence client keeps its own per-request
 * deadline, and the abort is what stops the sequence issuing anything further.
 */
export const DOCUMENT_PUBLICATION_ATTEMPT_TIMEOUT_MS = 60_000;

export const DOCUMENT_PUBLICATION_CLAIM_SAFETY_MARGIN_MS = 60_000;

/**
 * The most rows one run may claim: enough that the slowest possible batch
 * still finishes inside the claim lease, with a minute to spare. Claiming more
 * would let a lease expire under a run still working on it, and a second
 * worker would then start the same publication concurrently.
 */
export const DOCUMENT_PUBLICATION_MAX_CLAIM_BATCH = Math.floor(
  (PUBLICATION_CLAIM_STALE_AFTER_MS - DOCUMENT_PUBLICATION_CLAIM_SAFETY_MARGIN_MS) /
    DOCUMENT_PUBLICATION_ATTEMPT_TIMEOUT_MS,
);

export function documentPublicationRetryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError('Document publication attempt must be a positive integer');
  }
  return Math.min(PUBLICATION_RETRY_BASE_MS * (2 ** (attempt - 1)), PUBLICATION_RETRY_MAX_MS);
}

type DeadLetterAlertClaim = {
  claimToken: string;
  ids: string[];
};

export type DocumentPublicationRunResult = {
  processed: number;
  failed: number;
  retryScheduled: number;
  newlyDeadLettered: number;
  deadLetterAlert: DeadLetterAlertClaim | null;
};

type QueryRaw = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

type DocumentPublicationDelegate = {
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  findFirst(args: {
    where: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<DocumentPublicationRecord | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
    take: number;
    select?: Record<string, boolean>;
  }): Promise<DocumentPublicationRecord[]>;
};

type DocumentPublicationClient = {
  documentPublication: DocumentPublicationDelegate;
  $queryRaw?: QueryRaw;
  $transaction?: <T>(callback: (tx: DocumentPublicationClient) => Promise<T>) => Promise<T>;
};

function publicationDelegate(prisma: unknown): DocumentPublicationDelegate {
  return (prisma as DocumentPublicationClient).documentPublication;
}

// ---------------------------------------------------------------------------
// The erasure target this pipeline is obliged to produce
// ---------------------------------------------------------------------------

/**
 * The `targetRef` a published row names, in Phase 5's shape **exactly**.
 *
 * Built through `parseConfluenceErasureTarget` rather than beside it, so the
 * writer and the reader cannot drift: anything the eraser would refuse is
 * refused here, at publish time, while the failure is still recoverable. The
 * row carries one `attachmentId`; the target carries an array, and an
 * unattached page yields an empty one rather than a fabricated entry.
 */
export function publicationErasureTarget(row: {
  cloudId: string | null;
  pageId: string | null;
  attachmentId: string | null;
}): ConfluenceErasureTarget {
  return parseConfluenceErasureTarget({
    kind: 'confluence',
    cloudId: row.cloudId,
    pageId: row.pageId,
    attachmentIds: row.attachmentId === null ? [] : [row.attachmentId],
  });
}

// ---------------------------------------------------------------------------
// The publisher contract
// ---------------------------------------------------------------------------

/** What the worker learns the instant a page exists, and records before uploading to it. */
export type PublishedPage = {
  cloudId: string;
  spaceId: string;
  pageId: string;
  pageTitle: string;
};

export type PublicationOutcome = PublishedPage & {
  attachmentId: string;
  /** Validated by the same parser Phase 5's eraser reads it with. */
  targetRef: ConfluenceErasureTarget;
};

export type PublicationAttempt = {
  row: DocumentPublicationRecord;
  signal?: AbortSignal;
  /**
   * Records where the page is, before a single byte is uploaded to it.
   * Throws if the row is no longer this attempt's to write — a claim lost
   * mid-flight must stop the sequence, not upload on another worker's behalf.
   */
  recordPage(page: PublishedPage): Promise<void>;
};

export type Publisher = (attempt: PublicationAttempt) => Promise<PublicationOutcome>;

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/**
 * Permanent failures, and the terminal reason each maps to. Everything absent
 * from this table is transient — including every code the HTTP core raises for
 * a 5xx, a rate limit, an indeterminate write or an unreachable host, and
 * including `CONFLUENCE_RECONNECT_REQUIRED` raised by one 401, which says
 * nothing about the stored connection.
 */
const PERMANENT_PUBLICATION_TERMINAL_REASONS: Record<string, DocumentPublicationTerminalReason> = {
  // No connection to publish through, and no destination to publish into.
  // Retrying acquires neither; a human reconnects or chooses a space.
  CONFLUENCE_NOT_CONNECTED: 'PERMANENT_CONNECTION_UNAVAILABLE',
  CONFLUENCE_PUBLISH_DESTINATION_MISSING: 'PERMANENT_CONNECTION_UNAVAILABLE',
  // A 403 on a write. Reconnecting cannot grant a permission the account never
  // had, and no retry acquires one either.
  CONFLUENCE_PUBLISH_FORBIDDEN: 'PERMANENT_PERMISSION_DENIED',
  // A 409 on the create whose re-read found nothing to adopt.
  CONFLUENCE_PUBLISH_CONFLICT_UNRESOLVED: 'PERMANENT_CONFLICT_UNRESOLVED',
  // Two pages already carry this title. Publishing into either is a guess, and
  // a guess attaches one charity's document to an arbitrary page.
  CONFLUENCE_PAGE_TITLE_AMBIGUOUS: 'PERMANENT_CONFLICT_UNRESOLVED',
  // The row names a page on a site this charity is no longer connected to.
  CONFLUENCE_PUBLISH_SITE_CHANGED: 'PERMANENT_CONFLICT_UNRESOLVED',
  CONFLUENCE_CONTENT_PROPERTY_TOO_LARGE: 'PERMANENT_CONTENT_PROPERTY_REJECTED',
  CONFLUENCE_CONTENT_PROPERTY_INVALID: 'PERMANENT_CONTENT_PROPERTY_REJECTED',
  // The erasure parser refused the target this publish was about to record.
  ERASURE_TARGET_MALFORMED: 'PERMANENT_TARGET_REF_REJECTED',
};

function permanentPublicationTerminalReason(error: unknown): DocumentPublicationTerminalReason | null {
  if (!(error instanceof AppError)) return null;
  return Object.prototype.hasOwnProperty.call(PERMANENT_PUBLICATION_TERMINAL_REASONS, error.code)
    ? PERMANENT_PUBLICATION_TERMINAL_REASONS[error.code]
    : null;
}

/**
 * A charity whose Confluence connection is gone or unusable. The same shape,
 * and the same reasoning, as `confluence-erasure.ts`: retrying reconnects
 * nothing, so this is permanent and the message says what a human must do.
 */
function notConnected(organisationId: string, cause: unknown): AppError {
  return new AppError(
    409,
    'CONFLUENCE_NOT_CONNECTED',
    'This organisation has no live Confluence connection, so its governance document cannot be ' +
      'published. Retrying will not reconnect it — a human must reconnect the site. The ' +
      'authoritative copy in CharityPilot is unaffected.',
    { organisationId, cause: cause instanceof AppError ? cause.code : undefined },
  );
}

/**
 * Connected, but with nowhere to publish: no space was ever chosen, or the
 * space belongs to a site this charity has since left. Permanent for the same
 * reason — a destination is a human's choice, not something a retry supplies.
 */
function destinationMissing(organisationId: string): AppError {
  return new AppError(
    409,
    'CONFLUENCE_PUBLISH_DESTINATION_MISSING',
    'This organisation has no Confluence space chosen to publish into, so there is nowhere to ' +
      'publish this document. Retrying will not choose one — an administrator must pick a space ' +
      'on the integrations screen.',
    { organisationId },
  );
}

/**
 * The row already names a page on a different site.
 *
 * Publishing anyway would overwrite `cloudId` and `pageId` with the new site's
 * and leave the first page in the charity's old site with nothing remembering
 * where it is — an unerasable copy of a governance document, which is the
 * outcome this whole phase exists to prevent. A human decides.
 */
function siteChanged(recordedCloudId: string, currentCloudId: string): AppError {
  return new AppError(
    409,
    'CONFLUENCE_PUBLISH_SITE_CHANGED',
    `This document was already published to Confluence site ${recordedCloudId}, but this ` +
      `organisation now publishes to ${currentCloudId}. Publishing again would leave the first ` +
      'page behind with nothing recording where it is, so it has not been republished. A human ' +
      'must erase or adopt the original page first.',
    { recordedCloudId, currentCloudId },
  );
}

/**
 * A 409 on the create whose re-read found no page to adopt.
 *
 * This is the only genuinely unresolved conflict: Confluence refused the
 * create and nothing with that title exists to have caused it. Permanent —
 * every further attempt asks the same question and gets the same answer.
 */
function conflictUnresolved(spaceId: string, title: string): AppError {
  return new AppError(
    409,
    'CONFLUENCE_PUBLISH_CONFLICT_UNRESOLVED',
    `Confluence refused to create the page "${title}" in space ${spaceId} as a conflict, but a ` +
      'search of that space found no page with that title to adopt. Nothing was published, and ' +
      'no second page was created. A human must look at the space.',
    { spaceId, title },
  );
}

/**
 * A 403 on a write.
 *
 * The message names what is missing rather than saying "forbidden", because
 * the operator who reads it has to act on it, and the two remedies (grant the
 * space permission, or reconnect with the scope) are different actions.
 */
function publishForbidden(operation: string, spaceKey: string, cause: unknown): AppError {
  return new AppError(
    403,
    'CONFLUENCE_PUBLISH_FORBIDDEN',
    `Confluence refused to ${operation} in space ${spaceKey}: the connected grant lacks the ` +
      'permission to write there. Retrying will not acquire it — somebody with space ' +
      'administration rights must grant this account permission to add pages and attachments, ' +
      'or the site must be reconnected with that scope. Nothing was published.',
    {
      spaceKey,
      operation,
      // Carried through so a header-stripping proxy (see
      // `confluence-attachments.ts`) is still visible to whoever reads the row.
      cause: cause instanceof AppError ? cause.details : undefined,
    },
  );
}

/**
 * The attempt was abandoned part-way by the bounded runner. Transient: the row
 * records a failed attempt and the next one resumes, adopting the page this
 * one recorded rather than creating a second.
 */
function aborted(): AppError {
  return new AppError(
    504,
    'CONFLUENCE_PUBLISH_ABORTED',
    'The Confluence publish attempt was aborted before it finished. Nothing it had not already ' +
      'issued was issued.',
  );
}

/**
 * The row stopped being this attempt's to write — another worker claimed it,
 * or the lease expired. Transient, and it stops the sequence *before* the
 * upload: two workers uploading to one page is how a charity's record grows
 * versions nobody asked for.
 */
function claimLost(publicationId: string): AppError {
  return new AppError(
    409,
    'DOCUMENT_PUBLICATION_CLAIM_LOST',
    'This publication is no longer claimed by this attempt, so nothing further was uploaded.',
    { publicationId },
  );
}

/** The document this publication names is gone. Transient; see the module header. */
function documentMissing(documentId: string): AppError {
  return new AppError(
    404,
    'DOCUMENT_NOT_FOUND',
    `Document ${documentId} no longer exists, so there is nothing to publish.`,
    { documentId },
  );
}

/**
 * The document vanished *after* this attempt recorded a page for it — not
 * transient, and not a failure at all: see
 * {@link DocumentPublicationService.retirePublicationIfDocumentGone}, which
 * has already retired the row by the time this is thrown. The throw exists
 * only to stop `publish()` continuing into `downloadFile` against bytes an
 * ordinary deletion may already be erasing, and to unwind through the same
 * "ignored" path an ordinary lost claim already takes: `recordPublicationFailure`
 * finds no `PENDING` row left to act on, once this has run.
 */
function documentRetiredMidAttempt(publicationId: string): AppError {
  return new AppError(
    404,
    'DOCUMENT_PUBLICATION_RETIRED_MID_ATTEMPT',
    'The document was deleted while this page was being published; the publication has been retired.',
    { publicationId },
  );
}

/**
 * Checked *between* every pair of calls, exactly as `confluence-erasure.ts`
 * does and with the same limitation stated there: the signal is not threaded
 * into the calls themselves, so one already-issued call can still complete
 * after the runner gives up. It is bounded by the client's own deadline, and
 * the direction is fail-safe — a page created and recorded, with the attempt
 * marked failed and resumed by adoption next time.
 */
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw aborted();
}

/**
 * `true` only for the two ways the connection itself is unusable. Applied
 * **only to the connection call**: the same `CONFLUENCE_RECONNECT_REQUIRED`
 * code is raised by the HTTP core for a 401 or 403 on an individual request,
 * where translating it would dead-letter a row on one unlucky response.
 * `CONFLUENCE_REFRESH_IN_PROGRESS` is deliberately absent — losing a refresh
 * race is the most ordinary transient condition there is.
 */
function isConnectionUnusable(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  return error.code === 'INTEGRATION_NOT_FOUND' || error.code === 'CONFLUENCE_RECONNECT_REQUIRED';
}

/** The core's 409, untranslated. `confluence-pages.ts` deliberately leaves a create's 409 alone. */
function isConflict(error: unknown): boolean {
  return error instanceof AppError && error.code === 'CONFLUENCE_CONFLICT';
}

/**
 * `true` only for the core's translation of a **403** on one request. A 401
 * reaches the same code with `details.status === 401` and is left transient:
 * reconnecting genuinely fixes an expired token, and a token can expire
 * between two calls of one attempt.
 */
function isForbidden(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'CONFLUENCE_RECONNECT_REQUIRED') return false;
  const details = error.details;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return false;
  return (details as Record<string, unknown>).status === 403;
}

// ---------------------------------------------------------------------------
// The Confluence publisher
// ---------------------------------------------------------------------------

/** The four primitives the sequence is built from. Injectable so a test can watch the order. */
export type ConfluencePublishOperations = {
  findPageByTitle(client: ConfluenceClient, spaceId: string, title: string): Promise<ConfluencePage | null>;
  createPage(client: ConfluenceClient, input: CreatePageInput): Promise<ConfluencePage>;
  uploadAttachment(client: ConfluenceClient, input: UploadAttachmentInput): Promise<ConfluenceAttachment>;
  setContentProperty(client: ConfluenceClient, pageId: string, key: string, value: unknown): Promise<void>;
};

const DEFAULT_OPERATIONS: ConfluencePublishOperations = {
  findPageByTitle: findPageByTitleDefault,
  createPage: createPageDefault,
  uploadAttachment: uploadAttachmentDefault,
  setContentProperty: setContentPropertyDefault,
};

/** Everything the mapping needs, plus where the bytes are and what they are. */
export type PublicationSource = PublicationDocument & {
  storagePath: string;
  mimeType: string;
};

export type ConfluencePublishConnect = (input: {
  organisationId: string;
  cloudId: string;
}) => Promise<ConfluenceClient>;

type DocumentReadClient = {
  document: {
    findFirst(args: {
      where: { id: string; organisationId: string };
      select: Record<string, boolean>;
    }): Promise<Record<string, unknown> | null>;
  };
};

export type ConfluencePublisherDeps = {
  /** Required unless every seam below is supplied. Reads the connection, the destination and the document. */
  prisma?: ConfluenceConnectionClient & PublishTargetClient & DocumentReadClient;
  /** Passed straight through to `currentAccessTokenForOrganisation`. */
  connection?: ConfluenceConnectionDeps;
  /**
   * Fetches the bytes. **Required**, not optional: an entry point that forgot
   * it would publish pages with nothing attached to them, and the compiler
   * refuses that rather than a charity discovering it.
   */
  downloadFile(organisationId: string, storagePath: string): Promise<Uint8Array>;
  connect?: ConfluencePublishConnect;
  readTarget?: (organisationId: string) => Promise<ConfluencePublishTarget | null>;
  readDocument?: (input: { organisationId: string; documentId: string }) => Promise<PublicationSource>;
  operations?: Partial<ConfluencePublishOperations>;
};

function defaultConnect(deps: ConfluencePublisherDeps): ConfluencePublishConnect {
  const prisma = deps.prisma;
  if (!prisma) {
    throw new TypeError('createConfluencePublisher needs either a prisma client or a connect function.');
  }

  return async ({ organisationId, cloudId }) =>
    createConfluenceClient({
      cloudId,
      // A thunk, because a backoff can outlive an access token.
      // `currentAccessTokenForOrganisation` is the only permitted way to take a
      // token outside a route — a job holds a tenant, never an integration id.
      getAccessToken: () => currentAccessTokenForOrganisation(prisma, { organisationId }, deps.connection),
    });
}

function defaultReadTarget(
  deps: ConfluencePublisherDeps,
): (organisationId: string) => Promise<ConfluencePublishTarget | null> {
  const prisma = deps.prisma;
  if (!prisma) {
    throw new TypeError('createConfluencePublisher needs either a prisma client or a readTarget function.');
  }
  return (organisationId) => confluencePublishTargetForOrganisation(prisma, organisationId);
}

function defaultReadDocument(
  deps: ConfluencePublisherDeps,
): (input: { organisationId: string; documentId: string }) => Promise<PublicationSource> {
  const prisma = deps.prisma;
  if (!prisma) {
    throw new TypeError('createConfluencePublisher needs either a prisma client or a readDocument function.');
  }

  return async ({ organisationId, documentId }) => {
    // Scoped on the organisation as well as the id: a publication row names a
    // tenant, and a document id alone must never reach another charity's row.
    const doc = await prisma.document.findFirst({
      where: { id: documentId, organisationId },
      select: {
        id: true,
        name: true,
        version: true,
        organisationId: true,
        category: true,
        boardMinuteReference: true,
        approvedDate: true,
        nextReviewDate: true,
        fileUrl: true,
        mimeType: true,
      },
    });
    if (doc === null) throw documentMissing(documentId);

    return {
      id: String(doc.id),
      name: String(doc.name),
      version: Number(doc.version),
      organisationId: String(doc.organisationId),
      category: String(doc.category),
      boardMinuteReference: (doc.boardMinuteReference as string | null) ?? null,
      approvedDate: (doc.approvedDate as Date | null) ?? null,
      nextReviewDate: (doc.nextReviewDate as Date | null) ?? null,
      // `fileUrl` is the Supabase object path, not a URL. Named as the storage
      // path here so nothing downstream is tempted to fetch it.
      storagePath: String(doc.fileUrl),
      mimeType: String(doc.mimeType),
    };
  };
}

/** Confluence's own cap on an attachment title. */
const MAX_ATTACHMENT_FILENAME_LENGTH = 255;

function isFilenameSafeCodePoint(codePoint: number): boolean {
  // Control characters go looking for a multipart header parser somewhere
  // between here and Atlassian; `confluence-attachments.ts` refuses them, and
  // a refusal at upload time would be a permanent-looking failure for a
  // document name a charity was allowed to type.
  return codePoint >= 0x20 && codePoint !== 0x7f;
}

/**
 * The attachment's filename, derived from the document name.
 *
 * **Deterministic**, for the same reason the title is: a retry that uploaded a
 * different filename would leave a second attachment on the page instead of a
 * new version of the first, and the row records one `attachmentId`. So the
 * second file would be the one nothing remembers how to erase.
 */
export function publicationFilename(doc: { id: string; name: string }): string {
  let cleaned = '';
  for (const character of doc.name) {
    if (!isFilenameSafeCodePoint(character.codePointAt(0) ?? 0)) continue;
    // Path separators are meaningless in an attachment title and suspicious to
    // an auditor reading one.
    cleaned += character === '/' || character === '\\' ? '-' : character;
  }

  // Bounded by UTF-16 length, the unit `confluence-attachments.ts` measures,
  // but advanced by whole code points so the cap can never leave a lone
  // surrogate behind.
  let bounded = '';
  for (const character of cleaned.trim()) {
    if (bounded.length + character.length > MAX_ATTACHMENT_FILENAME_LENGTH) break;
    bounded += character;
  }

  if (bounded.length === 0 || bounded === '.' || bounded === '..') {
    return `charitypilot-document-${doc.id}`;
  }
  return bounded;
}

/**
 * Builds the publisher the outbox runs. Mirrors `createConfluenceEraser`'s
 * shape: an injectable `connect` seam, injectable `operations`, and the real
 * `createConfluenceClient` + `currentAccessTokenForOrganisation` underneath.
 */
export function createConfluencePublisher(deps: ConfluencePublisherDeps): Publisher {
  const connect = deps.connect ?? defaultConnect(deps);
  const readTarget = deps.readTarget ?? defaultReadTarget(deps);
  const readDocument = deps.readDocument ?? defaultReadDocument(deps);
  const operations: ConfluencePublishOperations = { ...DEFAULT_OPERATIONS, ...deps.operations };
  const downloadFile = deps.downloadFile;

  return async ({ row, signal, recordPage }: PublicationAttempt): Promise<PublicationOutcome> => {
    assertNotAborted(signal);

    const target = await readTarget(row.organisationId);
    if (target === null) throw destinationMissing(row.organisationId);

    // Before a connection is opened, exactly as Phase 5's eraser validates its
    // target before opening one. `pageId` is not known yet, so what can be
    // checked is checked now: a destination whose ids the erasure parser would
    // refuse can never produce a publishable row, and finding that out after
    // the page exists would mean a page nothing can erase.
    assertRecordableId(target.cloudId, 'cloudId');
    assertRecordableId(target.spaceId, 'spaceId');

    // A page this row already names on a *different* site is not ours to
    // abandon. See `siteChanged`.
    if (row.cloudId !== null && row.cloudId !== target.cloudId) {
      throw siteChanged(row.cloudId, target.cloudId);
    }

    assertNotAborted(signal);
    const doc = await readDocument({ organisationId: row.organisationId, documentId: row.documentId });
    const title = publicationTitle(doc);

    assertNotAborted(signal);
    let client: ConfluenceClient;
    try {
      client = await connect({ organisationId: row.organisationId, cloudId: target.cloudId });
    } catch (error) {
      if (isConnectionUnusable(error)) throw notConnected(row.organisationId, error);
      throw error;
    }

    const page = await resolvePage({ client, operations, row, target, doc, title, signal });

    const recorded: PublishedPage = {
      cloudId: target.cloudId,
      spaceId: target.spaceId,
      pageId: page.id,
      pageTitle: page.title,
    };

    // The arbiter, on what is about to be stored — before it is stored, and
    // before anything is uploaded to it.
    publicationErasureTarget({ cloudId: recorded.cloudId, pageId: recorded.pageId, attachmentId: null });

    // Deliberately *not* preceded by an abort guard: a page that exists must be
    // recorded even by an attempt that has run out of time, or the next attempt
    // creates a second one. See the module header.
    await recordPage(recorded);

    assertNotAborted(signal);
    const bytes = await downloadFile(row.organisationId, doc.storagePath);

    assertNotAborted(signal);
    let attachment: ConfluenceAttachment;
    try {
      attachment = await operations.uploadAttachment(client, {
        pageId: recorded.pageId,
        filename: publicationFilename(doc),
        contentType: doc.mimeType,
        bytes,
      });
    } catch (error) {
      if (isForbidden(error)) throw publishForbidden('attach a file to a page', target.spaceKey, error);
      throw error;
    }

    assertNotAborted(signal);
    try {
      await operations.setContentProperty(
        client,
        recorded.pageId,
        CHARITYPILOT_PROPERTY_KEY,
        publicationProperty(doc),
      );
    } catch (error) {
      if (isForbidden(error)) throw publishForbidden('write page metadata', target.spaceKey, error);
      throw error;
    }

    return {
      ...recorded,
      attachmentId: attachment.id,
      // Validated again now that the attachment id is known: the row this
      // outcome finalises is the one Phase 5's eraser will read.
      targetRef: publicationErasureTarget({
        cloudId: recorded.cloudId,
        pageId: recorded.pageId,
        attachmentId: attachment.id,
      }),
    };
  };
}

/**
 * The same rule `parseConfluenceErasureTarget` applies, on a value that cannot
 * be handed to it yet because the target is not complete.
 *
 * Raised with the parser's own code, so it dead-letters as
 * `PERMANENT_TARGET_REF_REJECTED` exactly as the parser's refusal does — one
 * outcome for one class of defect, whichever of the two boundaries catches it.
 */
function assertRecordableId(value: string, field: string): void {
  if (typeof value === 'string' && value.length > 0 && value === value.trim()) return;
  throw new AppError(
    500,
    'ERASURE_TARGET_MALFORMED',
    `A Confluence publish target is malformed: ${field} is empty or carries surrounding ` +
      'whitespace, so the erasure target this publish would record would be refused later. ' +
      'Nothing was published. This will not improve on retry.',
    { field },
  );
}

/**
 * Create-or-adopt. The three ways a page is arrived at, in the order that
 * makes a retry safe. See the module header.
 */
async function resolvePage(input: {
  client: ConfluenceClient;
  operations: ConfluencePublishOperations;
  row: DocumentPublicationRecord;
  target: ConfluencePublishTarget;
  doc: PublicationSource;
  title: string;
  signal?: AbortSignal;
}): Promise<{ id: string; title: string }> {
  const { client, operations, row, target, doc, title, signal } = input;

  // 1. A page id this row already recorded. Adopted without a lookup, because
  //    `findPageByTitle` is a search and a page created moments ago is not
  //    promised to be in its index yet — the very window a crash between
  //    create and attach lands in.
  if (row.pageId !== null) {
    return { id: row.pageId, title: row.pageTitle ?? title };
  }

  // 2. A page somebody (or a previous attempt) already made under this title.
  assertNotAborted(signal);
  const existing = await operations.findPageByTitle(client, target.spaceId, title);
  if (existing !== null) return existing;

  assertNotAborted(signal);
  try {
    return await operations.createPage(client, {
      spaceId: target.spaceId,
      title,
      bodyStorage: publicationBody(doc),
    });
  } catch (error) {
    if (isForbidden(error)) throw publishForbidden('create a page', target.spaceKey, error);
    if (!isConflict(error)) throw error;

    // 3. A 409. Confluence uses it for a duplicate title, which is exactly the
    //    case where a previous attempt already succeeded — so re-read **once**
    //    and adopt. The upstream error body is not read to decide this.
    assertNotAborted(signal);
    const adopted = await operations.findPageByTitle(client, target.spaceId, title);
    if (adopted === null) throw conflictUnresolved(target.spaceId, title);
    return adopted;
  }
}

// ---------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------

export class DocumentPublicationService {
  private readonly attemptTimeoutMs: number;

  constructor(
    private prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
    attemptTimeoutMs = DOCUMENT_PUBLICATION_ATTEMPT_TIMEOUT_MS,
  ) {
    if (
      !Number.isInteger(attemptTimeoutMs) ||
      attemptTimeoutMs < 10 ||
      attemptTimeoutMs > DOCUMENT_PUBLICATION_ATTEMPT_TIMEOUT_MS
    ) {
      throw new TypeError(
        `Document publication timeout must be an integer between 10 and ${DOCUMENT_PUBLICATION_ATTEMPT_TIMEOUT_MS} milliseconds`,
      );
    }
    this.attemptTimeoutMs = attemptTimeoutMs;
  }

  /**
   * Records where the page is, mid-attempt, with `publishedAt` still null.
   *
   * The database's `publication_target_consistent` CHECK permits exactly this
   * window — `cloudId` and `pageId` recorded, nothing yet claiming the publish
   * finished — and refuses an untrimmed id at the same time.
   */
  async attachPublicationPage(
    id: string,
    page: PublishedPage,
    claimedAt: Date | null = null,
  ): Promise<boolean> {
    const result = await publicationDelegate(this.prisma).updateMany({
      where: {
        id,
        state: 'PENDING',
        processedAt: null,
        publishedAt: null,
        claimedAt,
      },
      data: {
        cloudId: page.cloudId,
        spaceId: page.spaceId,
        pageId: page.pageId,
        pageTitle: page.pageTitle,
      },
    });
    return result.count === 1;
  }

  /**
   * The worker's half of the owner's 2026-09-19 ruling; see the module
   * header's "The document can vanish mid-attempt", and
   * `document.service.ts`'s `retireConfluencePublication` for the other half
   * and the constraint (`DocumentPublication_state_consistent`'s `RETIRED`
   * arm) both halves write to.
   *
   * Called from `recordPage`, immediately after `attachPublicationPage` has
   * successfully attached a page id — the only moment this worker holds both
   * facts a retire needs at once: the page it just recorded, and whether the
   * document that page is for still exists. `retireConfluencePublication`'s
   * own row lock cannot see this attempt at all while it is here, inside
   * Confluence's HTTP call, with no database write issued yet to block on;
   * this is the case that closes.
   *
   * A no-op, quietly, when the document is still there — the overwhelmingly
   * common case, checked on every attempt that reaches this point. When it is
   * gone: retires the row (never deletes it — the page it names is real) and
   * throws, so `publish()` never reaches `downloadFile` against bytes an
   * ordinary deletion may already be erasing. That throw unwinds through the
   * same "ignored" path an ordinary lost claim already takes:
   * `recordPublicationFailure` finds no `PENDING` row left to match, once the
   * row below has committed, so nothing here is scored as a failure, nothing
   * dead-letters, and no operator is alerted for a document a user simply
   * deleted.
   *
   * `retiredStoragePath` is left `null` rather than re-derived from a document
   * that is already gone — the column is nullable for exactly this, and
   * Task 4's erasure service already falls back when it is absent.
   *
   * No row lock: unlike `retireConfluencePublication`, which has to decide
   * between three outcomes (delete outright, park, or retire) from a value it
   * just read, this method already knows both facts it needs are true —
   * `attachPublicationPage` just proved the page id is this row's, and the
   * `document.findFirst` above is the read this decision is made from — so a
   * single targeted `UPDATE` is enough. The `pageId: { not: null }` guard
   * below is the same belt-and-braces `retireConfluencePublication`'s delete
   * branch keeps for a client that cannot lock: harmless when it is
   * redundant, and it costs nothing to keep.
   */
  private async retirePublicationIfDocumentGone(
    publicationId: string,
    documentId: string,
    organisationId: string,
  ): Promise<void> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, organisationId },
      select: { id: true },
    });
    if (doc !== null) return;

    await publicationDelegate(this.prisma).updateMany({
      where: { id: publicationId, pageId: { not: null } },
      data: {
        state: 'RETIRED',
        retiredAt: this.now(),
        // `retiredStoragePath` is deliberately omitted rather than set to null
        // here. `remove()`'s second pass may already have retired this row with
        // a correct path before this worker-side retire runs; setting null
        // unconditionally would clobber the only column telling an operator
        // which document a retired row belonged to once the Document row is
        // gone. Leaving the field out of this update preserves a path already
        // written by `remove()`; a row retired only by this worker simply keeps
        // the null it already has, which `publicationErasureTarget`'s caller
        // already falls back on.
        nextAttemptAt: null,
        claimedAt: null,
        alertClaimToken: null,
        alertClaimedAt: null,
        lastError: PUBLICATION_RETIRED_MID_ATTEMPT_MESSAGE,
      },
    });

    throw documentRetiredMidAttempt(publicationId);
  }

  async markPublicationProcessed(
    id: string,
    outcome: PublicationOutcome,
    claimedAt: Date | null = null,
  ): Promise<boolean> {
    const now = this.now();
    const result = await publicationDelegate(this.prisma).updateMany({
      where: {
        id,
        state: 'PENDING',
        processedAt: null,
        claimedAt,
      },
      data: {
        state: 'PROCESSED',
        processedAt: now,
        // Set only here, at the end. Every earlier write leaves it null, which
        // is what makes the create-then-attach window distinguishable from a
        // finished publication.
        publishedAt: now,
        cloudId: outcome.cloudId,
        spaceId: outcome.spaceId,
        pageId: outcome.pageId,
        pageTitle: outcome.pageTitle,
        attachmentId: outcome.attachmentId,
        nextAttemptAt: null,
        lastError: null,
        claimedAt: null,
        deadLetteredAt: null,
        terminalReason: null,
        alertClaimToken: null,
        alertClaimedAt: null,
        alertedAt: null,
      },
    });
    return result.count === 1;
  }

  async recordPublicationFailure(
    id: string,
    error: unknown,
    claimedAt: Date | null = null,
  ): Promise<{
    status: 'retry-scheduled' | 'dead-lettered' | 'ignored';
    attempts: number | null;
    nextAttemptAt: Date | null;
    terminalReason: DocumentPublicationTerminalReason | null;
  }> {
    const client = this.prisma as unknown as DocumentPublicationClient;
    const recordFailure = async (tx: DocumentPublicationClient) => {
      const current = await publicationDelegate(tx).findFirst({
        where: { id, state: 'PENDING', processedAt: null, claimedAt },
        select: { id: true, attempts: true, claimedAt: true },
      });
      if (!current) {
        return { status: 'ignored' as const, attempts: null, nextAttemptAt: null, terminalReason: null };
      }

      const attempt = current.attempts + 1;
      const now = this.now();
      const permanentReason = permanentPublicationTerminalReason(error);
      const deadLettered = permanentReason !== null || attempt >= DOCUMENT_PUBLICATION_MAX_ATTEMPTS;
      const terminalReason: DocumentPublicationTerminalReason | null =
        permanentReason ?? (deadLettered ? 'MAX_ATTEMPTS_EXHAUSTED' : null);
      const nextAttemptAt = deadLettered
        ? null
        : new Date(now.getTime() + documentPublicationRetryDelayMs(attempt));

      const update = await publicationDelegate(tx).updateMany({
        where: { id, state: 'PENDING', processedAt: null, attempts: current.attempts, claimedAt },
        data: {
          state: deadLettered ? 'DEAD_LETTER' : 'PENDING',
          attempts: attempt,
          lastError: formatProviderError(error).slice(0, 500),
          lastAttemptAt: now,
          nextAttemptAt,
          claimedAt: null,
          deadLetteredAt: deadLettered ? now : null,
          terminalReason,
          alertClaimToken: null,
          alertClaimedAt: null,
          alertedAt: null,
        },
      });
      if (update.count !== 1) {
        return { status: 'ignored' as const, attempts: null, nextAttemptAt: null, terminalReason: null };
      }
      return {
        status: deadLettered ? ('dead-lettered' as const) : ('retry-scheduled' as const),
        attempts: attempt,
        nextAttemptAt,
        terminalReason,
      };
    };

    return client.$transaction ? client.$transaction(recordFailure) : recordFailure(client);
  }

  /**
   * Claims a batch of due publications and runs `publish` against each,
   * mirroring `retryPendingStorageDeletions`'s shape so that the two outboxes
   * cannot drift into two reliability patterns.
   */
  async retryPendingPublications(
    publish: Publisher,
    limit = 25,
  ): Promise<DocumentPublicationRunResult> {
    const boundedLimit = Math.min(
      DOCUMENT_PUBLICATION_MAX_CLAIM_BATCH,
      Math.max(1, Number.isInteger(limit) ? limit : 25),
    );
    const pending = await this.claimPendingPublications(boundedLimit);

    let processed = 0;
    let retryScheduled = 0;
    let newlyDeadLettered = 0;

    for (const publication of pending) {
      let outcome: PublicationOutcome;
      try {
        outcome = await this.runBoundedPublication(publish, publication);
      } catch (error) {
        const failure = await this.recordPublicationFailure(
          publication.id,
          error,
          publication.claimedAt,
        );
        if (failure.status === 'retry-scheduled') retryScheduled += 1;
        if (failure.status === 'dead-lettered') newlyDeadLettered += 1;
        continue;
      }

      const finalized = await this.markPublicationProcessed(
        publication.id,
        outcome,
        publication.claimedAt,
      );
      if (finalized) processed += 1;
    }

    const deadLetterAlert = await this.claimUnalertedDeadLetters(boundedLimit);
    return {
      processed,
      failed: retryScheduled + newlyDeadLettered,
      retryScheduled,
      newlyDeadLettered,
      deadLetterAlert,
    };
  }

  private async runBoundedPublication(
    publish: Publisher,
    publication: DocumentPublicationRecord,
  ): Promise<PublicationOutcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new AppError(504, 'DOCUMENT_PUBLICATION_TIMEOUT', 'The Confluence publish attempt timed out.'),
        );
      }, this.attemptTimeoutMs);
    });

    const attempt = Promise.resolve().then(() =>
      publish({
        row: publication,
        signal: controller.signal,
        recordPage: async (page) => {
          const recorded = await this.attachPublicationPage(
            publication.id,
            page,
            publication.claimedAt,
          );
          if (!recorded) throw claimLost(publication.id);

          // The owner's 2026-09-19 ruling, the worker's half — see
          // `retirePublicationIfDocumentGone`'s doc comment.
          await this.retirePublicationIfDocumentGone(
            publication.id,
            publication.documentId,
            publication.organisationId,
          );
        },
      }),
    );
    // The attempt outlives a lost race by one call (see `assertNotAborted`), so
    // its later rejection has to land somewhere. In Node an unhandled
    // rejection terminates the process by default, so one slow publish that
    // eventually fails could take down the scheduler that was about to process
    // every other row.
    //
    // **`Promise.race` is what prevents that, and it has to stay the thing
    // that does.** `race` attaches a rejection handler to *every* entrant, so
    // the loser's late rejection is already observed and discarded by `race`
    // itself. A separate `attempt.catch(...)` beside it would be dead code --
    // there was one here, and it is gone. What is *not* safe is a refactor
    // that stops handing `attempt` itself to `race`: observing only its
    // fulfilment (`attempt.then(() => …)`, whether as an entrant or as a guard
    // beside the race) leaves a derived promise whose rejection nothing
    // handles, and the process dies. That was measured, not assumed, and it is
    // pinned by 'a late rejection from a timed-out publish attempt is observed
    // rather than left unhandled' in document-publication.service.test.ts.
    // `document.service.ts`'s storage-deletion runner carries the same note for
    // the same reason; the two must not drift.
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async claimPendingPublications(limit: number): Promise<DocumentPublicationRecord[]> {
    const client = this.prisma as unknown as DocumentPublicationClient;

    if (client.$transaction && client.$queryRaw) {
      return client.$transaction(async (tx) => {
        if (!tx.$queryRaw) {
          return [];
        }

        return tx.$queryRaw<DocumentPublicationRecord[]>`
          UPDATE "DocumentPublication"
          SET "claimedAt" = CURRENT_TIMESTAMP,
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" IN (
            SELECT "id"
            FROM "DocumentPublication"
            WHERE "state" = 'PENDING'
              AND "processedAt" IS NULL
              AND "attempts" < ${DOCUMENT_PUBLICATION_MAX_ATTEMPTS}
              AND "nextAttemptAt" <= CURRENT_TIMESTAMP
              AND (
                "claimedAt" IS NULL OR
                "claimedAt" < CURRENT_TIMESTAMP - (${PUBLICATION_CLAIM_STALE_AFTER_MS} * INTERVAL '1 millisecond')
              )
            ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING
            "id",
            "organisationId",
            "documentId",
            "provider",
            "cloudId",
            "spaceId",
            "pageId",
            "attachmentId",
            "pageTitle",
            "publishedAt",
            "state",
            "attempts",
            "claimedAt",
            "nextAttemptAt",
            "deadLetteredAt",
            "terminalReason",
            "alertClaimToken",
            "alertClaimedAt",
            "alertedAt"
        `;
      });
    }

    const now = this.now();
    const staleBefore = new Date(now.getTime() - PUBLICATION_CLAIM_STALE_AFTER_MS);
    const candidates = await publicationDelegate(this.prisma).findMany({
      where: {
        state: 'PENDING',
        processedAt: null,
        attempts: { lt: DOCUMENT_PUBLICATION_MAX_ATTEMPTS },
        nextAttemptAt: { lte: now },
        OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });

    const claimed: DocumentPublicationRecord[] = [];
    for (const candidate of candidates) {
      const claim = await publicationDelegate(this.prisma).updateMany({
        where: {
          id: candidate.id,
          state: 'PENDING',
          processedAt: null,
          attempts: candidate.attempts,
          nextAttemptAt: { lte: now },
          OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
        },
        data: { claimedAt: now },
      });
      if (claim.count === 1) claimed.push({ ...candidate, claimedAt: now });
    }
    return claimed;
  }

  private async claimUnalertedDeadLetters(limit: number): Promise<DeadLetterAlertClaim | null> {
    const client = this.prisma as unknown as DocumentPublicationClient;
    const claimToken = randomUUID();

    if (client.$transaction && client.$queryRaw) {
      const claimed = await client.$transaction(async (tx) => {
        if (!tx.$queryRaw) return [];
        return tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "DocumentPublication"
          SET "alertClaimToken" = ${claimToken},
              "alertClaimedAt" = CURRENT_TIMESTAMP,
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" IN (
            SELECT "id"
            FROM "DocumentPublication"
            WHERE "state" = 'DEAD_LETTER'
              AND "alertedAt" IS NULL
              AND (
                "alertClaimedAt" IS NULL OR
                "alertClaimedAt" < CURRENT_TIMESTAMP - (${PUBLICATION_ALERT_CLAIM_STALE_AFTER_MS} * INTERVAL '1 millisecond')
              )
            ORDER BY "deadLetteredAt" ASC, "createdAt" ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING "id"
        `;
      });
      return claimed.length > 0 ? { claimToken, ids: claimed.map(({ id }) => id) } : null;
    }

    const now = this.now();
    const staleBefore = new Date(now.getTime() - PUBLICATION_ALERT_CLAIM_STALE_AFTER_MS);
    const candidates = await publicationDelegate(this.prisma).findMany({
      where: {
        state: 'DEAD_LETTER',
        alertedAt: null,
        OR: [{ alertClaimedAt: null }, { alertClaimedAt: { lt: staleBefore } }],
      },
      orderBy: [{ deadLetteredAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: { id: true },
    });
    const ids: string[] = [];
    for (const candidate of candidates) {
      const claim = await publicationDelegate(this.prisma).updateMany({
        where: {
          id: candidate.id,
          state: 'DEAD_LETTER',
          alertedAt: null,
          OR: [{ alertClaimedAt: null }, { alertClaimedAt: { lt: staleBefore } }],
        },
        data: { alertClaimToken: claimToken, alertClaimedAt: now },
      });
      if (claim.count === 1) ids.push(candidate.id);
    }
    return ids.length > 0 ? { claimToken, ids } : null;
  }

  /** Records that the operator alert for this claim was delivered. */
  async markDeadLetterAlertSent(claim: DeadLetterAlertClaim): Promise<number> {
    if (claim.ids.length === 0) return 0;
    const result = await publicationDelegate(this.prisma).updateMany({
      where: {
        id: { in: claim.ids },
        state: 'DEAD_LETTER',
        alertedAt: null,
        alertClaimToken: claim.claimToken,
      },
      data: { alertedAt: this.now(), alertClaimToken: null, alertClaimedAt: null },
    });
    return result.count;
  }

  /** Releases the claim so the next run alerts again. Used when delivery failed. */
  async releaseDeadLetterAlertClaim(claim: DeadLetterAlertClaim): Promise<number> {
    if (claim.ids.length === 0) return 0;
    const result = await publicationDelegate(this.prisma).updateMany({
      where: {
        id: { in: claim.ids },
        state: 'DEAD_LETTER',
        alertedAt: null,
        alertClaimToken: claim.claimToken,
      },
      data: { alertClaimToken: null, alertClaimedAt: null },
    });
    return result.count;
  }
}
