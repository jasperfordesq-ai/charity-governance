/**
 * The Confluence connection lifecycle: establish it, keep it alive, tear it
 * down.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ATLASSIAN'S REFRESH TOKENS ROTATE AND ARE SINGLE-USE. READ THIS FIRST.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Every successful refresh invalidates the refresh token it was called with
 * and returns a replacement. Three consequences shape everything below:
 *
 * 1. **Two concurrent refreshes destroy each other.** CharityPilot refreshes
 *    from web routes *and* from background jobs. If both call Atlassian with
 *    the same stored token, one wins; the loser's token is already dead and
 *    its retry comes back `invalid_grant`. Read as "the tenant revoked us",
 *    that marks a perfectly healthy integration broken. So refreshes are
 *    serialised per integration by a claim on the row
 *    (`refreshClaimedAt`/`refreshClaimToken`), and **a refresh never happens
 *    without holding that claim** — which is also what makes an
 *    `invalid_grant` decidable: if you did not hold the claim you never
 *    called Atlassian, so an `invalid_grant` you actually saw is real.
 *
 * 2. **A crash between refreshing and storing is unrecoverable.** The old
 *    token dies the instant Atlassian responds. So the replacement is written
 *    durably, in its own committed write, *before* the new access token is
 *    stored, returned or used for anything. A process that dies before that
 *    write leaves the charity needing to re-authorise by hand — the window
 *    cannot be eliminated, only made as small as one statement.
 *
 * 3. **Ninety days of inactivity expires the refresh token**, the clock
 *    resetting on each use. An idle charity is silently disconnected by
 *    Atlassian; `invalid_grant` is how that surfaces, and `lastError` is
 *    where it is made visible.
 *
 * The claim idiom is not invented here: it mirrors
 * `markDeadLetterAlertSent` / `releaseDeadLetterAlertClaim` in
 * `document.service.ts`, down to **fencing the release on the claim token in
 * the `WHERE` clause**. A release that does not match the value it claimed
 * with can clear a *newer* claim taken by somebody else — the exact race the
 * claim exists to prevent. Holding a token without fencing on it is the
 * weaker pattern wearing the appearance of the stronger one.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THIS MODULE DOES NOT AUTHORIZE, FOR THE SAME REASON THE CREDENTIAL VAULT
 * DOES NOT. Every `integrationId` reaching these functions must already have
 * been proven to belong to the requesting organisation — prefer looking the
 * row up by `organisationId_provider` so an id never has to be accepted from
 * a request at all. See the banner at the top of
 * `integration-credential.service.ts`.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * No plaintext token, authorization code or client secret is ever logged,
 * returned, or put into an error message, an error `details` or an error
 * `cause` by anything here.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  exchangeAuthorizationCode as exchangeAuthorizationCodeDefault,
  listAccessibleResources as listAccessibleResourcesDefault,
  refreshAccessToken as refreshAccessTokenDefault,
  type OAuthDeps,
  type RefreshTokenOutcome,
} from './atlassian-oauth.js';
import {
  loadIntegrationCredential,
  storeIntegrationCredential,
  type IntegrationCredentialWriteClient,
} from './integration-credential.service.js';
import { AppError } from '../utils/errors.js';

/** The label the sealed envelope is stored under — never the value. */
const ACCESS_TOKEN_KIND = 'access_token';
const REFRESH_TOKEN_KIND = 'refresh_token';

const PROVIDER = 'CONFLUENCE' as const;

/**
 * How long a claim may be held before another worker may take it.
 *
 * Deliberately the same ten minutes as `document.service.ts`'s sibling
 * claims, and deliberately generous. The window must comfortably exceed the
 * worst case duration of one refresh, because a window that expires while the
 * holder is still mid-flight lets a second worker refresh with the same
 * stored token — the precise destruction the claim exists to prevent.
 * `fetch` has no default timeout in Node, so "worst case" is not a short
 * number.
 *
 * The cost of the generosity is bounded and much cheaper: a claim leaked by a
 * crash blocks that one charity's refresh for up to ten minutes, during which
 * callers get a clear, retryable `CONFLUENCE_REFRESH_IN_PROGRESS` rather than
 * a permanent disconnection.
 */
export const REFRESH_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;

/** How long a caller that lost the claim waits before re-reading. */
const REFRESH_CLAIM_WAIT_MS = 250;

/** How many times a caller that lost the claim re-reads before giving up. */
const REFRESH_CLAIM_MAX_ATTEMPTS = 8;

export type ConfluenceConnectionClient = IntegrationCredentialWriteClient;

export type ConfluenceConnectionDeps = {
  /** Forwarded to the OAuth module (injectable `fetch` and client credentials). */
  oauth?: OAuthDeps;
  exchangeAuthorizationCode?: typeof exchangeAuthorizationCodeDefault;
  refreshAccessToken?: typeof refreshAccessTokenDefault;
  listAccessibleResources?: typeof listAccessibleResourcesDefault;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export type ConnectConfluenceInput = {
  organisationId: string;
  userId: string;
  code: string;
  redirectUri: string;
};

export type ConfluenceIntegrationRef = {
  integrationId: string;
};

type RefreshClaim = {
  token: string;
  claimedAt: Date;
};

function resolveNow(deps: ConfluenceConnectionDeps): () => Date {
  return deps.now ?? (() => new Date());
}

function resolveSleep(deps: ConfluenceConnectionDeps): (ms: number) => Promise<void> {
  return (
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }))
  );
}

// ── the claim ──────────────────────────────────────────────────────────────

/**
 * Take the refresh claim, or return null because somebody else holds it.
 *
 * One conditional statement, exactly like `claimUnalertedDeadLetters`: the
 * `WHERE` carries the precondition, so the database — not this process —
 * decides who won. `refreshClaimToken` and `refreshClaimedAt` are always
 * written together; a CHECK constraint on the table rejects any write that
 * sets one without the other.
 */
async function acquireRefreshClaim(
  prisma: ConfluenceConnectionClient,
  integrationId: string,
  now: Date,
): Promise<RefreshClaim | null> {
  const staleBefore = new Date(now.getTime() - REFRESH_CLAIM_STALE_AFTER_MS);
  const token = randomUUID();

  const claimed = await prisma.organisationIntegration.updateMany({
    where: {
      id: integrationId,
      OR: [{ refreshClaimedAt: null }, { refreshClaimedAt: { lt: staleBefore } }],
    },
    data: { refreshClaimToken: token, refreshClaimedAt: now },
  });

  return claimed.count === 1 ? { token, claimedAt: now } : null;
}

/**
 * Give the claim back, **fenced on the token it was taken with**.
 *
 * Without `refreshClaimToken: claim.token` in the `WHERE`, a release from a
 * slow or stale holder would clear whatever claim happens to be on the row —
 * including a newer one somebody else is actively refreshing under. The fence
 * is the whole safety property; the token is not a receipt, it is the
 * condition.
 *
 * Idempotent by construction: once the success/failure writes below have
 * cleared the pair, this matches nothing and writes nothing, which is why
 * every path can call it unconditionally.
 */
async function releaseRefreshClaim(
  prisma: ConfluenceConnectionClient,
  integrationId: string,
  claim: RefreshClaim,
): Promise<void> {
  await prisma.organisationIntegration.updateMany({
    where: { id: integrationId, refreshClaimToken: claim.token },
    data: { refreshClaimToken: null, refreshClaimedAt: null },
  });
}

/** Record a successful refresh and release the claim in the same fenced write. */
async function markRefreshSucceeded(
  prisma: ConfluenceConnectionClient,
  integrationId: string,
  claim: RefreshClaim,
  at: Date,
): Promise<void> {
  await prisma.organisationIntegration.updateMany({
    where: { id: integrationId, refreshClaimToken: claim.token },
    data: {
      status: 'CONNECTED',
      lastError: null,
      lastRefreshedAt: at,
      refreshFailureCount: 0,
      refreshClaimToken: null,
      refreshClaimedAt: null,
    },
  });
}

/**
 * The grant itself is gone: revoked by the charity, or expired after ninety
 * idle days. This is the one failure an administrator can actually act on, so
 * it is the one that sets `status: ERROR` and writes `lastError`.
 *
 * Only ever called from inside a held claim. A caller that lost the race
 * never reaches here, because it never called Atlassian.
 */
async function markReconnectRequired(
  prisma: ConfluenceConnectionClient,
  integrationId: string,
  claim: RefreshClaim,
  reason: string,
): Promise<void> {
  await prisma.organisationIntegration.updateMany({
    where: { id: integrationId, refreshClaimToken: claim.token },
    data: {
      status: 'ERROR',
      lastError: reason,
      refreshFailureCount: { increment: 1 },
      refreshClaimToken: null,
      refreshClaimedAt: null,
    },
  });
}

/**
 * A refresh that failed for a reason that is not the charity's grant — a
 * network blip, a 5xx, a misconfigured `ATLASSIAN_CLIENT_SECRET`. Counted, but
 * deliberately **not** status-changing and deliberately not written to
 * `lastError`: telling a charity to reconnect because Atlassian was briefly
 * unreachable is exactly the false alarm this module exists to avoid, and
 * `invalid_client` is our misconfiguration to fix, not theirs.
 */
async function recordTransientRefreshFailure(
  prisma: ConfluenceConnectionClient,
  integrationId: string,
  claim: RefreshClaim,
): Promise<void> {
  await prisma.organisationIntegration.updateMany({
    where: { id: integrationId, refreshClaimToken: claim.token },
    data: {
      refreshFailureCount: { increment: 1 },
      refreshClaimToken: null,
      refreshClaimedAt: null,
    },
  });
}

// ── reading the stored access token ────────────────────────────────────────

/**
 * The stored access token if it is still usable, else null.
 *
 * The expiry is read first, from the unsealed column, so a token that is
 * already expired is never decrypted. A null `expiresAt` counts as expired:
 * a credential with no known lifetime must be renewed rather than presented
 * hopefully. (`atlassian-oauth.ts` already subtracts a 60s safety margin when
 * computing `expiresAt`, so "in the future" here means "still has a usable
 * margin".)
 */
async function readValidAccessToken(
  prisma: ConfluenceConnectionClient,
  integrationId: string,
  now: Date,
): Promise<string | null> {
  const stored = await prisma.integrationCredential.findUnique({
    where: { integrationId_kind: { integrationId, kind: ACCESS_TOKEN_KIND } },
    select: { expiresAt: true },
  });

  if (!stored?.expiresAt || stored.expiresAt.getTime() <= now.getTime()) return null;

  return loadIntegrationCredential(prisma, { integrationId, kind: ACCESS_TOKEN_KIND });
}

// ── the rotating refresh token ─────────────────────────────────────────────

/**
 * Persist whatever Atlassian did — or did not — issue in place of the refresh
 * token we just spent.
 *
 * The switch is exhaustive on purpose, and **every non-`issued` arm is a
 * no-op on purpose**. `not_rotated` means Atlassian chose not to rotate and
 * the token already on file is still current; writing anything at all here —
 * a null above all — destroys a working credential silently and permanently.
 * That is the single most expensive mistake available in this file, so the
 * decision is made in exactly one place and no caller derives it.
 */
async function persistRotatedRefreshToken(
  prisma: ConfluenceConnectionClient,
  integrationId: string,
  outcome: RefreshTokenOutcome,
): Promise<void> {
  switch (outcome.kind) {
    case 'issued':
      await storeIntegrationCredential(prisma, {
        integrationId,
        kind: REFRESH_TOKEN_KIND,
        plaintext: outcome.token,
      });
      return;
    case 'not_rotated':
      // The stored token is still current. Leave it exactly as it is.
      return;
    case 'unavailable':
      // `refreshAccessToken` never produces this (see `RefreshTokenOutcome`).
      // If it ever did, "no refresh token was issued" would still not be a
      // reason to delete the one on file.
      return;
    default: {
      const exhaustive: never = outcome;
      void exhaustive;
      // Deliberately does not interpolate the value: a future variant of the
      // union could carry a token, and this string could reach a log.
      throw new AppError(
        500,
        'ATLASSIAN_REFRESH_OUTCOME_UNHANDLED',
        'Atlassian returned a refresh-token outcome this deployment does not understand.',
      );
    }
  }
}

/**
 * Whether an error means the charity's grant is gone, as opposed to anything
 * else that can go wrong on the way to Atlassian.
 *
 * Keyed on `invalid_grant` alone, and on the OAuth error field rather than the
 * HTTP status. Atlassian answers a bad *client* credential with 401 and
 * `invalid_client`; treating that as a revoked grant would mark **every**
 * charity broken and tell them all to reconnect over a configuration mistake
 * of ours. An unreadable error body carries no `error` field and therefore
 * lands here as `false`, which is the conservative side to fail to.
 */
function isGrantRejected(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  const details = error.details as { error?: unknown } | undefined;
  return typeof details?.error === 'string' && details.error === 'invalid_grant';
}

const GRANT_REJECTED_REASON =
  'Atlassian rejected the stored Confluence refresh token (invalid_grant). ' +
  'Reconnect Confluence: the authorisation was revoked, or the refresh token ' +
  'expired after 90 days without use.';

const NO_REFRESH_TOKEN_REASON =
  'No Confluence refresh token is stored for this integration, so its access ' +
  'token can never be renewed. Reconnect Confluence.';

// ── the public surface ─────────────────────────────────────────────────────

/**
 * Exchange an authorization code for tokens, record the site, and seal both
 * tokens into the vault.
 *
 * Everything that can refuse the connection is checked **before** the first
 * write, so a connection that could never be refreshed is never half-created.
 */
export async function connectConfluence(
  prisma: ConfluenceConnectionClient,
  { organisationId, userId, code, redirectUri }: ConnectConfluenceInput,
  deps: ConfluenceConnectionDeps = {},
): Promise<{ integrationId: string; siteUrl: string }> {
  const exchange = deps.exchangeAuthorizationCode ?? exchangeAuthorizationCodeDefault;
  const listSites = deps.listAccessibleResources ?? listAccessibleResourcesDefault;
  const now = resolveNow(deps);

  const tokens = await exchange(code, redirectUri, deps.oauth);

  if (tokens.refreshToken.kind !== 'issued') {
    // Without `offline_access` the access token dies within the hour and
    // nothing can renew it. Failing here is far kinder than a connection that
    // looks fine until lunchtime.
    throw new AppError(
      400,
      'CONFLUENCE_OFFLINE_ACCESS_NOT_GRANTED',
      'Atlassian issued no refresh token for this authorisation, so the connection ' +
        'could not be kept alive. Re-authorise including the offline_access scope.',
    );
  }
  const refreshToken = tokens.refreshToken.token;

  const sites = await listSites(tokens.accessToken, deps.oauth);
  const site = sites[0];
  if (!site) {
    throw new AppError(
      400,
      'CONFLUENCE_NO_ACCESSIBLE_SITE',
      'The Atlassian account that authorised CharityPilot can reach no Confluence site.',
    );
  }
  // Choosing the first site is deliberate and temporary: letting a charity
  // pick among several belongs with the UI that shows them, and is out of
  // scope here. Only non-secret connection facts go into `config`.
  const config = { siteId: site.id, siteUrl: site.url, siteName: site.name } satisfies Prisma.InputJsonObject;

  const at = now();
  const connectedState = {
    status: 'CONNECTED',
    config,
    lastError: null,
    connectedAt: at,
    connectedById: userId,
    // A reconnect supersedes whatever the old credential was doing, including
    // a claim leaked by a crash and the failure count that went with it.
    refreshFailureCount: 0,
    lastRefreshedAt: at,
    refreshClaimToken: null,
    refreshClaimedAt: null,
  } as const;

  const integration = await prisma.organisationIntegration.upsert({
    where: { organisationId_provider: { organisationId, provider: PROVIDER } },
    create: { organisationId, provider: PROVIDER, ...connectedState },
    update: connectedState,
    select: { id: true },
  });

  // The refresh token first: it is the irreplaceable one, and the access
  // token is worthless on its own an hour from now.
  await storeIntegrationCredential(prisma, {
    integrationId: integration.id,
    kind: REFRESH_TOKEN_KIND,
    plaintext: refreshToken,
  });
  await storeIntegrationCredential(prisma, {
    integrationId: integration.id,
    kind: ACCESS_TOKEN_KIND,
    plaintext: tokens.accessToken,
    expiresAt: tokens.expiresAt,
  });

  return { integrationId: integration.id, siteUrl: site.url };
}

/**
 * A usable Confluence access token, refreshing it if need be — and refreshing
 * it **at most once across every process in the deployment**.
 *
 * The shape, in order:
 *
 *   1. Return the stored token if it is still valid. No claim, no HTTP.
 *   2. Otherwise try to claim the refresh.
 *   3. Lost the claim? Somebody else is refreshing. Wait, re-read, and take
 *      their result. Never refresh in parallel.
 *   4. Won the claim? Refresh, then store the replacement refresh token
 *      before the new access token is stored, returned or used.
 *   5. Release the claim on every path, fenced on the token.
 */
export async function currentAccessToken(
  prisma: ConfluenceConnectionClient,
  { integrationId }: ConfluenceIntegrationRef,
  deps: ConfluenceConnectionDeps = {},
): Promise<string> {
  const now = resolveNow(deps);
  const sleep = resolveSleep(deps);

  const stored = await readValidAccessToken(prisma, integrationId, now());
  if (stored) return stored;

  // Established before the claim loop so a nonexistent integration is named
  // as one, instead of looking indistinguishable from a lost race.
  const integration = await prisma.organisationIntegration.findUnique({
    where: { id: integrationId },
    select: { id: true },
  });
  if (!integration) {
    throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'Integration not found');
  }

  for (let attempt = 0; attempt < REFRESH_CLAIM_MAX_ATTEMPTS; attempt += 1) {
    const claim = await acquireRefreshClaim(prisma, integrationId, now());
    if (claim) return refreshUnderClaim(prisma, integrationId, claim, deps);

    // Somebody else holds the claim. Their refresh will store an access token
    // this caller can use, so wait for it rather than racing it.
    await sleep(REFRESH_CLAIM_WAIT_MS);
    const refreshed = await readValidAccessToken(prisma, integrationId, now());
    if (refreshed) return refreshed;
  }

  throw new AppError(
    409,
    'CONFLUENCE_REFRESH_IN_PROGRESS',
    'Another process is refreshing this Confluence connection. Try again shortly.',
  );
}

/**
 * The refresh itself. Only ever entered holding `claim`, which is what makes
 * every `invalid_grant` seen in here genuine.
 */
async function refreshUnderClaim(
  prisma: ConfluenceConnectionClient,
  integrationId: string,
  claim: RefreshClaim,
  deps: ConfluenceConnectionDeps,
): Promise<string> {
  const refresh = deps.refreshAccessToken ?? refreshAccessTokenDefault;
  const now = resolveNow(deps);

  try {
    // Somebody may have refreshed and released between this caller's first
    // read and its claim. Spending a rotation to re-derive a token that is
    // already stored is pure loss, so check once more now that nobody else
    // can be mid-refresh.
    const alreadyFresh = await readValidAccessToken(prisma, integrationId, now());
    if (alreadyFresh) return alreadyFresh;

    const storedRefreshToken = await loadIntegrationCredential(prisma, {
      integrationId,
      kind: REFRESH_TOKEN_KIND,
    });
    if (!storedRefreshToken) {
      await markReconnectRequired(prisma, integrationId, claim, NO_REFRESH_TOKEN_REASON);
      throw new AppError(409, 'CONFLUENCE_RECONNECT_REQUIRED', NO_REFRESH_TOKEN_REASON);
    }

    let tokens;
    try {
      tokens = await refresh(storedRefreshToken, deps.oauth);
    } catch (error) {
      if (isGrantRejected(error)) {
        await markReconnectRequired(prisma, integrationId, claim, GRANT_REJECTED_REASON);
      } else {
        await recordTransientRefreshFailure(prisma, integrationId, claim);
      }
      throw error;
    }

    // ────────────────────────────────────────────────────────────────────
    // The token just used is dead as of the line above. Nothing may happen
    // between here and this write: no logging, no access-token store, no
    // return. Its own committed write, batched with nothing.
    // ────────────────────────────────────────────────────────────────────
    try {
      await persistRotatedRefreshToken(prisma, integrationId, tokens.refreshToken);
    } catch (error) {
      if (error instanceof AppError) throw error;
      // The replacement exists only at Atlassian and in this stack frame, and
      // the old one is gone. Loud, 500-level (so it pages), and carrying
      // neither the token nor the underlying error as `cause`, which could
      // echo query parameters.
      throw new AppError(
        500,
        'CONFLUENCE_REFRESH_TOKEN_PERSIST_FAILED',
        'Atlassian issued a replacement Confluence refresh token but it could not be ' +
          'stored. The previous token is no longer valid; this charity may have to ' +
          'reconnect Confluence.',
      );
    }

    await storeIntegrationCredential(prisma, {
      integrationId,
      kind: ACCESS_TOKEN_KIND,
      plaintext: tokens.accessToken,
      expiresAt: tokens.expiresAt,
    });

    await markRefreshSucceeded(prisma, integrationId, claim, now());
    return tokens.accessToken;
  } finally {
    // Unconditional, and safe *because* it is fenced: the success and failure
    // writes above have already cleared the pair, so this matches no row and
    // writes nothing. A release that failed here would leave the claim to age
    // out through the staleness window, which is survivable — masking the real
    // error with a database error from the cleanup path would not be.
    try {
      await releaseRefreshClaim(prisma, integrationId, claim);
    } catch {
      // Intentionally swallowed; see above.
    }
  }
}

/**
 * Drop the connection: delete every sealed credential, and return the row to
 * a disconnected state.
 *
 * Both halves are one transaction. Deleting the credentials while leaving the
 * row `CONNECTED` would advertise a connection with nothing behind it, and
 * marking the row disconnected while leaving sealed tokens on disk would keep
 * a credential the charity believes it has revoked.
 *
 * `config` is deliberately left alone: it holds only non-secret site facts,
 * and keeping them means a reconnect — or an administrator asking "which site
 * was this?" — has something to go on. `status` is the truth about whether the
 * connection is live.
 */
export async function disconnectConfluence(
  prisma: ConfluenceConnectionClient,
  { integrationId }: ConfluenceIntegrationRef,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.integrationCredential.deleteMany({ where: { integrationId } });
    await tx.organisationIntegration.updateMany({
      where: { id: integrationId },
      data: {
        status: 'DISCONNECTED',
        lastError: null,
        connectedAt: null,
        connectedById: null,
        lastRefreshedAt: null,
        refreshFailureCount: 0,
        refreshClaimToken: null,
        refreshClaimedAt: null,
      },
    });
  });
}
