# Per-Tenant Document Storage (Phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the document storage backend a per-organisation choice instead of a single process-wide environment setting, behind a provider registry that can refuse alpha-stage providers.

**Architecture:** A small provider registry declares every known storage provider and its stage (`ga` or `alpha`). A resolver turns an organisation id into a provider id, falling back to the existing environment default when the organisation has expressed no preference. `StorageService` keeps its existing public method signatures and its existing zero-argument constructor, and gains an optional resolver argument. No storage logic is rewritten; the `isLocalStorageDriver()` call inside each method is replaced by the resolved provider for that organisation.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 22, Fastify 5, Prisma 6, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md`

## Global Constraints

- **No behaviour change for any existing deployment.** `new StorageService()` with no arguments must continue to behave exactly as it does today, including for unrecognised `DOCUMENT_STORAGE_DRIVER` values, which fall back to Supabase.
- **No Confluence code in this phase.** Phase 0 adds the seam only. The registry ships with `supabase` and `local`, both `ga`.
- **Tenant isolation is unchanged.** `assertOrganisationStoragePath` must still run on every read and delete, before any storage access.
- **Alpha providers are never defaultable.** An alpha provider named in `DOCUMENT_STORAGE_DRIVER` must fail loudly rather than be silently promoted.
- ESM only: every relative import ends in `.js`.
- Tests are compiled before they run. From `apps/api`, a single test file runs as `npm run build && node --test dist/tests/<name>.test.js`.
- Migrations are additive only: new columns are nullable or carry a default.

---

## File Structure

**Create:**
- `apps/api/src/services/document-storage-provider.ts` — the registry. Knows provider ids and stages; enforces the alpha gate. Pure, no I/O, no env access.
- `apps/api/src/services/document-storage-resolution.ts` — resolution. Reads the environment default and, when given a resolver, an organisation's stored preference. Depends on the registry.
- `apps/api/src/tests/document-storage-provider.test.ts`
- `apps/api/src/tests/document-storage-resolution.test.ts`
- `apps/api/prisma/migrations/20260918120000_add_organisation_document_storage_provider/migration.sql`

**Modify:**
- `apps/api/prisma/schema.prisma` — two new `Organisation` columns.
- `apps/api/src/services/storage.service.ts` — optional constructor argument; per-organisation branching inside `uploadFile`, `downloadFile`, `deleteFile`.
- `apps/api/src/routes/documents/index.ts:62` — pass the Prisma-backed resolver.
- `apps/api/src/jobs/cleanup-document-storage.ts:20` — pass the Prisma-backed resolver.
- `apps/api/src/jobs/production-scheduler.ts:497` — pass the Prisma-backed resolver.
- `docs/ARCHITECTURE.md` — document the provider registry and the alpha gate.

**Deliberately left alone:**
- `apps/api/src/routes/health/index.ts:210` keeps `new StorageService()`. The global health probe reports on the deployment default, not on any tenant. Per-tenant integration health is Phase 6.
- `isConfigured()` and `verifyBucket()` stay environment-scoped for the same reason.

---

### Task 1: Provider registry with the alpha gate

The registry is a factory so tests can build one containing an alpha provider without shipping a fake provider in production code.

**Files:**
- Create: `apps/api/src/services/document-storage-provider.ts`
- Test: `apps/api/src/tests/document-storage-provider.test.ts`

**Interfaces:**
- Consumes: `AppError` from `../utils/errors.js`.
- Produces:
  - `type DocumentStorageProviderId = 'supabase' | 'local'`
  - `type DocumentStorageProviderStage = 'ga' | 'alpha'`
  - `type DocumentStorageProviderDescriptor = { id: string; stage: DocumentStorageProviderStage }`
  - `createDocumentStorageProviderRegistry(descriptors: DocumentStorageProviderDescriptor[])` returning `{ list(), describe(id), isKnown(id), assertSelectable(id, { alphaOptIn }), assertDefaultable(id) }`
  - `documentStorageProviders` — the default registry instance containing `supabase` (ga) and `local` (ga).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/document-storage-provider.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDocumentStorageProviderRegistry,
  documentStorageProviders,
} from '../services/document-storage-provider.js';
import { AppError } from '../utils/errors.js';

function assertAppError(action: () => unknown, statusCode: number, code: string) {
  assert.throws(action, (err) => {
    assert.equal(err instanceof AppError, true);
    assert.equal((err as AppError).statusCode, statusCode);
    assert.equal((err as AppError).code, code);
    return true;
  });
}

const registry = createDocumentStorageProviderRegistry([
  { id: 'supabase', stage: 'ga' },
  { id: 'local', stage: 'ga' },
  { id: 'confluence', stage: 'alpha' },
]);

test('a ga provider is selectable without any alpha opt-in', () => {
  assert.equal(registry.assertSelectable('supabase', { alphaOptIn: false }), 'supabase');
  assert.equal(registry.assertSelectable('local', { alphaOptIn: false }), 'local');
});

test('an alpha provider is refused unless the organisation has opted in', () => {
  assertAppError(
    () => registry.assertSelectable('confluence', { alphaOptIn: false }),
    400,
    'STORAGE_PROVIDER_ALPHA_NOT_ENABLED',
  );
});

test('an alpha provider is selectable once the organisation has opted in', () => {
  assert.equal(registry.assertSelectable('confluence', { alphaOptIn: true }), 'confluence');
});

test('an alpha provider can never be the deployment default, even with opt-in', () => {
  assertAppError(
    () => registry.assertDefaultable('confluence'),
    500,
    'STORAGE_PROVIDER_ALPHA_NOT_DEFAULTABLE',
  );
  assert.equal(registry.assertDefaultable('supabase'), 'supabase');
});

test('an unknown provider is refused by both gates', () => {
  assertAppError(() => registry.assertSelectable('dropbox', { alphaOptIn: true }), 400, 'STORAGE_PROVIDER_UNKNOWN');
  assertAppError(() => registry.assertDefaultable('dropbox'), 500, 'STORAGE_PROVIDER_UNKNOWN');
});

test('isKnown reports membership without throwing', () => {
  assert.equal(registry.isKnown('local'), true);
  assert.equal(registry.isKnown('dropbox'), false);
});

test('the shipped registry contains only ga providers in this phase', () => {
  const stages = documentStorageProviders.list().map((descriptor) => `${descriptor.id}:${descriptor.stage}`).sort();
  assert.deepEqual(stages, ['local:ga', 'supabase:ga']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/api`:

```bash
npm run build && node --test dist/tests/document-storage-provider.test.js
```

Expected: the build fails because `../services/document-storage-provider.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/document-storage-provider.ts`:

```ts
import { AppError } from '../utils/errors.js';

export type DocumentStorageProviderId = 'supabase' | 'local';

export type DocumentStorageProviderStage = 'ga' | 'alpha';

export type DocumentStorageProviderDescriptor = {
  id: string;
  stage: DocumentStorageProviderStage;
};

export type DocumentStorageProviderRegistry = {
  list(): DocumentStorageProviderDescriptor[];
  isKnown(id: string): boolean;
  describe(id: string): DocumentStorageProviderDescriptor | null;
  assertSelectable(id: string, options: { alphaOptIn: boolean }): string;
  assertDefaultable(id: string): string;
};

export function createDocumentStorageProviderRegistry(
  descriptors: DocumentStorageProviderDescriptor[],
): DocumentStorageProviderRegistry {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));

  return {
    list() {
      return [...byId.values()];
    },

    isKnown(id: string) {
      return byId.has(id);
    },

    describe(id: string) {
      return byId.get(id) ?? null;
    },

    assertSelectable(id: string, options: { alphaOptIn: boolean }) {
      const descriptor = byId.get(id);
      if (!descriptor) {
        throw new AppError(400, 'STORAGE_PROVIDER_UNKNOWN', 'That document storage provider is not available.');
      }
      if (descriptor.stage === 'alpha' && !options.alphaOptIn) {
        throw new AppError(
          400,
          'STORAGE_PROVIDER_ALPHA_NOT_ENABLED',
          'That document storage provider is in alpha and has not been enabled for this organisation.',
        );
      }
      return descriptor.id;
    },

    assertDefaultable(id: string) {
      const descriptor = byId.get(id);
      if (!descriptor) {
        throw new AppError(500, 'STORAGE_PROVIDER_UNKNOWN', 'The configured document storage provider is not recognised.');
      }
      if (descriptor.stage === 'alpha') {
        throw new AppError(
          500,
          'STORAGE_PROVIDER_ALPHA_NOT_DEFAULTABLE',
          'An alpha document storage provider cannot be the deployment default.',
        );
      }
      return descriptor.id;
    },
  };
}

// Phase 0 ships ga providers only. Confluence joins this list as `alpha`
// in Phase 1 — see docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md.
export const documentStorageProviders = createDocumentStorageProviderRegistry([
  { id: 'supabase', stage: 'ga' },
  { id: 'local', stage: 'ga' },
]);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run build && node --test dist/tests/document-storage-provider.test.js
```

Expected: 7 passing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/document-storage-provider.ts apps/api/src/tests/document-storage-provider.test.ts
git commit -m "feat(storage): add a document storage provider registry with an alpha gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Environment default and organisation resolution

**Files:**
- Create: `apps/api/src/services/document-storage-resolution.ts`
- Test: `apps/api/src/tests/document-storage-resolution.test.ts`

**Interfaces:**
- Consumes: `documentStorageProviders`, `DocumentStorageProviderRegistry` from Task 1.
- Produces:
  - `type OrganisationStorageSelection = { provider: string | null; alphaOptIn: boolean }`
  - `type OrganisationStorageResolver = (organisationId: string) => Promise<OrganisationStorageSelection>`
  - `envDefaultProviderId(registry?): string`
  - `resolveProviderForOrganisation(organisationId, resolver, registry?): Promise<string>`

The behaviour that must be preserved exactly: today `isLocalStorageDriver()` is `process.env.DOCUMENT_STORAGE_DRIVER === 'local'`, and **every other value, including nonsense, means Supabase**. `envDefaultProviderId` therefore only consults the registry when the environment value names a known provider.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/document-storage-resolution.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run build && node --test dist/tests/document-storage-resolution.test.js
```

Expected: the build fails because `../services/document-storage-resolution.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/document-storage-resolution.ts`:

```ts
import {
  documentStorageProviders,
  type DocumentStorageProviderRegistry,
} from './document-storage-provider.js';

export type OrganisationStorageSelection = {
  /** null means "no preference recorded — use the deployment default". */
  provider: string | null;
  alphaOptIn: boolean;
};

export type OrganisationStorageResolver = (
  organisationId: string,
) => Promise<OrganisationStorageSelection>;

/**
 * The deployment-wide default.
 *
 * Historically this was `DOCUMENT_STORAGE_DRIVER === 'local'`, with every other
 * value — including empty or misspelled ones — meaning Supabase. That fallback
 * is preserved deliberately: an unknown value must not start throwing on a
 * deployment that has been running happily. Only a value that names a KNOWN
 * provider is passed to the registry, which is what lets the alpha gate refuse
 * an alpha provider named here.
 */
export function envDefaultProviderId(
  registry: DocumentStorageProviderRegistry = documentStorageProviders,
): string {
  const configured = process.env.DOCUMENT_STORAGE_DRIVER;
  if (!configured || !registry.isKnown(configured)) return 'supabase';
  return registry.assertDefaultable(configured);
}

export async function resolveProviderForOrganisation(
  organisationId: string,
  resolver: OrganisationStorageResolver | null,
  registry: DocumentStorageProviderRegistry = documentStorageProviders,
): Promise<string> {
  if (!resolver) return envDefaultProviderId(registry);

  const selection = await resolver(organisationId);
  if (!selection.provider) return envDefaultProviderId(registry);

  return registry.assertSelectable(selection.provider, { alphaOptIn: selection.alphaOptIn });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run build && node --test dist/tests/document-storage-resolution.test.js
```

Expected: 9 passing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/document-storage-resolution.ts apps/api/src/tests/document-storage-resolution.test.ts
git commit -m "feat(storage): resolve the document storage provider per organisation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Organisation columns and migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (the `Organisation` model, `apps/api/prisma/schema.prisma:328`)
- Create: `apps/api/prisma/migrations/20260918120000_add_organisation_document_storage_provider/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `Organisation.documentStorageProvider: String?` and `Organisation.documentStorageAlphaOptIn: Boolean` (default `false`), read by Task 4's Prisma resolver.

The column is a nullable `String`, not a Prisma enum, so that the provider registry in Task 1 stays the single source of truth for which providers exist and what stage they are at. A Prisma enum would duplicate that list and let the two drift.

- [ ] **Step 1: Add the columns to the schema**

In `apps/api/prisma/schema.prisma`, inside `model Organisation`, immediately after the `stripeCustomerId` line:

```prisma
  // Document storage backend for this organisation.
  // null  = use the deployment default (DOCUMENT_STORAGE_DRIVER).
  // Values are validated against the provider registry in
  // apps/api/src/services/document-storage-provider.ts, which is the single
  // source of truth for which providers exist and which stage they are at.
  documentStorageProvider   String?
  // Alpha-stage providers are refused unless this is explicitly true.
  documentStorageAlphaOptIn Boolean @default(false)
```

- [ ] **Step 2: Generate the migration**

Run from `apps/api`:

```bash
npx prisma migrate dev --name add_organisation_document_storage_provider --create-only
```

- [ ] **Step 3: Verify the generated SQL is additive only**

Open the generated `migration.sql`. It must contain only `ALTER TABLE ... ADD COLUMN` statements and no `DROP`, no `NOT NULL` without a default, and no data backfill. Expected content:

```sql
ALTER TABLE "Organisation" ADD COLUMN "documentStorageProvider" TEXT;
ALTER TABLE "Organisation" ADD COLUMN "documentStorageAlphaOptIn" BOOLEAN NOT NULL DEFAULT false;
```

If the generated file differs, rename the directory to `20260918120000_add_organisation_document_storage_provider` and replace its contents with exactly the SQL above.

- [ ] **Step 4: Apply the migration and regenerate the client**

```bash
npm run db:migrate:deploy && npm run db:generate
```

Expected: the migration applies cleanly and the Prisma client regenerates with the two new fields.

- [ ] **Step 5: Run the full API test suite to confirm nothing regressed**

```bash
npm test
```

Expected: the suite passes exactly as it did before this task.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260918120000_add_organisation_document_storage_provider
git commit -m "feat(storage): add per-organisation document storage columns

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Prisma-backed resolver

**Files:**
- Modify: `apps/api/src/services/document-storage-resolution.ts`
- Modify: `apps/api/src/tests/document-storage-resolution.test.ts`

**Interfaces:**
- Consumes: the `Organisation` columns from Task 3.
- Produces: `createPrismaOrganisationStorageResolver(prisma): OrganisationStorageResolver`, used by Task 6 at the three production call sites.

An organisation that cannot be found resolves to "no preference" rather than throwing. The document routes already enforce that the caller belongs to a live organisation, and a storage call is the wrong place to re-litigate tenancy.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/tests/document-storage-resolution.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run build && node --test dist/tests/document-storage-resolution.test.js
```

Expected: the build fails because `createPrismaOrganisationStorageResolver` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `apps/api/src/services/document-storage-resolution.ts`:

```ts
type OrganisationStorageDelegate = {
  organisation: {
    findUnique(args: {
      where: { id: string };
      select: Record<string, boolean>;
    }): Promise<{ documentStorageProvider: string | null; documentStorageAlphaOptIn: boolean } | null>;
  };
};

export function createPrismaOrganisationStorageResolver(prisma: unknown): OrganisationStorageResolver {
  const client = prisma as OrganisationStorageDelegate;

  return async (organisationId: string) => {
    const organisation = await client.organisation.findUnique({
      where: { id: organisationId },
      select: { documentStorageProvider: true, documentStorageAlphaOptIn: true },
    });

    // A missing organisation means "no preference". Tenancy is enforced by the
    // route guards; a storage call is the wrong place to re-check it.
    if (!organisation) return { provider: null, alphaOptIn: false };

    return {
      provider: organisation.documentStorageProvider,
      alphaOptIn: organisation.documentStorageAlphaOptIn,
    };
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run build && node --test dist/tests/document-storage-resolution.test.js
```

Expected: 12 passing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/document-storage-resolution.ts apps/api/src/tests/document-storage-resolution.test.ts
git commit -m "feat(storage): add a prisma-backed organisation storage resolver

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Teach StorageService to resolve per organisation

This is the task that changes existing behaviour-bearing code. The zero-argument constructor must keep working identically — that is what protects the six existing call sites and every existing test.

**Files:**
- Modify: `apps/api/src/services/storage.service.ts`
- Test: `apps/api/src/tests/storage.service.test.ts` (append)

**Interfaces:**
- Consumes: `resolveProviderForOrganisation`, `OrganisationStorageResolver` from Task 2.
- Produces: `new StorageService(resolver?: OrganisationStorageResolver | null)`. All existing method signatures are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/tests/storage.service.test.ts`:

The file already imports `mkdtemp`, `readFile`, `rm`, `join` and `tmpdir` at the top —
reuse them rather than adding duplicates. The only new import is the resolver type:

```ts
import type { OrganisationStorageResolver } from '../services/document-storage-resolution.js';

test('an organisation pinned to local storage uses local storage even when the deployment default is supabase', async () => {
  const previousDriver = process.env.DOCUMENT_STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_FILE_STORAGE_DIR;
  const root = await mkdtemp(join(tmpdir(), 'charitypilot-per-tenant-'));

  // Deployment default is supabase (driver unset); the organisation overrides it.
  delete process.env.DOCUMENT_STORAGE_DRIVER;
  process.env.LOCAL_FILE_STORAGE_DIR = root;

  const resolver: OrganisationStorageResolver = async () => ({ provider: 'local', alphaOptIn: false });

  try {
    const service = new StorageService(resolver);
    const uploaded = await service.uploadFile('org-pinned', 'policy.pdf', Buffer.from('pinned'), 'application/pdf');

    assert.equal(uploaded.storagePath.startsWith('org-pinned/'), true);
    const roundTripped = await service.downloadFile('org-pinned', uploaded.storagePath);
    assert.equal(roundTripped.toString(), 'pinned');

    await service.deleteFile('org-pinned', uploaded.storagePath);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (previousDriver === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = previousDriver;
    if (previousRoot === undefined) delete process.env.LOCAL_FILE_STORAGE_DIR;
    else process.env.LOCAL_FILE_STORAGE_DIR = previousRoot;
  }
});

test('the organisation prefix guard still runs before any resolved provider is used', async () => {
  const resolver: OrganisationStorageResolver = async () => ({ provider: 'local', alphaOptIn: false });
  const service = new StorageService(resolver) as unknown as GuardedStorageService;

  await assertForbiddenStoragePath(() => service.downloadFile('org-a', 'org-b/policy.pdf'));
  await assertForbiddenStoragePath(() => service.deleteFile('org-a', '../org-a/policy.pdf'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run build && node --test dist/tests/storage.service.test.js
```

Expected: FAIL — `StorageService` takes no constructor argument, so the organisation-pinned upload goes to Supabase and the test errors rather than round-tripping through the temp directory.

- [ ] **Step 3: Write the implementation**

In `apps/api/src/services/storage.service.ts`:

First add the import beside the existing imports:

```ts
import {
  resolveProviderForOrganisation,
  type OrganisationStorageResolver,
} from './document-storage-resolution.js';
```

Give the class a constructor. Insert immediately after `export class StorageService {`:

```ts
  /**
   * `resolver` is optional and defaults to null, which means "use the
   * deployment default for every organisation" — exactly the behaviour every
   * call site had before per-tenant storage existed. Do not make it required:
   * the health probe and the existing tests rely on the zero-argument form.
   */
  constructor(private readonly resolver: OrganisationStorageResolver | null = null) {}

  private async providerFor(organisationId: string): Promise<string> {
    return resolveProviderForOrganisation(organisationId, this.resolver);
  }
```

Then replace the three `isLocalStorageDriver()` calls that sit inside per-organisation methods. In `uploadFile`, replace:

```ts
    if (isLocalStorageDriver()) {
```

with:

```ts
    if ((await this.providerFor(organisationId)) === 'local') {
```

In `downloadFile`, the existing local branch delegates to `this.readLocalFile(organisationId, guardedPath)`, which re-asserts the environment driver. Extract the read body so the resolved path does not consult the environment again. Replace the `readLocalFile` method and the local branch of `downloadFile` with:

```ts
  private async readLocalResolved(guardedPath: string): Promise<Buffer> {
    try {
      const filePath = localFilePath(guardedPath);
      const file = await stat(filePath);
      if (file.size > MAX_DOCUMENT_DOWNLOAD_BYTES) {
        throw new AppError(500, 'STORAGE_DOWNLOAD_TOO_LARGE', STORAGE_OPERATION_FAILED_MESSAGE);
      }
      return await readFile(filePath);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isMissingFileError(error)) {
        throw new AppError(404, 'STORAGE_FILE_NOT_FOUND', 'Document file not found in local storage');
      }
      throw new AppError(500, 'STORAGE_READ_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }
  }

  async readLocalFile(organisationId: string, storagePath: string): Promise<Buffer> {
    this.assertLocalStorageEnabled();
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);
    return this.readLocalResolved(guardedPath);
  }
```

The body above is the current `readLocalFile` body moved verbatim — same error codes
(`STORAGE_DOWNLOAD_TOO_LARGE`, `STORAGE_FILE_NOT_FOUND`, `STORAGE_READ_FAILED`), same
messages, same local variable name. Only the two guard lines move out to the public
wrapper. Do not "tidy" any of it: `documents-route.test.ts` asserts on these codes.

and inside `downloadFile`, replace `if (isLocalStorageDriver()) { return this.readLocalFile(organisationId, guardedPath); }` with:

```ts
    if ((await this.providerFor(organisationId)) === 'local') {
      return this.readLocalResolved(guardedPath);
    }
```

In `deleteFile`, replace `if (isLocalStorageDriver()) {` with:

```ts
    if ((await this.providerFor(organisationId)) === 'local') {
```

Leave `isConfigured()`, `verifyBucket()` and `assertLocalStorageEnabled()` exactly as they are — they describe the deployment, not a tenant.

> If `readLocalFile`'s existing body differs from the block above (size cap, error mapping), keep the existing body verbatim and only move it into `readLocalResolved`. This step must not change any error code or message.

- [ ] **Step 4: Run the storage tests to verify they pass**

```bash
npm run build && node --test dist/tests/storage.service.test.js dist/tests/documents-reliability.test.js dist/tests/degradation-reliability.test.js
```

Expected: PASS, including every pre-existing test. If `degradation-reliability.test.ts` fails, the zero-argument default was not preserved — fix that rather than editing the test.

- [ ] **Step 5: Run the full API suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/storage.service.ts apps/api/src/tests/storage.service.test.ts
git commit -m "feat(storage): resolve the storage provider per organisation in StorageService

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the resolver in, and document it

**Files:**
- Modify: `apps/api/src/routes/documents/index.ts:62`
- Modify: `apps/api/src/jobs/cleanup-document-storage.ts:20`
- Modify: `apps/api/src/jobs/production-scheduler.ts:497`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: `createPrismaOrganisationStorageResolver` from Task 4, `new StorageService(resolver)` from Task 5.
- Produces: nothing new.

- [ ] **Step 1: Wire the documents route**

In `apps/api/src/routes/documents/index.ts`, add the import:

```ts
import { createPrismaOrganisationStorageResolver } from '../../services/document-storage-resolution.js';
```

and replace line 62:

```ts
  const storageService = new StorageService();
```

with:

```ts
  const storageService = new StorageService(createPrismaOrganisationStorageResolver(app.prisma));
```

- [ ] **Step 2: Wire the two jobs**

In `apps/api/src/jobs/cleanup-document-storage.ts` and `apps/api/src/jobs/production-scheduler.ts`, add the same import (adjusting the relative path to `../services/document-storage-resolution.js`) and pass the resolver built from whichever Prisma client that file already has in scope:

```ts
const storageService = new StorageService(createPrismaOrganisationStorageResolver(prisma));
```

Use the existing local variable name for the Prisma client in each file rather than introducing a new one.

- [ ] **Step 3: Confirm the health probe was left alone**

Run:

```bash
grep -n "new StorageService" apps/api/src/routes/health/index.ts
```

Expected: `new StorageService()` with no argument. The global readiness probe reports on the deployment default, not on any tenant.

- [ ] **Step 4: Run the full API suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Document the registry in ARCHITECTURE.md**

Add this section to `docs/ARCHITECTURE.md`, under the existing document storage material:

```markdown
### Document storage providers

Document storage is chosen per organisation, not per process.

- `apps/api/src/services/document-storage-provider.ts` is the registry: the
  single source of truth for which providers exist and what stage each is at
  (`ga` or `alpha`).
- `apps/api/src/services/document-storage-resolution.ts` turns an organisation
  id into a provider id, falling back to `DOCUMENT_STORAGE_DRIVER` when the
  organisation has recorded no preference.
- `Organisation.documentStorageProvider` (nullable) holds the preference;
  `Organisation.documentStorageAlphaOptIn` gates alpha-stage providers.

An alpha provider can only be selected by an organisation that has explicitly
opted in, and can never be the deployment default. This is the mechanism that
keeps in-progress integrations off tenants who have not asked for them — see
`docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md`.

The global health probe (`routes/health`) deliberately reports on the
deployment default only. Per-tenant integration health is a later phase.
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/documents/index.ts apps/api/src/jobs/cleanup-document-storage.ts apps/api/src/jobs/production-scheduler.ts docs/ARCHITECTURE.md
git commit -m "feat(storage): wire the per-organisation storage resolver into routes and jobs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Done when

- `npm test` passes in `apps/api` with no pre-existing test modified to accommodate the change.
- A deployment with `DOCUMENT_STORAGE_DRIVER` unset, set to `local`, or set to an unrecognised value behaves exactly as it did before this plan.
- An organisation row with `documentStorageProvider = 'local'` uses local storage on a deployment whose default is Supabase.
- Setting `DOCUMENT_STORAGE_DRIVER` to an alpha provider fails loudly with `STORAGE_PROVIDER_ALPHA_NOT_DEFAULTABLE`.
- No Confluence code exists anywhere in the repository.
