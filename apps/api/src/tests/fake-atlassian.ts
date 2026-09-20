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

/**
 * Creates a fake Atlassian site. Every call routed through `fetch` is
 * recorded on `calls`, in the order it was made, before it is dispatched.
 */
export function createFakeAtlassian(options: FakeAtlassianOptions = {}): FakeAtlassian {
  const cloudId = options.cloudId ?? DEFAULT_CLOUD_ID;

  const calls: FakeCall[] = [];
  const issuedRefreshTokens: string[] = [];
  const spaces: FakeSpace[] = [];
  const pages = new Map<string, FakePage>();

  function notFound(): Response {
    return new Response(JSON.stringify({ errors: [{ title: 'Not Found' }] }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = toUrl(input);
    const method = toMethod(input, init);

    calls.push({ method, url: url.toString() });

    return notFound();
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
