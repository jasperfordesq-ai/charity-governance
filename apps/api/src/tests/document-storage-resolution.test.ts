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
