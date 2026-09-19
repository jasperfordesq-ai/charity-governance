import { AppError } from '../utils/errors.js';
import type { ConfluenceClient } from './confluence-client.js';
import { createConfluenceClient } from './confluence-client.js';
import {
  deleteAttachment as deleteAttachmentDefault,
  purgeAttachment as purgeAttachmentDefault,
} from './confluence-attachments.js';
import {
  deletePage as deletePageDefault,
  getPage as getPageDefault,
  purgePage as purgePageDefault,
  type ConfluencePage,
} from './confluence-pages.js';
import {
  currentAccessTokenForOrganisation,
  type ConfluenceConnectionClient,
  type ConfluenceConnectionDeps,
} from './confluence-connection.service.js';
import { parseConfluenceErasureTarget, type ConfluenceErasureTarget } from './confluence-erasure-target.js';
import type { Eraser, ErasureTarget } from './document-erasure.js';

/**
 * The Confluence eraser: the sequence that turns a deletion row into an
 * erasure the platform can *prove*.
 *
 * ## Order is a correctness property, not a style choice
 *
 * 1. Every attachment, `delete` then `purge`.
 * 2. Then the page, `delete` then `purge`.
 * 3. Then a read of the page, which must 404.
 *
 * **Attachments before the page**, because Atlassian does not promise that
 * deleting a page erases the files attached to it. If it does cascade, the
 * attachment call 404s and that is success (see `confluence-attachments.ts`);
 * if it does not, an attachment erased afterwards would be an orphan nobody
 * holds a handle to any more — a charity's document still sitting in their
 * Confluence after they asked for it to be erased.
 *
 * **Delete before purge**, because purge only works on already-trashed
 * content. A purge issued against live content is refused, and a sequence that
 * skipped the delete would leave the content exactly where it started while
 * reporting that it had tried.
 *
 * ## The read is the proof
 *
 * The pipeline exists so that erasure is provable, and the worst thing it can
 * produce is a *false proof* — a row marked PROCESSED for content still
 * sitting in a charity's space. Issuing four DELETEs proves only that four
 * requests were sent. The final `getPage` is what is actually known: a 404 is
 * the evidence, and anything else fails the attempt
 * (`CONFLUENCE_ERASURE_UNVERIFIED`), which is **transient** — the page may be
 * gone by the next attempt, and a five-minute Atlassian blip must not become a
 * dead-letter a human has to clear by hand.
 *
 * ## No persisted sub-state
 *
 * Every step is idempotent because absence is the goal: a 404 is success at
 * each one. So a crash anywhere in the middle is recovered by running the
 * whole sequence again from the top, and the row needs to remember nothing
 * beyond what it already carries. This is the exact inverse of the publish
 * side, where a retried create duplicates a governance document.
 *
 * ## Permanent versus transient
 *
 * Three failures here are permanent and dead-letter on the first attempt,
 * because retrying acquires none of the three things missing:
 *
 * - `CONFLUENCE_PURGE_FORBIDDEN` — a permission,
 * - `ERASURE_TARGET_MALFORMED` — a well-formed row,
 * - `CONFLUENCE_NOT_CONNECTED` — a connection.
 *
 * Everything else — an unverified read, a 5xx, a timeout, a rate limit, a
 * refresh already in flight — is transient and goes back through the ordinary
 * claim/backoff loop. `document.service.ts` holds the mapping; this module
 * holds the codes.
 */

/** The five primitives the sequence is built from. Injectable so a test can watch the order. */
export type ConfluenceErasureOperations = {
  deleteAttachment(client: ConfluenceClient, attachmentId: string): Promise<void>;
  purgeAttachment(client: ConfluenceClient, attachmentId: string): Promise<void>;
  deletePage(client: ConfluenceClient, pageId: string): Promise<void>;
  purgePage(client: ConfluenceClient, pageId: string): Promise<void>;
  getPage(client: ConfluenceClient, pageId: string): Promise<ConfluencePage | null>;
};

/**
 * Opens a client for the site the *row* names, not the site the organisation
 * happens to be connected to now. A charity may disconnect and reconnect to a
 * different site and still be owed erasure from the first, which is why
 * `cloudId` travels on the target — see `confluence-erasure-target.ts`.
 */
export type ConfluenceConnect = (input: {
  organisationId: string;
  cloudId: string;
}) => Promise<ConfluenceClient>;

export type ConfluenceEraserDeps = {
  /**
   * The Prisma client the default {@link ConfluenceConnect} reads the
   * charity's connection through. Required unless `connect` is supplied.
   */
  prisma?: ConfluenceConnectionClient;
  /** Passed straight through to `currentAccessTokenForOrganisation`. */
  connection?: ConfluenceConnectionDeps;
  /** Overrides the default connection path entirely. Exists for tests. */
  connect?: ConfluenceConnect;
  /** Overrides any of the five primitives. Exists for tests. */
  operations?: Partial<ConfluenceErasureOperations>;
};

const DEFAULT_OPERATIONS: ConfluenceErasureOperations = {
  deleteAttachment: deleteAttachmentDefault,
  purgeAttachment: purgeAttachmentDefault,
  deletePage: deletePageDefault,
  purgePage: purgePageDefault,
  getPage: getPageDefault,
};

/**
 * A charity whose Confluence connection is gone or unusable.
 *
 * Permanent, and the message says why rather than hiding it: retrying does not
 * reconnect anything, and the honest statement to make about a document whose
 * bytes live on a site the platform can no longer reach is that the platform
 * can no longer reach it. A human must reconnect, or erase it in Confluence
 * directly and record that (`COMPLETE_EXTERNALLY_REMEDIATED`).
 */
function notConnected(organisationId: string, cause: unknown): AppError {
  return new AppError(
    409,
    'CONFLUENCE_NOT_CONNECTED',
    'This organisation has no live Confluence connection, so the published copy of this ' +
      'document cannot be reached, let alone erased. Retrying will not reconnect it — a human ' +
      'must reconnect the site, or erase the content in Confluence directly and record that. ' +
      'Until then the content has not been erased.',
    {
      organisationId,
      cause: cause instanceof AppError ? cause.code : undefined,
    },
  );
}

/**
 * `true` only for the two ways the connection itself is unusable.
 *
 * `CONFLUENCE_REFRESH_IN_PROGRESS` is deliberately absent: another process
 * holding the refresh claim is the most ordinary transient condition there is,
 * and folding it in here would dead-letter a row for losing a race.
 *
 * This is applied **only to the connection call**. The same
 * `CONFLUENCE_RECONNECT_REQUIRED` code is also raised by the HTTP core for a
 * 401 or 403 on an individual request, where it does not mean the stored
 * connection is dead, and translating those would dead-letter a row on a
 * single unlucky response.
 */
function isConnectionUnusable(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  return error.code === 'INTEGRATION_NOT_FOUND' || error.code === 'CONFLUENCE_RECONNECT_REQUIRED';
}

/**
 * The attempt was abandoned part-way by the bounded runner.
 *
 * Transient by design: the row records a failed attempt, and the next one
 * starts the whole idempotent sequence again.
 */
function aborted(): AppError {
  return new AppError(
    504,
    'CONFLUENCE_ERASURE_ABORTED',
    'The Confluence erasure attempt was aborted before it finished. Nothing it had not already ' +
      'issued was issued.',
  );
}

/**
 * Checked *between* every pair of calls, because the runner's only lever is the
 * signal. An eraser that checked once at the top would carry on purging a
 * charity's content long after the row had recorded the attempt as timed out —
 * the row would say the erasure failed while the erasure was still happening,
 * and the two would disagree about what a charity's Confluence contains.
 *
 * **What this does not close, stated exactly.** The signal is checked between
 * calls and is *not* threaded into them: `ConfluenceErasureOperations` takes no
 * `AbortSignal`, and `confluence-client.ts` exposes no caller signal — it
 * builds its own per-attempt deadline instead. So when the runner aborts,
 * exactly one already-issued call can still complete afterwards. That one call
 * is bounded by the client's own deadline, and the direction is fail-safe: a
 * real erasure recorded as a failed attempt, re-proved by the 404 on the next
 * one. It is never the other way round — the row cannot record an erasure that
 * did not happen. Closing the last call means giving the closed client a caller
 * signal, which is a change to that module, not to this one.
 */
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw aborted();
}

/**
 * The page is still there after delete and purge both reported success.
 *
 * **Transient, not permanent.** The likeliest causes — Confluence's own
 * eventual consistency, a purge that raced a restore — clear on their own, and
 * the one thing that must never happen is marking this row PROCESSED. It is
 * not marked PROCESSED, so the attempt is simply retried.
 */
function unverified(pageId: string): AppError {
  return new AppError(
    502,
    'CONFLUENCE_ERASURE_UNVERIFIED',
    `Confluence still returns page ${pageId} after it was deleted and purged, so this erasure ` +
      'is not proven and has not been recorded as complete. The attempt will be retried.',
    { pageId },
  );
}

function defaultConnect(deps: ConfluenceEraserDeps): ConfluenceConnect {
  const prisma = deps.prisma;
  if (!prisma) {
    throw new TypeError('createConfluenceEraser needs either a prisma client or a connect function.');
  }

  return async ({ organisationId, cloudId }) =>
    createConfluenceClient({
      cloudId,
      // Resolved per request by the HTTP core, which is why this is a thunk: a
      // backoff can outlive an access token. `currentAccessTokenForOrganisation`
      // is the only permitted way to take a token outside a route — a job holds
      // a tenant, never an integration id.
      getAccessToken: () => currentAccessTokenForOrganisation(prisma, { organisationId }, deps.connection),
    });
}

/**
 * Builds the eraser the dispatcher registers under `confluence`.
 */
export function createConfluenceEraser(deps: ConfluenceEraserDeps): Eraser {
  const connect = deps.connect ?? defaultConnect(deps);
  const operations: ConfluenceErasureOperations = { ...DEFAULT_OPERATIONS, ...deps.operations };

  return async (row: ErasureTarget, signal?: AbortSignal): Promise<void> => {
    assertNotAborted(signal);

    // Before anything is opened or issued. A malformed row names nothing, and
    // the one thing worse than not erasing it is issuing deletes derived from
    // a shape that was never validated.
    const target: ConfluenceErasureTarget = parseConfluenceErasureTarget(row.targetRef);

    let client: ConfluenceClient;
    try {
      client = await connect({ organisationId: row.organisationId, cloudId: target.cloudId });
    } catch (error) {
      if (isConnectionUnusable(error)) throw notConnected(row.organisationId, error);
      throw error;
    }

    // Attachments first, and each trashed before it is purged. See the module
    // header: this order is the difference between an erasure and an orphan.
    for (const attachmentId of target.attachmentIds) {
      assertNotAborted(signal);
      await operations.deleteAttachment(client, attachmentId);
      assertNotAborted(signal);
      await operations.purgeAttachment(client, attachmentId);
    }

    assertNotAborted(signal);
    await operations.deletePage(client, target.pageId);
    assertNotAborted(signal);
    await operations.purgePage(client, target.pageId);

    // The proof. Everything above this line is a record of what was asked for;
    // only this line is a record of what is true.
    assertNotAborted(signal);
    const page = await operations.getPage(client, target.pageId);
    if (page !== null) throw unverified(target.pageId);
  };
}
