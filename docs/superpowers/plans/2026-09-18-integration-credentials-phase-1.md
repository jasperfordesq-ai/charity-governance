# Integration Credentials (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give CharityPilot a provider-agnostic way to hold a tenant's third-party credentials encrypted at rest, with key rotation, so a later phase can connect Confluence (and later still, accounting software) without inventing secret handling under time pressure.

**Architecture:** A single symmetric key from the environment, validated the way `AUTH_RECOVERY_SECRET` already is. Secrets are sealed with AES-256-GCM into a self-describing envelope that records its key generation, so a rotation can re-seal without guessing which key a row used. Two new models — `OrganisationIntegration` (what a tenant has connected) and `IntegrationCredential` (the sealed material) — plus a control row carrying the active generation, mirroring the existing `AuthRecoveryControl` idiom. No provider is implemented in this phase.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Node 22 `node:crypto`, Fastify 5, Prisma 6, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md` (Phase 1)

## Why this phase contains no Confluence code

The Atlassian MCP app is not installed on `hour-timebank.atlassian.net`; every content call returns `403 "The app is not installed on this instance"`. A Confluence client written now could not be verified against the real space, and the first page it touched in anger would be the test. Credential handling is provider-agnostic, is the longest pole in the Confluence work, and is equally needed by the Irish accounting integration — so it is worth building now and is fully testable without Atlassian.

**Phase 2 (Confluence OAuth + client) does not start until that app is installed.**

## Global Constraints

- **No behaviour change for any existing deployment.** Nothing in this phase runs unless an organisation has an integration row, and none will exist.
- **A plaintext secret never leaves the crypto module.** No secret, and no derived key, may be logged, returned in an API response, put in an error message, or stored unsealed. Errors about sealed material carry a fingerprint, never the material.
- **`INTEGRATION_ENCRYPTION_KEY` is required in production and must be distinct** from `JWT_SECRET`, `AUTH_RECOVERY_SECRET`, `OWNER_JWT_SECRET` and `READINESS_API_KEY`.
- **Migrations are additive only:** new tables, or new columns that are nullable or carry a default.
- ESM only: every relative import ends in `.js`.
- Tests compile before running. From `apps/api`: `npm run build && node --test dist/tests/<name>.test.js`.
- Current suite state: main **1054 pass / 0 fail**, real-PostgreSQL migration suite **4 pass / 0 fail**. Every task reports against this.
- **Do not weaken anything Phase 0 shipped.** `assertOrganisationStoragePath` still runs first on every read and delete; the zero-argument `StorageService()` still behaves as before.

---

## File Structure

**Create:**
- `apps/api/src/services/integration-crypto.ts` — seal/open primitives and the envelope format. Pure; no Prisma, no env reads beyond the key accessor.
- `apps/api/src/services/integration-credential.service.ts` — stores and loads a tenant's credentials through the crypto module.
- `apps/api/src/tests/integration-crypto.test.ts`
- `apps/api/src/tests/integration-credential.service.test.ts`
- `apps/api/prisma/migrations/20260919090000_add_integration_credentials/migration.sql`

**Modify:**
- `apps/api/prisma/schema.prisma` — three new models, one new enum.
- `apps/api/src/utils/env.ts` — validate `INTEGRATION_ENCRYPTION_KEY`.
- `apps/api/src/tests/env.test.ts` — cover that validation.
- `apps/api/src/services/document-storage-resolution.ts` — the carried Phase 0 fix (Task 5).
- `docs/ARCHITECTURE.md` — document the envelope, rotation, and the deployment-consistency rule.

---

### Task 1: Envelope crypto primitives

**Files:**
- Create: `apps/api/src/services/integration-crypto.ts`
- Test: `apps/api/src/tests/integration-crypto.test.ts`

**Interfaces:**
- Consumes: `node:crypto`, `AppError` from `../utils/errors.js`.
- Produces:
  - `type SealedSecret = { generation: number; iv: string; tag: string; ciphertext: string }`
  - `sealIntegrationSecret(plaintext: string, key: Buffer, generation: number): SealedSecret`
  - `openIntegrationSecret(sealed: SealedSecret, key: Buffer): string`
  - `integrationKeyFingerprint(key: Buffer): string`
  - `decodeIntegrationKey(raw: string): Buffer`

The envelope carries its `generation` so a rotation knows which key opened a row without trial decryption. AES-256-GCM is authenticated, so tampering fails loudly rather than yielding garbage.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/integration-crypto.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  decodeIntegrationKey,
  integrationKeyFingerprint,
  openIntegrationSecret,
  sealIntegrationSecret,
} from '../services/integration-crypto.js';
import { AppError } from '../utils/errors.js';

const key = randomBytes(32);
const otherKey = randomBytes(32);

test('a sealed secret round-trips through the same key', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1);
  assert.equal(openIntegrationSecret(sealed, key), 'atlassian-refresh-token');
});

test('the envelope records its generation and never contains the plaintext', () => {
  const sealed = sealIntegrationSecret('super-secret-value', key, 7);
  assert.equal(sealed.generation, 7);
  const serialised = JSON.stringify(sealed);
  assert.equal(serialised.includes('super-secret-value'), false);
});

test('sealing the same plaintext twice produces different ciphertext', () => {
  const a = sealIntegrationSecret('same', key, 1);
  const b = sealIntegrationSecret('same', key, 1);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.iv, b.iv);
});

test('opening with the wrong key fails and does not leak the material', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1);
  assert.throws(
    () => openIntegrationSecret(sealed, otherKey),
    (err) => {
      assert.equal(err instanceof AppError, true);
      assert.equal((err as AppError).code, 'INTEGRATION_SECRET_UNREADABLE');
      assert.equal((err as AppError).message.includes('atlassian-refresh-token'), false);
      return true;
    },
  );
});

test('a tampered ciphertext is rejected rather than decrypted', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1);
  const flipped = Buffer.from(sealed.ciphertext, 'base64');
  flipped[0] ^= 0xff;
  const tampered = { ...sealed, ciphertext: flipped.toString('base64') };
  assert.throws(() => openIntegrationSecret(tampered, key), (err) => {
    assert.equal((err as AppError).code, 'INTEGRATION_SECRET_UNREADABLE');
    return true;
  });
});

test('a tampered auth tag is rejected', () => {
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 1);
  const flipped = Buffer.from(sealed.tag, 'base64');
  flipped[0] ^= 0xff;
  assert.throws(
    () => openIntegrationSecret({ ...sealed, tag: flipped.toString('base64') }, key),
    (err) => {
      assert.equal((err as AppError).code, 'INTEGRATION_SECRET_UNREADABLE');
      return true;
    },
  );
});

test('the fingerprint is stable, 64 hex characters, and differs per key', () => {
  const fingerprint = integrationKeyFingerprint(key);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint, integrationKeyFingerprint(key));
  assert.notEqual(fingerprint, integrationKeyFingerprint(otherKey));
});

test('decodeIntegrationKey accepts hex and base64url, and rejects short keys', () => {
  assert.equal(decodeIntegrationKey(key.toString('hex')).equals(key), true);
  assert.equal(decodeIntegrationKey(key.toString('base64url')).equals(key), true);
  assert.throws(
    () => decodeIntegrationKey(randomBytes(16).toString('hex')),
    (err) => {
      assert.equal((err as AppError).code, 'INTEGRATION_KEY_INVALID');
      return true;
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

From `apps/api`:

```bash
npm run build && node --test dist/tests/integration-crypto.test.js
```

Expected: build fails — `../services/integration-crypto.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/integration-crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '../utils/errors.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type SealedSecret = {
  /** The key generation that sealed this envelope, so rotation never guesses. */
  generation: number;
  iv: string;
  tag: string;
  ciphertext: string;
};

/**
 * Decode a configured key. Accepts hex or base64url, matching the encodings
 * AUTH_RECOVERY_SECRET already allows, and insists on exactly 32 bytes.
 */
export function decodeIntegrationKey(raw: string): Buffer {
  const candidates = /^[0-9a-f]+$/i.test(raw)
    ? [Buffer.from(raw, 'hex')]
    : [Buffer.from(raw, 'base64url'), Buffer.from(raw, 'base64')];

  const key = candidates.find((candidate) => candidate.length === KEY_BYTES);
  if (!key) {
    throw new AppError(
      500,
      'INTEGRATION_KEY_INVALID',
      `INTEGRATION_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes`,
    );
  }
  return key;
}

export function integrationKeyFingerprint(key: Buffer): string {
  // Fingerprint the key, never the material it protects. Safe to log.
  return createHash('sha256').update(key).digest('hex');
}

export function sealIntegrationSecret(plaintext: string, key: Buffer, generation: number): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    generation,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function openIntegrationSecret(sealed: SealedSecret, key: Buffer): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM authentication failed, or the envelope is malformed. Either way the
    // material is unusable. The caught error is deliberately not surfaced: it
    // can carry fragments of the attempted plaintext.
    throw new AppError(500, 'INTEGRATION_SECRET_UNREADABLE', 'Stored integration credential could not be read.');
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run build && node --test dist/tests/integration-crypto.test.js
```

Expected: 8 passing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/integration-crypto.ts apps/api/src/tests/integration-crypto.test.ts
git commit -m "feat(integrations): add AES-256-GCM envelope crypto for tenant credentials

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Environment validation for the encryption key

**Files:**
- Modify: `apps/api/src/utils/env.ts`
- Test: `apps/api/src/tests/env.test.ts` (append)

**Interfaces:**
- Consumes: `decodeIntegrationKey` from Task 1.
- Produces: `requireIntegrationEncryptionKey(issues: string[]): void`, called from `validateProductionEnv`.

Follow the existing `AUTH_RECOVERY_SECRET` validation in the same file as the model: read it with the file's existing `requireConfiguredEnv` helper, push human-readable strings onto `issues`, and enforce distinctness from the other secrets. Read that function before writing this one and mirror its shape and message style exactly.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/tests/env.test.ts`, matching the file's existing style for building a complete production environment (find an existing production-validation test and copy its setup rather than inventing one):

```ts
test('production requires a distinct, correctly sized INTEGRATION_ENCRYPTION_KEY', () => {
  const issues: string[] = [];
  requireIntegrationEncryptionKey(issues, {
    INTEGRATION_ENCRYPTION_KEY: undefined,
  } as NodeJS.ProcessEnv);
  assert.equal(issues.some((issue) => issue.includes('INTEGRATION_ENCRYPTION_KEY')), true);
});

test('an INTEGRATION_ENCRYPTION_KEY of the wrong size is rejected', () => {
  const issues: string[] = [];
  requireIntegrationEncryptionKey(issues, {
    INTEGRATION_ENCRYPTION_KEY: '00'.repeat(16),
  } as NodeJS.ProcessEnv);
  assert.equal(issues.some((issue) => issue.includes('32 bytes')), true);
});

test('an INTEGRATION_ENCRYPTION_KEY equal to another secret is rejected', () => {
  const shared = '11'.repeat(32);
  const issues: string[] = [];
  requireIntegrationEncryptionKey(issues, {
    INTEGRATION_ENCRYPTION_KEY: shared,
    JWT_SECRET: shared,
  } as NodeJS.ProcessEnv);
  assert.equal(issues.some((issue) => issue.includes('distinct')), true);
});

test('a valid, distinct INTEGRATION_ENCRYPTION_KEY raises no issue', () => {
  const issues: string[] = [];
  requireIntegrationEncryptionKey(issues, {
    INTEGRATION_ENCRYPTION_KEY: 'ab'.repeat(32),
    JWT_SECRET: 'cd'.repeat(32),
    AUTH_RECOVERY_SECRET: 'ef'.repeat(32),
  } as NodeJS.ProcessEnv);
  assert.deepEqual(issues, []);
});
```

Add `requireIntegrationEncryptionKey` to the existing named import from `../utils/env.js` in that file rather than adding a second import statement.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run build && node --test dist/tests/env.test.js
```

Expected: build fails — `requireIntegrationEncryptionKey` is not exported.

- [ ] **Step 3: Write the implementation**

In `apps/api/src/utils/env.ts`, add the import beside the existing ones:

```ts
import { decodeIntegrationKey } from '../services/integration-crypto.js';
```

Add the validator, following the shape of the existing `AUTH_RECOVERY_SECRET` validator in the same file:

```ts
const INTEGRATION_KEY_PEER_SECRETS = [
  'JWT_SECRET',
  'AUTH_RECOVERY_SECRET',
  'OWNER_JWT_SECRET',
  'READINESS_API_KEY',
] as const;

export function requireIntegrationEncryptionKey(
  issues: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const configured = env.INTEGRATION_ENCRYPTION_KEY;
  if (!configured) {
    issues.push('INTEGRATION_ENCRYPTION_KEY must be set');
    return;
  }

  try {
    decodeIntegrationKey(configured);
  } catch {
    issues.push('INTEGRATION_ENCRYPTION_KEY must canonically encode exactly 32 bytes as hex or base64url');
    return;
  }

  if (INTEGRATION_KEY_PEER_SECRETS.some((name) => env[name] === configured)) {
    issues.push(
      `INTEGRATION_ENCRYPTION_KEY must be distinct from ${INTEGRATION_KEY_PEER_SECRETS.join(', ')}`,
    );
  }
}
```

Call it once from `validateProductionEnv`, beside the other `require*` calls:

```ts
  requireIntegrationEncryptionKey(issues);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run build && node --test dist/tests/env.test.js
```

Expected: PASS, including every pre-existing test in that file.

- [ ] **Step 5: Document the new variable**

Add `INTEGRATION_ENCRYPTION_KEY` to `.env.example` (and any other env example the repo keeps — check `ls .env*` from the repo root and from `apps/api`), with a comment saying it must be 32 random bytes as hex, generated with `openssl rand -hex 32`, and must differ from every other secret.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/utils/env.ts apps/api/src/tests/env.test.ts
git add $(ls .env.example apps/api/.env.example 2>/dev/null)
git commit -m "feat(integrations): require a distinct INTEGRATION_ENCRYPTION_KEY in production

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Schema and migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260919090000_add_integration_credentials/migration.sql`

**Interfaces:**
- Produces: `OrganisationIntegration`, `IntegrationCredential`, `IntegrationSecretControl`, and the `IntegrationProvider` / `IntegrationStatus` enums, all read by Task 4.

**Note on generating the migration:** `prisma migrate dev` cannot be used on this database — it reports pre-existing drift unrelated to this work and demands a data-destroying reset. Hand-write the migration directory and SQL as below, then apply it with `npm run db:migrate:deploy`, which does not run drift detection. **Never run `prisma migrate reset`, `db push`, `DROP` or `TRUNCATE`.** If any command asks to discard data, stop and report BLOCKED.

- [ ] **Step 1: Add the models to the schema**

In `apps/api/prisma/schema.prisma`, add the enums beside the other enums, and the models after `Organisation`:

```prisma
enum IntegrationProvider {
  CONFLUENCE
}

enum IntegrationStatus {
  CONNECTED
  DISCONNECTED
  ERROR
}

model OrganisationIntegration {
  id             String              @id @default(cuid())
  organisationId String
  organisation   Organisation        @relation(fields: [organisationId], references: [id], onDelete: Cascade)
  provider       IntegrationProvider
  status         IntegrationStatus   @default(DISCONNECTED)
  // Non-secret connection facts only (site id, space key). Never credentials.
  config         Json?
  lastError      String?
  connectedAt    DateTime?
  connectedById  String?
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt

  credentials IntegrationCredential[]

  @@unique([organisationId, provider])
  @@index([organisationId])
}

model IntegrationCredential {
  id            String                  @id @default(cuid())
  integrationId String
  integration   OrganisationIntegration @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  // e.g. "access_token", "refresh_token" — the label, never the value.
  kind          String
  // The sealed envelope from integration-crypto.ts: { generation, iv, tag, ciphertext }.
  sealed        Json
  // Denormalised from the envelope so a rotation can find rows without opening them.
  generation    Int
  expiresAt     DateTime?
  createdAt     DateTime                @default(now())
  updatedAt     DateTime                @updatedAt

  @@unique([integrationId, kind])
  @@index([generation])
}

model IntegrationSecretControl {
  id                      Int       @id
  generation              Int       @default(1)
  activeKeyFingerprint    String?   @db.Char(64)
  retiredKeyFingerprint   String?   @db.Char(64)
  rotatedAt               DateTime?
  createdAt               DateTime  @default(now())
  updatedAt               DateTime  @default(now()) @updatedAt
}
```

Add the back-relation to `Organisation`, beside its other relation fields:

```prisma
  integrations OrganisationIntegration[]
```

- [ ] **Step 2: Hand-write the migration**

**There is no shadow database configured in this repository** (`SHADOW_DATABASE_URL` appears nowhere), so `prisma migrate diff --from-migrations` cannot run, and `prisma migrate dev` is unusable because of the pre-existing drift described above. Write the file by hand, exactly as Phase 0 did.

Create `apps/api/prisma/migrations/20260919090000_add_integration_credentials/migration.sql` containing exactly:

```sql
CREATE TYPE "IntegrationProvider" AS ENUM ('CONFLUENCE');
CREATE TYPE "IntegrationStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR');

CREATE TABLE "OrganisationIntegration" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "config" JSONB,
    "lastError" TEXT,
    "connectedAt" TIMESTAMP(3),
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganisationIntegration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationCredential" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sealed" JSONB NOT NULL,
    "generation" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationSecretControl" (
    "id" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "activeKeyFingerprint" CHAR(64),
    "retiredKeyFingerprint" CHAR(64),
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntegrationSecretControl_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganisationIntegration_organisationId_provider_key" ON "OrganisationIntegration"("organisationId", "provider");
CREATE INDEX "OrganisationIntegration_organisationId_idx" ON "OrganisationIntegration"("organisationId");
CREATE UNIQUE INDEX "IntegrationCredential_integrationId_kind_key" ON "IntegrationCredential"("integrationId", "kind");
CREATE INDEX "IntegrationCredential_generation_idx" ON "IntegrationCredential"("generation");

ALTER TABLE "OrganisationIntegration" ADD CONSTRAINT "OrganisationIntegration_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "OrganisationIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

This touches no existing table. Every statement is a `CREATE` or an `ADD CONSTRAINT` on a table created in the same file. **Do not add any `DROP`, or any `ALTER` against a pre-existing table** — if you believe one is needed, stop and report BLOCKED.

After writing it, confirm the schema and the SQL agree by checking that every model field above appears as a column, and that the enum values match. A mismatch here surfaces much later as a confusing Prisma client error.

- [ ] **Step 3: Apply and regenerate**

```bash
npm run db:migrate:deploy && npm run db:generate
```

Expected: exactly one migration applied. If it applies more than one, stop and report.

- [ ] **Step 4: Verify the tables exist**

```bash
docker exec charitypilot-dev-db psql -U charitypilot -d charitypilot -c '\dt' | grep -i integration
```

Expected: all three tables listed.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

Expected: main suite 1054 pass / 0 fail, real-PostgreSQL suite 4 pass / 0 fail — unchanged, since nothing reads these tables yet.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260919090000_add_integration_credentials
git commit -m "feat(integrations): add integration, credential and rotation-control models

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Credential service

**Files:**
- Create: `apps/api/src/services/integration-credential.service.ts`
- Test: `apps/api/src/tests/integration-credential.service.test.ts`

**Interfaces:**
- Consumes: Task 1's crypto, Task 3's models.
- Produces:
  - `storeIntegrationCredential(prisma, { integrationId, kind, plaintext, expiresAt? }): Promise<void>`
  - `loadIntegrationCredential(prisma, { integrationId, kind }): Promise<string | null>`
  - `countCredentialsAwaitingRotation(prisma, activeGeneration): Promise<number>`

Tests use a hand-written Prisma fake, following the idiom already used in `apps/api/src/tests/document-storage-resolution.test.ts`. The active key and generation come from the environment and the control row respectively; read both through small internal helpers so the tests can drive them.

> **Read this before writing any code — the crypto signatures changed after this plan was first written.**
>
> Task 1's security review found that a sealed envelope was portable between tenants: one process-wide key, and nothing binding a ciphertext to its owner, so a row copied from one charity into another's decrypted cleanly. The fix added mandatory context binding. The current signatures are:
>
> ```ts
> export type SecretContext = { organisationId: string; provider: string; kind: string };
>
> sealIntegrationSecret(plaintext: string, key: Buffer, generation: number, context: SecretContext): SealedSecret
> openIntegrationSecret(sealed: SealedSecret, key: Buffer, context: SecretContext): string
> ```
>
> **Derive the context from the database row, never from the caller.** `organisationId` and `provider` live on `OrganisationIntegration`, not on `IntegrationCredential`, so both functions must first load the parent integration by `integrationId`:
>
> ```ts
> const integration = await prisma.organisationIntegration.findUnique({
>   where: { id: integrationId },
>   select: { organisationId: true, provider: true },
> });
> ```
>
> Throw an `AppError` if it is missing. Build the context from that row plus the `kind` argument.
>
> This is the whole point of the binding: if the caller supplied the context, a bug that passed the wrong organisation would seal under the wrong identity and the protection would be worthless. Deriving it from the row the credential actually hangs off makes the AAD mean what it claims. **Do not add an escape hatch that lets a caller override it.**
>
> The consequence for your tests: the Prisma fake needs an `organisationIntegration.findUnique` delegate as well as the `integrationCredential` ones, and any `sealIntegrationSecret` call in a test needs the fourth argument. Add a test proving that a credential sealed under one integration cannot be opened as though it belonged to another — that is the regression test for the vulnerability this binding exists to prevent.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/integration-credential.service.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  countCredentialsAwaitingRotation,
  loadIntegrationCredential,
  storeIntegrationCredential,
} from '../services/integration-credential.service.js';
import { sealIntegrationSecret } from '../services/integration-crypto.js';

const key = randomBytes(32);

function withKey<T>(run: () => T): T {
  const previous = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = key.toString('hex');
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
    else process.env.INTEGRATION_ENCRYPTION_KEY = previous;
  }
}

function fakePrisma(row: unknown = null) {
  const upserts: unknown[] = [];
  return {
    upserts,
    client: {
      integrationSecretControl: { findUnique: async () => ({ id: 1, generation: 3 }) },
      integrationCredential: {
        upsert: async (args: unknown) => { upserts.push(args); return {}; },
        findUnique: async () => row,
        count: async () => 2,
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
  const sealed = sealIntegrationSecret('atlassian-refresh-token', key, 3);
  const { client } = fakePrisma({ sealed, generation: 3 });

  const loaded = await withKey(() =>
    loadIntegrationCredential(client as never, { integrationId: 'int-1', kind: 'refresh_token' }),
  );
  assert.equal(await loaded, 'atlassian-refresh-token');
});

test('a missing credential loads as null rather than throwing', async () => {
  const { client } = fakePrisma(null);
  const loaded = await withKey(() =>
    loadIntegrationCredential(client as never, { integrationId: 'int-1', kind: 'refresh_token' }),
  );
  assert.equal(await loaded, null);
});

test('rows sealed under an older generation are countable without opening them', async () => {
  const { client } = fakePrisma();
  assert.equal(await countCredentialsAwaitingRotation(client as never, 3), 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run build && node --test dist/tests/integration-credential.service.test.js
```

Expected: build fails — the service module does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/integration-credential.service.ts`. Read the active key from `INTEGRATION_ENCRYPTION_KEY` via `decodeIntegrationKey`, read the active generation from the `IntegrationSecretControl` row with `id: 1` (defaulting to `1` when absent), seal on write, open on read, and expose a count of rows whose `generation` is below the active one. Store `generation` as a column alongside the `sealed` JSON so the count needs no decryption.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run build && node --test dist/tests/integration-credential.service.test.js
```

Expected: 4 passing tests.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

Expected: main suite 1054 + your new tests, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/integration-credential.service.ts apps/api/src/tests/integration-credential.service.test.ts
git commit -m "feat(integrations): store and load tenant credentials through the sealed envelope

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Carried Phase 0 fix — deployment-consistency of the local-provider gate

**Files:**
- Modify: `apps/api/src/services/document-storage-resolution.ts`
- Test: `apps/api/src/tests/document-storage-resolution.test.ts` (append)
- Modify: `docs/ARCHITECTURE.md`

**The problem, found by the Phase 0 whole-branch re-review.** Phase 0 added `assertProviderPermittedByDeployment`, which refuses a per-organisation `'local'` provider in production. It decides production-ness with `isProductionEnv()`. But `apps/api/src/jobs/cleanup-document-storage.ts` and `apps/api/src/jobs/production-scheduler.ts` both execute `process.env.NODE_ENV ??= 'production'` at module load, while the web routes do not.

So on a dev or staging deployment with a Supabase default, an organisation pinned to `'local'` would **upload successfully through the route** and then have its **deletion refused by the cleanup job**, stalling the reconciliation pipeline on a document the same deployment wrote. Unreachable while nothing writes the column — which stops being true the moment Phase 2 ships a connect flow.

**The fix:** apply the gate on the **write path only**. Its purpose is to stop a production deployment writing bytes to an unvalidated, ephemeral, un-backed-up local path. Once bytes exist, refusing to read or delete them strands them — strictly worse, and in the delete case it breaks a provable-erasure guarantee. Reading and deleting what is already there must always be possible.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/tests/document-storage-resolution.test.ts`:

```ts
test('a production deployment refuses a local provider for writes', async () => {
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

test('a production deployment still allows reading and deleting existing local documents', async () => {
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

test('the operation defaults to write, so an unqualified call stays strict', async () => {
  await withNodeEnv('production', async () => {
    await assert.rejects(() => resolveProviderForOrganisation('org-a', localResolver, registry));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run build && node --test dist/tests/document-storage-resolution.test.js
```

Expected: FAIL — `resolveProviderForOrganisation` takes no options argument, so the read and delete cases reject.

- [ ] **Step 3: Write the implementation**

Give `resolveProviderForOrganisation` a fourth parameter `options: { operation?: 'read' | 'write' | 'delete' } = {}`, defaulting `operation` to `'write'` so any unqualified call keeps the strict behaviour. Call `assertProviderPermittedByDeployment` only when `operation === 'write'`.

Then in `apps/api/src/services/storage.service.ts`, have `providerFor` take the operation and pass it through: `uploadFile` passes `'write'`, `downloadFile` passes `'read'`, `deleteFile` passes `'delete'`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run build && node --test dist/tests/document-storage-resolution.test.js dist/tests/storage.service.test.js dist/tests/documents-route.test.js
```

Expected: PASS, with every pre-existing test unchanged.

- [ ] **Step 5: Document it**

In the document-storage section of `docs/ARCHITECTURE.md`, record the rule: the production local-provider gate applies to writes only, because refusing reads and deletes would strand existing bytes and break provable erasure. Note also that the background jobs default `NODE_ENV` to `production` while the web process does not, which is why the gate must not depend on the two agreeing.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm test
```

```bash
git add apps/api/src/services/document-storage-resolution.ts apps/api/src/services/storage.service.ts apps/api/src/tests/document-storage-resolution.test.ts docs/ARCHITECTURE.md
git commit -m "fix(storage): apply the production local-provider gate to writes only

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Done when

- `npm test` passes in `apps/api` with no pre-existing test modified to accommodate the change.
- A secret sealed by `sealIntegrationSecret` cannot be recovered from the database row, and a tampered envelope fails closed.
- `INTEGRATION_ENCRYPTION_KEY` is required in production, must decode to 32 bytes, and must differ from every other secret.
- An organisation pinned to `'local'` in production is refused on upload but can still download and delete what it already has.
- No Confluence client code exists — only the `CONFLUENCE` enum value, which nothing constructs yet.

## Explicitly not in this phase

- Any Confluence API client, OAuth flow, or connect/disconnect route. **Phase 2 — blocked until the Atlassian MCP app is installed on `hour-timebank.atlassian.net`.**
- The key-rotation job itself. Task 4 exposes the count of rows awaiting rotation; the job that re-seals them follows once there is anything to rotate.
- Pinning the `requireUsableDocumentStorageDefault` call site in `env.ts`. It cannot be pinned end-to-end while the registry is GA-only; do it in the phase that registers Confluence as `alpha`.
