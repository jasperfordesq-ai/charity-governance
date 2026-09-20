import assert from 'node:assert/strict';
import test from 'node:test';
import { getTenantIntegrationHealth } from '../services/owner-integration-health.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CONNECTED_AT = new Date('2026-06-01T09:00:00.000Z');

type Row = Record<string, unknown>;

function fakePrisma(integration: Row | null, publications: Row[] = []) {
  return {
    organisationIntegration: {
      async findUnique() {
        return integration;
      },
    },
    documentPublication: {
      async groupBy(args: { by: string[] }) {
        const field = args.by[0];
        const counts = new Map<unknown, number>();
        for (const row of publications) {
          const key = row[field] ?? null;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts.entries()].map(([value, count]) => ({
          [field]: value,
          _count: { _all: count },
        }));
      },
    },
  } as never;
}

function integrationRow(overrides: Row = {}): Row {
  return {
    status: 'CONNECTED',
    connectedAt: CONNECTED_AT,
    lastError: null,
    config: { siteId: 'site-1', siteUrl: 'https://charity.atlassian.net', siteName: 'Charity' },
    publishSpaceKey: 'GOV',
    publishSpaceName: 'Governance',
    grantedScopes: ['read:page:confluence', 'write:page:confluence'],
    lastRefreshedAt: new Date('2026-09-01T09:00:00.000Z'),
    lastReconcileAt: new Date('2026-09-20T09:00:00.000Z'),
    lastReconcileOutcome: 'OK',
    dormancyNoticedAt: null,
    declaredPlan: 'Premium',
    declaredResidency: 'EU (Ireland)',
    declaredAt: new Date('2026-09-02T09:00:00.000Z'),
    ...overrides,
  };
}

test('a charity that has never connected reads as no integration, not an empty one', async () => {
  const health = await getTenantIntegrationHealth(fakePrisma(null), 'org-1');

  // Rendering a zeroed panel for this would have an operator hunting a fault in
  // a charity that simply does not use the feature.
  assert.equal(health, null);
});

test('the missing delete scopes are named, because CONNECTED does not say so', async () => {
  const health = await getTenantIntegrationHealth(fakePrisma(integrationRow()), 'org-1');

  assert.equal(health?.status, 'CONNECTED');
  // The single most common cause of an integration that looks healthy and
  // cannot erase: authorised before the delete scopes were added.
  assert.deepEqual(health?.missingScopes, ['delete:page:confluence', 'delete:attachment:confluence']);
});

test('a connection granted the delete scopes reports nothing missing', async () => {
  const health = await getTenantIntegrationHealth(
    fakePrisma(
      integrationRow({
        grantedScopes: ['read:page:confluence', 'delete:page:confluence', 'delete:attachment:confluence'],
      }),
    ),
    'org-1',
  );

  assert.deepEqual(health?.missingScopes, []);
});

test('publication and remote-state counts are reported separately', async () => {
  const health = await getTenantIntegrationHealth(
    fakePrisma(integrationRow(), [
      { state: 'PROCESSED', remoteState: 'VISIBLE' },
      { state: 'PROCESSED', remoteState: 'VISIBLE' },
      { state: 'PROCESSED', remoteState: 'TRASHED' },
      { state: 'PENDING', remoteState: null },
      { state: 'DEAD_LETTER', remoteState: 'UNKNOWN' },
      { state: 'RETIRED', remoteState: 'GONE' },
    ]),
    'org-1',
  );

  assert.deepEqual(health?.publications, { pending: 1, processed: 3, deadLettered: 1, retired: 1 });
  assert.deepEqual(health?.remoteStates, {
    visible: 2,
    archived: 0,
    trashed: 1,
    gone: 1,
    unknown: 1,
    // Counted apart from UNKNOWN on purpose: never checked means the reconcile
    // job has not reached it, UNKNOWN means the site refused to say. An
    // operator reading "1 unknown" would chase a permissions problem that does
    // not exist if the two were merged.
    neverChecked: 1,
  });
});

test('the expiry date shown is the one the dormancy sweep would act on', async () => {
  const lastRefreshedAt = new Date('2026-09-01T09:00:00.000Z');
  const health = await getTenantIntegrationHealth(
    fakePrisma(integrationRow({ lastRefreshedAt })),
    'org-1',
  );

  assert.equal(
    health?.authorisationExpiresAt,
    new Date(lastRefreshedAt.getTime() + 90 * DAY_MS).toISOString(),
    'a second opinion about the expiry date would be worse than none',
  );
});

test('a tenant that has never refreshed is aged from its grant, not shown as ageless', async () => {
  const health = await getTenantIntegrationHealth(
    fakePrisma(integrationRow({ lastRefreshedAt: null })),
    'org-1',
  );

  assert.equal(
    health?.authorisationExpiresAt,
    new Date(CONNECTED_AT.getTime() + 90 * DAY_MS).toISOString(),
  );
});

test('a disconnected integration runs no expiry clock', async () => {
  const health = await getTenantIntegrationHealth(
    fakePrisma(integrationRow({ status: 'DISCONNECTED' })),
    'org-1',
  );

  // There is no authorisation left to lapse, and printing a future date beside
  // a disconnected integration would read as though one were still standing.
  assert.equal(health?.authorisationExpiresAt, null);
});

test('the declared residency travels with its disclaimer', async () => {
  const health = await getTenantIntegrationHealth(fakePrisma(integrationRow()), 'org-1');

  assert.equal(health?.declaredResidency, 'EU (Ireland)');
  // An operator reading "EU (Ireland)" must understand they are reading a
  // charity administrator's claim, not something CharityPilot established.
  assert.equal(health?.residencyControlledByCharityPilot, false);
});

test('the health response carries no credential material, by exact key set', async () => {
  const health = await getTenantIntegrationHealth(fakePrisma(integrationRow()), 'org-1');

  // An exact allow-list rather than a substring scan: this response is
  // assembled from an OrganisationIntegration row that also holds
  // `refreshClaimToken`, and a widening that pulled the whole row through would
  // pass a "does it contain the word token" test only by luck.
  assert.deepEqual(Object.keys(health ?? {}).sort(), [
    'authorisationExpiresAt',
    'authorisationLapseNoticedAt',
    'connectedAt',
    'declaredAt',
    'declaredPlan',
    'declaredResidency',
    'grantedScopes',
    'lastError',
    'lastReconcileAt',
    'lastReconcileOutcome',
    'lastRefreshedAt',
    'missingScopes',
    'provider',
    'publications',
    'remoteStates',
    'residencyControlledByCharityPilot',
    'siteName',
    'siteUrl',
    'spaceKey',
    'spaceName',
    'status',
  ]);

  const serialised = JSON.stringify(health).toLowerCase();
  for (const forbidden of ['refreshclaim', 'sealed', 'ciphertext', 'secret', 'bearer']) {
    assert.ok(!serialised.includes(forbidden), `the health view leaked ${forbidden}`);
  }
});
