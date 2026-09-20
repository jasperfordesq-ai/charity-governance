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

type FakeSpace = { id: string; key: string; name: string; type: 'global'; status: 'current' };

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
  const revokedTokens = new Set<string>();

  let nextPageId = 100001;
  let nextPropertyId = 1;
  const confluencePrefix = `/ex/confluence/${cloudId}`;

  let rateLimitSpec: FakeRateLimitSpec | undefined;
  let requestsSinceRateLimit = 0;

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

  function withNearLimitHeader(status: number, headers: Record<string, string>): Record<string, string> {
    if (rateLimitSpec?.nearLimit === true && status >= 200 && status < 300) {
      return { ...headers, 'X-RateLimit-NearLimit': 'true' };
    }
    return headers;
  }

  function jsonResponse(status: number, body: unknown): Response {
    const headers = withNearLimitHeader(status, { 'Content-Type': 'application/json' });
    return new Response(JSON.stringify(body), { status, headers });
  }

  function emptyResponse(status: number): Response {
    return new Response(null, { status, headers: withNearLimitHeader(status, {}) });
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
    if (token === undefined || revokedTokens.has(token) || !validAccessTokens.has(token)) return unauthorized();
    return jsonResponse(200, [{ id: cloudId, url: siteUrl, name: siteName, scopes: [] }]);
  }

  /** Ruling B: any non-empty, non-revoked bearer token is accepted on Confluence content routes. */
  function checkContentBearer(headers: Headers): Response | undefined {
    const token = extractBearer(headers.get('Authorization'));
    if (token === undefined) return unauthorized();
    if (revokedTokens.has(token)) return unauthorized();
    return undefined;
  }

  function withAuth(headers: Headers, handler: () => Response): Response {
    return checkContentBearer(headers) ?? handler();
  }

  /**
   * A cursor is the index of the next unread item, encoded as a plain
   * decimal string. `restPath` is the pathname relative to this site's
   * Confluence prefix (e.g. `/wiki/api/v2/spaces`), because that is how
   * Atlassian returns `_links.next` and how `confluence-spaces.ts` and
   * `confluence-pages.ts` read it back: relative, with only the `cursor`
   * query parameter taken from it.
   */
  function paginate<T>(
    items: T[],
    url: URL,
    restPath: string,
    defaultLimit = 25,
  ): { results: T[]; _links: { next?: string } } {
    const limitParam = url.searchParams.get('limit');
    const parsedLimit = limitParam !== null ? Number(limitParam) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : defaultLimit;

    const cursorParam = url.searchParams.get('cursor');
    const start = cursorParam !== null && /^\d+$/.test(cursorParam) ? Number(cursorParam) : 0;

    const page = items.slice(start, start + limit);
    const nextStart = start + limit;

    const links: { next?: string } = {};
    if (nextStart < items.length) {
      const nextParams = new URLSearchParams(url.searchParams);
      nextParams.set('cursor', String(nextStart));
      nextParams.set('limit', String(limit));
      links.next = `${restPath}?${nextParams.toString()}`;
    }

    return { results: page, _links: links };
  }

  function pageJson(page: FakePage): Record<string, unknown> {
    return {
      id: page.id,
      status: page.status,
      title: page.title,
      spaceId: page.spaceId,
      version: { number: page.version },
      _links: { base: siteUrl, webui: `/pages/${page.id}` },
    };
  }

  function createPageHandler(bodyText: string | undefined): Response {
    const body = parseJsonObject(bodyText) ?? {};
    const spaceId = typeof body.spaceId === 'string' ? body.spaceId : undefined;
    if (spaceId === undefined) return jsonResponse(400, { errors: [{ title: 'spaceId is required' }] });

    const id = String(nextPageId);
    nextPageId += 1;

    const page: FakePage = {
      id,
      spaceId,
      title: typeof body.title === 'string' ? body.title : '',
      version: 1,
      status: 'current',
      properties: new Map(),
    };
    pages.set(id, page);

    return jsonResponse(200, pageJson(page));
  }

  function getPageHandler(pageId: string): Response {
    const page = pages.get(pageId);
    if (page === undefined || page.status !== 'current') return notFound();
    return jsonResponse(200, pageJson(page));
  }

  function updatePageHandler(pageId: string, bodyText: string | undefined): Response {
    const page = pages.get(pageId);
    if (page === undefined || page.status !== 'current') return notFound();

    const body = parseJsonObject(bodyText) ?? {};
    const versionNumber = asObject(body.version)?.number;
    if (typeof versionNumber !== 'number' || versionNumber !== page.version + 1) {
      return jsonResponse(409, { errors: [{ title: 'Conflict' }] });
    }

    page.version = versionNumber;
    if (typeof body.title === 'string') page.title = body.title;

    return jsonResponse(200, pageJson(page));
  }

  function deletePageHandler(pageId: string, url: URL): Response {
    const purge = url.searchParams.get('purge') === 'true';
    const page = pages.get(pageId);
    if (page === undefined) return notFound();

    if (purge) {
      if (page.status !== 'trashed') {
        return jsonResponse(400, { errors: [{ title: 'Page must be trashed before it can be purged' }] });
      }
      page.status = 'purged';
      return emptyResponse(204);
    }

    if (page.status === 'purged') return notFound();
    page.status = 'trashed';
    return emptyResponse(204);
  }

  function listSpacesHandler(url: URL): Response {
    const { results, _links } = paginate(spaces, url, '/wiki/api/v2/spaces');
    return jsonResponse(200, { results, _links });
  }

  function listPagesHandler(url: URL): Response {
    const titleFilter = url.searchParams.get('title');
    const spaceIdFilter = url.searchParams.get('spaceId') ?? url.searchParams.get('space-id');

    let items = Array.from(pages.values()).filter((page) => page.status === 'current');
    if (titleFilter !== null) items = items.filter((page) => page.title === titleFilter);
    if (spaceIdFilter !== null) items = items.filter((page) => page.spaceId === spaceIdFilter);

    const { results, _links } = paginate(items.map(pageJson), url, '/wiki/api/v2/pages');
    return jsonResponse(200, { results, _links });
  }

  function propertyJson(record: { id: string; key: string; value: unknown; version: number }): Record<string, unknown> {
    return { id: record.id, key: record.key, value: record.value, version: { number: record.version } };
  }

  function listPropertiesHandler(pageId: string, url: URL): Response {
    const page = pages.get(pageId);
    if (page === undefined || page.status !== 'current') return notFound();

    const keyFilter = url.searchParams.get('key');
    let items = Array.from(page.properties.values());
    if (keyFilter !== null) items = items.filter((record) => record.key === keyFilter);

    const { results, _links } = paginate(items.map(propertyJson), url, `/wiki/api/v2/pages/${pageId}/properties`);
    return jsonResponse(200, { results, _links });
  }

  function createPropertyHandler(pageId: string, bodyText: string | undefined): Response {
    const page = pages.get(pageId);
    if (page === undefined || page.status !== 'current') return notFound();

    const body = parseJsonObject(bodyText) ?? {};
    const key = typeof body.key === 'string' ? body.key : undefined;
    if (key === undefined) return jsonResponse(400, { errors: [{ title: 'key is required' }] });
    if (page.properties.has(key)) {
      return jsonResponse(400, { errors: [{ title: 'Property already exists' }] });
    }

    const id = String(nextPropertyId);
    nextPropertyId += 1;
    const record = { id, key, value: body.value, version: 1 };
    page.properties.set(key, record);

    return jsonResponse(200, propertyJson(record));
  }

  function getPropertyByIdHandler(pageId: string, propertyId: string): Response {
    const page = pages.get(pageId);
    if (page === undefined || page.status !== 'current') return notFound();

    const record = Array.from(page.properties.values()).find((entry) => entry.id === propertyId);
    if (record === undefined) return notFound();

    return jsonResponse(200, propertyJson(record));
  }

  function updatePropertyHandler(pageId: string, propertyId: string, bodyText: string | undefined): Response {
    const page = pages.get(pageId);
    if (page === undefined || page.status !== 'current') return notFound();

    const record = Array.from(page.properties.values()).find((entry) => entry.id === propertyId);
    if (record === undefined) return notFound();

    const body = parseJsonObject(bodyText) ?? {};
    const versionNumber = asObject(body.version)?.number;
    if (typeof versionNumber !== 'number' || versionNumber !== record.version + 1) {
      return jsonResponse(409, { errors: [{ title: 'Conflict' }] });
    }

    record.version = versionNumber;
    if ('value' in body) record.value = body.value;

    return jsonResponse(200, propertyJson(record));
  }

  function getContentV1Handler(pageId: string, url: URL): Response {
    const page = pages.get(pageId);
    if (page === undefined) return notFound();

    const status = url.searchParams.get('status');
    if (status === 'trashed') {
      if (page.status !== 'trashed') return notFound();
      return jsonResponse(200, pageJson(page));
    }

    if (page.status !== 'current') return notFound();
    return jsonResponse(200, pageJson(page));
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

    if (url.hostname === API_HOST && url.pathname.startsWith(confluencePrefix)) {
      const rest = url.pathname.slice(confluencePrefix.length) || '/';

      if (rest === '/wiki/api/v2/pages') {
        if (method === 'POST') return withAuth(headers, () => createPageHandler(bodyText));
        if (method === 'GET') return withAuth(headers, () => listPagesHandler(url));
      }

      if (rest === '/wiki/api/v2/spaces' && method === 'GET') {
        return withAuth(headers, () => listSpacesHandler(url));
      }

      const pageIdMatch = /^\/wiki\/api\/v2\/pages\/([^/]+)$/.exec(rest);
      if (pageIdMatch) {
        const pageId = pageIdMatch[1];
        if (method === 'GET') return withAuth(headers, () => getPageHandler(pageId));
        if (method === 'PUT') return withAuth(headers, () => updatePageHandler(pageId, bodyText));
        if (method === 'DELETE') return withAuth(headers, () => deletePageHandler(pageId, url));
      }

      const propertiesMatch = /^\/wiki\/api\/v2\/pages\/([^/]+)\/properties$/.exec(rest);
      if (propertiesMatch) {
        const pageId = propertiesMatch[1];
        if (method === 'GET') return withAuth(headers, () => listPropertiesHandler(pageId, url));
        if (method === 'POST') return withAuth(headers, () => createPropertyHandler(pageId, bodyText));
      }

      const propertyIdMatch = /^\/wiki\/api\/v2\/pages\/([^/]+)\/properties\/([^/]+)$/.exec(rest);
      if (propertyIdMatch) {
        const [, pageId, propertyId] = propertyIdMatch;
        if (method === 'GET') return withAuth(headers, () => getPropertyByIdHandler(pageId, propertyId));
        if (method === 'PUT') return withAuth(headers, () => updatePropertyHandler(pageId, propertyId, bodyText));
      }

      const contentMatch = /^\/wiki\/rest\/api\/content\/([^/]+)$/.exec(rest);
      if (contentMatch) {
        const pageId = contentMatch[1];
        if (method === 'GET') return withAuth(headers, () => getContentV1Handler(pageId, url));
      }
    }

    return notFound();
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = toUrl(input);
    const method = toMethod(input, init);
    const headers = toHeaders(input, init);
    const bodyText = toBodyText(init);

    calls.push({ method, url: url.toString() });

    if (rateLimitSpec !== undefined) {
      requestsSinceRateLimit += 1;
      const after = rateLimitSpec.after ?? 0;
      if (requestsSinceRateLimit > after) {
        return new Response(null, {
          status: 429,
          headers: { 'Retry-After': String(rateLimitSpec.retryAfterSeconds ?? 60) },
        });
      }
    }

    return route(method, url, headers, bodyText);
  }) as typeof globalThis.fetch;

  return {
    fetch: fetchImpl,
    cloudId,
    calls,
    issuedRefreshTokens,
    addSpace(space: { id: string; key: string; name: string }): void {
      spaces.push({ ...space, type: 'global', status: 'current' });
    },
    getPage(pageId: string): FakePage | undefined {
      return pages.get(pageId);
    },
    allPages(): FakePage[] {
      return Array.from(pages.values());
    },
    rateLimit(spec: FakeRateLimitSpec): void {
      rateLimitSpec = spec;
      requestsSinceRateLimit = 0;
    },
    revokeAccessToken(token: string): void {
      revokedTokens.add(token);
    },
  };
}
