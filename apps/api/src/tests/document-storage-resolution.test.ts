import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocumentStorageProviderRegistry } from '../services/document-storage-provider.js';
import {
  envDefaultProviderId,
  resolveProviderForOrganisation,
  type OrganisationStorageResolver,
} from '../services/document-storage-resolution.js';
import { AppError } from '../utils/errors.js';

const registry = createDocumentStorageProviderRegistry([
  { id: 'supabase', stage: 'ga' },
  { id: 'local', stage: 'ga' },
  { id: 'confluence', stage: 'alpha' },
]);

// Always awaits `run()` before restoring the environment. A non-async version
// would restore DOCUMENT_STORAGE_DRIVER while an async body was still running,
// and these tests all run under the suite's default concurrency.
async function withDriver<T>(value: string | undefined, run: () => T | Promise<T>): Promise<T> {
  const previous = process.env.DOCUMENT_STORAGE_DRIVER;
  if (value === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
  else process.env.DOCUMENT_STORAGE_DRIVER = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = previous;
  }
}

test('an unset driver defaults to supabase', async () => {
  await withDriver(undefined, () => assert.equal(envDefaultProviderId(registry), 'supabase'));
});

test('the local driver is honoured', async () => {
  await withDriver('local', () => assert.equal(envDefaultProviderId(registry), 'local'));
});

test('an unrecognised driver falls back to supabase, exactly as before this change', async () => {
  await withDriver('nonsense', () => assert.equal(envDefaultProviderId(registry), 'supabase'));
  await withDriver('', () => assert.equal(envDefaultProviderId(registry), 'supabase'));
});

test('an alpha provider named as the deployment default fails loudly', async () => {
  await withDriver('confluence', () => {
    assert.throws(() => envDefaultProviderId(registry), (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal((err as AppError).code, 'STORAGE_PROVIDER_ALPHA_NOT_DEFAULTABLE');
      return true;
    });
  });
});

test('with no resolver the organisation gets the deployment default', async () => {
  await withDriver('local', async () => {
    assert.equal(await resolveProviderForOrganisation('org-a', null, registry), 'local');
  });
});

test('an organisation with no stored preference gets the deployment default', async () => {
  const resolver: OrganisationStorageResolver = async () => ({ provider: null, alphaOptIn: false });
  await withDriver(undefined, async () => {
    assert.equal(await resolveProviderForOrganisation('org-a', resolver, registry), 'supabase');
  });
});

test('an organisation preference overrides the deployment default', async () => {
  const resolver: OrganisationStorageResolver = async () => ({ provider: 'local', alphaOptIn: false });
  await withDriver(undefined, async () => {
    assert.equal(await resolveProviderForOrganisation('org-a', resolver, registry), 'local');
  });
});

test('an organisation cannot select an alpha provider without opting in', async () => {
  const resolver: OrganisationStorageResolver = async () => ({ provider: 'confluence', alphaOptIn: false });
  await assert.rejects(
    () => resolveProviderForOrganisation('org-a', resolver, registry),
    (err) => {
      assert.equal((err as AppError).code, 'STORAGE_PROVIDER_ALPHA_NOT_ENABLED');
      return true;
    },
  );
});

test('an organisation that has opted in may select an alpha provider', async () => {
  const resolver: OrganisationStorageResolver = async () => ({ provider: 'confluence', alphaOptIn: true });
  assert.equal(await resolveProviderForOrganisation('org-a', resolver, registry), 'confluence');
});

// ---------------------------------------------------------------------------
// Bytes that already exist must stay erasable and readable, whatever the
// deployment would permit an organisation to *choose* today. Both directions
// are pinned: the exemption must cover erasure and read, and must not leak into
// selection or upload.
// ---------------------------------------------------------------------------

const notOptedInAlphaResolver: OrganisationStorageResolver = async () => ({
  provider: 'confluence',
  alphaOptIn: false,
});
const unknownProviderResolver: OrganisationStorageResolver = async () => ({
  provider: 'legacy-s3',
  alphaOptIn: false,
});

test('an alpha provider the organisation never opted into still resolves for erasure and read', async () => {
  for (const operation of ['delete', 'read'] as const) {
    assert.equal(
      await resolveProviderForOrganisation('org-a', notOptedInAlphaResolver, registry, { operation }),
      'confluence',
      `a document stored in an alpha provider must remain ${operation}-able; refusing strands the bytes`,
    );
  }
});

test('an unknown provider id still resolves for erasure and read, verbatim', async () => {
  for (const operation of ['delete', 'read'] as const) {
    assert.equal(
      await resolveProviderForOrganisation('org-a', unknownProviderResolver, registry, { operation }),
      'legacy-s3',
      'an unrecognised id must be returned as-is so erasure can stamp it and fail on it visibly',
    );
  }
});

test('the erasure exemption never substitutes the deployment default for an unresolvable provider', async () => {
  // The dangerous near-miss: falling back to 'supabase' here would stamp a row
  // whose bytes are elsewhere, the Supabase eraser would find nothing, report
  // success, and the pipeline would record an erasure that never happened.
  await withDriver('local', async () => {
    assert.notEqual(
      await resolveProviderForOrganisation('org-a', unknownProviderResolver, registry, { operation: 'delete' }),
      'local',
    );
    assert.notEqual(
      await resolveProviderForOrganisation('org-a', notOptedInAlphaResolver, registry, { operation: 'delete' }),
      'local',
    );
  });
});

test('selecting or writing still refuses an alpha-not-enabled provider and an unknown provider', async () => {
  for (const resolver of [notOptedInAlphaResolver, unknownProviderResolver]) {
    for (const options of [undefined, { operation: 'write' } as const]) {
      await assert.rejects(
        () => resolveProviderForOrganisation('org-a', resolver, registry, options),
        (err) => {
          assert.equal(err instanceof AppError, true);
          assert.ok(
            ['STORAGE_PROVIDER_ALPHA_NOT_ENABLED', 'STORAGE_PROVIDER_UNKNOWN'].includes((err as AppError).code),
            `the write path must keep refusing; got ${(err as AppError).code}`,
          );
          return true;
        },
      );
    }
  }
});

import { createPrismaOrganisationStorageResolver } from '../services/document-storage-resolution.js';

type FindUniqueArgs = { where: { id: string }; select: Record<string, boolean> };

function fakePrisma(row: { documentStorageProvider: string | null; documentStorageAlphaOptIn: boolean } | null) {
  const calls: FindUniqueArgs[] = [];
  return {
    calls,
    client: {
      organisation: {
        async findUnique(args: FindUniqueArgs) {
          calls.push(args);
          return row;
        },
      },
    },
  };
}

test('the prisma resolver reads the organisation preference', async () => {
  const { client, calls } = fakePrisma({ documentStorageProvider: 'local', documentStorageAlphaOptIn: false });
  const resolver = createPrismaOrganisationStorageResolver(client);

  assert.deepEqual(await resolver('org-a'), { provider: 'local', alphaOptIn: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].where, { id: 'org-a' });
  assert.deepEqual(calls[0].select, { documentStorageProvider: true, documentStorageAlphaOptIn: true });
});

test('the prisma resolver carries the alpha opt-in through', async () => {
  const { client } = fakePrisma({ documentStorageProvider: 'confluence', documentStorageAlphaOptIn: true });
  const resolver = createPrismaOrganisationStorageResolver(client);

  assert.deepEqual(await resolver('org-a'), { provider: 'confluence', alphaOptIn: true });
});

test('a missing organisation resolves to no preference rather than throwing', async () => {
  const { client } = fakePrisma(null);
  const resolver = createPrismaOrganisationStorageResolver(client);

  assert.deepEqual(await resolver('org-missing'), { provider: null, alphaOptIn: false });
});

// Production deployments forbid DOCUMENT_STORAGE_DRIVER=local
// (requireProductionDocumentStorageDriver in utils/env.ts) and validate
// LOCAL_FILE_STORAGE_DIR only inside that same branch. A per-organisation
// 'local' preference on a Supabase-default production deployment would have
// reached StorageService's local branch with none of that validation having
// run, writing to the unvalidated relative default root. The resolution layer
// refuses it instead.
async function withNodeEnv<T>(value: string | undefined, run: () => T | Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

const localResolver: OrganisationStorageResolver = async () => ({ provider: 'local', alphaOptIn: false });
const supabaseResolver: OrganisationStorageResolver = async () => ({ provider: 'supabase', alphaOptIn: false });

test('a production deployment refuses a per-organisation local provider', { concurrency: false }, async () => {
  await withNodeEnv('production', () =>
    withDriver(undefined, () =>
      assert.rejects(
        () => resolveProviderForOrganisation('org-a', localResolver, registry),
        (err) => {
          assert.equal(err instanceof AppError, true);
          assert.equal((err as AppError).code, 'STORAGE_PROVIDER_NOT_PERMITTED_IN_PRODUCTION');
          return true;
        },
      ),
    ),
  );
});

test('a production deployment still allows a per-organisation supabase provider', { concurrency: false }, async () => {
  await withNodeEnv('production', () =>
    withDriver(undefined, async () => {
      assert.equal(await resolveProviderForOrganisation('org-a', supabaseResolver, registry), 'supabase');
    }),
  );
});

test('a non-production deployment allows a per-organisation local provider', { concurrency: false }, async () => {
  await withNodeEnv('test', () =>
    withDriver(undefined, async () => {
      assert.equal(await resolveProviderForOrganisation('org-a', localResolver, registry), 'local');
    }),
  );
});

test('a production deployment whose own driver is local allows a per-organisation local provider', { concurrency: false }, async () => {
  await withNodeEnv('production', () =>
    withDriver('local', async () => {
      assert.equal(await resolveProviderForOrganisation('org-a', localResolver, registry), 'local');
    }),
  );
});

test('a production deployment refuses a local provider for writes', { concurrency: false }, async () => {
  await withNodeEnv('production', async () => {
    await assert.rejects(
      () => resolveProviderForOrganisation('org-a', localResolver, registry, { operation: 'write' }),
      (err) => {
        assert.equal((err as AppError).code, 'STORAGE_PROVIDER_NOT_PERMITTED_IN_PRODUCTION');
        return true;
      },
    );
  });
});

test('a production deployment still allows reading and deleting existing local documents', { concurrency: false }, async () => {
  await withNodeEnv('production', async () => {
    assert.equal(
      await resolveProviderForOrganisation('org-a', localResolver, registry, { operation: 'read' }),
      'local',
    );
    assert.equal(
      await resolveProviderForOrganisation('org-a', localResolver, registry, { operation: 'delete' }),
      'local',
    );
  });
});

test('the operation defaults to write, so an unqualified call stays strict', { concurrency: false }, async () => {
  await withNodeEnv('production', async () => {
    await assert.rejects(() => resolveProviderForOrganisation('org-a', localResolver, registry));
  });
});
