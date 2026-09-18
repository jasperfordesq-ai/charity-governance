import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { AtlassianTokens } from '../services/atlassian-oauth.js';
import {
  REFRESH_CLAIM_STALE_AFTER_MS,
  connectConfluence,
  currentAccessToken,
  disconnectConfluence,
  type ConfluenceConnectionClient,
} from '../services/confluence-connection.service.js';
import { integrationKeyFingerprint, sealIntegrationSecret } from '../services/integration-crypto.js';
import { AppError } from '../utils/errors.js';

const KEY = randomBytes(32);
const KEY_FINGERPRINT = integrationKeyFingerprint(KEY);

const ORG_ID = 'org-a';
const INTEGRATION_ID = 'int-1';
const PROVIDER = 'CONFLUENCE';

// Every token literal the tests plant. Nothing in this list may ever appear in
// an OrganisationIntegration write, an IntegrationCredential write, or an
// error surfaced out of the service.
const STORED_REFRESH_TOKEN = 'stored-refresh-token-AAAA';
const ROTATED_REFRESH_TOKEN = 'rotated-refresh-token-BBBB';
const STORED_ACCESS_TOKEN = 'stored-access-token-CCCC';
const FRESH_ACCESS_TOKEN = 'fresh-access-token-DDDD';

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

type FakeOptions = {
  integration?: Partial<IntegrationRow> | null;
  storedRefreshToken?: string | null;
  storedAccessToken?: { plaintext: string; expiresAt: Date | null } | null;
  /** Make the sealed-credential write for this kind throw, standing in for a failed write. */
  failCredentialWriteFor?: string;
};

function fakePrisma(options: FakeOptions = {}) {
  const {
    integration = {},
    storedRefreshToken = STORED_REFRESH_TOKEN,
    storedAccessToken = null,
    failCredentialWriteFor,
  } = options;

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
  const sealFor = (kind: string, plaintext: string) =>
    sealIntegrationSecret(plaintext, KEY, 1, { organisationId: ORG_ID, provider: PROVIDER, kind });

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

  const findIntegration = (id: string) => integrations.find((row) => row.id === id) ?? null;
  const findCredential = (integrationId: string, kind: string) =>
    credentials.find((row) => row.integrationId === integrationId && row.kind === kind) ?? null;

  const delegates = {
    organisationIntegration: {
      findUnique: async (args: { where: { id?: string } }) => {
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
        return row === null ? null : { ...row };
      },
      upsert: async (args: {
        where: { integrationId_kind: { integrationId: string; kind: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { integrationId, kind } = args.where.integrationId_kind;
        if (failCredentialWriteFor === kind) {
          throw new Error(`fake prisma: credential write for "${kind}" failed`);
        }
        credentialWrites.push(args);
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

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
        listAccessibleResources: async () => [
          { id: 'site-9', url: 'https://charity.atlassian.net', name: 'Charity Wiki' },
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
  assert.deepEqual(row.config, { siteId: 'site-9', siteUrl: 'https://charity.atlassian.net', siteName: 'Charity Wiki' });

  assert.equal(JSON.stringify(fake.integrationWrites).includes('auth-code-EEEE'), false);
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
