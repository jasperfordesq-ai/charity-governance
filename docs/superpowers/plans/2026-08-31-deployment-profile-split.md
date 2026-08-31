# Deployment Profile Split (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `isPersonalServerDeployment()` into independent capability axes (tenancy, registration, email delivery, billing) so a deployment can be multi-tenant with local providers, while the shipped appliance behaves identically — frozen by a compatibility invariant.

**Architecture:** One new module per surface interprets env into capabilities: `apps/api/src/utils/deployment-profile.ts` (API) and `apps/web/src/lib/deployment-profile.ts` (web, from `NEXT_PUBLIC_` vars). Every current `isPersonalServerDeployment()` call site outside the appliance lifecycle is re-keyed to its true axis. Explicit env vars win; defaults derive from `CHARITYPILOT_DEPLOYMENT_MODE`, so no existing install changes behaviour without opting in.

**Tech Stack:** Fastify 5, Prisma 6, Zod, `node:test` + `node:assert/strict`, Next.js 16 app router.

**Spec:** `docs/superpowers/specs/2026-08-31-deployment-profile-and-bluegreen-design.md` (P1 section). This plan makes two recorded deviations: (1) a fourth axis `CHARITYPILOT_BILLING` (`stripe` | `none`) because "billing readiness keyed on Stripe config presence" is circular — a presence-keyed check can never fail; (2) forgot-password stays 404 under `manual-link` (operator-mediated reset on the VM is follow-up work). Task 1 amends the spec for both.

## Global Constraints

- API tests: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/<name>.test.js`; full suite `npm test`. Web tests: `cd apps/web && npm test`; build `npm run build`.
- Every relative import in `apps/api` carries a `.js` extension. Tests set env vars BEFORE dynamic imports (modules read env at import time) — follow `apps/api/src/tests/team-reliability.test.ts`'s `await Promise.all([import(...)])` pattern.
- **Never assert an error code with a bare regex** — `AppError` carries the code on `.code`. Use `const codeOf = (err: unknown) => (err as { code?: string })?.code;` with a predicate.
- **In-memory Prisma stubs must honour the `where` clause they are given.** A stub that ignores `where` tests the stub, not the service.
- **The appliance-compatibility invariant is sacred:** `CHARITYPILOT_DEPLOYMENT_MODE=personal-server` with none of the new vars set must resolve every re-keyed call site exactly as today. Same for default mode with no new vars (today's production behaviour).
- All axis readers take `(env: Record<string, string | undefined> = process.env)` — the repo convention in `utils/personal-server.ts` — and are resolved lazily, never at module load.
- `docs/RELIABILITY.md` is GENERATED. New guarantees go in `docs/reliability/guarantees.json`; `npm run reliability:report -- --write` must exit 0 (needs `DATABASE_URL` exported from `apps/api/.env`).
- The secret scanner (`npm run security:secrets`) blocks `re_`-prefixed literals outside test files — do not write Resend-style placeholders into docs or non-test code.
- `isPersonalServerDeployment()` itself, `PERSONAL_SERVER_DEPLOYMENT_MODE`, and all appliance-lifecycle consumers (installer jobs, `personal-server-account`, recovery-secret rotation, `personal-server-env.ts` branch selection, `getPersonalServerOrigin`) are NOT re-keyed and must not change behaviour.
- Work on branch `feat/deployment-profile-and-bluegreen`.

---

### Task 1: The API deployment-profile module (and spec amendments)

**Files:**
- Create: `apps/api/src/utils/deployment-profile.ts`
- Create: `apps/api/src/tests/deployment-profile.test.ts`
- Modify: `docs/superpowers/specs/2026-08-31-deployment-profile-and-bluegreen-design.md` (axis table + Accepted Risks)

**Interfaces:**
- Consumes: `PERSONAL_SERVER_DEPLOYMENT_MODE` from `./personal-server.js`.
- Produces (later tasks rely on these exact names):
  - `type DeploymentEnv = Record<string, string | undefined>`
  - `isMultiTenant(env?: DeploymentEnv): boolean`
  - `isRegistrationOpen(env?: DeploymentEnv): boolean`
  - `emailDeliveryMode(env?: DeploymentEnv): 'provider' | 'manual-link'`
  - `billingMode(env?: DeploymentEnv): 'stripe' | 'none'`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/deployment-profile.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

const [{ isMultiTenant, isRegistrationOpen, emailDeliveryMode, billingMode }] =
  await Promise.all([import('../utils/deployment-profile.js')]);

const APPLIANCE = { CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server' };
const DEFAULT = {};

test('appliance defaults: single tenancy, closed registration, manual links, no billing', () => {
  assert.equal(isMultiTenant(APPLIANCE), false);
  assert.equal(isRegistrationOpen(APPLIANCE), false);
  assert.equal(emailDeliveryMode(APPLIANCE), 'manual-link');
  assert.equal(billingMode(APPLIANCE), 'none');
});

test('default-mode defaults: multi tenancy, open registration, provider email, stripe billing', () => {
  assert.equal(isMultiTenant(DEFAULT), true);
  assert.equal(isRegistrationOpen(DEFAULT), true);
  assert.equal(emailDeliveryMode(DEFAULT), 'provider');
  assert.equal(billingMode(DEFAULT), 'stripe');
});

test('explicit values override the mode-derived default in both directions', () => {
  assert.equal(isMultiTenant({ ...APPLIANCE, CHARITYPILOT_TENANCY: 'multi' }), true);
  assert.equal(isMultiTenant({ CHARITYPILOT_TENANCY: 'single' }), false);
  assert.equal(isRegistrationOpen({ ...APPLIANCE, CHARITYPILOT_REGISTRATION: 'open' }), true);
  assert.equal(isRegistrationOpen({ CHARITYPILOT_REGISTRATION: 'closed' }), false);
  assert.equal(emailDeliveryMode({ ...APPLIANCE, CHARITYPILOT_EMAIL_DELIVERY: 'provider' }), 'provider');
  assert.equal(emailDeliveryMode({ CHARITYPILOT_EMAIL_DELIVERY: 'manual-link' }), 'manual-link');
  assert.equal(billingMode({ ...APPLIANCE, CHARITYPILOT_BILLING: 'stripe' }), 'stripe');
  assert.equal(billingMode({ CHARITYPILOT_BILLING: 'none' }), 'none');
});

test('the private-VM combination is representable', () => {
  const vm = {
    CHARITYPILOT_TENANCY: 'multi',
    CHARITYPILOT_REGISTRATION: 'closed',
    CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
    CHARITYPILOT_BILLING: 'none',
  };
  assert.equal(isMultiTenant(vm), true);
  assert.equal(isRegistrationOpen(vm), false);
  assert.equal(emailDeliveryMode(vm), 'manual-link');
  assert.equal(billingMode(vm), 'none');
});

test('an invalid axis value throws loudly and names the variable', () => {
  assert.throws(() => isMultiTenant({ CHARITYPILOT_TENANCY: 'both' }), /CHARITYPILOT_TENANCY/);
  assert.throws(() => isRegistrationOpen({ CHARITYPILOT_REGISTRATION: 'yes' }), /CHARITYPILOT_REGISTRATION/);
  assert.throws(() => emailDeliveryMode({ CHARITYPILOT_EMAIL_DELIVERY: 'smtp' }), /CHARITYPILOT_EMAIL_DELIVERY/);
  assert.throws(() => billingMode({ CHARITYPILOT_BILLING: 'paypal' }), /CHARITYPILOT_BILLING/);
});

test('whitespace or empty values are rejected, not treated as unset', () => {
  assert.throws(() => isMultiTenant({ CHARITYPILOT_TENANCY: ' multi' }), /CHARITYPILOT_TENANCY/);
  assert.throws(() => isMultiTenant({ CHARITYPILOT_TENANCY: '' }), /CHARITYPILOT_TENANCY/);
});
```

Note the empty-string case: an explicitly empty env var is a misconfiguration, not a default — silently falling back would hide a typo'd compose file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/deployment-profile.test.js`
Expected: FAIL — cannot find module `../utils/deployment-profile.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/utils/deployment-profile.ts`:

```ts
import { PERSONAL_SERVER_DEPLOYMENT_MODE } from './personal-server.js';

// The capability axes. One deployment "mode" used to imply all of these at
// once, which made multi-tenant-with-local-providers unrepresentable. Each
// axis is now its own env var; when unset, its default derives from
// CHARITYPILOT_DEPLOYMENT_MODE so every existing install keeps today's
// behaviour without setting anything.
//
// isPersonalServerDeployment() still exists — for the appliance LIFECYCLE
// only (installer jobs, recovery machinery, appliance env validation).
// Nothing behavioural should key on it any more; key on an axis here.

export type DeploymentEnv = Record<string, string | undefined>;

function isApplianceMode(env: DeploymentEnv): boolean {
  return env.CHARITYPILOT_DEPLOYMENT_MODE === PERSONAL_SERVER_DEPLOYMENT_MODE;
}

function axis<T extends string>(
  env: DeploymentEnv,
  name: string,
  allowed: readonly T[],
  applianceDefault: T,
  standardDefault: T,
): T {
  const raw = env[name];
  if (raw === undefined) {
    return isApplianceMode(env) ? applianceDefault : standardDefault;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(
      `FATAL: ${name} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as T;
}

export function isMultiTenant(env: DeploymentEnv = process.env): boolean {
  return axis(env, 'CHARITYPILOT_TENANCY', ['multi', 'single'] as const, 'single', 'multi') === 'multi';
}

export function isRegistrationOpen(env: DeploymentEnv = process.env): boolean {
  return axis(env, 'CHARITYPILOT_REGISTRATION', ['open', 'closed'] as const, 'closed', 'open') === 'open';
}

export function emailDeliveryMode(env: DeploymentEnv = process.env): 'provider' | 'manual-link' {
  return axis(env, 'CHARITYPILOT_EMAIL_DELIVERY', ['provider', 'manual-link'] as const, 'manual-link', 'provider');
}

export function billingMode(env: DeploymentEnv = process.env): 'stripe' | 'none' {
  return axis(env, 'CHARITYPILOT_BILLING', ['stripe', 'none'] as const, 'none', 'stripe');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/deployment-profile.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Amend the spec**

In `docs/superpowers/specs/2026-08-31-deployment-profile-and-bluegreen-design.md`:

1. Add a row to the P1 axes table:

```markdown
| Billing | `CHARITYPILOT_BILLING` | `stripe` \| `none` | `none` | `stripe` |
```

and after the table, this paragraph:

```markdown
The billing axis is a recorded deviation from the first draft, which keyed
billing readiness on "Stripe config presence" — circular, since a
presence-keyed check can never fail. `none` exempts billing from health
readiness and hides the tenant billing page; subscriptions are handled with
comped data instead.
```

2. In the P1 call-site table, replace the `password-recovery.service.ts` row's
   target with: *stays keyed on `isPersonalServerDeployment()` — its use
   selects audit labels describing the appliance operator flow
   (`SUPPORT`/`'Personal-server operator'`), which is lifecycle identity, not
   an email-delivery behaviour. The user-facing email-axis behaviour lives in
   the provider-email endpoint gate instead.*

3. Add to **Accepted Risks**:

```markdown
- **Forgot-password stays disabled (404) under `manual-link`.** A tenant on
  the self-contained VM who forgets their password needs the platform
  operator; the console has no per-tenant reset-link reissue yet. Follow-up
  work, deliberately out of P1.
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/utils/deployment-profile.ts apps/api/src/tests/deployment-profile.test.ts docs/superpowers/specs/2026-08-31-deployment-profile-and-bluegreen-design.md
git commit -m "feat(profile): add capability axes derived from the deployment mode"
```

---

### Task 2: Re-key the auth gates (registration + email axes)

**Files:**
- Modify: `apps/api/src/routes/auth/index.ts` (the register gate at ~:58 and `personalServerProviderAuthGuard` at ~:40)
- Create: `apps/api/src/tests/deployment-profile-auth-gates.test.ts`

**Interfaces:**
- Consumes: `isRegistrationOpen`, `emailDeliveryMode` from `../../utils/deployment-profile.js` (Task 1).
- Produces: register 404s iff registration is closed; the provider-auth endpoints (forgot-password/reset flows guarded by `personalServerProviderAuthGuard`) 404 iff email delivery is `manual-link`.

- [ ] **Step 1: Read the current code**

`apps/api/src/routes/auth/index.ts` currently has:

```ts
async function personalServerProviderAuthGuard(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!isPersonalServerDeployment()) return;
  reply.status(404).send({ error: "Not found", code: "NOT_FOUND" });
}
```

and inside the register handler:

```ts
      if (isPersonalServerDeployment()) {
        reply.status(404).send({ error: "Not found", code: "NOT_FOUND" });
        return;
      }
```

Find every route that attaches `personalServerProviderAuthGuard` (grep the file) and list them in your report — those are the email-axis surface.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/tests/deployment-profile-auth-gates.test.ts`. Build the app the way `owner-auth-routes.test.ts` does (Fastify + cookie + rate-limit + a Prisma stub), once per env fixture. The Prisma stub only needs the calls the guarded handlers make before the gate fires — the gate runs first, so a stub whose methods throw `new Error('should not be reached')` proves the 404 happened at the gate:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'gate-test-secret';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 'resend-test-key-placeholder';
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@example.org';

const [{ default: Fastify }, { default: cookie }, { default: rateLimit }, { authRoutes }] =
  await Promise.all([
    import('fastify'),
    import('@fastify/cookie'),
    import('@fastify/rate-limit'),
    import('../routes/auth/index.js'),
  ]);

function unreachablePrisma() {
  return new Proxy({}, {
    get: (_t, model) => new Proxy({}, {
      get: (_t2, op) => () => {
        throw new Error(`prisma.${String(model)}.${String(op)} reached — the gate did not fire`);
      },
    }),
  }) as never;
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.decorate('prisma', unreachablePrisma());
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  return app;
}

async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const REGISTER = { method: 'POST' as const, url: '/api/v1/auth/register', payload: { email: 'a@b.ie', password: 'x'.repeat(14), name: 'A', organisationName: 'Org' } };
const FORGOT = { method: 'POST' as const, url: '/api/v1/auth/forgot-password', payload: { email: 'a@b.ie' } };

test('registration closed => register 404s before any DB call', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: undefined, CHARITYPILOT_REGISTRATION: 'closed' }, async () => {
    const app = await buildApp();
    const res = await app.inject(REGISTER);
    assert.equal(res.statusCode, 404);
    await app.close();
  });
});

test('registration open in appliance mode => register is reachable (not 404)', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', CHARITYPILOT_REGISTRATION: 'open' }, async () => {
    const app = await buildApp();
    const res = await app.inject(REGISTER);
    assert.notEqual(res.statusCode, 404); // reaches the handler (which then hits the throwing stub => 500)
    await app.close();
  });
});

test('manual-link email => forgot-password 404s; provider email => reachable', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: undefined, CHARITYPILOT_EMAIL_DELIVERY: 'manual-link' }, async () => {
    const app = await buildApp();
    assert.equal((await app.inject(FORGOT)).statusCode, 404);
    await app.close();
  });
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', CHARITYPILOT_EMAIL_DELIVERY: 'provider' }, async () => {
    const app = await buildApp();
    assert.notEqual((await app.inject(FORGOT)).statusCode, 404);
    await app.close();
  });
});

test('APPLIANCE COMPATIBILITY: personal-server mode with no axis vars behaves exactly as today', async () => {
  await withEnv({
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    CHARITYPILOT_REGISTRATION: undefined,
    CHARITYPILOT_EMAIL_DELIVERY: undefined,
  }, async () => {
    const app = await buildApp();
    assert.equal((await app.inject(REGISTER)).statusCode, 404, 'register must stay 404 on the appliance');
    assert.equal((await app.inject(FORGOT)).statusCode, 404, 'forgot-password must stay 404 on the appliance');
    await app.close();
  });
});

test('DEFAULT COMPATIBILITY: no mode, no axis vars => both endpoints reachable', async () => {
  await withEnv({
    CHARITYPILOT_DEPLOYMENT_MODE: undefined,
    CHARITYPILOT_REGISTRATION: undefined,
    CHARITYPILOT_EMAIL_DELIVERY: undefined,
  }, async () => {
    const app = await buildApp();
    assert.notEqual((await app.inject(REGISTER)).statusCode, 404);
    assert.notEqual((await app.inject(FORGOT)).statusCode, 404);
    await app.close();
  });
});
```

If `forgot-password` is not among the routes guarded by `personalServerProviderAuthGuard`, adjust `FORGOT` to one that is (per your Step 1 listing) and say so in your report.

**Caution:** the axis functions read `process.env` lazily per call (Task 1), so `withEnv` works without re-importing modules — but if you find any gate capturing the value at registration time rather than per request, that is a bug to fix as part of this task: gates must evaluate per request, as `personalServerProviderAuthGuard` does today.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/deployment-profile-auth-gates.test.js`
Expected: FAIL — the closed-registration and manual-link tests fail (gates still keyed on mode).

- [ ] **Step 4: Re-key the gates**

In `apps/api/src/routes/auth/index.ts`:

```ts
import { isRegistrationOpen, emailDeliveryMode } from "../../utils/deployment-profile.js";
```

Rename and re-key the guard (update every attachment site; keep the same behaviour shape):

```ts
// Email-axis gate: these endpoints exist to send provider email. Under
// manual-link delivery they are hidden entirely (404, not 403) — the
// appliance's long-standing behaviour, now keyed on the axis that means it.
async function providerEmailAuthGuard(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (emailDeliveryMode() === "provider") return;
  reply.status(404).send({ error: "Not found", code: "NOT_FOUND" });
}
```

And the register gate:

```ts
      if (!isRegistrationOpen()) {
        reply.status(404).send({ error: "Not found", code: "NOT_FOUND" });
        return;
      }
```

Remove the `isPersonalServerDeployment` import from this file if nothing else in it uses it.

- [ ] **Step 5: Run the test, then the full suite**

Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/deployment-profile-auth-gates.test.js` — PASS, 5 tests.
Then: `cd apps/api && npm test` — all green (existing auth tests run in default mode with no axis vars, covered by the default-compat invariant).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth/index.ts apps/api/src/tests/deployment-profile-auth-gates.test.ts
git commit -m "feat(profile): key registration and provider-email gates on their axes"
```

---

### Task 3: Re-key the owner console gate and boot guard (tenancy axis)

**Files:**
- Modify: `apps/api/src/routes/owner/index.ts:33` (`if (isPersonalServerDeployment()) return;`)
- Modify: `apps/api/src/server.ts:78-80` (the `OWNER_JWT_SECRET` boot guard)
- Modify: `apps/api/src/tests/owner-auth-routes.test.ts` (the existing personal-server gating test)
- Create: `apps/api/src/tests/deployment-profile-tenancy.test.ts`

**Interfaces:**
- Consumes: `isMultiTenant` from Task 1.
- Produces: owner routes register iff `isMultiTenant()`; boot guard runs iff `isMultiTenant()`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/tests/deployment-profile-tenancy.test.ts`. Reuse the `withEnv` helper shape from Task 2 (copy it — test files in this repo are self-contained). Build the owner app the way `owner-auth-routes.test.ts` does. Assertions:

```ts
test('single tenancy in DEFAULT mode disables the owner console', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: undefined, CHARITYPILOT_TENANCY: 'single' }, async () => {
    const app = await buildOwnerApp();
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/owner/auth/me' })).statusCode, 404);
    await app.close();
  });
});

test('multi tenancy in APPLIANCE mode enables the owner console', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', CHARITYPILOT_TENANCY: 'multi' }, async () => {
    const app = await buildOwnerApp();
    // 401 (guard engaged), not 404 (routes absent)
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/owner/auth/me' })).statusCode, 401);
    await app.close();
  });
});

test('APPLIANCE COMPATIBILITY: personal-server mode, no axis vars => console absent', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', CHARITYPILOT_TENANCY: undefined }, async () => {
    const app = await buildOwnerApp();
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/owner/auth/me' })).statusCode, 404, 'the appliance must keep 404ing owner routes');
    await app.close();
  });
});

test('DEFAULT COMPATIBILITY: no mode, no axis vars => console present', async () => {
  await withEnv({ CHARITYPILOT_DEPLOYMENT_MODE: undefined, CHARITYPILOT_TENANCY: undefined }, async () => {
    const app = await buildOwnerApp();
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/owner/auth/me' })).statusCode, 401, 'default mode keeps the console live behind its guard');
    await app.close();
  });
});

test('the boot guard is keyed on tenancy, not mode (source assertion)', () => {
  const serverSource = readFileSync(join(process.cwd(), 'src', 'server.ts'), 'utf8');
  assert.match(serverSource, /if \(isMultiTenant\(\)\) \{\s*\n\s*assertOwnerJwtSecretConfigured\(\);/);
  assert.doesNotMatch(serverSource, /!isPersonalServerDeployment\(\)\) \{\s*\n\s*assertOwnerJwtSecretConfigured/);
});
```

Fill in the two compatibility tests with the same `withEnv`/inject shape (payloads shown in the neighbouring tests). Note `ownerRoutes` registration happens per-app-build, so per-fixture app construction gives fresh gating — no module cache concern.

- [ ] **Step 2: Run to verify it fails** — the single-tenancy-default and multi-tenancy-appliance tests fail; the source assertion fails.

- [ ] **Step 3: Re-key**

`apps/api/src/routes/owner/index.ts` — replace the mode import and gate:

```ts
import { isMultiTenant } from '../../utils/deployment-profile.js';
// ...
  // Single-tenant deployments must not expose a platform console at all.
  // Returning before registering anything means every owner path 404s.
  if (!isMultiTenant()) return;
```

`apps/api/src/server.ts` — replace the guard block (keep the comment's intent):

```ts
import { isMultiTenant } from './utils/deployment-profile.js';
// ...
// A deployment that serves the owner console must have a distinct owner secret.
// Collapsing the two secrets would silently remove the isolation the console relies on.
if (isMultiTenant()) {
  assertOwnerJwtSecretConfigured();
}
```

Remove the now-unused `isPersonalServerDeployment` import from `server.ts` **only if** nothing else in the file uses it — check before deleting.

- [ ] **Step 4: Update the existing gating test**

`apps/api/src/tests/owner-auth-routes.test.ts` has a test that sets `CHARITYPILOT_DEPLOYMENT_MODE=personal-server` and expects 404, plus a source-text assertion on `server.ts` matching `!isPersonalServerDeployment()`. Both still express real contracts — update them to the new keying: the 404 test stands as-is (appliance default ⇒ single ⇒ 404 — it now passes through the axis), and the source assertion must be updated to match the new `isMultiTenant()` form. Do not delete either; re-point them.

- [ ] **Step 5: Run focused + full suite** — both green: `node --test dist/tests/deployment-profile-tenancy.test.js dist/tests/owner-auth-routes.test.js`, then `npm test`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/owner/index.ts apps/api/src/server.ts apps/api/src/tests/deployment-profile-tenancy.test.ts apps/api/src/tests/owner-auth-routes.test.ts
git commit -m "feat(profile): key the owner console and its boot guard on tenancy"
```

---

### Task 4: Health readiness and the manual invite link (email + billing axes)

**Files:**
- Modify: `apps/api/src/routes/health/index.ts:220-222`
- Modify: `apps/api/src/utils/personal-server.ts:63-74` (generalise the invite-URL origin)
- Modify: `apps/api/src/services/team.service.ts:371-378` and `:525`
- Create: `apps/api/src/tests/deployment-profile-providers.test.ts`

**Interfaces:**
- Consumes: `emailDeliveryMode`, `billingMode` from Task 1; `getPersonalServerOrigin` from `./personal-server.js`.
- Produces: `manualInviteUrl(token: string, env?: DeploymentEnv): string | null` in `utils/deployment-profile.ts` — origin from the personal-server origin when in appliance mode, `FRONTEND_URL` otherwise; token in the URL **fragment** (never the query string).

- [ ] **Step 1: Read the current code**

`routes/health/index.ts:220`:

```ts
    const providerChecksReady = isPersonalServerDeployment() || (
      checks.billingConfigured && checks.emailConfigured
    );
```

`utils/personal-server.ts:63` (`personalServerManualInviteUrl`) builds `/accept-invite` with `inviteUrl.hash = new URLSearchParams({ token }).toString()` from `getPersonalServerOrigin`. `team.service.ts:371` keys surfacing on `isPersonalServerDeployment()`; `:525` (invite-link reissue) calls the helper directly.

- [ ] **Step 2: Write the failing test**

`apps/api/src/tests/deployment-profile-providers.test.ts` (self-contained `withEnv` again):

```ts
test('health: manual-link + billing none => provider checks exempt', async () => {
  // Build the health app with stubs reporting billingConfigured=false,
  // emailConfigured=false (follow the existing health test file's stub shape),
  // env: no mode, EMAIL_DELIVERY=manual-link, BILLING=none.
  // Expect readiness NOT blocked by providers.
});
test('health: provider email missing config still blocks readiness in default mode', async () => { /* as today */ });
test('health APPLIANCE COMPATIBILITY: personal-server mode, no vars => providers exempt (as today)', async () => {});

test('manualInviteUrl uses the personal-server origin in appliance mode', () => {
  const url = manualInviteUrl('tok123', {
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    PERSONAL_SERVER_PUBLIC_ORIGIN: 'https://charitypilot.tail.example.ts.net',
  });
  assert.equal(url, 'https://charitypilot.tail.example.ts.net/accept-invite#token=tok123');
});

test('manualInviteUrl falls back to FRONTEND_URL outside appliance mode', () => {
  const url = manualInviteUrl('tok123', { FRONTEND_URL: 'https://charitypilot.tail.example.ts.net' });
  assert.equal(url, 'https://charitypilot.tail.example.ts.net/accept-invite#token=tok123');
});

test('manualInviteUrl returns null with no usable origin, and never puts the token in the query string', () => {
  assert.equal(manualInviteUrl('tok123', {}), null);
  const url = manualInviteUrl('tok123', { FRONTEND_URL: 'https://x.example' });
  assert.ok(url && !url.includes('?token='), 'token must ride the fragment');
});
```

Check the exact env var name `getPersonalServerOrigin` reads (open `utils/personal-server.ts:40-60`) and use it verbatim in the appliance-mode test. For the health tests, follow the app-construction pattern of the existing health test file — find it with `ls apps/api/src/tests | grep -i health` and mirror its stubs; do not invent a new harness.

- [ ] **Step 3: Run to verify it fails** — `manualInviteUrl` does not exist; the health manual-link test fails.

- [ ] **Step 4: Implement**

Add to `apps/api/src/utils/deployment-profile.ts`:

```ts
import { getPersonalServerOrigin } from './personal-server.js';

// Where manually surfaced links point. In appliance mode the validated
// personal-server origin wins (its parsing enforces origin-exactness);
// otherwise FRONTEND_URL — required by production env validation — is the
// tenant web origin. The token rides the URL FRAGMENT, never the query
// string: fragments do not reach servers, proxies, or access logs.
function manualLinkOrigin(env: DeploymentEnv): URL | null {
  const personal = getPersonalServerOrigin(env);
  if (personal) return personal;
  const frontend = env.FRONTEND_URL;
  if (!frontend) return null;
  try {
    const url = new URL(frontend);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export function manualInviteUrl(token: string, env: DeploymentEnv = process.env): string | null {
  const origin = manualLinkOrigin(env);
  if (!origin || !token) return null;
  const inviteUrl = new URL('/accept-invite', origin);
  inviteUrl.hash = new URLSearchParams({ token }).toString();
  return inviteUrl.toString();
}
```

`personalServerManualInviteUrl` in `utils/personal-server.ts` becomes a thin delegate (keep the export — `team.service.ts:525` and any tests reference it):

```ts
export function personalServerManualInviteUrl(
  token: string,
  env: DeploymentEnv = process.env,
): string | null {
  const origin = getPersonalServerOrigin(env);
  if (!origin || !token) return null;
  const inviteUrl = new URL('/accept-invite', origin);
  inviteUrl.hash = new URLSearchParams({ token }).toString();
  return inviteUrl.toString();
}
```

(Unchanged in behaviour; the new generalised helper lives in the profile module so `personal-server.ts` stays appliance-only.)

`team.service.ts` — re-key both sites on the email axis:

```ts
import { emailDeliveryMode, manualInviteUrl } from '../utils/deployment-profile.js';
// :371
    const manualLink = emailDeliveryMode() === 'manual-link'
      ? manualInviteUrl(inviteToken)
      : null;
    if (emailDeliveryMode() === 'manual-link' && !manualLink) {
      throw new AppError(
        500,
        'MANUAL_INVITE_ORIGIN_INVALID',
        'No safe origin is configured for manual invite links',
      );
    }
```

Keep the variable name `manualInviteUrl` colliding? It does — the local `const manualInviteUrl` at :371 collides with the import. Rename the local to `manualLink` as shown, and update its uses through the function. At `:525` (reissue), replace `personalServerManualInviteUrl(inviteToken)` with `manualInviteUrl(inviteToken)` so reissue works on any manual-link deployment. Check what `:516`'s `if (!isPersonalServerDeployment())` guards — if it gates the reissue feature itself, re-key it to `emailDeliveryMode() === 'manual-link'`.

Keep the old error code `PERSONAL_SERVER_ORIGIN_INVALID`? No — but check for tests/web code matching it first (`grep -rn "PERSONAL_SERVER_ORIGIN_INVALID" apps`); update any hit to the new code and note it in your report.

`routes/health/index.ts:220`:

```ts
    const providerChecksReady =
      (emailDeliveryMode() === 'manual-link' || checks.emailConfigured) &&
      (billingMode() === 'none' || checks.billingConfigured);
```

- [ ] **Step 5: Run focused + full suite** — green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/utils/deployment-profile.ts apps/api/src/utils/personal-server.ts apps/api/src/services/team.service.ts apps/api/src/routes/health/index.ts apps/api/src/tests/deployment-profile-providers.test.ts
git commit -m "feat(profile): key health readiness and manual invite links on the provider axes"
```

---

### Task 5: Axis-aware production env validation

**Files:**
- Modify: `apps/api/src/utils/env.ts` (inside `validateProductionEnv` ONLY — the personal-server branch is untouched)
- Create: `apps/api/src/tests/deployment-profile-env-validation.test.ts`

**Interfaces:**
- Consumes: `emailDeliveryMode`, `billingMode`, `isMultiTenant` from Task 1; storage axis via `DOCUMENT_STORAGE_DRIVER`.
- Produces: `validateProductionEnv` accepts a self-contained configuration.

- [ ] **Step 1: Locate the exact requirement sites inside `validateProductionEnv`**

`grep -n "validateProductionEnv" apps/api/src/utils/env.ts` for the function boundary, then within it find: `requireUrl('SUPABASE_URL', …)` / `requireConfiguredEnv('SUPABASE_SERVICE_ROLE_KEY', …)` / `requireConfiguredEnv('SUPABASE_STORAGE_BUCKET', …)` (~:474-476), `requirePrefix('RESEND_API_KEY', …)` / `requireApprovedEmailSender('EMAIL_FROM', …)` (there are several RESEND/EMAIL_FROM lines in the file — only the ones inside `validateProductionEnv` change; identify which of :500/:524/:602 those are and record it in your report). Also locate the Stripe requirements inside the same function (`grep -n "STRIPE" apps/api/src/utils/env.ts`).

- [ ] **Step 2: Write the failing test**

```ts
test('self-contained config passes: storage local, email manual-link, billing none', () => {
  const issues = validateProductionEnvIssues(selfContainedEnv());
  assert.deepEqual(issues.filter(i => /SUPABASE|RESEND|EMAIL_FROM|STRIPE/.test(i)), []);
});
test('local storage still requires the local storage path config', () => { /* asserts the mirrored appliance check fires when missing */ });
test('provider email still requires RESEND_API_KEY and EMAIL_FROM', () => { /* default axes, missing vars => issues name them */ });
test('supabase storage still requires the trio', () => {});
test('stripe billing still requires the stripe secrets', () => {});
test('multi tenancy still requires OWNER_JWT_SECRET distinct from JWT_SECRET', () => { /* existing rule unchanged, now via isMultiTenant() */ });
test('single tenancy skips the OWNER_JWT_SECRET requirement', () => {});
```

How to call it: check how existing env tests invoke validation (`grep -rn "validateProductionEnv" apps/api/src/tests | head -3`) and mirror that harness exactly — if the function throws an aggregate rather than returning issues, assert on the thrown message with a predicate (never a bare-regex code match). `selfContainedEnv()` is a fixture with every unconditionally-required var present (copy the baseline from an existing passing env fixture in those tests) plus `DOCUMENT_STORAGE_DRIVER=local`, `CHARITYPILOT_EMAIL_DELIVERY=manual-link`, `CHARITYPILOT_BILLING=none`, `OWNER_JWT_SECRET` set (multi is the default), and whatever local-storage path var the appliance checks require.

- [ ] **Step 3: Run to verify it fails** — the self-contained fixture produces SUPABASE/RESEND issues today.

- [ ] **Step 4: Implement**

Inside `validateProductionEnv`, wrap each provider block in its axis:

```ts
  if (env.DOCUMENT_STORAGE_DRIVER === LOCAL_STORAGE_DRIVER) {
    // Self-contained storage: mirror the appliance's local-storage checks.
    // (Copy the exact checks from validatePersonalServerEnv's storage section —
    // path presence and shape — so both validators demand the same thing.)
  } else {
    requireUrl('SUPABASE_URL', issues, { requireHttps: true, requirePublicHost: true });
    requireConfiguredEnv('SUPABASE_SERVICE_ROLE_KEY', issues);
    requireConfiguredEnv('SUPABASE_STORAGE_BUCKET', issues);
  }

  if (emailDeliveryMode(env) === 'provider') {
    requirePrefix('RESEND_API_KEY', 're_', 'Resend API key', issues);
    requireApprovedEmailSender('EMAIL_FROM', issues);
  }

  if (billingMode(env) === 'stripe') {
    /* existing Stripe requirements, unchanged, moved inside */
  }

  if (isMultiTenant(env)) {
    /* existing OWNER_JWT_SECRET length + distinctness checks, moved inside */
  }
```

Import the axis functions with the `env` argument — validation must judge the env object it was handed, not ambient `process.env`. Check the existing function's signature: if it takes an env parameter, thread it; if it reads `process.env` directly, keep that convention but note it in your report.

`FRONTEND_URL` stays unconditional (manual links need it). Do not touch `validatePersonalServerEnv` or `validateRuntimeEnv`'s branch selection.

- [ ] **Step 5: Run focused + full suite; also `node scripts/check-production.mjs --help` still exits cleanly** (that script has its own REQUIRED list for the SaaS host and is out of P1 scope — confirm you did not change its behaviour).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/utils/env.ts apps/api/src/tests/deployment-profile-env-validation.test.ts
git commit -m "feat(profile): make production env validation axis-aware"
```

---

### Task 6: Provisioning under manual-link, and comped tenants (service + route)

**Files:**
- Modify: `apps/api/src/services/owner-provisioning.service.ts`
- Modify: `apps/api/src/routes/owner/tenants.ts` (`provisionBodySchema` + response)
- Modify: `apps/api/src/tests/owner-provisioning.test.ts`

**Interfaces:**
- Consumes: `emailDeliveryMode` (Task 1).
- Produces: `provisionTenant` returns `{ organisationId, userId, links?: { setPassword: string; verifyEmail: string } }` — `links` present iff `emailDeliveryMode() === 'manual-link'`. Request gains `billing: 'trial' | 'comped'` (default `'trial'`).

- [ ] **Step 1: Write the failing tests** (extend the existing file; its store-stub already honours `where`)

```ts
test('manual-link: no emails are sent and both links are returned in the fragment form', async () => {
  // env: CHARITYPILOT_EMAIL_DELIVERY=manual-link, FRONTEND_URL=https://charitypilot.tail.example.ts.net
  // assert emailService.sendWelcomeEmail / sendEmailVerification / sendPasswordRecoveryEmail were NOT called
  // assert result.links.setPassword === 'https://charitypilot.tail.example.ts.net/reset-password#token=' + <raw reset token>
  // assert result.links.verifyEmail  === 'https://charitypilot.tail.example.ts.net/verify-email#token=' + <raw verify token>
  // assert the STORED hashes still match sha256 of the raw tokens embedded in the links
});
test('provider email: emails sent, no links in the response (today’s behaviour)', async () => {});
test('comped billing creates ACTIVE with null trialEndsAt', async () => {
  // billing: 'comped' => subscription create called with { plan, status: 'ACTIVE', trialEndsAt: null }
});
test('trial billing requires trialDays; comped forbids it', async () => {
  // exercise the route schema via app.inject: trial without trialDays => 400 VALIDATION_ERROR;
  // comped with trialDays => 400 VALIDATION_ERROR
});
```

Follow the existing tests' harness (they already stub the email service and capture creates; extend, don't rewrite). The link assertions must recompute sha256 of the token extracted from the link and compare to the stored hash — the same invariant discipline the file already has.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the service**

In `owner-provisioning.service.ts`:

1. Input type gains `billing: 'trial' | 'comped'`; `trialDays` becomes `number | undefined` (route schema enforces the pairing; the service still guards: `billing === 'trial'` requires a positive integer `trialDays` — keep the existing `INVALID_TRIAL_DAYS` check for that arm).
2. Subscription create becomes:

```ts
    await tx.subscription.create({
      data: input.billing === 'comped'
        // The appliance's own shape for a non-expiring subscription:
        // ACTIVE with no trial end. subscriptionGuard honours the data.
        ? { organisationId: organisation.id, plan: input.plan, status: 'ACTIVE', trialEndsAt: null }
        : { organisationId: organisation.id, plan: input.plan, status: 'TRIALING', trialEndsAt },
    });
```

3. After the transaction commits, branch on the email axis:

```ts
  if (emailDeliveryMode() === 'manual-link') {
    // No email provider exists on this deployment. The links are surfaced
    // ONCE to the authenticated platform operator — the same trust decision
    // as the appliance's manual invite links. Tokens ride the URL fragment,
    // which never reaches server logs or proxies.
    return {
      organisationId: created.organisationId,
      userId: created.userId,
      links: {
        setPassword: manualAuthLinkUrl('/reset-password', resetToken),
        verifyEmail: manualAuthLinkUrl('/verify-email', verifyToken),
      },
    };
  }

  // Sent only after the transaction commits (unchanged rationale) …
  void emailService.sendWelcomeEmail(email, ownerName, input.organisationName);
  void emailService.sendEmailVerification(email, ownerName, verifyToken);
  void emailService.sendPasswordRecoveryEmail(/* existing args unchanged */);
  return { organisationId: created.organisationId, userId: created.userId };
```

with a small helper added to `utils/deployment-profile.ts` (exported, tested in this task's suite):

```ts
export function manualAuthLinkUrl(
  path: '/reset-password' | '/verify-email' | '/accept-invite',
  token: string,
  env: DeploymentEnv = process.env,
): string | null {
  const origin = manualLinkOrigin(env);
  if (!origin || !token) return null;
  const url = new URL(path, origin);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}
```

Refactor `manualInviteUrl` to delegate to it. If `manualAuthLinkUrl` returns null under manual-link (no origin configured), throw `new AppError(500, 'MANUAL_LINK_ORIGIN_INVALID', 'No safe origin is configured for manual links')` **before** the transaction — a provision whose links cannot be delivered must not create the tenant. Add a test for that ordering (`creates nothing when the manual-link origin is missing`).

4. Confirm the tenant reset/verify pages actually read fragment tokens: `grep -n "useSensitiveQueryToken\|location.hash" apps/web/src/lib/use-sensitive-query-token.ts`. The proxy rewrites `?token=` to fragments on sensitive paths, so the hook reads fragments — verify and cite the line in your report. If it reads only query params, STOP and report BLOCKED with what you found (the fix would belong to the hook, not to link format).

- [ ] **Step 4: Route schema** (`routes/owner/tenants.ts`):

```ts
  const provisionBodySchema = z
    .object({
      organisationName: z.string().trim().min(1).max(200),
      ownerName: z.string().trim().min(1).max(200),
      ownerEmail: z.string().email().max(254),
      plan: z.enum(['ESSENTIALS', 'COMPLETE']),
      billing: z.enum(['trial', 'comped']).default('trial'),
      trialDays: z.number().int().min(1).max(365).optional(),
    })
    .superRefine((body, ctx) => {
      if (body.billing === 'trial' && body.trialDays === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['trialDays'], message: 'trialDays is required for trial billing' });
      }
      if (body.billing === 'comped' && body.trialDays !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['trialDays'], message: 'trialDays is not allowed for comped billing' });
      }
    });
```

The 201 response passes the service result through unchanged (links included when present).

- [ ] **Step 5: Run focused + full suite** — green. The pre-existing provider-mode tests must pass without modification (they run with no axis vars ⇒ provider ⇒ unchanged behaviour); if any needed changing, explain why in your report.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/owner-provisioning.service.ts apps/api/src/routes/owner/tenants.ts apps/api/src/utils/deployment-profile.ts apps/api/src/tests/owner-provisioning.test.ts
git commit -m "feat(profile): manual-link provisioning links and comped tenants"
```

---

### Task 7: Console UI for billing choice and one-time links

**Files:**
- Modify: `apps/web/src/app/(owner)/owner/tenants/new/page.tsx`
- Modify: `apps/web/src/lib/owner-api.ts` (`provisionTenant` request/response types)

**Interfaces:**
- Consumes: Task 6's request/response contract.
- Produces: the provision form offers `billing: trial (with days) | comped`; on success, when `links` is present the page renders both links ONCE with copy-to-clipboard buttons and an explicit "shown once — copy now" warning; when absent it shows today's success state.

- [ ] **Step 1: Read the current form** (`tenants/new/page.tsx`) and `ownerApi.provisionTenant`. Extend, matching the console's existing HeroUI style:
  - A `RadioGroup` (or the file's existing selection idiom) for billing; the `trialDays` input renders only for `trial`.
  - Success state: if `result.links`, render a bordered panel with the two links in read-only inputs + copy buttons and the warning text: "These links are shown once and are not emailed. Copy them now and pass them to the charity owner." Navigation away discards them — no storage, no re-fetch (there is deliberately no endpoint to re-read them).
- [ ] **Step 2: Types** in `owner-api.ts`:

```ts
  async provisionTenant(body: {
    organisationName: string;
    ownerName: string;
    ownerEmail: string;
    plan: 'ESSENTIALS' | 'COMPLETE';
    billing: 'trial' | 'comped';
    trialDays?: number;
  }) {
    const { data } = await client.post('/tenants', body);
    return data as {
      organisationId: string;
      userId: string;
      links?: { setPassword: string; verifyEmail: string };
    };
  },
```

- [ ] **Step 3: Verify** — `cd apps/web && npm test && npm run build && npm run lint`. No new page routes, so the pinned tenant-isolation segment sets are untouched — confirm the suite agrees.
- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(owner\)/owner/tenants/new/page.tsx apps/web/src/lib/owner-api.ts
git commit -m "feat(web): billing choice and one-time manual links in tenant provisioning"
```

---

### Task 8: The web deployment-profile helper and call-site re-keying

**Files:**
- Create: `apps/web/src/lib/deployment-profile.ts`
- Create: `apps/web/src/lib/deployment-profile.test.ts`
- Modify (re-key `NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE` checks by their true axis):
  - `apps/web/src/app/(auth)/login/page.tsx` (~:30,66,115,138)
  - `apps/web/src/app/(auth)/forgot-password/page.tsx` (~:16,22)
  - `apps/web/src/app/(auth)/reset-password/page.tsx` (~:19,110,115,142)
  - `apps/web/src/app/(dashboard)/layout.tsx` (~:123-124,309)
  - `apps/web/src/app/(dashboard)/team/page.tsx` (~:25) and `team/use-invite-link-reissue.ts`
  - `apps/web/src/app/(marketing)/layout.tsx` (~:10,39,69,72,77)
  - `apps/web/src/lib/auth-error-message.ts` (~:19, `PERSONAL_SERVER_DEPLOYMENT` and `isPersonalServer` origin logic)

**Interfaces:**
- Produces: `webTenancyIsMulti()`, `webRegistrationIsOpen()`, `webEmailDelivery()`, `webBillingMode()` — reading `NEXT_PUBLIC_CHARITYPILOT_{TENANCY,REGISTRATION,EMAIL_DELIVERY,BILLING}` with defaults derived from `NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE` (same derivation table as the API module). Next.js inlines `process.env.NEXT_PUBLIC_*` only as static property accesses, so the helper must reference each variable literally — no dynamic `env[name]` lookup:

```ts
const MODE = process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE;
const APPLIANCE = MODE === 'personal-server';

function pick<T extends string>(raw: string | undefined, allowed: readonly T[], applianceDefault: T, standardDefault: T): T {
  if (raw === undefined) return APPLIANCE ? applianceDefault : standardDefault;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`Invalid deployment-profile value: ${raw}`);
  }
  return raw as T;
}

export const webTenancyIsMulti = () =>
  pick(process.env.NEXT_PUBLIC_CHARITYPILOT_TENANCY, ['multi', 'single'] as const, 'single', 'multi') === 'multi';
export const webRegistrationIsOpen = () =>
  pick(process.env.NEXT_PUBLIC_CHARITYPILOT_REGISTRATION, ['open', 'closed'] as const, 'closed', 'open') === 'open';
export const webEmailDelivery = () =>
  pick(process.env.NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY, ['provider', 'manual-link'] as const, 'manual-link', 'provider');
export const webBillingMode = () =>
  pick(process.env.NEXT_PUBLIC_CHARITYPILOT_BILLING, ['stripe', 'none'] as const, 'none', 'stripe');
```

- [ ] **Step 1: Write the helper test** (Node side of the web suite): appliance defaults, standard defaults, explicit override, invalid throws — mirror Task 1's cases using `process.env` save/restore since these read live env.

- [ ] **Step 2: Re-key each call site by its REASON, not mechanically.** For each file, read the branch and decide which axis the check truly expresses, then replace. The expected mapping — verify each against the actual JSX and record any you judged differently, with the reason:

| Site | Branch means | Axis |
| --- | --- | --- |
| login: register link / "start trial" hint (~:138) | can new orgs sign up? | `webRegistrationIsOpen()` |
| login: subtitle + support copy (~:66,115) | is reset self-service or operator-mediated? | `webEmailDelivery() === 'manual-link'` |
| forgot-password: disabled page (~:22) | no provider email | email axis |
| reset-password: copy variants (~:110,115,142) | operator-issued vs emailed link wording | email axis |
| dashboard layout: `visibleNavItems` trimming (~:124) | is there a Billing page to show? | `webBillingMode() === 'none'` for the billing item; if other items are trimmed too, judge each (a team item is tenancy-agnostic; report what you find) |
| dashboard layout: footer label (~:309) | "private server" branding | keep on the MODE check — appliance branding is lifecycle, not an axis; leave `NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE` here |
| team page + reissue hook | manual invite links shown? | email axis |
| marketing layout: register CTA (~:69,72) | can visitors sign up? | registration axis (closed ⇒ "Sign in" → `/login`) |
| marketing layout: nav trimming (~:39,77) | judge per item, same rules |
| `auth-error-message.ts` `isPersonalServer` origin comparison | single-origin deployment heuristic for network-failure classification | keep on MODE — it describes the appliance's one-origin topology, not an axis. Do not re-key; add a comment saying so |

- [ ] **Step 3: Verify** — `cd apps/web && npm test && npm run build && npm run lint`. Then the critical check: **build once with `NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE=personal-server` and no axis vars** and grep the built HTML/JS for a register CTA to confirm appliance output is unchanged (spot-check, note method and result in the report).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/deployment-profile.ts apps/web/src/lib/deployment-profile.test.ts apps/web/src/app apps/web/src/lib/auth-error-message.ts
git commit -m "feat(web): key UI branches on capability axes instead of the deployment mode"
```

---

### Task 9: Structural guard, env examples, and the reliability ledger

**Files:**
- Create: `apps/api/src/tests/deployment-profile-structure.test.ts`
- Modify: `.env.example`, `.env.production.example`
- Modify: `docs/reliability/guarantees.json` (+ regenerate `docs/RELIABILITY.md`)

**Interfaces:** none produced; this task locks P1 in place.

- [ ] **Step 1: Write the structural test** (the sole-writer pattern from `owner-sole-writer.test.ts` — walk `src/`, skip `.test.` files):

```ts
// Only the appliance LIFECYCLE may key on isPersonalServerDeployment().
// Behavioural code keys on a capability axis in utils/deployment-profile.ts.
// Adding a file here means you are writing appliance-lifecycle code — say
// why in the commit message.
const ALLOWED = new Set([
  'utils/personal-server.ts',
  'utils/personal-server-env.ts',
  'utils/deployment-profile.ts',
  'jobs/initialize-personal-server.ts',
  'jobs/personal-server-account.ts',
  'jobs/rebind-personal-server-auth-recovery-secret.ts',
  'jobs/rotate-auth-recovery-secret.ts',
  'services/auth-recovery-control.ts',
  'services/password-recovery.service.ts', // audit labels describe the appliance operator flow — deliberate
  'routes/health/index.ts',                // remove if Task 4 eliminated its use; verify
]);
```

Before finalising `ALLOWED`, run `grep -rln "isPersonalServerDeployment" apps/api/src --include=*.ts | grep -v test` and reconcile: every remaining consumer must be either genuinely lifecycle (allowlist it, with the comment) or a missed re-key (fix it — do not allowlist around a miss). `password-recovery.service.ts` stays: its use selects audit labels for the appliance operator flow, ruled deliberate in the spec work. If `routes/health` no longer imports it after Task 4, drop it from the list. Second test: no file under `src/routes/` or `src/services/` (outside the allowlist) references `CHARITYPILOT_DEPLOYMENT_MODE` directly.

- [ ] **Step 2: Env examples.** Add to `.env.example` and `.env.production.example`, commented-out with one explanatory line each (they are OPTIONAL — defaults derive from the mode):

```bash
# Capability axes (optional — defaults derive from CHARITYPILOT_DEPLOYMENT_MODE).
# CHARITYPILOT_TENANCY=multi            # multi | single
# CHARITYPILOT_REGISTRATION=open        # open | closed
# CHARITYPILOT_EMAIL_DELIVERY=provider  # provider | manual-link
# CHARITYPILOT_BILLING=stripe           # stripe | none
# NEXT_PUBLIC_CHARITYPILOT_TENANCY=
# NEXT_PUBLIC_CHARITYPILOT_REGISTRATION=
# NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY=
# NEXT_PUBLIC_CHARITYPILOT_BILLING=
```

- [ ] **Step 3: Ledger.** Add guarantees to `docs/reliability/guarantees.json` (group them where the generator's taxonomy fits — check `CONCERN_LABEL` in `scripts/reliability-report.mjs`; likely `authz-boundary` and `input-validation`), each citing its exact test title verbatim:
  - appliance-compatibility invariant (register + forgot-password + console; cite the Task 2 and Task 3 compat tests)
  - default-mode compatibility invariant
  - registration axis gates register before any DB call
  - manual-link axis hides provider-email endpoints
  - single tenancy disables the console; multi requires the distinct owner secret at boot
  - self-contained env validation passes with no Supabase/Resend/Stripe
  - manual provisioning links carry tokens in the fragment and hash-match stored tokens
  - comped tenants are ACTIVE with null trialEndsAt
  - structural: only lifecycle files reference `isPersonalServerDeployment`
  Claim exactly what each cited test proves — no more. Then `export DATABASE_URL=$(grep '^DATABASE_URL=' apps/api/.env | cut -d= -f2-)` and `npm run reliability:report -- --write` from the repo root — must exit 0 with zero broken links.

- [ ] **Step 4: Full verification** — repo root: `npm test` (all four chained suites) — exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tests/deployment-profile-structure.test.ts .env.example .env.production.example docs/reliability/guarantees.json docs/RELIABILITY.md
git commit -m "test(profile): structural guard, env examples, and ledger rows for the axis split"
```

---

## Post-Implementation Notes

- The VM's actual env file (axes + `OWNER_JWT_SECRET` + `OWNER_CONSOLE_ORIGIN` + local storage path) is written in P3, not here. P1 ships inert everywhere.
- `scripts/check-production.mjs`'s REQUIRED list still describes the Supabase/Resend SaaS host — P2's blue-green preflight gets its own axis-aware check; out of P1 scope on purpose.
- Operator-mediated tenant password reset under `manual-link` (a console "reissue reset link" per tenant) is recorded follow-up work in the spec's Accepted Risks.
