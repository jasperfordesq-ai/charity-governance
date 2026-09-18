import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  countCredentialsAwaitingRotation,
  loadIntegrationCredential,
  storeIntegrationCredential,
} from '../services/integration-credential.service.js';
import { integrationKeyFingerprint, sealIntegrationSecret } from '../services/integration-crypto.js';
import { AppError } from '../utils/errors.js';

const key = randomBytes(32);
// A second, correctly-sized key: the likely operational mistake is a key from
// the wrong environment, not a malformed one.
const otherKey = randomBytes(32);

// Always awaits `run()` before restoring the environment: a non-async version
// would restore INTEGRATION_ENCRYPTION_KEY while an async body was still
// running, and these tests run under the suite's default concurrency.
async function withKeyBytes<T>(bytes: Buffer, run: () => T | Promise<T>): Promise<T> {
  const previous = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = bytes.toString('hex');
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
    else process.env.INTEGRATION_ENCRYPTION_KEY = previous;
  }
}

async function withKey<T>(run: () => T | Promise<T>): Promise<T> {
  return withKeyBytes(key, run);
}

type FakeOptions = {
  credential?: unknown;
  integration?: { organisationId: string; provider: string } | null;
  generation?: number | null;
  activeKeyFingerprint?: string | null;
};

function fakePrisma(options: FakeOptions = {}) {
  const {
    credential = null,
    integration = { organisationId: 'org-a', provider: 'CONFLUENCE' },
    generation = 3,
    // The normal starting state: an installation that has never recorded one.
    activeKeyFingerprint = null,
  } = options;

  const upserts: unknown[] = [];
  const counts: unknown[] = [];
  const controlWrites: unknown[] = [];

  return {
    upserts,
    counts,
    controlWrites,
    client: {
      organisationIntegration: {
        findUnique: async () => integration,
      },
      integrationSecretControl: {
        findUnique: async () =>
          generation === null ? null : { id: 1, generation, activeKeyFingerprint },
        upsert: async (args: unknown) => {
          controlWrites.push(args);
          return {};
        },
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

// The provider leg of the binding. `IntegrationProvider` has a single member
// today, so a cross-provider test has to name a provider that does not exist
// yet — which is exactly the point: the binding has to already hold on the day
// a second provider is added, not be discovered unprotected then. Everything
// else here is identical to the rightful load: same organisation, same kind,
// same key, same generation.
test('a credential sealed for one provider cannot be opened under another', async () => {
  const confluence = fakePrisma({ integration: { organisationId: 'org-a', provider: 'CONFLUENCE' } });

  await withKey(() =>
    storeIntegrationCredential(confluence.client as never, {
      integrationId: 'int-a',
      kind: 'refresh_token',
      plaintext: 'confluence-refresh-token',
    }),
  );

  const stored = (confluence.upserts[0] as { create: { sealed: unknown; generation: number } }).create;

  // Sanity check: the same envelope opens for the same provider, so the
  // rejection below can only be the provider leg and not a broken row.
  const sameProvider = fakePrisma({
    integration: { organisationId: 'org-a', provider: 'CONFLUENCE' },
    credential: { sealed: stored.sealed, generation: stored.generation },
  });
  assert.equal(
    await withKey(() =>
      loadIntegrationCredential(sameProvider.client as never, {
        integrationId: 'int-a',
        kind: 'refresh_token',
      }),
    ),
    'confluence-refresh-token',
  );

  const otherProvider = fakePrisma({
    integration: { organisationId: 'org-a', provider: 'SHAREPOINT' },
    credential: { sealed: stored.sealed, generation: stored.generation },
  });

  await assert.rejects(
    () =>
      withKey(() =>
        loadIntegrationCredential(otherProvider.client as never, {
          integrationId: 'int-a',
          kind: 'refresh_token',
        }),
      ),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INTEGRATION_SECRET_UNREADABLE');
      assert.equal(String((error as AppError).message).includes('confluence-refresh-token'), false);
      return true;
    },
  );
});

// The kind leg of the binding. The fake's `findUnique` ignores the composite
// key, so loading under a different `kind` hands the refresh-token envelope to
// an access-token context — what a mislabelled or copied row looks like.
test('a credential sealed under one kind cannot be opened under another', async () => {
  const sealer = fakePrisma();

  await withKey(() =>
    storeIntegrationCredential(sealer.client as never, {
      integrationId: 'int-a',
      kind: 'refresh_token',
      plaintext: 'refresh-token-value',
    }),
  );

  const stored = (sealer.upserts[0] as { create: { sealed: unknown; generation: number } }).create;

  const otherKind = fakePrisma({ credential: { sealed: stored.sealed, generation: stored.generation } });

  await assert.rejects(
    () =>
      withKey(() =>
        loadIntegrationCredential(otherKind.client as never, {
          integrationId: 'int-a',
          kind: 'access_token',
        }),
      ),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INTEGRATION_SECRET_UNREADABLE');
      assert.equal(String((error as AppError).message).includes('refresh-token-value'), false);
      return true;
    },
  );
});

// Asserting against the serialised upsert cannot tell the denormalised column
// from the envelope's own `generation` field — the substring matches either.
// Rotation counts on the column, so pin the column itself.
test('the denormalised generation column is written alongside the envelope, not merely implied by it', async () => {
  const { client, upserts } = fakePrisma({ generation: 3 });

  await withKey(() =>
    storeIntegrationCredential(client as never, {
      integrationId: 'int-1',
      kind: 'refresh_token',
      plaintext: 'atlassian-refresh-token',
    }),
  );

  const args = upserts[0] as {
    create: { generation: unknown; sealed: { generation: unknown } };
    update: { generation: unknown; sealed: { generation: unknown } };
  };
  assert.equal(args.create.generation, 3);
  assert.equal(args.update.generation, 3);
  // ...and it is a mirror of the envelope, not a second derivation.
  assert.equal(args.create.generation, args.create.sealed.generation);
  assert.equal(args.update.generation, args.update.sealed.generation);
});

// I-2. A correctly-sized key from the wrong environment used to land in the
// "credential corrupt" bucket for every charity at once, and the reasonable
// operator response to that — asking charities to reconnect — would upsert
// over recoverable envelopes.
test('a key that disagrees with the recorded fingerprint is reported as a wrong key, not a corrupt credential', async () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 3, {
    organisationId: 'org-a',
    provider: 'CONFLUENCE',
    kind: 'refresh_token',
  });
  const { client } = fakePrisma({
    credential: { sealed, generation: 3 },
    activeKeyFingerprint: integrationKeyFingerprint(key),
  });

  await assert.rejects(
    () =>
      withKeyBytes(otherKey, () =>
        loadIntegrationCredential(client as never, {
          integrationId: 'int-1',
          kind: 'refresh_token',
        }),
      ),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INTEGRATION_KEY_MISMATCH');
      const reported = `${(error as AppError).message} ${JSON.stringify(
        (error as AppError).details ?? null,
      )}`;
      // The fingerprint is safe to surface; the key material is not.
      assert.equal(reported.includes(integrationKeyFingerprint(key)), true);
      assert.equal(reported.includes(key.toString('hex')), false);
      assert.equal(reported.includes(key.toString('base64')), false);
      assert.equal(reported.includes(otherKey.toString('hex')), false);
      assert.equal(reported.includes(otherKey.toString('base64')), false);
      return true;
    },
  );
});

test('a key that disagrees with the recorded fingerprint cannot overwrite the envelopes it cannot read', async () => {
  const { client, upserts, controlWrites } = fakePrisma({
    activeKeyFingerprint: integrationKeyFingerprint(key),
  });

  await assert.rejects(
    () =>
      withKeyBytes(otherKey, () =>
        storeIntegrationCredential(client as never, {
          integrationId: 'int-1',
          kind: 'refresh_token',
          plaintext: 'reconnected-token',
        }),
      ),
    (error: unknown) => {
      assert.equal((error as AppError).code, 'INTEGRATION_KEY_MISMATCH');
      return true;
    },
  );
  assert.equal(upserts.length, 0);
  assert.equal(controlWrites.length, 0);
});

test('the recorded fingerprint is left alone when the configured key already matches it', async () => {
  const { client, upserts, controlWrites } = fakePrisma({
    activeKeyFingerprint: integrationKeyFingerprint(key),
  });

  await withKey(() =>
    storeIntegrationCredential(client as never, {
      integrationId: 'int-1',
      kind: 'refresh_token',
      plaintext: 'atlassian-refresh-token',
    }),
  );

  assert.equal(upserts.length, 1);
  assert.equal(controlWrites.length, 0);
});

test('an installation with no recorded fingerprint still works, and the first successful store records it', async () => {
  const { client, upserts, controlWrites } = fakePrisma({ activeKeyFingerprint: null });

  await withKey(() =>
    storeIntegrationCredential(client as never, {
      integrationId: 'int-1',
      kind: 'refresh_token',
      plaintext: 'atlassian-refresh-token',
    }),
  );

  assert.equal(upserts.length, 1);
  assert.equal(controlWrites.length, 1);
  const args = controlWrites[0] as {
    where: unknown;
    create: { activeKeyFingerprint: unknown };
    update: { activeKeyFingerprint: unknown };
  };
  assert.deepEqual(args.where, { id: 1 });
  assert.equal(args.create.activeKeyFingerprint, integrationKeyFingerprint(key));
  assert.equal(args.update.activeKeyFingerprint, integrationKeyFingerprint(key));
  assert.equal(JSON.stringify(controlWrites[0]).includes(key.toString('hex')), false);
});

test('loading against an unrecorded fingerprint neither fails nor records anything', async () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 3, {
    organisationId: 'org-a',
    provider: 'CONFLUENCE',
    kind: 'refresh_token',
  });
  const { client, controlWrites } = fakePrisma({
    credential: { sealed, generation: 3 },
    activeKeyFingerprint: null,
  });

  assert.equal(
    await withKey(() =>
      loadIntegrationCredential(client as never, { integrationId: 'int-1', kind: 'refresh_token' }),
    ),
    'atlassian-refresh-token',
  );
  assert.equal(controlWrites.length, 0);
});

// Minor: the one place a malformed row used to escape the module's error
// taxonomy as a raw TypeError.
test('a stored row whose sealed column is not an envelope stays inside the error taxonomy', async () => {
  const malformed: unknown[] = [null, 'not-an-envelope', 42, [], { iv: 'aaaa' }, { generation: '3' }];

  for (const sealed of malformed) {
    const { client } = fakePrisma({ credential: { sealed, generation: 3 } });

    await assert.rejects(
      () =>
        withKey(() =>
          loadIntegrationCredential(client as never, {
            integrationId: 'int-1',
            kind: 'refresh_token',
          }),
        ),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true, `not an AppError for ${JSON.stringify(sealed)}`);
        assert.equal((error as AppError).code, 'INTEGRATION_SECRET_MALFORMED');
        return true;
      },
    );
  }
});

// Minor: documented behaviour — a re-store is a fresh credential, so omitting
// the expiry clears whatever the previous one had rather than preserving it.
test('re-storing a credential without an expiry clears the previous expiry', async () => {
  const { client, upserts } = fakePrisma();
  const expiresAt = new Date('2026-10-01T00:00:00.000Z');

  await withKey(() =>
    storeIntegrationCredential(client as never, {
      integrationId: 'int-1',
      kind: 'refresh_token',
      plaintext: 'atlassian-refresh-token',
      expiresAt,
    }),
  );
  await withKey(() =>
    storeIntegrationCredential(client as never, {
      integrationId: 'int-1',
      kind: 'refresh_token',
      plaintext: 'atlassian-refresh-token',
    }),
  );

  const withExpiry = upserts[0] as { create: { expiresAt: unknown }; update: { expiresAt: unknown } };
  const withoutExpiry = upserts[1] as { create: { expiresAt: unknown }; update: { expiresAt: unknown } };
  assert.deepEqual(withExpiry.create.expiresAt, expiresAt);
  assert.deepEqual(withExpiry.update.expiresAt, expiresAt);
  assert.equal(withoutExpiry.create.expiresAt, null);
  assert.equal(withoutExpiry.update.expiresAt, null);
});
