import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'integrations-route-test-secret';

const VALID_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

process.env.INTEGRATION_ENCRYPTION_KEY = VALID_KEY;
process.env.ATLASSIAN_CLIENT_ID = process.env.ATLASSIAN_CLIENT_ID ?? 'test-client-id';
process.env.ATLASSIAN_CLIENT_SECRET = process.env.ATLASSIAN_CLIENT_SECRET ?? 'test-client-secret';
process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'https://api.example.test';

const [
  { default: Fastify },
  { default: jwt },
  {
    integrationRoutes,
    INTEGRATION_ROUTES_PREFIX,
    CONFLUENCE_OAUTH_SCOPES,
  },
  { AppError },
  { signAccessToken },
  { apiLoggerOptionsForEnvironment },
] = await Promise.all([
  import('fastify'),
  import('jsonwebtoken'),
  import('../routes/integrations/index.js'),
  import('../utils/errors.js'),
  import('../utils/jwt.js'),
  import('../utils/logger.js'),
]);

// ── the fake datastore ──────────────────────────────────────────────────────
//
// Hand-written on purpose: no Prisma, no database. It records every `where`
// it is handed so a test can assert what a route actually asked for, which is
// how the tenant-scoping tests prove the lookup is scoped rather than merely
// that the answer happened to be empty.

type IntegrationRow = {
  id: string;
  organisationId: string;
  provider: 'CONFLUENCE';
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  config: Record<string, unknown> | null;
  lastError: string | null;
  connectedAt: Date | null;
  connectedById: string | null;
};

type CredentialRow = { integrationId: string; kind: string; sealed: unknown; generation: number; expiresAt: Date | null };

type Calls = {
  integrationFindUnique: unknown[];
  integrationUpsert: unknown[];
  integrationUpdateMany: unknown[];
  credentialDeleteMany: unknown[];
};

function makeStore(rows: IntegrationRow[]) {
  const integrations = new Map(rows.map((row) => [row.id, { ...row }]));
  const credentials: CredentialRow[] = [];
  const calls: Calls = {
    integrationFindUnique: [],
    integrationUpsert: [],
    integrationUpdateMany: [],
    credentialDeleteMany: [],
  };

  function find(where: Record<string, unknown>): IntegrationRow | undefined {
    if (typeof where.id === 'string') return integrations.get(where.id);
    const composite = where.organisationId_provider as { organisationId: string; provider: string } | undefined;
    if (composite) {
      return [...integrations.values()].find(
        (row) => row.organisationId === composite.organisationId && row.provider === composite.provider,
      );
    }
    return undefined;
  }

  const client = {
    organisationIntegration: {
      findUnique: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        calls.integrationFindUnique.push(args.where);
        const row = find(args.where);
        if (!row) return null;
        if (!args.select) return { ...row };
        const projected: Record<string, unknown> = {};
        for (const key of Object.keys(args.select)) {
          projected[key] = (row as unknown as Record<string, unknown>)[key];
        }
        return projected;
      },
      upsert: async (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        calls.integrationUpsert.push(args.where);
        const existing = find(args.where);
        if (existing) {
          Object.assign(existing, args.update);
          return { id: existing.id };
        }
        const composite = args.where.organisationId_provider as { organisationId: string; provider: 'CONFLUENCE' };
        const created: IntegrationRow = {
          id: `integration-${integrations.size + 1}`,
          organisationId: composite.organisationId,
          provider: composite.provider,
          status: 'DISCONNECTED',
          config: null,
          lastError: null,
          connectedAt: null,
          connectedById: null,
          ...(args.create as Partial<IntegrationRow>),
        };
        integrations.set(created.id, created);
        return { id: created.id };
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.integrationUpdateMany.push(args.where);
        const row = find(args.where);
        if (!row) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    integrationCredential: {
      upsert: async (args: { where: { integrationId_kind: { integrationId: string; kind: string } }; create: CredentialRow }) => {
        const { integrationId, kind } = args.where.integrationId_kind;
        const index = credentials.findIndex((row) => row.integrationId === integrationId && row.kind === kind);
        const next = { ...args.create, expiresAt: args.create.expiresAt ?? null };
        if (index >= 0) credentials[index] = next;
        else credentials.push(next);
        return next;
      },
      deleteMany: async (args: { where: { integrationId: string } }) => {
        calls.credentialDeleteMany.push(args.where);
        const before = credentials.length;
        for (let i = credentials.length - 1; i >= 0; i -= 1) {
          if (credentials[i]!.integrationId === args.where.integrationId) credentials.splice(i, 1);
        }
        return { count: before - credentials.length };
      },
    },
    integrationSecretControl: {
      findUnique: async () => null,
      upsert: async () => ({ id: 1 }),
    },
    $transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run(client),
  };

  return { client, calls, integrations, credentials };
}

// ── actors ──────────────────────────────────────────────────────────────────

type Actor = { userId: string; organisationId: string; role: 'OWNER' | 'ADMIN' | 'MEMBER'; sessionId: string };

const ORG_A_ADMIN: Actor = { userId: 'user-a', organisationId: 'org-a', role: 'ADMIN', sessionId: 'session-a' };
const ORG_B_ADMIN: Actor = { userId: 'user-b', organisationId: 'org-b', role: 'ADMIN', sessionId: 'session-b' };
const ORG_A_MEMBER: Actor = { userId: 'user-m', organisationId: 'org-a', role: 'MEMBER', sessionId: 'session-m' };

function bearer(actor: Actor): string {
  return `Bearer ${signAccessToken(actor)}`;
}

function authModels(actor: Actor) {
  return {
    authSession: { findFirst: async () => ({ id: actor.sessionId }) },
    user: {
      findUnique: async () => ({
        id: actor.userId,
        organisationId: actor.organisationId,
        role: actor.role,
        emailVerified: true,
      }),
    },
  };
}

type BuildOptions = {
  rows?: IntegrationRow[];
  actor?: Actor;
  exchangeAuthorizationCode?: unknown;
  listAccessibleResources?: unknown;
  logStream?: { write(chunk: string): void };
};

async function buildApp(options: BuildOptions = {}) {
  const actor = options.actor ?? ORG_A_ADMIN;
  const store = makeStore(options.rows ?? []);
  const app = Fastify(
    options.logStream
      ? {
          // The REAL production logger configuration, so a leak test is a test
          // of what a deployment actually writes rather than of a bespoke one.
          logger: {
            ...(apiLoggerOptionsForEnvironment('production') as Record<string, unknown>),
            level: 'trace',
            stream: options.logStream,
          },
        }
      : { logger: false },
  );
  app.decorate('prisma', { ...authModels(actor), ...store.client } as never);
  await app.register(integrationRoutes, {
    confluenceDeps: {
      ...(options.exchangeAuthorizationCode ? { exchangeAuthorizationCode: options.exchangeAuthorizationCode } : {}),
      ...(options.listAccessibleResources ? { listAccessibleResources: options.listAccessibleResources } : {}),
    },
  } as never);
  return { app, store, actor };
}

function connectedRow(overrides: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    id: 'integration-a',
    organisationId: 'org-a',
    provider: 'CONFLUENCE',
    status: 'CONNECTED',
    config: { siteId: 'site-1', siteUrl: 'https://charity-a.atlassian.net', siteName: 'Charity A', siteCount: 2 },
    lastError: null,
    connectedAt: new Date('2026-09-01T10:00:00.000Z'),
    connectedById: 'user-a',
    ...overrides,
  };
}

async function authorizeState(app: Awaited<ReturnType<typeof buildApp>>['app'], actor: Actor): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/authorize',
    headers: { authorization: bearer(actor) },
  });
  assert.equal(response.statusCode, 200, response.body);
  const url = new URL(JSON.parse(response.body).data.authorizationUrl);
  const state = url.searchParams.get('state');
  assert.ok(state, 'authorize must put a state on the authorization URL');
  return state;
}

function tokenExchangeThatMustNotRun() {
  return async () => {
    throw new Error('the authorization code must never be exchanged on this path');
  };
}

function restoreKey() {
  process.env.INTEGRATION_ENCRYPTION_KEY = VALID_KEY;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. `state` is the CSRF defence for the whole flow.
// ────────────────────────────────────────────────────────────────────────────

test('the callback rejects a request with no state at all, before exchanging anything', async () => {
  restoreKey();
  const { app } = await buildApp({ exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/callback?code=an-authorization-code',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_OAUTH_STATE_INVALID');
});

test('the callback rejects a state signed with the wrong secret', async () => {
  restoreKey();
  const { app } = await buildApp({ exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
  const forged = jwt.sign(
    { organisationId: 'org-a', userId: 'user-a', provider: 'CONFLUENCE', redirectUri: 'https://api.example.test/x' },
    'not-the-jwt-secret',
    { algorithm: 'HS256', issuer: 'charitypilot-api', audience: 'charitypilot-integration-oauth-state', expiresIn: '10m' },
  );
  const response = await app.inject({
    method: 'GET',
    url: `/confluence/callback?code=an-authorization-code&state=${encodeURIComponent(forged)}`,
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_OAUTH_STATE_INVALID');
});

test('the callback rejects an unsigned (alg=none) state', async () => {
  restoreKey();
  const { app } = await buildApp({ exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      organisationId: 'org-a',
      userId: 'user-a',
      provider: 'CONFLUENCE',
      redirectUri: 'https://api.example.test/x',
      iss: 'charitypilot-api',
      aud: 'charitypilot-integration-oauth-state',
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  ).toString('base64url');
  const response = await app.inject({
    method: 'GET',
    url: `/confluence/callback?code=an-authorization-code&state=${encodeURIComponent(`${header}.${payload}.`)}`,
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_OAUTH_STATE_INVALID');
});

test('the callback rejects a state bound to another organisation', async () => {
  restoreKey();
  // org B authorises honestly; the resulting state is then replayed against
  // org A's session. This is the attack: attach the attacker's Confluence
  // site to the victim charity.
  const orgB = await buildApp({ actor: ORG_B_ADMIN });
  const stolenState = await authorizeState(orgB.app, ORG_B_ADMIN);

  const orgA = await buildApp({ actor: ORG_A_ADMIN, exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
  const response = await orgA.app.inject({
    method: 'GET',
    url: `/confluence/callback?code=an-authorization-code&state=${encodeURIComponent(stolenState)}`,
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_OAUTH_STATE_INVALID');
  assert.equal(orgA.store.calls.integrationUpsert.length, 0, 'nothing may be written on a rejected callback');
});

test('the callback rejects an expired state', async () => {
  restoreKey();
  const { app } = await buildApp({ exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
  const expired = jwt.sign(
    { organisationId: 'org-a', userId: 'user-a', provider: 'CONFLUENCE', redirectUri: 'https://api.example.test/x' },
    process.env.JWT_SECRET!,
    {
      algorithm: 'HS256',
      issuer: 'charitypilot-api',
      audience: 'charitypilot-integration-oauth-state',
      expiresIn: '-1s',
    },
  );
  const response = await app.inject({
    method: 'GET',
    url: `/confluence/callback?code=an-authorization-code&state=${encodeURIComponent(expired)}`,
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_OAUTH_STATE_INVALID');
});

test('a CharityPilot access token cannot be replayed as a state', async () => {
  restoreKey();
  const { app } = await buildApp({ exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
  const response = await app.inject({
    method: 'GET',
    url: `/confluence/callback?code=an-authorization-code&state=${encodeURIComponent(signAccessToken(ORG_A_ADMIN))}`,
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_OAUTH_STATE_INVALID');
});

test('a state minted by authorize is accepted by the callback of the same organisation', async () => {
  restoreKey();
  const exchanged: string[] = [];
  const { app, store } = await buildApp({
    exchangeAuthorizationCode: async (code: string, redirectUri: string) => {
      exchanged.push(`${code}|${redirectUri}`);
      return {
        accessToken: 'plaintext-access-token',
        refreshToken: { kind: 'issued' as const, token: 'plaintext-refresh-token' },
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: [...CONFLUENCE_OAUTH_SCOPES],
      };
    },
    listAccessibleResources: async () => [
      { id: 'site-1', url: 'https://charity-a.atlassian.net', name: 'Charity A' },
    ],
  });

  const state = await authorizeState(app, ORG_A_ADMIN);
  const response = await app.inject({
    method: 'GET',
    url: `/confluence/callback?code=an-authorization-code&state=${encodeURIComponent(state)}`,
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.data.status, 'CONNECTED');
  assert.equal(body.data.siteUrl, 'https://charity-a.atlassian.net');
  assert.equal(exchanged.length, 1);
  // The redirect URI the callback exchanges with comes from the signed state,
  // never from the request.
  assert.ok(exchanged[0]!.endsWith(`|https://api.example.test${INTEGRATION_ROUTES_PREFIX}/confluence/callback`));
  assert.equal(store.credentials.length, 2);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Ownership scoping — the layer below binds but does not authorize.
// ────────────────────────────────────────────────────────────────────────────

test('status never reaches another organisation integration', async () => {
  restoreKey();
  const { app, store } = await buildApp({ rows: [connectedRow()], actor: ORG_B_ADMIN });
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/status',
    headers: { authorization: bearer(ORG_B_ADMIN) },
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.data.status, 'NOT_CONNECTED');
  assert.equal(body.data.siteUrl, null);

  // Structural, not incidental: every lookup was keyed on the requesting
  // organisation, so there is no argument by which org A's row could be named.
  assert.ok(store.calls.integrationFindUnique.length > 0);
  for (const where of store.calls.integrationFindUnique as Array<Record<string, unknown>>) {
    assert.deepEqual(where.organisationId_provider, { organisationId: 'org-b', provider: 'CONFLUENCE' });
    assert.equal(where.id, undefined, 'no route may address an integration by id from a request');
  }
});

test('status ignores an integrationId supplied on the query string', async () => {
  restoreKey();
  const { app, store } = await buildApp({ rows: [connectedRow()], actor: ORG_B_ADMIN });
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/status?integrationId=integration-a&organisationId=org-a',
    headers: { authorization: bearer(ORG_B_ADMIN) },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).data.status, 'NOT_CONNECTED');
  for (const where of store.calls.integrationFindUnique as Array<Record<string, unknown>>) {
    assert.deepEqual(where.organisationId_provider, { organisationId: 'org-b', provider: 'CONFLUENCE' });
  }
});

test('disconnect cannot delete another organisation credentials', async () => {
  restoreKey();
  const { app, store } = await buildApp({ rows: [connectedRow()], actor: ORG_B_ADMIN });
  store.credentials.push({ integrationId: 'integration-a', kind: 'refresh_token', sealed: {}, generation: 1, expiresAt: null });

  const response = await app.inject({
    method: 'DELETE',
    url: '/confluence?integrationId=integration-a',
    headers: { authorization: bearer(ORG_B_ADMIN) },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_NOT_CONNECTED');
  assert.equal(store.calls.credentialDeleteMany.length, 0, 'no credential row may be deleted for a foreign integration');
  assert.equal(store.credentials.length, 1);
  assert.equal(store.integrations.get('integration-a')!.status, 'CONNECTED');
});

test('disconnect removes the requesting organisation own integration', async () => {
  restoreKey();
  const { app, store } = await buildApp({ rows: [connectedRow()], actor: ORG_A_ADMIN });
  store.credentials.push({ integrationId: 'integration-a', kind: 'refresh_token', sealed: {}, generation: 1, expiresAt: null });

  const response = await app.inject({
    method: 'DELETE',
    url: '/confluence',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(store.credentials.length, 0);
  assert.equal(store.integrations.get('integration-a')!.status, 'DISCONNECTED');
});

test('a member may not reach any integration route', async () => {
  restoreKey();
  const { app } = await buildApp({ rows: [connectedRow()], actor: ORG_A_MEMBER });
  for (const [method, url] of [
    ['GET', '/confluence/authorize'],
    ['GET', '/confluence/status'],
    ['DELETE', '/confluence'],
  ] as const) {
    const response = await app.inject({ method, url, headers: { authorization: bearer(ORG_A_MEMBER) } });
    assert.equal(response.statusCode, 403, `${method} ${url}`);
  }
});

test('every integration route refuses an unauthenticated request', async () => {
  restoreKey();
  const { app } = await buildApp({ rows: [connectedRow()] });
  for (const [method, url] of [
    ['GET', '/confluence/authorize'],
    ['GET', '/confluence/callback?code=c&state=s'],
    ['GET', '/confluence/status'],
    ['DELETE', '/confluence'],
  ] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 3. The connect flow is gated on INTEGRATION_ENCRYPTION_KEY, on every profile.
// ────────────────────────────────────────────────────────────────────────────

test('authorize refuses when INTEGRATION_ENCRYPTION_KEY is absent', async () => {
  delete process.env.INTEGRATION_ENCRYPTION_KEY;
  try {
    const { app } = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/confluence/authorize',
      headers: { authorization: bearer(ORG_A_ADMIN) },
    });
    assert.equal(response.statusCode, 503);
    const body = JSON.parse(response.body);
    assert.equal(body.code, 'INTEGRATION_ENCRYPTION_KEY_MISSING');
    assert.match(body.error, /INTEGRATION_ENCRYPTION_KEY/);
    assert.match(body.error, /openssl rand -hex 32/);
  } finally {
    restoreKey();
  }
});

test('authorize refusal stays actionable in production, where 5xx messages are normally masked', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.NODE_ENV = 'production';
  try {
    const { app } = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/confluence/authorize',
      headers: { authorization: bearer(ORG_A_ADMIN) },
    });
    assert.equal(response.statusCode, 503);
    const body = JSON.parse(response.body);
    assert.equal(body.code, 'INTEGRATION_ENCRYPTION_KEY_MISSING');
    assert.match(body.error, /INTEGRATION_ENCRYPTION_KEY/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    restoreKey();
  }
});

test('authorize refuses when INTEGRATION_ENCRYPTION_KEY does not decode', async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = 'not-a-32-byte-key';
  try {
    const { app } = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/confluence/authorize',
      headers: { authorization: bearer(ORG_A_ADMIN) },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).code, 'INTEGRATION_ENCRYPTION_KEY_INVALID');
  } finally {
    restoreKey();
  }
});

test('the callback refuses before contacting Atlassian when INTEGRATION_ENCRYPTION_KEY is absent', async () => {
  restoreKey();
  const { app } = await buildApp();
  const state = await authorizeState(app, ORG_A_ADMIN);

  delete process.env.INTEGRATION_ENCRYPTION_KEY;
  try {
    const guarded = await buildApp({ exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
    const response = await guarded.app.inject({
      method: 'GET',
      url: `/confluence/callback?code=an-authorization-code&state=${encodeURIComponent(state)}`,
      headers: { authorization: bearer(ORG_A_ADMIN) },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).code, 'INTEGRATION_ENCRYPTION_KEY_MISSING');
    assert.equal(guarded.store.calls.integrationUpsert.length, 0);
  } finally {
    restoreKey();
  }
});

test('status and disconnect are not gated on the encryption key', async () => {
  delete process.env.INTEGRATION_ENCRYPTION_KEY;
  try {
    const { app } = await buildApp({ rows: [connectedRow()] });
    const status = await app.inject({
      method: 'GET',
      url: '/confluence/status',
      headers: { authorization: bearer(ORG_A_ADMIN) },
    });
    assert.equal(status.statusCode, 200);
    const disconnect = await app.inject({
      method: 'DELETE',
      url: '/confluence',
      headers: { authorization: bearer(ORG_A_ADMIN) },
    });
    assert.equal(disconnect.statusCode, 204);
  } finally {
    restoreKey();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// The authorization URL
// ────────────────────────────────────────────────────────────────────────────

test('the authorization URL carries offline_access and the fixed Atlassian parameters', async () => {
  restoreKey();
  const { app } = await buildApp();
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/authorize',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });
  assert.equal(response.statusCode, 200);
  const url = new URL(JSON.parse(response.body).data.authorizationUrl);

  assert.equal(url.origin + url.pathname, 'https://auth.atlassian.com/authorize');
  assert.equal(url.searchParams.get('audience'), 'api.atlassian.com');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('client_id'), 'test-client-id');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    `https://api.example.test${INTEGRATION_ROUTES_PREFIX}/confluence/callback`,
  );

  const scopes = (url.searchParams.get('scope') ?? '').split(' ');
  assert.ok(scopes.includes('offline_access'), 'without offline_access every charity drops within the hour');
  for (const scope of CONFLUENCE_OAUTH_SCOPES) assert.ok(scopes.includes(scope), scope);
  assert.ok(!url.searchParams.get('client_secret'), 'the client secret never goes in a front-channel URL');
});

test('authorize refuses when the Atlassian client credentials are not configured', async () => {
  restoreKey();
  const previous = process.env.ATLASSIAN_CLIENT_ID;
  delete process.env.ATLASSIAN_CLIENT_ID;
  try {
    const { app } = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/confluence/authorize',
      headers: { authorization: bearer(ORG_A_ADMIN) },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).code, 'ATLASSIAN_OAUTH_CLIENT_NOT_CONFIGURED');
  } finally {
    process.env.ATLASSIAN_CLIENT_ID = previous;
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Status carries connection facts and nothing else
// ────────────────────────────────────────────────────────────────────────────

test('status reports the connection without any token material', async () => {
  restoreKey();
  const { app } = await buildApp({ rows: [connectedRow({ lastError: null })] });
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/status',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });

  assert.equal(response.statusCode, 200);
  const { data } = JSON.parse(response.body);
  assert.deepEqual(Object.keys(data).sort(), [
    'connectedAt',
    'lastError',
    'provider',
    'siteCount',
    'siteName',
    'siteUrl',
    'status',
  ]);
  assert.equal(data.provider, 'CONFLUENCE');
  assert.equal(data.status, 'CONNECTED');
  assert.equal(data.siteUrl, 'https://charity-a.atlassian.net');
  assert.equal(data.siteCount, 2);
  assert.equal(data.connectedAt, '2026-09-01T10:00:00.000Z');
  const serialised = response.body.toLowerCase();
  for (const forbidden of ['token', 'fingerprint', 'sealed', 'ciphertext', 'secret', 'refresh']) {
    assert.ok(!serialised.includes(forbidden), `status leaked ${forbidden}`);
  }
});

test('status reports an errored connection with its stored reason', async () => {
  restoreKey();
  const { app } = await buildApp({
    rows: [connectedRow({ status: 'ERROR', lastError: 'Atlassian rejected the stored grant.' })],
  });
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/status',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });
  const { data } = JSON.parse(response.body);
  assert.equal(data.status, 'ERROR');
  assert.equal(data.lastError, 'Atlassian rejected the stored grant.');
});

// ────────────────────────────────────────────────────────────────────────────
// Secrets never egress; 409 is branched on by code, never by bare status
// ────────────────────────────────────────────────────────────────────────────

test('no plaintext token, code or client secret reaches the response or the log', async () => {
  restoreKey();
  const captured: string[] = [];
  const { app } = await buildApp({
    logStream: { write: (chunk: string) => void captured.push(chunk) },
    exchangeAuthorizationCode: async () => ({
      accessToken: 'SUPERSECRET-ACCESS-TOKEN',
      refreshToken: { kind: 'issued' as const, token: 'SUPERSECRET-REFRESH-TOKEN' },
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [...CONFLUENCE_OAUTH_SCOPES],
    }),
    listAccessibleResources: async () => [
      { id: 'site-1', url: 'https://charity-a.atlassian.net', name: 'Charity A' },
    ],
  });

  const state = await authorizeState(app, ORG_A_ADMIN);
  const response = await app.inject({
    method: 'GET',
    url: `/confluence/callback?code=SUPERSECRET-AUTHORIZATION-CODE&state=${encodeURIComponent(state)}`,
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });

  assert.equal(response.statusCode, 200, response.body);
  const haystack = `${response.body}\n${captured.join('')}`;
  for (const secret of [
    'SUPERSECRET-ACCESS-TOKEN',
    'SUPERSECRET-REFRESH-TOKEN',
    'SUPERSECRET-AUTHORIZATION-CODE',
    process.env.ATLASSIAN_CLIENT_SECRET!,
  ]) {
    assert.ok(!haystack.includes(secret), `${secret} escaped the credential boundary`);
  }
  // Fastify logs req.url on every request; the callback carries the code and
  // the state in that URL. Both must be censored, and the rest of the URL
  // must survive so the log line is still worth having.
  assert.ok(captured.join('').includes('/confluence/callback?code=[redacted]&state=[redacted]'));
});

test('the request logger censors credential-bearing query parameters and nothing else', async () => {
  const { redactSensitiveQueryParams } = await import('../utils/logger.js');
  assert.equal(redactSensitiveQueryParams('/api/v1/documents'), '/api/v1/documents');
  assert.equal(
    redactSensitiveQueryParams('/api/v1/documents?page=2&pageSize=50'),
    '/api/v1/documents?page=2&pageSize=50',
  );
  assert.equal(
    redactSensitiveQueryParams('/cb?code=abc123&state=xyz&page=2'),
    '/cb?code=[redacted]&state=[redacted]&page=2',
  );
  assert.equal(redactSensitiveQueryParams('/cb?CODE=abc123'), '/cb?CODE=[redacted]');
});

test('an Atlassian reconnect-required 409 keeps its own code and is not a tenant lifecycle conflict', async () => {
  restoreKey();
  const { app } = await buildApp({
    exchangeAuthorizationCode: async () => {
      throw new AppError(
        409,
        'ATLASSIAN_OAUTH_RECONNECT_REQUIRED',
        'Atlassian OAuth token request failed: invalid_grant',
        { status: 401 },
      );
    },
  });

  const state = await authorizeState(app, ORG_A_ADMIN);
  const response = await app.inject({
    method: 'GET',
    url: `/confluence/callback?code=an-authorization-code&state=${encodeURIComponent(state)}`,
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });

  assert.equal(response.statusCode, 409);
  const body = JSON.parse(response.body);
  // The web client keys on the code. 409 is already spoken for by
  // TENANT_LIFECYCLE_CONFLICT elsewhere, so the code must survive intact and
  // must not be that one.
  assert.equal(body.code, 'ATLASSIAN_OAUTH_RECONNECT_REQUIRED');
  assert.notEqual(body.code, 'TENANT_LIFECYCLE_CONFLICT');
});

test('the callback rejects a missing authorization code after the state is validated', async () => {
  restoreKey();
  const { app } = await buildApp({ exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
  const state = await authorizeState(app, ORG_A_ADMIN);
  const response = await app.inject({
    method: 'GET',
    url: `/confluence/callback?state=${encodeURIComponent(state)}`,
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_OAUTH_CODE_MISSING');
});

test('the callback surfaces an Atlassian error returned in place of a code', async () => {
  restoreKey();
  const { app } = await buildApp({ exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
  const state = await authorizeState(app, ORG_A_ADMIN);
  const response = await app.inject({
    method: 'GET',
    url: `/confluence/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_OAUTH_DENIED');
});
