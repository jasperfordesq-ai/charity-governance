# Blue-Green Deploy Engine (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-downtime blue-green deploy engine for CharityPilot — colour-scoped api/web behind a Caddy upstream switch, an expand/contract Postgres migration gate, and backup/restore-drill as first-class subcommands — proven by a full local cycle on scratch volumes before it ever touches the VM.

**Architecture:** `scripts/bluegreen-deploy.mjs` orchestrates phases over `compose.bluegreen.yml` (colour profiles `blue`/`green`; singletons db/caddy/scheduler/jobs), reusing the repo's cutover lock and transcript redaction. Pure logic (colour resolution, upstream rendering, migration lint, manifest verify) lives in `scripts/bluegreen/` modules with their own tests; the orchestrator is tested with an injected command runner, the pattern `scripts/production-compose-deploy.test.mjs` already uses. Two P1-named prerequisites are paid down first: configurable canonical origins + optional error-alert webhook in env validation, and the operator bootstrap link moving to the fragment form.

**Tech Stack:** Node 22 `.mjs` scripts + `node:test`; Docker Compose profiles; Caddy 2 (`caddy validate` / graceful reload); `pg_dump -Fc` via the pinned postgres image; Prisma migration directory diffed against `_prisma_migrations`.

**Spec:** `docs/superpowers/specs/2026-08-31-deployment-profile-and-bluegreen-design.md` (P2 section, plus its "Named prerequisite" note before P3's sequence and the P1 ledger ruling on `owner:create`'s `?token=` link).

## Global Constraints

- Scripts tests run under the root `npm run test:production-check` (`node --test` over `scripts/*.test.mjs`); every new script gets a sibling `.test.mjs` following `scripts/production-compose-deploy.test.mjs`'s injected-runner harness. API tests: `cd apps/api && npx tsc -p tsconfig.json && node --test dist/tests/<name>.test.js`.
- **The hosted SaaS profile must be unchanged with zero new env vars set** — every relaxation in this plan defaults to today's exact behaviour (canonical `https://app.charitypilot.ie` / `https://api.charitypilot.ie` pins, webhook required). Pin this with both-direction tests, the P1 discipline.
- Reuse, do not duplicate: `acquireProductionCutoverLock`/`assertProductionCutoverLock`/`releaseProductionCutoverLock` from `scripts/production-cutover-lock.mjs`; `redactProductionDeployTranscript` from `scripts/production-deploy-preflight.mjs`; the pinned postgres image digest from `scripts/postgres-backup.mjs`.
- All secrets/DSNs printed by the engine pass through the redactor. The secret scanner blocks `re_`-prefixed literals outside test files.
- Tokens in operator-facing links ride the URL FRAGMENT, never the query string (P1 convention; fragments do not reach access logs).
- `docs/RELIABILITY.md` is GENERATED — rows go in `docs/reliability/guarantees.json`, claims ≤ what the cited test proves, `npm run reliability:report -- --write` must exit 0 (export `DATABASE_URL` from `apps/api/.env` first).
- Never assert an error code/message with a bare regex when a structured field exists; stubs and injected runners must honour the arguments they are given (record them; don't hardcode responses irrespective of input).
- The migration gate's rules are pinned in BOTH directions by tests, and the design note travels with the code: *a gate whose only exit is the override teaches everyone to reach for the override* — narrow rules or proof-carrying exemptions, never silent widening.
- Engine state lives in `BLUEGREEN_STATE_DIR` (default `<repo>/.bluegreen/`, gitignored). Compose project name fixed via `-p charitypilot-bluegreen` so it cannot collide with the appliance stack.
- Work on a new branch `feat/bluegreen-engine` off `master`.

---

### Task 1: Deployment-origin and alert-webhook relaxation (P1's named prerequisite)

**Files:**
- Modify: `apps/api/src/utils/env.ts` (`CANONICAL_*` consts at :11-12, `requireUrl`'s `canonicalOriginRole` branch at :73-81, the three `ERROR_ALERT_WEBHOOK_URL` requirement lines at :506, :530, :554 — confirm each is inside which validator and record it)
- Create: `apps/api/src/tests/deployment-origins-env.test.ts`
- Modify: `.env.example`, `.env.production.example` (commented entries)

**Interfaces:**
- Produces env vars later tasks and P3 depend on:
  - `CHARITYPILOT_CANONICAL_WEB_ORIGIN` (default `https://app.charitypilot.ie`)
  - `CHARITYPILOT_CANONICAL_API_ORIGIN` (default `https://api.charitypilot.ie`)
  - `CHARITYPILOT_ERROR_ALERTS` = `webhook` (default) | `none`

- [ ] **Step 1: Write the failing test**

`apps/api/src/tests/deployment-origins-env.test.ts`, mirroring the harness `deployment-profile-env-validation.test.ts` uses (same fixture/reset discipline):

```ts
test('defaults unchanged: canonical charitypilot.ie origins still required with no new vars', () => {
  // hosted fixture with FRONTEND_URL=https://example.org => issue naming https://app.charitypilot.ie
});
test('configured canonical origins are honoured', () => {
  // CHARITYPILOT_CANONICAL_WEB_ORIGIN=https://charitypilot.tail1234.ts.net
  // FRONTEND_URL matching it => no origin issue; mismatching => issue naming the CONFIGURED origin
});
test('a non-https canonical origin override is itself rejected', () => {
  // CHARITYPILOT_CANONICAL_WEB_ORIGIN=http://x => issue naming the variable
});
test('alerts default: webhook still required', () => { /* unset var, missing webhook => issue */ });
test('alerts none: webhook not required and, if present, still validated', () => {});
test('alerts axis invalid value fails at boot via assertDeploymentProfile-style naming', () => {
  // CHARITYPILOT_ERROR_ALERTS=slack => issue naming CHARITYPILOT_ERROR_ALERTS
});
```

Every conditional in both directions, per the P1 discipline. Note `ERROR_ALERT_WEBHOOK_URL` appears in the job validators too (:506 cleanup, :530 reminders) — the `none` opt-out must cover all of them identically or the scheduler containers fail validation while the API boots; test at least one job validator's both directions.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

In `env.ts`:

```ts
const DEFAULT_CANONICAL_WEB_ORIGIN = 'https://app.charitypilot.ie';
const DEFAULT_CANONICAL_API_ORIGIN = 'https://api.charitypilot.ie';

function canonicalOrigin(role, issues) {
  const name = role === 'web' ? 'CHARITYPILOT_CANONICAL_WEB_ORIGIN' : 'CHARITYPILOT_CANONICAL_API_ORIGIN';
  const fallback = role === 'web' ? DEFAULT_CANONICAL_WEB_ORIGIN : DEFAULT_CANONICAL_API_ORIGIN;
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.origin !== raw) {
      issues.push(`${name} must be an exact https origin (no path, no trailing slash)`);
      return fallback;
    }
    return url.origin;
  } catch {
    issues.push(`${name} must be a valid https origin`);
    return fallback;
  }
}

function errorAlertsMode(issues) {
  const raw = process.env.CHARITYPILOT_ERROR_ALERTS;
  if (raw === undefined || raw === '') return 'webhook';
  if (raw !== 'webhook' && raw !== 'none') {
    issues.push(`CHARITYPILOT_ERROR_ALERTS must be webhook | none (got ${JSON.stringify(raw)})`);
    return 'webhook';
  }
  return raw;
}
```

`requireUrl`'s `canonicalOriginRole` branch compares against `canonicalOrigin(role, issues)` instead of the consts. Each `requireUrl('ERROR_ALERT_WEBHOOK_URL', …)` call becomes conditional: skip the REQUIREMENT when `errorAlertsMode(issues) === 'none'`, but if the var IS set under `none`, still validate its shape. The runtime alert service already degrades when the webhook is unconfigured (`shouldSendErrorAlert` → false, `error-alerts.service.ts:61-66`) — no service change; say so in a comment. Empty-string-= -unset matches the P1 fix-wave convention.

- [ ] **Step 4: Green, then the full API suite (`npm test` from apps/api) — the hosted-fixture env tests must pass unmodified.**

- [ ] **Step 5: Env examples** — add the three vars, commented, with one line each; the canonical-origin comment states they exist for non-charitypilot.ie deployments (the private VM) and default to the hosted origins.

- [ ] **Step 6: Commit** — `feat(deploy): configurable canonical origins and optional error alerts`

---

### Task 2: Operator bootstrap link moves to the fragment (P1 ledger ruling)

**Files:**
- Modify: `apps/api/src/jobs/create-platform-operator.ts:144`
- Modify: `apps/api/src/tests/create-platform-operator.test.ts` (link-shape assertions)
- Modify: `docs/owner-console-runbook.md` (the printed-link example)

**Interfaces:** none new; the set-password page already reads fragment tokens via `useSensitiveQueryToken` (verified in P1: `apps/web/src/lib/url-security.ts` reads `url.hash` first).

- [ ] **Step 1: Failing test** — assert the printed link is `${origin}/owner/set-password#token=…` and contains no `?token=`:

```ts
test('the bootstrap link carries its token in the fragment, never the query string', async () => {
  // reuse the existing CLI-output capture harness in this file;
  // assert /#token=/ matches and /\?token=/ does not
});
```

Check what the existing link-shape test asserts and update it in the same commit (re-point, don't weaken: the origin-validation assertions stay).

- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** — build with `new URL('/owner/set-password', origin)` + `url.hash = new URLSearchParams({ token: resetToken }).toString()`, matching `manualAuthLinkUrl`'s pattern; print `url.toString()`.
- [ ] **Step 4: GREEN + full API suite.** Update the runbook's example link text.
- [ ] **Step 5: Commit** — `fix(owner): bootstrap set-password link rides the URL fragment`

---

### Task 3: Build-commit provenance (what candidate smoke asserts against)

**Files:**
- Modify: `apps/api/Dockerfile` (ARG/ENV `CHARITYPILOT_BUILD_COMMIT`, following the file's existing ARG style)
- Modify: `apps/web/Dockerfile` (same)
- Modify: `apps/api/src/routes/health/index.ts` (readiness payload gains `buildCommit`)
- Create: `apps/api/src/tests/health-build-commit.test.ts`

**Interfaces:**
- Produces: readiness JSON gains `buildCommit: string | null` (from `process.env.CHARITYPILOT_BUILD_COMMIT ?? null`). Task 7's candidate smoke consumes it.

- [ ] **Step 1: Failing test** — build the health app the way `health-readiness.test.ts` does; with `CHARITYPILOT_BUILD_COMMIT=abc1234` the readiness body carries `buildCommit: 'abc1234'`; with it unset, `buildCommit: null` (and readiness itself unaffected).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** — one field in the readiness payload; ARG+ENV pair in both Dockerfiles with NO default (absent arg ⇒ null; the P1 empty-string convention makes `''` equivalent to unset — state that in a comment referencing the readiness read: `process.env.CHARITYPILOT_BUILD_COMMIT || null`).
- [ ] **Step 4: GREEN + full API suite.**
- [ ] **Step 5: Commit** — `feat(deploy): expose the built commit through readiness`

---

### Task 4: The blue-green compose file and Caddy front door

**Files:**
- Create: `compose.bluegreen.yml`
- Create: `caddy/Caddyfile.bluegreen`
- Create: `caddy/active-upstreams.example.caddy`
- Create: `scripts/check-bluegreen-compose.test.mjs` (structural, the `scripts/check-personal-server-compose.test.mjs` pattern — read it first and mirror its harness)
- Modify: `.gitignore` (`.bluegreen/`, `caddy/active-upstreams.caddy`)

**Interfaces:**
- Produces the service/profile names every later task uses verbatim:
  - profiles `blue` / `green`; services `api-blue`, `web-blue`, `api-green`, `web-green`
  - singletons (no profile): `db`, `caddy`, `scheduler`, `deadline-reminders`, `document-storage-cleanup`, `auth-recovery-secret-rotation`, and one-shot `migrate`
  - volumes `bluegreen-db`, `bluegreen-documents` (plain named volumes — P3 swaps in the appliance volumes via an override file, NOT by editing this one; leave that comment in the file)
  - Caddy listens on `:8080` inside the network, published `127.0.0.1:${BLUEGREEN_FRONT_PORT:-8080}:8080`; `import /etc/caddy/active-upstreams.caddy`

Shape rules (structural test enforces each):
- api/web services `build:` from repo context with the existing Dockerfiles (the compose.personal-server.yml pattern), `image:` tag `charitypilot-bluegreen-<svc>:${BLUEGREEN_<COLOR>_TAG:?...}`, build arg `CHARITYPILOT_BUILD_COMMIT: ${BLUEGREEN_<COLOR>_TAG:?...}`
- NO host ports on api/web (Caddy proxies by DNS name); healthchecks present on api and web
- api services set `ENABLE_IN_PROCESS_JOBS: "false"`; scheduler/jobs mirror `compose.production.yml`'s job services but with the local build image
- env via `env_file: ${BLUEGREEN_ENV_FILE:?...}` so the engine injects the deployment's env file
- `active-upstreams.example.caddy` content:

```
# Generated by scripts/bluegreen-deploy.mjs — do not edit by hand.
# The engine writes the live colour's upstreams and gracefully reloads Caddy.
reverse_proxy /api/* api-blue:3002
reverse_proxy web-blue:3003
```

- `Caddyfile.bluegreen`: `{ admin off auto_https off persist_config off }` + `:8080 { encode zstd gzip import /etc/caddy/active-upstreams.caddy }` — the `Caddyfile.personal-server` shape; caddy service mounts `caddy/Caddyfile.bluegreen` and the generated `active-upstreams.caddy` read-only, and the pinned `caddy:2-alpine` digest from `compose.personal-server.yml`.

- [ ] **Step 1: Write the structural test first** (each shape rule above = one assertion, parsing the YAML with the same loader the personal-server compose test uses). RED because the file doesn't exist.
- [ ] **Step 2: Write the compose + caddy files until GREEN.**
- [ ] **Step 3: `docker compose -f compose.bluegreen.yml -p charitypilot-bluegreen config` exits 0** with a scratch env file (write one under `.bluegreen/` in the test's temp dir; the test may shell out gated on docker availability the way existing docker-dependent script tests do — mirror their skip convention).
- [ ] **Step 4: Commit** — `feat(deploy): blue-green compose topology and caddy front door`

---

### Task 5: Engine library — colours, state, upstream rendering

**Files:**
- Create: `scripts/bluegreen/lib.mjs`
- Create: `scripts/bluegreen/lib.test.mjs`

**Interfaces (later tasks import these exactly):**

```js
export const COLORS = ['blue', 'green'];
export function otherColor(color)                     // 'blue' <-> 'green', throws on anything else
export function readState(stateDir)                  // -> { activeColor, commit, deployedAt } | null (missing/corrupt file -> null, corrupt also returns .corrupt flag)
export function writeState(stateDir, state)          // atomic: tmp file + rename
export function renderUpstreams(color)               // -> the exact two-line caddy import body for that colour
export function releaseDirFor(stateDir, commit)      // -> `${stateDir}/releases/${commit}`
export function prunePlan(releases, keep = 3)        // pure: given [{commit, mtime}] -> commits to delete, newest `keep` retained
export function deployStatus(stateDir)               // read/write helpers for the status file the operator tails
export function writeDeployStatus(stateDir, phase, detail)
```

- [ ] **Step 1: Failing tests** — one per function; the ones that matter most:

```js
test('renderUpstreams(green) names only green services', () => {
  const body = renderUpstreams('green');
  assert.match(body, /api-green:3002/); assert.match(body, /web-green:3003/);
  assert.doesNotMatch(body, /blue/);
});
test('readState tolerates a corrupt state file by reporting, not throwing', () => { /* write garbage, expect null + corrupt flag */ });
test('writeState is atomic', () => { /* after write, no .tmp remnant; content round-trips */ });
test('prunePlan keeps the 3 newest and never the active commit', () => { /* pass active commit in, assert excluded from deletions */ });
```

(`prunePlan` must take the active commit as an explicit keep — losing the running release's worktree would break rollback.)
- [ ] **Steps 2-4: RED → implement → GREEN.**
- [ ] **Step 5: Commit** — `feat(deploy): blue-green engine library`

---

### Task 6: The Postgres migration safety gate

**Files:**
- Create: `scripts/bluegreen/migration-gate.mjs`
- Create: `scripts/bluegreen/migration-gate.test.mjs`

**Interfaces:**

```js
export function pendingMigrations(releaseMigrationsDir, appliedNames)  // dir names minus applied; sorted
export function lintMigrationSql(name, sql)   // -> { blocked: [], warned: [] } of findings with the matched excerpt
export function gateMigrations(pending /* [{name, sql}] */, { allowDestructive = false } = {})
// -> { ok, blocked, warned, overridden } ; ok=false when blocked.length && !allowDestructive
```

Applied names come from the LIVE db: the orchestrator (Task 7) runs `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL` via `docker compose … exec -T db psql` — the gate itself stays pure and offline-testable.

Lint vocabulary (Postgres; each rule one regex over comment-stripped SQL, case-insensitive):

```js
const BLOCKED = [
  ['drop-table',        /\bDROP\s+TABLE\b/],
  ['drop-column',       /\bALTER\s+TABLE\b[\s\S]{0,300}?\bDROP\s+COLUMN\b/],
  ['truncate',          /\bTRUNCATE\b/],
  ['rename-table',      /\bALTER\s+TABLE\b[\s\S]{0,200}?\bRENAME\s+TO\b/],
  ['rename-column',     /\bALTER\s+TABLE\b[\s\S]{0,300}?\bRENAME\s+COLUMN\b/],
  ['alter-column-type', /\bALTER\s+TABLE\b[\s\S]{0,300}?\bALTER\s+COLUMN\b[\s\S]{0,120}?\bTYPE\b/],
  ['set-not-null',      /\bALTER\s+TABLE\b[\s\S]{0,300}?\bSET\s+NOT\s+NULL\b/],
];
const WARNED = [
  // SHARE lock blocks writes for the build duration; fine at current volume,
  // this warning is future-you's reminder. CONCURRENTLY is the allowed form.
  ['create-index-non-concurrent', /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/],
];
```

Comment stripping: remove `--` line comments and `/* */` blocks before matching (a commented-out `DROP TABLE` must not block — test it). `ADD CONSTRAINT ... NOT VALID` passes; a bare `ADD CONSTRAINT ... CHECK`/`FOREIGN KEY` without `NOT VALID` gets a WARN rule `['validating-constraint', …]` — implementer writes the regex and pins it both ways.

Design note to carry verbatim as the file's header comment: *"A gate whose only exit is the override teaches everyone to reach for the override. Narrow these rules or give them proof-carrying exemptions; never widen silently. Every rule is pinned in both directions by migration-gate.test.mjs."*

- [ ] **Step 1: Failing tests, BOTH directions per rule** — every BLOCKED pattern has (a) a realistic matching SQL sample proven to block and (b) a near-miss proven to pass (e.g. `DROP TABLE` inside a comment; `ALTER TABLE … ADD COLUMN` not matching drop-column; `SET NOT NULL` absent). Plus: `ADD COLUMN … DEFAULT` passes; `CREATE TYPE … AS ENUM` and `ALTER TYPE … ADD VALUE` pass clean (the spec's allowed list); `CREATE INDEX CONCURRENTLY` passes clean; plain `CREATE INDEX` warns-not-blocks; override flips `ok` true while preserving the `blocked` list in `overridden`; `pendingMigrations` sorted-diff behaviour; a REAL migration from `apps/api/prisma/migrations/` (pick `…add_platform_operator/migration.sql`) passes the gate — the fixture that keeps the gate honest against actual repo SQL.
- [ ] **Steps 2-4: RED → implement → GREEN.**
- [ ] **Step 5: Commit** — `feat(deploy): expand/contract migration gate for postgres, pinned both directions`

---

### Task 7: Backup and restore-drill subcommands

**Files:**
- Create: `scripts/bluegreen/backup.mjs`
- Create: `scripts/bluegreen/backup.test.mjs`

**Interfaces:**

```js
export function backupPlan({ stateDir, now })    // -> { dir: `${stateDir}/backups/<ISO-stamp>`, dumpFile, documentsTar, manifestFile }
export function buildManifest(entries /* [{path, sha256, bytes}] */, meta /* {commit, activeColor, createdAt} */)
export function verifyManifest(manifest, recomputedEntries)  // -> { ok, missing, mismatched, extra }
export function retentionPlan(existingDirs, keepDays, now)   // pure: dirs older than keepDays
export async function runBackup(ctx)             // orchestrates: pg_dump -Fc via dockerized pg image, tar documents volume, sha256 every artifact, write manifest
export async function runRestoreDrill(ctx)       // restore dump into a THROWAWAY container (never the live db), row-count census vs manifest meta, verify documents hashes both ways, tear down
```

Mechanics mirror the repo's proven pieces: the pinned postgres image digest and dockerized-client invocation style from `scripts/postgres-backup.mjs`; documents tar via a one-shot alpine container mounting the volume read-only. `ctx` carries an injectable `runCommand` (the production-compose-deploy pattern) so unit tests assert the exact command lines without docker. The drill's scratch container name is `charitypilot-bluegreen-drill-<stamp>` and is force-removed in a `finally`.

- [ ] **Step 1: Failing tests** — pure functions fully (manifest round-trip; verifyManifest catches a flipped byte, a missing file, an extra file; retentionPlan boundary at exactly keepDays); `runBackup`/`runRestoreDrill` against a recording `runCommand`: assert the pg_dump command uses `-Fc`, targets the compose db service, redirects into the plan's dumpFile; the drill NEVER references the live db container/service in any command; teardown runs even when a step throws (inject a failing step).
- [ ] **Steps 2-4: RED → implement → GREEN.**
- [ ] **Step 5: Commit** — `feat(deploy): backup and restore-drill with sha256 manifests`

---

### Task 8: The orchestrator — deploy, rollback, status

**Files:**
- Create: `scripts/bluegreen-deploy.mjs`
- Create: `scripts/bluegreen-deploy.test.mjs`

**Interfaces:** CLI `node scripts/bluegreen-deploy.mjs <deploy|rollback|status|backup|restore-drill> [--detach] [--env-file <path>] [--state-dir <path>] [--allow-destructive-migration] [--skip-backup (drill/dev only, refused when NODE_ENV=production)]`.

Deploy phases in order — each `writeDeployStatus`, each failure path explicit:

1. `preflight` — env file exists; parse it; `assertDeploymentProfile`-level axis validation via a spawned `node -e` against the API's compiled validators is NOT reused (different process/env model): instead validate the deploy-critical keys directly (DATABASE_URL points at the compose db service; `BLUEGREEN_ENV_FILE` self-consistent; canonical-origin vars present when FRONTEND_URL is non-charitypilot.ie — the Task 1 vars); git worktree clean; `git fetch` + `HEAD == origin/master` gate (same rule the installer uses); acquire cutover lock (reused module).
2. `backup` — Task 7's `runBackup` (skippable only outside production).
3. `resolve` — `readState`; first deploy defaults active=none/target=blue; corrupt state ABORTS with instructions rather than guessing.
4. `worktree` — `git worktree add ${releaseDirFor(...)} <commit>`; prune per `prunePlan` (never the active commit).
5. `build` — `docker compose -f compose.bluegreen.yml -p charitypilot-bluegreen --profile <target> build` with `BLUEGREEN_<COLOR>_TAG=<commit>`; builds run FROM the release worktree (`--project-directory`).
6. `gate` — applied names via `exec -T db psql -tA -c 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'` (db started if not running); `gateMigrations` over the release worktree's `apps/api/prisma/migrations`; blocked ⇒ abort naming each finding unless `--allow-destructive-migration` (which also disables one-command rollback: record `rollbackable: false` in state).
7. `quiesce` — stop scheduler/job singletons.
8. `migrate` — one-shot `migrate` service on the target tag; failure ⇒ restart jobs on the OLD tag and abort (old colour untouched, still serving).
9. `up` — `--profile <target> up -d --wait` (compose healthchecks gate readiness).
10. `candidate-smoke` — `exec -T api-<target> node -e 'fetch readiness'`… simplest robust: `docker compose … exec -T api-<target> wget -qO- http://127.0.0.1:3002/api/v1/health/readiness` (confirm the actual readiness path from `routes/health/index.ts` and use it verbatim); assert HTTP 200 AND `buildCommit === <commit>` (Task 3). Web candidate: `wget` the web service root, 200.
11. `switch` — back up `caddy/active-upstreams.caddy`, write `renderUpstreams(target)`, `docker compose … exec -T caddy caddy validate --config /etc/caddy/Caddyfile`, then `exec -T caddy caddy reload --config /etc/caddy/Caddyfile`; reload failure ⇒ restore file, reload again, abort.
12. `public-smoke` — `wget` through the FRONT DOOR (`http://127.0.0.1:${BLUEGREEN_FRONT_PORT}/api/v1/health/readiness`), assert 200 + buildCommit; failure ⇒ restore previous upstreams, reload, restart jobs on old tag, abort with traffic verified back (re-run public smoke expecting the OLD commit — assert it).
13. `jobs` — start scheduler/jobs on the target tag.
14. `retire` — `stop` the old colour's services (containers kept).
15. `record` — `writeState({activeColor: target, commit, deployedAt})`, prune backups per retention, release lock.

`rollback`: read state; verify the previous colour's containers exist (`ps -a`); refuse with a clear message if `rollbackable: false`; write previous upstreams, validate+reload, restart jobs on previous tag, public-smoke asserting the previous commit, flip state. `status`: print state + compose ps + tail of deploy status. `--detach`: re-exec self with `spawn(..., {detached: true, stdio: ['ignore', logFd, logFd]})` writing to `${stateDir}/deploy-<stamp>.log`, print the log path and exit — the staging engine's contract.

- [ ] **Step 1: Failing tests** with an injected recording runner (mirror `production-compose-deploy.test.mjs`'s harness — read it first):

```js
test('phase order is exactly the spec sequence', ...)          // assert the recorded command groups' order
test('a blocked migration aborts BEFORE quiesce and touches nothing', ...)
test('migrate failure restarts jobs on the OLD tag and never ups the target colour', ...)
test('candidate smoke failure leaves the switch unexecuted', ...)
test('public smoke failure restores upstreams, reloads, and re-verifies the OLD commit', ...)
test('reload failure restores the previous upstream file', ...)
test('rollback refuses after --allow-destructive-migration', ...)
test('every DSN in the transcript is redacted', ...)            // feed a DATABASE_URL, grep the recorded log
test('lock is released on every abort path', ...)
test('--skip-backup refused when NODE_ENV=production', ...)
```

- [ ] **Steps 2-4: RED → implement → GREEN.** Then run the root `test:production-check` — every script test green.
- [ ] **Step 5: Commit** — `feat(deploy): blue-green orchestrator with revert-on-failed-smoke`

---

### Task 9: Wiring, runbook, ledger

**Files:**
- Modify: root `package.json` (scripts: `bluegreen:deploy`, `bluegreen:rollback`, `bluegreen:status`, `bluegreen:backup`, `bluegreen:restore-drill` → `node scripts/bluegreen-deploy.mjs <cmd>`)
- Create: `docs/bluegreen-runbook.md`
- Modify: `docs/reliability/guarantees.json` (+ regenerate)
- Modify: `docs/superpowers/specs/2026-08-31-deployment-profile-and-bluegreen-design.md` (tick the named prerequisite: origins/webhook now configurable — cite Task 1)

- [ ] **Step 1: Runbook** — operator-facing, the `docs/owner-console-runbook.md` register: prerequisites (env file with axes + canonical origins + OWNER vars + BLUEGREEN_ENV_FILE), the SSH invocation with `--detach`, reading the status file, what each failure mode looks like and what the engine already did about it (traffic reverted, lock released), rollback, the destructive-migration override and its cost (no one-command rollback), backup/restore-drill usage, retention, and the nightly-cron line: the VM's nightly backup will invoke this same `bluegreen:backup` subcommand (wired in P3). State plainly: the engine has never touched the VM; P3 owns that.
- [ ] **Step 2: Ledger rows** — cite real test titles verbatim: gate blocks each destructive class / override preserves the blocked list; public-smoke failure reverts traffic and re-verifies the old commit; lock released on abort; drill never touches the live db; canonical-origin defaults unchanged; alert opt-out both directions; bootstrap link fragment-only. Regenerate; exit 0; zero broken links.
- [ ] **Step 3: Root `npm test` full chain green.**
- [ ] **Step 4: Commit** — `docs(deploy): blue-green runbook, npm entry points, ledger rows`

---

### Task 10: Local acceptance — the full cycle on scratch volumes

Not a unit test: the operator-shaped proof the spec demands before any VM use. The implementer RUNS it and the report carries the evidence (commands + output). Docker required locally.

- [ ] **Step 1:** Write `.bluegreen/local.env` (self-contained axes per P1, scratch secrets ≥32 chars, `DATABASE_URL` at the compose db, `BLUEGREEN_ENV_FILE` pointing at itself). `npm run bluegreen:deploy -- --env-file .bluegreen/local.env` (skip-backup NOT set — prove backup too). **Before that first deploy's backup runs**, seed the scratch deployment with at least one provisioned tenant (organisation + user — via the owner console API or a direct `psql` insert against the compose `db`, operator's choice) and at least one stored document (uploaded through the app, or written directly into the `charitypilot-bluegreen-documents` volume) — a fresh, empty deployment makes the row census and per-document hash manifest degenerate (`{}` vs `{}`, zero manifest entries), which is structurally incapable of exercising Task 7's census/hash mechanics even when everything downstream is broken. Evidence: status file phases, `docker compose ps` showing blue serving, public smoke output with buildCommit, and the seeded tenant/document identifiers.
- [ ] **Step 2:** Make a trivial committed change (docs touch) and deploy again → green colour takes traffic; old blue stopped-but-present. Evidence as above plus the upstream file diff.
- [ ] **Step 3:** `npm run bluegreen:rollback` → blue serving again, public smoke shows blue's commit.
- [ ] **Step 4:** `npm run bluegreen:restore-drill` against the step-1 backup → census + hashes verified, scratch container gone after. Evidence must show a NON-degenerate census (the step-1 seeded tenant's row counts, not `{}`) and the seeded document's hash actually verified — not just a green exit code.
- [ ] **Step 5:** Tear down (`docker compose -p charitypilot-bluegreen down -v`), commit nothing but the report; the evidence lives in the task report file.

---

## Post-Implementation Notes

- P3 (VM cutover) consumes this engine unchanged: an override compose file pointing volumes at `personal-server-db`/`personal-server-documents` (`external: true`), the VM env file with the Task 1 canonical-origin vars set to the Tailscale origin, and the runbook's Option-D-replacement section. None of that is in P2.
- The appliance product is untouched by every task here except Task 1's env.ts changes (defaults preserve it — pinned by test) and Task 3's Dockerfile ARG (no default ⇒ null ⇒ readiness field absent-equivalent; appliance compose passes nothing).
