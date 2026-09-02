# Private VM Cutover to Blue-Green (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Hyper-V private server from the personal-server appliance install to the blue-green deploy engine — same data volumes, same Tailscale origin, no VM teardown — so that from then on a deploy is `npm run bluegreen:deploy` over SSH.

**Architecture:** Tasks 1–3 make three small, tested changes to `scripts/bluegreen-deploy.mjs` that the VM target needs and the local acceptance never exercised (the appliance's database is named `charitypilot_personal_server`, not `charitypilot`; the engine hardcodes a single `-f compose.bluegreen.yml`; and a first deploy runs its backup against a `db` container nothing has started yet). Tasks 4–6 add the three VM-specific artifacts: a Compose override that points the engine's volumes at the appliance's existing external volumes, an env-file template derived from the appliance's env, and the nightly backup wrapper that replaces the appliance cron. Task 7 documents and ledgers. Task 8 is the cutover itself — an operator-executed, gated checklist with a Hyper-V checkpoint as the whole-cutover rollback, recorded as evidence rather than automated tests.

**Tech Stack:** Node 22 `.mjs` scripts + `node:test`; Docker Compose multi-file merge (`-f a.yml -f b.yml`), external named volumes; Caddy 2; Postgres 16.4 (byte-identical image digest in both compose files); Tailscale Serve (unchanged); Hyper-V checkpoints (PowerShell, elevated).

**Spec:** `docs/superpowers/specs/2026-08-31-deployment-profile-and-bluegreen-design.md` — section "P3 — VM cutover" (Mechanism, Named prerequisite, Sequence, What the appliance becomes, Rollback during cutover) and "Accepted Risks". The engine it drives is documented in `docs/bluegreen-runbook.md`; the appliance it retires in `D:\CharityPilot-VM\provision\RUNBOOK.md` (private, off-repo).

## Global Constraints

- **The hosted SaaS profile and the local/scratch profile must be unchanged with zero new env vars set.** Every engine change here defaults to today's exact behaviour (`charitypilot`/`charitypilot` database identity, a single `-f compose.bluegreen.yml`, no extra preflight issue). Pin each in BOTH directions with tests.
- **Data volumes are never created, deleted, or renamed by anything in this plan.** The override file declares the appliance's volumes `external: true`; the engine's `compose down` paths never pass `-v`; the appliance is stopped with `down` (no `-v`). The appliance's volume names, verbatim from `compose.personal-server.yml:329-333`: `charitypilot-personal-server-db` and `charitypilot-personal-server-documents`. (The spec's P3 section abbreviates these as `personal-server-db`/`-documents`; the real Docker names carry the `charitypilot-` prefix — Task 7 corrects the spec.)
- **Secrets never pass through chat, tool output, or the repo.** The VM env file is generated ON the VM from the appliance's own env file by a script the operator runs (Task 8 step 3). The committed template contains only `REPLACE_ME_*` placeholders. `AUTH_RECOVERY_SECRET`, `JWT_SECRET`, `READINESS_API_KEY`, `POSTGRES_PASSWORD` are copied verbatim from the appliance env — a different `AUTH_RECOVERY_SECRET` makes the API fail closed with `AUTH_RECOVERY_CONTROL_UNAVAILABLE` ("non-active root key").
- The engine runs on the VM as `cpops` (docker group member) — **not** under `sudo`, so `.bluegreen/state` stays `cpops`-owned. Repo on the VM: `/home/cpops/charity-governance`. Appliance state: `/home/cpops/.local/share/charitypilot/personal-server/` (env at `.env.personal-server`, recovery sets under `recovery/`).
- Scripts tests run under `npm run test:production-check` (`node --test` over the explicit file list in root `package.json:21`); a NEW `scripts/*.test.mjs` file must be appended to that list. API tests: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/<name>.test.js`.
- `docs/RELIABILITY.md` is GENERATED — rows go in `docs/reliability/guarantees.json` (a flat array; fields `id, group, concern, guarantee, status, testFile, testTitle, gapDescription, surface, testType, proposedTitle`), claims ≤ what the cited test proves; `npm run reliability:report -- --write` must exit 0 (export `DATABASE_URL` from `apps/api/.env` first). Only cite tests in files `scripts/reliability-report.mjs`'s `BLUEGREEN_SCRIPT_TESTS` actually runs (`scripts/bluegreen-deploy.test.mjs`, `scripts/bluegreen/migration-gate.test.mjs`, `scripts/bluegreen/backup.test.mjs`) or under `apps/api/src/tests/`.
- Env-file convention: `''` counts as unset (`fileEnv.X || default`), matching `BLUEGREEN_FRONT_PORT`'s handling at `scripts/bluegreen-deploy.mjs:432`.
- Never assert an error with a bare regex when a structured field exists; injected runners must record the arguments they were given.
- Work on a new branch `feat/private-vm-bluegreen-cutover` off `master`. Tasks 1–7 merge to master BEFORE Task 8 begins, because the engine's own preflight requires the VM's `HEAD == origin/master`.
- Two Windows traps from the private runbook apply to Task 8: `Start-Process -Verb RunAs` yields a 32-bit PowerShell where `ssh` is missing (use `C:\Windows\Sysnative\OpenSSH\ssh.exe` there, or a normal shell for ssh and an elevated one only for Hyper-V cmdlets); and always say "from Windows PowerShell" vs "on the VM".

---

### Task 1: Engine reads the database identity from the env file

The appliance's Postgres role and database are both `charitypilot_personal_server` (the installer's defaults, `.env.personal-server.example`), while the engine hardcodes `DEFAULT_DATABASE_NAME = 'charitypilot'` / `DEFAULT_DATABASE_USER = 'charitypilot'` for the migration gate's `psql`, the backup's `pg_dump` + row census, and the drill. On the VM every one of those would fail with `role "charitypilot" does not exist`.

**Files:**
- Modify: `scripts/bluegreen-deploy.mjs:108-109` (constants), `:495-540` (`fetchAppliedMigrationNames`), `:840-841`, `:1540-1541`, `:1585-1586` (the three `runBackupImpl`/`runRestoreDrillImpl` ctx literals), `:338-405` (`preflightIssues`)
- Test: `scripts/bluegreen-deploy.test.mjs`

**Interfaces:**
- Produces: `export function databaseIdentity(fileEnv) → { databaseName: string, databaseUser: string }` — `fileEnv.POSTGRES_DB || 'charitypilot'`, `fileEnv.POSTGRES_USER || 'charitypilot'`.
- Produces: two new `preflightIssues` messages (exact strings below) when `DATABASE_URL`'s database/user disagree with the resolved identity.
- `fetchAppliedMigrationNames(run, deployEnv, identity)` gains a third argument.

- [ ] **Step 1: Write the failing tests** (append to `scripts/bluegreen-deploy.test.mjs`, using the existing `makeFakeRunCommand`, `writeEnvFile`, `seedMigrationsDir`, `makeFixtureDir`, `loadDeployRunner`, `loadDeployModule` helpers)

```js
test('P3-1: databaseIdentity defaults to charitypilot/charitypilot and honours POSTGRES_DB/POSTGRES_USER ("" counts as unset)', async () => {
  const { databaseIdentity } = await loadDeployModule();
  assert.deepEqual(databaseIdentity({}), { databaseName: 'charitypilot', databaseUser: 'charitypilot' });
  assert.deepEqual(databaseIdentity({ POSTGRES_DB: '', POSTGRES_USER: '' }), {
    databaseName: 'charitypilot',
    databaseUser: 'charitypilot',
  });
  assert.deepEqual(
    databaseIdentity({ POSTGRES_DB: 'charitypilot_personal_server', POSTGRES_USER: 'charitypilot_personal_server' }),
    { databaseName: 'charitypilot_personal_server', databaseUser: 'charitypilot_personal_server' },
  );
});

test('P3-1: the gate psql, pg backup, and drill all use the env file database identity', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-db-identity-');
  const envPath = join(stateDir, 'vm.env');
  writeEnvFile(envPath, {
    POSTGRES_DB: 'charitypilot_personal_server',
    POSTGRES_USER: 'charitypilot_personal_server',
    DATABASE_URL: 'postgresql://charitypilot_personal_server:pw@db:5432/charitypilot_personal_server',
  });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { runCommand, calls } = makeFakeRunCommand();
  const backupCtxs = [];
  const deps = {
    runCommand,
    runBackupImpl: async (ctx) => {
      backupCtxs.push(ctx);
      return { backupDir: join(stateDir, 'backups', 'x') };
    },
    runRestoreDrillImpl: async () => ({}),
  };
  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], deps);
  assert.equal(outcome.status, 0, outcome.stderr);

  const psqlCalls = calls.filter((call) => call.command.includes('psql'));
  assert.ok(psqlCalls.length > 0, 'gate must query the database');
  for (const call of psqlCalls) {
    const u = call.command.indexOf('-U');
    const d = call.command.indexOf('-d');
    assert.equal(call.command[u + 1], 'charitypilot_personal_server');
    assert.equal(call.command[d + 1], 'charitypilot_personal_server');
  }
  assert.equal(backupCtxs.length, 1);
  assert.equal(backupCtxs[0].databaseName, 'charitypilot_personal_server');
  assert.equal(backupCtxs[0].databaseUser, 'charitypilot_personal_server');
  rmSync(stateDir, { recursive: true, force: true });
});

test('P3-1: with no POSTGRES_* vars the gate and backup still use charitypilot/charitypilot (default pinned)', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-db-identity-default-');
  const envPath = join(stateDir, 'local.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { runCommand, calls } = makeFakeRunCommand();
  const backupCtxs = [];
  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], {
    runCommand,
    runBackupImpl: async (ctx) => {
      backupCtxs.push(ctx);
      return { backupDir: join(stateDir, 'backups', 'x') };
    },
    runRestoreDrillImpl: async () => ({}),
  });
  assert.equal(outcome.status, 0, outcome.stderr);
  const psql = calls.find((call) => call.command.includes('psql'));
  assert.equal(psql.command[psql.command.indexOf('-U') + 1], 'charitypilot');
  assert.equal(psql.command[psql.command.indexOf('-d') + 1], 'charitypilot');
  assert.equal(backupCtxs[0].databaseName, 'charitypilot');
  assert.equal(backupCtxs[0].databaseUser, 'charitypilot');
  rmSync(stateDir, { recursive: true, force: true });
});

test('P3-1: preflightIssues rejects a DATABASE_URL whose database or user disagrees with the resolved identity', async () => {
  const { preflightIssues } = await loadDeployModule();
  const envFilePath = '/tmp/x.env';
  const base = {
    BLUEGREEN_ENV_FILE: envFilePath,
    BLUEGREEN_ORIGIN: 'http://127.0.0.1:8080',
    READINESS_API_KEY: READINESS_KEY,
    FRONTEND_URL: 'http://127.0.0.1:8080',
  };
  // Consistent, explicit identity: clean.
  assert.deepEqual(
    preflightIssues({
      fileEnv: {
        ...base,
        POSTGRES_DB: 'charitypilot_personal_server',
        POSTGRES_USER: 'charitypilot_personal_server',
        DATABASE_URL: 'postgresql://charitypilot_personal_server:pw@db:5432/charitypilot_personal_server',
      },
      resolvedEnvFilePath: envFilePath,
    }),
    [],
  );
  // Appliance-shaped URL with the POSTGRES_* vars forgotten: both mismatches named.
  const forgotten = preflightIssues({
    fileEnv: { ...base, DATABASE_URL: 'postgresql://charitypilot_personal_server:pw@db:5432/charitypilot_personal_server' },
    resolvedEnvFilePath: envFilePath,
  });
  assert.ok(
    forgotten.includes(
      'DATABASE_URL database "charitypilot_personal_server" does not match POSTGRES_DB (resolved "charitypilot"); set POSTGRES_DB in the env file to the database the volume actually holds',
    ),
    forgotten.join('\n'),
  );
  assert.ok(
    forgotten.includes(
      'DATABASE_URL user "charitypilot_personal_server" does not match POSTGRES_USER (resolved "charitypilot"); set POSTGRES_USER in the env file to the role the volume actually holds',
    ),
    forgotten.join('\n'),
  );
  // Default identity with the default URL (today's local fixture): clean — pins that no new issue appears for existing deployments.
  assert.deepEqual(
    preflightIssues({
      fileEnv: { ...base, DATABASE_URL: 'postgresql://charitypilot:scratch-password@db:5432/charitypilot' },
      resolvedEnvFilePath: envFilePath,
    }),
    [],
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/bluegreen-deploy.test.mjs --test-name-pattern="P3-1"`
Expected: FAIL — `databaseIdentity` is not exported; `-U` is `charitypilot` in the identity test; the two preflight strings are absent.

- [ ] **Step 3: Implement**

In `scripts/bluegreen-deploy.mjs`, directly after the two constants at :108-109:

```js
// P3: the appliance's volumes hold a role/database both named
// `charitypilot_personal_server`, not `charitypilot`. Every psql/pg_dump the
// engine issues must use the identity the volume actually holds, so it is
// read from the deployment env file (the same POSTGRES_DB/POSTGRES_USER the
// compose db service itself reads) with today's values as the default.
export function databaseIdentity(fileEnv) {
  return {
    databaseName: fileEnv.POSTGRES_DB || DEFAULT_DATABASE_NAME,
    databaseUser: fileEnv.POSTGRES_USER || DEFAULT_DATABASE_USER,
  };
}
```

In `preflightIssues`, after the existing `DATABASE_URL` hostname check (the `databaseHost !== 'db'` block):

```js
  // P3: the URL the app connects with and the identity the engine's own
  // psql/pg_dump use must name the same database and role — an appliance-
  // shaped URL with the POSTGRES_* vars forgotten would otherwise pass here
  // and fail at the migration gate with `role "charitypilot" does not exist`.
  const identity = databaseIdentity(fileEnv);
  try {
    const url = new URL(fileEnv.DATABASE_URL ?? '');
    const urlDatabase = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const urlUser = decodeURIComponent(url.username);
    if (urlDatabase && urlDatabase !== identity.databaseName) {
      issues.push(
        `DATABASE_URL database ${JSON.stringify(urlDatabase)} does not match POSTGRES_DB (resolved ${JSON.stringify(identity.databaseName)}); set POSTGRES_DB in the env file to the database the volume actually holds`,
      );
    }
    if (urlUser && urlUser !== identity.databaseUser) {
      issues.push(
        `DATABASE_URL user ${JSON.stringify(urlUser)} does not match POSTGRES_USER (resolved ${JSON.stringify(identity.databaseUser)}); set POSTGRES_USER in the env file to the role the volume actually holds`,
      );
    }
  } catch {
    // An unparseable DATABASE_URL is already reported by the hostname check above.
  }
```

Change `fetchAppliedMigrationNames(run, deployEnv)` to `fetchAppliedMigrationNames(run, deployEnv, identity)` and replace both `DEFAULT_DATABASE_USER` / `DEFAULT_DATABASE_NAME` inside it with `identity.databaseUser` / `identity.databaseName`. At the call site (:910) pass `databaseIdentity(fileEnv)`. In the three ctx literals (:840-841, :1540-1541, :1585-1586) replace `databaseName: DEFAULT_DATABASE_NAME, databaseUser: DEFAULT_DATABASE_USER,` with `...databaseIdentity(fileEnv),`.

- [ ] **Step 4: Run the whole engine suite**

Run: `node --test scripts/bluegreen-deploy.test.mjs`
Expected: all pass (45 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/bluegreen-deploy.mjs scripts/bluegreen-deploy.test.mjs
git commit -m "fix(deploy): read the database identity from the env file so the engine works on the appliance's volumes"
```

---

### Task 2: Engine accepts a Compose override file

`compose.bluegreen.yml`'s own header (lines 24-30) says P3 swaps the volumes in "via a separate Compose override file passed alongside this one on the `-f` flag chain — NEVER by editing this file", but the engine builds `['-f', COMPOSE_FILE, '-p', PROJECT_NAME]` in exactly two places (`composePrefix()` at :413 and `composeArgs` at :658) with no way to add a second `-f`.

**Files:**
- Modify: `scripts/bluegreen-deploy.mjs:100-101` (constants), `:413-417` (`composePrefix`), `:658` (`composeArgs`), `preflightIssues`, `runBluegreenDeployFromArgs` (right after `parseEnvFile`)
- Test: `scripts/bluegreen-deploy.test.mjs`

**Interfaces:**
- Consumes: env-file key `BLUEGREEN_COMPOSE_OVERRIDE` (path, resolved against the repo root like `--env-file`; `''` = unset).
- Produces: `export function composeFileArgs(fileEnv) → string[]` — `['-f', <abs compose.bluegreen.yml>]` plus `['-f', <abs override>]` when set. Every `docker compose` invocation the engine makes, and the `composeArgs` handed to `runBackup`/`runRestoreDrill`, carry it.
- Produces: preflight issues `BLUEGREEN_COMPOSE_OVERRIDE file not found: <abs path>` and `BLUEGREEN_DOCUMENTS_VOLUME is required when BLUEGREEN_COMPOSE_OVERRIDE is set (an override exists to move the volumes; the backup must tar the one the override names)`.

- [ ] **Step 1: Write the failing tests**

```js
test('P3-2: composeFileArgs is a single -f by default and appends the override as a second -f', async () => {
  const { composeFileArgs } = await loadDeployModule();
  const defaults = composeFileArgs({});
  assert.equal(defaults.length, 2);
  assert.equal(defaults[0], '-f');
  assert.match(defaults[1], /compose\.bluegreen\.yml$/);
  assert.deepEqual(composeFileArgs({ BLUEGREEN_COMPOSE_OVERRIDE: '' }), defaults, '"" counts as unset');
  const withOverride = composeFileArgs({ BLUEGREEN_COMPOSE_OVERRIDE: '/abs/private-vm.yml' });
  assert.deepEqual(withOverride, [...defaults, '-f', '/abs/private-vm.yml']);
});

test('P3-2: every docker compose call and the backup composeArgs carry the override -f when set', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-override-');
  const overridePath = join(stateDir, 'override.yml');
  writeFileSync(overridePath, 'volumes:\n  bluegreen-db:\n    external: true\n    name: x\n');
  const envPath = join(stateDir, 'vm.env');
  writeEnvFile(envPath, {
    BLUEGREEN_COMPOSE_OVERRIDE: overridePath,
    BLUEGREEN_DOCUMENTS_VOLUME: 'charitypilot-personal-server-documents',
  });
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { runCommand, calls } = makeFakeRunCommand();
  const backupCtxs = [];
  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], {
    runCommand,
    runBackupImpl: async (ctx) => {
      backupCtxs.push(ctx);
      return { backupDir: join(stateDir, 'backups', 'x') };
    },
    runRestoreDrillImpl: async () => ({}),
  });
  assert.equal(outcome.status, 0, outcome.stderr);
  const composeCalls = calls.filter((call) => call.command[0] === 'docker' && call.command[1] === 'compose');
  assert.ok(composeCalls.length > 0);
  for (const call of composeCalls) {
    const flags = call.command.filter((_, i) => call.command[i - 1] === '-f');
    assert.equal(flags.length, 2, `expected two -f flags in: ${call.command.join(' ')}`);
    assert.match(flags[0], /compose\.bluegreen\.yml$/);
    assert.equal(flags[1], overridePath);
    assert.ok(call.command.indexOf('-p') > call.command.lastIndexOf('-f'), '-p must follow every -f');
  }
  assert.deepEqual(backupCtxs[0].composeArgs.filter((_, i) => backupCtxs[0].composeArgs[i - 1] === '-f')[1], overridePath);
  rmSync(stateDir, { recursive: true, force: true });
});

test('P3-2: without an override every docker compose call has exactly one -f (default pinned)', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-no-override-');
  const envPath = join(stateDir, 'local.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { runCommand, calls } = makeFakeRunCommand();
  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], {
    runCommand,
    runBackupImpl: async () => ({ backupDir: join(stateDir, 'backups', 'x') }),
    runRestoreDrillImpl: async () => ({}),
  });
  assert.equal(outcome.status, 0, outcome.stderr);
  for (const call of calls.filter((c) => c.command[0] === 'docker' && c.command[1] === 'compose')) {
    assert.equal(call.command.filter((arg) => arg === '-f').length, 1, call.command.join(' '));
  }
  rmSync(stateDir, { recursive: true, force: true });
});

test('P3-2: preflightIssues names a missing override file and requires BLUEGREEN_DOCUMENTS_VOLUME alongside an override', async () => {
  const { preflightIssues } = await loadDeployModule();
  const envFilePath = '/tmp/x.env';
  const base = {
    BLUEGREEN_ENV_FILE: envFilePath,
    BLUEGREEN_ORIGIN: 'http://127.0.0.1:8080',
    READINESS_API_KEY: READINESS_KEY,
    FRONTEND_URL: 'http://127.0.0.1:8080',
    DATABASE_URL: 'postgresql://charitypilot:pw@db:5432/charitypilot',
  };
  const missing = preflightIssues({
    fileEnv: { ...base, BLUEGREEN_COMPOSE_OVERRIDE: '/definitely/not/here.yml', BLUEGREEN_DOCUMENTS_VOLUME: 'v' },
    resolvedEnvFilePath: envFilePath,
  });
  assert.ok(missing.includes('BLUEGREEN_COMPOSE_OVERRIDE file not found: /definitely/not/here.yml'), missing.join('\n'));

  const dir = makeFixtureDir('bluegreen-override-preflight-');
  const present = join(dir, 'o.yml');
  writeFileSync(present, 'volumes: {}\n');
  const noVolume = preflightIssues({
    fileEnv: { ...base, BLUEGREEN_COMPOSE_OVERRIDE: present },
    resolvedEnvFilePath: envFilePath,
  });
  assert.ok(
    noVolume.includes(
      'BLUEGREEN_DOCUMENTS_VOLUME is required when BLUEGREEN_COMPOSE_OVERRIDE is set (an override exists to move the volumes; the backup must tar the one the override names)',
    ),
    noVolume.join('\n'),
  );
  assert.deepEqual(
    preflightIssues({
      fileEnv: { ...base, BLUEGREEN_COMPOSE_OVERRIDE: present, BLUEGREEN_DOCUMENTS_VOLUME: 'v' },
      resolvedEnvFilePath: envFilePath,
    }),
    [],
  );
  assert.deepEqual(preflightIssues({ fileEnv: base, resolvedEnvFilePath: envFilePath }), [], 'no override: no new issues');
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/bluegreen-deploy.test.mjs --test-name-pattern="P3-2"`
Expected: FAIL — `composeFileArgs` not exported; compose calls have one `-f`; preflight strings absent.

- [ ] **Step 3: Implement**

Constants (after `PROJECT_NAME` at :101):

```js
// P3: the engine's compose invocation is `-f compose.bluegreen.yml [-f <override>] -p charitypilot-bluegreen`.
// The override (env-file key BLUEGREEN_COMPOSE_OVERRIDE, resolved against the repo root like --env-file)
// is how a deployment target points the volumes somewhere else — the private VM at the appliance's
// external volumes — without ever editing compose.bluegreen.yml (its header says exactly this).
let activeComposeFileArgs = ['-f', COMPOSE_FILE];

export function composeFileArgs(fileEnv) {
  const override = fileEnv.BLUEGREEN_COMPOSE_OVERRIDE || '';
  return override ? ['-f', COMPOSE_FILE, '-f', resolve(repoRoot, override)] : ['-f', COMPOSE_FILE];
}
```

`composePrefix`:

```js
function composePrefix({ projectDirectory } = {}) {
  const prefix = ['docker', 'compose', ...activeComposeFileArgs, '-p', PROJECT_NAME];
  if (projectDirectory) prefix.push('--project-directory', projectDirectory);
  return prefix;
}
```

In `runBluegreenDeployFromArgs`, immediately after the `fileEnv = parseEnvFile(...)` try/catch succeeds, and BEFORE the `composeArgs` line:

```js
  // Set once per run, from this run's env file — every composePrefix() call
  // below (32 of them) and the composeArgs handed to backup/drill agree.
  activeComposeFileArgs = composeFileArgs(fileEnv);
```

and change :658 to `const composeArgs = [...activeComposeFileArgs, '-p', PROJECT_NAME];`.

In `preflightIssues`, after the `BLUEGREEN_FRONT_PORT` check:

```js
  const overrideValue = fileEnv.BLUEGREEN_COMPOSE_OVERRIDE || '';
  if (overrideValue) {
    const overridePath = resolve(repoRoot, overrideValue);
    if (!existsSync(overridePath)) {
      issues.push(`BLUEGREEN_COMPOSE_OVERRIDE file not found: ${overridePath}`);
    }
    if (!(fileEnv.BLUEGREEN_DOCUMENTS_VOLUME || '')) {
      issues.push(
        'BLUEGREEN_DOCUMENTS_VOLUME is required when BLUEGREEN_COMPOSE_OVERRIDE is set (an override exists to move the volumes; the backup must tar the one the override names)',
      );
    }
  }
```

(`existsSync` is already imported from `node:fs` at :67 and `resolve` from `node:path` at :76 — no new imports.)

- [ ] **Step 4: Run the suite**

Run: `node --test scripts/bluegreen-deploy.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/bluegreen-deploy.mjs scripts/bluegreen-deploy.test.mjs
git commit -m "feat(deploy): accept a compose override file so a target can relocate the engine's volumes"
```

---

### Task 3: A deploy brings `db` up before it backs up or gates

Phase 2 runs `runBackup`, which is `docker compose exec -T db pg_dump …` (`scripts/bluegreen/backup.mjs:354-367`); phase 6's gate is `docker compose exec -T db psql …`. On a first deploy nothing has started `db`, so `exec` fails with "service db is not running". The P2 acceptance never hit this because it seeded data (and therefore started `db` by hand) before its first deploy. The VM cutover IS a first deploy on a stopped stack.

**Files:**
- Modify: `scripts/bluegreen-deploy.mjs` (between the git checks and the `// Phase 2: backup` comment, ~:830)
- Test: `scripts/bluegreen-deploy.test.mjs` (a new test, plus the phase-order test at :170 which pins the exact call sequence and must gain the new call)

**Interfaces:**
- Produces: one new status-history entry `ensure-db` ("starting db if not already running") written before phase 2's `backup` entry; one new compose call `up -d --wait db` before any `exec … db …`.

- [ ] **Step 1: Write the failing test**

```js
test('P3-3: a deploy brings db up (with --wait) before the backup runs and before any exec against db', async () => {
  const runDeploy = await loadDeployRunner();
  const stateDir = makeFixtureDir('bluegreen-ensure-db-');
  const envPath = join(stateDir, 'local.env');
  writeEnvFile(envPath);
  seedMigrationsDir(stateDir, TARGET_COMMIT, []);
  const { runCommand, calls } = makeFakeRunCommand();
  let callsAtBackup = -1;
  const outcome = await runDeploy(['deploy', '--env-file', envPath, '--state-dir', stateDir], {
    runCommand,
    runBackupImpl: async () => {
      callsAtBackup = calls.length;
      return { backupDir: join(stateDir, 'backups', 'x') };
    },
    runRestoreDrillImpl: async () => ({}),
  });
  assert.equal(outcome.status, 0, outcome.stderr);
  const dbUpIndex = calls.findIndex(
    (call) => call.command.includes('up') && call.command.includes('--wait') && call.command.at(-1) === 'db',
  );
  assert.notEqual(dbUpIndex, -1, 'db must be brought up explicitly');
  assert.ok(dbUpIndex < callsAtBackup, 'db up must precede the backup');
  const firstExecDb = calls.findIndex((call) => call.command.includes('exec') && call.command.includes('db'));
  assert.ok(firstExecDb === -1 || dbUpIndex < firstExecDb, 'db up must precede any exec against db');
  // writeDeployStatus (scripts/bluegreen/lib.mjs:112) writes { history: [{ timestamp, phase, detail }] }
  // to <stateDir>/deploy-status.json.
  const { history } = JSON.parse(readFileSync(join(stateDir, 'deploy-status.json'), 'utf8'));
  const phases = history.map((entry) => entry.phase);
  assert.ok(phases.includes('ensure-db'), phases.join(' → '));
  assert.ok(phases.indexOf('ensure-db') < phases.indexOf('backup'), phases.join(' → '));
  rmSync(stateDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/bluegreen-deploy.test.mjs --test-name-pattern="P3-3"`
Expected: FAIL — no `up --wait db` call recorded.

- [ ] **Step 3: Implement** — immediately before `// Phase 2: backup`:

```js
  // P3: a first deploy on a stopped stack (the VM cutover, or any host where
  // the stack was `down`) has no running db for phase 2's `exec db pg_dump`
  // or phase 6's `exec db psql` to reach. Idempotent when db is already up.
  writeDeployStatus(resolvedStateDir, 'ensure-db', 'starting db if not already running');
  try {
    await run([...composePrefix(), 'up', '-d', '--wait', 'db'], deployEnv);
  } catch (error) {
    return result(1, '', `Blue-green deploy failed: could not start the db service: ${redact(error)}\n`);
  }
```

Then update the phase-order test at :170 so its expected sequence includes the `up -d --wait db` call (and, if it asserts the status history, the `ensure-db` entry) between the git checks and the backup.

- [ ] **Step 4: Run the suite**

Run: `node --test scripts/bluegreen-deploy.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/bluegreen-deploy.mjs scripts/bluegreen-deploy.test.mjs
git commit -m "fix(deploy): start db before the pre-migration backup so a first deploy on a stopped stack works"
```

---

### Task 4: The private-VM Compose override

**Files:**
- Create: `compose.bluegreen.private-vm.yml`
- Create: `scripts/check-bluegreen-private-vm-compose.test.mjs`
- Modify: `package.json:21` (append the new test file to `test:production-check`)

**Interfaces:**
- Produces: volumes `bluegreen-db` → external `charitypilot-personal-server-db`, `bluegreen-documents` → external `charitypilot-personal-server-documents`; network `bluegreen-internal` pinned to subnet `172.31.250.0/24` (so `TRUSTED_PROXY_ADDRESSES=172.31.250.0/24` in the env file is exact; the appliance used `172.30.250.0/24` and `.251.0/24` — this must not collide while both networks exist during the cutover).
- Consumed by Task 5's template (`BLUEGREEN_COMPOSE_OVERRIDE=compose.bluegreen.private-vm.yml`) and Task 8.

- [ ] **Step 1: Write the failing test** — `scripts/check-bluegreen-private-vm-compose.test.mjs`:

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readFixture = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8').replace(/\r\n?/g, '\n');
const override = readFixture('compose.bluegreen.private-vm.yml');
const personalServerCompose = readFixture('compose.personal-server.yml');
const DOCKER_COMPOSE_CONFIG_TIMEOUT_MS = 120_000;

test('the override redefines only volumes and the network — never a service', () => {
  assert.doesNotMatch(override, /^services:/m);
  assert.match(override, /^volumes:\n  bluegreen-db:\n    external: true\n    name: charitypilot-personal-server-db\n/m);
  assert.match(
    override,
    /^  bluegreen-documents:\n    external: true\n    name: charitypilot-personal-server-documents\n/m,
  );
  assert.match(override, /^networks:\n  bluegreen-internal:\n    ipam:\n      config:\n        - subnet: 172\.31\.250\.0\/24\n/m);
});

test('the external volume names are byte-identical to the appliance compose file’s own volume names', () => {
  for (const name of ['charitypilot-personal-server-db', 'charitypilot-personal-server-documents']) {
    assert.match(personalServerCompose, new RegExp(`^    name: ${name}$`, 'm'), `${name} must be the appliance's volume`);
  }
});

test('the pinned subnet does not overlap the appliance networks (both exist during the cutover)', () => {
  const applianceSubnets = [...personalServerCompose.matchAll(/subnet: (\d+\.\d+\.\d+\.\d+\/\d+)/g)].map((m) => m[1]);
  assert.ok(applianceSubnets.length >= 1);
  assert.equal(applianceSubnets.includes('172.31.250.0/24'), false);
});

test('docker compose config with both files renders the external appliance volumes and drops the scratch names', () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'charitypilot-bluegreen-vm-compose-'));
  const envFile = join(scratchDir, 'bluegreen.env');
  writeFileSync(
    envFile,
    [
      'POSTGRES_DB=charitypilot_personal_server',
      'POSTGRES_USER=charitypilot_personal_server',
      'POSTGRES_PASSWORD=scratch-password',
      'DATABASE_URL=postgresql://charitypilot_personal_server:scratch-password@db:5432/charitypilot_personal_server',
      'JWT_SECRET=scratch-jwt-secret-at-least-32-characters-long',
      'AUTH_RECOVERY_SECRET=scratch-recovery-secret-at-least-32-characters',
      'READINESS_API_KEY=scratch-readiness-key',
      'FRONTEND_URL=https://vm.tailnet.example',
      '',
    ].join('\n'),
  );
  const env = {
    ...process.env,
    BLUEGREEN_ENV_FILE: envFile,
    BLUEGREEN_BLUE_TAG: 'scratch-blue-commit',
    BLUEGREEN_GREEN_TAG: 'scratch-green-commit',
    BLUEGREEN_ACTIVE_TAG: 'scratch-blue-commit',
    BLUEGREEN_ORIGIN: 'https://vm.tailnet.example',
    BLUEGREEN_FRONT_PORT: '8080',
  };
  const result = spawnSync(
    'docker',
    ['compose', '-f', 'compose.bluegreen.yml', '-f', 'compose.bluegreen.private-vm.yml', '-p', 'charitypilot-bluegreen', 'config'],
    { cwd: repoRoot, encoding: 'utf8', env, timeout: DOCKER_COMPOSE_CONFIG_TIMEOUT_MS },
  );
  if (result.error?.code === 'EPERM' || result.error?.code === 'ENOENT') return; // no docker here; shape pinned above
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'docker compose config failed');
  assert.match(result.stdout, /name: charitypilot-personal-server-db\n\s+external: true|external: true\n\s+name: charitypilot-personal-server-db/);
  assert.match(result.stdout, /charitypilot-personal-server-documents/);
  assert.doesNotMatch(result.stdout, /charitypilot-bluegreen-db\b/);
  assert.doesNotMatch(result.stdout, /charitypilot-bluegreen-documents\b/);
  assert.match(result.stdout, /subnet: 172\.31\.250\.0\/24/);
  // Every api/web/scheduler documents mount still resolves to the (now external) bluegreen-documents key.
  assert.match(result.stdout, /source: bluegreen-documents\n\s+target: \/data\/documents/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/check-bluegreen-private-vm-compose.test.mjs`
Expected: FAIL — `ENOENT` reading `compose.bluegreen.private-vm.yml`.

- [ ] **Step 3: Create the override**

```yaml
# =============================================================================
# compose.bluegreen.private-vm.yml — the PRIVATE HYPER-V VM's override for the
# blue-green engine. Always passed AFTER compose.bluegreen.yml:
#
#   docker compose -f compose.bluegreen.yml -f compose.bluegreen.private-vm.yml -p charitypilot-bluegreen ...
#
# (the engine does this itself when the env file sets
# BLUEGREEN_COMPOSE_OVERRIDE=compose.bluegreen.private-vm.yml).
#
# It changes WHERE the data lives and nothing else: the engine's two volume
# keys are re-pointed at the appliance install's existing external volumes, so
# cutting the VM over changes running processes, never data. `external: true`
# means compose will NEVER create, remove, or rename them — `down -v` on this
# project leaves them untouched. Postgres major/minor is byte-identical between
# compose.bluegreen.yml and compose.personal-server.yml (16.4-alpine, same
# digest), so the existing cluster directory starts unmodified.
#
# The internal network's subnet is pinned so TRUSTED_PROXY_ADDRESSES in the
# VM env file (172.31.250.0/24) is exact rather than a docker-wide guess. It
# deliberately differs from the appliance's 172.30.250.0/24 and 172.30.251.0/24
# because both networks exist on the host during the cutover.
#
# No `services:` key on purpose — the engine's topology is owned by
# compose.bluegreen.yml alone (scripts/check-bluegreen-private-vm-compose.test.mjs
# pins this).
# =============================================================================

volumes:
  bluegreen-db:
    external: true
    name: charitypilot-personal-server-db
  bluegreen-documents:
    external: true
    name: charitypilot-personal-server-documents

networks:
  bluegreen-internal:
    ipam:
      config:
        - subnet: 172.31.250.0/24
```

Append ` scripts/check-bluegreen-private-vm-compose.test.mjs` to the `test:production-check` file list in `package.json` (immediately after `scripts/check-bluegreen-compose.test.mjs`).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/check-bluegreen-private-vm-compose.test.mjs`
Expected: 4 pass (the `docker compose config` test actually runs on this machine — Docker is present).

- [ ] **Step 5: Commit**

```bash
git add compose.bluegreen.private-vm.yml scripts/check-bluegreen-private-vm-compose.test.mjs package.json
git commit -m "feat(deploy): compose override that runs the blue-green engine on the appliance's external volumes"
```

---

### Task 5: The private-VM env template, validated on both sides

The env file is generated on the VM (Task 8 step 3) from this template. Two tests prove the template's shape is accepted by (a) the engine's preflight and (b) the API's own production validator running the **multi-tenant** branch — closing the "API-side canonical-origin override is unit-tested only" gap with a test on exactly the VM's env shape.

**Files:**
- Create: `.env.bluegreen.private-vm.example`
- Create: `apps/api/src/tests/private-vm-env-profile.test.ts`
- Test: `scripts/bluegreen-deploy.test.mjs` (one new test)

**Interfaces:**
- Placeholders are exactly: `REPLACE_ME_TAILSCALE_HOSTNAME` (bare hostname, e.g. `charitypilot.tailXXXX.ts.net`), `REPLACE_ME_POSTGRES_DB`, `REPLACE_ME_POSTGRES_USER`, `REPLACE_ME_POSTGRES_PASSWORD`, `REPLACE_ME_JWT_SECRET`, `REPLACE_ME_AUTH_RECOVERY_SECRET`, `REPLACE_ME_READINESS_API_KEY`, `REPLACE_ME_OWNER_JWT_SECRET`, `REPLACE_ME_ENV_FILE_PATH`. Task 8's generator script substitutes exactly these.

- [ ] **Step 1: Write the failing API test** — `apps/api/src/tests/private-vm-env-profile.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { AppError } from '../utils/errors.js';
import { assertDeploymentProfile } from '../utils/deployment-profile.js';
import { validateDeadlineRemindersEnv, validateProductionEnv } from '../utils/env.js';

// dist/tests/<this>.js → apps/api/dist/tests → repo root is four levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const TEMPLATE = join(REPO_ROOT, '.env.bluegreen.private-vm.example');
const ORIGINAL_ENV = { ...process.env };

const FILL: Record<string, string> = {
  REPLACE_ME_TAILSCALE_HOSTNAME: 'charitypilot.tail0000.ts.net',
  REPLACE_ME_POSTGRES_DB: 'charitypilot_personal_server',
  REPLACE_ME_POSTGRES_USER: 'charitypilot_personal_server',
  REPLACE_ME_POSTGRES_PASSWORD: 'a'.repeat(64),
  REPLACE_ME_JWT_SECRET: 'j'.repeat(48),
  REPLACE_ME_AUTH_RECOVERY_SECRET: '0123456789abcdef'.repeat(4),
  REPLACE_ME_READINESS_API_KEY: 'r'.repeat(40),
  REPLACE_ME_OWNER_JWT_SECRET: 'o'.repeat(48),
  REPLACE_ME_ENV_FILE_PATH: '/home/cpops/charity-governance/.bluegreen/private-vm.env',
};

function templateEnv(): Record<string, string> {
  let text = readFileSync(TEMPLATE, 'utf8');
  for (const [key, value] of Object.entries(FILL)) text = text.split(key).join(value);
  assert.doesNotMatch(text, /REPLACE_ME_/, 'every placeholder in the template must be in FILL');
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    values[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return values;
}

function applyEnv(values: Record<string, string>) {
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  for (const key of ['CHARITYPILOT_DEPLOYMENT_MODE', 'ERROR_ALERT_WEBHOOK_URL', 'RESEND_API_KEY', 'SUPABASE_URL', 'STRIPE_SECRET_KEY']) {
    delete process.env[key];
  }
  Object.assign(process.env, values);
}

beforeEach(() => applyEnv(templateEnv()));
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

test('private VM template: the filled template passes the deployment profile, production, and job validators', () => {
  assert.doesNotThrow(() => assertDeploymentProfile());
  assert.doesNotThrow(() => validateProductionEnv());
  assert.doesNotThrow(() => validateDeadlineRemindersEnv());
});

test('private VM template: it runs the multi-tenant validator branch (dropping OWNER_JWT_SECRET is fatal)', () => {
  delete process.env.OWNER_JWT_SECRET;
  assert.throws(
    () => validateProductionEnv(),
    (error: unknown) => error instanceof AppError && /OWNER_JWT_SECRET/.test(error.message),
  );
});

test('private VM template: it is NOT the appliance branch (CHARITYPILOT_DEPLOYMENT_MODE is absent) and has no SaaS provider vars', () => {
  const values = templateEnv();
  assert.equal('CHARITYPILOT_DEPLOYMENT_MODE' in values, false);
  for (const forbidden of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'ERROR_ALERT_WEBHOOK_URL', 'PERSONAL_SERVER_OWNER_EMAIL']) {
    assert.equal(forbidden in values, false, `${forbidden} must not appear in the private VM template`);
  }
  assert.equal(values.CHARITYPILOT_TENANCY, 'multi');
  assert.equal(values.CHARITYPILOT_REGISTRATION, 'closed');
  assert.equal(values.CHARITYPILOT_EMAIL_DELIVERY, 'manual-link');
  assert.equal(values.CHARITYPILOT_BILLING, 'none');
  assert.equal(values.CHARITYPILOT_ERROR_ALERTS, 'none');
  assert.equal(values.DOCUMENT_STORAGE_DRIVER, 'local');
});

test('private VM template: the canonical-origin override is what makes the Tailscale origin acceptable (removing it is fatal)', () => {
  delete process.env.CHARITYPILOT_CANONICAL_WEB_ORIGIN;
  delete process.env.CHARITYPILOT_CANONICAL_API_ORIGIN;
  assert.throws(() => validateProductionEnv(), (error: unknown) => error instanceof AppError);
});
```

(Error classes, verified: `validateProductionEnv` and `validateDeadlineRemindersEnv` throw `AppError(500, code, message, issues)` via `throwIfProductionIssues` — `issues` is the structured list, so the `OWNER_JWT_SECRET` check may equally be written against `error.details`/the fourth constructor argument if `AppError` exposes it; `assertDeploymentProfile` throws a plain `Error` (`deployment-profile.ts:42,85,94`), which is why the first test only uses `assert.doesNotThrow` on it.)

- [ ] **Step 2: Write the failing engine-preflight test** (append to `scripts/bluegreen-deploy.test.mjs`):

```js
test('P3-5: the committed private-VM env template, filled in, passes engine preflight with zero issues', async () => {
  const { preflightIssues, parseEnvFile } = await loadDeployModule();
  const repoRoot = dirname(scriptsDir);
  let text = readFileSync(join(repoRoot, '.env.bluegreen.private-vm.example'), 'utf8');
  const dir = makeFixtureDir('bluegreen-vm-template-');
  const envPath = join(dir, 'private-vm.env');
  const fill = {
    REPLACE_ME_TAILSCALE_HOSTNAME: 'charitypilot.tail0000.ts.net',
    REPLACE_ME_POSTGRES_DB: 'charitypilot_personal_server',
    REPLACE_ME_POSTGRES_USER: 'charitypilot_personal_server',
    REPLACE_ME_POSTGRES_PASSWORD: 'a'.repeat(64),
    REPLACE_ME_JWT_SECRET: 'j'.repeat(48),
    REPLACE_ME_AUTH_RECOVERY_SECRET: '0123456789abcdef'.repeat(4),
    REPLACE_ME_READINESS_API_KEY: 'r'.repeat(40),
    REPLACE_ME_OWNER_JWT_SECRET: 'o'.repeat(48),
    REPLACE_ME_ENV_FILE_PATH: envPath,
  };
  for (const [key, value] of Object.entries(fill)) text = text.split(key).join(value);
  assert.doesNotMatch(text, /REPLACE_ME_/);
  writeFileSync(envPath, text);
  const fileEnv = parseEnvFile(envPath);
  assert.equal(fileEnv.BLUEGREEN_COMPOSE_OVERRIDE, 'compose.bluegreen.private-vm.yml');
  assert.equal(fileEnv.BLUEGREEN_DOCUMENTS_VOLUME, 'charitypilot-personal-server-documents');
  assert.deepEqual(preflightIssues({ fileEnv, resolvedEnvFilePath: envPath }), []);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run both to verify failure**

Run: `node --test scripts/bluegreen-deploy.test.mjs --test-name-pattern="P3-5"` → FAIL (`ENOENT` on the template).
Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/private-vm-env-profile.test.js` → FAIL (`ENOENT`).

- [ ] **Step 4: Create `.env.bluegreen.private-vm.example`**

```bash
# =============================================================================
# CharityPilot — private Hyper-V VM env file for the BLUE-GREEN engine.
#
# This is a TEMPLATE. The real file is generated ON the VM from the appliance's
# own env (~/.local/share/charitypilot/personal-server/.env.personal-server) by
# the cutover runbook's generator script, lands at
# ~/charity-governance/.bluegreen/private-vm.env (gitignored, mode 0600), and
# never leaves the VM. Every REPLACE_ME_* below is substituted by that script.
#
# Secrets marked "carry over" MUST equal the appliance's values: a different
# AUTH_RECOVERY_SECRET makes the API fail closed (AUTH_RECOVERY_CONTROL_UNAVAILABLE,
# "non-active root key"); a different POSTGRES_PASSWORD cannot log in to the
# existing cluster; a different JWT_SECRET only logs everyone out.
#
# Deployment profile: MULTI-TENANT, fully self-contained (no Supabase, Resend,
# Stripe, or alert webhook). CHARITYPILOT_DEPLOYMENT_MODE is deliberately ABSENT
# — this is not the appliance branch. Validated on both sides by
# apps/api/src/tests/private-vm-env-profile.test.ts and the P3-5 test in
# scripts/bluegreen-deploy.test.mjs.
# =============================================================================

# ---- engine orchestration (read by scripts/bluegreen-deploy.mjs) -------------
NODE_ENV=production
BLUEGREEN_ENV_FILE=REPLACE_ME_ENV_FILE_PATH
BLUEGREEN_ORIGIN=https://REPLACE_ME_TAILSCALE_HOSTNAME
BLUEGREEN_FRONT_PORT=8080
BLUEGREEN_COMPOSE_OVERRIDE=compose.bluegreen.private-vm.yml
BLUEGREEN_DOCUMENTS_VOLUME=charitypilot-personal-server-documents

# ---- database (carry over — the appliance cluster's own identity) -----------
POSTGRES_DB=REPLACE_ME_POSTGRES_DB
POSTGRES_USER=REPLACE_ME_POSTGRES_USER
POSTGRES_PASSWORD=REPLACE_ME_POSTGRES_PASSWORD
DATABASE_URL=postgresql://REPLACE_ME_POSTGRES_USER:REPLACE_ME_POSTGRES_PASSWORD@db:5432/REPLACE_ME_POSTGRES_DB

# ---- auth secrets (carry over) ----------------------------------------------
JWT_SECRET=REPLACE_ME_JWT_SECRET
AUTH_RECOVERY_SECRET=REPLACE_ME_AUTH_RECOVERY_SECRET
READINESS_API_KEY=REPLACE_ME_READINESS_API_KEY
JWT_EXPIRY=15m
REFRESH_TOKEN_TTL_DAYS=7

# ---- platform-owner console (NEW on this host; distinct from JWT_SECRET) ----
OWNER_JWT_SECRET=REPLACE_ME_OWNER_JWT_SECRET
OWNER_CONSOLE_ORIGIN=https://REPLACE_ME_TAILSCALE_HOSTNAME

# ---- origins: one hostname serves web and API through Tailscale Serve -------
FRONTEND_URL=https://REPLACE_ME_TAILSCALE_HOSTNAME
NEXT_PUBLIC_API_URL=https://REPLACE_ME_TAILSCALE_HOSTNAME
CHARITYPILOT_CANONICAL_WEB_ORIGIN=https://REPLACE_ME_TAILSCALE_HOSTNAME
CHARITYPILOT_CANONICAL_API_ORIGIN=https://REPLACE_ME_TAILSCALE_HOSTNAME
# Exact hostname — never the shared .ts.net parent (docs/bluegreen-runbook.md, Preconditions).
AUTH_COOKIE_DOMAIN=REPLACE_ME_TAILSCALE_HOSTNAME
# The override compose file pins the internal network to this subnet; Caddy is the only proxy.
TRUSTED_PROXY_ADDRESSES=172.31.250.0/24

# ---- capability axes (P1) ---------------------------------------------------
CHARITYPILOT_TENANCY=multi
CHARITYPILOT_REGISTRATION=closed
CHARITYPILOT_EMAIL_DELIVERY=manual-link
CHARITYPILOT_BILLING=none
CHARITYPILOT_ERROR_ALERTS=none

# ---- documents: the appliance's local driver and path, unchanged ------------
DOCUMENT_STORAGE_DRIVER=local
LOCAL_FILE_STORAGE_DIR=/data/documents
```

- [ ] **Step 5: Run both suites to verify they pass**

Run: `node --test scripts/bluegreen-deploy.test.mjs` → all pass.
Run: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/private-vm-env-profile.test.js` → 4 pass. If `validateProductionEnv` reports an issue, the template is wrong, not the validator — fix the template (the validator is the contract) and note what it demanded in the commit message.

- [ ] **Step 6: Run the full API suite** so the hosted-fixture tests still pass unmodified: `cd apps/api && npm test`.

- [ ] **Step 7: Commit**

```bash
git add .env.bluegreen.private-vm.example apps/api/src/tests/private-vm-env-profile.test.ts scripts/bluegreen-deploy.test.mjs
git commit -m "feat(deploy): private-VM env template, validated by engine preflight and the API's multi-tenant production validator"
```

---

### Task 6: Nightly backup wrapper that replaces the appliance cron

Mirrors `D:\CharityPilot-VM\provision\charitypilot-backup.sh` (log file, free-space warning, idempotent `--install-cron`) but invokes `bluegreen:backup` and, on install, removes the appliance's cron line — the spec's step 7 "the nightly cron switches to the engine's backup and the appliance cron gets disabled" in one idempotent command.

**Files:**
- Create: `scripts/bluegreen-nightly-backup.sh`
- Create: `scripts/bluegreen-nightly-backup.test.mjs`
- Modify: `package.json:21` (append the test file)

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, 'scripts', 'bluegreen-nightly-backup.sh');
const script = readFileSync(scriptPath, 'utf8');

test('nightly wrapper: strict mode, LF line endings, and it calls the engine backup subcommand with the VM env file', () => {
  assert.doesNotMatch(script, /\r/, 'must be LF-only (runs under Linux cron)');
  assert.match(script, /^set -euo pipefail$/m);
  assert.match(script, /npm run --silent bluegreen:backup -- --env-file "\$ENV_FILE"/);
  assert.match(script, /ENV_FILE="\$REPO_DIR\/\.bluegreen\/private-vm\.env"/);
  assert.match(script, /REPO_DIR="\$HOME\/charity-governance"/);
});

test('nightly wrapper: --install-cron replaces BOTH the appliance entry and any previous copy of itself', () => {
  assert.match(script, /grep -v 'charitypilot-backup\.sh'/);
  assert.match(script, /grep -v 'bluegreen-nightly-backup\.sh'/);
  assert.match(script, /^ {6}echo "30 3 \* \* \* \$HOME\/bin\/bluegreen-nightly-backup\.sh >\/dev\/null 2>&1" \) \| crontab -$/m);
});

test('nightly wrapper: parses under bash -n when bash is available', () => {
  const result = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test scripts/bluegreen-nightly-backup.test.mjs` → FAIL (`ENOENT`).

- [ ] **Step 3: Create the script** (LF line endings — add `scripts/bluegreen-nightly-backup.sh text eol=lf` to `.gitattributes`, the same fix `b22ba4c` applied for the caddy files):

```bash
#!/usr/bin/env bash
# =============================================================================
# CharityPilot private VM — nightly backup via the blue-green engine.
#
# Runs `bluegreen:backup` (row census + pg_dump -Fc + documents tar + sha256
# manifest under .bluegreen/state/backups/<stamp>, 14-day retention pruned by
# the engine itself) and logs the outcome. Replaces the appliance-era
# ~/bin/charitypilot-backup.sh — `--install-cron` removes that entry.
#
# Install/replace the cron entry:  bash scripts/bluegreen-nightly-backup.sh --install-cron
# Run one backup now:              bash ~/bin/bluegreen-nightly-backup.sh
#
# Backups are ON the VM. Copy them off-host (see docs/bluegreen-runbook.md,
# "Cutting the private VM over") — a dead VM takes its backups with it.
# =============================================================================
set -euo pipefail

REPO_DIR="$HOME/charity-governance"
ENV_FILE="$REPO_DIR/.bluegreen/private-vm.env"
STATE_DIR="$REPO_DIR/.bluegreen/state"
LOG="$HOME/charitypilot-bluegreen-backup.log"
MIN_FREE_GIB=10

# cron runs with a minimal PATH; node/npm live in /usr/bin via NodeSource.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }

if [ "${1:-}" = "--install-cron" ]; then
    mkdir -p "$HOME/bin"
    install -m 700 "$0" "$HOME/bin/bluegreen-nightly-backup.sh"
    # Idempotent, and retires the appliance's entry in the same edit.
    ( crontab -l 2>/dev/null | grep -v 'charitypilot-backup.sh' | grep -v 'bluegreen-nightly-backup.sh' || true
      echo "30 3 * * * $HOME/bin/bluegreen-nightly-backup.sh >/dev/null 2>&1" ) | crontab -
    echo "Installed: $HOME/bin/bluegreen-nightly-backup.sh"
    echo "Cron now:"
    crontab -l
    exit 0
fi

log '--- backup run starting ---'

if [ ! -f "$ENV_FILE" ]; then
    log "FAIL: env file missing at $ENV_FILE"
    exit 1
fi

mkdir -p "$STATE_DIR"
free_gib=$(df -BG --output=avail "$STATE_DIR" | tail -1 | tr -dc '0-9')
if [ "$free_gib" -lt "$MIN_FREE_GIB" ]; then
    log "WARN: only ${free_gib} GiB free on the state volume (threshold ${MIN_FREE_GIB} GiB)"
fi

cd "$REPO_DIR"
if npm run --silent bluegreen:backup -- --env-file "$ENV_FILE" >> "$LOG" 2>&1; then
    newest=$(ls -1dt "$STATE_DIR"/backups/*/ 2>/dev/null | head -1 || true)
    count=$(ls -1d "$STATE_DIR"/backups/*/ 2>/dev/null | wc -l || echo 0)
    log "OK: backup written and manifested. newest=${newest:-none} total_sets=${count} free=${free_gib}GiB"
else
    log 'FAIL: bluegreen:backup returned non-zero -- see output above'
    exit 1
fi
```

Append ` scripts/bluegreen-nightly-backup.test.mjs` to `test:production-check` in `package.json`.

- [ ] **Step 4: Run to verify it passes** — `node --test scripts/bluegreen-nightly-backup.test.mjs` → 3 pass (the `bash -n` test runs here via Git Bash).

- [ ] **Step 5: Commit**

```bash
git add scripts/bluegreen-nightly-backup.sh scripts/bluegreen-nightly-backup.test.mjs .gitattributes package.json
git commit -m "feat(deploy): nightly blue-green backup wrapper that retires the appliance cron on install"
```

---

### Task 7: Documentation, spec correction, and reliability ledger

**Files:**
- Modify: `docs/bluegreen-runbook.md` (Scope note ~:18-27; Preconditions; "The nightly cron (not yet wired)" ~:300-308; new section)
- Modify: `docs/hyperv-private-server-deployment.md` ("Deploying a new commit" :205-302, "Scheduled backups" :189-204)
- Modify: `docs/superpowers/specs/2026-08-31-deployment-profile-and-bluegreen-design.md` (P3 Mechanism paragraph :301-306)
- Modify: `docs/reliability/guarantees.json`; regenerate `docs/RELIABILITY.md`
- Modify: `.env.example` (one comment line pointing at the new template, next to the existing canonical-origin comments)

- [ ] **Step 1: Runbook — replace the scope note.** Replace the paragraph beginning "**Scope note, stated plainly:** this engine has never been run against a real production VM" with:

```markdown
**Scope note, stated plainly:** everything here is proven against
`docker compose` and a scratch Postgres locally (`scripts/bluegreen-deploy.test.mjs`,
`scripts/bluegreen/*.test.mjs`) and by a local acceptance cycle. The private
Hyper-V VM's cutover from the appliance to this engine is the operational
project in `docs/superpowers/plans/2026-09-02-private-vm-bluegreen-cutover.md`
(Task 8); its "Cutting the private VM over" section below is the operator
sequence, and its evidence is recorded in that plan's task report once run.
Until that report exists, this engine has not run against a real VM.
```

- [ ] **Step 2: Runbook — Preconditions additions.** Add three bullets after the `BLUEGREEN_DOCUMENTS_VOLUME` bullet:

```markdown
- **`BLUEGREEN_COMPOSE_OVERRIDE`** (optional; path resolved against the repo
  root) adds a second `-f` to every compose invocation the engine makes —
  the only sanctioned way to relocate the engine's volumes. The private VM
  sets `compose.bluegreen.private-vm.yml`, which re-points `bluegreen-db` /
  `bluegreen-documents` at the appliance install's external volumes and pins
  the internal subnet. When set, `BLUEGREEN_DOCUMENTS_VOLUME` is required
  (preflight refuses otherwise — the backup must tar the volume the override
  actually names).
- **`POSTGRES_DB` / `POSTGRES_USER`** name the database and role the engine's
  own `psql`/`pg_dump` use (default `charitypilot`/`charitypilot`). Set them
  whenever the volume holds a different identity — the appliance's is
  `charitypilot_personal_server` for both — and keep `DATABASE_URL`
  consistent; preflight rejects a mismatch by name.
- **First deploy on a stopped stack:** the engine now starts `db` itself
  (`up -d --wait db`, status entry `ensure-db`) before the pre-migration
  backup and the migration gate. Nothing to do by hand.
```

- [ ] **Step 3: Runbook — replace "The nightly cron (not yet wired)"** with:

```markdown
## The nightly cron (private VM)

`scripts/bluegreen-nightly-backup.sh --install-cron` installs itself to
`~/bin/`, writes the `30 3 * * *` crontab entry, and removes the appliance-era
`charitypilot-backup.sh` entry in the same edit (idempotent). It runs
`bluegreen:backup` against `~/charity-governance/.bluegreen/private-vm.env`
and logs to `~/charitypilot-bluegreen-backup.log`. Backups stay on the VM
under `.bluegreen/state/backups/` (14-day retention, pruned by the engine);
copy the newest set off-host after any deploy and at least weekly:

```powershell
# from Windows PowerShell
$KEY = "D:\CharityPilot-VM\secrets\charitypilot-server_ed25519"
$NEWEST = ssh -i $KEY cpops@charitypilot.local "ls -1dt ~/charity-governance/.bluegreen/state/backups/*/ | head -1"
scp -i $KEY -r "cpops@charitypilot.local:$NEWEST" D:\CharityPilot-VM\backups\bluegreen\
```
```

- [ ] **Step 4: Runbook — add the cutover section** before "The nightly cron (private VM)": a section titled `## Cutting the private VM over from the appliance` whose body is Task 8's steps 0–9 verbatim (copy them once Task 8 is final; do not paraphrase — this runbook IS the operator's copy). Prefix it with one paragraph: "Executed once, on <date>, evidence in the plan's task report. Kept here because it is also the recovery sequence if the VM must ever be re-provisioned through the appliance installer and then brought back onto the engine."

- [ ] **Step 5: Public Hyper-V doc.** In `docs/hyperv-private-server-deployment.md`, replace the body of "## Deploying a new commit" (keep the three historical subsections "Why improvising a deploy breaks restore", "If it has already happened", "Recovery sets cannot carry data across a commit change" under a new `### History: the appliance era` heading, since they explain the state of any host still on the appliance) with:

```markdown
## Deploying a new commit

Since the blue-green cutover this host deploys like any other Docker host:

```bash
# on the VM, as cpops (never sudo)
cd ~/charity-governance && git pull --ff-only
npm run bluegreen:deploy -- --env-file .bluegreen/private-vm.env --detach
npm run bluegreen:status -- --env-file .bluegreen/private-vm.env
```

`docs/bluegreen-runbook.md` is the reference: phases, failure modes, one-command
`bluegreen:rollback`, and the destructive-migration override's cost. There is
no VM teardown and no installer step. The appliance installer remains this
host's worst-case rebuild path only (provision fresh → run the cutover
sequence in the blue-green runbook against a restored backup).
```

Replace "## Scheduled backups" body with a pointer to the runbook's "The nightly cron (private VM)" section and the off-host copy command.

- [ ] **Step 6: Spec correction.** In the P3 Mechanism paragraph, change `(`personal-server-db`, `personal-server-documents`)` to `(`charitypilot-personal-server-db`, `charitypilot-personal-server-documents` — the Docker names, compose.personal-server.yml:329-333)` and append: "The override is `compose.bluegreen.private-vm.yml`, selected by `BLUEGREEN_COMPOSE_OVERRIDE` in the VM env file; the engine's psql/pg_dump identity follows `POSTGRES_DB`/`POSTGRES_USER` (`charitypilot_personal_server`)."

- [ ] **Step 7: `.env.example`** — next to the `CHARITYPILOT_CANONICAL_*` comment lines add: `# Private Hyper-V VM (blue-green, multi-tenant, self-contained): see .env.bluegreen.private-vm.example`.

- [ ] **Step 8: Ledger rows.** Append to `docs/reliability/guarantees.json` (ids continue the `bluegreen-*` sequences; `surface: "api"`, `testType: "unit"`, `status: "covered"`, `gapDescription: ""`, `proposedTitle: ""`):

| id | concern | guarantee | testFile | testTitle |
|---|---|---|---|---|
| `bluegreen-state-integrity-6` | state-integrity | The engine's migration-gate psql and its backup/drill use the database identity declared by the env file's POSTGRES_DB/POSTGRES_USER, defaulting to charitypilot/charitypilot when unset. | `scripts/bluegreen-deploy.test.mjs` | `P3-1: the gate psql, pg backup, and drill all use the env file database identity` |
| `bluegreen-state-integrity-7` | state-integrity | Preflight refuses a DATABASE_URL whose database or user differs from the resolved POSTGRES_DB/POSTGRES_USER identity, naming both. | `scripts/bluegreen-deploy.test.mjs` | `P3-1: preflightIssues rejects a DATABASE_URL whose database or user disagrees with the resolved identity` |
| `bluegreen-state-integrity-8` | state-integrity | When BLUEGREEN_COMPOSE_OVERRIDE is set, every docker compose invocation the engine makes and the composeArgs handed to backup carry it as a second -f after compose.bluegreen.yml. | `scripts/bluegreen-deploy.test.mjs` | `P3-2: every docker compose call and the backup composeArgs carry the override -f when set` |
| `bluegreen-graceful-degradation-3` | graceful-degradation | A deploy brings the db service up (up -d --wait db) before the pre-migration backup and before any exec against db, so a first deploy on a stopped stack does not fail at phase 2. | `scripts/bluegreen-deploy.test.mjs` | `P3-3: a deploy brings db up (with --wait) before the backup runs and before any exec against db` |
| `bluegreen-state-integrity-9` | state-integrity | The committed private-VM env template, with placeholders filled, passes engine preflight with zero issues. | `scripts/bluegreen-deploy.test.mjs` | `P3-5: the committed private-VM env template, filled in, passes engine preflight with zero issues` |
| `deployment-profile-private-vm-1` (group `deployment-profile`) | env-validation | The filled private-VM env template passes assertDeploymentProfile, validateProductionEnv, and validateDeadlineRemindersEnv. | `apps/api/src/tests/private-vm-env-profile.test.ts` | `private VM template: the filled template passes the deployment profile, production, and job validators` |
| `deployment-profile-private-vm-2` (group `deployment-profile`) | env-validation | The private-VM template exercises the multi-tenant validator branch: removing OWNER_JWT_SECRET is fatal. | `apps/api/src/tests/private-vm-env-profile.test.ts` | `private VM template: it runs the multi-tenant validator branch (dropping OWNER_JWT_SECRET is fatal)` |

Before writing, check an existing `deployment-profile` row for its `concern` vocabulary and reuse it (if the group uses e.g. `env-validation` already, keep that; otherwise use the concern the nearest row uses).

- [ ] **Step 9: Regenerate and verify.**

```bash
export DATABASE_URL="$(grep -E '^DATABASE_URL=' apps/api/.env | cut -d= -f2-)"
npm run reliability:report -- --write
```
Expected: exit 0, no broken links; `git diff --stat docs/RELIABILITY.md` shows only additions.

- [ ] **Step 10: Run the whole scripts gate** — `npm run test:production-check` → 0 failures.

- [ ] **Step 11: Commit**

```bash
git add docs/bluegreen-runbook.md docs/hyperv-private-server-deployment.md docs/superpowers/specs/2026-08-31-deployment-profile-and-bluegreen-design.md docs/reliability/guarantees.json docs/RELIABILITY.md .env.example
git commit -m "docs(deploy): private-VM cutover runbook, engine preconditions, spec volume names, ledger rows"
```

- [ ] **Step 12: Merge to master and push** (Task 8's preflight requires the VM's `HEAD == origin/master`):

```bash
git checkout master && git merge --no-ff feat/private-vm-bluegreen-cutover -m "merge: private VM cutover artifacts (P3 tasks 1-7)" && git push origin master
```

---

### Task 8: The cutover (operational, gated, evidence-recorded)

This task is executed by the operator with the agent driving over SSH, **from Windows PowerShell** unless a step says "on the VM". Each step has a gate; do not pass a gate on a guess. Record every gate's output in `docs/superpowers/plans/2026-09-02-private-vm-bluegreen-cutover-report.md` as you go (that file is the P3 acceptance evidence the spec calls for). Budget ~2 hours; downtime begins at step 4 and ends at step 5 (~15 minutes, dominated by the image builds).

Three things the agent cannot do and must hand to the operator as a single copy-pasteable command: write the credential file on the VM (step 3), anything that deletes a data volume (nothing here does — refuse if one appears), and the elevated Hyper-V cmdlets (step 2, 9).

**Files:**
- Create: `docs/superpowers/plans/2026-09-02-private-vm-bluegreen-cutover-report.md` (evidence)
- Modify (off-repo): `D:\CharityPilot-VM\provision\RUNBOOK.md` §1 table and §3
- Modify (off-repo): the agent memory file `charitypilot-deploy-procedure.md`

Variables used below:

```powershell
$KEY = "D:\CharityPilot-VM\secrets\charitypilot-server_ed25519"
$VM  = "cpops@charitypilot.local"          # mDNS; never a bare IP (leases change)
$SSH = "ssh -i $KEY $VM"
```

- [ ] **Step 0: Pre-checks (read-only; no downtime).** Run each and paste outputs into the report.

```powershell
ssh -i $KEY $VM "cd ~/charity-governance && git rev-parse HEAD && git remote -v | head -1 && git status --porcelain=v1 --untracked-files=all | wc -l"
```
Gate: HEAD is the appliance commit (`8bd3f78…`), remote is `https://github.com/jasperfordesq-ai/charity-governance.git`, porcelain count `0`.

```powershell
ssh -i $KEY $VM "node --version; docker --version; docker compose version; which wget git; df -BG --output=avail / | tail -1; free -g | head -2"
```
Gate: node is `v22.x` or newer (root `package.json` `engines.node` is `>=22.0.0`); `wget` and `git` found; ≥ 20 GiB free (two colours of images plus a worktree).

```powershell
ssh -i $KEY $VM "sudo tailscale serve status"
```
Gate: exactly one `https://charitypilot.<tailnet>.ts.net (tailnet only)` → `http://127.0.0.1:8080`. **Serve is not touched by this cutover** — the engine's Caddy binds the same `127.0.0.1:8080` once the appliance's Caddy is down.

```powershell
ssh -i $KEY $VM "docker volume ls --format '{{.Name}}' | grep personal-server"
```
Gate: `charitypilot-personal-server-db` and `charitypilot-personal-server-documents` both listed.

```powershell
ssh -i $KEY $VM "docker compose --project-name charitypilot-personal-server --env-file ~/.local/share/charitypilot/personal-server/.env.personal-server -f ~/charity-governance/compose.personal-server.yml exec -T db psql -U \"\$(grep -E '^POSTGRES_USER=' ~/.local/share/charitypilot/personal-server/.env.personal-server | cut -d= -f2- | tr -d '\"')\" -d \"\$(grep -E '^POSTGRES_DB=' ~/.local/share/charitypilot/personal-server/.env.personal-server | cut -d= -f2- | tr -d '\"')\" -tAc 'select count(*) from \"Organisation\"; select count(*) from \"User\"; select count(*) from \"Document\"; select count(*) from _prisma_migrations;'"
```
Gate: four non-zero counts printed; write them down — `_prisma_migrations` should rise by exactly 5 after step 4 (the migrations between `8bd3f78` and master, none destructive: `20260830180000_add_invite_link_reissued_audit`, `20260830201131_add_platform_operator`, `20260831000000/000100/000200_add_owner_provisioned_recovery_*`).

```powershell
ssh -i $KEY $VM "KEY=\$(grep -E '^READINESS_API_KEY=' ~/.local/share/charitypilot/personal-server/.env.personal-server | cut -d= -f2- | tr -d '\"'); ORIGIN=\$(grep -E '^CHARITYPILOT_PERSONAL_SERVER_ORIGIN=' ~/.local/share/charitypilot/personal-server/.env.personal-server | cut -d= -f2- | tr -d '\"'); wget -qO- --header \"x-charitypilot-readiness-key: \$KEY\" \$ORIGIN/api/v1/health/readiness"
```
Gate: JSON with `"status":"ready"`. This proves the VM can reach its own Tailscale origin over HTTPS from the host — exactly what the engine's phase-12 public smoke does.

- [ ] **Step 1: Final appliance backup, plaintext fingerprints, copy off-VM.**

```powershell
ssh -i $KEY $VM "bash ~/bin/charitypilot-backup.sh && tail -2 ~/charitypilot-backup.log"
```
Gate: log line starts `OK: backup verified.`

Plaintext fingerprints (the appliance's recovery set is encrypted; these are what step 6 diffs against):
```powershell
ssh -i $KEY $VM "mkdir -p ~/precutover && docker run --rm -v charitypilot-personal-server-documents:/d:ro alpine:3.20 sh -c 'cd /d && find . -type f -print0 | sort -z | xargs -0 sha256sum' > ~/precutover/documents.sha256 && wc -l ~/precutover/documents.sha256"
```
```powershell
ssh -i $KEY $VM "ENVF=~/.local/share/charitypilot/personal-server/.env.personal-server; U=\$(grep -E '^POSTGRES_USER=' \$ENVF | cut -d= -f2- | tr -d '\"'); D=\$(grep -E '^POSTGRES_DB=' \$ENVF | cut -d= -f2- | tr -d '\"'); docker compose --project-name charitypilot-personal-server --env-file \$ENVF -f ~/charity-governance/compose.personal-server.yml exec -T db psql -U \$U -d \$D -tAc \"SELECT c.relname || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname;\" > ~/precutover/census.txt && wc -l ~/precutover/census.txt"
```
Gate: `documents.sha256` line count equals the `Document` count from step 0 (or explain the difference — versions/attachments); `census.txt` has one line per table.

Copy off-VM:
```powershell
$NEWEST = ssh -i $KEY $VM "ls -1dt ~/.local/share/charitypilot/personal-server/recovery/*/ | head -1"
New-Item -ItemType Directory -Force D:\CharityPilot-VM\backups\pre-bluegreen | Out-Null
scp -i $KEY -r "${VM}:$NEWEST" D:\CharityPilot-VM\backups\pre-bluegreen\
scp -i $KEY -r "${VM}:~/precutover" D:\CharityPilot-VM\backups\pre-bluegreen\
```
Gate: `Get-ChildItem -Recurse D:\CharityPilot-VM\backups\pre-bluegreen | Measure-Object -Sum Length` shows a non-trivial size and both `documents.sha256` and `census.txt` present.

- [ ] **Step 2: Hyper-V checkpoint (operator, ELEVATED PowerShell — Hyper-V cmdlets only; do not run ssh from this shell).**

```powershell
$SHA = "<paste the origin/master short sha from Task 7 step 12>"
Stop-VM -Name charitypilot-server                      # clean guest shutdown (~1 min)
Checkpoint-VM -Name charitypilot-server -SnapshotName "pre-bluegreen-$SHA"
Start-VM -Name charitypilot-server
Get-VMSnapshot -VMName charitypilot-server | Select-Object Name, CreationTime
```
Gate: the snapshot is listed. Wait for the guest to come back: from a NORMAL shell, `ssh -i $KEY $VM "uptime && docker ps --format '{{.Names}}' | sort"` shows the appliance containers running again. **This checkpoint is the whole-cutover rollback: `Restore-VMSnapshot -Name "pre-bluegreen-$SHA" -VMName charitypilot-server -Confirm:$false` returns the appliance, its cron, its state — everything — as of this moment.**

- [ ] **Step 3: Generate the engine env file ON the VM (operator runs; secrets never leave the VM).** Hand the operator this single command to paste into an interactive `ssh -i $KEY $VM` session:

```bash
set -euo pipefail
cd ~/charity-governance && git fetch origin master
SRC=$HOME/.local/share/charitypilot/personal-server/.env.personal-server
DST=$HOME/charity-governance/.bluegreen/private-vm.env
TEMPLATE=$(git show origin/master:.env.bluegreen.private-vm.example)
get() { grep -E "^$1=" "$SRC" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
ORIGIN=$(get CHARITYPILOT_PERSONAL_SERVER_ORIGIN); HOST=${ORIGIN#https://}
[ -n "$HOST" ] && [ "$HOST" != "$ORIGIN" ] || { echo "appliance origin is not https: $ORIGIN"; exit 1; }
mkdir -p "$(dirname "$DST")"; umask 077
printf '%s\n' "$TEMPLATE" \
  | sed -e "s#REPLACE_ME_ENV_FILE_PATH#$DST#g" \
        -e "s#REPLACE_ME_TAILSCALE_HOSTNAME#$HOST#g" \
        -e "s#REPLACE_ME_POSTGRES_DB#$(get POSTGRES_DB)#g" \
        -e "s#REPLACE_ME_POSTGRES_USER#$(get POSTGRES_USER)#g" \
        -e "s#REPLACE_ME_POSTGRES_PASSWORD#$(get POSTGRES_PASSWORD)#g" \
        -e "s#REPLACE_ME_JWT_SECRET#$(get JWT_SECRET)#g" \
        -e "s#REPLACE_ME_AUTH_RECOVERY_SECRET#$(get AUTH_RECOVERY_SECRET)#g" \
        -e "s#REPLACE_ME_READINESS_API_KEY#$(get READINESS_API_KEY)#g" \
        -e "s#REPLACE_ME_OWNER_JWT_SECRET#$(openssl rand -hex 32)#g" \
  > "$DST"
chmod 600 "$DST"
grep -c REPLACE_ME "$DST" || echo "OK: no placeholders left"
grep -E '^(BLUEGREEN_ORIGIN|FRONTEND_URL|AUTH_COOKIE_DOMAIN|POSTGRES_DB|POSTGRES_USER|BLUEGREEN_COMPOSE_OVERRIDE|BLUEGREEN_DOCUMENTS_VOLUME)=' "$DST"
```
Gate: prints `OK: no placeholders left` and the seven non-secret lines show the Tailscale hostname, `charitypilot_personal_server` ×2, the override filename, and the documents volume name. (The appliance's `POSTGRES_PASSWORD` is 64 hex chars, so no URL-encoding is needed in `DATABASE_URL`; if `get POSTGRES_PASSWORD | grep -q '[^0-9a-f]'` prints anything, stop and percent-encode it by hand.)

- [ ] **Step 4: Stop the appliance, move the checkout, run the first deploy (DOWNTIME STARTS).** Order matters: the appliance is stopped with the compose file at ITS commit, then the checkout moves.

```powershell
ssh -i $KEY $VM "cd ~/charity-governance && docker compose --project-name charitypilot-personal-server --env-file ~/.local/share/charitypilot/personal-server/.env.personal-server -f compose.personal-server.yml down && docker ps --format '{{.Names}}' | wc -l && docker volume ls --format '{{.Name}}' | grep -c personal-server"
```
Gate: `0` containers, `2` volumes. (No `-v`. Ever.)

```powershell
ssh -i $KEY $VM "cd ~/charity-governance && git reset --hard origin/master && git rev-parse HEAD && git status --porcelain=v1 --untracked-files=all | wc -l"
```
Gate: HEAD equals the pushed master sha from Task 7; porcelain `0` (`.bluegreen/` is gitignored, so the env file does not dirty the tree).

Engine preflight dry-check (pure, no docker):
```powershell
ssh -i $KEY $VM "cd ~/charity-governance && node -e \"import('./scripts/bluegreen-deploy.mjs').then(m=>{const p=process.env.HOME+'/charity-governance/.bluegreen/private-vm.env';const f=m.parseEnvFile(p);const i=m.preflightIssues({fileEnv:f,resolvedEnvFilePath:p});console.log(i.length?i:'preflight clean');process.exit(i.length?1:0)})\""
```
Gate: `preflight clean`.

The deploy:
```powershell
ssh -i $KEY $VM "cd ~/charity-governance && npm run bluegreen:deploy -- --env-file .bluegreen/private-vm.env --detach"
```
It prints the log path. Tail it until it ends:
```powershell
ssh -i $KEY $VM "tail -f ~/charity-governance/.bluegreen/state/deploy-*.log"
```
Gate: the log ends with the success record (phase 15 `record`), and
```powershell
ssh -i $KEY $VM "cd ~/charity-governance && npm run bluegreen:status -- --env-file .bluegreen/private-vm.env"
```
shows `activeColor: blue` at the master commit, `docker compose ps -a` with `db`, `caddy`, `api-blue`, `web-blue`, `scheduler` up, and a status history `preflight → ensure-db → backup → resolve → worktree → build → gate → quiesce → migrate → up → candidate-smoke → switch → public-smoke → jobs → retire → record`. If the deploy fails at any phase, read the runbook's "What each failure mode looks like" — nothing before `switch` has touched traffic, and the step-2 checkpoint covers everything.

- [ ] **Step 5: Bootstrap the platform operator (DOWNTIME ENDS at the start of this step — the site is already serving).**

```powershell
ssh -i $KEY $VM "cd ~/charity-governance && TAG=\$(git rev-parse HEAD) && set -a && . .bluegreen/private-vm.env && set +a && BLUEGREEN_BLUE_TAG=\$TAG BLUEGREEN_GREEN_TAG=unbuilt BLUEGREEN_ACTIVE_TAG=\$TAG docker compose -f compose.bluegreen.yml -f compose.bluegreen.private-vm.yml -p charitypilot-bluegreen --profile blue run --rm --no-deps api-blue node dist/jobs/create-platform-operator.js --email=jasper@hour-timebank.ie --name='Jasper Ford'"
```
Gate: `Created platform operator <id> (jasper@hour-timebank.ie).` and a set-password link of the form `https://<tailscale-host>/owner/set-password#token=…` (fragment, not query). The operator opens it on a tailnet device and sets the owner-console password. Record the operator id (never the token) in the report.

- [ ] **Step 6: Verify (all gates must pass before step 7).**

1. Existing charity signs in at `https://<tailscale-host>/login` with the existing owner account; dashboard, documents list, minute book, and registers render. Gate: pass.
2. Documents byte-identical:
   ```powershell
   ssh -i $KEY $VM "docker run --rm -v charitypilot-personal-server-documents:/d:ro alpine:3.20 sh -c 'cd /d && find . -type f -print0 | sort -z | xargs -0 sha256sum' | diff - ~/precutover/documents.sha256 && echo DOCUMENTS IDENTICAL"
   ```
   Gate: `DOCUMENTS IDENTICAL`.
3. Row census: same query as step 1 against the new stack (`docker compose -f compose.bluegreen.yml -f compose.bluegreen.private-vm.yml -p charitypilot-bluegreen exec -T db psql -U charitypilot_personal_server -d charitypilot_personal_server -tAc "<census SQL>" | diff - ~/precutover/census.txt`). Gate: the ONLY differences are `_prisma_migrations` (+5), new tables that did not exist before (`PlatformOperator`… and the owner-provisioning tables, each at 0 or 1), `PlatformOperator=1`, and session/audit tables touched by the logins. Any other table differing is a stop.
4. Owner console: `https://<tailscale-host>/owner/login` → the tenants list shows the existing organisation as tenant #1, `ACTIVE`. Gate: pass.
5. Provision one comped test tenant from the console (`/owner/tenants` → create), copy the printed manual set-password link, open it in a private window, set a password, sign in as the new tenant, confirm it sees an empty workspace and NOT the existing charity's documents. Gate: pass; record the test tenant's organisation id.
6. Scheduler alive: `ssh … "cd ~/charity-governance && docker compose -f compose.bluegreen.yml -f compose.bluegreen.private-vm.yml -p charitypilot-bluegreen ps scheduler && docker compose -f compose.bluegreen.yml -f compose.bluegreen.private-vm.yml -p charitypilot-bluegreen logs --tail 20 scheduler"`. Gate: `Up`, no crash loop, log shows a tick.
7. Public readiness through Tailscale from the VM host: the step-0 wget command with the origin from the env file. Gate: `"status":"ready"` and `buildCommit` equal to HEAD.

- [ ] **Step 7: Safety-net acceptance: backup, restore drill, cron switch.**

```powershell
ssh -i $KEY $VM "cd ~/charity-governance && npm run bluegreen:backup -- --env-file .bluegreen/private-vm.env && ls -1dt .bluegreen/state/backups/*/ | head -1"
```
Gate: a new backup directory with `database.dump`, `documents.tar`, `manifest.json`.

```powershell
ssh -i $KEY $VM "cd ~/charity-governance && npm run bluegreen:restore-drill -- --env-file .bluegreen/private-vm.env"
```
Gate: the drill reports the census matched (non-degenerate — the counts from step 6.3, not `{}`) and every manifested file re-hashed clean; `docker ps -a | grep charitypilot-bluegreen-drill-` prints nothing afterwards. The app has been idle since step 6, so `BLUEGREEN_DRILL_CENSUS_TOLERANCE` stays unset (exact).

Switch the nightly cron:
```powershell
ssh -i $KEY $VM "cd ~/charity-governance && bash scripts/bluegreen-nightly-backup.sh --install-cron"
```
Gate: `crontab -l` output contains exactly one `30 3 * * *` line, pointing at `bluegreen-nightly-backup.sh`, and no `charitypilot-backup.sh` line. Then copy the step-7 backup off-VM with the runbook's scp command. Gate: present under `D:\CharityPilot-VM\backups\bluegreen\`.

- [ ] **Step 8: One real deploy, one real rollback, one re-deploy.** From Windows, make a trivial commit on master (e.g. append a dated line to the acceptance markers at the end of `docs/bluegreen-runbook.md`) and `git push origin master`. Then:

```powershell
ssh -i $KEY $VM "cd ~/charity-governance && git pull --ff-only && npm run bluegreen:deploy -- --env-file .bluegreen/private-vm.env"
```
Gate: exit 0; `bluegreen:status` shows `activeColor: green` at the new commit, `previousColor: blue`; readiness `buildCommit` equals the new commit; sign-in still works.

```powershell
ssh -i $KEY $VM "cd ~/charity-governance && npm run bluegreen:rollback -- --env-file .bluegreen/private-vm.env"
```
Gate: exit 0; status shows `activeColor: blue` at the old commit; readiness `buildCommit` equals the old commit. This is the first rollback ever run on the real host — record its full output.

```powershell
ssh -i $KEY $VM "cd ~/charity-governance && npm run bluegreen:deploy -- --env-file .bluegreen/private-vm.env"
```
Gate: exit 0; green serving the new commit again. Total elapsed for the deploy: record it (expected a few minutes — images for the new commit are already built).

- [ ] **Step 9: Retire the appliance on this host (only after 6–8 all passed).**

Archive, never delete, the appliance state (the old recovery key lives there):
```powershell
ssh -i $KEY $VM "mv ~/.local/share/charitypilot/personal-server ~/charitypilot-appliance-archive-$(Get-Date -Format yyyyMMdd) && ls ~/ | grep appliance-archive"
```
Copy `~/charitypilot-appliance-archive-*/recovery-key.hex` off-VM to `D:\CharityPilot-VM\secrets\` under a dated name if it is not already there (it should be — check first; do not overwrite).

Delete the checkpoint (operator, ELEVATED PowerShell):
```powershell
Remove-VMSnapshot -VMName charitypilot-server -Name "pre-bluegreen-$SHA" -Confirm:$false
Get-VMSnapshot -VMName charitypilot-server
```
Gate: no snapshots listed (a lingering checkpoint grows a differencing disk forever).

Update `D:\CharityPilot-VM\provision\RUNBOOK.md`: §1 row "Installed commit" → "Blue-green engine; active colour/commit via `npm run bluegreen:status -- --env-file .bluegreen/private-vm.env`"; row "Nightly backup" → "`~/bin/bluegreen-nightly-backup.sh`, sets under `~/charity-governance/.bluegreen/state/backups/`"; §3 → a new lead paragraph "**Deploy = `git pull --ff-only && npm run bluegreen:deploy -- --env-file .bluegreen/private-vm.env`. See `docs/bluegreen-runbook.md`.**" with Options A–D retitled "History — appliance era (retired <date>)".

Update the agent memory `charitypilot-deploy-procedure.md`: replace "The deploy decision, in one place" with the blue-green command; keep the access/traps sections; mark Option D as history; note the appliance archive path and that `bluegreen:rollback` and `restore-drill` were proven on the host on <date>.

Finish the report file with: timestamps per step, every gate's output, the operator id and test-tenant id, the two commits deployed in step 8, and the deploy/rollback wall-clock times. Commit the report and the runbook marker:
```bash
git add docs/superpowers/plans/2026-09-02-private-vm-bluegreen-cutover-report.md docs/bluegreen-runbook.md
git commit -m "docs(deploy): private VM cutover to blue-green — executed <date>, evidence report"
git push origin master
```

---

## Self-review against the spec

- **Mechanism** (external volumes, same Postgres major, env axes, drop SaaS vars) → Tasks 4, 5. Volume names corrected in Task 7 step 6.
- **Named prerequisite** (canonical-origin overrides + `ERROR_ALERTS=none`) → Task 5 template + API-side test proving the multi-tenant branch accepts it.
- **Sequence 1–9** → Task 8 steps 1–9 one-to-one (step 3 of the spec — "fetch/reset; write env; compose down" — is split into Task 8 steps 3 and 4 so the appliance is stopped with its own compose file before the checkout moves).
- **Step 7 cron switch + appliance cron disabled** → Task 6 (`--install-cron` does both) + Task 8 step 7.
- **What the appliance becomes / Rollback during cutover** → Task 8 steps 2 and 9; documented in Task 7.
- **P3 acceptance is operational, recorded as a runbook checklist** → the report file + runbook section (Task 7 step 4).
- **Accepted risks** unchanged; one newly surfaced and mitigated here: a first deploy on a stopped stack (Task 3).
- Not in the spec but load-bearing and now covered: the database identity mismatch (Task 1) and the missing override plumbing (Task 2). Both would have failed the cutover at phase 2/6 with nothing lost — but the plan should not depend on failing safely.

Type/name consistency checked: `databaseIdentity`, `composeFileArgs`, `activeComposeFileArgs`, `BLUEGREEN_COMPOSE_OVERRIDE`, `BLUEGREEN_DOCUMENTS_VOLUME`, `ensure-db`, the nine `REPLACE_ME_*` placeholders, `compose.bluegreen.private-vm.yml`, `.bluegreen/private-vm.env`, `scripts/bluegreen-nightly-backup.sh` — each spelled identically everywhere it appears above.
