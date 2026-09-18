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

export type AtlassianTokens = {
  accessToken: string;
  refreshToken: string | null;
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
type TokenSuccessBody = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
};

// Atlassian's OAuth error bodies carry exactly these two fields that are
// safe to surface. Everything else on an error body may echo back parts of
// the request (including the code/refresh_token/client_secret that were
// just sent) and must never be read out of it.
type TokenErrorBody = {
  error?: string;
  error_description?: string;
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
 * Extract only the two fields Atlassian's own OAuth error documentation
 * promises: `error` and `error_description`. The rest of the body is
 * discarded unread specifically because it can echo back request fields
 * (an authorization code, a refresh token, a client secret) verbatim.
 */
function extractTokenErrorFields(body: unknown): { error: string; description: string | undefined } {
  const parsed = (body && typeof body === 'object' ? (body as TokenErrorBody) : {}) as TokenErrorBody;
  const error = typeof parsed.error === 'string' && parsed.error.length > 0 ? parsed.error : 'unknown_error';
  const description = typeof parsed.error_description === 'string' ? parsed.error_description : undefined;
  return { error, description };
}

async function readJsonBodySafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // The body wasn't valid JSON. Nothing about it is safe to surface, so
    // it is discarded rather than attached anywhere.
    return undefined;
  }
}

async function throwTokenRequestFailed(response: Response): Promise<never> {
  const body = await readJsonBodySafely(response);
  const { error, description } = extractTokenErrorFields(body);
  const message = description
    ? `Atlassian OAuth token request failed: ${error} (${description})`
    : `Atlassian OAuth token request failed: ${error}`;
  throw new AppError(502, 'ATLASSIAN_OAUTH_TOKEN_FAILED', message, { error, error_description: description });
}

async function requestTokens(body: Record<string, string>, deps: OAuthDeps | undefined): Promise<AtlassianTokens> {
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
    // triggering error is deliberately not attached as `cause`: it could in
    // principle echo parts of the request URL/body back in its message, and
    // the request logger serialises `cause` verbatim.
    throw new AppError(502, 'ATLASSIAN_OAUTH_UNREACHABLE', 'Could not reach Atlassian to exchange the OAuth token.');
  }

  if (!response.ok) {
    await throwTokenRequestFailed(response);
  }

  let parsed: TokenSuccessBody;
  try {
    parsed = (await response.json()) as TokenSuccessBody;
  } catch {
    throw new AppError(502, 'ATLASSIAN_OAUTH_RESPONSE_INVALID', 'Atlassian returned a token response that was not valid JSON.');
  }

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresAt: computeExpiresAt(parsed.expires_in),
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
  );
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
    const body = await readJsonBodySafely(response);
    const { error, description } = extractTokenErrorFields(body);
    const message = description
      ? `Atlassian accessible-resources request failed: ${error} (${description})`
      : `Atlassian accessible-resources request failed: ${error}`;
    throw new AppError(502, 'ATLASSIAN_OAUTH_RESOURCES_FAILED', message, { error, error_description: description });
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new AppError(
      502,
      'ATLASSIAN_OAUTH_RESPONSE_INVALID',
      'Atlassian returned an accessible-resources response that was not valid JSON.',
    );
  }

  if (!Array.isArray(parsed)) {
    throw new AppError(
      502,
      'ATLASSIAN_OAUTH_RESPONSE_INVALID',
      'Atlassian returned an accessible-resources response that was not a list.',
    );
  }

  return parsed.map((entry) => {
    const site = entry as { id: string; url: string; name: string };
    return { id: site.id, url: site.url, name: site.name };
  });
}
