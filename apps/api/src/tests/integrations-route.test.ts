import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'integrations-route-test-secret';

const VALID_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

process.env.INTEGRATION_ENCRYPTION_KEY = VALID_KEY;
process.env.ATLASSIAN_CLIENT_ID = process.env.ATLASSIAN_CLIENT_ID ?? 'test-client-id';
process.env.ATLASSIAN_CLIENT_SECRET = process.env.ATLASSIAN_CLIENT_SECRET ?? 'test-client-secret';
process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'https://api.example.test';
// The web origin. `FRONTEND_URL` is the one source of truth for it — the CORS
// allow-list, the emailed links and now the OAuth `redirect_uri` all read it.
process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://app.example.test';

const [
  { default: Fastify },
  { default: jwt },
  {
    integrationRoutes,
    INTEGRATION_ROUTES_PREFIX,
    CONFLUENCE_CALLBACK_PATH,
    CONFLUENCE_OAUTH_SCOPES,
    CONFLUENCE_CONNECT_DISCLOSURE,
    confluenceRedirectUri,
  },
  { AppError },
  { signAccessToken },
  { apiLoggerOptionsForEnvironment },
  { sealIntegrationSecret },
  { getPrimaryFrontendOrigin },
] = await Promise.all([
  import('fastify'),
  import('jsonwebtoken'),
  import('../routes/integrations/index.js'),
  import('../utils/errors.js'),
  import('../utils/jwt.js'),
  import('../utils/logger.js'),
  import('../services/integration-crypto.js'),
  import('../utils/frontend-origin.js'),
]);

const WEB_CALLBACK_URL = `${getPrimaryFrontendOrigin()}${CONFLUENCE_CALLBACK_PATH}`;

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
  // The chosen publish destination. Dedicated columns, deliberately NOT part
  // of `config` — `connectConfluence`'s `connectingState` spreads `config`
  // into the upsert's `update`, so a reconnect would wipe a choice stored
  // there. This store reproduces that faithfully: `upsert` assigns only the
  // keys it is handed, exactly as Prisma does.
  publishSpaceId: string | null;
  publishSpaceKey: string | null;
  publishSpaceName: string | null;
  publishSpaceSiteId: string | null;
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
          publishSpaceId: null,
          publishSpaceKey: null,
          publishSpaceName: null,
          publishSpaceSiteId: null,
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
      // Added when disconnect began reading the sealed refresh token so it
      // could attempt to withdraw the grant. Without it the load throws, which
      // this service swallows — so every revocation test would silently
      // exercise the same "could not open the vault" branch.
      findUnique: async (args: { where: { integrationId_kind: { integrationId: string; kind: string } } }) => {
        const { integrationId, kind } = args.where.integrationId_kind;
        const row = credentials.find((c) => c.integrationId === integrationId && c.kind === kind);
        return row === undefined ? null : { ...row };
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
  /** Injected `OAuthDeps`, which is how the disconnect route's revoke attempt is driven. */
  confluenceOAuth?: unknown;
  /** Injected `fetch` for `createConfluenceClient`, distinct from the OAuth/token layer above. */
  confluenceFetch?: unknown;
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
      ...(options.confluenceOAuth ? { oauth: options.confluenceOAuth } : {}),
    },
    ...(options.confluenceFetch ? { confluenceClientDeps: { fetch: options.confluenceFetch } } : {}),
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
    publishSpaceId: null,
    publishSpaceKey: null,
    publishSpaceName: null,
    publishSpaceSiteId: null,
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

/**
 * The callback as the web page calls it: a POST carrying `code` and `state`
 * in the body.
 *
 * Every callback test goes through this, deliberately. The query string is
 * where the authorization code used to live and where a proxy's error log
 * caught it; a helper that cannot build one is how these tests stay on the
 * right side of that.
 */
function postCallback(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  actor: Actor | null,
  payload: Record<string, string>,
) {
  return app.inject({
    method: 'POST',
    url: '/confluence/callback',
    ...(actor ? { headers: { authorization: bearer(actor) } } : {}),
    payload,
  });
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
  const response = await postCallback(app, ORG_A_ADMIN, { code: 'an-authorization-code' });
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
  const response = await postCallback(app, ORG_A_ADMIN, { code: 'an-authorization-code', state: forged });
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
  const response = await postCallback(app, ORG_A_ADMIN, {
    code: 'an-authorization-code',
    state: `${header}.${payload}.`,
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
  const response = await postCallback(orgA.app, ORG_A_ADMIN, {
    code: 'an-authorization-code',
    state: stolenState,
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
  const response = await postCallback(app, ORG_A_ADMIN, { code: 'an-authorization-code', state: expired });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_OAUTH_STATE_INVALID');
});

test('a CharityPilot access token cannot be replayed as a state', async () => {
  restoreKey();
  const { app } = await buildApp({ exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
  const response = await postCallback(app, ORG_A_ADMIN, {
    code: 'an-authorization-code',
    state: signAccessToken(ORG_A_ADMIN),
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
  const response = await postCallback(app, ORG_A_ADMIN, { code: 'an-authorization-code', state });

  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.data.status, 'CONNECTED');
  assert.equal(body.data.siteUrl, 'https://charity-a.atlassian.net');
  assert.equal(exchanged.length, 1);
  // The redirect URI the callback exchanges with comes from the signed state,
  // never from the request — and it is the web app's page, which is what
  // Atlassian has registered.
  assert.ok(exchanged[0]!.endsWith(`|${WEB_CALLBACK_URL}`));
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
    ['GET', '/confluence/spaces'],
    ['PUT', '/confluence/publish-space'],
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
    ['POST', '/confluence/callback'],
    ['GET', '/confluence/status'],
    ['GET', '/confluence/spaces'],
    ['PUT', '/confluence/publish-space'],
    ['DELETE', '/confluence'],
  ] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
  // The retired GET callback is the single, declared exception: see the test
  // below. It is not in the loop because it must NOT be 401 — an expired
  // cookie is exactly the failure it exists to explain.
});

test('a member may not post the callback either', async () => {
  restoreKey();
  const { app } = await buildApp({
    actor: ORG_A_MEMBER,
    exchangeAuthorizationCode: tokenExchangeThatMustNotRun(),
  });
  const response = await postCallback(app, ORG_A_MEMBER, { code: 'c', state: 's' });
  assert.equal(response.statusCode, 403);
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
    const response = await postCallback(guarded.app, ORG_A_ADMIN, {
      code: 'an-authorization-code',
      state,
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
  assert.equal(url.searchParams.get('redirect_uri'), WEB_CALLBACK_URL);

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
// The callback is a page in the web app, and the code arrives in a body
//
// The access-token cookie lives 15 minutes from login or the last refresh,
// not from the click on Connect, and the administrator then spends unbounded
// time on Atlassian's consent screen. Coming back to a bare API callback with
// a dead cookie meant a raw JSON 401 — and the code in that URL is single-use
// and by then spent, so retrying failed identically. A page can renew the
// session before spending the code. These tests hold the three things that
// makes true.
// ────────────────────────────────────────────────────────────────────────────

test('the redirect_uri points at the web app, not the API', () => {
  restoreKey();
  const redirectUri = confluenceRedirectUri();
  assert.ok(redirectUri, 'a configured FRONTEND_URL must yield a redirect URI');
  assert.ok(redirectUri.startsWith(getPrimaryFrontendOrigin()), redirectUri);
  assert.ok(!redirectUri.includes('/api/v1/'), redirectUri);
  assert.ok(!redirectUri.includes(INTEGRATION_ROUTES_PREFIX), redirectUri);
  // Atlassian matches this byte for byte, so it is pinned whole and not by
  // shape: the registered value and this one are the same string.
  assert.equal(redirectUri, 'https://app.example.test/integrations/confluence/callback');
});

test('the redirect_uri reads the web origin nothing else owns, so the two cannot drift', () => {
  restoreKey();
  const previous = process.env.FRONTEND_URL;
  try {
    process.env.FRONTEND_URL = 'https://moved.example.test';
    assert.equal(confluenceRedirectUri(), `https://moved.example.test${CONFLUENCE_CALLBACK_PATH}`);
    // A comma-separated list is the canonical origin first, exactly as the
    // CORS allow-list and the emailed links read it.
    process.env.FRONTEND_URL = 'https://first.example.test, https://second.example.test';
    assert.equal(confluenceRedirectUri(), `https://first.example.test${CONFLUENCE_CALLBACK_PATH}`);
  } finally {
    process.env.FRONTEND_URL = previous;
  }
});

test('connecting is refused, naming FRONTEND_URL, when the web origin is not configured', async () => {
  restoreKey();
  const previous = process.env.FRONTEND_URL;
  try {
    delete process.env.FRONTEND_URL;
    // Not the localhost fallback `getPrimaryFrontendOrigin` gives an emailed
    // link: sending a production administrator to their own laptop and
    // telling nobody is the failure this refusal replaces.
    assert.equal(confluenceRedirectUri(), null);

    const { app } = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/confluence/authorize',
      headers: { authorization: bearer(ORG_A_ADMIN) },
    });
    assert.equal(response.statusCode, 503);
    const body = JSON.parse(response.body);
    assert.equal(body.code, 'INTEGRATION_CALLBACK_ORIGIN_NOT_CONFIGURED');
    assert.match(body.error, /FRONTEND_URL/);
  } finally {
    process.env.FRONTEND_URL = previous;
  }
});

test('the callback accepts code and state in the body, never the query string', async () => {
  restoreKey();
  const exchanged: string[] = [];
  const { app } = await buildApp({
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
  const accepted = await postCallback(app, ORG_A_ADMIN, { code: 'c', state });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(JSON.parse(accepted.body).data.status, 'CONNECTED');
  assert.deepEqual(exchanged, [`c|${WEB_CALLBACK_URL}`]);

  // The same values in the query string of the same POST buy nothing: the
  // route reads the body and only the body.
  const viaQueryString = await app.inject({
    method: 'POST',
    url: `/confluence/callback?code=c&state=${encodeURIComponent(state)}`,
    headers: { authorization: bearer(ORG_A_ADMIN) },
    payload: {},
  });
  assert.equal(viaQueryString.statusCode, 400);
  assert.equal(JSON.parse(viaQueryString.body).code, 'CONFLUENCE_OAUTH_STATE_INVALID');
  assert.equal(exchanged.length, 1, 'a query-string code must never be exchanged');

  // And with the state valid in the body, so the request gets past the CSRF
  // check, a code left in the query string is still not a code. Without this
  // the check above would pass on a route that happily fell back to the URL,
  // because it never got far enough to try.
  const freshState = await authorizeState(app, ORG_A_ADMIN);
  const codeOnlyInTheUrl = await app.inject({
    method: 'POST',
    url: '/confluence/callback?code=SUPERSECRET-URL-CODE',
    headers: { authorization: bearer(ORG_A_ADMIN) },
    payload: { state: freshState },
  });
  assert.equal(codeOnlyInTheUrl.statusCode, 400);
  assert.equal(JSON.parse(codeOnlyInTheUrl.body).code, 'CONFLUENCE_OAUTH_CODE_MISSING');
  assert.equal(exchanged.length, 1, 'a query-string code must never be exchanged');
});

test('a body that is not an object is rejected as an invalid state, not a crash', async () => {
  restoreKey();
  const { app } = await buildApp({ exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
  // A JSON array, a JSON null and no body at all: all front-channel-reachable
  // shapes, none of them a record with a `state` on it.
  const bodies: Array<Record<string, unknown> | undefined> = [
    [] as unknown as Record<string, unknown>,
    null as unknown as Record<string, unknown>,
    undefined,
  ];
  for (const payload of bodies) {
    const response = await app.inject({
      method: 'POST',
      url: '/confluence/callback',
      headers: { authorization: bearer(ORG_A_ADMIN) },
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_OAUTH_STATE_INVALID');
  }

  // A literal JSON `null` body, sent raw so Fastify really parses it to null.
  // `typeof null === 'object'`, so this is the shape that turns a property
  // read into a TypeError and a 400 into a 500 if the falsy check goes.
  const jsonNull = await app.inject({
    method: 'POST',
    url: '/confluence/callback',
    headers: { authorization: bearer(ORG_A_ADMIN), 'content-type': 'application/json' },
    payload: 'null',
  });
  assert.equal(jsonNull.statusCode, 400, jsonNull.body);
  assert.equal(JSON.parse(jsonNull.body).code, 'CONFLUENCE_OAUTH_STATE_INVALID');
});

test('the retired GET callback explains what to re-register rather than 404ing', async () => {
  restoreKey();
  const { app } = await buildApp({ exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/callback?code=c&state=s',
  });

  // Unauthenticated on purpose. An administrator whose Atlassian app is still
  // registered here arrives with a cookie that expired on the consent screen;
  // answering 401 would reproduce, for the one person who must read this, the
  // exact failure the move exists to remove.
  assert.notEqual(response.statusCode, 404);
  assert.notEqual(response.statusCode, 401);
  assert.equal(response.statusCode, 410);
  assert.match(response.body, /re-?register|callback URL/i);

  const body = JSON.parse(response.body);
  assert.equal(body.code, 'CONFLUENCE_CALLBACK_MOVED');
  // Naming the change is half of it; the other half is the URL to register
  // now, which an operator can copy straight into the Atlassian console.
  assert.equal(body.callbackUrl, WEB_CALLBACK_URL);
  assert.match(body.error, /re-register the callback URL/i);
  assert.match(body.error, /Nothing has been connected/i);
});

test('the retired GET callback neither echoes nor exchanges what it was handed', async () => {
  restoreKey();
  const captured: string[] = [];
  const { app } = await buildApp({
    logStream: { write: (chunk: string) => void captured.push(chunk) },
    exchangeAuthorizationCode: tokenExchangeThatMustNotRun(),
  });
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/callback?code=SUPERSECRET-STALE-CODE&state=SUPERSECRET-STALE-STATE',
  });

  assert.equal(response.statusCode, 410);
  const haystack = `${response.body}\n${captured.join('')}`;
  for (const secret of ['SUPERSECRET-STALE-CODE', 'SUPERSECRET-STALE-STATE']) {
    assert.ok(!haystack.includes(secret), `${secret} escaped the retired callback`);
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
  // Still an exact allow-list, now carrying the destination as well as the
  // connection: `publishSpace` is a space id, key and display name read from
  // this organisation's own row, and `publishing` is a boolean. No token
  // material, and nothing derived from any — the substring guard below is
  // unchanged and still applies to every one of them.
  assert.deepEqual(Object.keys(data).sort(), [
    'connectedAt',
    'lastError',
    'provider',
    'publishSpace',
    'publishing',
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
// Spaces — the destination Phase 4's publish pipeline otherwise has no way to
// choose.
// ────────────────────────────────────────────────────────────────────────────

/** A stored access token this route's client can actually use, without exercising the refresh path. */
function sealedAccessTokenRow(
  integrationId: string,
  organisationId: string,
  token = 'SUPERSECRET-VALID-ACCESS-TOKEN',
): CredentialRow {
  return {
    integrationId,
    kind: 'access_token',
    sealed: sealIntegrationSecret(token, Buffer.from(VALID_KEY, 'hex'), 1, {
      organisationId,
      provider: 'CONFLUENCE',
      kind: 'access_token',
    }),
    generation: 1,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

function fetchThatMustNotRun() {
  return async () => {
    throw new Error('Confluence must not be called for an organisation with no live connection');
  };
}

test('spaces refuses with a clean 404 rather than a 500 when there is no connection at all', async () => {
  restoreKey();
  const { app } = await buildApp({ confluenceFetch: fetchThatMustNotRun() });
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/spaces',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_NOT_CONNECTED');
});

for (const status of ['DISCONNECTED', 'ERROR'] as const) {
  test(`spaces refuses with the same clean 404 when the connection is ${status}, not live`, async () => {
    restoreKey();
    const { app } = await buildApp({
      rows: [connectedRow({ status })],
      confluenceFetch: fetchThatMustNotRun(),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/confluence/spaces',
      headers: { authorization: bearer(ORG_A_ADMIN) },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_NOT_CONNECTED');
  });
}

test('spaces never reaches another organisation connection', async () => {
  restoreKey();
  const { app, store } = await buildApp({
    rows: [connectedRow()],
    actor: ORG_B_ADMIN,
    confluenceFetch: fetchThatMustNotRun(),
  });
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/spaces',
    headers: { authorization: bearer(ORG_B_ADMIN) },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_NOT_CONNECTED');
  assert.ok(
    store.calls.integrationFindUnique.every(
      (where) =>
        (where as { organisationId_provider?: { organisationId: string } }).organisationId_provider
          ?.organisationId === 'org-b',
    ),
    'the lookup must be scoped to the requesting organisation, never org-a',
  );
});

test('spaces returns only id, key and name for a connected organisation, and follows a supplied cursor', async () => {
  restoreKey();
  const requestedUrls: string[] = [];
  const { app, store } = await buildApp({
    rows: [connectedRow()],
    confluenceFetch: async (input: unknown) => {
      requestedUrls.push(String(input));
      return new Response(
        JSON.stringify({
          results: [
            {
              id: 'space1',
              key: 'GOV',
              name: 'Governance',
              description: { plain: { value: 'Board minutes and policies' } },
              permissions: [{ subject: 'user-1', operation: 'read' }],
            },
          ],
          _links: { base: 'https://charity-a.atlassian.net/wiki' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  store.credentials.push(sealedAccessTokenRow('integration-a', 'org-a'));

  const response = await app.inject({
    method: 'GET',
    url: '/confluence/spaces?cursor=RESUME-FROM-HERE',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });

  assert.equal(response.statusCode, 200, response.body);
  const { data } = JSON.parse(response.body);
  assert.deepEqual(data.spaces, [{ id: 'space1', key: 'GOV', name: 'Governance' }]);
  assert.equal(data.nextCursor, null);

  assert.equal(requestedUrls.length, 1, 'exactly one upstream request for a single page of spaces');
  const requested = new URL(requestedUrls[0]!);
  assert.equal(requested.pathname, '/ex/confluence/site-1/wiki/api/v2/spaces');
  assert.equal(requested.searchParams.get('cursor'), 'RESUME-FROM-HERE');
  assert.equal(requested.searchParams.get('limit'), '250');

  const serialised = response.body.toLowerCase();
  for (const forbidden of ['token', 'fingerprint', 'sealed', 'ciphertext', 'secret', 'refresh']) {
    assert.ok(!serialised.includes(forbidden), `spaces leaked ${forbidden}`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Choosing a space — the destination. Connected is NOT publishing.
// ────────────────────────────────────────────────────────────────────────────

/** A fake Confluence that lists exactly these spaces, on one page. */
function fetchListing(...spaces: Array<{ id: string; key: string; name: string }>) {
  return async () =>
    new Response(JSON.stringify({ results: spaces, _links: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

const LISTED_GOVERNANCE = { id: 'space-gov', key: 'GOV', name: 'Governance' };

function putPublishSpace(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  actor: Actor,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'PUT',
    url: '/confluence/publish-space',
    headers: { authorization: bearer(actor) },
    payload,
  });
}

/** A row that has already chosen Governance on the site it is connected to. */
function rowWithChosenSpace(overrides: Partial<IntegrationRow> = {}): IntegrationRow {
  return connectedRow({
    publishSpaceId: 'space-gov',
    publishSpaceKey: 'GOV',
    publishSpaceName: 'Governance',
    publishSpaceSiteId: 'site-1',
    ...overrides,
  });
}

test('a connected organisation with no chosen space is reported as not publishing', async () => {
  restoreKey();
  const { app } = await buildApp({ rows: [connectedRow()] });
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/status',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });

  const { data } = JSON.parse(response.body);
  assert.equal(data.status, 'CONNECTED');
  assert.equal(data.publishSpace, null);
  assert.equal(
    data.publishing,
    false,
    'connected-but-not-chosen must never be reported as publishing: a charity that believes it is ' +
      'mirroring and is not is worse off than one that knows it has a step left',
  );
});

test('choosing a listed space stores it on its own columns, and the organisation then publishes', async () => {
  restoreKey();
  const { app, store } = await buildApp({
    rows: [connectedRow()],
    confluenceFetch: fetchListing(LISTED_GOVERNANCE, { id: 'space-fin', key: 'FIN', name: 'Finance' }),
  });
  store.credentials.push(sealedAccessTokenRow('integration-a', 'org-a'));

  const chosen = await putPublishSpace(app, ORG_A_ADMIN, { spaceId: 'space-gov' });
  assert.equal(chosen.statusCode, 200, chosen.body);
  assert.deepEqual(JSON.parse(chosen.body).data.publishSpace, { id: 'space-gov', key: 'GOV', name: 'Governance' });

  const saved = store.integrations.get('integration-a')!;
  assert.equal(saved.publishSpaceId, 'space-gov');
  assert.equal(saved.publishSpaceKey, 'GOV');
  assert.equal(saved.publishSpaceSiteId, 'site-1', 'the site the space belongs to is recorded with it');
  // The choice must not be in `config`: that is the field a reconnect
  // overwrites wholesale.
  assert.deepEqual(saved.config, {
    siteId: 'site-1',
    siteUrl: 'https://charity-a.atlassian.net',
    siteName: 'Charity A',
    siteCount: 2,
  });

  const status = await app.inject({
    method: 'GET',
    url: '/confluence/status',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });
  const { data } = JSON.parse(status.body);
  assert.equal(data.publishing, true);
  assert.deepEqual(data.publishSpace, { id: 'space-gov', key: 'GOV', name: 'Governance' });
});

test('a space id the listing never returned is refused, and no destination is stored', async () => {
  restoreKey();
  const { app, store } = await buildApp({
    rows: [connectedRow()],
    confluenceFetch: fetchListing(LISTED_GOVERNANCE),
  });
  store.credentials.push(sealedAccessTokenRow('integration-a', 'org-a'));

  // An id a browser could put in the body but this charity's connection never
  // listed. Accepting it would aim publication at a space the charity never
  // intended, and bake that id into every page this pipeline creates.
  const refused = await putPublishSpace(app, ORG_A_ADMIN, { spaceId: 'space-somebody-elses' });

  assert.equal(refused.statusCode, 400, refused.body);
  assert.equal(JSON.parse(refused.body).code, 'CONFLUENCE_SPACE_NOT_LISTED');
  assert.equal(store.integrations.get('integration-a')!.publishSpaceId, null);
});

test('publish-space refuses a missing space id before Confluence is asked anything', async () => {
  restoreKey();
  const { app, store } = await buildApp({
    rows: [connectedRow()],
    confluenceFetch: fetchThatMustNotRun(),
  });

  for (const payload of [{}, { spaceId: '' }, { spaceId: 42 }]) {
    const response = await putPublishSpace(app, ORG_A_ADMIN, payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_SPACE_ID_REQUIRED');
  }
  assert.equal(store.integrations.get('integration-a')!.publishSpaceId, null);
});

test('publish-space refuses with a clean 404 rather than a 500 when there is no live connection', async () => {
  restoreKey();
  for (const rows of [[], [connectedRow({ status: 'DISCONNECTED' })], [connectedRow({ status: 'ERROR' })]]) {
    const { app } = await buildApp({ rows, confluenceFetch: fetchThatMustNotRun() });
    const response = await putPublishSpace(app, ORG_A_ADMIN, { spaceId: 'space-gov' });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_NOT_CONNECTED');
  }
});

test('publish-space never reaches another organisation connection', async () => {
  restoreKey();
  const { app, store } = await buildApp({
    rows: [connectedRow()],
    actor: ORG_B_ADMIN,
    confluenceFetch: fetchThatMustNotRun(),
  });

  const response = await putPublishSpace(app, ORG_B_ADMIN, { spaceId: 'space-gov' });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_NOT_CONNECTED');
  assert.equal(store.integrations.get('integration-a')!.publishSpaceId, null, "org-a's row must be untouched");
  assert.ok(
    store.calls.integrationFindUnique.every(
      (where) =>
        (where as { organisationId_provider?: { organisationId: string } }).organisationId_provider
          ?.organisationId === 'org-b',
    ),
    'the lookup must be scoped to the requesting organisation, never org-a',
  );
});

test('the publish-space response carries no token material', async () => {
  restoreKey();
  const { app, store } = await buildApp({
    rows: [connectedRow()],
    confluenceFetch: fetchListing(LISTED_GOVERNANCE),
  });
  store.credentials.push(sealedAccessTokenRow('integration-a', 'org-a'));

  const response = await putPublishSpace(app, ORG_A_ADMIN, { spaceId: 'space-gov' });
  assert.equal(response.statusCode, 200, response.body);

  const serialised = response.body.toLowerCase();
  for (const forbidden of ['token', 'fingerprint', 'sealed', 'ciphertext', 'secret', 'refresh']) {
    assert.ok(!serialised.includes(forbidden), `publish-space leaked ${forbidden}`);
  }
});

test('a space chosen earlier is not publishing while the connection is not live', async () => {
  restoreKey();
  for (const status of ['DISCONNECTED', 'ERROR'] as const) {
    const { app } = await buildApp({ rows: [rowWithChosenSpace({ status })] });
    const response = await app.inject({
      method: 'GET',
      url: '/confluence/status',
      headers: { authorization: bearer(ORG_A_ADMIN) },
    });

    const { data } = JSON.parse(response.body);
    // The choice is remembered — it is not the charity's fault the grant went
    // stale, and reconnecting to the same site keeps it. But a destination
    // with nothing able to reach it is not publication, and saying otherwise
    // would tell a charity its documents are being mirrored while nothing is.
    assert.deepEqual(data.publishSpace, { id: 'space-gov', key: 'GOV', name: 'Governance' }, status);
    assert.equal(data.publishing, false, `a ${status} connection must never report publishing`);
  }
});

// ── the reconnect, end to end through the REAL connection service ───────────
//
// Not a simulation: these two go through `POST /confluence/callback`, which
// calls `connectConfluence`, whose `connectingState` includes `config` and is
// spread into the upsert's `update`. That is the exact write that would have
// wiped a choice stored in `config`.

async function reconnectTo(site: { id: string; url: string; name: string }, rows: IntegrationRow[]) {
  const built = await buildApp({
    rows,
    exchangeAuthorizationCode: async () => ({
      accessToken: 'plaintext-access-token',
      refreshToken: { kind: 'issued' as const, token: 'plaintext-refresh-token' },
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [...CONFLUENCE_OAUTH_SCOPES],
    }),
    listAccessibleResources: async () => [site],
  });

  const state = await authorizeState(built.app, ORG_A_ADMIN);
  const reconnected = await postCallback(built.app, ORG_A_ADMIN, { code: 'c', state });
  assert.equal(reconnected.statusCode, 200, reconnected.body);

  const status = await built.app.inject({
    method: 'GET',
    url: '/confluence/status',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });
  assert.equal(status.statusCode, 200, status.body);
  return { data: JSON.parse(status.body).data as Record<string, unknown>, store: built.store };
}

test('a reconnect to the same Atlassian site keeps the chosen space', async () => {
  restoreKey();
  const { data, store } = await reconnectTo(
    { id: 'site-1', url: 'https://charity-a.atlassian.net', name: 'Charity A' },
    [rowWithChosenSpace()],
  );

  // Reconnecting is the recovery action CharityPilot's own error messages
  // recommend. A charity that takes it must not silently stop publishing.
  assert.deepEqual(data.publishSpace, { id: 'space-gov', key: 'GOV', name: 'Governance' });
  assert.equal(data.publishing, true);
  assert.equal(store.integrations.get('integration-a')!.publishSpaceId, 'space-gov');
});

test('a reconnect to a DIFFERENT Atlassian site reports no space chosen', async () => {
  restoreKey();
  const { data } = await reconnectTo(
    { id: 'site-2', url: 'https://charity-b.atlassian.net', name: 'Charity B' },
    [rowWithChosenSpace()],
  );

  // Space ids are per-site: the old id names nothing on the new site, so the
  // screen asks again rather than aiming publication at a space that is not
  // there.
  assert.equal(data.publishSpace, null);
  assert.equal(data.publishing, false);
  assert.equal(data.status, 'CONNECTED');
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
  const response = await postCallback(app, ORG_A_ADMIN, {
    code: 'SUPERSECRET-AUTHORIZATION-CODE',
    state,
  });

  assert.equal(response.statusCode, 200, response.body);
  const haystack = `${response.body}\n${captured.join('')}`;
  for (const secret of [
    'SUPERSECRET-ACCESS-TOKEN',
    'SUPERSECRET-REFRESH-TOKEN',
    'SUPERSECRET-AUTHORIZATION-CODE',
    state,
    process.env.ATLASSIAN_CLIENT_SECRET!,
  ]) {
    assert.ok(!haystack.includes(secret), `${secret} escaped the credential boundary`);
  }
  // Fastify logs `req.url` on every request and never the body. With the code
  // and the state in the body there is nothing left in the URL to censor —
  // which is the point: `redactSensitiveQueryParams` can only reach
  // CharityPilot's own log, and Phase 2 caught a *proxy's* error log writing a
  // live code. Pin that the logged URL is the bare path, so a future move
  // back to the query string shows up here.
  const logged = captured.join('');
  assert.ok(logged.includes('"url":"/confluence/callback"'), logged);
  assert.ok(!logged.includes('/confluence/callback?'), 'the callback URL must carry no query string');
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
  const response = await postCallback(app, ORG_A_ADMIN, { code: 'an-authorization-code', state });

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
  const response = await postCallback(app, ORG_A_ADMIN, { state });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_OAUTH_CODE_MISSING');
});

test('the callback surfaces an Atlassian error returned in place of a code', async () => {
  restoreKey();
  const { app } = await buildApp({ exchangeAuthorizationCode: tokenExchangeThatMustNotRun() });
  const state = await authorizeState(app, ORG_A_ADMIN);
  const response = await postCallback(app, ORG_A_ADMIN, { error: 'access_denied', state });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'CONFLUENCE_OAUTH_DENIED');
});

// ── the revocation attempt an operator has to be able to see ───────────────
//
// Atlassian documents no revocation endpoint for a 3LO app, so `revoked:
// false` is the case to plan for rather than the exception. A discarded
// return value would make a grant that is still standing at Atlassian
// invisible to everybody; the DELETE route logs it instead. 204 either way —
// the charity's disconnect succeeded.

const REVOKE_REFRESH_TOKEN = 'SUPERSECRET-STORED-REFRESH-TOKEN';

/** A credential row the service can actually open, so the revoke is really attempted. */
function sealedRefreshTokenRow(integrationId: string, organisationId: string): CredentialRow {
  return {
    integrationId,
    kind: 'refresh_token',
    sealed: sealIntegrationSecret(REVOKE_REFRESH_TOKEN, Buffer.from(VALID_KEY, 'hex'), 1, {
      organisationId,
      provider: 'CONFLUENCE',
      kind: 'refresh_token',
    }),
    generation: 1,
    expiresAt: null,
  };
}

async function disconnectAndCaptureLog(revokeStatus: number) {
  restoreKey();
  const captured: string[] = [];
  const revokes: string[] = [];
  const { app, store } = await buildApp({
    rows: [connectedRow()],
    logStream: { write: (chunk: string) => void captured.push(chunk) },
    confluenceOAuth: {
      fetch: async (input: unknown) => {
        revokes.push(String(input));
        return new Response(null, { status: revokeStatus });
      },
      clientId: process.env.ATLASSIAN_CLIENT_ID,
      clientSecret: process.env.ATLASSIAN_CLIENT_SECRET,
    },
  });
  store.credentials.push(sealedRefreshTokenRow('integration-a', 'org-a'));

  const response = await app.inject({
    method: 'DELETE',
    url: '/confluence',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });

  const lines = captured
    .join('')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  return { response, store, revokes, lines, raw: captured.join('') };
}

test('a revocation Atlassian will not confirm is logged where an operator can see it', async () => {
  const { response, store, revokes, lines, raw } = await disconnectAndCaptureLog(404);

  // The charity's disconnect succeeded and their credentials are gone. The
  // status code does not depend on Atlassian in any way.
  assert.equal(response.statusCode, 204);
  assert.equal(store.credentials.length, 0);
  assert.equal(store.integrations.get('integration-a')!.status, 'DISCONNECTED');

  // 404 is the shape of the failure that matters most: an endpoint Atlassian
  // may simply not offer.
  assert.equal(revokes.length, 1);

  const warning = lines.find(
    (line) => line.level === 40 && String(line.msg).includes('could not be confirmed as withdrawn'),
  );
  assert.ok(warning, `expected a warning about the unwithdrawn grant, got:\n${raw}`);
  assert.equal(warning.integrationId, 'integration-a');
  assert.equal(warning.provider, 'CONFLUENCE');
  // The two things the administrator can actually act on.
  assert.match(String(warning.msg), /90 days/);
  assert.match(String(warning.msg), /connected-apps settings/);

  // And the line is safe to ship to a log aggregator.
  for (const secret of [REVOKE_REFRESH_TOKEN, process.env.ATLASSIAN_CLIENT_SECRET!]) {
    assert.ok(!raw.includes(secret), `the logs leaked ${secret}`);
  }
});

test('a revocation Atlassian accepts is not logged as a problem', async () => {
  const { response, store, revokes, lines } = await disconnectAndCaptureLog(200);

  assert.equal(response.statusCode, 204);
  assert.equal(store.credentials.length, 0);
  assert.equal(revokes.length, 1);
  assert.equal(
    lines.find((line) => String(line.msg).includes('could not be confirmed as withdrawn')),
    undefined,
    'a revocation that succeeded must not warn — an operator who is warned every time stops reading',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// The connect-boundary disclosure
//
// These tests pin user-facing copy, which is unusual and deliberate. Every
// clause below is a limit on a data subject's erasure request; a later edit
// that makes the integration sound more capable than it is would cost a
// charity's DPO their answer to a regulator, and a pinned string is the only
// thing that makes such an edit fail loudly instead of shipping.
// ────────────────────────────────────────────────────────────────────────────

/** Every sentence of the disclosure, flattened, for substring assertions. */
function disclosureText(disclosure: unknown): string {
  const record = disclosure as {
    headline: string;
    erasure: readonly string[];
    disconnecting: readonly string[];
  };
  return [record.headline, ...record.erasure, ...record.disconnecting].join('\n');
}

test('authorize hands the administrator the limits along with the authorization URL', async () => {
  restoreKey();
  const { app } = await buildApp();
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/authorize',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });

  assert.equal(response.statusCode, 200);
  const { data } = JSON.parse(response.body);
  assert.ok(data.authorizationUrl, 'the URL must still be there');
  assert.deepEqual(
    data.disclosure,
    CONFLUENCE_CONNECT_DISCLOSURE,
    'the limits must travel with the URL, so no client can show one without the other',
  );
  assert.equal(data.disclosure.stage, 'alpha');
});

test('the status response is left alone, so its no-token-material guard stays strict', async () => {
  restoreKey();
  const { app } = await buildApp({ rows: [connectedRow()] });
  const response = await app.inject({
    method: 'GET',
    url: '/confluence/status',
    headers: { authorization: bearer(ORG_A_ADMIN) },
  });

  assert.equal(response.statusCode, 200);
  // Deliberate: the disclosure names a "refresh token", and `status` is
  // guarded by a substring test that forbids that word precisely because no
  // token material may appear on a tenant-facing connection report. Carrying
  // prose onto this response would mean loosening that guard to let prose
  // through, which is a worse trade than showing the limits one route earlier.
  // `authorize` is the connect boundary, and it is where they are shown.
  assert.equal(
    (JSON.parse(response.body).data as Record<string, unknown>).disclosure,
    undefined,
    'the limits belong on authorize; status must stay a keys-allow-listed connection report',
  );
});

test('the disclosure states the erasure limits the charity, not CharityPilot, controls', async () => {
  const text = disclosureText(CONFLUENCE_CONNECT_DISCLOSURE);

  // Best-effort, and whose permissions bound it.
  assert.match(text, /best-effort/);
  // The two permissions, named, because "higher permission" is not actionable.
  assert.match(text, /manage\/content/);
  assert.match(text, /administer space/);
  // The delete-then-purge sequence and the read-back that is the proof.
  assert.match(text, /404/);
  // The trash window, and whose trash it is.
  assert.match(text, /trash/);
  assert.match(text, /CharityPilot cannot\s+prevent that/);
  // A refused purge is reported, not quietly called success.
  assert.match(text, /does not quietly report success/);
  // The proof covers the page, not every attachment.
  assert.match(text, /only as complete as what CharityPilot published/);
  // No residency guarantee is claimed for content in the charity's own site.
  assert.match(text, /no data-residency guarantee/);
});

test('the disclosure never claims CharityPilot revoked anything at Atlassian', async () => {
  const text = disclosureText(CONFLUENCE_CONNECT_DISCLOSURE);

  // What is provable.
  assert.match(text, /complete and verifiable/);
  // What is attempted but not provable — and it must not be phrased as done.
  assert.match(text, /may silently do nothing/);
  assert.match(text, /does not claim to have revoked your access/);
  assert.ok(
    !/\bwe(?: have)? revoked\b/i.test(text) && !/CharityPilot revoked/i.test(text),
    'Atlassian documents no revocation for an app; claiming one would be a false assurance',
  );
  // The 90-day figure, attributed, and disclaimed as theirs to change.
  assert.match(text, /90 days/);
  assert.match(text, /not a CharityPilot guarantee/);
  // The one action that is guaranteed, and whose it is.
  assert.match(text, /only guaranteed way/);
  assert.match(text, /connected-apps settings/);
});

test('the disclosure says it is alpha, and points at the long form', async () => {
  assert.equal(CONFLUENCE_CONNECT_DISCLOSURE.stage, 'alpha');
  assert.match(CONFLUENCE_CONNECT_DISCLOSURE.headline, /alpha/);
  assert.match(
    CONFLUENCE_CONNECT_DISCLOSURE.reference,
    /docs\/ARCHITECTURE\.md/,
    'the short form must name where the long form lives, or the two drift unnoticed',
  );
});
