/**
 * Re-reads the pages CharityPilot has published, so a charity can be told when
 * one of them is no longer where we left it.
 *
 * WHY THIS IS A POLLING JOB AND NOT A SUBSCRIPTION. Atlassian gives OAuth 2.0
 * (3LO) apps no webhooks at all — only Connect (end of life) and Forge have
 * page triggers. Polling is not a shortcut here; it is the only mechanism the
 * platform offers, and the DPO's own condition on Forge Remote was that it be
 * considered only if polling proves insufficient.
 *
 * WHY IT DOES NOT KEEP TOKENS ALIVE. The obvious shape for this job is a
 * six-hourly visit to every connected tenant, which — because the access token
 * has always expired by then — would rotate every tenant's refresh token and
 * so keep every authorisation alive for ever, including tenants that have
 * never published anything. The DPO ruled against exactly that on 2026-09-20:
 * refreshing as a by-product of an integration doing real work is legitimate,
 * refreshing solely to stop a dormant authorisation lapsing is not, and an
 * organisation that is not using the integration should be asked to reconnect
 * rather than have its access quietly preserved.
 *
 * So the first question this job asks about a tenant is whether there is any
 * work to do, and it asks it BEFORE it takes a token. A tenant with nothing
 * live to reconcile is skipped without a single call to Atlassian, and
 * `sweepDormantIntegrations` records the lapse approaching instead of
 * preventing it. Two tests exist purely to hold that line: one asserts no token
 * is taken at all for a dormant tenant (asserting no *page* calls would pass
 * while the token was still being rotated), and one asserts the dormancy sweep
 * never moves `lastRefreshedAt`.
 */
import { AppError } from '../utils/app-error.js';
import type { ConfluenceClient } from './confluence-client.js';
import { createConfluenceClient } from './confluence-client.js';
import {
  getPage as getPageDefault,
  getTrashedPage as getTrashedPageDefault,
  type ConfluencePage,
} from './confluence-pages.js';
import {
  currentAccessTokenForOrganisation,
  type ConfluenceConnectionClient,
  type ConfluenceConnectionDeps,
} from './confluence-connection.service.js';
import {
  listAccessibleResources as listAccessibleResourcesDefault,
  type AccessibleResource,
} from './atlassian-oauth.js';

/** Mirrors `IntegrationReconcileOutcome` in the Prisma schema. */
export type IntegrationReconcileOutcome =
  | 'OK'
  | 'RECONNECT_REQUIRED'
  | 'FORBIDDEN'
  | 'SITE_NOT_ACCESSIBLE'
  | 'RATE_LIMITED'
  | 'EXPIRING_SOON'
  | 'EXPIRED';

/** Mirrors `DocumentPublicationRemoteState` in the Prisma schema. */
export type DocumentPublicationRemoteState = 'VISIBLE' | 'ARCHIVED' | 'TRASHED' | 'GONE' | 'UNKNOWN';

/**
 * A page's remote state as this job determined it.
 *
 * `determinate` is carried separately rather than derived from `state` at each
 * write site. UNKNOWN is the only indeterminate value today, but the reason it
 * is indeterminate — the site refused to answer, so the last determinate clock
 * must not move — is a property of the reading, not of the word, and encoding
 * it here keeps the two from drifting apart.
 */
export type RemoteStateReading = {
  state: DocumentPublicationRemoteState;
  determinate: boolean;
  version: number | null;
  title: string | null;
  errorCode: string | null;
};

/** One row, as much of it as this job needs. */
export type ReconcilablePublication = {
  id: string;
  organisationId: string;
  pageId: string | null;
  remoteState: DocumentPublicationRemoteState | null;
};

export type ReconcileTenant = {
  organisationId: string;
  integrationId: string;
  /** The site the integration is bound to, from `config.siteId`. */
  siteId: string | null;
};

export type ConfluenceReconcileOperations = {
  getPage(client: ConfluenceClient, pageId: string): Promise<ConfluencePage | null>;
  getTrashedPage(client: ConfluenceClient, pageId: string): Promise<ConfluencePage | null>;
  listAccessibleResources(accessToken: string): Promise<AccessibleResource[]>;
};

const DEFAULT_OPERATIONS: ConfluenceReconcileOperations = {
  getPage: getPageDefault,
  getTrashedPage: getTrashedPageDefault,
  listAccessibleResources: (accessToken) => listAccessibleResourcesDefault(accessToken),
};

export type ConfluenceReconcileConnect = (input: {
  organisationId: string;
  cloudId: string;
}) => Promise<{ client: ConfluenceClient; accessToken: string }>;

export type ConfluenceReconcilerDeps = {
  /** Required unless `connect` is supplied. Reads the connection to mint a token. */
  prisma?: ConfluenceConnectionClient;
  /** Passed straight through to `currentAccessTokenForOrganisation`. */
  connection?: ConfluenceConnectionDeps;
  connect?: ConfluenceReconcileConnect;
  operations?: Partial<ConfluenceReconcileOperations>;
};

/**
 * Per-tenant result. `pages` is what was read; `outcome` is the tenant-level
 * answer written to `OrganisationIntegration`.
 */
export type TenantReconcileResult = {
  outcome: IntegrationReconcileOutcome;
  readings: Array<{ publicationId: string; reading: RemoteStateReading }>;
  /**
   * True when the whole run must stop, not just this tenant. Only a rate limit
   * sets it: Atlassian's hourly points pool is shared across every tenant of
   * the app, so continuing to the next charity spends the same exhausted
   * budget and makes one busy charity's problem into everybody's.
   */
  abortRun: boolean;
};

/** Reads the HTTP status the client recorded on an upstream failure. */
function upstreamStatus(error: unknown): number | undefined {
  if (!(error instanceof AppError)) return undefined;
  const details = error.details;
  if (details === null || typeof details !== 'object') return undefined;
  const status = (details as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Whether this error means the whole run should stop.
 *
 * Both rate-limit codes count. `CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY` cannot
 * arise from a read — every call this job makes is idempotent — but treating it
 * as anything other than a rate limit here would mean a future non-idempotent
 * addition silently stopped aborting the run.
 */
function isRateLimited(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === 'CONFLUENCE_RATE_LIMITED' || error.code === 'CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY')
  );
}

/**
 * 401 and 403 arrive as the SAME error code.
 *
 * `confluence-client.ts` maps both to `CONFLUENCE_RECONNECT_REQUIRED`, which is
 * right for a publisher — either way the charity has to act — but wrong for
 * this job, where they mean opposite things. A 401 is the grant: nothing will
 * work until the charity reconnects, so the tenant is abandoned. A 403 is one
 * page's permissions: the grant is fine, this page is not readable, and the
 * other pages must still be checked. The only thing separating them is the
 * numeric status the client preserved in `details`, so read it rather than
 * inferring from the code.
 */
function isGrantRejected(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'CONFLUENCE_RECONNECT_REQUIRED' &&
    upstreamStatus(error) === 401
  );
}

function isPageForbidden(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'CONFLUENCE_RECONNECT_REQUIRED' &&
    upstreamStatus(error) === 403
  );
}

function defaultConnect(deps: ConfluenceReconcilerDeps): ConfluenceReconcileConnect {
  const prisma = deps.prisma;
  if (!prisma) {
    throw new TypeError('createConfluenceReconciler needs either a prisma client or a connect function.');
  }

  return async ({ organisationId, cloudId }) => {
    // Taken ONCE and held for the tenant's whole visit, unlike the publisher's
    // thunk. The publisher re-reads because a backoff can outlive an access
    // token; this job never sleeps (see the rate-limit rule), so a single token
    // covers the visit — and taking it once is what makes "one token per tenant
    // WITH WORK" an assertable property rather than an intention.
    const accessToken = await currentAccessTokenForOrganisation(
      prisma,
      { organisationId },
      deps.connection,
    );
    return {
      accessToken,
      client: createConfluenceClient({ cloudId, getAccessToken: async () => accessToken }),
    };
  };
}

export type ConfluenceReconciler = (input: {
  tenant: ReconcileTenant;
  publications: ReconcilablePublication[];
}) => Promise<TenantReconcileResult>;

export function createConfluenceReconciler(deps: ConfluenceReconcilerDeps): ConfluenceReconciler {
  const connect = deps.connect ?? defaultConnect(deps);
  const operations: ConfluenceReconcileOperations = { ...DEFAULT_OPERATIONS, ...deps.operations };

  return async ({ tenant, publications }): Promise<TenantReconcileResult> => {
    // THE DORMANCY GATE. Before anything else, and specifically before a token
    // is minted. An empty claim means this tenant has nothing live to
    // reconcile, and the ruling says such a tenant is not to be visited at all.
    if (publications.length === 0) {
      return { outcome: 'OK', readings: [], abortRun: false };
    }

    if (tenant.siteId === null || tenant.siteId.length === 0) {
      return { outcome: 'SITE_NOT_ACCESSIBLE', readings: [], abortRun: false };
    }

    let client: ConfluenceClient;
    let accessToken: string;
    try {
      ({ client, accessToken } = await connect({
        organisationId: tenant.organisationId,
        cloudId: tenant.siteId,
      }));
    } catch (error) {
      if (isRateLimited(error)) return { outcome: 'RATE_LIMITED', readings: [], abortRun: true };
      if (isGrantRejected(error)) return { outcome: 'RECONNECT_REQUIRED', readings: [], abortRun: false };
      throw error;
    }

    // Probe the site ONCE, before touching a page. A site the grant no longer
    // reaches produces a 404 on every page, which is indistinguishable from
    // every page having been purged — and this job's whole output is the
    // difference between those two. Establishing the site is reachable first
    // is what makes a later 404 mean what it says.
    try {
      const sites = await operations.listAccessibleResources(accessToken);
      if (!sites.some((site) => site.id === tenant.siteId)) {
        return { outcome: 'SITE_NOT_ACCESSIBLE', readings: [], abortRun: false };
      }
    } catch (error) {
      if (isRateLimited(error)) return { outcome: 'RATE_LIMITED', readings: [], abortRun: true };
      if (isGrantRejected(error) || isPageForbidden(error)) {
        return { outcome: 'RECONNECT_REQUIRED', readings: [], abortRun: false };
      }
      throw error;
    }

    const readings: Array<{ publicationId: string; reading: RemoteStateReading }> = [];
    let firstPage = true;

    for (const publication of publications) {
      // A row with no page id was claimed but never got as far as creating one.
      // There is nothing remote to read, and inventing a state for it would put
      // "gone" against a page that was never there.
      if (publication.pageId === null || publication.pageId.length === 0) continue;

      let reading: RemoteStateReading;
      try {
        reading = await readRemoteState(operations, client, publication.pageId);
      } catch (error) {
        if (isRateLimited(error)) {
          // Stop claiming, and leave every unread row unstamped so the next run
          // picks them up in the same order rather than treating them as seen.
          return { outcome: 'RATE_LIMITED', readings, abortRun: true };
        }
        if (isGrantRejected(error)) {
          return { outcome: 'RECONNECT_REQUIRED', readings, abortRun: false };
        }
        if (isPageForbidden(error)) {
          // The first page being refused is not a page-level fact. The grant
          // reaches the site but not its content, which will be true of every
          // page, so reading the rest spends the shared rate-limit pool to
          // learn the same thing N times.
          if (firstPage) return { outcome: 'FORBIDDEN', readings, abortRun: false };
          readings.push({
            publicationId: publication.id,
            reading: {
              state: 'UNKNOWN',
              determinate: false,
              version: null,
              title: null,
              errorCode: 'CONFLUENCE_PAGE_FORBIDDEN',
            },
          });
          firstPage = false;
          continue;
        }
        if (error instanceof AppError && error.code === 'CONFLUENCE_RESPONSE_INVALID') {
          // A provider shape/status change is a page-level unknown, not a
          // reason to abandon other pages in this tenant's bounded batch.
          readings.push({ publicationId: publication.id, reading: {
            state: 'UNKNOWN', determinate: false, version: null, title: null,
            errorCode: 'CONFLUENCE_RESPONSE_INVALID',
          } });
          firstPage = false;
          continue;
        }
        throw error;
      }

      readings.push({ publicationId: publication.id, reading });
      firstPage = false;
    }

    return { outcome: 'OK', readings, abortRun: false };
  };
}

/**
 * One page's remote state.
 *
 * The first v2 read may return HTTP 200 with status=trashed; getPage treats
 * that as absent from the current view. The second, status-filtered v2 read
 * establishes whether the page is recoverable in trash or absent. A live C01
 * sandbox check showed the old v1 trash endpoint returning HTTP 410.
 */
async function readRemoteState(
  operations: ConfluenceReconcileOperations,
  client: ConfluenceClient,
  pageId: string,
): Promise<RemoteStateReading> {
  const page = await operations.getPage(client, pageId);
  if (page !== null) {
    if (page.status !== undefined && page.status !== 'current' && page.status !== 'archived') {
      return { state: 'UNKNOWN', determinate: false, version: null, title: null,
        errorCode: 'CONFLUENCE_PAGE_STATUS_UNRECOGNISED' };
    }
    return {
      state: page.status === 'archived' ? 'ARCHIVED' : 'VISIBLE',
      determinate: true,
      version: page.version,
      title: page.title.length > 0 ? page.title : null,
      errorCode: null,
    };
  }

  const trashed = await operations.getTrashedPage(client, pageId);
  if (trashed !== null) {
    return {
      state: 'TRASHED',
      determinate: true,
      version: trashed.version,
      title: trashed.title.length > 0 ? trashed.title : null,
      errorCode: null,
    };
  }

  return { state: 'GONE', determinate: true, version: null, title: null, errorCode: null };
}
