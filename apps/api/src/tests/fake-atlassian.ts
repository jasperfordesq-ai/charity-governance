/**
 * An in-process fake of the parts of Atlassian this codebase talks to: the
 * OAuth token endpoint, the accessible-resources endpoint, and the
 * Confluence v1/v2 content API. It exists so the connector's tests can run
 * without a real Atlassian site or OAuth app, which do not exist yet.
 *
 * This module is test-only. No production source file may import it.
 *
 * The full `FakeAtlassian` contract is declared here even though several
 * members (`issuedRefreshTokens`, `rateLimit`, `revokeAccessToken`) are only
 * given real behaviour by later tasks — see the phase-a plan. Declaring the
 * complete shape now means the contract is visible in one place, and no
 * later task has to widen it.
 */

export type FakeAtlassianOptions = {
  cloudId?: string;
  siteUrl?: string;
  siteName?: string;
  clientId?: string;
  clientSecret?: string;
};

export type FakeCall = { method: string; url: string };

export type FakeRateLimitSpec = {
  after?: number;
  retryAfterSeconds?: number;
  nearLimit?: boolean;
};

export type FakeAtlassian = {
  fetch: typeof globalThis.fetch;
  cloudId: string;
  calls: FakeCall[];
  issuedRefreshTokens: string[];
  addSpace(space: { id: string; key: string; name: string }): void;
  getPage(pageId: string): FakePage | undefined;
  allPages(): FakePage[];
  rateLimit(spec: FakeRateLimitSpec): void;
  revokeAccessToken(token: string): void;
};

export type FakePage = {
  id: string;
  spaceId: string;
  title: string;
  version: number;
  status: 'current' | 'trashed' | 'purged';
  properties: Map<string, { id: string; key: string; value: unknown; version: number }>;
};

type FakeSpace = { id: string; key: string; name: string };

const DEFAULT_CLOUD_ID = '11111111-2222-3333-4444-555555555555';
const DEFAULT_SITE_URL = 'https://example.atlassian.net';
const DEFAULT_SITE_NAME = 'Example';

// Pinned in apps/api/src/services/atlassian-oauth.ts:9-10. The fake must
// match these exactly.
const AUTH_HOST = 'auth.atlassian.com';
const API_HOST = 'api.atlassian.com';
const TOKEN_PATH = '/oauth/token';
const ACCESSIBLE_RESOURCES_PATH = '/oauth/token/accessible-resources';

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    return asObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function extractBearer(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return undefined;
  const token = match[1].trim();
  return token.length > 0 ? token : undefined;
}

function toUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

function toMethod(input: string | URL | Request, init: RequestInit | undefined): string {
  if (typeof init?.method === 'string') return init.method.toUpperCase();
  if (typeof input !== 'string' && !(input instanceof URL)) return input.method.toUpperCase();
  return 'GET';
}

function toHeaders(input: string | URL | Request, init: RequestInit | undefined): Headers {
  if (init?.headers !== undefined) return new Headers(init.headers);
  if (typeof input !== 'string' && !(input instanceof URL)) return new Headers(input.headers);
  return new Headers();
}

function toBodyText(init: RequestInit | undefined): string | undefined {
  const body = init?.body;
  return typeof body === 'string' ? body : undefined;
}

/**
 * Creates a fake Atlassian site. Every call routed through `fetch` is
 * recorded on `calls`, in the order it was made, before it is dispatched.
 */
export function createFakeAtlassian(options: FakeAtlassianOptions = {}): FakeAtlassian {
  const cloudId = options.cloudId ?? DEFAULT_CLOUD_ID;
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const siteName = options.siteName ?? DEFAULT_SITE_NAME;

  const calls: FakeCall[] = [];
  const issuedRefreshTokens: string[] = [];
  const spaces: FakeSpace[] = [];
  const pages = new Map<string, FakePage>();

  let tokenCounter = 0;
  let currentRefreshToken: string | undefined;
  const validAccessTokens = new Set<string>();

  function notFound(): Response {
    return new Response(JSON.stringify({ errors: [{ title: 'Not Found' }] }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function unauthorized(): Response {
    return new Response(JSON.stringify({ message: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  function mintTokenPair(): { access_token: string; refresh_token: string } {
    tokenCounter += 1;
    const access = `access-${tokenCounter}`;
    const refresh = `refresh-${tokenCounter}`;
    validAccessTokens.add(access);
    currentRefreshToken = refresh;
    issuedRefreshTokens.push(refresh);
    return { access_token: access, refresh_token: refresh };
  }

  function tokenResponseBody(pair: { access_token: string; refresh_token: string }): Record<string, unknown> {
    return {
      access_token: pair.access_token,
      refresh_token: pair.refresh_token,
      expires_in: 3600,
      scope: 'read:confluence-content.all write:confluence-content offline_access',
      token_type: 'Bearer',
    };
  }

  function handleToken(bodyText: string | undefined): Response {
    const body = parseJsonObject(bodyText) ?? {};
    const grantType = body.grant_type;

    if (grantType === 'authorization_code') {
      return jsonResponse(200, tokenResponseBody(mintTokenPair()));
    }

    if (grantType === 'refresh_token') {
      const presented = body.refresh_token;
      if (typeof presented !== 'string' || presented !== currentRefreshToken) {
        return jsonResponse(403, { error: 'invalid_grant' });
      }
      return jsonResponse(200, tokenResponseBody(mintTokenPair()));
    }

    return jsonResponse(400, { error: 'unsupported_grant_type' });
  }

  function handleAccessibleResources(headers: Headers): Response {
    const token = extractBearer(headers.get('Authorization'));
    if (token === undefined || !validAccessTokens.has(token)) return unauthorized();
    return jsonResponse(200, [{ id: cloudId, url: siteUrl, name: siteName, scopes: [] }]);
  }

  function route(method: string, url: URL, headers: Headers, bodyText: string | undefined): Response {
    if (url.hostname === AUTH_HOST && url.pathname === TOKEN_PATH) {
      if (method === 'POST') return handleToken(bodyText);
      return notFound();
    }

    if (url.hostname === API_HOST && url.pathname === ACCESSIBLE_RESOURCES_PATH) {
      if (method === 'GET') return handleAccessibleResources(headers);
      return notFound();
    }

    return notFound();
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = toUrl(input);
    const method = toMethod(input, init);
    const headers = toHeaders(input, init);
    const bodyText = toBodyText(init);

    calls.push({ method, url: url.toString() });

    return route(method, url, headers, bodyText);
  }) as typeof globalThis.fetch;

  return {
    fetch: fetchImpl,
    cloudId,
    calls,
    issuedRefreshTokens,
    addSpace(space: { id: string; key: string; name: string }): void {
      spaces.push({ ...space });
    },
    getPage(pageId: string): FakePage | undefined {
      return pages.get(pageId);
    },
    allPages(): FakePage[] {
      return Array.from(pages.values());
    },
    rateLimit(): void {
      // Implemented in Task 5.
    },
    revokeAccessToken(): void {
      // Implemented in Task 3 (as the escape hatch behind Ruling B).
    },
  };
}
