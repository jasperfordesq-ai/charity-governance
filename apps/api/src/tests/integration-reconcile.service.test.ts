import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATLASSIAN_REFRESH_INACTIVITY_EXPIRY_MS,
  INTEGRATION_DORMANCY_WARN_AFTER_MS,
  listTenantsForReconcile,
  recordTenantReconcileOutcome,
  sweepDormantIntegrations,
} from '../services/integration-reconcile.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-21T00:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

type Row = Record<string, unknown>;

type Fake = {
  prisma: never;
  rows: Row[];
  writes: Array<{ where: Row; data: Row }>;
  findManyArgs: Array<Record<string, unknown>>;
};

function fakePrisma(rows: Row[]): Fake {
  const writes: Array<{ where: Row; data: Row }> = [];
  const findManyArgs: Array<Record<string, unknown>> = [];

  const prisma = {
    organisationIntegration: {
      async findMany(args: { where: Record<string, unknown>; take?: number }) {
        findManyArgs.push(args);
        const matching = rows.filter((row) =>
          Object.entries(args.where).every(([key, value]) => row[key] === value),
        );
        return args.take === undefined ? matching : matching.slice(0, args.take);
      },
      async updateMany(args: { where: Row; data: Row }) {
        writes.push(args);
        let count = 0;
        for (const row of rows) {
          const matches = Object.entries(args.where).every(([key, value]) =>
            value === null ? (row[key] ?? null) === null : row[key] === value,
          );
          if (!matches) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        return { count };
      },
    },
  } as never;

  return { prisma, rows, writes, findManyArgs };
}

function connectedRow(overrides: Row = {}): Row {
  return {
    id: 'int-1',
    organisationId: 'org-1',
    provider: 'CONFLUENCE',
    status: 'CONNECTED',
    config: { siteId: 'site-1' },
    connectedAt: daysAgo(200),
    lastRefreshedAt: daysAgo(1),
    lastReconcileOutcome: null,
    dormancyNoticedAt: null,
    lastReconcileAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// THE CANARY FOR THE RULING.
//
// The whole point of this module is that it does NOT keep an authorisation
// alive. `lastRefreshedAt` is the column Atlassian's inactivity clock follows,
// and the one a keepalive would move. If it ever appears in a write from this
// sweep, a keepalive has been reintroduced under another name.
// ---------------------------------------------------------------------------

test('the dormancy sweep never writes lastRefreshedAt, in any branch', async () => {
  const fake = fakePrisma([
    connectedRow({ id: 'fresh', lastRefreshedAt: daysAgo(1) }),
    connectedRow({ id: 'warning', organisationId: 'org-2', lastRefreshedAt: daysAgo(61) }),
    connectedRow({ id: 'expired', organisationId: 'org-3', lastRefreshedAt: daysAgo(91) }),
    connectedRow({
      id: 'recovered',
      organisationId: 'org-4',
      lastRefreshedAt: daysAgo(1),
      lastReconcileOutcome: 'EXPIRING_SOON',
      dormancyNoticedAt: daysAgo(10),
    }),
  ]);

  await sweepDormantIntegrations(fake.prisma, { now: NOW });

  assert.ok(fake.writes.length > 0, 'the sweep must have written something, or this proves nothing');
  for (const write of fake.writes) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(write.data, 'lastRefreshedAt'),
      `a dormancy sweep write touched lastRefreshedAt: ${JSON.stringify(write.data)}`,
    );
  }
  // And the values themselves are untouched, in case a write ever reached the
  // column by some route other than a literal key.
  assert.deepEqual(
    fake.rows.map((row) => (row.lastRefreshedAt as Date).toISOString()),
    [daysAgo(1), daysAgo(61), daysAgo(91), daysAgo(1)].map((date) => date.toISOString()),
  );
});

// ---------------------------------------------------------------------------
// The thresholds
// ---------------------------------------------------------------------------

test('a tenant used recently produces no notice at all', async () => {
  const fake = fakePrisma([connectedRow({ lastRefreshedAt: daysAgo(5) })]);

  const notices = await sweepDormantIntegrations(fake.prisma, { now: NOW });

  assert.deepEqual(notices, []);
  assert.deepEqual(fake.writes, [], 'a healthy tenant is not written to on every sweep');
});

test('past the warning threshold the charity is told, and told once', async () => {
  const fake = fakePrisma([connectedRow({ lastRefreshedAt: daysAgo(61) })]);

  const first = await sweepDormantIntegrations(fake.prisma, { now: NOW });
  assert.equal(first.length, 1);
  assert.equal(first[0].outcome, 'EXPIRING_SOON');
  assert.equal(first[0].organisationId, 'org-1');
  assert.equal(
    first[0].expiresAt.toISOString(),
    new Date(daysAgo(61).getTime() + ATLASSIAN_REFRESH_INACTIVITY_EXPIRY_MS).toISOString(),
    'the charity is told the date, not a number of days',
  );
  assert.equal(fake.rows[0].lastReconcileOutcome, 'EXPIRING_SOON');
  assert.notEqual(fake.rows[0].dormancyNoticedAt, null);

  // Six hours later, and for the next thirty days. Without the transition
  // guard this would be about 120 identical audit events.
  const second = await sweepDormantIntegrations(fake.prisma, {
    now: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
  });
  assert.deepEqual(second, [], 'the same warning must not be raised twice');
});

test('past the expiry the row is put into the state a revoked grant produces', async () => {
  const fake = fakePrisma([connectedRow({ lastRefreshedAt: daysAgo(91) })]);

  const notices = await sweepDormantIntegrations(fake.prisma, { now: NOW });

  assert.equal(notices[0].outcome, 'EXPIRED');
  assert.equal(fake.rows[0].status, 'ERROR', 'the next publish must fail as reconnect-required by design');
  assert.equal(fake.rows[0].lastError, 'CONFLUENCE_AUTHORISATION_EXPIRED');
});

test('crossing from warning to expiry raises a second, different notice', async () => {
  const fake = fakePrisma([
    connectedRow({ lastRefreshedAt: daysAgo(61), lastReconcileOutcome: 'EXPIRING_SOON', dormancyNoticedAt: daysAgo(1) }),
  ]);

  const notices = await sweepDormantIntegrations(fake.prisma, { now: new Date(NOW.getTime() + 31 * DAY_MS) });

  assert.equal(notices.length, 1);
  assert.equal(notices[0].outcome, 'EXPIRED', 'the lapse itself is a new fact, not a repeat of the warning');
});

test('a tenant that is used again has its notice cleared', async () => {
  const fake = fakePrisma([
    connectedRow({
      lastRefreshedAt: daysAgo(2),
      lastReconcileOutcome: 'EXPIRING_SOON',
      dormancyNoticedAt: daysAgo(40),
    }),
  ]);

  const notices = await sweepDormantIntegrations(fake.prisma, { now: NOW });

  assert.deepEqual(notices, [], 'recovering is not itself an event to report');
  assert.equal(fake.rows[0].dormancyNoticedAt, null);
  assert.equal(
    fake.rows[0].lastReconcileOutcome,
    null,
    'a stale EXPIRING_SOON would suppress the next genuine warning',
  );
});

test('a tenant that has never refreshed is aged from its grant, not treated as new', async () => {
  const fake = fakePrisma([connectedRow({ lastRefreshedAt: null, connectedAt: daysAgo(95) })]);

  const notices = await sweepDormantIntegrations(fake.prisma, { now: NOW });

  // The 90 days run from the grant. Falling back to `connectedAt` is what stops
  // a charity that connected and never used the integration looking eternally
  // young to this sweep.
  assert.equal(notices.length, 1);
  assert.equal(notices[0].outcome, 'EXPIRED');
});

test('a row with neither timestamp is left alone rather than guessed at', async () => {
  const fake = fakePrisma([connectedRow({ lastRefreshedAt: null, connectedAt: null })]);

  const notices = await sweepDormantIntegrations(fake.prisma, { now: NOW });

  assert.deepEqual(notices, []);
  assert.deepEqual(fake.writes, [], 'warning about an expiry computed from a date we do not have is worse than silence');
});

test('the sweep only considers connected Confluence integrations', async () => {
  const fake = fakePrisma([connectedRow({ lastRefreshedAt: daysAgo(200) })]);

  await sweepDormantIntegrations(fake.prisma, { now: NOW });

  assert.deepEqual(fake.findManyArgs[0].where, { provider: 'CONFLUENCE', status: 'CONNECTED' });
});

test('the warning window leaves time to act', () => {
  const noticePeriodMs = ATLASSIAN_REFRESH_INACTIVITY_EXPIRY_MS - INTEGRATION_DORMANCY_WARN_AFTER_MS;
  // Reconnecting needs an Atlassian administrator, who at a small charity may
  // be a volunteer. A window measured in days rather than weeks would be a
  // notice in name only.
  assert.ok(noticePeriodMs >= 28 * DAY_MS, 'at least four weeks of notice');
});

// ---------------------------------------------------------------------------
// Tenant listing and outcome recording
// ---------------------------------------------------------------------------

test('tenants are listed oldest-visit-first with NULLS FIRST', async () => {
  const fake = fakePrisma([connectedRow()]);

  const tenants = await listTenantsForReconcile(fake.prisma, 10);

  assert.deepEqual(tenants, [{ integrationId: 'int-1', organisationId: 'org-1', siteId: 'site-1' }]);
  // PostgreSQL's default for ASC is NULLS LAST, which would put every
  // never-reconciled tenant at the back of a queue that `take` truncates — so
  // a new charity could wait indefinitely behind ones already being visited.
  assert.deepEqual(fake.findManyArgs[0].orderBy, [{ lastReconcileAt: { sort: 'asc', nulls: 'first' } }]);
  assert.equal(fake.findManyArgs[0].take, 10);
});

test('a tenant with no site id in its config is listed with a null site', async () => {
  const fake = fakePrisma([connectedRow({ config: {} })]);

  const tenants = await listTenantsForReconcile(fake.prisma, 10);

  // Listed rather than filtered out: the reconciler records
  // SITE_NOT_ACCESSIBLE for it, which is a visible state an operator can act
  // on. Dropping it here would make it invisible instead.
  assert.equal(tenants[0].siteId, null);
});

test('recording an outcome touches only the two reconcile columns', async () => {
  const fake = fakePrisma([connectedRow()]);

  await recordTenantReconcileOutcome(fake.prisma, {
    integrationId: 'int-1',
    outcome: 'FORBIDDEN',
    at: NOW,
  });

  assert.equal(fake.writes.length, 1);
  // It is called after a visit that may have failed, so it must not be capable
  // of disturbing the connection state it is reporting on.
  assert.deepEqual(Object.keys(fake.writes[0].data).sort(), ['lastReconcileAt', 'lastReconcileOutcome']);
  assert.deepEqual(fake.writes[0].where, { id: 'int-1' });
});
