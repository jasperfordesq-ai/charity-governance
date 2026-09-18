import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative as relativePath, sep } from 'node:path';
import test from 'node:test';
import type { AtlassianTokens, OAuthDeps } from '../services/atlassian-oauth.js';
import {
  CONNECT_REQUEST_TIMEOUT_MS,
  REFRESH_CLAIM_STALE_AFTER_MS,
  REFRESH_REQUEST_TIMEOUT_MS,
  connectConfluence,
  currentAccessToken,
  currentAccessTokenForOrganisation,
  disconnectConfluence,
  resolveConnectTimeoutMs,
  resolveRefreshTimeoutMs,
  type ConfluenceConnectionClient,
} from '../services/confluence-connection.service.js';
import { OAUTH_STATE_TTL_SECONDS } from '../routes/integrations/oauth-state.js';
import { loadIntegrationCredential } from '../services/integration-credential.service.js';
import { integrationKeyFingerprint, sealIntegrationSecret } from '../services/integration-crypto.js';
import { AppError } from '../utils/errors.js';

const KEY = randomBytes(32);
const KEY_FINGERPRINT = integrationKeyFingerprint(KEY);

const ORG_ID = 'org-a';
const INTEGRATION_ID = 'int-1';
const PROVIDER = 'CONFLUENCE';

// A second charity on the same deployment, used by the organisation-scoping
// tests. Its integration id is exactly the kind of value a non-route caller
// could be handed by mistake.
const OTHER_ORG_ID = 'org-b';
const OTHER_INTEGRATION_ID = 'int-2';

// Every token literal the tests plant. Nothing in this list may ever appear in
// an OrganisationIntegration write, an IntegrationCredential write, or an
// error surfaced out of the service.
const STORED_REFRESH_TOKEN = 'stored-refresh-token-AAAA';
const ROTATED_REFRESH_TOKEN = 'rotated-refresh-token-BBBB';
const STORED_ACCESS_TOKEN = 'stored-access-token-CCCC';
const FRESH_ACCESS_TOKEN = 'fresh-access-token-DDDD';

// What a reconnect landing mid-refresh puts on file, and what the other
// charity holds. Both belong to the list above in spirit; they are separate
// only because the containment test that enumerates it is a pinned test and is
// left untouched.
const RECONNECT_REFRESH_TOKEN = 'reconnect-refresh-token-EEEE';
const RECONNECT_ACCESS_TOKEN = 'reconnect-access-token-FFFF';
const OTHER_ORG_ACCESS_TOKEN = 'other-org-access-token-GGGG';

/**
 * Always awaits `run()` before restoring the environment — the suite runs
 * these files concurrently, so a synchronous restore would pull the key out
 * from under an in-flight body. Copied deliberately from
 * integration-credential.service.test.ts.
 */
async function withKey<T>(run: () => T | Promise<T>): Promise<T> {
  const previous = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = KEY.toString('hex');
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
    else process.env.INTEGRATION_ENCRYPTION_KEY = previous;
  }
}

// ── the fake ───────────────────────────────────────────────────────────────
// Hand-written, per the task constraint: no Prisma, no database, no mocking
// library. It is deliberately strict — an unsupported `where` shape throws
// rather than silently matching, because a permissive fake would make the
// claim assertions meaningless.

type IntegrationRow = {
  id: string;
  organisationId: string;
  provider: string;
  status: string;
  config: unknown;
  lastError: string | null;
  connectedAt: Date | null;
  connectedById: string | null;
  refreshClaimedAt: Date | null;
  refreshClaimToken: string | null;
  refreshFailureCount: number;
  lastRefreshedAt: Date | null;
};

type CredentialRow = {
  integrationId: string;
  kind: string;
  sealed: unknown;
  generation: number;
  expiresAt: Date | null;
};

type WhereClause = Record<string, unknown>;

function matchesIntegration(row: IntegrationRow, where: WhereClause): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (field === 'OR') {
      if (!Array.isArray(condition)) throw new Error('fake prisma: OR must be an array');
      if (!condition.some((clause) => matchesIntegration(row, clause as WhereClause))) return false;
      continue;
    }

    const value = (row as unknown as Record<string, unknown>)[field];

    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const operators = condition as Record<string, unknown>;
      const keys = Object.keys(operators);
      if (keys.length !== 1 || keys[0] !== 'lt') {
        throw new Error(`fake prisma: unsupported condition on "${field}": ${keys.join(',')}`);
      }
      const bound = operators.lt;
      if (!(bound instanceof Date)) throw new Error(`fake prisma: lt on "${field}" must be a Date`);
      if (!(value instanceof Date) || value.getTime() >= bound.getTime()) return false;
      continue;
    }

    if (value instanceof Date && condition instanceof Date) {
      if (value.getTime() !== condition.getTime()) return false;
      continue;
    }

    if (value !== condition) return false;
  }
  return true;
}

/**
 * The database CHECK constraint
 * (`OrganisationIntegration_refresh_claim_consistent`), enforced in the fake
 * so a release that clears one half of the pair fails here exactly as it
 * would in PostgreSQL, instead of silently corrupting claim state.
 */
function assertClaimPairConsistent(row: IntegrationRow): void {
  if ((row.refreshClaimToken === null) !== (row.refreshClaimedAt === null)) {
    throw new Error(
      'CHECK constraint "OrganisationIntegration_refresh_claim_consistent" violated: ' +
        'refreshClaimToken and refreshClaimedAt must be null together or set together',
    );
  }
}

function applyIntegrationData(row: IntegrationRow, data: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const operators = value as Record<string, unknown>;
      if (Object.keys(operators).length === 1 && typeof operators.increment === 'number') {
        const current = (row as unknown as Record<string, unknown>)[field];
        (row as unknown as Record<string, unknown>)[field] =
          (typeof current === 'number' ? current : 0) + operators.increment;
        continue;
      }
    }
    (row as unknown as Record<string, unknown>)[field] = value;
  }
  assertClaimPairConsistent(row);
}

/**
 * Another charity's live Confluence integration, sitting in the same tables.
 * It exists so a lookup that is not scoped to the asking organisation has
 * something to reach — an unscoped lookup with only one row in the database
 * proves nothing.
 */
type OtherOrganisation = {
  organisationId: string;
  integrationId: string;
  accessToken: { plaintext: string; expiresAt: Date | null };
};

type FakeOptions = {
  integration?: Partial<IntegrationRow> | null;
  storedRefreshToken?: string | null;
  storedAccessToken?: { plaintext: string; expiresAt: Date | null } | null;
  /** Make the sealed-credential write for this kind throw, standing in for a failed write. */
  failCredentialWriteFor?: string;
  /** What that write throws. Defaults to a plain Error; an AppError exercises a different branch. */
  credentialWriteError?: unknown;
  /** Further charities on the same deployment. */
  others?: OtherOrganisation[];
};

function fakePrisma(options: FakeOptions = {}) {
  const {
    integration = {},
    storedRefreshToken = STORED_REFRESH_TOKEN,
    storedAccessToken = null,
    failCredentialWriteFor,
    credentialWriteError,
    others = [],
  } = options;

  // Lets a test act at a chosen point in the service's read sequence — the
  // only way to simulate another worker finishing between two of this
  // caller's reads without depending on timing. Awaited, so the hook can run a
  // whole `connectConfluence` to completion at that point rather than merely
  // starting one.
  const hooks: { onCredentialRead?: (call: number) => void | Promise<void> } = {};
  let credentialReads = 0;

  const integrations: IntegrationRow[] = [];
  if (integration !== null) {
    integrations.push({
      id: INTEGRATION_ID,
      organisationId: ORG_ID,
      provider: PROVIDER,
      status: 'CONNECTED',
      config: { siteId: 'site-1', siteUrl: 'https://charity.atlassian.net', siteName: 'Charity' },
      lastError: null,
      connectedAt: new Date('2026-01-01T00:00:00.000Z'),
      connectedById: 'user-1',
      refreshClaimedAt: null,
      refreshClaimToken: null,
      refreshFailureCount: 0,
      lastRefreshedAt: null,
      ...integration,
    });
  }

  const credentials: CredentialRow[] = [];
  const sealFor = (kind: string, plaintext: string, organisationId: string = ORG_ID) =>
    sealIntegrationSecret(plaintext, KEY, 1, { organisationId, provider: PROVIDER, kind });

  for (const other of others) {
    integrations.push({
      id: other.integrationId,
      organisationId: other.organisationId,
      provider: PROVIDER,
      status: 'CONNECTED',
      config: null,
      lastError: null,
      connectedAt: new Date('2026-01-01T00:00:00.000Z'),
      connectedById: 'user-other',
      refreshClaimedAt: null,
      refreshClaimToken: null,
      refreshFailureCount: 0,
      lastRefreshedAt: null,
    });
    credentials.push({
      integrationId: other.integrationId,
      kind: 'access_token',
      sealed: sealFor('access_token', other.accessToken.plaintext, other.organisationId),
      generation: 1,
      expiresAt: other.accessToken.expiresAt,
    });
  }

  if (storedRefreshToken !== null) {
    credentials.push({
      integrationId: INTEGRATION_ID,
      kind: 'refresh_token',
      sealed: sealFor('refresh_token', storedRefreshToken),
      generation: 1,
      expiresAt: null,
    });
  }
  if (storedAccessToken !== null) {
    credentials.push({
      integrationId: INTEGRATION_ID,
      kind: 'access_token',
      sealed: sealFor('access_token', storedAccessToken.plaintext),
      generation: 1,
      expiresAt: storedAccessToken.expiresAt,
    });
  }

  // Everything written, kept for the "no plaintext escapes" assertions.
  const integrationWrites: unknown[] = [];
  const credentialWrites: unknown[] = [];

  // The same writes in one ordered list. The two arrays above are separate, so
  // the *relative* order of a row write and a credential write is invisible to
  // them — and that order is exactly what the refresh fence depends on in
  // `connectConfluence`.
  type WriteLogEntry =
    | { table: 'integration'; data: Record<string, unknown> }
    | { table: 'credential'; kind: string };
  const writeLog: WriteLogEntry[] = [];

  const findIntegration = (id: string) => integrations.find((row) => row.id === id) ?? null;
  const findCredential = (integrationId: string, kind: string) =>
    credentials.find((row) => row.integrationId === integrationId && row.kind === kind) ?? null;

  const delegates = {
    organisationIntegration: {
      findUnique: async (args: {
        where: {
          id?: string;
          organisationId_provider?: { organisationId: string; provider: string };
        };
      }) => {
        // The organisation-scoped form the route layer uses, and the only form
        // a caller outside a route may reach an integration through.
        const scoped = args.where.organisationId_provider;
        if (scoped) {
          const found = integrations.find(
            (row) => row.organisationId === scoped.organisationId && row.provider === scoped.provider,
          );
          return found === undefined ? null : { ...found };
        }
        if (typeof args.where.id !== 'string') {
          throw new Error('fake prisma: organisationIntegration.findUnique needs an id');
        }
        const row = findIntegration(args.where.id);
        return row === null ? null : { ...row };
      },
      updateMany: async (args: { where: WhereClause; data: Record<string, unknown> }) => {
        // No `await` before the mutation: the body runs to completion
        // synchronously, which is what makes this fake behave like a single
        // atomic statement under concurrent callers.
        const matched = integrations.filter((row) => matchesIntegration(row, args.where));
        for (const row of matched) applyIntegrationData(row, args.data);
        integrationWrites.push(args);
        writeLog.push({ table: 'integration', data: args.data });
        return { count: matched.length };
      },
      upsert: async (args: {
        where: { organisationId_provider: { organisationId: string; provider: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { organisationId, provider } = args.where.organisationId_provider;
        integrationWrites.push(args);
        const existing = integrations.find(
          (row) => row.organisationId === organisationId && row.provider === provider,
        );
        if (existing) {
          applyIntegrationData(existing, args.update);
          writeLog.push({ table: 'integration', data: args.update });
          return { ...existing };
        }
        const created: IntegrationRow = {
          id: INTEGRATION_ID,
          organisationId,
          provider,
          status: 'DISCONNECTED',
          config: null,
          lastError: null,
          connectedAt: null,
          connectedById: null,
          refreshClaimedAt: null,
          refreshClaimToken: null,
          refreshFailureCount: 0,
          lastRefreshedAt: null,
        };
        applyIntegrationData(created, args.create);
        writeLog.push({ table: 'integration', data: args.create });
        integrations.push(created);
        return { ...created };
      },
    },
    integrationCredential: {
      findUnique: async (args: {
        where: { integrationId_kind: { integrationId: string; kind: string } };
      }) => {
        const { integrationId, kind } = args.where.integrationId_kind;
        const row = findCredential(integrationId, kind);
        // Snapshot first, then run the hook: the hook stands for another
        // worker's write landing *after* this read returned.
        const result = row === null ? null : { ...row };
        credentialReads += 1;
        await hooks.onCredentialRead?.(credentialReads);
        return result;
      },
      upsert: async (args: {
        where: { integrationId_kind: { integrationId: string; kind: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { integrationId, kind } = args.where.integrationId_kind;
        if (failCredentialWriteFor === kind) {
          throw credentialWriteError ?? new Error(`fake prisma: credential write for "${kind}" failed`);
        }
        credentialWrites.push(args);
        writeLog.push({ table: 'credential', kind });
        const existing = findCredential(integrationId, kind);
        if (existing) {
          Object.assign(existing, args.update);
          return { ...existing };
        }
        const created = { integrationId, kind, ...args.create } as unknown as CredentialRow;
        credentials.push(created);
        return { ...created };
      },
      deleteMany: async (args: { where: { integrationId: string } }) => {
        const before = credentials.length;
        for (let i = credentials.length - 1; i >= 0; i -= 1) {
          if (credentials[i]!.integrationId === args.where.integrationId) credentials.splice(i, 1);
        }
        return { count: before - credentials.length };
      },
      count: async () => 0,
    },
    integrationSecretControl: {
      findUnique: async () => ({ id: 1, generation: 1, activeKeyFingerprint: KEY_FINGERPRINT }),
      upsert: async () => ({}),
    },
  };

  const client = {
    ...delegates,
    $transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run(delegates),
  };

  return {
    client: client as unknown as ConfluenceConnectionClient,
    integrations,
    credentials,
    integrationWrites,
    credentialWrites,
    writeLog,
    hooks,
    /** Stand in for another worker having stored a fresh access token. */
    setAccessToken: (plaintext: string, expiresAt: Date | null) => {
      const sealed = sealFor('access_token', plaintext);
      const existing = findCredential(INTEGRATION_ID, 'access_token');
      if (existing) Object.assign(existing, { sealed, expiresAt });
      else
        credentials.push({
          integrationId: INTEGRATION_ID,
          kind: 'access_token',
          sealed,
          generation: 1,
          expiresAt,
        });
    },
    row: () => {
      const found = findIntegration(INTEGRATION_ID);
      assert.ok(found, 'expected the integration row to exist');
      return found;
    },
    credential: (kind: string) => findCredential(INTEGRATION_ID, kind),
  };
}

// ── fake Atlassian ─────────────────────────────────────────────────────────

function tokens(overrides: Partial<AtlassianTokens> = {}): AtlassianTokens {
  return {
    accessToken: FRESH_ACCESS_TOKEN,
    refreshToken: { kind: 'issued', token: ROTATED_REFRESH_TOKEN },
    expiresAt: new Date(NOW.getTime() + 3_540_000),
    scopes: ['read:page:confluence', 'offline_access'],
    ...overrides,
  };
}

const NOW = new Date('2026-09-18T12:00:00.000Z');
const clock = () => NOW;

type RefreshRecorder = {
  calls: string[];
  fn: (refreshToken: string) => Promise<AtlassianTokens>;
};

function recordingRefresh(
  respond: (call: number, refreshToken: string) => Promise<AtlassianTokens> = async () => tokens(),
): RefreshRecorder {
  const calls: string[] = [];
  return {
    calls,
    fn: async (refreshToken: string) => {
      calls.push(refreshToken);
      return respond(calls.length, refreshToken);
    },
  };
}

function invalidGrant(): AppError {
  return new AppError(400, 'ATLASSIAN_OAUTH_TOKEN_FAILED', 'Atlassian OAuth token request failed: invalid_grant', {
    status: 400,
    error: 'invalid_grant',
    error_description: 'refresh token is invalid',
  });
}

const neverCalled = async (): Promise<never> => {
  throw new Error('Atlassian must not be called');
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Let every pending microtask run. The service's whole path between awaits is
 * microtasks, so one macrotask turn drains it deterministically — no timing
 * guesswork, and the interleave below is reproducible.
 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

// ── tests ──────────────────────────────────────────────────────────────────

test('a valid stored access token is returned without touching Atlassian', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() + 60_000) },
  });
  const refresh = recordingRefresh();

  const token = await withKey(() =>
    currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refresh.fn,
      oauth: { fetch: neverCalled as unknown as typeof globalThis.fetch },
    }),
  );

  assert.equal(token, STORED_ACCESS_TOKEN);
  assert.equal(refresh.calls.length, 0);
  // Nothing was claimed, so nothing had to be released.
  assert.equal(fake.integrationWrites.length, 0);
  assert.equal(fake.row().refreshClaimToken, null);
});

test('an expired access token is refreshed exactly once and the replacement is stored', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });
  const refresh = recordingRefresh();

  const token = await withKey(() =>
    currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refresh.fn,
    }),
  );

  assert.equal(token, FRESH_ACCESS_TOKEN);
  assert.deepEqual(refresh.calls, [STORED_REFRESH_TOKEN]);

  const kinds = fake.credentialWrites.map(
    (write) => (write as { where: { integrationId_kind: { kind: string } } }).where.integrationId_kind.kind,
  );
  // The irreplaceable secret is written first, and before the new access
  // token is stored or returned.
  assert.deepEqual(kinds, ['refresh_token', 'access_token']);

  const row = fake.row();
  assert.equal(row.refreshClaimToken, null);
  assert.equal(row.refreshClaimedAt, null);
  assert.equal(row.status, 'CONNECTED');
  assert.equal(row.refreshFailureCount, 0);
  assert.deepEqual(row.lastRefreshedAt, NOW);
});

test('two concurrent callers produce exactly one refresh call', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });
  // A distinct access token per call, so a second refresh cannot hide behind
  // an identical value.
  const refresh = recordingRefresh(async (call) =>
    tokens({ accessToken: `${FRESH_ACCESS_TOKEN}-${call}`, refreshToken: { kind: 'issued', token: `${ROTATED_REFRESH_TOKEN}-${call}` } }),
  );

  const [first, second] = await withKey(() =>
    Promise.all([
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
        now: clock,
        refreshAccessToken: refresh.fn,
        sleep: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
      }),
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
        now: clock,
        refreshAccessToken: refresh.fn,
        sleep: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
      }),
    ]),
  );

  assert.equal(refresh.calls.length, 1, 'exactly one refresh must reach Atlassian');
  assert.deepEqual(refresh.calls, [STORED_REFRESH_TOKEN]);
  assert.equal(first, `${FRESH_ACCESS_TOKEN}-1`);
  assert.equal(second, `${FRESH_ACCESS_TOKEN}-1`);
  assert.equal(fake.row().refreshClaimToken, null);
  assert.equal(fake.row().refreshClaimedAt, null);
});

test('a not_rotated outcome never clears or overwrites the stored refresh token', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });
  const sealedBefore = JSON.stringify(fake.credential('refresh_token'));
  const refresh = recordingRefresh(async () => tokens({ refreshToken: { kind: 'not_rotated' } }));

  const token = await withKey(() =>
    currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refresh.fn,
    }),
  );

  assert.equal(token, FRESH_ACCESS_TOKEN);
  const kinds = fake.credentialWrites.map(
    (write) => (write as { where: { integrationId_kind: { kind: string } } }).where.integrationId_kind.kind,
  );
  assert.deepEqual(kinds, ['access_token'], 'the refresh token row must not be written at all');
  assert.equal(JSON.stringify(fake.credential('refresh_token')), sealedBefore);

  // And it is still usable: the next refresh presents the same stored token.
  const secondRefresh = recordingRefresh();
  await withKey(() =>
    currentAccessToken(
      fake.client,
      { integrationId: INTEGRATION_ID },
      { now: () => new Date(NOW.getTime() + 7_200_000), refreshAccessToken: secondRefresh.fn },
    ),
  );
  assert.deepEqual(secondRefresh.calls, [STORED_REFRESH_TOKEN]);
});

test('a failed write of the replacement refresh token surfaces and releases the claim', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
    failCredentialWriteFor: 'refresh_token',
  });
  const refresh = recordingRefresh();

  await assert.rejects(
    withKey(() =>
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
        now: clock,
        refreshAccessToken: refresh.fn,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'CONFLUENCE_REFRESH_TOKEN_PERSIST_FAILED');
      assert.equal(JSON.stringify({ message: error.message, details: error.details, cause: error.cause }).includes(ROTATED_REFRESH_TOKEN), false);
      return true;
    },
  );

  // The new access token was never stored, because the replacement refresh
  // token it depends on was never durably written.
  assert.equal(fake.credential('access_token')?.expiresAt?.getTime(), NOW.getTime() - 1_000);
  // The claim did not leak: a later call does not have to wait out the window.
  assert.equal(fake.row().refreshClaimToken, null);
  assert.equal(fake.row().refreshClaimedAt, null);
});

test('a persist failure that is itself an AppError still pages rather than inheriting its status', async () => {
  // storeIntegrationCredential can answer with 404 INTEGRATION_NOT_FOUND or
  // 500 INTEGRATION_KEY_MISMATCH. Surfacing either verbatim reports a routine
  // failure while the charity's only refresh token has just been destroyed —
  // this is the one outcome that must page.
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
    failCredentialWriteFor: 'refresh_token',
    credentialWriteError: new AppError(404, 'INTEGRATION_NOT_FOUND', 'Integration not found'),
  });
  const refresh = recordingRefresh();

  await assert.rejects(
    withKey(() =>
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
        now: clock,
        refreshAccessToken: refresh.fn,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'CONFLUENCE_REFRESH_TOKEN_PERSIST_FAILED');
      assert.equal(error.statusCode, 500, 'must page, not report a 404');
      return true;
    },
  );

  assert.equal(fake.row().refreshClaimToken, null);
});

test('a claim leaked by a crash ages out and the next call reaches an actionable state', async () => {
  // The state a crash between Atlassian's response and the store leaves
  // behind: the claim still held, the stored refresh token still the old one
  // (which Atlassian has already invalidated).
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
    integration: {
      refreshClaimToken: 'claim-from-the-dead-process',
      refreshClaimedAt: new Date(NOW.getTime() - REFRESH_CLAIM_STALE_AFTER_MS - 1_000),
    },
  });
  const refresh = recordingRefresh(async () => {
    throw invalidGrant();
  });

  await assert.rejects(
    withKey(() =>
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
        now: clock,
        refreshAccessToken: refresh.fn,
        sleep: async () => {},
      }),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'ATLASSIAN_OAUTH_TOKEN_FAILED',
  );

  assert.equal(refresh.calls.length, 1, 'the stale claim must be reclaimable');
  const row = fake.row();
  assert.equal(row.status, 'ERROR');
  assert.ok(row.lastError);
  assert.match(row.lastError, /reconnect/i);
  assert.equal(row.refreshClaimToken, null, 'the reclaimed claim must be released again');
  assert.equal(row.refreshClaimedAt, null);
});

test('a slow holder never clears the newer claim that superseded it', async () => {
  // The race the fence exists for. A's refresh hangs long enough for its claim
  // to go stale; B legitimately steals it and starts its own refresh; A then
  // finishes. Every write A makes from here on must match on the token A
  // claimed with, or A tears down a claim somebody else is actively
  // refreshing under — and a third caller is then free to refresh in
  // parallel, which is the destruction the claim exists to prevent.
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });

  const deferred = [defer<AtlassianTokens>(), defer<AtlassianTokens>()];
  const calls: string[] = [];
  const refreshFn = async (refreshToken: string) => {
    calls.push(refreshToken);
    return deferred[calls.length - 1]!.promise;
  };

  const later = new Date(NOW.getTime() + REFRESH_CLAIM_STALE_AFTER_MS + 1);

  return withKey(async () => {
    const slowHolder = currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refreshFn,
    });
    await flush();
    assert.equal(calls.length, 1);
    const holderClaim = fake.row().refreshClaimToken;
    assert.ok(holderClaim);

    const stealer = currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: () => later,
      refreshAccessToken: refreshFn,
    });
    await flush();
    assert.equal(calls.length, 2, 'the stale claim must be takeable');
    const stealerClaim = fake.row().refreshClaimToken;
    assert.ok(stealerClaim);
    assert.notEqual(stealerClaim, holderClaim);

    deferred[0]!.resolve(tokens({ accessToken: `${FRESH_ACCESS_TOKEN}-slow` }));
    await slowHolder;

    assert.equal(
      fake.row().refreshClaimToken,
      stealerClaim,
      "the slow holder must not clear the newer holder's claim",
    );
    assert.deepEqual(fake.row().refreshClaimedAt, later);

    deferred[1]!.resolve(tokens({ accessToken: `${FRESH_ACCESS_TOKEN}-stealer` }));
    assert.equal(await stealer, `${FRESH_ACCESS_TOKEN}-stealer`);
    assert.equal(fake.row().refreshClaimToken, null);
  });
});

test('a slow holder whose grant is rejected never marks the newer holder errored', async () => {
  // The other half of the fence, and the one that guards a *wrong* diagnosis.
  // A's claim goes stale and B steals it; A's refresh then comes back
  // `invalid_grant` — which is true of the token A was given, and says nothing
  // about the connection B is at that moment refreshing successfully. Unfenced,
  // A marks a healthy integration ERROR with "Reconnect Confluence" and rips
  // away B's claim on the way out.
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });

  const deferred = [defer<AtlassianTokens>(), defer<AtlassianTokens>()];
  const calls: string[] = [];
  const refreshFn = async (refreshToken: string) => {
    calls.push(refreshToken);
    return deferred[calls.length - 1]!.promise;
  };

  const later = new Date(NOW.getTime() + REFRESH_CLAIM_STALE_AFTER_MS + 1);

  return withKey(async () => {
    const slowHolder = currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refreshFn,
    });
    await flush();
    const stealer = currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: () => later,
      refreshAccessToken: refreshFn,
    });
    await flush();
    assert.equal(calls.length, 2);
    const stealerClaim = fake.row().refreshClaimToken;
    assert.ok(stealerClaim);

    deferred[0]!.reject(invalidGrant());
    await assert.rejects(slowHolder, (error: unknown) => error instanceof AppError);

    const row = fake.row();
    assert.equal(row.status, 'CONNECTED', 'a superseded holder must not mark the integration errored');
    assert.equal(row.lastError, null);
    assert.equal(row.refreshFailureCount, 0);
    assert.equal(row.refreshClaimToken, stealerClaim, "and must not clear the newer holder's claim");

    deferred[1]!.resolve(tokens({ accessToken: `${FRESH_ACCESS_TOKEN}-stealer` }));
    assert.equal(await stealer, `${FRESH_ACCESS_TOKEN}-stealer`);
    assert.equal(fake.row().status, 'CONNECTED');
  });
});

test('a superseded holder does not even count a transient failure against the newer holder', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });

  const deferred = [defer<AtlassianTokens>(), defer<AtlassianTokens>()];
  const calls: string[] = [];
  const refreshFn = async (refreshToken: string) => {
    calls.push(refreshToken);
    return deferred[calls.length - 1]!.promise;
  };
  const later = new Date(NOW.getTime() + REFRESH_CLAIM_STALE_AFTER_MS + 1);

  return withKey(async () => {
    const slowHolder = currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refreshFn,
    });
    await flush();
    const stealer = currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: () => later,
      refreshAccessToken: refreshFn,
    });
    await flush();
    const stealerClaim = fake.row().refreshClaimToken;

    deferred[0]!.reject(
      new AppError(502, 'ATLASSIAN_OAUTH_UNREACHABLE', 'Could not reach Atlassian to exchange the OAuth token.'),
    );
    await assert.rejects(slowHolder, (error: unknown) => error instanceof AppError);

    assert.equal(fake.row().refreshFailureCount, 0);
    assert.equal(fake.row().refreshClaimToken, stealerClaim);

    deferred[1]!.resolve(tokens());
    await stealer;
  });
});

test('an invalid_client failure is our misconfiguration, not a revoked grant', async () => {
  // Atlassian answers a bad CLIENT credential with 401/invalid_client. Widening
  // the grant-rejection test to cover it would tell every charity on the
  // deployment to reconnect because ATLASSIAN_CLIENT_SECRET is wrong.
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });
  const refresh = recordingRefresh(async () => {
    throw new AppError(
      409,
      'ATLASSIAN_OAUTH_RECONNECT_REQUIRED',
      'Atlassian OAuth token request failed: invalid_client (client authentication failed)',
      { status: 401, error: 'invalid_client', error_description: 'client authentication failed' },
    );
  });

  await assert.rejects(
    withKey(() =>
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
        now: clock,
        refreshAccessToken: refresh.fn,
      }),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'ATLASSIAN_OAUTH_RECONNECT_REQUIRED',
  );

  const row = fake.row();
  assert.equal(row.status, 'CONNECTED', 'our own misconfiguration must not mark the charity broken');
  assert.equal(row.lastError, null);
  assert.equal(row.refreshFailureCount, 1);
  assert.equal(row.refreshClaimToken, null);
});

test('the refresh request carries a deadline the claim window dominates', async () => {
  // The staleness window is only safe while it dominates the worst case
  // duration of one refresh. undici's own defaults (headersTimeout 300s +
  // bodyTimeout 300s) sum to roughly the window, so the bound has to be ours.
  assert.ok(
    REFRESH_REQUEST_TIMEOUT_MS * 10 <= REFRESH_CLAIM_STALE_AFTER_MS,
    'the claim window must dominate the request deadline by at least 10x',
  );

  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });

  // A request that would otherwise hang forever, exactly as undici can.
  // `AbortSignal.timeout`'s own timer is unref'd, so the test needs a ref'd
  // one to hold the event loop open — and it doubles as the assertion that the
  // deadline fires at all.
  const hangingFetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('the deadline never fired')), 1_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(new Error('request aborted by deadline'));
      });
    })) as unknown as typeof globalThis.fetch;

  const refreshFn = async (_refreshToken: string, oauth?: OAuthDeps) => {
    assert.ok(oauth?.fetch, 'the refresh must be handed a bounded fetch');
    await oauth.fetch('https://auth.atlassian.com/oauth/token', { method: 'POST' });
    throw new Error('the request should not have completed');
  };

  await assert.rejects(
    withKey(() =>
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
        now: clock,
        refreshTimeoutMs: 5,
        refreshAccessToken: refreshFn as never,
        oauth: { fetch: hangingFetch },
      }),
    ),
    /request aborted by deadline/,
  );

  // A timed-out refresh is not a revoked grant.
  assert.equal(fake.row().status, 'CONNECTED');
  assert.equal(fake.row().refreshClaimToken, null, 'and the claim is released, not leaked');
});

test('a stored access token with no recorded expiry is treated as expired', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: null },
  });
  const refresh = recordingRefresh();

  const token = await withKey(() =>
    currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refresh.fn,
    }),
  );

  assert.equal(token, FRESH_ACCESS_TOKEN);
  assert.equal(refresh.calls.length, 1, 'a credential with no known lifetime must be renewed, not presented');
});

test('a rotation is not spent on a token another worker stored between the read and the claim', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });
  const refresh = recordingRefresh();
  fake.hooks.onCredentialRead = (call) => {
    // Right after this caller's pre-claim read came back expired, another
    // worker finishes its own refresh and stores the result.
    if (call === 1) fake.setAccessToken(FRESH_ACCESS_TOKEN, new Date(NOW.getTime() + 60_000));
  };

  const token = await withKey(() =>
    currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refresh.fn,
    }),
  );

  assert.equal(token, FRESH_ACCESS_TOKEN);
  assert.equal(refresh.calls.length, 0, 'the post-claim re-check must not spend a rotation');
  assert.equal(fake.row().refreshClaimToken, null, 'and must still release the claim it took');
});

test('a stale claim is reclaimable and the refresh then succeeds', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
    integration: {
      refreshClaimToken: 'abandoned-claim',
      refreshClaimedAt: new Date(NOW.getTime() - REFRESH_CLAIM_STALE_AFTER_MS - 1),
    },
  });
  const refresh = recordingRefresh();

  const token = await withKey(() =>
    currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refresh.fn,
    }),
  );

  assert.equal(token, FRESH_ACCESS_TOKEN);
  assert.equal(refresh.calls.length, 1);
  assert.equal(fake.row().refreshClaimToken, null);
});

test('a claim inside the staleness window is not stealable', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
    integration: {
      refreshClaimToken: 'held-by-another-worker',
      refreshClaimedAt: new Date(NOW.getTime() - 1_000),
    },
  });
  const refresh = recordingRefresh();

  await assert.rejects(
    withKey(() =>
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
        now: clock,
        refreshAccessToken: refresh.fn,
        sleep: async () => {},
      }),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'CONFLUENCE_REFRESH_IN_PROGRESS',
  );

  assert.equal(refresh.calls.length, 0, 'a refresh must never happen without the claim');
  // The other worker's claim is untouched: a loser must not clear a claim it
  // does not hold.
  assert.equal(fake.row().refreshClaimToken, 'held-by-another-worker');
  // And a lost race is NOT a revoked grant.
  assert.equal(fake.row().status, 'CONNECTED');
  assert.equal(fake.row().lastError, null);
});

test('invalid_grant while holding the claim marks the integration errored', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });
  const refresh = recordingRefresh(async () => {
    throw invalidGrant();
  });

  await assert.rejects(
    withKey(() =>
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
        now: clock,
        refreshAccessToken: refresh.fn,
      }),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'ATLASSIAN_OAUTH_TOKEN_FAILED',
  );

  const row = fake.row();
  assert.equal(row.status, 'ERROR');
  assert.equal(row.refreshFailureCount, 1);
  assert.ok(row.lastError);
  assert.match(row.lastError, /invalid_grant/);
  assert.match(row.lastError, /reconnect/i);
  assert.equal(row.refreshClaimToken, null);
  assert.equal(row.refreshClaimedAt, null);
});

test('a transient upstream failure does not mark the integration errored', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });
  const refresh = recordingRefresh(async () => {
    throw new AppError(502, 'ATLASSIAN_OAUTH_UNREACHABLE', 'Could not reach Atlassian to exchange the OAuth token.');
  });

  await assert.rejects(
    withKey(() =>
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
        now: clock,
        refreshAccessToken: refresh.fn,
      }),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'ATLASSIAN_OAUTH_UNREACHABLE',
  );

  const row = fake.row();
  assert.equal(row.status, 'CONNECTED', 'a network blip is not a revoked grant');
  assert.equal(row.lastError, null);
  assert.equal(row.refreshFailureCount, 1);
  assert.equal(row.refreshClaimToken, null);
});

test('no plaintext token ever reaches the integration row or a credential write', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });
  const refresh = recordingRefresh();

  await withKey(() =>
    currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refresh.fn,
    }),
  );

  const serialised = JSON.stringify({
    integrationWrites: fake.integrationWrites,
    credentialWrites: fake.credentialWrites,
    integrationRow: fake.integrations,
  });
  for (const secret of [STORED_REFRESH_TOKEN, ROTATED_REFRESH_TOKEN, STORED_ACCESS_TOKEN, FRESH_ACCESS_TOKEN]) {
    assert.equal(serialised.includes(secret), false, `"${secret}" must never be persisted in the clear`);
  }
});

test('currentAccessToken rejects an unknown integration rather than looping', async () => {
  const fake = fakePrisma({ integration: null, storedRefreshToken: null });

  await assert.rejects(
    withKey(() =>
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, { now: clock, refreshAccessToken: neverCalled }),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'INTEGRATION_NOT_FOUND',
  );
});

test('a missing stored refresh token asks for a reconnect instead of calling Atlassian', async () => {
  const fake = fakePrisma({
    storedRefreshToken: null,
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });
  const refresh = recordingRefresh();

  await assert.rejects(
    withKey(() =>
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
        now: clock,
        refreshAccessToken: refresh.fn,
      }),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'CONFLUENCE_RECONNECT_REQUIRED',
  );

  assert.equal(refresh.calls.length, 0);
  assert.equal(fake.row().status, 'ERROR');
  assert.equal(fake.row().refreshClaimToken, null);
});

test('connectConfluence records the site, stores both tokens, and clears any stale claim', async () => {
  const fake = fakePrisma({
    integration: { status: 'ERROR', lastError: 'previously broken', refreshClaimToken: 'stale', refreshClaimedAt: NOW, refreshFailureCount: 4 },
    storedRefreshToken: null,
  });

  const result = await withKey(() =>
    connectConfluence(
      fake.client,
      { organisationId: ORG_ID, userId: 'user-9', code: 'auth-code-EEEE', redirectUri: 'https://api.example/cb' },
      {
        now: clock,
        exchangeAuthorizationCode: async () => tokens(),
        // Two sites: the first is chosen, and `siteCount` records that a
        // choice was made on the charity's behalf.
        listAccessibleResources: async () => [
          { id: 'site-9', url: 'https://charity.atlassian.net', name: 'Charity Wiki' },
          { id: 'site-10', url: 'https://charity-two.atlassian.net', name: 'Second Site' },
        ],
      },
    ),
  );

  assert.equal(result.integrationId, INTEGRATION_ID);
  assert.equal(result.siteUrl, 'https://charity.atlassian.net');

  const kinds = fake.credentialWrites.map(
    (write) => (write as { where: { integrationId_kind: { kind: string } } }).where.integrationId_kind.kind,
  );
  assert.deepEqual(kinds, ['refresh_token', 'access_token']);

  const row = fake.row();
  assert.equal(row.status, 'CONNECTED');
  assert.equal(row.lastError, null);
  assert.equal(row.refreshFailureCount, 0);
  assert.equal(row.refreshClaimToken, null);
  assert.equal(row.refreshClaimedAt, null);
  assert.equal(row.connectedById, 'user-9');
  assert.deepEqual(row.config, {
    siteId: 'site-9',
    siteUrl: 'https://charity.atlassian.net',
    siteName: 'Charity Wiki',
    siteCount: 2,
  });

  // The status flip is the LAST write, after both credentials exist.
  const last = fake.integrationWrites.at(-1) as { data: { status?: string } };
  assert.equal(last.data.status, 'CONNECTED');

  assert.equal(JSON.stringify(fake.integrationWrites).includes('auth-code-EEEE'), false);
});

test('connectConfluence does not advertise a connection before the credentials exist', async () => {
  const fake = fakePrisma({
    integration: { status: 'DISCONNECTED' },
    storedRefreshToken: null,
    failCredentialWriteFor: 'access_token',
  });

  await assert.rejects(
    withKey(() =>
      connectConfluence(
        fake.client,
        { organisationId: ORG_ID, userId: 'user-9', code: 'auth-code', redirectUri: 'https://api.example/cb' },
        {
          now: clock,
          exchangeAuthorizationCode: async () => tokens(),
          listAccessibleResources: async () => [
            { id: 'site-9', url: 'https://charity.atlassian.net', name: 'Charity Wiki' },
          ],
        },
      ),
    ),
  );

  assert.notEqual(fake.row().status, 'CONNECTED', 'a row with no usable credential must not read CONNECTED');
});

test('connectConfluence refuses an authorization that issued no refresh token', async () => {
  const fake = fakePrisma({ integration: null, storedRefreshToken: null });

  await assert.rejects(
    withKey(() =>
      connectConfluence(
        fake.client,
        { organisationId: ORG_ID, userId: 'user-9', code: 'auth-code', redirectUri: 'https://api.example/cb' },
        {
          now: clock,
          exchangeAuthorizationCode: async () => tokens({ refreshToken: { kind: 'unavailable' } }),
          listAccessibleResources: neverCalled,
        },
      ),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'CONFLUENCE_OFFLINE_ACCESS_NOT_GRANTED',
  );

  // Nothing was written: a connection that can never be refreshed is not
  // half-created.
  assert.equal(fake.integrationWrites.length, 0);
  assert.equal(fake.credentialWrites.length, 0);
});

/**
 * A `fetch` that never settles, exactly as undici can when a peer accepts the
 * connection and then says nothing. `AbortSignal.timeout`'s own timer is
 * unref'd, so the ref'd `setTimeout` here is what holds the event loop open —
 * and it doubles as the assertion that the deadline fires at all.
 */
function hangingFetch(): typeof globalThis.fetch {
  return ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('the deadline never fired')), 1_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(new Error('request aborted by deadline'));
      });
    })) as unknown as typeof globalThis.fetch;
}

test('the authorization-code exchange carries a deadline', async () => {
  // A human is standing in front of a browser tab for this one. Unbounded, a
  // stalled Atlassian holds them for undici's ~600s while the single-use code
  // expires underneath them, and the flow becomes unrecoverable.
  const fake = fakePrisma({ integration: null, storedRefreshToken: null });

  const exchange = async (_code: string, _redirectUri: string, oauth?: OAuthDeps) => {
    assert.ok(oauth?.fetch, 'the exchange must be handed a bounded fetch');
    await oauth.fetch('https://auth.atlassian.com/oauth/token', { method: 'POST' });
    throw new Error('the request should not have completed');
  };

  await assert.rejects(
    withKey(() =>
      connectConfluence(
        fake.client,
        { organisationId: ORG_ID, userId: 'user-9', code: 'auth-code', redirectUri: 'https://api.example/cb' },
        {
          now: clock,
          connectTimeoutMs: 5,
          exchangeAuthorizationCode: exchange as never,
          listAccessibleResources: neverCalled,
          oauth: { fetch: hangingFetch() },
        },
      ),
    ),
    /request aborted by deadline/,
  );

  // Nothing half-created on the way out.
  assert.equal(fake.integrationWrites.length, 0);
  assert.equal(fake.credentialWrites.length, 0);
});

test('the accessible-resources lookup carries the same deadline', async () => {
  // The second call is on the same live route, holds the same person, and is
  // made with an access token whose code has already been spent — so a stall
  // here is the more expensive of the two.
  const fake = fakePrisma({ integration: null, storedRefreshToken: null });

  const listSites = async (_accessToken: string, oauth?: OAuthDeps) => {
    assert.ok(oauth?.fetch, 'the site lookup must be handed a bounded fetch');
    await oauth.fetch('https://api.atlassian.com/oauth/token/accessible-resources');
    throw new Error('the request should not have completed');
  };

  await assert.rejects(
    withKey(() =>
      connectConfluence(
        fake.client,
        { organisationId: ORG_ID, userId: 'user-9', code: 'auth-code', redirectUri: 'https://api.example/cb' },
        {
          now: clock,
          connectTimeoutMs: 5,
          exchangeAuthorizationCode: async () => tokens(),
          listAccessibleResources: listSites as never,
          oauth: { fetch: hangingFetch() },
        },
      ),
    ),
    /request aborted by deadline/,
  );

  assert.equal(fake.integrationWrites.length, 0);
  assert.equal(fake.credentialWrites.length, 0);
});

test('the production deadline defaults are the constants, not whatever a test injected', () => {
  // Both deadline tests above and the refresh one below inject their own
  // value, so hardcoding a ten-minute default in either call site would leave
  // every test green. The resolvers are the join between the constants — which
  // ARE pinned, by the assertions that follow — and the code that runs in
  // production, and this is the only thing that pins the join itself.
  assert.equal(resolveRefreshTimeoutMs({}), REFRESH_REQUEST_TIMEOUT_MS);
  assert.equal(resolveConnectTimeoutMs({}), CONNECT_REQUEST_TIMEOUT_MS);

  // An injected value still wins; that is what the deadline tests rely on.
  assert.equal(resolveRefreshTimeoutMs({ refreshTimeoutMs: 5 }), 5);
  assert.equal(resolveConnectTimeoutMs({ connectTimeoutMs: 5 }), 5);

  // The connect deadline is deliberately far shorter than the refresh one: a
  // refresh happens behind a background job or an already-rendered page, while
  // a connect holds a person in front of a browser tab.
  assert.ok(
    CONNECT_REQUEST_TIMEOUT_MS < REFRESH_REQUEST_TIMEOUT_MS,
    'a human waiting on a browser must not wait as long as a background refresh',
  );

  // And the whole connect path — both calls, worst case — has to leave most of
  // the authorization code's life intact for the administrator to retry inside.
  // `OAUTH_STATE_TTL_SECONDS` is that window: the state and the code expire
  // together, which is why the state TTL was chosen to match it.
  assert.ok(
    CONNECT_REQUEST_TIMEOUT_MS * 2 * 10 <= OAUTH_STATE_TTL_SECONDS * 1_000,
    'the code/state window must dominate the connect path by at least 10x',
  );
});

// ── precondition A: a reconnect landing mid-refresh ────────────────────────

const RECONNECTED_AT = new Date('2026-09-18T12:00:05.000Z');

/**
 * The charity administrator reconnecting Confluence, run to completion. The
 * tokens it puts on file are deliberately distinct from everything the
 * in-flight refresher is carrying, so "whose credentials survived?" has an
 * unambiguous answer.
 */
function reconnect(fake: ReturnType<typeof fakePrisma>): Promise<{ integrationId: string }> {
  return connectConfluence(
    fake.client,
    {
      organisationId: ORG_ID,
      userId: 'user-reconnecting',
      code: 'auth-code-reconnect',
      redirectUri: 'https://api.example/cb',
    },
    {
      now: () => RECONNECTED_AT,
      exchangeAuthorizationCode: async () =>
        tokens({
          accessToken: RECONNECT_ACCESS_TOKEN,
          refreshToken: { kind: 'issued', token: RECONNECT_REFRESH_TOKEN },
          expiresAt: new Date(RECONNECTED_AT.getTime() + 3_540_000),
        }),
      listAccessibleResources: async () => [
        { id: 'site-9', url: 'https://charity.atlassian.net', name: 'Charity Wiki' },
      ],
    },
  );
}

async function storedCredential(fake: ReturnType<typeof fakePrisma>, kind: string) {
  return withKey(() => loadIntegrationCredential(fake.client, { integrationId: INTEGRATION_ID, kind }));
}

test('a reconnect landing mid-refresh is not overwritten by the superseded refresher', async () => {
  // The interleave, in order: a refresher takes the claim and calls Atlassian;
  // the administrator reconnects while that call is still in flight, which
  // replaces both credentials and clears the claim; only then does Atlassian
  // answer the older refresh, with the PREVIOUS grant's rotation.
  //
  // Unfenced, that answer is persisted by `integrationId_kind` upsert and the
  // charity is left with a row reading CONNECTED against an authorisation it
  // has already replaced — no error anywhere.
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });

  const inFlight = defer<AtlassianTokens>();
  const refresh = recordingRefresh(async () => inFlight.promise);

  return withKey(async () => {
    const refresher = currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refresh.fn,
    });
    await flush();
    assert.deepEqual(refresh.calls, [STORED_REFRESH_TOKEN], 'the refresher must be in flight');
    assert.ok(fake.row().refreshClaimToken, 'and holding the claim');

    await reconnect(fake);
    assert.equal(await storedCredential(fake, 'refresh_token'), RECONNECT_REFRESH_TOKEN);
    assert.equal(await storedCredential(fake, 'access_token'), RECONNECT_ACCESS_TOKEN);

    inFlight.resolve(tokens());
    await assert.rejects(
      refresher,
      (error: unknown) => error instanceof AppError && error.code === 'CONFLUENCE_REFRESH_SUPERSEDED',
      'a refresher whose authorisation was replaced must fail rather than persist',
    );

    // The credentials behind the row are still the ones the charity just
    // authorised — not the previous grant's rotation.
    assert.equal(await storedCredential(fake, 'refresh_token'), RECONNECT_REFRESH_TOKEN);
    assert.equal(await storedCredential(fake, 'access_token'), RECONNECT_ACCESS_TOKEN);

    const row = fake.row();
    assert.equal(row.status, 'CONNECTED');
    assert.deepEqual(row.connectedAt, RECONNECTED_AT);
    assert.equal(row.connectedById, 'user-reconnecting');
    // And the superseded refresher diagnosed nothing on the way out: it never
    // held the fresh connection's claim, so none of its row writes matched.
    assert.equal(row.lastError, null);
    assert.equal(row.refreshFailureCount, 0);
    assert.equal(row.refreshClaimToken, null);
    assert.equal(row.refreshClaimedAt, null);
  });
});

test('a superseded refresher does not overwrite the new access token when Atlassian did not rotate', async () => {
  // `not_rotated` writes no refresh token at all, so the access-token store is
  // the only write left to fence. Fencing just the refresh-token persist would
  // still hand the charity the previous grant's access token.
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });

  const inFlight = defer<AtlassianTokens>();
  const refresh = recordingRefresh(async () => inFlight.promise);

  return withKey(async () => {
    const refresher = currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refresh.fn,
    });
    await flush();
    assert.equal(refresh.calls.length, 1);

    await reconnect(fake);

    inFlight.resolve(tokens({ refreshToken: { kind: 'not_rotated' } }));
    await assert.rejects(
      refresher,
      (error: unknown) => error instanceof AppError && error.code === 'CONFLUENCE_REFRESH_SUPERSEDED',
    );

    assert.equal(await storedCredential(fake, 'access_token'), RECONNECT_ACCESS_TOKEN);
    assert.equal(await storedCredential(fake, 'refresh_token'), RECONNECT_REFRESH_TOKEN);
  });
});

test('the superseded outcome does not page and carries no token', async () => {
  // It is a routine consequence of an administrator reconnecting, not the
  // unrecoverable persist failure that shares the same code path. Reporting it
  // as CONFLUENCE_REFRESH_TOKEN_PERSIST_FAILED would page an operator every
  // time a charity re-authorises while a publish job happens to be refreshing.
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });

  const inFlight = defer<AtlassianTokens>();
  const refresh = recordingRefresh(async () => inFlight.promise);

  return withKey(async () => {
    const refresher = currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
      now: clock,
      refreshAccessToken: refresh.fn,
    });
    await flush();
    await reconnect(fake);
    inFlight.resolve(tokens());

    await assert.rejects(refresher, (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'CONFLUENCE_REFRESH_SUPERSEDED');
      assert.equal(error.statusCode, 409, 'a reconnect racing a refresh must not page');
      const surfaced = JSON.stringify({
        message: error.message,
        details: error.details,
        cause: error.cause,
      });
      for (const secret of [
        STORED_REFRESH_TOKEN,
        ROTATED_REFRESH_TOKEN,
        FRESH_ACCESS_TOKEN,
        RECONNECT_REFRESH_TOKEN,
        RECONNECT_ACCESS_TOKEN,
      ]) {
        assert.equal(surfaced.includes(secret), false, `"${secret}" must never reach an error`);
      }
      return true;
    });
  });
});

test('a reconnect landing between the token load and the generation re-read is caught', async () => {
  // The narrow half of the fence, and the half a reading review slides past.
  // The fence value and the token being spent have to describe the SAME
  // authorisation. Here the refresher loads the previous grant's refresh token
  // and the administrator reconnects the instant after that read returns — so a
  // generation read taken only afterwards hands back the NEW value, the fence
  // matches, and the refresher overwrites the freshly connected credentials.
  // That is precondition A reopened through a narrower window.
  //
  // Reading the generation either side of the load and requiring the two to
  // agree is what closes it, and it closes it before anything has been spent.
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
  });
  const refresh = recordingRefresh();

  // Credential reads 1 and 2 are the pre-claim and post-claim access-token
  // expiry checks; read 3 is the stored refresh token itself. The hook fires
  // after the row has been snapshotted, which is precisely "another worker's
  // write landed after this read returned".
  fake.hooks.onCredentialRead = async (call) => {
    if (call === 3) await reconnect(fake);
  };

  await assert.rejects(
    withKey(() =>
      currentAccessToken(fake.client, { integrationId: INTEGRATION_ID }, {
        now: clock,
        refreshAccessToken: refresh.fn,
      }),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'CONFLUENCE_REFRESH_SUPERSEDED',
  );

  assert.equal(refresh.calls.length, 0, 'the disagreement must be caught before a token is spent');
  assert.equal(await storedCredential(fake, 'refresh_token'), RECONNECT_REFRESH_TOKEN);
  assert.equal(await storedCredential(fake, 'access_token'), RECONNECT_ACCESS_TOKEN);
});

test('connectConfluence stamps the new authorisation before it writes either credential', async () => {
  // Not a stylistic ordering: it is the precondition the refresh fence stands
  // on. `authorisationFencedClient` excludes an in-flight refresher by matching
  // the OLD `connectedAt`, so the new value has to be committed *before* the
  // credentials it is protecting. Move it into the final status write — the
  // natural next edit, since the comment there already argues that `status`
  // must not be advertised early and the status route exposes `connectedAt`
  // too — and the reconnect's credential writes land inside the window where
  // the old fence still matches.
  const fake = fakePrisma({ integration: { status: 'ERROR' }, storedRefreshToken: null });

  await withKey(() => reconnect(fake));

  const stamped = fake.writeLog.findIndex(
    (entry) => entry.table === 'integration' && entry.data.connectedAt instanceof Date,
  );
  const firstCredential = fake.writeLog.findIndex((entry) => entry.table === 'credential');

  assert.notEqual(stamped, -1, 'the reconnect must record when it connected');
  assert.notEqual(firstCredential, -1, 'the reconnect must write credentials');
  assert.ok(
    stamped < firstCredential,
    'connectedAt must be committed before the credential writes it fences an in-flight refresher away from',
  );
});

test('a charity whose refresh is stuck can still reconnect while the claim is held', async () => {
  // The other half of the choice. Refusing a reconnect while a claim is live
  // would leave a charity whose refresh is wedged unable to fix it from the
  // one screen that exists for fixing it. Fencing the credential write instead
  // means the reconnect always wins, immediately.
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() - 1_000) },
    integration: {
      status: 'ERROR',
      lastError: 'previously broken',
      refreshFailureCount: 7,
      refreshClaimToken: 'held-by-a-wedged-worker',
      refreshClaimedAt: new Date(NOW.getTime() - 1_000),
    },
  });

  await withKey(() => reconnect(fake));

  const row = fake.row();
  assert.equal(row.status, 'CONNECTED');
  assert.equal(row.lastError, null);
  assert.equal(row.refreshFailureCount, 0);
  assert.equal(row.refreshClaimToken, null, 'a live claim must not block recovery');
  assert.equal(row.refreshClaimedAt, null);
  assert.equal(await storedCredential(fake, 'refresh_token'), RECONNECT_REFRESH_TOKEN);
  assert.equal(await storedCredential(fake, 'access_token'), RECONNECT_ACCESS_TOKEN);
});

// ── precondition B: no access token by bare integration id ─────────────────

test("currentAccessTokenForOrganisation reaches only the asking organisation's integration", async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() + 60_000) },
    others: [
      {
        organisationId: OTHER_ORG_ID,
        integrationId: OTHER_INTEGRATION_ID,
        accessToken: { plaintext: OTHER_ORG_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() + 60_000) },
      },
    ],
  });

  const mine = await withKey(() =>
    currentAccessTokenForOrganisation(fake.client, { organisationId: ORG_ID }, {
      now: clock,
      refreshAccessToken: neverCalled,
    }),
  );
  assert.equal(mine, STORED_ACCESS_TOKEN);

  const theirs = await withKey(() =>
    currentAccessTokenForOrganisation(fake.client, { organisationId: OTHER_ORG_ID }, {
      now: clock,
      refreshAccessToken: neverCalled,
    }),
  );
  assert.equal(theirs, OTHER_ORG_ACCESS_TOKEN);
  assert.notEqual(theirs, STORED_ACCESS_TOKEN);
});

test('currentAccessTokenForOrganisation refuses an organisation with no Confluence integration', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() + 60_000) },
  });

  await assert.rejects(
    withKey(() =>
      currentAccessTokenForOrganisation(fake.client, { organisationId: 'org-with-no-integration' }, {
        now: clock,
        refreshAccessToken: neverCalled,
      }),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'INTEGRATION_NOT_FOUND',
  );

  assert.equal(fake.integrationWrites.length, 0);
  assert.equal(fake.credentialWrites.length, 0);
});

test('nothing outside a route may take a Confluence access token by bare integration id', () => {
  // The credential layer binds but does not authorize: an `integrationId`
  // belonging to another charity yields a context derived from THAT charity's
  // row and decrypts successfully (see the banner in
  // integration-credential.service.ts). The route layer is safe because no
  // route accepts an id from a request. This phase introduces the first
  // non-route caller, and a comment would not have stopped it — so the rule is
  // this assertion.
  //
  // Be honest about its reach. It is a source scan, and it catches what a
  // person would actually write: a direct call, and an import of the bare
  // identifier. It does not catch a renaming import used indirectly, a dynamic
  // `ns['currentAccessToken']`, or anything reached through a variable. It
  // stops the accident, not an author who has decided to get around it.
  //
  // The `routes/` exemption is a path prefix, so it also exempts a helper
  // placed under `routes/` that takes an `integrationId` from a request body.
  // "No route accepts an id from a request" therefore remains a convention of
  // that directory, defended by review, not by this test.
  const sourceRoot = join(process.cwd(), 'src');
  const offenders: string[] = [];

  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;

      const name = relativePath(sourceRoot, path).split(sep).join('/');
      // The definition itself; the route layer, which derives every id from
      // `organisationId_provider` on the authenticated user; and the tests.
      if (name === 'services/confluence-connection.service.ts') continue;
      if (name.startsWith('routes/') || name.startsWith('tests/')) continue;

      const source = readFileSync(path, 'utf8');

      // `currentAccessTokenForOrganisation(` does not contain this literal.
      const calls = source.includes('currentAccessToken(');

      // And an import of the bare identifier, whatever is done with it after.
      // `\bcurrentAccessToken\b` cannot match inside
      // `currentAccessTokenForOrganisation`, because the character after
      // "Token" is a word character and the boundary fails.
      const importsBareForm = (
        source.match(/import\s*\{[^}]*\}\s*from\s*'[^']*confluence-connection\.service\.js'/g) ?? []
      ).some((clause) => /\bcurrentAccessToken\b/.test(clause));

      if (calls || importsBareForm) offenders.push(name);
    }
  };
  visit(sourceRoot);

  assert.deepEqual(
    offenders,
    [],
    'these files take a Confluence access token by bare integrationId; outside a route the ' +
      'only permitted entry point is currentAccessTokenForOrganisation',
  );

  // And the strong entry point exists and resolves the integration from the
  // unique pair rather than from anything it was handed. Read out of its own
  // body, not the whole file: `connectConfluence` keys on the same pair, so a
  // file-wide match would stay green with this function gutted.
  // Normalised, because the slice below keys on a line break and this repo is
  // developed on Windows: a CRLF working copy would otherwise find no end to
  // the function, silently widen the slice to the rest of the file, and fail
  // on a `where: { id:` belonging to something else entirely.
  const service = readFileSync(
    join(process.cwd(), 'src', 'services', 'confluence-connection.service.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const start = service.indexOf('export async function currentAccessTokenForOrganisation');
  assert.notEqual(start, -1, 'the organisation-scoped entry point must exist');
  const end = service.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'the entry point must be a top-level function this slice can end at');
  const body = service.slice(start, end);
  assert.match(body, /organisationId_provider: \{ organisationId, provider: PROVIDER \}/);
  assert.doesNotMatch(body, /where: \{ id:/, 'it must not look an integration up by id');
});

test('disconnectConfluence deletes every stored credential and marks the row disconnected', async () => {
  const fake = fakePrisma({
    storedAccessToken: { plaintext: STORED_ACCESS_TOKEN, expiresAt: new Date(NOW.getTime() + 60_000) },
    integration: { refreshClaimToken: 'held', refreshClaimedAt: NOW, refreshFailureCount: 3, lastError: 'boom' },
  });

  await withKey(() => disconnectConfluence(fake.client, { integrationId: INTEGRATION_ID }));

  assert.equal(fake.credentials.length, 0);
  const row = fake.row();
  assert.equal(row.status, 'DISCONNECTED');
  assert.equal(row.lastError, null);
  assert.equal(row.connectedAt, null);
  assert.equal(row.connectedById, null);
  assert.equal(row.refreshClaimToken, null);
  assert.equal(row.refreshClaimedAt, null);
  assert.equal(row.refreshFailureCount, 0);
  assert.equal(row.lastRefreshedAt, null);
});
