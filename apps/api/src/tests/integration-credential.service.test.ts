import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  countCredentialsAwaitingRotation,
  loadIntegrationCredential,
  storeIntegrationCredential,
} from '../services/integration-credential.service.js';
import { sealIntegrationSecret } from '../services/integration-crypto.js';
import { AppError } from '../utils/errors.js';

const key = randomBytes(32);

// Always awaits `run()` before restoring the environment: a non-async version
// would restore INTEGRATION_ENCRYPTION_KEY while an async body was still
// running, and these tests run under the suite's default concurrency.
async function withKey<T>(run: () => T | Promise<T>): Promise<T> {
  const previous = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = key.toString('hex');
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
    else process.env.INTEGRATION_ENCRYPTION_KEY = previous;
  }
}

type FakeOptions = {
  credential?: unknown;
  integration?: { organisationId: string; provider: string } | null;
  generation?: number | null;
};

function fakePrisma(options: FakeOptions = {}) {
  const {
    credential = null,
    integration = { organisationId: 'org-a', provider: 'CONFLUENCE' },
    generation = 3,
  } = options;

  const upserts: unknown[] = [];
  const counts: unknown[] = [];

  return {
    upserts,
    counts,
    client: {
      organisationIntegration: {
        findUnique: async () => integration,
      },
      integrationSecretControl: {
        findUnique: async () => (generation === null ? null : { id: 1, generation }),
      },
      integrationCredential: {
        upsert: async (args: unknown) => {
          upserts.push(args);
          return {};
        },
        findUnique: async () => credential,
        count: async (args: unknown) => {
          counts.push(args);
          return 2;
        },
      },
    },
  };
}

test('storing a credential persists a sealed envelope and never the plaintext', async () => {
  const { client, upserts } = fakePrisma();

  await withKey(() =>
    storeIntegrationCredential(client as never, {
      integrationId: 'int-1',
      kind: 'refresh_token',
      plaintext: 'atlassian-refresh-token',
    }),
  );

  assert.equal(upserts.length, 1);
  const serialised = JSON.stringify(upserts[0]);
  assert.equal(serialised.includes('atlassian-refresh-token'), false);
  assert.equal(serialised.includes('"generation":3'), true);
});

test('loading a credential opens the envelope back to the original secret', async () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 3, {
    organisationId: 'org-a',
    provider: 'CONFLUENCE',
    kind: 'refresh_token',
  });
  const { client } = fakePrisma({ credential: { sealed, generation: 3 } });

  const loaded = await withKey(() =>
    loadIntegrationCredential(client as never, { integrationId: 'int-1', kind: 'refresh_token' }),
  );
  assert.equal(loaded, 'atlassian-refresh-token');
});

test('a missing credential loads as null rather than throwing', async () => {
  const { client } = fakePrisma({ credential: null });

  const loaded = await withKey(() =>
    loadIntegrationCredential(client as never, { integrationId: 'int-1', kind: 'refresh_token' }),
  );
  assert.equal(loaded, null);
});

test('rows sealed under an older generation are countable without opening them', async () => {
  const { client, counts } = fakePrisma();

  assert.equal(await countCredentialsAwaitingRotation(client as never, 3), 2);
  assert.deepEqual(counts, [{ where: { generation: { lt: 3 } } }]);
});

test('with no control row present, credentials seal under generation 1', async () => {
  const { client, upserts } = fakePrisma({ generation: null });

  await withKey(() =>
    storeIntegrationCredential(client as never, {
      integrationId: 'int-1',
      kind: 'refresh_token',
      plaintext: 'atlassian-refresh-token',
    }),
  );

  assert.equal(upserts.length, 1);
  assert.equal(JSON.stringify(upserts[0]).includes('"generation":1'), true);
});

// The regression test for the vulnerability the context binding exists to
// prevent. The envelope below is produced by the service itself under
// organisation A, then handed back to the service while the *database* says
// the owning integration belongs to organisation B — exactly what a row
// copied between tenants looks like. Nothing else differs: same key, same
// generation, same kind. If the binding were removed from integration-crypto,
// this would resolve to 'org-a-refresh-token' instead of rejecting.
test('a credential sealed under one integration cannot be opened as another tenant’s', async () => {
  const organisationA = fakePrisma({ integration: { organisationId: 'org-a', provider: 'CONFLUENCE' } });

  await withKey(() =>
    storeIntegrationCredential(organisationA.client as never, {
      integrationId: 'int-a',
      kind: 'refresh_token',
      plaintext: 'org-a-refresh-token',
    }),
  );

  const stolen = (organisationA.upserts[0] as { create: { sealed: unknown; generation: number } }).create;

  // Sanity check: the very same envelope opens perfectly for its real owner,
  // so a rejection below can only be the tenant binding and not a broken row.
  const rightfulOwner = fakePrisma({
    integration: { organisationId: 'org-a', provider: 'CONFLUENCE' },
    credential: { sealed: stolen.sealed, generation: stolen.generation },
  });
  assert.equal(
    await withKey(() =>
      loadIntegrationCredential(rightfulOwner.client as never, {
        integrationId: 'int-a',
        kind: 'refresh_token',
      }),
    ),
    'org-a-refresh-token',
  );

  const organisationB = fakePrisma({
    integration: { organisationId: 'org-b', provider: 'CONFLUENCE' },
    credential: { sealed: stolen.sealed, generation: stolen.generation },
  });

  await assert.rejects(
    () =>
      withKey(() =>
        loadIntegrationCredential(organisationB.client as never, {
          integrationId: 'int-b',
          kind: 'refresh_token',
        }),
      ),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INTEGRATION_SECRET_UNREADABLE');
      assert.equal(String((error as AppError).message).includes('org-a-refresh-token'), false);
      return true;
    },
  );
});

test('an integration that does not exist fails loudly instead of sealing under an empty identity', async () => {
  const { client, upserts } = fakePrisma({ integration: null });

  await assert.rejects(
    () =>
      withKey(() =>
        storeIntegrationCredential(client as never, {
          integrationId: 'int-missing',
          kind: 'refresh_token',
          plaintext: 'atlassian-refresh-token',
        }),
      ),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INTEGRATION_NOT_FOUND');
      return true;
    },
  );
  assert.equal(upserts.length, 0);

  await assert.rejects(
    () =>
      withKey(() =>
        loadIntegrationCredential(client as never, {
          integrationId: 'int-missing',
          kind: 'refresh_token',
        }),
      ),
    (error: unknown) => {
      assert.equal((error as AppError).code, 'INTEGRATION_NOT_FOUND');
      return true;
    },
  );
});
