# Platform Owner Console and Multi-Tenant Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a platform-owner console that lists, provisions and suspends tenants, and make tenant login explain a suspension instead of reporting it as a bad password.

**Architecture:** A `PlatformOperator` identity lives entirely outside the tenant graph — no `organisationId`, no foreign key to `Organisation` or `User` — and is authenticated with its own JWT secret, issuer, audience and cookie. Owner routes mount under `/api/v1/owner` and are not registered at all in personal-server mode. Tenant lifecycle changes write `Organisation.lifecycleStatus` and a `SecurityAuditEvent` in one transaction, guarded by the existing `lifecycleVersion` optimistic-concurrency pattern.

**Tech Stack:** Fastify 5, Prisma 6, PostgreSQL, `jsonwebtoken`, `bcryptjs`, Zod, `node:test` + `node:assert/strict`, Next.js 16 app router, React 19, HeroUI v2.

**Spec:** `docs/superpowers/specs/2026-08-30-owner-console-and-multi-tenant-login-design.md`

## Global Constraints

- API tests compile first: `npm test` in `apps/api` runs `tsc -p tsconfig.json` then `node --test dist/tests/*.test.js`. A targeted run is `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/<name>.test.js`.
- Test files live in `apps/api/src/tests/*.test.ts` and compile to `dist/tests/*.test.js`.
- Every relative import in `apps/api` carries a `.js` extension, including imports of `.ts` sources. This is required by the ESM build.
- Tests set required env vars **before** dynamic imports, because modules read env at import time. Follow the `await Promise.all([import(...)])` pattern in `apps/api/src/tests/team-reliability.test.ts`.
- `OWNER_JWT_SECRET` must be resolved **lazily** inside functions, never at module load. `JWT_SECRET` is resolved at load in `utils/jwt.ts`; copying that would break personal-server installs, which must run without an owner secret.
- Owner identifiers: secret `OWNER_JWT_SECRET`, issuer `charitypilot-owner-api`, audience `charitypilot-owner`, access cookie `charitypilot_owner_access`, refresh cookie `charitypilot_owner_refresh`, cookie `Path` `/api/v1/owner`, access TTL 30 minutes.
- Error responses use `AppError(statusCode, code, message)` from `utils/errors.js` and are sent via `handleError(reply, err)`.
- Never change `TokenPayload` in `apps/api/src/utils/jwt.ts`. The test at `apps/api/src/tests/team-reliability.test.ts:582` asserts `SUPERADMIN` is a rejected role and must keep passing.

---

### Task 1: Platform operator schema and migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_platform_operator/migration.sql` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `PlatformOperator`, `PlatformOperatorSession`, enum `OperatorLifecycleStatus`. Client accessors `prisma.platformOperator` and `prisma.platformOperatorSession`.

- [ ] **Step 1: Add the enum and models to the schema**

Append to `apps/api/prisma/schema.prisma`:

```prisma
enum OperatorLifecycleStatus {
  ACTIVE
  SUSPENDED
}

model PlatformOperator {
  id              String                  @id @default(cuid())
  email           String                  @unique
  name            String
  passwordHash    String
  lifecycleStatus OperatorLifecycleStatus @default(ACTIVE)

  resetToken       String?   @unique
  resetTokenExpiry DateTime?

  sessions  PlatformOperatorSession[]
  createdAt DateTime                  @default(now())
  updatedAt DateTime                  @updatedAt
}

model PlatformOperatorSession {
  id         String           @id @default(cuid())
  operatorId String
  operator   PlatformOperator @relation(fields: [operatorId], references: [id], onDelete: Cascade)
  tokenHash  String           @unique
  revokedAt  DateTime?
  expiresAt  DateTime
  createdAt  DateTime         @default(now())

  @@index([operatorId, revokedAt, expiresAt])
}
```

`resetToken` / `resetTokenExpiry` exist so the bootstrap CLI in Task 6 can issue a set-password link instead of taking a password on the command line.

- [ ] **Step 2: Generate the migration**

Run: `cd apps/api && npx prisma migrate dev --name add_platform_operator`
Expected: a new folder under `prisma/migrations/`, and `CREATE TABLE "PlatformOperator"` in its `migration.sql`.

- [ ] **Step 3: Verify no existing table was altered**

Run: `cd apps/api && grep -E 'ALTER TABLE "(User|Organisation|Subscription|SecurityAuditEvent)"|DROP' prisma/migrations/*_add_platform_operator/migration.sql`
Expected: no output. Prisma legitimately emits `ALTER TABLE "PlatformOperatorSession" ADD CONSTRAINT … FOREIGN KEY` for the operator→session relation; that is additive and expected. What must NOT appear is any `ALTER TABLE` against an existing tenant table, or any `DROP`.

- [ ] **Step 4: Regenerate the client and typecheck**

Run: `cd apps/api && npm run db:generate && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(owner): add PlatformOperator schema and migration"
```

---

### Task 2: Owner JWT utility and boot-time secret guard

**Files:**
- Create: `apps/api/src/utils/owner-jwt.ts`
- Create: `apps/api/src/tests/owner-jwt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface OperatorTokenPayload { operatorId: string; sessionId: string }`
  - `signOperatorAccessToken(payload: OperatorTokenPayload): string`
  - `verifyOperatorAccessToken(token: string): OperatorTokenPayload`
  - `assertOwnerJwtSecretConfigured(env?: NodeJS.ProcessEnv): void`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/owner-jwt.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-for-owner-jwt-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-for-owner-jwt-test';

const [{ signOperatorAccessToken, verifyOperatorAccessToken, assertOwnerJwtSecretConfigured }, { signAccessToken }] =
  await Promise.all([import('../utils/owner-jwt.js'), import('../utils/jwt.js')]);

test('an operator token round-trips', () => {
  const token = signOperatorAccessToken({ operatorId: 'op-1', sessionId: 's-1' });
  assert.deepEqual(verifyOperatorAccessToken(token), { operatorId: 'op-1', sessionId: 's-1' });
});

test('a tenant token is rejected by the operator verifier', () => {
  const tenantToken = signAccessToken({
    userId: 'u-1',
    organisationId: 'org-1',
    role: 'OWNER',
    sessionId: 's-1',
  });
  assert.throws(() => verifyOperatorAccessToken(tenantToken));
});

test('a token signed with the tenant secret but operator claims is rejected', async () => {
  // Proves isolation comes from the SECRET, not only from the claim shape:
  // an attacker who learns JWT_SECRET still cannot mint an owner token.
  const jwt = (await import('jsonwebtoken')).default;
  const forged = jwt.sign({ operatorId: 'op-1', sessionId: 's-1' }, process.env.JWT_SECRET as string, {
    algorithm: 'HS256',
    issuer: 'charitypilot-owner-api',
    audience: 'charitypilot-owner',
    expiresIn: '30m',
  });
  assert.throws(() => verifyOperatorAccessToken(forged));
});

test('a payload missing operatorId is rejected', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const bad = jwt.sign({ sessionId: 's-1' }, process.env.OWNER_JWT_SECRET as string, {
    algorithm: 'HS256',
    issuer: 'charitypilot-owner-api',
    audience: 'charitypilot-owner',
    expiresIn: '30m',
  });
  assert.throws(() => verifyOperatorAccessToken(bad), /Invalid operator token payload/);
});

test('the boot guard rejects a missing secret', () => {
  assert.throws(
    () => assertOwnerJwtSecretConfigured({ JWT_SECRET: 'a' } as NodeJS.ProcessEnv),
    /OWNER_JWT_SECRET/,
  );
});

test('the boot guard rejects a secret equal to JWT_SECRET', () => {
  assert.throws(
    () => assertOwnerJwtSecretConfigured({ JWT_SECRET: 'same', OWNER_JWT_SECRET: 'same' } as NodeJS.ProcessEnv),
    /must not equal JWT_SECRET/,
  );
});

test('the boot guard accepts distinct secrets', () => {
  assert.doesNotThrow(() =>
    assertOwnerJwtSecretConfigured({ JWT_SECRET: 'a', OWNER_JWT_SECRET: 'b' } as NodeJS.ProcessEnv),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-jwt.test.js`
Expected: FAIL — cannot find module `../utils/owner-jwt.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/utils/owner-jwt.ts`:

```ts
import jwt from 'jsonwebtoken';

const OWNER_TOKEN_ALGORITHM = 'HS256';
const OWNER_TOKEN_ISSUER = 'charitypilot-owner-api';
const OWNER_TOKEN_AUDIENCE = 'charitypilot-owner';
const OWNER_TOKEN_EXPIRY = '30m';

export interface OperatorTokenPayload {
  operatorId: string;
  sessionId: string;
}

// Resolved lazily, never at module load. Personal-server installs never set
// OWNER_JWT_SECRET and must still boot: a module-load requireEnv (as in
// utils/jwt.ts) would crash them on import.
function ownerSecret(): string {
  const value = process.env.OWNER_JWT_SECRET;
  if (!value) {
    throw new Error('FATAL: OWNER_JWT_SECRET environment variable must be set to use the owner console.');
  }
  return value;
}

export function assertOwnerJwtSecretConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const secret = env.OWNER_JWT_SECRET;
  if (!secret) {
    throw new Error('FATAL: OWNER_JWT_SECRET must be set when the owner console is enabled.');
  }
  if (secret === env.JWT_SECRET) {
    throw new Error('FATAL: OWNER_JWT_SECRET must not equal JWT_SECRET; the two-secret isolation would be lost.');
  }
}

export function signOperatorAccessToken(payload: OperatorTokenPayload): string {
  return jwt.sign(payload, ownerSecret(), {
    algorithm: OWNER_TOKEN_ALGORITHM,
    issuer: OWNER_TOKEN_ISSUER,
    audience: OWNER_TOKEN_AUDIENCE,
    expiresIn: OWNER_TOKEN_EXPIRY,
  });
}

export function verifyOperatorAccessToken(token: string): OperatorTokenPayload {
  const decoded = jwt.verify(token, ownerSecret(), {
    algorithms: [OWNER_TOKEN_ALGORITHM],
    issuer: OWNER_TOKEN_ISSUER,
    audience: OWNER_TOKEN_AUDIENCE,
  });

  if (!decoded || typeof decoded !== 'object') {
    throw new Error('Invalid operator token payload');
  }

  const payload = decoded as Partial<OperatorTokenPayload> & { organisationId?: unknown; role?: unknown };
  if (typeof payload.operatorId !== 'string' || typeof payload.sessionId !== 'string') {
    throw new Error('Invalid operator token payload');
  }
  // A token carrying tenant claims is not an operator token, whatever it is signed with.
  if (payload.organisationId !== undefined || payload.role !== undefined) {
    throw new Error('Invalid operator token payload');
  }

  return { operatorId: payload.operatorId, sessionId: payload.sessionId };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-jwt.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/utils/owner-jwt.ts apps/api/src/tests/owner-jwt.test.ts
git commit -m "feat(owner): add operator JWT utility with its own secret and audience"
```

---

### Task 3: Operator session service

**Files:**
- Create: `apps/api/src/services/operator-session.service.ts`
- Create: `apps/api/src/tests/operator-session.test.ts`

**Interfaces:**
- Consumes: `signOperatorAccessToken` (Task 2), `prisma.platformOperatorSession` (Task 1).
- Produces:
  - `type OperatorTokens = { accessToken: string; refreshToken: string }`
  - `issueOperatorSession(prisma, operatorId: string): Promise<OperatorTokens>`
  - `rotateOperatorSession(prisma, refreshToken: string): Promise<OperatorTokens>`
  - `revokeOperatorSession(prisma, refreshToken: string): Promise<void>`
  - `hashOperatorToken(token: string): string`
  - `operatorRefreshMaxAgeSeconds(): number`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/operator-session.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-operator-session-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-operator-session-test';

const [{ issueOperatorSession, rotateOperatorSession, revokeOperatorSession, hashOperatorToken }] =
  await Promise.all([import('../services/operator-session.service.js')]);

function sessionStore() {
  const rows: Record<string, { id: string; operatorId: string; tokenHash: string; revokedAt: Date | null; expiresAt: Date }> = {};
  let n = 0;
  return {
    rows,
    prisma: {
      platformOperatorSession: {
        create: async ({ data }: { data: { operatorId: string; tokenHash: string; expiresAt: Date } }) => {
          const id = `sess-${++n}`;
          rows[id] = { id, operatorId: data.operatorId, tokenHash: data.tokenHash, revokedAt: null, expiresAt: data.expiresAt };
          return rows[id];
        },
        findFirst: async ({ where }: { where: { tokenHash: string } }) =>
          Object.values(rows).find(
            (r) => r.tokenHash === where.tokenHash && r.revokedAt === null && r.expiresAt > new Date(),
          ) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          Object.assign(rows[where.id], data);
          return rows[where.id];
        },
      },
    } as never,
  };
}

test('issuing a session stores only the hash of the refresh token', async () => {
  const { prisma, rows } = sessionStore();
  const tokens = await issueOperatorSession(prisma, 'op-1');

  assert.ok(tokens.accessToken.length > 0);
  assert.ok(tokens.refreshToken.length > 0);
  const stored = Object.values(rows)[0];
  assert.equal(stored.tokenHash, hashOperatorToken(tokens.refreshToken));
  assert.notEqual(stored.tokenHash, tokens.refreshToken, 'the raw refresh token must never be stored');
});

test('rotating a session revokes the old refresh token', async () => {
  const { prisma, rows } = sessionStore();
  const first = await issueOperatorSession(prisma, 'op-1');
  const second = await rotateOperatorSession(prisma, first.refreshToken);

  assert.notEqual(second.refreshToken, first.refreshToken);
  const old = Object.values(rows).find((r) => r.tokenHash === hashOperatorToken(first.refreshToken));
  assert.ok(old?.revokedAt instanceof Date, 'the rotated token must be revoked');
});

test('a revoked refresh token cannot be rotated again', async () => {
  const { prisma } = sessionStore();
  const first = await issueOperatorSession(prisma, 'op-1');
  await rotateOperatorSession(prisma, first.refreshToken);

  await assert.rejects(() => rotateOperatorSession(prisma, first.refreshToken), /INVALID_OPERATOR_REFRESH/);
});

test('logging out revokes the session', async () => {
  const { prisma, rows } = sessionStore();
  const tokens = await issueOperatorSession(prisma, 'op-1');
  await revokeOperatorSession(prisma, tokens.refreshToken);

  const row = Object.values(rows)[0];
  assert.ok(row.revokedAt instanceof Date);
});

test('revoking an unknown token is a no-op rather than an error', async () => {
  const { prisma } = sessionStore();
  await assert.doesNotReject(() => revokeOperatorSession(prisma, 'not-a-real-token'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/operator-session.test.js`
Expected: FAIL — cannot find module `../services/operator-session.service.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/operator-session.service.ts`:

```ts
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { signOperatorAccessToken } from '../utils/owner-jwt.js';

const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_DAYS = 7;

export type OperatorTokens = {
  accessToken: string;
  refreshToken: string;
};

export function hashOperatorToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function operatorRefreshMaxAgeSeconds(): number {
  return REFRESH_TOKEN_DAYS * 24 * 60 * 60;
}

function refreshExpiry(): Date {
  return new Date(Date.now() + operatorRefreshMaxAgeSeconds() * 1000);
}

export async function issueOperatorSession(
  prisma: PrismaClient,
  operatorId: string,
): Promise<OperatorTokens> {
  const refreshToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

  const session = await prisma.platformOperatorSession.create({
    data: { operatorId, tokenHash: hashOperatorToken(refreshToken), expiresAt: refreshExpiry() },
  });

  return {
    accessToken: signOperatorAccessToken({ operatorId, sessionId: session.id }),
    refreshToken,
  };
}

export async function rotateOperatorSession(
  prisma: PrismaClient,
  refreshToken: string,
): Promise<OperatorTokens> {
  const existing = await prisma.platformOperatorSession.findFirst({
    where: { tokenHash: hashOperatorToken(refreshToken), revokedAt: null, expiresAt: { gt: new Date() } },
  });

  if (!existing) {
    throw new AppError(401, 'INVALID_OPERATOR_REFRESH', 'Invalid or expired session');
  }

  await prisma.platformOperatorSession.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  return issueOperatorSession(prisma, existing.operatorId);
}

export async function revokeOperatorSession(
  prisma: PrismaClient,
  refreshToken: string,
): Promise<void> {
  const existing = await prisma.platformOperatorSession.findFirst({
    where: { tokenHash: hashOperatorToken(refreshToken), revokedAt: null },
  });
  if (!existing) return;

  await prisma.platformOperatorSession.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/operator-session.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/operator-session.service.ts apps/api/src/tests/operator-session.test.ts
git commit -m "feat(owner): add operator session issue, rotate and revoke"
```

---

### Task 4: Owner cookies and the requirePlatformOperator guard

**Files:**
- Create: `apps/api/src/utils/owner-cookies.ts`
- Create: `apps/api/src/middleware/owner-auth.ts`
- Create: `apps/api/src/tests/owner-auth-middleware.test.ts`

**Interfaces:**
- Consumes: `verifyOperatorAccessToken` (Task 2), `operatorRefreshMaxAgeSeconds` (Task 3).
- Produces:
  - `OWNER_ACCESS_TOKEN_COOKIE`, `OWNER_REFRESH_TOKEN_COOKIE` constants
  - `setOwnerCookies(reply, tokens)`, `clearOwnerCookies(reply)`, `getOwnerRefreshTokenFromRequest(request)`
  - `requirePlatformOperator(request, reply): Promise<void>` — decorates `request.operator: { id: string; email: string }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/owner-auth-middleware.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-owner-mw-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-owner-mw-test';

const [{ default: Fastify }, { requirePlatformOperator }, { signOperatorAccessToken }, { signAccessToken }] =
  await Promise.all([
    import('fastify'),
    import('../middleware/owner-auth.js'),
    import('../utils/owner-jwt.js'),
    import('../utils/jwt.js'),
  ]);

function appWith(operatorRow: unknown, sessionRow: unknown) {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    platformOperatorSession: { findFirst: async () => sessionRow },
    platformOperator: { findUnique: async () => operatorRow },
  } as never);
  app.get('/probe', { preHandler: [requirePlatformOperator] }, async (request) => ({
    operatorId: (request as { operator?: { id: string } }).operator?.id,
  }));
  return app;
}

const activeOperator = { id: 'op-1', email: 'owner@example.org', lifecycleStatus: 'ACTIVE' };
const liveSession = { id: 's-1', operatorId: 'op-1' };

test('a valid operator token is accepted and decorates request.operator', async () => {
  const app = appWith(activeOperator, liveSession);
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${signOperatorAccessToken({ operatorId: 'op-1', sessionId: 's-1' })}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().operatorId, 'op-1');
  await app.close();
});

test('a tenant token is rejected', async () => {
  const app = appWith(activeOperator, liveSession);
  const tenantToken = signAccessToken({ userId: 'u-1', organisationId: 'org-1', role: 'OWNER', sessionId: 's-1' });
  const res = await app.inject({ method: 'GET', url: '/probe', headers: { authorization: `Bearer ${tenantToken}` } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'OWNER_UNAUTHORIZED');
  await app.close();
});

test('a missing token is rejected', async () => {
  const app = appWith(activeOperator, liveSession);
  const res = await app.inject({ method: 'GET', url: '/probe' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('a revoked session is rejected even with a valid signature', async () => {
  const app = appWith(activeOperator, null);
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${signOperatorAccessToken({ operatorId: 'op-1', sessionId: 's-1' })}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('a suspended operator is rejected', async () => {
  const app = appWith({ ...activeOperator, lifecycleStatus: 'SUSPENDED' }, liveSession);
  const res = await app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${signOperatorAccessToken({ operatorId: 'op-1', sessionId: 's-1' })}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-auth-middleware.test.js`
Expected: FAIL — cannot find module `../middleware/owner-auth.js`.

- [ ] **Step 3: Write the cookie helper**

Create `apps/api/src/utils/owner-cookies.ts`:

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { operatorRefreshMaxAgeSeconds } from '../services/operator-session.service.js';
import { personalServerAllowsInsecureCookies } from './personal-server.js';

export const OWNER_ACCESS_TOKEN_COOKIE = 'charitypilot_owner_access';
export const OWNER_REFRESH_TOKEN_COOKIE = 'charitypilot_owner_refresh';

// Scoped to the owner API path so the cookie is never transmitted on ordinary
// tenant requests.
const OWNER_COOKIE_PATH = '/api/v1/owner';

function ownerCookieOptions(maxAge: number) {
  const secure = process.env.NODE_ENV === 'production' && !personalServerAllowsInsecureCookies();
  return {
    path: OWNER_COOKIE_PATH,
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    maxAge,
    domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
  };
}

export function setOwnerCookies(
  reply: FastifyReply,
  tokens: { accessToken: string; refreshToken: string },
): void {
  reply.setCookie(OWNER_ACCESS_TOKEN_COOKIE, tokens.accessToken, ownerCookieOptions(30 * 60));
  reply.setCookie(OWNER_REFRESH_TOKEN_COOKIE, tokens.refreshToken, ownerCookieOptions(operatorRefreshMaxAgeSeconds()));
}

export function clearOwnerCookies(reply: FastifyReply): void {
  const options = ownerCookieOptions(0);
  reply.clearCookie(OWNER_ACCESS_TOKEN_COOKIE, options);
  reply.clearCookie(OWNER_REFRESH_TOKEN_COOKIE, options);
}

export function getOwnerRefreshTokenFromRequest(request: FastifyRequest): string | undefined {
  return request.cookies?.[OWNER_REFRESH_TOKEN_COOKIE];
}

export function getOwnerAccessTokenFromRequest(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return request.cookies?.[OWNER_ACCESS_TOKEN_COOKIE];
}
```

- [ ] **Step 4: Write the middleware**

Create `apps/api/src/middleware/owner-auth.ts`:

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyOperatorAccessToken } from '../utils/owner-jwt.js';
import { getOwnerAccessTokenFromRequest } from '../utils/owner-cookies.js';

declare module 'fastify' {
  interface FastifyRequest {
    operator: { id: string; email: string };
  }
}

function unauthorized(reply: FastifyReply): void {
  reply.status(401).send({ error: 'Owner authentication required', code: 'OWNER_UNAUTHORIZED' });
}

export async function requirePlatformOperator(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = getOwnerAccessTokenFromRequest(request);
  if (!token) {
    unauthorized(reply);
    return;
  }

  let payload: { operatorId: string; sessionId: string };
  try {
    payload = verifyOperatorAccessToken(token);
  } catch {
    unauthorized(reply);
    return;
  }

  // The signature alone is not enough: the session must still be live and the
  // operator still active, re-read on every request as middleware/auth.ts does.
  const [session, operator] = await Promise.all([
    request.server.prisma.platformOperatorSession.findFirst({
      where: {
        id: payload.sessionId,
        operatorId: payload.operatorId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    }),
    request.server.prisma.platformOperator.findUnique({
      where: { id: payload.operatorId },
      select: { id: true, email: true, lifecycleStatus: true },
    }),
  ]);

  if (!session || !operator || operator.lifecycleStatus !== 'ACTIVE') {
    unauthorized(reply);
    return;
  }

  request.operator = { id: operator.id, email: operator.email };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-auth-middleware.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/utils/owner-cookies.ts apps/api/src/middleware/owner-auth.ts apps/api/src/tests/owner-auth-middleware.test.ts
git commit -m "feat(owner): add scoped owner cookies and requirePlatformOperator guard"
```

---

### Task 5: Owner auth routes and personal-server gating

**Files:**
- Create: `apps/api/src/routes/owner/auth.ts`
- Create: `apps/api/src/routes/owner/index.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/src/tests/owner-auth-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `ownerRoutes(app: FastifyInstance)` registered at prefix `/api/v1/owner`; endpoints `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/owner-auth-routes.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-owner-routes-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-owner-routes-test';

const [{ default: Fastify }, { default: cookie }, { default: rateLimit }, bcrypt, { ownerRoutes }] =
  await Promise.all([
    import('fastify'),
    import('@fastify/cookie'),
    import('@fastify/rate-limit'),
    import('bcryptjs'),
    import('../routes/owner/index.js'),
  ]);

const PASSWORD = 'correct-horse-battery-staple';

async function buildApp(operator: Record<string, unknown> | null) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.decorate('prisma', {
    platformOperator: { findUnique: async () => operator },
    platformOperatorSession: {
      create: async ({ data }: { data: unknown }) => ({ id: 's-1', ...(data as object) }),
      findFirst: async () => null,
      update: async () => ({}),
    },
  } as never);
  await app.register(ownerRoutes, { prefix: '/api/v1/owner' });
  return app;
}

test('a correct operator password issues owner cookies', async () => {
  const app = await buildApp({
    id: 'op-1',
    email: 'owner@example.org',
    name: 'Owner',
    passwordHash: await bcrypt.default.hash(PASSWORD, 10),
    lifecycleStatus: 'ACTIVE',
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/login',
    payload: { email: 'owner@example.org', password: PASSWORD },
  });

  assert.equal(res.statusCode, 200);
  const setCookie = res.headers['set-cookie'] as string[] | string;
  const cookies = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
  assert.match(cookies, /charitypilot_owner_access=/);
  assert.match(cookies, /Path=\/api\/v1\/owner/);
  assert.doesNotMatch(cookies, /charitypilot_access=/, 'owner login must not set tenant cookies');
  await app.close();
});

test('a wrong operator password is rejected', async () => {
  const app = await buildApp({
    id: 'op-1',
    email: 'owner@example.org',
    name: 'Owner',
    passwordHash: await bcrypt.default.hash(PASSWORD, 10),
    lifecycleStatus: 'ACTIVE',
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/login',
    payload: { email: 'owner@example.org', password: 'wrong' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'INVALID_CREDENTIALS');
  await app.close();
});

test('an unknown operator email is indistinguishable from a wrong password', async () => {
  const app = await buildApp(null);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/login',
    payload: { email: 'nobody@example.org', password: PASSWORD },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'INVALID_CREDENTIALS');
  await app.close();
});

test('a suspended operator cannot log in', async () => {
  const app = await buildApp({
    id: 'op-1',
    email: 'owner@example.org',
    name: 'Owner',
    passwordHash: await bcrypt.default.hash(PASSWORD, 10),
    lifecycleStatus: 'SUSPENDED',
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/login',
    payload: { email: 'owner@example.org', password: PASSWORD },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('owner routes are not registered in personal-server mode', async () => {
  process.env.CHARITYPILOT_DEPLOYMENT_MODE = 'personal-server';
  try {
    const app = await buildApp({
      id: 'op-1',
      email: 'owner@example.org',
      name: 'Owner',
      passwordHash: await bcrypt.default.hash(PASSWORD, 10),
      lifecycleStatus: 'ACTIVE',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/auth/login',
      payload: { email: 'owner@example.org', password: PASSWORD },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  } finally {
    delete process.env.CHARITYPILOT_DEPLOYMENT_MODE;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-auth-routes.test.js`
Expected: FAIL — cannot find module `../routes/owner/index.js`.

- [ ] **Step 3: Write the auth routes**

Create `apps/api/src/routes/owner/auth.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z, ZodError } from 'zod';
import { AppError, handleError } from '../../utils/errors.js';
import { bodyIdentifierRateLimit } from '../../utils/identifier-rate-limit.js';
import {
  issueOperatorSession,
  rotateOperatorSession,
  revokeOperatorSession,
} from '../../services/operator-session.service.js';
import {
  setOwnerCookies,
  clearOwnerCookies,
  getOwnerRefreshTokenFromRequest,
} from '../../utils/owner-cookies.js';
import { requirePlatformOperator } from '../../middleware/owner-auth.js';

// Same constant-time defence as tenant login: an unknown operator email must
// cost the same bcrypt work as a wrong password, or operator addresses can be
// enumerated by response timing.
const DUMMY_PASSWORD_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export async function ownerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/auth/login',
    { config: { rateLimit: bodyIdentifierRateLimit(['email']) } },
    async (request, reply) => {
      try {
        const body = loginSchema.parse(request.body);
        const email = body.email.trim().toLowerCase();

        const operator = await app.prisma.platformOperator.findUnique({
          where: { email },
          select: { id: true, email: true, name: true, passwordHash: true, lifecycleStatus: true },
        });

        if (!operator) {
          await bcrypt.compare(body.password, DUMMY_PASSWORD_HASH);
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
        }

        const valid = await bcrypt.compare(body.password, operator.passwordHash);
        if (!valid || operator.lifecycleStatus !== 'ACTIVE') {
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
        }

        const tokens = await issueOperatorSession(app.prisma, operator.id);
        setOwnerCookies(reply, tokens);
        reply.send({ operator: { id: operator.id, email: operator.email, name: operator.name } });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
          return;
        }
        handleError(reply, err);
      }
    },
  );

  app.post('/auth/refresh', async (request, reply) => {
    try {
      const refreshToken = getOwnerRefreshTokenFromRequest(request);
      if (!refreshToken) {
        throw new AppError(401, 'INVALID_OPERATOR_REFRESH', 'Missing session');
      }
      const tokens = await rotateOperatorSession(app.prisma, refreshToken);
      setOwnerCookies(reply, tokens);
      reply.send({ ok: true });
    } catch (err) {
      clearOwnerCookies(reply);
      handleError(reply, err);
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const refreshToken = getOwnerRefreshTokenFromRequest(request);
    if (refreshToken) await revokeOperatorSession(app.prisma, refreshToken);
    clearOwnerCookies(reply);
    reply.send({ message: 'Signed out' });
  });

  app.get('/auth/me', { preHandler: [requirePlatformOperator] }, async (request, reply) => {
    reply.send({ operator: request.operator });
  });
}
```

- [ ] **Step 4: Write the owner route index with the deployment gate**

Create `apps/api/src/routes/owner/index.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isPersonalServerDeployment } from '../../utils/personal-server.js';
import { ownerAuthRoutes } from './auth.js';

// Optional extra tightening: when OWNER_ALLOWED_ORIGINS is set, the console
// answers only requests from those origins, so it can be moved behind Tailscale
// or a private hostname later without a rewrite. Unset means "same policy as the
// tenant app", so this is opt-in hardening and never a deployment blocker.
function ownerOriginGuard(app: FastifyInstance): void {
  const configured = process.env.OWNER_ALLOWED_ORIGINS?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!configured?.length) return;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    // A same-origin, non-CORS request sends no Origin header; the existing
    // browser-origin-protection plugin already covers unsafe methods there.
    if (!origin) return;
    if (!configured.includes(origin)) {
      reply.status(403).send({ error: 'Not found', code: 'OWNER_ORIGIN_REJECTED' });
    }
  });
}

export async function ownerRoutes(app: FastifyInstance): Promise<void> {
  // Single-charity installs must not expose a platform console at all. Returning
  // before registering anything means every owner path 404s naturally.
  if (isPersonalServerDeployment()) return;

  ownerOriginGuard(app);
  await app.register(ownerAuthRoutes);
}
```

Add to the Task 5 test file, after the personal-server test:

```ts
test('a configured owner origin allowlist rejects other origins', async () => {
  process.env.OWNER_ALLOWED_ORIGINS = 'https://console.example.org';
  try {
    const app = await buildApp({
      id: 'op-1',
      email: 'owner@example.org',
      name: 'Owner',
      passwordHash: await bcrypt.default.hash(PASSWORD, 10),
      lifecycleStatus: 'ACTIVE',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/auth/login',
      headers: { origin: 'https://evil.example.org' },
      payload: { email: 'owner@example.org', password: PASSWORD },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'OWNER_ORIGIN_REJECTED');
    await app.close();
  } finally {
    delete process.env.OWNER_ALLOWED_ORIGINS;
  }
});
```

- [ ] **Step 5: Register the routes and add the boot guard**

In `apps/api/src/server.ts`, add the import alongside the other route imports:

```ts
import { ownerRoutes } from './routes/owner/index.js';
import { assertOwnerJwtSecretConfigured } from './utils/owner-jwt.js';
import { isPersonalServerDeployment } from './utils/personal-server.js';
```

Add the boot guard immediately before the route registrations:

```ts
// A deployment that serves the owner console must have a distinct owner secret.
// Collapsing the two secrets would silently remove the isolation the console relies on.
if (!isPersonalServerDeployment()) {
  assertOwnerJwtSecretConfigured();
}
```

Add the registration after the existing `healthRoutes` line:

```ts
await app.register(ownerRoutes, { prefix: '/api/v1/owner' });
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-auth-routes.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 7: Run the full API suite to confirm nothing regressed**

Run: `cd apps/api && npm test`
Expected: PASS. If it fails because `OWNER_JWT_SECRET` is unset, set it in `apps/api/.env` to a value different from `JWT_SECRET` — that failure is the boot guard working correctly.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/owner apps/api/src/server.ts apps/api/src/tests/owner-auth-routes.test.ts
git commit -m "feat(owner): add owner auth routes, deployment gate and boot secret guard"
```

---

### Task 6: Bootstrap CLI for the first operator

**Files:**
- Create: `apps/api/src/jobs/create-platform-operator.ts`
- Modify: `apps/api/package.json` (add `jobs:create-platform-operator`)
- Modify: `package.json` (add root `owner:create`)
- Create: `apps/api/src/tests/create-platform-operator.test.ts`

**Interfaces:**
- Consumes: `prisma.platformOperator` (Task 1).
- Produces: `createPlatformOperator(prisma, input: { email: string; name: string }): Promise<{ operatorId: string; resetToken: string }>` and `assertOperatorBootstrapRuntime(env)`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/create-platform-operator.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-bootstrap-test';

const [{ createPlatformOperator, assertOperatorBootstrapRuntime }] = await Promise.all([
  import('../jobs/create-platform-operator.js'),
]);

function prismaStub(existing: unknown = null) {
  const created: Record<string, unknown>[] = [];
  return {
    created,
    prisma: {
      platformOperator: {
        findUnique: async () => existing,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: 'op-1', ...data };
        },
      },
    } as never,
  };
}

test('the runtime guard requires production', () => {
  assert.throws(
    () => assertOperatorBootstrapRuntime({ NODE_ENV: 'development' } as NodeJS.ProcessEnv),
    /NODE_ENV=production/,
  );
});

test('the runtime guard refuses personal-server mode', () => {
  assert.throws(
    () =>
      assertOperatorBootstrapRuntime({
        NODE_ENV: 'production',
        CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
      } as NodeJS.ProcessEnv),
    /personal-server/,
  );
});

test('a non-canonical email is rejected', async () => {
  const { prisma } = prismaStub();
  await assert.rejects(
    () => createPlatformOperator(prisma, { email: 'Owner@Example.org', name: 'Owner' }),
    /canonical lowercase/,
  );
});

test('creating an operator stores a hashed reset token and no usable password', async () => {
  const { prisma, created } = prismaStub();
  const result = await createPlatformOperator(prisma, { email: 'owner@example.org', name: 'Owner' });

  assert.ok(result.resetToken.length > 0);
  const row = created[0];
  assert.notEqual(row.resetToken, result.resetToken, 'only the hash of the reset token may be stored');
  assert.equal(typeof row.passwordHash, 'string');
  assert.notEqual(row.passwordHash, '', 'an unusable placeholder hash must still be present');
});

test('a duplicate operator email is refused', async () => {
  const { prisma } = prismaStub({ id: 'op-existing' });
  await assert.rejects(
    () => createPlatformOperator(prisma, { email: 'owner@example.org', name: 'Owner' }),
    /already exists/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/create-platform-operator.test.js`
Expected: FAIL — cannot find module `../jobs/create-platform-operator.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/jobs/create-platform-operator.ts`:

```ts
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { PERSONAL_SERVER_DEPLOYMENT_MODE } from '../utils/personal-server.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_HOURS = 24;

export function assertOperatorBootstrapRuntime(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') {
    throw new Error('Platform operator bootstrap requires NODE_ENV=production');
  }
  if (env.CHARITYPILOT_DEPLOYMENT_MODE === PERSONAL_SERVER_DEPLOYMENT_MODE) {
    throw new Error('Platform operator bootstrap is not available on a personal-server deployment');
  }
}

export async function createPlatformOperator(
  prisma: PrismaClient,
  input: { email: string; name: string },
): Promise<{ operatorId: string; resetToken: string }> {
  const { email, name } = input;
  if (email.trim() !== email || email !== email.toLowerCase() || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new Error('Operator email must be a canonical lowercase email address');
  }
  if (!name.trim()) {
    throw new Error('Operator name must not be empty');
  }

  const existing = await prisma.platformOperator.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    throw new Error(`A platform operator with email ${email} already exists`);
  }

  const resetToken = crypto.randomBytes(32).toString('base64url');
  const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000);

  // The operator never receives a password from the command line. A random,
  // discarded secret fills passwordHash so the column is never empty and no
  // login is possible until the reset link is used.
  const unusablePassword = crypto.randomBytes(32).toString('base64url');

  const created = await prisma.platformOperator.create({
    data: {
      email,
      name,
      passwordHash: await bcrypt.hash(unusablePassword, 10),
      resetToken: crypto.createHash('sha256').update(resetToken).digest('hex'),
      resetTokenExpiry,
    },
    select: { id: true },
  });

  return { operatorId: created.id, resetToken };
}
```

- [ ] **Step 4: Add the CLI entrypoint at the bottom of the same file**

```ts
async function main(): Promise<void> {
  assertOperatorBootstrapRuntime();

  const emailArg = process.argv.find((a) => a.startsWith('--email='))?.split('=')[1];
  const nameArg = process.argv.find((a) => a.startsWith('--name='))?.split('=')[1] ?? 'Platform owner';
  if (!emailArg) {
    throw new Error('Usage: npm run owner:create -- --email=<canonical-lowercase-email> [--name=<name>]');
  }

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const { operatorId, resetToken } = await createPlatformOperator(prisma, { email: emailArg, name: nameArg });
    const origin = process.env.OWNER_CONSOLE_ORIGIN ?? process.env.APP_ORIGIN ?? '';
    process.stdout.write(`Created platform operator ${operatorId} (${emailArg}).\n`);
    process.stdout.write(`Set-password link (valid ${RESET_TOKEN_HOURS}h, shown once):\n`);
    process.stdout.write(`${origin}/owner/set-password?token=${resetToken}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly, so the module stays importable by tests.
if (process.argv[1]?.endsWith('create-platform-operator.js')) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 5: Add the npm scripts**

In `apps/api/package.json` add to `scripts`:

```json
"jobs:create-platform-operator": "node dist/jobs/create-platform-operator.js"
```

In the root `package.json` add to `scripts`:

```json
"owner:create": "npm run build --workspace apps/api && npm run jobs:create-platform-operator --workspace apps/api --"
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/create-platform-operator.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/create-platform-operator.ts apps/api/src/tests/create-platform-operator.test.ts apps/api/package.json package.json
git commit -m "feat(owner): add CLI bootstrap for the first platform operator"
```

---

### Task 6A: Operator set-password (completes the bootstrap)

Task 6 prints a set-password link but nothing consumes it. Without this task the
bootstrapped operator can never sign in and the console is unreachable.

**Files:**
- Modify: `apps/api/src/routes/owner/auth.ts`
- Create: `apps/web/src/app/(owner)/owner/set-password/page.tsx`
- Create: `apps/api/src/tests/owner-set-password.test.ts`

**Interfaces:**
- Consumes: `PlatformOperator.resetToken` / `resetTokenExpiry` (Task 1), `ownerAuthRoutes` (Task 5).
- Produces: `POST /api/v1/owner/auth/set-password` accepting `{ token, password }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/owner-set-password.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-setpw-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-setpw-test';

const [{ default: Fastify }, { default: cookie }, { default: rateLimit }, bcrypt, { ownerRoutes }] =
  await Promise.all([
    import('fastify'),
    import('@fastify/cookie'),
    import('@fastify/rate-limit'),
    import('bcryptjs'),
    import('../routes/owner/index.js'),
  ]);

const RAW_TOKEN = 'a-valid-reset-token';
const TOKEN_HASH = crypto.createHash('sha256').update(RAW_TOKEN).digest('hex');

async function buildApp(operator: Record<string, unknown> | null) {
  const updates: Record<string, unknown>[] = [];
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.decorate('prisma', {
    platformOperator: {
      findFirst: async () => operator,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      },
    },
    platformOperatorSession: { updateMany: async () => ({ count: 0 }) },
  } as never);
  await app.register(ownerRoutes, { prefix: '/api/v1/owner' });
  return { app, updates };
}

const liveOperator = {
  id: 'op-1',
  email: 'owner@example.org',
  resetTokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
};

test('a valid token sets the password and clears the token', async () => {
  const { app, updates } = await buildApp(liveOperator);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: RAW_TOKEN, password: 'a-long-enough-new-password' },
  });

  assert.equal(res.statusCode, 200);
  const written = updates[0];
  assert.equal(written.resetToken, null, 'the reset token must be single-use');
  assert.equal(written.resetTokenExpiry, null);
  assert.ok(await bcrypt.default.compare('a-long-enough-new-password', written.passwordHash as string));
  await app.close();
});

test('an unknown or already-used token is refused', async () => {
  const { app, updates } = await buildApp(null);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: 'wrong', password: 'a-long-enough-new-password' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_RESET_TOKEN');
  assert.equal(updates.length, 0);
  await app.close();
});

test('a short password is refused before any write', async () => {
  const { app, updates } = await buildApp(liveOperator);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: RAW_TOKEN, password: 'short' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(updates.length, 0);
  await app.close();
});

test('the raw token is never used as a lookup key', async () => {
  // The column stores a sha256 hash; querying by the raw value would never match
  // and would mean the CLI-issued link could not work at all.
  let observedWhere: Record<string, unknown> | undefined;
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.decorate('prisma', {
    platformOperator: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        observedWhere = where;
        return liveOperator;
      },
      update: async () => ({}),
    },
    platformOperatorSession: { updateMany: async () => ({ count: 0 }) },
  } as never);
  await app.register(ownerRoutes, { prefix: '/api/v1/owner' });

  await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/set-password',
    payload: { token: RAW_TOKEN, password: 'a-long-enough-new-password' },
  });

  assert.equal(observedWhere?.resetToken, TOKEN_HASH);
  assert.notEqual(observedWhere?.resetToken, RAW_TOKEN);
  await app.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-set-password.test.js`
Expected: FAIL — the route returns 404 because it does not exist.

- [ ] **Step 3: Add the endpoint**

Add to `apps/api/src/routes/owner/auth.ts`, inside `ownerAuthRoutes`, and add `import crypto from 'node:crypto';` at the top of the file:

```ts
  const setPasswordSchema = z.object({
    token: z.string().min(1).max(200),
    password: z.string().min(12).max(200),
  });

  app.post(
    '/auth/set-password',
    { config: { rateLimit: bodyIdentifierRateLimit(['token']) } },
    async (request, reply) => {
      try {
        const body = setPasswordSchema.parse(request.body);
        // The column holds a sha256 hash, never the raw token from the link.
        const tokenHash = crypto.createHash('sha256').update(body.token).digest('hex');

        const operator = await app.prisma.platformOperator.findFirst({
          where: { resetToken: tokenHash, resetTokenExpiry: { gt: new Date() } },
          select: { id: true, email: true },
        });

        if (!operator) {
          throw new AppError(400, 'INVALID_RESET_TOKEN', 'That link is invalid or has expired.');
        }

        await app.prisma.platformOperator.update({
          where: { id: operator.id },
          data: {
            passwordHash: await bcrypt.hash(body.password, 10),
            resetToken: null,
            resetTokenExpiry: null,
          },
        });

        // Any session established before a credential change must not survive it.
        await app.prisma.platformOperatorSession.updateMany({
          where: { operatorId: operator.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        reply.send({ message: 'Password set. You can now sign in.' });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send({ error: 'Password must be at least 12 characters.', code: 'VALIDATION_ERROR' });
          return;
        }
        handleError(reply, err);
      }
    },
  );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-set-password.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the web page**

Create `apps/web/src/app/(owner)/owner/set-password/page.tsx`:

```tsx
'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, CardBody, Input } from '@heroui/react';
import axios from 'axios';
import { configuredApiOrigin } from '@/lib/api';
import { apiErrorMessage } from '@/lib/errors';

function SetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await axios.post(`${configuredApiOrigin}/api/v1/owner/auth/set-password`, { token, password });
      router.push('/owner/login');
    } catch (err) {
      setError(apiErrorMessage(err, 'That link is invalid or has expired.'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card>
      <CardBody className="gap-4">
        <h1 className="text-xl font-semibold">Set your console password</h1>
        {error ? <p className="text-danger">{error}</p> : null}
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <Input
            label="New password"
            type="password"
            value={password}
            onValueChange={setPassword}
            autoComplete="new-password"
            description="At least 12 characters."
          />
          <Button type="submit" color="primary" isLoading={isLoading} isDisabled={!token || password.length < 12}>
            Set password
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export default function OwnerSetPasswordPage() {
  return (
    <div className="mx-auto w-full max-w-md">
      <Suspense fallback={<p>Loading…</p>}>
        <SetPasswordForm />
      </Suspense>
    </div>
  );
}
```

`useSearchParams` requires a `Suspense` boundary in the Next.js app router; omitting it fails the production build.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/owner/auth.ts apps/api/src/tests/owner-set-password.test.ts apps/web/src/app/\(owner\)/owner/set-password
git commit -m "feat(owner): let a bootstrapped operator set their password"
```

---

### Task 7: Tenant list, search and detail

**Files:**
- Create: `apps/api/src/services/owner-tenants.service.ts`
- Create: `apps/api/src/routes/owner/tenants.ts`
- Modify: `apps/api/src/routes/owner/index.ts`
- Create: `apps/api/src/tests/owner-tenants-list.test.ts`

**Interfaces:**
- Consumes: `requirePlatformOperator` (Task 4).
- Produces:
  - `listTenants(prisma, query: { q?: string; status?: 'ACTIVE'|'SUSPENDED'|'CLOSED'; cursor?: string; limit?: number }): Promise<{ tenants: TenantSummary[]; nextCursor: string | null }>`
  - `getTenant(prisma, id: string): Promise<TenantDetail>`
  - `type TenantSummary = { id, name, lifecycleStatus, lifecycleVersion, plan, subscriptionStatus, trialEndsAt, userCount, createdAt }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/owner-tenants-list.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-owner-list-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-owner-list-test';

const [{ listTenants, getTenant }] = await Promise.all([import('../services/owner-tenants.service.js')]);

const orgRow = {
  id: 'org-1',
  name: 'Test Charity',
  rcnNumber: '12345',
  croNumber: null,
  lifecycleStatus: 'ACTIVE',
  lifecycleVersion: 1,
  createdAt: new Date('2026-01-01'),
  subscription: { plan: 'ESSENTIALS', status: 'TRIALING', trialEndsAt: new Date('2026-02-01') },
  _count: { users: 3 },
};

function prismaStub(rows = [orgRow], capture: { args?: unknown } = {}) {
  return {
    organisation: {
      findMany: async (args: unknown) => {
        capture.args = args;
        return rows;
      },
      findUnique: async () => rows[0] ?? null,
    },
  } as never;
}

test('listing returns a flattened tenant summary', async () => {
  const result = await listTenants(prismaStub(), {});
  assert.equal(result.tenants.length, 1);
  assert.deepEqual(result.tenants[0], {
    id: 'org-1',
    name: 'Test Charity',
    lifecycleStatus: 'ACTIVE',
    lifecycleVersion: 1,
    plan: 'ESSENTIALS',
    subscriptionStatus: 'TRIALING',
    trialEndsAt: orgRow.subscription.trialEndsAt,
    userCount: 3,
    createdAt: orgRow.createdAt,
  });
});

test('a tenant with no subscription still lists', async () => {
  const rows = [{ ...orgRow, subscription: null }];
  const result = await listTenants(prismaStub(rows), {});
  assert.equal(result.tenants[0].plan, null);
  assert.equal(result.tenants[0].subscriptionStatus, null);
});

test('a search term filters on name, RCN, CRO and owner email', async () => {
  const capture: { args?: unknown } = {};
  await listTenants(prismaStub([orgRow], capture), { q: 'test' });
  const where = (capture.args as { where?: { OR?: unknown[] } }).where;
  assert.ok(Array.isArray(where?.OR));
  assert.equal(where?.OR?.length, 4);
});

test('a status filter is applied', async () => {
  const capture: { args?: unknown } = {};
  await listTenants(prismaStub([orgRow], capture), { status: 'SUSPENDED' });
  const where = (capture.args as { where?: { lifecycleStatus?: string } }).where;
  assert.equal(where?.lifecycleStatus, 'SUSPENDED');
});

test('nextCursor is null when the page is not full', async () => {
  const result = await listTenants(prismaStub(), { limit: 50 });
  assert.equal(result.nextCursor, null);
});

test('getTenant returns null-safe detail for an unknown id', async () => {
  const prisma = { organisation: { findUnique: async () => null } } as never;
  await assert.rejects(() => getTenant(prisma, 'missing'), /TENANT_NOT_FOUND/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-tenants-list.test.js`
Expected: FAIL — cannot find module `../services/owner-tenants.service.js`.

- [ ] **Step 3: Write the service**

Create `apps/api/src/services/owner-tenants.service.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

// This file holds the ONLY unscoped Organisation reads in the codebase. No
// tenant-facing route may import it; see the sole-writer test in
// apps/api/src/tests/owner-sole-writer.test.ts.

export type TenantLifecycleStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export type TenantSummary = {
  id: string;
  name: string;
  lifecycleStatus: TenantLifecycleStatus;
  lifecycleVersion: number;
  plan: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: Date | null;
  userCount: number;
  createdAt: Date;
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const tenantSelect = {
  id: true,
  name: true,
  rcnNumber: true,
  croNumber: true,
  lifecycleStatus: true,
  lifecycleVersion: true,
  createdAt: true,
  subscription: { select: { plan: true, status: true, trialEndsAt: true } },
  _count: { select: { users: true } },
} as const;

type TenantRow = {
  id: string;
  name: string;
  lifecycleStatus: TenantLifecycleStatus;
  lifecycleVersion: number;
  createdAt: Date;
  subscription: { plan: string; status: string; trialEndsAt: Date | null } | null;
  _count: { users: number };
};

function toSummary(row: TenantRow): TenantSummary {
  return {
    id: row.id,
    name: row.name,
    lifecycleStatus: row.lifecycleStatus,
    lifecycleVersion: row.lifecycleVersion,
    plan: row.subscription?.plan ?? null,
    subscriptionStatus: row.subscription?.status ?? null,
    trialEndsAt: row.subscription?.trialEndsAt ?? null,
    userCount: row._count.users,
    createdAt: row.createdAt,
  };
}

export async function listTenants(
  prisma: PrismaClient,
  query: { q?: string; status?: TenantLifecycleStatus; cursor?: string; limit?: number },
): Promise<{ tenants: TenantSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const where: Record<string, unknown> = {};
  if (query.status) where.lifecycleStatus = query.status;
  if (query.q) {
    const contains = { contains: query.q, mode: 'insensitive' as const };
    where.OR = [
      { name: contains },
      { rcnNumber: contains },
      { croNumber: contains },
      { users: { some: { email: contains, role: 'OWNER' } } },
    ];
  }

  const rows = (await prisma.organisation.findMany({
    where,
    select: tenantSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  })) as unknown as TenantRow[];

  return {
    tenants: rows.map(toSummary),
    nextCursor: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
  };
}

export async function getTenant(prisma: PrismaClient, id: string): Promise<TenantSummary> {
  const row = (await prisma.organisation.findUnique({
    where: { id },
    select: tenantSelect,
  })) as unknown as TenantRow | null;

  if (!row) {
    throw new AppError(404, 'TENANT_NOT_FOUND', 'Organisation not found');
  }
  return toSummary(row);
}
```

- [ ] **Step 4: Write the routes**

Create `apps/api/src/routes/owner/tenants.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { handleError } from '../../utils/errors.js';
import { requirePlatformOperator } from '../../middleware/owner-auth.js';
import { listTenants, getTenant } from '../../services/owner-tenants.service.js';

const listQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function ownerTenantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requirePlatformOperator);

  app.get('/tenants', async (request, reply) => {
    try {
      reply.send(await listTenants(app.prisma, listQuerySchema.parse(request.query ?? {})));
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
        return;
      }
      handleError(reply, err);
    }
  });

  app.get('/tenants/:id', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
      reply.send({ tenant: await getTenant(app.prisma, id) });
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
        return;
      }
      handleError(reply, err);
    }
  });
}
```

Register it in `apps/api/src/routes/owner/index.ts`, after `ownerAuthRoutes`:

```ts
import { ownerTenantRoutes } from './tenants.js';
// ...
  await app.register(ownerTenantRoutes);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-tenants-list.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/owner-tenants.service.ts apps/api/src/routes/owner apps/api/src/tests/owner-tenants-list.test.ts
git commit -m "feat(owner): list, search and read tenants"
```

---

### Task 8: Tenant lifecycle transitions with audit

**Files:**
- Modify: `apps/api/src/services/owner-tenants.service.ts`
- Modify: `apps/api/src/routes/owner/tenants.ts`
- Create: `apps/api/src/tests/owner-tenant-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 7.
- Produces: `transitionTenantLifecycle(prisma, input: { tenantId: string; action: 'SUSPEND'|'REACTIVATE'|'CLOSE'; reason: string; expectedLifecycleVersion: number; operator: { id: string; email: string } }): Promise<TenantSummary>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/owner-tenant-lifecycle.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-lifecycle-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-lifecycle-test';

const [{ transitionTenantLifecycle }] = await Promise.all([
  import('../services/owner-tenants.service.js'),
]);

const OPERATOR = { id: 'op-1', email: 'owner@example.org' };

function prismaStub(current: { lifecycleStatus: string; lifecycleVersion: number } | null) {
  const calls = { updates: [] as unknown[], audits: [] as Record<string, unknown>[] };
  const tx = {
    $queryRaw: async () => (current ? [{ id: 'org-1', ...current }] : []),
    organisation: {
      update: async ({ data }: { data: unknown }) => {
        calls.updates.push(data);
        return { id: 'org-1' };
      },
      findUnique: async () => ({
        id: 'org-1',
        name: 'Test Charity',
        lifecycleStatus: 'SUSPENDED',
        lifecycleVersion: (current?.lifecycleVersion ?? 1) + 1,
        createdAt: new Date('2026-01-01'),
        subscription: null,
        _count: { users: 1 },
      }),
    },
    securityAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.audits.push(data);
        return data;
      },
    },
  };
  return {
    calls,
    prisma: { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as never,
  };
}

test('suspending writes the status and the audit event together', async () => {
  const { prisma, calls } = prismaStub({ lifecycleStatus: 'ACTIVE', lifecycleVersion: 1 });
  await transitionTenantLifecycle(prisma, {
    tenantId: 'org-1',
    action: 'SUSPEND',
    reason: 'Non-payment after dunning',
    expectedLifecycleVersion: 1,
    operator: OPERATOR,
  });

  assert.equal(calls.updates.length, 1);
  assert.equal(calls.audits.length, 1);
  const audit = calls.audits[0];
  assert.equal(audit.type, 'ORGANISATION_SUSPENDED');
  assert.equal(audit.actorKind, 'SUPPORT');
  assert.equal(audit.actorUserId, null);
  assert.equal(audit.actorLabel, 'owner@example.org');
  assert.equal(audit.organisationId, 'org-1');
  assert.equal(audit.reason, 'Non-payment after dunning');
});

test('a version mismatch is refused before any write', async () => {
  const { prisma, calls } = prismaStub({ lifecycleStatus: 'ACTIVE', lifecycleVersion: 5 });
  await assert.rejects(
    () =>
      transitionTenantLifecycle(prisma, {
        tenantId: 'org-1',
        action: 'SUSPEND',
        reason: 'Non-payment',
        expectedLifecycleVersion: 1,
        operator: OPERATOR,
      }),
    /TENANT_LIFECYCLE_CONFLICT/,
  );
  assert.equal(calls.updates.length, 0, 'no write may happen on a conflict');
  assert.equal(calls.audits.length, 0, 'no audit event may be written on a conflict');
});

test('an unknown tenant is refused', async () => {
  const { prisma } = prismaStub(null);
  await assert.rejects(
    () =>
      transitionTenantLifecycle(prisma, {
        tenantId: 'missing',
        action: 'SUSPEND',
        reason: 'Non-payment',
        expectedLifecycleVersion: 1,
        operator: OPERATOR,
      }),
    /TENANT_NOT_FOUND/,
  );
});

test('an empty reason is refused', async () => {
  const { prisma, calls } = prismaStub({ lifecycleStatus: 'ACTIVE', lifecycleVersion: 1 });
  await assert.rejects(
    () =>
      transitionTenantLifecycle(prisma, {
        tenantId: 'org-1',
        action: 'SUSPEND',
        reason: '   ',
        expectedLifecycleVersion: 1,
        operator: OPERATOR,
      }),
    /REASON_REQUIRED/,
  );
  assert.equal(calls.updates.length, 0);
});

test('a closed tenant cannot be reopened from the console', async () => {
  const { prisma, calls } = prismaStub({ lifecycleStatus: 'CLOSED', lifecycleVersion: 3 });
  await assert.rejects(
    () =>
      transitionTenantLifecycle(prisma, {
        tenantId: 'org-1',
        action: 'REACTIVATE',
        reason: 'Customer returned',
        expectedLifecycleVersion: 3,
        operator: OPERATOR,
      }),
    /TENANT_TRANSITION_NOT_ALLOWED/,
  );
  assert.equal(calls.updates.length, 0);
});

test('suspending an already suspended tenant is refused', async () => {
  const { prisma } = prismaStub({ lifecycleStatus: 'SUSPENDED', lifecycleVersion: 2 });
  await assert.rejects(
    () =>
      transitionTenantLifecycle(prisma, {
        tenantId: 'org-1',
        action: 'SUSPEND',
        reason: 'Non-payment',
        expectedLifecycleVersion: 2,
        operator: OPERATOR,
      }),
    /TENANT_TRANSITION_NOT_ALLOWED/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-tenant-lifecycle.test.js`
Expected: FAIL — `transitionTenantLifecycle` is not exported.

- [ ] **Step 3: Add the transition to the service**

First change the existing top-of-file import so `Prisma` is available for `Prisma.sql` — imports must stay at the top of the module:

```ts
import { Prisma, type PrismaClient } from '@prisma/client';
```

Then append to `apps/api/src/services/owner-tenants.service.ts`:

```ts
export type TenantLifecycleAction = 'SUSPEND' | 'REACTIVATE' | 'CLOSE';

// CLOSED is deliberately terminal here. Leaving it is a deliberate shell
// operation, because that is where data-retention obligations begin.
const ALLOWED_TRANSITIONS: Record<TenantLifecycleAction, { from: TenantLifecycleStatus[]; to: TenantLifecycleStatus }> = {
  SUSPEND: { from: ['ACTIVE'], to: 'SUSPENDED' },
  REACTIVATE: { from: ['SUSPENDED'], to: 'ACTIVE' },
  CLOSE: { from: ['ACTIVE', 'SUSPENDED'], to: 'CLOSED' },
};

const AUDIT_TYPE: Record<TenantLifecycleAction, string> = {
  SUSPEND: 'ORGANISATION_SUSPENDED',
  REACTIVATE: 'ORGANISATION_REACTIVATED',
  CLOSE: 'ORGANISATION_CLOSED',
};

export async function transitionTenantLifecycle(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    action: TenantLifecycleAction;
    reason: string;
    expectedLifecycleVersion: number;
    operator: { id: string; email: string };
  },
): Promise<TenantSummary> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError(400, 'REASON_REQUIRED', 'A reason is required for a lifecycle change');
  }

  return prisma.$transaction(async (tx) => {
    // Lock the row first, exactly as jobs/recover-team-ownership.ts does, so a
    // concurrent transition cannot interleave between the read and the write.
    const locked = (await tx.$queryRaw(
      Prisma.sql`SELECT "id", "lifecycleStatus", "lifecycleVersion" FROM "Organisation" WHERE "id" = ${input.tenantId} FOR UPDATE`,
    )) as { id: string; lifecycleStatus: TenantLifecycleStatus; lifecycleVersion: number }[];

    const current = locked[0];
    if (!current) {
      throw new AppError(404, 'TENANT_NOT_FOUND', 'Organisation not found');
    }

    if (current.lifecycleVersion !== input.expectedLifecycleVersion) {
      throw new AppError(
        409,
        'TENANT_LIFECYCLE_CONFLICT',
        'This organisation changed since you loaded it. Reload and try again.',
      );
    }

    const transition = ALLOWED_TRANSITIONS[input.action];
    if (!transition.from.includes(current.lifecycleStatus)) {
      throw new AppError(
        409,
        'TENANT_TRANSITION_NOT_ALLOWED',
        `Cannot ${input.action.toLowerCase()} an organisation that is ${current.lifecycleStatus}`,
      );
    }

    await tx.organisation.update({
      where: { id: input.tenantId },
      data: {
        lifecycleStatus: transition.to,
        lifecycleVersion: { increment: 1 },
        lifecycleChangedAt: new Date(),
      },
    });

    await tx.securityAuditEvent.create({
      data: {
        organisationId: input.tenantId,
        type: AUDIT_TYPE[input.action] as never,
        actorKind: 'SUPPORT',
        actorUserId: null,
        actorLabel: input.operator.email,
        subjectLabel: `Organisation ${input.tenantId}`,
        reason,
        context: {
          operatorId: input.operator.id,
          previousStatus: current.lifecycleStatus,
          newStatus: transition.to,
          lifecycleVersion: current.lifecycleVersion,
        },
      },
    });

    const row = (await tx.organisation.findUnique({
      where: { id: input.tenantId },
      select: tenantSelect,
    })) as unknown as TenantRow;

    return toSummary(row);
  });
}
```

- [ ] **Step 4: Add the route**

Append inside `ownerTenantRoutes` in `apps/api/src/routes/owner/tenants.ts`:

```ts
  const lifecycleBodySchema = z.object({
    action: z.enum(['SUSPEND', 'REACTIVATE', 'CLOSE']),
    reason: z.string().trim().min(1).max(1000),
    expectedLifecycleVersion: z.number().int().min(1),
  });

  app.post('/tenants/:id/lifecycle', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
      const body = lifecycleBodySchema.parse(request.body);
      const tenant = await transitionTenantLifecycle(app.prisma, {
        tenantId: id,
        action: body.action,
        reason: body.reason,
        expectedLifecycleVersion: body.expectedLifecycleVersion,
        operator: request.operator,
      });
      reply.send({ tenant });
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
        return;
      }
      handleError(reply, err);
    }
  });
```

Add `transitionTenantLifecycle` to the existing import from `../../services/owner-tenants.service.js`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-tenant-lifecycle.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/owner-tenants.service.ts apps/api/src/routes/owner/tenants.ts apps/api/src/tests/owner-tenant-lifecycle.test.ts
git commit -m "feat(owner): suspend, reactivate and close tenants with audit"
```

---

### Task 9: Provision a tenant by hand

**Files:**
- Create: `apps/api/src/services/owner-provisioning.service.ts`
- Modify: `apps/api/src/routes/owner/tenants.ts`
- Create: `apps/api/src/tests/owner-provisioning.test.ts`

**Interfaces:**
- Consumes: Task 7 (`TenantSummary`).
- Produces: `provisionTenant(prisma, input: { organisationName: string; ownerName: string; ownerEmail: string; plan: 'ESSENTIALS'|'COMPLETE'; trialDays: number }): Promise<{ organisationId: string; userId: string; verifyToken: string }>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/owner-provisioning.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-provisioning-test';
process.env.OWNER_JWT_SECRET = 'owner-secret-provisioning-test';

const [{ provisionTenant }] = await Promise.all([import('../services/owner-provisioning.service.js')]);

function prismaStub(existingUser: unknown = null) {
  const calls = { orgs: 0, users: [] as Record<string, unknown>[], subs: [] as Record<string, unknown>[] };
  const tx = {
    user: {
      findUnique: async () => existingUser,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.users.push(data);
        return { id: 'u-1', ...data };
      },
      update: async () => ({}),
    },
    organisation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.orgs += 1;
        return { id: 'org-1', ...data };
      },
    },
    subscription: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.subs.push(data);
        return data;
      },
    },
  };
  return { calls, prisma: { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as never };
}

const INPUT = {
  organisationName: 'New Charity',
  ownerName: 'Ada Lovelace',
  ownerEmail: 'ada@example.org',
  plan: 'ESSENTIALS' as const,
  trialDays: 30,
};

test('provisioning creates org, OWNER user and subscription', async () => {
  const { prisma, calls } = prismaStub();
  const result = await provisionTenant(prisma, INPUT);

  assert.equal(calls.orgs, 1);
  assert.equal(calls.users.length, 1);
  assert.equal(calls.users[0].role, 'OWNER');
  assert.equal(calls.users[0].email, 'ada@example.org');
  assert.equal(calls.subs.length, 1);
  assert.equal(calls.subs[0].plan, 'ESSENTIALS');
  assert.equal(calls.subs[0].status, 'TRIALING');
  assert.ok(result.verifyToken.length > 0);
});

test('the operator never supplies a password and none is usable', async () => {
  const { prisma, calls } = prismaStub();
  await provisionTenant(prisma, INPUT);
  const created = calls.users[0];
  assert.equal(typeof created.passwordHash, 'string');
  assert.notEqual(created.passwordHash, '');
  assert.equal(created.emailVerified, false);
});

test('a duplicate email returns 409 and creates nothing', async () => {
  // AuthService.register deliberately reports success for a taken email to
  // prevent enumeration. For a trusted operator that would silently no-op, so
  // the owner path must fail loudly instead.
  const { prisma, calls } = prismaStub({ id: 'u-existing' });
  await assert.rejects(() => provisionTenant(prisma, INPUT), /EMAIL_ALREADY_REGISTERED/);
  assert.equal(calls.orgs, 0, 'no partial organisation may be created');
  assert.equal(calls.users.length, 0);
});

test('a non-canonical email is normalised before the duplicate check', async () => {
  const { prisma, calls } = prismaStub();
  await provisionTenant(prisma, { ...INPUT, ownerEmail: '  Ada@Example.ORG ' });
  assert.equal(calls.users[0].email, 'ada@example.org');
});

test('trial days must be positive', async () => {
  const { prisma } = prismaStub();
  await assert.rejects(() => provisionTenant(prisma, { ...INPUT, trialDays: 0 }), /INVALID_TRIAL_DAYS/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-provisioning.test.js`
Expected: FAIL — cannot find module `../services/owner-provisioning.service.js`.

- [ ] **Step 3: Write the service**

Create `apps/api/src/services/owner-provisioning.service.ts`:

```ts
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

const VERIFY_TOKEN_HOURS = 48;

export async function provisionTenant(
  prisma: PrismaClient,
  input: {
    organisationName: string;
    ownerName: string;
    ownerEmail: string;
    plan: 'ESSENTIALS' | 'COMPLETE';
    trialDays: number;
  },
): Promise<{ organisationId: string; userId: string; verifyToken: string }> {
  if (!Number.isInteger(input.trialDays) || input.trialDays < 1) {
    throw new AppError(400, 'INVALID_TRIAL_DAYS', 'Trial length must be at least one day');
  }

  const email = input.ownerEmail.trim().toLowerCase();
  const verifyToken = crypto.randomBytes(32).toString('base64url');
  const verifyTokenHash = crypto.createHash('sha256').update(verifyToken).digest('hex');

  // The operator never chooses another person's credential: a random secret is
  // hashed and discarded, and the owner sets a real password via the link.
  const unusablePassword = crypto.randomBytes(32).toString('base64url');
  const passwordHash = await bcrypt.hash(unusablePassword, 10);

  const trialEndsAt = new Date(Date.now() + input.trialDays * 24 * 60 * 60 * 1000);
  const verifyTokenExpiry = new Date(Date.now() + VERIFY_TOKEN_HOURS * 60 * 60 * 1000);

  const created = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'That email already belongs to an account');
    }

    const organisation = await tx.organisation.create({ data: { name: input.organisationName } });

    const user = await tx.user.create({
      data: {
        email,
        name: input.ownerName,
        passwordHash,
        role: 'OWNER',
        organisationId: organisation.id,
        emailVerified: false,
        verifyToken: verifyTokenHash,
        verifyTokenExpiry,
      },
      select: { id: true },
    });

    await tx.subscription.create({
      data: { organisationId: organisation.id, plan: input.plan, status: 'TRIALING', trialEndsAt },
    });

    return { organisationId: organisation.id, userId: user.id };
  });

  return { ...created, verifyToken };
}
```

- [ ] **Step 4: Add the route**

Append inside `ownerTenantRoutes` in `apps/api/src/routes/owner/tenants.ts`:

```ts
  const provisionBodySchema = z.object({
    organisationName: z.string().trim().min(1).max(200),
    ownerName: z.string().trim().min(1).max(200),
    ownerEmail: z.string().email().max(254),
    plan: z.enum(['ESSENTIALS', 'COMPLETE']),
    trialDays: z.number().int().min(1).max(365),
  });

  app.post('/tenants', async (request, reply) => {
    try {
      const body = provisionBodySchema.parse(request.body);
      const result = await provisionTenant(app.prisma, body);
      reply.status(201).send(result);
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
        return;
      }
      handleError(reply, err);
    }
  });
```

Add `import { provisionTenant } from '../../services/owner-provisioning.service.js';` at the top of the file.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-provisioning.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/owner-provisioning.service.ts apps/api/src/routes/owner/tenants.ts apps/api/src/tests/owner-provisioning.test.ts
git commit -m "feat(owner): provision a tenant by hand with a real duplicate-email error"
```

---

### Task 10: Login disclosure change

**Files:**
- Modify: `apps/api/src/services/auth.service.ts:191-197`
- Create: `apps/api/src/tests/login-suspension-disclosure.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AuthService.login` throws `403 ACCOUNT_SUSPENDED`, `403 ORGANISATION_SUSPENDED` or `403 ORGANISATION_CLOSED` only after a correct password.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/login-suspension-disclosure.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'tenant-secret-disclosure-test';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_disclosure_test_key';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const [{ AuthService }, bcrypt] = await Promise.all([
  import('../services/auth.service.js'),
  import('bcryptjs'),
]);

const PASSWORD = 'correct-horse-battery-staple';
const codeOf = (err: unknown) => (err as { code?: string })?.code;
const statusOf = (err: unknown) => (err as { statusCode?: number })?.statusCode;

async function serviceFor(userLifecycle: string, orgLifecycle: string) {
  const passwordHash = await bcrypt.default.hash(PASSWORD, 10);
  return new AuthService({
    user: {
      findUnique: async () => ({
        id: 'u-1',
        email: 'user@example.org',
        name: 'User',
        passwordHash,
        role: 'OWNER',
        emailVerified: true,
        lifecycleStatus: userLifecycle,
        organisationId: 'org-1',
        organisation: { id: 'org-1', name: 'Charity', lifecycleStatus: orgLifecycle },
      }),
    },
  } as never);
}

test('a wrong password against a SUSPENDED organisation stays generic', async () => {
  // This is the security property of the whole change: the explanation must be
  // unreachable without valid credentials, or it becomes an enumeration oracle.
  const service = await serviceFor('ACTIVE', 'SUSPENDED');
  const err = await service.login({ email: 'user@example.org', password: 'wrong' }).catch((e: unknown) => e);
  assert.equal(statusOf(err), 401);
  assert.equal(codeOf(err), 'INVALID_CREDENTIALS');
});

test('a correct password against a SUSPENDED organisation explains why', async () => {
  const service = await serviceFor('ACTIVE', 'SUSPENDED');
  const err = await service.login({ email: 'user@example.org', password: PASSWORD }).catch((e: unknown) => e);
  assert.equal(statusOf(err), 403);
  assert.equal(codeOf(err), 'ORGANISATION_SUSPENDED');
});

test('a correct password against a CLOSED organisation explains why', async () => {
  const service = await serviceFor('ACTIVE', 'CLOSED');
  const err = await service.login({ email: 'user@example.org', password: PASSWORD }).catch((e: unknown) => e);
  assert.equal(statusOf(err), 403);
  assert.equal(codeOf(err), 'ORGANISATION_CLOSED');
});

test('a suspended user in an active organisation is told about the account', async () => {
  const service = await serviceFor('SUSPENDED', 'ACTIVE');
  const err = await service.login({ email: 'user@example.org', password: PASSWORD }).catch((e: unknown) => e);
  assert.equal(statusOf(err), 403);
  assert.equal(codeOf(err), 'ACCOUNT_SUSPENDED');
});

test('an unknown email is still a generic 401', async () => {
  const service = new AuthService({ user: { findUnique: async () => null } } as never);
  const err = await service.login({ email: 'nobody@example.org', password: PASSWORD }).catch((e: unknown) => e);
  assert.equal(statusOf(err), 401);
  assert.equal(codeOf(err), 'INVALID_CREDENTIALS');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/login-suspension-disclosure.test.js`
Expected: FAIL — the suspended cases return 401 `INVALID_CREDENTIALS` instead of 403.

- [ ] **Step 3: Replace the combined check in `auth.service.ts`**

Replace this block (currently at approximately `apps/api/src/services/auth.service.ts:191`):

```ts
    if (
      !valid ||
      !hasActiveLifecycle(user)
    ) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
```

with:

```ts
    if (!valid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // The password is proven correct from here, so naming the real reason leaks
    // nothing an attacker does not already hold. A WRONG password against a
    // suspended tenant still returns the generic 401 above, which is what keeps
    // this from becoming an account-enumeration oracle.
    if (user.lifecycleStatus !== 'ACTIVE') {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is no longer active. Contact your organisation administrator.');
    }
    if (user.organisation.lifecycleStatus === 'SUSPENDED') {
      throw new AppError(403, 'ORGANISATION_SUSPENDED', 'This organisation is suspended. Contact support to restore access.');
    }
    if (user.organisation.lifecycleStatus === 'CLOSED') {
      throw new AppError(403, 'ORGANISATION_CLOSED', 'This organisation is closed. Contact support if you believe this is wrong.');
    }
```

Leave `hasActiveLifecycle` in place — `getMe` and `refresh` still use it and must keep failing flat.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/login-suspension-disclosure.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full API suite**

Run: `cd apps/api && npm test`
Expected: PASS. Any existing test asserting a `401` for a suspended login is now asserting the old behaviour — update it to expect `403` and the specific code, and note the change in the commit message.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/auth.service.ts apps/api/src/tests/login-suspension-disclosure.test.ts
git commit -m "feat(auth): explain a suspended tenant only after a correct password"
```

---

### Task 11: Login screen wording for the new codes

**Files:**
- Modify: `apps/web/src/lib/auth-error-message.ts`
- Create: `apps/web/src/lib/auth-error-message.lifecycle.test.ts`

**Interfaces:**
- Consumes: the 403 codes from Task 10.
- Produces: `authFailureNotice` returns a titled notice for `ACCOUNT_SUSPENDED`, `ORGANISATION_SUSPENDED` and `ORGANISATION_CLOSED`.

Note: `apiErrorMessage` already surfaces the server's `error` string, so the messages from Task 10 display **without** this task. This adds titles so the alert reads as a status rather than a validation failure.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/auth-error-message.lifecycle.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authFailureNotice, ORGANISATION_SUSPENDED_TITLE } from './auth-error-message';

function apiError(status: number, code: string, message: string) {
  return { isAxiosError: true, response: { status, data: { code, error: message } } };
}

test('a suspended organisation gets its own title and the server message', () => {
  const notice = authFailureNotice(
    apiError(403, 'ORGANISATION_SUSPENDED', 'This organisation is suspended. Contact support to restore access.'),
    'Invalid email or password. Please try again.',
  );
  assert.equal(notice.title, ORGANISATION_SUSPENDED_TITLE);
  assert.match(notice.message, /suspended/);
});

test('a generic 401 still falls back to the credential message', () => {
  const notice = authFailureNotice(
    apiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password'),
    'Invalid email or password. Please try again.',
  );
  assert.equal(notice.title, undefined);
});

test('an origin rejection still wins over the lifecycle codes', () => {
  const notice = authFailureNotice(
    apiError(403, 'INVALID_ORIGIN', 'refused'),
    'Invalid email or password. Please try again.',
  );
  assert.notEqual(notice.title, ORGANISATION_SUSPENDED_TITLE);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx tsx --test src/lib/auth-error-message.lifecycle.test.ts`
Expected: FAIL — `ORGANISATION_SUSPENDED_TITLE` is not exported.

- [ ] **Step 3: Add the titles and the branch**

In `apps/web/src/lib/auth-error-message.ts`, add the exported titles next to the existing title constants:

```ts
export const ACCOUNT_SUSPENDED_TITLE = 'This account is no longer active';
export const ORGANISATION_SUSPENDED_TITLE = 'This organisation is suspended';
export const ORGANISATION_CLOSED_TITLE = 'This organisation is closed';

const LIFECYCLE_TITLES: Record<string, string> = {
  ACCOUNT_SUSPENDED: ACCOUNT_SUSPENDED_TITLE,
  ORGANISATION_SUSPENDED: ORGANISATION_SUSPENDED_TITLE,
  ORGANISATION_CLOSED: ORGANISATION_CLOSED_TITLE,
};
```

Replace the `default:` branch of `authFailureNotice` with:

```ts
    default: {
      const code = errorResponse(error)?.data?.code;
      const title = typeof code === 'string' ? LIFECYCLE_TITLES[code] : undefined;
      // The server's own message is authoritative here; the title only frames it.
      return title ? { title, message: apiErrorMessage(error, fallback) } : { message: apiErrorMessage(error, fallback) };
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx tsx --test src/lib/auth-error-message.lifecycle.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/auth-error-message.ts apps/web/src/lib/auth-error-message.lifecycle.test.ts
git commit -m "feat(web): title the suspended and closed organisation login notices"
```

---

### Task 12: Owner console pages

**Files:**
- Create: `apps/web/src/app/(owner)/layout.tsx`
- Create: `apps/web/src/app/(owner)/owner/login/page.tsx`
- Create: `apps/web/src/app/(owner)/owner/tenants/page.tsx`
- Create: `apps/web/src/app/(owner)/owner/tenants/[id]/page.tsx`
- Create: `apps/web/src/lib/owner-api.ts`

**Interfaces:**
- Consumes: the owner API from Tasks 5, 7, 8, 9.
- Produces: `ownerApi` client with `login`, `logout`, `listTenants`, `getTenant`, `transitionLifecycle`, `provisionTenant`.

- [ ] **Step 1: Write the owner API client**

Create `apps/web/src/lib/owner-api.ts`:

```ts
import axios from 'axios';
import { configuredApiOrigin } from './api';

// withCredentials so the Path-scoped owner cookie is sent; the tenant client is
// deliberately a separate instance so neither can carry the other's cookies.
const client = axios.create({
  baseURL: `${configuredApiOrigin}/api/v1/owner`,
  withCredentials: true,
});

export type TenantSummary = {
  id: string;
  name: string;
  lifecycleStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  lifecycleVersion: number;
  plan: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  userCount: number;
  createdAt: string;
};

export const ownerApi = {
  async login(email: string, password: string) {
    const { data } = await client.post('/auth/login', { email, password });
    return data.operator as { id: string; email: string; name: string };
  },
  async logout() {
    await client.post('/auth/logout');
  },
  async me() {
    const { data } = await client.get('/auth/me');
    return data.operator as { id: string; email: string };
  },
  async listTenants(params: { q?: string; status?: string; cursor?: string }) {
    const { data } = await client.get('/tenants', { params });
    return data as { tenants: TenantSummary[]; nextCursor: string | null };
  },
  async getTenant(id: string) {
    const { data } = await client.get(`/tenants/${id}`);
    return data.tenant as TenantSummary;
  },
  async transitionLifecycle(
    id: string,
    body: { action: 'SUSPEND' | 'REACTIVATE' | 'CLOSE'; reason: string; expectedLifecycleVersion: number },
  ) {
    const { data } = await client.post(`/tenants/${id}/lifecycle`, body);
    return data.tenant as TenantSummary;
  },
  async provisionTenant(body: {
    organisationName: string;
    ownerName: string;
    ownerEmail: string;
    plan: 'ESSENTIALS' | 'COMPLETE';
    trialDays: number;
  }) {
    const { data } = await client.post('/tenants', body);
    return data as { organisationId: string; userId: string; verifyToken: string };
  },
};
```

- [ ] **Step 2: Write the owner layout**

Create `apps/web/src/app/(owner)/layout.tsx`:

```tsx
import type { ReactNode } from 'react';

// Deliberately NOT the tenant dashboard shell: no compliance nav, no
// organisation context, and a distinct bar so the operating context is
// never ambiguous.
export default function OwnerLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900 px-6 py-3">
        <span className="text-sm font-semibold uppercase tracking-wide text-amber-400">
          CharityPilot platform console
        </span>
      </header>
      <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
```

- [ ] **Step 3: Write the login page**

Create `apps/web/src/app/(owner)/owner/login/page.tsx`:

```tsx
'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, Input } from '@heroui/react';
import { ownerApi } from '@/lib/owner-api';
import { apiErrorMessage } from '@/lib/errors';
import { FormAlert } from '@/components/ui/form-alert';

export default function OwnerLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await ownerApi.login(email, password);
      router.push('/owner/tenants');
    } catch (err) {
      setError(apiErrorMessage(err, 'Invalid email or password.'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardBody className="gap-4">
          <h1 className="text-xl font-semibold">Platform console sign in</h1>
          {error ? <FormAlert>{error}</FormAlert> : null}
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <Input label="Email" type="email" value={email} onValueChange={setEmail} autoComplete="username" />
            <Input
              label="Password"
              type="password"
              value={password}
              onValueChange={setPassword}
              autoComplete="current-password"
            />
            <Button type="submit" isLoading={isLoading} color="primary">
              Sign in
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Write the tenant list page**

Create `apps/web/src/app/(owner)/owner/tenants/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Chip, Input, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from '@heroui/react';
import { ownerApi, type TenantSummary } from '@/lib/owner-api';

const STATUS_COLOR = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  CLOSED: 'danger',
} as const;

export default function OwnerTenantsPage() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      ownerApi
        .listTenants(q ? { q } : {})
        .then((result) => {
          if (!cancelled) setTenants(result.tenants);
        })
        .catch(() => {
          if (!cancelled) setError('Could not load tenants.');
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Tenants</h1>
      <Input placeholder="Search name, RCN, CRO or owner email" value={q} onValueChange={setQ} />
      {error ? <p className="text-danger">{error}</p> : null}
      <Table aria-label="Tenants">
        <TableHeader>
          <TableColumn>Name</TableColumn>
          <TableColumn>Status</TableColumn>
          <TableColumn>Plan</TableColumn>
          <TableColumn>Users</TableColumn>
        </TableHeader>
        <TableBody emptyContent="No tenants found.">
          {tenants.map((tenant) => (
            <TableRow key={tenant.id}>
              <TableCell>
                <Link href={`/owner/tenants/${tenant.id}`}>{tenant.name}</Link>
              </TableCell>
              <TableCell>
                <Chip color={STATUS_COLOR[tenant.lifecycleStatus]} size="sm">
                  {tenant.lifecycleStatus}
                </Chip>
              </TableCell>
              <TableCell>{tenant.plan ?? '—'}</TableCell>
              <TableCell>{tenant.userCount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 5: Write the tenant detail page with lifecycle actions**

Create `apps/web/src/app/(owner)/owner/tenants/[id]/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button, Card, CardBody, Input, Textarea } from '@heroui/react';
import { ownerApi, type TenantSummary } from '@/lib/owner-api';
import { apiErrorMessage } from '@/lib/errors';

type Action = 'SUSPEND' | 'REACTIVATE' | 'CLOSE';

export default function OwnerTenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tenant, setTenant] = useState<TenantSummary | null>(null);
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ownerApi.getTenant(id).then(setTenant).catch(() => setError('Could not load this tenant.'));
  }, [id]);

  async function run(action: Action) {
    if (!tenant) return;
    setError(null);
    try {
      // expectedLifecycleVersion is what makes a stale tab fail loudly with a
      // 409 instead of silently overwriting someone else's change.
      setTenant(
        await ownerApi.transitionLifecycle(tenant.id, {
          action,
          reason,
          expectedLifecycleVersion: tenant.lifecycleVersion,
        }),
      );
      setReason('');
      setConfirmName('');
    } catch (err) {
      setError(apiErrorMessage(err, 'That change could not be applied.'));
    }
  }

  if (!tenant) return <p>{error ?? 'Loading…'}</p>;

  const closeArmed = confirmName === tenant.name;

  return (
    <Card>
      <CardBody className="gap-4">
        <h1 className="text-2xl font-semibold">{tenant.name}</h1>
        <p>
          Status: {tenant.lifecycleStatus} · Plan: {tenant.plan ?? '—'} · Users: {tenant.userCount}
        </p>
        {error ? <p className="text-danger">{error}</p> : null}

        <Textarea label="Reason (recorded in the audit trail)" value={reason} onValueChange={setReason} />

        <div className="flex flex-wrap gap-2">
          {tenant.lifecycleStatus === 'ACTIVE' ? (
            <Button color="warning" isDisabled={!reason.trim()} onPress={() => run('SUSPEND')}>
              Suspend
            </Button>
          ) : null}
          {tenant.lifecycleStatus === 'SUSPENDED' ? (
            <Button color="success" isDisabled={!reason.trim()} onPress={() => run('REACTIVATE')}>
              Reactivate
            </Button>
          ) : null}
        </div>

        {tenant.lifecycleStatus !== 'CLOSED' ? (
          <div className="flex flex-col gap-2 rounded border border-danger p-4">
            <p className="text-sm">Closing is permanent from this console. Type the organisation name to confirm.</p>
            <Input label="Organisation name" value={confirmName} onValueChange={setConfirmName} />
            <Button color="danger" isDisabled={!closeArmed || !reason.trim()} onPress={() => run('CLOSE')}>
              Close this organisation
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
```

- [ ] **Step 6: Build the web app**

Run: `cd apps/web && npm run build`
Expected: build succeeds. If `FormAlert` has a different prop shape than `children`, adapt the login page to match its actual signature in `apps/web/src/components/ui/form-alert.tsx`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/\(owner\) apps/web/src/lib/owner-api.ts
git commit -m "feat(web): add the platform owner console pages"
```

---

### Task 13: Sole-writer structural test and reliability ledger

**Files:**
- Create: `apps/api/src/tests/owner-sole-writer.test.ts`
- Modify: `docs/RELIABILITY.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a structural guarantee that only the owner service writes `Organisation.lifecycleStatus`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/owner-sole-writer.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Structural, not behavioural: this exists so the "console is the sole writer of
// tenant lifecycle" property cannot erode as the codebase grows. If a new file
// legitimately needs to write it, add it to ALLOWED and say why in the commit.
const ALLOWED = new Set(['services/owner-tenants.service.ts']);

const SRC = path.join(process.cwd(), 'src');

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) return [];
      return [full];
    }),
  );
  return files.flat();
}

test('only the owner tenants service writes Organisation.lifecycleStatus', async () => {
  const files = await sourceFiles(SRC);
  const offenders: string[] = [];

  for (const file of files) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    if (ALLOWED.has(relative)) continue;

    const source = await readFile(file, 'utf8');
    const writesViaPrisma = /organisation\.update\s*\(\s*\{[\s\S]{0,400}?lifecycleStatus/.test(source);
    const writesViaSql = /UPDATE\s+"Organisation"[\s\S]{0,200}?lifecycleStatus/i.test(source);
    if (writesViaPrisma || writesViaSql) offenders.push(relative);
  }

  assert.deepEqual(offenders, [], `unexpected writers of Organisation.lifecycleStatus: ${offenders.join(', ')}`);
});

test('no tenant-facing route imports the owner tenants service', async () => {
  const files = await sourceFiles(path.join(SRC, 'routes'));
  const offenders = [] as string[];

  for (const file of files) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    if (relative.startsWith('routes/owner/')) continue;
    const source = await readFile(file, 'utf8');
    if (source.includes('owner-tenants.service')) offenders.push(relative);
  }

  assert.deepEqual(offenders, [], `tenant routes must not import the owner service: ${offenders.join(', ')}`);
});
```

- [ ] **Step 2: Run the test**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/owner-sole-writer.test.js`
Expected: PASS, 2 tests. The test reads from `src/`, so it runs correctly from the compiled output as long as the working directory is `apps/api`.

If it FAILS naming a legitimate writer, that is the test doing its job — either move the write into `owner-tenants.service.ts` or add the file to `ALLOWED` with a justification.

- [ ] **Step 3: Add the ledger rows**

Append to the appropriate table in `docs/RELIABILITY.md`:

```markdown
| Token isolation | An owner token is rejected by every tenant route and a tenant token by every owner route; a token forged with JWT_SECRET but owner claims is rejected because the verifier uses OWNER_JWT_SECRET. | covered | `a token signed with the tenant secret but operator claims is rejected`<br/><sub>owner-jwt.test.ts</sub> |
| Deployment gating | Every owner route returns 404 under CHARITYPILOT_DEPLOYMENT_MODE=personal-server, because ownerRoutes registers nothing in that mode. | covered | `owner routes are not registered in personal-server mode`<br/><sub>owner-auth-routes.test.ts</sub> |
| Configuration | assertOwnerJwtSecretConfigured throws when OWNER_JWT_SECRET is unset or equals JWT_SECRET, so a deployment cannot silently collapse the two-secret isolation. | covered | `the boot guard rejects a secret equal to JWT_SECRET`<br/><sub>owner-jwt.test.ts</sub> |
| Login disclosure | A wrong password against a SUSPENDED organisation returns generic 401 INVALID_CREDENTIALS; only a correct password returns 403 ORGANISATION_SUSPENDED. | covered | `a wrong password against a SUSPENDED organisation stays generic`<br/><sub>login-suspension-disclosure.test.ts</sub> |
| Login disclosure | An unknown email still performs the dummy bcrypt comparison and returns generic 401. | covered | `an unknown email is still a generic 401`<br/><sub>login-suspension-disclosure.test.ts</sub> |
| Concurrency | transitionTenantLifecycle with a stale expectedLifecycleVersion throws 409 TENANT_LIFECYCLE_CONFLICT and performs no update and no audit write. | covered | `a version mismatch is refused before any write`<br/><sub>owner-tenant-lifecycle.test.ts</sub> |
| Atomicity | The lifecycle update and its SecurityAuditEvent are created inside one $transaction, so a failed transition leaves no orphan audit event. | covered | `suspending writes the status and the audit event together`<br/><sub>owner-tenant-lifecycle.test.ts</sub> |
| Terminal state | A CLOSED organisation cannot be reactivated from the console; the transition is refused before any write. | covered | `a closed tenant cannot be reopened from the console`<br/><sub>owner-tenant-lifecycle.test.ts</sub> |
| Provisioning | Provisioning with an already-registered email throws 409 EMAIL_ALREADY_REGISTERED and creates no organisation, diverging deliberately from register()'s anti-enumeration silence. | covered | `a duplicate email returns 409 and creates nothing`<br/><sub>owner-provisioning.test.ts</sub> |
| Operator enumeration | An unknown operator email at owner login costs the same bcrypt work and returns the same 401 as a wrong password. | covered | `an unknown operator email is indistinguishable from a wrong password`<br/><sub>owner-auth-routes.test.ts</sub> |
| Sole writer | No source file outside services/owner-tenants.service.ts writes Organisation.lifecycleStatus, and no tenant-facing route imports the owner service. | covered | `only the owner tenants service writes Organisation.lifecycleStatus`<br/><sub>owner-sole-writer.test.ts</sub> |
```

- [ ] **Step 4: Run the whole API suite**

Run: `cd apps/api && npm test`
Expected: PASS, including the pre-existing `team-reliability.test.ts` SUPERADMIN rejection test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tests/owner-sole-writer.test.ts docs/RELIABILITY.md
git commit -m "test(owner): guard the sole-writer property and record ledger invariants"
```

---

## Post-Implementation Notes

- `OWNER_JWT_SECRET` must be added to production env generation and the deployment checks in `scripts/generate-production-env.mjs` and `scripts/check-production*.mjs`. That is a separate piece of work, not covered here; until it is done, a production deploy will fail the Task 5 boot guard, which is the intended failure mode rather than a silent one.
- TOTP for operator accounts is the recommended next change, per the Accepted Risks section of the spec.
