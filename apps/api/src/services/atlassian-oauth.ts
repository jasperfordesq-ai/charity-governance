import { AppError } from '../utils/errors.js';

// Deliberately does NOT import from '../utils/env.js'. env.ts already imports
// two service modules (document-storage-resolution.js, integration-crypto.js);
// importing it back from here would close a cycle. This module stays pure —
// like integration-crypto.ts — and reads process.env directly so env.ts (or
// anything else) can safely import *this* module later without a cycle.

const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

// A token is never presented to Atlassian at the exact instant it expires:
// callers that check `expiresAt` against "now" get a 60s buffer to act in.
const EXPIRY_SAFETY_MARGIN_SECONDS = 60;

/**
 * The outcome of a token response's optional `refresh_token` field.
 *
 * Atlassian omits `refresh_token` for two DIFFERENT reasons depending on
 * which call produced the response, and those reasons mean opposite things
 * to a caller that persists this result:
 *
 * - `{ kind: 'issued', token }` — Atlassian returned a refresh token
 *   (rotated or first-issued). Store it, replacing whatever was stored
 *   before.
 * - `{ kind: 'not_rotated' }` — only ever returned by `refreshAccessToken`.
 *   Atlassian chose not to rotate the refresh token on this call. The
 *   refresh token already on file (the one just used to make this call)
 *   is still current and valid. **Do not overwrite the stored refresh
 *   token — in particular, never with null** — or a working credential is
 *   permanently destroyed with no error anywhere.
 * - `{ kind: 'unavailable' }` — only ever returned by
 *   `exchangeAuthorizationCode`. `offline_access` was not granted during
 *   this authorization, so there is no refresh token and this credential
 *   can never be refreshed (short of the charity re-authorizing).
 *
 * The two omission cases are deliberately NOT collapsed to the same shape
 * (e.g. both to `null`): that collapse is what would let a caller treat
 * "unrotated, still valid" as "gone", which is the actual production risk.
 */
export type RefreshTokenOutcome =
  | { kind: 'issued'; token: string }
  | { kind: 'not_rotated' }
  | { kind: 'unavailable' };

export type AtlassianTokens = {
  accessToken: string;
  refreshToken: RefreshTokenOutcome;
  expiresAt: Date;
  scopes: string[];
};

export type OAuthDeps = {
  fetch?: typeof globalThis.fetch;
  clientId?: string;
  clientSecret?: string;
};

export type AccessibleResource = {
  id: string;
  url: string;
  name: string;
};

// Shape of Atlassian's token success response. Only the fields we use are
// declared; anything else on the body is never read, so it can never leak.
// All fields are typed as `unknown`-adjacent (optional / not asserted) on
// purpose: `parseTokenSuccessBody` is what actually validates them before
// anything here is trusted, so a malformed 200 response (missing
// `access_token`, missing `expires_in`, or a non-string `scope`) fails
// loudly instead of silently producing `undefined`/`Invalid Date`/a thrown
// `TypeError`.
type TokenSuccessBody = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
};

// Atlassian's OAuth error bodies carry exactly these two fields that are
// safe to surface. Everything else on an error body may echo back parts of
// the request (including the code/refresh_token/client_secret that were
// just sent) and must never be read out of it.
type TokenErrorBody = {
  error?: unknown;
  error_description?: unknown;
};

function resolveFetch(deps?: OAuthDeps): typeof globalThis.fetch {
  return deps?.fetch ?? globalThis.fetch;
}

function resolveClientId(deps?: OAuthDeps): string {
  return deps?.clientId ?? process.env.ATLASSIAN_CLIENT_ID ?? '';
}

function resolveClientSecret(deps?: OAuthDeps): string {
  return deps?.clientSecret ?? process.env.ATLASSIAN_CLIENT_SECRET ?? '';
}

function parseScopes(scope: string | undefined): string[] {
  if (!scope) return [];
  return scope.split(' ').filter((s) => s.length > 0);
}

function computeExpiresAt(expiresInSeconds: number): Date {
  const safeSeconds = expiresInSeconds - EXPIRY_SAFETY_MARGIN_SECONDS;
  return new Date(Date.now() + safeSeconds * 1000);
}

/**
 * Never attaches anything from the response body: the body is Atlassian's
 * own successful payload, not a reflection of our request, but a malformed
 * shape here is still a real operational problem (a downstream caller that
 * trusted `accessToken: undefined` or `expiresAt: Invalid Date` would
 * persist a broken credential that "looks" structurally fine). Fails
 * loudly with a single, consistent code instead.
 */
function invalidTokenResponse(detail: string): AppError {
  return new AppError(502, 'ATLASSIAN_OAUTH_RESPONSE_INVALID', `Atlassian returned ${detail}.`);
}

function parseTokenSuccessBody(body: unknown): { accessToken: string; expiresInSeconds: number; scope?: string; refreshToken?: string } {
  if (!body || typeof body !== 'object') {
    throw invalidTokenResponse('a token response body that was not an object');
  }
  const parsed = body as TokenSuccessBody;

  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    throw invalidTokenResponse('a token response with a missing or invalid access_token');
  }
  if (typeof parsed.expires_in !== 'number' || !Number.isFinite(parsed.expires_in) || parsed.expires_in <= 0) {
    // A non-positive lifetime is not a plausible honest response (it would
    // yield an already-expired expiresAt, which fails safe on its own, but
    // is still not a shape Atlassian would ever legitimately send).
    throw invalidTokenResponse('a token response with a missing or invalid expires_in');
  }
  if (parsed.scope !== undefined && typeof parsed.scope !== 'string') {
    throw invalidTokenResponse('a token response with a non-string scope');
  }
  if (parsed.refresh_token !== undefined && typeof parsed.refresh_token !== 'string') {
    throw invalidTokenResponse('a token response with a non-string refresh_token');
  }

  return {
    accessToken: parsed.access_token,
    expiresInSeconds: parsed.expires_in,
    scope: parsed.scope as string | undefined,
    refreshToken: parsed.refresh_token as string | undefined,
  };
}

// Atlassian's 401/403 mean "this credential is unauthorized/forbidden" —
// but apps/web's global axios interceptors (apps/web/src/lib/api.ts and
// apps/web/src/lib/owner-api.ts) treat ANY 401 response from OUR API as
// "the CharityPilot session expired": they call refreshSession()/retry,
// and on a second 401 force the user back to the login screen. Once a
// route wires this module in, letting an Atlassian 401 (an expired access
// token, or the token endpoint rejecting a bad grant with 401) pass
// through unchanged would bounce the charity's user out of CharityPilot
// entirely — even though their CharityPilot session was never the
// problem. 403 gets the same treatment on the same reasoning: a revoked or
// insufficiently-scoped Atlassian grant is not a CharityPilot permission
// problem either, and nothing should be free to build 403-specific
// "access denied" handling around what is actually a stale integration
// credential.
//
// 409 is used instead of inventing a 5xx or reusing another 4xx: the
// request itself is well-formed and the caller's own CharityPilot session/
// permissions are fine — what conflicts is the *stored* Atlassian
// credential's state (unauthorized/forbidden) with the assumption that it
// is still usable. It is deliberately not >=500 (this is not our server
// failing) and deliberately not 401/403 (see above). The exact number
// matters less than the code: `reconnectRequired` on the thrown AppError
// is what a route should actually branch on.
const RECONNECT_REQUIRED_STATUS_CODE = 409;

function isReconnectRequiredStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Maps an upstream HTTP status to the status this module throws with.
 *
 * A 4xx from Atlassian (invalid_grant, invalid_request, ...) is the charity
 * rejecting/expiring its own credential — a client error, not our server
 * failing — and is passed through unchanged, EXCEPT for 401/403 (see
 * `isReconnectRequiredStatus`), which are remapped to
 * `RECONNECT_REQUIRED_STATUS_CODE` so the web client's global session
 * interceptors never see them. Anything else (5xx, or a status this module
 * doesn't specifically recognise) becomes 502, since it reflects Atlassian
 * being unreachable/broken rather than the caller's input. This matters
 * operationally: statusCode >= 500 logs at error level and fires the
 * production alert webhook (see utils/errors.ts), so a user pasting a
 * stale authorization code must not page anyone, and Atlassian's
 * error_description must not egress to the alert webhook host.
 */
function mapUpstreamStatusCode(status: number): number {
  if (isReconnectRequiredStatus(status)) return RECONNECT_REQUIRED_STATUS_CODE;
  return status >= 400 && status < 500 ? status : 502;
}

/**
 * Throws for a non-2xx upstream response. `status` — the one discriminator
 * guaranteed present on every response, and the one thing here that can
 * never echo the request back — is always carried into `details`, so a 502
 * with an unreadable body is never indistinguishable from a 400 with a
 * readable-but-incomplete one.
 *
 * Reads the body **at most once**, and only ever surfaces the two fields
 * Atlassian's own OAuth error documentation promises: `error` and
 * `error_description`. Everything else on the body is discarded unread,
 * because it can echo back request fields (an authorization code, a
 * refresh token, a client secret, or — for the accessible-resources
 * endpoint — the Authorization header) verbatim.
 *
 * Every `throw` below is written as a statement inside this
 * `Promise<never>`-returning function, which is fine on its own — but a
 * caller must write `return await throwUpstreamFailure(...)`, not bare
 * `await throwUpstreamFailure(...)`, for TypeScript to treat the code after
 * the call as unreachable and catch a future edit that adds fallthrough
 * logic after it.
 */
async function throwUpstreamFailure(
  response: Response,
  label: string,
  codes: { unreadableBody: string; failed: string; reconnectRequired: string },
): Promise<never> {
  const status = response.status;
  const statusCode = mapUpstreamStatusCode(status);
  const reconnectRequired = isReconnectRequiredStatus(status);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AppError(
      statusCode,
      reconnectRequired ? codes.reconnectRequired : codes.unreadableBody,
      `${label} failed with status ${status} and a response body that was not valid JSON.`,
      { status },
    );
  }

  const parsed = (body && typeof body === 'object' ? (body as TokenErrorBody) : {}) as TokenErrorBody;
  const error = typeof parsed.error === 'string' && parsed.error.length > 0 ? parsed.error : undefined;
  const description = typeof parsed.error_description === 'string' ? parsed.error_description : undefined;

  if (!error) {
    throw new AppError(
      statusCode,
      reconnectRequired ? codes.reconnectRequired : codes.unreadableBody,
      `${label} failed with status ${status} and no error field in the response body.`,
      { status },
    );
  }

  const message = description
    ? `${label} failed: ${error} (${description})`
    : `${label} failed: ${error}`;

  throw new AppError(
    statusCode,
    reconnectRequired ? codes.reconnectRequired : codes.failed,
    message,
    { status, error, error_description: description },
  );
}

type AbsentRefreshTokenMeaning = Exclude<RefreshTokenOutcome['kind'], 'issued'>;

async function requestTokens(
  body: Record<string, string>,
  deps: OAuthDeps | undefined,
  absentRefreshTokenMeaning: AbsentRefreshTokenMeaning,
): Promise<AtlassianTokens> {
  const fetchImpl = resolveFetch(deps);

  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    // A transport-level failure (DNS, TLS, connection reset, ...). The
    // triggering error is deliberately not attached as `cause`: Node's
    // `fetch failed` cause chain can carry the request URL, and the
    // request logger serialises `cause` verbatim.
    throw new AppError(502, 'ATLASSIAN_OAUTH_UNREACHABLE', 'Could not reach Atlassian to exchange the OAuth token.');
  }

  if (!response.ok) {
    return await throwUpstreamFailure(response, 'Atlassian OAuth token request', {
      unreadableBody: 'ATLASSIAN_OAUTH_ERROR_BODY_UNREADABLE',
      failed: 'ATLASSIAN_OAUTH_TOKEN_FAILED',
      reconnectRequired: 'ATLASSIAN_OAUTH_RECONNECT_REQUIRED',
    });
  }

  let bodyJson: unknown;
  try {
    bodyJson = await response.json();
  } catch {
    throw invalidTokenResponse('a token response that was not valid JSON');
  }

  const parsed = parseTokenSuccessBody(bodyJson);

  const refreshToken: RefreshTokenOutcome =
    parsed.refreshToken !== undefined && parsed.refreshToken.length > 0
      ? { kind: 'issued', token: parsed.refreshToken }
      : { kind: absentRefreshTokenMeaning };

  return {
    accessToken: parsed.accessToken,
    refreshToken,
    expiresAt: computeExpiresAt(parsed.expiresInSeconds),
    scopes: parseScopes(parsed.scope),
  };
}

export async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
  deps?: OAuthDeps,
): Promise<AtlassianTokens> {
  return requestTokens(
    {
      grant_type: 'authorization_code',
      client_id: resolveClientId(deps),
      client_secret: resolveClientSecret(deps),
      code,
      redirect_uri: redirectUri,
    },
    deps,
    'unavailable',
  );
}

export async function refreshAccessToken(refreshToken: string, deps?: OAuthDeps): Promise<AtlassianTokens> {
  return requestTokens(
    {
      grant_type: 'refresh_token',
      client_id: resolveClientId(deps),
      client_secret: resolveClientSecret(deps),
      refresh_token: refreshToken,
    },
    deps,
    'not_rotated',
  );
}

function invalidAccessibleResourcesResponse(detail: string): AppError {
  return new AppError(502, 'ATLASSIAN_OAUTH_RESPONSE_INVALID', `Atlassian returned ${detail}.`);
}

/** Validates and narrows one accessible-resources array entry, by index so a diagnostic never needs to echo the (untrusted, but not secret) entry contents. */
function parseAccessibleResourceEntry(entry: unknown, index: number): AccessibleResource {
  if (!entry || typeof entry !== 'object') {
    throw invalidAccessibleResourcesResponse(`an accessible-resources entry at index ${index} that was not an object`);
  }
  const site = entry as { id?: unknown; url?: unknown; name?: unknown };
  if (typeof site.id !== 'string' || typeof site.url !== 'string' || typeof site.name !== 'string') {
    throw invalidAccessibleResourcesResponse(`an accessible-resources entry at index ${index} missing id, url, or name`);
  }
  return { id: site.id, url: site.url, name: site.name };
}

export async function listAccessibleResources(
  accessToken: string,
  deps?: OAuthDeps,
): Promise<AccessibleResource[]> {
  const fetchImpl = resolveFetch(deps);

  let response: Response;
  try {
    response = await fetchImpl(ACCESSIBLE_RESOURCES_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
  } catch {
    // See requestTokens: the underlying error is not attached, since it
    // could echo request details (here, the Authorization header) back.
    throw new AppError(502, 'ATLASSIAN_OAUTH_UNREACHABLE', 'Could not reach Atlassian to list accessible sites.');
  }

  if (!response.ok) {
    return await throwUpstreamFailure(response, 'Atlassian accessible-resources request', {
      unreadableBody: 'ATLASSIAN_OAUTH_RESOURCES_ERROR_BODY_UNREADABLE',
      failed: 'ATLASSIAN_OAUTH_RESOURCES_FAILED',
      reconnectRequired: 'ATLASSIAN_OAUTH_RESOURCES_RECONNECT_REQUIRED',
    });
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw invalidAccessibleResourcesResponse('an accessible-resources response that was not valid JSON');
  }

  if (!Array.isArray(parsed)) {
    throw invalidAccessibleResourcesResponse('an accessible-resources response that was not a list');
  }

  return parsed.map((entry, index) => parseAccessibleResourceEntry(entry, index));
}
