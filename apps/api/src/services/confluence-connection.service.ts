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
 * 4. **A reconnect can land while a refresh is in flight.** The claim protects
 *    the *row*, and every row write here is fenced on it. It does not protect
 *    the *vault*: `storeIntegrationCredential` upserts on `integrationId_kind`
 *    and takes no precondition, so a refresher that got its rotation before an
 *    administrator re-authorised and persists after would put the previous
 *    grant's tokens behind a freshly connected row, silently. So the
 *    refresher's sealed writes are fenced too — on `connectedAt`, the row's
 *    record of *which* authorisation the credentials belong to, not on the
 *    claim. See `authorisationFencedClient` for why that distinction is the
 *    whole of it.
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
 *
 * **Outside a route, `currentAccessTokenForOrganisation` is the only permitted
 * way to obtain an access token.** A route derives its `integrationId` from
 * the authenticated user and may use the by-id form; anything else — a job, a
 * client, a pipeline — holds a tenant rather than an id and must say so. That
 * is a test, not a convention: see "nothing outside a route may take a
 * Confluence access token by bare integration id".
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
  type IntegrationCredentialClient,
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

/**
 * The deadline on the one HTTP call made while holding the claim.
 *
 * The staleness window above is only safe while it **dominates** the worst
 * case duration of a refresh, and "fetch has no timeout" is not the same as
 * "fetch cannot take forever quietly". Node's undici defaults are
 * `headersTimeout` 300s and `bodyTimeout` 300s, which sum to ~600s — the
 * window itself. The margin in the pathological case is therefore about zero,
 * not comfortable, and a refresh that outlives its lease lets a second worker
 * legitimately steal the claim and refresh with the *same* stored token:
 * concurrent destruction through the back door.
 *
 * 30s against a 600s window restores a 20x margin, and is generous for a
 * single token exchange. Exceeding it surfaces through
 * `atlassian-oauth.ts`'s transport branch as `ATLASSIAN_OAUTH_UNREACHABLE` —
 * a transient failure, which is exactly right: a timed-out refresh is not a
 * revoked grant and must not mark the charity broken.
 */
export const REFRESH_REQUEST_TIMEOUT_MS = 30 * 1000;

/**
 * The deadline on each of the two HTTP calls `connectConfluence` makes.
 *
 * Deliberately far shorter than the refresh deadline above, because the thing
 * waiting is different. A refresh runs behind a background job or an
 * already-rendered page and its bound exists to protect the *claim lease*. A
 * connect runs on a live user-facing route with **a charity administrator
 * sitting in front of a browser tab**, and its bound exists to protect *them*.
 *
 * Unbounded, undici's defaults apply — `headersTimeout` 300s plus
 * `bodyTimeout` 300s, twice over for the two calls — so a stalled Atlassian
 * can hold that tab for up to twenty minutes. The single-use authorization
 * code expires inside that window (it shares the ten minutes of
 * `OAUTH_STATE_TTL_SECONDS`), so the administrator is left with a spinner
 * that resolves into an unrecoverable failure and no way forward but to start
 * the whole flow again.
 *
 * Ten seconds is the number because it has to satisfy both ends:
 *
 * - **Short enough for a person.** Twenty seconds worst case for the pair is
 *   about the longest a browser tab can hang before it reads as broken, and
 *   it leaves over 96% of the code's ten-minute life for a retry that can
 *   still succeed. That is the whole point — a bounded failure here is
 *   *recoverable*, an unbounded one is not.
 * - **Long enough for a working Atlassian.** Atlassian's token and
 *   accessible-resources endpoints answer in well under a second; ten seconds
 *   is more than an order of magnitude of headroom, so a merely slow response
 *   is not cut off. Anything past it is a stall, not slowness.
 *
 * Exceeding it surfaces through `atlassian-oauth.ts`'s transport branch as
 * `ATLASSIAN_OAUTH_UNREACHABLE` — a transient 502, which is correct: a
 * timed-out connect attempt is not a refused authorisation and must not tell
 * the charity their grant was rejected.
 */
export const CONNECT_REQUEST_TIMEOUT_MS = 10 * 1000;

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
  /** Overrides `REFRESH_REQUEST_TIMEOUT_MS`; exists so a test can use a short deadline. */
  refreshTimeoutMs?: number;
  /** Overrides `CONNECT_REQUEST_TIMEOUT_MS`; exists so a test can use a short deadline. */
  connectTimeoutMs?: number;
};

/**
 * Wrap a `fetch` so the request it makes cannot outlive `timeoutMs`.
 *
 * Built here rather than in `atlassian-oauth.ts` because the deadline belongs
 * to the *lease*, not to the HTTP client: it is this module's claim window
 * that the bound has to dominate. `OAuthDeps.fetch` is the seam that makes
 * that possible without reopening a closed module.
 *
 * An inbound signal is composed rather than replaced, so a future caller's own
 * cancellation still works alongside the deadline.
 */
function boundedFetch(base: typeof globalThis.fetch, timeoutMs: number): typeof globalThis.fetch {
  return (input, init) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return base(input, { ...init, signal });
  };
}

export type ConnectConfluenceInput = {
  organisationId: string;
  userId: string;
  code: string;
  redirectUri: string;
};

export type ConfluenceIntegrationRef = {
  integrationId: string;
};

/**
 * The reference a caller outside a route must use.
 *
 * An `organisationId` comes from an authenticated principal or from a job's
 * own tenant iteration; an `integrationId` comes from wherever the caller got
 * it, and the credential layer beneath will happily derive a context from
 * *that* charity's row and open the envelope. See
 * `currentAccessTokenForOrganisation`.
 */
export type ConfluenceOrganisationRef = {
  organisationId: string;
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

/**
 * The production deadlines, resolved in one place each.
 *
 * These exist to be *asserted on*. Every test that exercises a deadline
 * injects its own short value, so the fallback — the number that actually runs
 * in production — is reached by nothing in the suite. Written inline at the
 * call site, replacing either constant with a hardcoded ten minutes left every
 * test green while quietly removing the margin the claim lease depends on.
 *
 * The constants themselves are pinned (a 10x floor against
 * `REFRESH_CLAIM_STALE_AFTER_MS`, and against the code/state window for the
 * connect path). These functions pin the *join* between those constants and
 * the code that uses them, which is the part that was unpinned.
 */
export function resolveRefreshTimeoutMs(deps: ConfluenceConnectionDeps): number {
  return deps.refreshTimeoutMs ?? REFRESH_REQUEST_TIMEOUT_MS;
}

export function resolveConnectTimeoutMs(deps: ConfluenceConnectionDeps): number {
  return deps.connectTimeoutMs ?? CONNECT_REQUEST_TIMEOUT_MS;
}

/**
 * `deps.oauth` with its `fetch` bounded, leaving every other field alone.
 *
 * `atlassian-oauth.ts` is closed, and it has no business owning a deadline
 * that belongs to a caller's context anyway: the refresh path's bound answers
 * to the claim lease, the connect path's to a waiting human. `OAuthDeps.fetch`
 * is the seam that lets each caller state its own.
 */
function boundedOAuth(oauth: OAuthDeps | undefined, timeoutMs: number): OAuthDeps {
  return { ...oauth, fetch: boundedFetch(oauth?.fetch ?? globalThis.fetch, timeoutMs) };
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
 *
 * Note the staleness comparison is made against **application process time**,
 * not database time — `staleBefore` is computed here and sent as a literal.
 * A process whose clock runs far ahead therefore considers every claim stale
 * and steals them all. This is inherited from the sibling claims in
 * `document.service.ts`, which compute `staleBefore` the same way, so it is
 * recorded rather than fixed: diverging from the idiom for one of the four
 * claim sites in the codebase would be worse than the shared property. Moving
 * all of them to `NOW()` is a separate, deliberate change.
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

// ── the authorisation a refresh is performed against ───────────────────────

/**
 * Which authorisation the credentials on file belong to.
 *
 * `connectedAt` is written by `connectConfluence` and nulled by
 * `disconnectConfluence`, and by nothing else in the codebase — the status
 * route only reads it. That makes it the row's record of *which grant* the
 * sealed envelopes came from, which is the question a refresher has to be able
 * to answer before it writes.
 */
type AuthorisationGeneration = { connectedAt: Date | null };

async function readAuthorisationGeneration(
  prisma: ConfluenceConnectionClient,
  integrationId: string,
): Promise<AuthorisationGeneration> {
  const row = await prisma.organisationIntegration.findUnique({
    where: { id: integrationId },
    select: { connectedAt: true },
  });
  if (!row) throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'Integration not found');
  return { connectedAt: row.connectedAt };
}

function sameAuthorisation(a: AuthorisationGeneration, b: AuthorisationGeneration): boolean {
  if (a.connectedAt === null || b.connectedAt === null) return a.connectedAt === b.connectedAt;
  return a.connectedAt.getTime() === b.connectedAt.getTime();
}

/**
 * A refresh whose result belongs to an authorisation that is no longer the one
 * on file.
 *
 * Re-entering `currentAccessToken` resolves it, because the reconnect that
 * superseded this refresh stored a usable access token on its way past. That
 * is a statement about *this* function and nothing else: `confluence-client.ts`
 * has no entry for this code in its retry taxonomy yet, and nothing here
 * asserts how that client should classify it. Adding the entry belongs with the
 * Phase 3 documentation of the error taxonomy.
 */
const REFRESH_SUPERSEDED_CODE = 'CONFLUENCE_REFRESH_SUPERSEDED';

const REFRESH_SUPERSEDED_REASON =
  'This Confluence refresh was superseded before its result could be stored: the ' +
  'connection was re-authorised or disconnected while the refresh was in flight. ' +
  'Nothing was written — the credentials on file belong to the newer authorisation. ' +
  'Try again.';

/**
 * A view of the client whose sealed-credential writes land **only while the
 * authorisation they belong to is still the one on the row**.
 *
 * This is the fix for the reconnect race, and it needs the shape it has.
 * `storeIntegrationCredential` upserts on `integrationId_kind`; it is in a
 * closed module and it takes no precondition. So the precondition is supplied
 * where it can be: inside the transaction that module already opens around its
 * write. `$transaction` is the seam.
 *
 * The statement is a conditional no-op update. Its value is not the write —
 * it writes back what it matched — but the two things a conditional update
 * gives you:
 *
 *  - **the match count**, which decides whether this refresher's result still
 *    describes the credentials on file, and
 *  - **the row lock**, held until this transaction commits, which is what makes
 *    the decision hold rather than merely having been true a moment ago. A
 *    reconnect's `upsert` of the same row blocks on it, so the two orderings
 *    are the only two possible: either the reconnect lands first and this
 *    matches nothing, or this commits first and the reconnect's credential
 *    writes follow it and win.
 *
 * **Why `connectedAt` and not the refresh claim.** Fencing on the claim looks
 * more natural — the claim is already the file's concurrency primitive — and
 * it is wrong. A claim can be lost two ways: a reconnect replaced the
 * authorisation, or the claim simply aged out and another worker took it. In
 * the second case the refresher's rotation is a perfectly good replacement for
 * a refresh token Atlassian has already invalidated, and refusing to store it
 * destroys the charity's only means of renewal — the exact unrecoverable state
 * the "store the replacement durably first" rule exists to prevent. The test
 * "a slow holder never clears the newer claim that superseded it" catches it.
 * `connectedAt` separates the two cases precisely, because it changes for a
 * reconnect and does not change for a stolen claim.
 *
 * Note this deliberately does **not** fence the claim columns, so it cannot
 * half-write the CHECK-constrained pair.
 */
function authorisationFencedClient(
  prisma: ConfluenceConnectionClient,
  integrationId: string,
  authorisation: AuthorisationGeneration,
): ConfluenceConnectionClient {
  return {
    organisationIntegration: prisma.organisationIntegration,
    integrationCredential: prisma.integrationCredential,
    integrationSecretControl: prisma.integrationSecretControl,
    $transaction: <T>(run: (tx: IntegrationCredentialClient) => Promise<T>): Promise<T> =>
      prisma.$transaction(async (tx) => {
        const stillCurrent = await tx.organisationIntegration.updateMany({
          where: { id: integrationId, connectedAt: authorisation.connectedAt },
          data: { connectedAt: authorisation.connectedAt },
        });

        if (stillCurrent.count !== 1) {
          throw new AppError(409, REFRESH_SUPERSEDED_CODE, REFRESH_SUPERSEDED_REASON);
        }

        return run(tx);
      }),
  };
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
const REFRESH_OUTCOME_UNHANDLED_CODE = 'ATLASSIAN_REFRESH_OUTCOME_UNHANDLED';

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
        REFRESH_OUTCOME_UNHANDLED_CODE,
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

  // Both calls below are made on a live route with an administrator waiting on
  // a browser tab, and both are unbounded without this. See
  // CONNECT_REQUEST_TIMEOUT_MS: a stall does not merely delay the connection,
  // it burns the single-use authorization code's whole life while the person
  // watches a spinner.
  const bounded = boundedOAuth(deps.oauth, resolveConnectTimeoutMs(deps));

  const tokens = await exchange(code, redirectUri, bounded);

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

  const sites = await listSites(tokens.accessToken, bounded);
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
  // scope here. `siteCount` is recorded so that choice stays *visible* — a
  // status route can say "site 1 of N" rather than leaving a decision made on
  // a charity's behalf undiscoverable after the fact. Only non-secret
  // connection facts go into `config`.
  const config = {
    siteId: site.id,
    siteUrl: site.url,
    siteName: site.name,
    siteCount: sites.length,
  } satisfies Prisma.InputJsonObject;

  const at = now();
  // Deliberately does NOT set `status` or clear `lastError`. Until both sealed
  // credentials exist there is nothing behind this row, and a status route
  // that read `CONNECTED` in the gap would advertise a connection that cannot
  // serve a single request. An existing row keeps whatever status it had —
  // including `ERROR` — until the connection is genuinely usable.
  //
  // ── `connectedAt` IS DIFFERENT, AND DELIBERATELY SO ──────────────────────
  // Do not extend the reasoning above to it. `connectedAt` is stamped *here*,
  // in the write that precedes both credential writes, and that ordering is a
  // precondition of the refresh fence rather than a preference:
  // `authorisationFencedClient` excludes an in-flight refresher by matching on
  // the OLD value, so the new one has to be committed before the credentials it
  // is protecting. Written afterwards instead — the natural next edit, since
  // the status route exposes `connectedAt` too — the credential writes would
  // land inside the window where the old fence still matches, and a refresher
  // carrying the previous grant's rotation would overwrite them. Pinned by
  // "connectConfluence stamps the new authorisation before it writes either
  // credential".
  //
  // Stamping early has a cost, and it is the smaller one. If this function
  // fails between the upsert below and the refresh-token store, the row carries
  // the new `connectedAt` while the previous grant's credentials are still on
  // file, so a refresher fenced out in that moment discards a rotation whose
  // predecessor Atlassian has already invalidated. The way out of that is to
  // reconnect — the action that has just failed and that the administrator is
  // already retrying — so it is bounded and recoverable, unlike the silent
  // credential swap the ordering prevents.
  const connectingState = {
    config,
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
    // A created row takes the schema default, DISCONNECTED, for the same reason.
    create: { organisationId, provider: PROVIDER, ...connectingState },
    update: connectingState,
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

  // Now, and only now, is there a connection to advertise.
  await prisma.organisationIntegration.updateMany({
    where: { id: integration.id },
    data: { status: 'CONNECTED', lastError: null },
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
 * A usable Confluence access token for a charity, addressed by the charity.
 *
 * **This is the entry point for every caller outside a route**, and the rule
 * is enforced by a test rather than by this paragraph: see "nothing outside a
 * route may take a Confluence access token by bare integration id" in
 * `confluence-connection.service.test.ts`.
 *
 * `currentAccessToken` takes an `integrationId` and cannot check that the
 * caller is entitled to it — nothing below it can either. The credential vault
 * *binds* an envelope to its owner (a row copied between charities will not
 * open) but it does not *authorize*: the AAD context is derived from the
 * `OrganisationIntegration` row the id points at, so another charity's id
 * yields another charity's context and decrypts perfectly. Read the banner at
 * the top of `integration-credential.service.ts`.
 *
 * The route layer discharges that obligation by never accepting an id at all —
 * every lookup is keyed on `organisationId_provider` from the authenticated
 * user. This function is the same discipline made available to the callers
 * that have no request to derive an organisation from: a background publish
 * job holds a tenant, not an integration id, and handing it the weak form
 * would make "which charity's token is this?" a question about whatever value
 * happened to be in scope.
 */
export async function currentAccessTokenForOrganisation(
  prisma: ConfluenceConnectionClient,
  { organisationId }: ConfluenceOrganisationRef,
  deps: ConfluenceConnectionDeps = {},
): Promise<string> {
  const integration = await prisma.organisationIntegration.findUnique({
    where: { organisationId_provider: { organisationId, provider: PROVIDER } },
    select: { id: true },
  });

  if (!integration) {
    throw new AppError(
      404,
      'INTEGRATION_NOT_FOUND',
      'This organisation has no Confluence integration.',
    );
  }

  return currentAccessToken(prisma, { integrationId: integration.id }, deps);
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

    // Which authorisation the token about to be spent belongs to, read either
    // side of the load. A single read could straddle a reconnect and pair one
    // grant's token with the other grant's fence value: read first, and a token
    // loaded afterwards may be the *new* one, which would then be spent and its
    // replacement refused — a disconnection. Read after, and the token may be
    // the *old* one carrying the new fence value, which is the overwrite this
    // whole mechanism exists to stop. Two reads that agree admit neither, and
    // a disagreement costs nothing because nothing has been spent yet.
    const authorisationBefore = await readAuthorisationGeneration(prisma, integrationId);

    const storedRefreshToken = await loadIntegrationCredential(prisma, {
      integrationId,
      kind: REFRESH_TOKEN_KIND,
    });
    if (!storedRefreshToken) {
      await markReconnectRequired(prisma, integrationId, claim, NO_REFRESH_TOKEN_REASON);
      throw new AppError(409, 'CONFLUENCE_RECONNECT_REQUIRED', NO_REFRESH_TOKEN_REASON);
    }

    const authorisation = await readAuthorisationGeneration(prisma, integrationId);
    if (!sameAuthorisation(authorisationBefore, authorisation)) {
      // Nothing has been sent to Atlassian, so nothing has been spent and no
      // failure has occurred: the caller retries and reads the access token
      // the reconnect has just stored.
      throw new AppError(409, REFRESH_SUPERSEDED_CODE, REFRESH_SUPERSEDED_REASON);
    }

    // Every sealed write below goes through the fence. Both of them: a
    // `not_rotated` outcome writes no refresh token at all, so the access-token
    // store is the only write left, and it would otherwise hand the charity the
    // previous grant's access token under the new grant's row.
    const fenced = authorisationFencedClient(prisma, integrationId, authorisation);

    // The one call made while holding the lease, and the only one that has to
    // finish inside the staleness window. See REFRESH_REQUEST_TIMEOUT_MS.
    const bounded = boundedOAuth(deps.oauth, resolveRefreshTimeoutMs(deps));

    let tokens;
    try {
      tokens = await refresh(storedRefreshToken, bounded);
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
      await persistRotatedRefreshToken(fenced, integrationId, tokens.refreshToken);
    } catch (error) {
      // Only this module's own sentinel passes through. Everything else is
      // rewritten, INCLUDING an `AppError` — `storeIntegrationCredential` can
      // answer with a 404 (`INTEGRATION_NOT_FOUND`) or a 500
      // (`INTEGRATION_KEY_MISMATCH`), and surfacing either verbatim reports a
      // routine client error while the charity's only refresh token has in
      // fact just been destroyed. This is the single outcome that must page,
      // so the status must not be inherited from whatever failed.
      if (error instanceof AppError && error.code === REFRESH_OUTCOME_UNHANDLED_CODE) throw error;
      // The fence, likewise, is not a persist failure. A charity re-authorising
      // while a publish job happens to be refreshing is routine, and the
      // replacement this refresher could not store belongs to an authorisation
      // that has already been superseded — there is nothing to lose and nothing
      // to page anybody about.
      if (error instanceof AppError && error.code === REFRESH_SUPERSEDED_CODE) throw error;
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

    await storeIntegrationCredential(fenced, {
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
 * Drop the connection: withdraw the grant at Atlassian, delete every sealed
 * credential, and return the row to a disconnected state.
 *
 * The revocation comes first and is best effort — see the body. It is the
 * difference between a charity that has been told "disconnected" and a
 * charity whose authorisation is actually gone from the identity provider.
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
  deps: ConfluenceConnectionDeps = {},
): Promise<{ revoked: boolean }> {
  // Atlassian's OAuth 2.0 (3LO) revocation endpoint, declared here rather than
  // beside `TOKEN_URL` in `atlassian-oauth.ts` because that module is closed
  // and the authorisation to open this one covers this function alone.
  //
  // The *refresh* token is what is presented. Access tokens are short-lived
  // and cannot be withdrawn; revoking the refresh token is what ends the
  // grant, which is the thing the charity believes they are cancelling.
  const REVOKE_URL = 'https://auth.atlassian.com/oauth/revoke';

  // ── best effort, bounded, and never a precondition of forgetting ─────────
  //
  // A charity that presses Disconnect has withdrawn their consent, and that
  // is true whether or not Atlassian is reachable to be told. So the whole
  // attempt is wrapped: a transport failure, a rejection, a missing
  // encryption key, an envelope that will not open — none of them may leave
  // sealed credentials on disk for a connection the user believes is gone.
  // Making the deletion conditional on this succeeding would turn a third
  // party's outage into CharityPilot keeping secrets it was told to destroy.
  //
  // Bounded on `CONNECT_REQUEST_TIMEOUT_MS` for the same reason the connect
  // path is: an administrator is sitting in front of a browser tab, `fetch`
  // has no default timeout in Node, and a stalled Atlassian would otherwise
  // hold the disconnect open for undici's ~600s. The deadline turns the stall
  // into an abort, the abort into the catch below, and the disconnect
  // completes without it.
  let revoked = false;
  try {
    const refreshToken = await loadIntegrationCredential(prisma, {
      integrationId,
      kind: REFRESH_TOKEN_KIND,
    });
    // Nothing to withdraw, and a request with a null token would be answered
    // by Atlassian as a client error which `revoked` would then report as a
    // failure that never happened.
    if (refreshToken !== null) {
      const revokeFetch = boundedFetch(
        deps.oauth?.fetch ?? globalThis.fetch,
        resolveConnectTimeoutMs(deps),
      );
      const response = await revokeFetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          token: refreshToken,
          // Resolved the same way `atlassian-oauth.ts` resolves them, so a
          // deployment that injects its client does not revoke as a different
          // one than it connected as.
          client_id: deps.oauth?.clientId ?? process.env.ATLASSIAN_CLIENT_ID ?? '',
          client_secret: deps.oauth?.clientSecret ?? process.env.ATLASSIAN_CLIENT_SECRET ?? '',
        }),
      });
      revoked = response.ok;
    }
  } catch {
    // Swallowed on purpose, and swallowed *whole*: the error is not rethrown,
    // not logged and not attached as a `cause` anywhere, because Node's
    // `fetch failed` cause chain can carry the request — and this request
    // body holds a refresh token and the client secret.
  }

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

  // The outcome is reported rather than thrown: the disconnect succeeded
  // either way, and a caller that wants to say "we could not reach Atlassian
  // to withdraw the authorisation" needs to be able to tell.
  return { revoked };
}
