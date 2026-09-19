import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'owner-tenant-configuration-test-secret';

const { getTenantConfiguration, updateTenantConfiguration } = await import(
  '../services/owner-tenant-configuration.service.js'
);
const { createDocumentStorageProviderRegistry } = await import(
  '../services/document-storage-provider.js'
);

const OPERATOR = { id: 'op-1', email: 'operator@example.org' };

/** Supabase and local are generally available; Confluence is alpha. */
const registry = createDocumentStorageProviderRegistry([
  { id: 'supabase', stage: 'ga' },
  { id: 'local', stage: 'ga' },
  { id: 'confluence', stage: 'alpha' },
]);

type Row = {
  id: string;
  name: string;
  documentStorageProvider: string | null;
  documentStorageAlphaOptIn: boolean;
  updatedAt: Date;
  subscription: { plan: string; status: string } | null;
  integrations: Array<{
    status: string;
    connectedAt: Date | null;
    config: unknown;
    lastError: string | null;
  }>;
};

function prismaStub(initial: Partial<Row> = {}) {
  const row: Row = {
    id: 'org-1',
    name: 'Probe Charity',
    documentStorageProvider: null,
    documentStorageAlphaOptIn: false,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    subscription: { plan: 'ESSENTIALS', status: 'ACTIVE' },
    integrations: [],
    ...initial,
  };

  const audits: Array<Record<string, unknown>> = [];
  let subscriptionRows = row.subscription ? 1 : 0;

  const client = {
    organisation: {
      findUnique: async () => (row.id ? row : null),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(row, data);
        return row;
      },
    },
    subscription: {
      updateMany: async ({ data }: { data: { plan?: string } }) => {
        if (subscriptionRows === 0) return { count: 0 };
        if (row.subscription && data.plan) row.subscription.plan = data.plan;
        return { count: subscriptionRows };
      },
    },
    securityAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
    $queryRaw: async () => [
      {
        id: row.id,
        documentStorageProvider: row.documentStorageProvider,
        documentStorageAlphaOptIn: row.documentStorageAlphaOptIn,
      },
    ],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };

  return {
    row,
    audits,
    client,
    removeSubscription() {
      subscriptionRows = 0;
      row.subscription = null;
    },
  };
}

test('the configuration says what a null provider actually resolves to', async () => {
  // Read from the environment rather than assumed: this repository's own .env
  // sets the driver to local, so a test that hardcoded supabase would pass or
  // fail depending on whose machine it ran on.
  const original = process.env.DOCUMENT_STORAGE_DRIVER;
  try {
    for (const driver of ['supabase', 'local']) {
      process.env.DOCUMENT_STORAGE_DRIVER = driver;
      const { client } = prismaStub();
      const configuration = await getTenantConfiguration(client as never, 'org-1', registry);

      assert.equal(configuration.documentStorageProvider, null);
      assert.equal(
        configuration.deploymentDefaultProvider,
        driver,
        'an operator cannot judge "use the default" without being told what it is',
      );
      assert.deepEqual(
        configuration.availableProviders.map((p) => p.id).sort(),
        ['confluence', 'local', 'supabase'],
      );
    }
  } finally {
    if (original === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = original;
  }
});

test('a provider is marked with the stage it is at', async () => {
  const { client } = prismaStub();
  const configuration = await getTenantConfiguration(client as never, 'org-1', registry);

  const confluence = configuration.availableProviders.find((p) => p.id === 'confluence')!;
  assert.equal(confluence.stage, 'alpha');
});

test('changing the provider records who changed it, from what, and why', async () => {
  const { client, audits, row } = prismaStub();

  await updateTenantConfiguration(
    client as never,
    {
      tenantId: 'org-1',
      change: { documentStorageProvider: 'local' },
      reason: 'The charity asked to keep files on their own server',
      operator: OPERATOR,
    },
    registry,
  );

  assert.equal(row.documentStorageProvider, 'local');
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!['type'], 'ORGANISATION_CONFIGURATION_CHANGED');
  assert.equal(audits[0]!['actorKind'], 'SUPPORT');
  assert.equal(audits[0]!['actorLabel'], 'operator@example.org');
  assert.equal(audits[0]!['reason'], 'The charity asked to keep files on their own server');

  const context = audits[0]!['context'] as Record<string, unknown>;
  assert.equal(context['previousDocumentStorageProvider'], null);
  assert.equal(context['newDocumentStorageProvider'], 'local');
  assert.equal(context['operatorId'], 'op-1');
});

test('a change with no reason is refused before anything is written', async () => {
  const { client, row, audits } = prismaStub();

  await assert.rejects(
    () =>
      updateTenantConfiguration(
        client as never,
        {
          tenantId: 'org-1',
          change: { documentStorageProvider: 'local' },
          reason: '   ',
          operator: OPERATOR,
        },
        registry,
      ),
    /reason is required/i,
  );

  assert.equal(row.documentStorageProvider, null);
  assert.deepEqual(audits, []);
});

test('a request that changes nothing is refused rather than writing an empty audit row', async () => {
  const { client, audits } = prismaStub();

  await assert.rejects(
    () =>
      updateTenantConfiguration(
        client as never,
        { tenantId: 'org-1', change: {}, reason: 'Nothing in particular', operator: OPERATOR },
        registry,
      ),
    /No configuration change/,
  );

  assert.deepEqual(audits, []);
});

test('an unknown provider is refused by name', async () => {
  const { client } = prismaStub();

  await assert.rejects(
    () =>
      updateTenantConfiguration(
        client as never,
        {
          tenantId: 'org-1',
          change: { documentStorageProvider: 'dropbox' },
          reason: 'Trying something',
          operator: OPERATOR,
        },
        registry,
      ),
    /no document storage provider called "dropbox"/,
  );
});

test('an alpha provider is refused until the charity has opted in', async () => {
  const { client } = prismaStub();

  await assert.rejects(
    () =>
      updateTenantConfiguration(
        client as never,
        {
          tenantId: 'org-1',
          change: { documentStorageProvider: 'confluence' },
          reason: 'They asked for Confluence',
          operator: OPERATOR,
        },
        registry,
      ),
    /decision to take with them rather than for them/,
  );
});

test('opting in and choosing an alpha provider in one request is allowed', async () => {
  // The opt-in that applies is the one the change leaves behind, not the one it
  // started with. Judging it the other way would make this coherent request
  // impossible and force an operator to save twice.
  const { client, row } = prismaStub();

  await updateTenantConfiguration(
    client as never,
    {
      tenantId: 'org-1',
      change: { documentStorageProvider: 'confluence', documentStorageAlphaOptIn: true },
      reason: 'They agreed to the alpha terms in writing',
      operator: OPERATOR,
    },
    registry,
  );

  assert.equal(row.documentStorageProvider, 'confluence');
  assert.equal(row.documentStorageAlphaOptIn, true);
});

test('withdrawing the opt-in while an alpha provider is selected is refused', async () => {
  // Otherwise the charity is left on a provider it is no longer allowed to use,
  // and finds out on its next upload.
  const { client } = prismaStub({
    documentStorageProvider: 'confluence',
    documentStorageAlphaOptIn: true,
  });

  await assert.rejects(
    () =>
      updateTenantConfiguration(
        client as never,
        {
          tenantId: 'org-1',
          change: { documentStorageAlphaOptIn: false },
          reason: 'Tidying up',
          operator: OPERATOR,
        },
        registry,
      ),
    /Move the charity to a stable provider first|stable provider before withdrawing/,
  );
});

test('the plan can be changed, and the change is audited', async () => {
  const { client, row, audits } = prismaStub();

  await updateTenantConfiguration(
    client as never,
    {
      tenantId: 'org-1',
      change: { plan: 'COMPLETE' },
      reason: 'Upgraded as agreed',
      operator: OPERATOR,
    },
    registry,
  );

  assert.equal(row.subscription!.plan, 'COMPLETE');
  assert.equal((audits[0]!['context'] as Record<string, unknown>)['newPlan'], 'COMPLETE');
});

test('changing the plan of a charity with no subscription says so', async () => {
  const stub = prismaStub();
  stub.removeSubscription();

  await assert.rejects(
    () =>
      updateTenantConfiguration(
        stub.client as never,
        {
          tenantId: 'org-1',
          change: { plan: 'COMPLETE' },
          reason: 'Upgrade',
          operator: OPERATOR,
        },
        registry,
      ),
    /no subscription record/,
  );
});

test('null is a value, meaning follow the deployment default', async () => {
  const { client, row, audits } = prismaStub({ documentStorageProvider: 'local' });

  await updateTenantConfiguration(
    client as never,
    {
      tenantId: 'org-1',
      change: { documentStorageProvider: null },
      reason: 'Back to the platform default',
      operator: OPERATOR,
    },
    registry,
  );

  assert.equal(row.documentStorageProvider, null);
  assert.equal(
    (audits[0]!['context'] as Record<string, unknown>)['newDocumentStorageProvider'],
    null,
  );
});

test('a Confluence connection is reported but not settable from here', async () => {
  const { client } = prismaStub({
    integrations: [
      {
        status: 'CONNECTED',
        connectedAt: new Date('2026-02-01T00:00:00.000Z'),
        config: { spaceKey: 'GOV' },
        lastError: null,
      },
    ],
  });

  const configuration = await getTenantConfiguration(client as never, 'org-1', registry);

  assert.equal(configuration.confluence?.status, 'CONNECTED');
  assert.equal(configuration.confluence?.spaceKey, 'GOV');
});

test('a charity that does not exist is a 404, not an empty configuration', async () => {
  const client = {
    organisation: { findUnique: async () => null },
  };

  await assert.rejects(
    () => getTenantConfiguration(client as never, 'nope', registry),
    /not found/i,
  );
});
