# Deployment Profile Split and Blue-Green Deploys Design

## Purpose

The owner's Hyper-V VM is the platform's real deployment server — kept off the
public internet by choice (Tailscale-only ingress), not by limitation. Today it
cannot serve that role, for two reasons that look like one:

1. It was provisioned with the **personal-server appliance profile**, whose
   deploy story is install/decommission — tearing the stack down rather than
   deploying to it.
2. `isPersonalServerDeployment()` is one flag doing two jobs: it selects
   **tenancy** (single-charity, no registration, no owner console) and
   **providers** (manual links instead of email, no provider health checks) at
   once. The combination the owner wants — multi-tenant with local providers —
   is unrepresentable.

This design makes the VM a self-contained, multi-tenant deployment target with
zero-downtime blue-green deploys, without changing the shipped appliance
product's behaviour at all.

It is three projects, in dependency order, each independently shippable:

- **P1 — Split the deployment profile into capability axes** (code only, no VM
  involvement)
- **P2 — A blue-green deploy engine for CharityPilot** (Caddy switch, Prisma
  migration gate; exercised locally before any VM use)
- **P3 — Cut the VM over** from the appliance stack to the blue-green stack by
  in-place volume takeover

## Decisions Already Made (with the owner)

- The VM stays **fully self-contained**: local document storage, **no email
  provider** for now, no Supabase, no Stripe, nothing outbound required.
- **Tenant intake is provision-only**: self-serve registration stays off on
  this VM; every tenant is created through the owner console.
- **The deploy engine owns the safety net**: backup/restore become deploy-engine
  phases; the appliance's recovery machinery retires on this host — but only
  after a rehearsed restore drill passes (a hard acceptance gate).
- Approach picks: capability axes (not a third mode); extend the repo's Node
  deploy tooling (not a port of the staging bash engine); in-place volume
  takeover (not export/import).
- The one-time cutover accepts a short downtime window (~10–15 min).
  Zero-downtime deploys start from the first blue-green deploy after it.

## Verified Facts This Design Depends On

- `scripts/production-compose-deploy.mjs` already implements a
  quiesce → migrate → up compose deploy with a cutover lock, preflight,
  backup hook, and transcript redaction. The teardown deploy on the VM is a
  consequence of the appliance provisioning, not of anything in this repo's
  deploy tooling.
- `storage.service.ts:22` selects local storage purely on
  `DOCUMENT_STORAGE_DRIVER === 'local'`, independent of deployment mode — the
  precedent every new axis follows.
- In-process cron is already disabled in production (`utils/cron.ts`:
  `NODE_ENV === 'production' && ENABLE_IN_PROCESS_JOBS !== 'true'`), and
  `compose.production.yml` runs a dedicated `production-scheduler` service with
  the API pinned to `ENABLE_IN_PROCESS_JOBS: "false"`. Blue-green therefore
  needs no scheduler extraction — the scheduler is a singleton restarted onto
  the new image at cutover.
- The appliance answers billing with data, not code:
  `initialize-personal-server` creates `plan: COMPLETE, status: ACTIVE,
  trialEndsAt: null`, and `subscriptionGuard` has no mode exemption. Comped
  tenants reuse this pattern exactly.
- The appliance compose names its volumes `personal-server-db` and
  `personal-server-documents` and pins `postgres:16.4-alpine`. Referencing the
  same named volumes as `external` from a new compose file is a complete
  takeover mechanism.
- The appliance already surfaces links instead of emailing
  (`password-recovery.service.ts:548`, `team.service.ts:371` manualInviteUrl)
  — the `manual-link` email mode generalises existing behaviour, it does not
  invent new behaviour.
- The owner's staging blue-green engine
  (`C:\platforms\htdocs\staging\scripts\deploy\bluegreen-deploy.sh`) provides
  the design template: route-file switch with backup and graceful reload,
  post-cutover public smoke that reverts traffic on failure, an
  expand/contract migration safety gate pinned both directions by tests,
  `--detach`, release worktrees retained as rollback candidates, and a deploy
  status file. Its code is Laravel/Apache/MariaDB-shaped and is NOT ported;
  its design is.

## Out of Scope

- Email/SMTP support beyond the existing Resend path and the `manual-link`
  mode. Adding a local SMTP sink is future work the axes make easy.
- Stripe/billing on the VM. Comped tenants make it unnecessary.
- Changing the appliance product's behaviour, installers, release process, or
  recovery machinery. It ships unchanged and remains this VM's worst-case
  rebuild path.
- Blue-green for any host other than this VM (the design generalises, but only
  this VM is in scope to cut over).
- TOTP for platform operators (already recorded as the owner console's next
  piece of work — unchanged by this design).

---

# P1 — Deployment profile split

## The axes

One new module, `apps/api/src/utils/deployment-profile.ts`, is the only code
that interprets configuration into capabilities:

| Axis | Env var | Values | Default under `personal-server` | Default otherwise |
| --- | --- | --- | --- | --- |
| Tenancy | `CHARITYPILOT_TENANCY` | `multi` \| `single` | `single` | `multi` |
| Registration | `CHARITYPILOT_REGISTRATION` | `open` \| `closed` | `closed` | `open` |
| Email delivery | `CHARITYPILOT_EMAIL_DELIVERY` | `provider` \| `manual-link` | `manual-link` | `provider` |
| Billing | `CHARITYPILOT_BILLING` | `stripe` \| `none` | `none` | `stripe` |

The billing axis is a recorded deviation from the first draft, which keyed
billing readiness on "Stripe config presence" — circular, since a
presence-keyed check can never fail. `none` exempts billing from health
readiness and hides the tenant billing page; subscriptions are handled with
comped data instead.

Document storage keeps its existing independent axis
(`DOCUMENT_STORAGE_DRIVER`), untouched.

Exports: `isMultiTenant()`, `isRegistrationOpen()`, `emailDeliveryMode()`, `billingMode()`.
An explicit env var wins; otherwise the default derives from
`CHARITYPILOT_DEPLOYMENT_MODE`. Invalid values fail loudly at boot.

`isPersonalServerDeployment()` survives for what is genuinely
appliance-lifecycle: installer jobs (`initialize-personal-server`,
`personal-server-account`), recovery-secret rotation, appliance env
validation, and the appliance web build/proxy profile.

## Call-site re-routing

| Call site | Today keyed on | Re-keyed to |
| --- | --- | --- |
| `routes/auth/index.ts` register 404 gate | mode | `isRegistrationOpen()` |
| `routes/owner/index.ts` console gate | mode | `isMultiTenant()` |
| `server.ts` `OWNER_JWT_SECRET` boot guard | mode | `isMultiTenant()` |
| `password-recovery.service.ts` manual reset link | mode | *stays keyed on `isPersonalServerDeployment()` — its use selects audit labels describing the appliance operator flow (`SUPPORT`/`'Personal-server operator'`), which is lifecycle identity, not an email-delivery behaviour. The user-facing email-axis behaviour lives in the provider-email endpoint gate instead.* |
| `team.service.ts` manual invite link | mode | `emailDeliveryMode() === 'manual-link'` |
| `routes/health` provider-readiness checks | mode | `emailDeliveryMode() === 'manual-link'` exempts email readiness; `billingMode() === 'none'` exempts billing readiness |
| Web (`NEXT_PUBLIC_…` checks in login, forgot/reset password, dashboard nav, marketing) | one mode var | per-axis `NEXT_PUBLIC_` variants, chosen by each check's true reason (copy/links → email axis; nav/register CTAs → tenancy/registration axes) |

## Axis-aware environment validation

`validateProductionEnv()` today hard-requires `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `RESEND_API_KEY`, and
`EMAIL_FROM`. It becomes axis-aware:

- `DOCUMENT_STORAGE_DRIVER=local` ⇒ the Supabase trio is not required (local
  storage path/volume config is required instead, mirroring the appliance's
  checks).
- `CHARITYPILOT_EMAIL_DELIVERY=manual-link` ⇒ `RESEND_API_KEY` and
  `EMAIL_FROM` are not required.
- `CHARITYPILOT_TENANCY=multi` ⇒ `OWNER_JWT_SECRET` required (≥32 chars,
  distinct from `JWT_SECRET`) — the existing rule, re-keyed.
- The personal-server validation branch is untouched.

Tests cover each conditional in both directions.

## Behaviour additions the axes unlock

1. **Provisioning under `manual-link`.** The owner console's provision flow
   currently emails welcome/verification/set-password and deliberately returns
   no raw tokens. Under `manual-link` it must instead return the set-password
   and verification links in the 201 response, and the console UI shows them
   once with copy controls — the `manualInviteUrl` pattern. Under `provider`,
   behaviour is unchanged (emails sent, no tokens in the response). The
   security rationale is preserved: links are surfaced only to an
   authenticated platform operator over the owner-scoped session, exactly like
   the appliance's reset links.

2. **Comped tenants.** The provision request gains
   `billing: 'trial' | 'comped'` (default `trial`, with `trialDays` as
   today). `comped` creates `status: ACTIVE, trialEndsAt: null` — the
   appliance's own subscription shape. No middleware changes;
   `subscriptionGuard` already honours the data.

## The compatibility invariant (P1's most important test)

With `CHARITYPILOT_DEPLOYMENT_MODE=personal-server` and none of the new vars
set, every re-routed call site resolves exactly as before the split — asserted
per call site in one test file. The shipped appliance product's behaviour is
frozen by test, not by intention. A matching invariant covers default
(non-personal-server) mode: no new vars ⇒ today's production behaviour.

---

# P2 — Blue-green deploy engine

## Topology

- **Colour-scoped:** `api` and `web` only (`charitypilot-blue-api`,
  `charitypilot-green-web`, …), built on the host from a git release worktree,
  images tagged with the commit.
- **Singletons:** Postgres (shared by both colours), Caddy (front door), the
  scheduler and job services, the one-shot `migrate` runner.
- **Network:** one compose network; Caddy proxies by container DNS name. No
  host ports for app containers at all.
- **Front door:** unchanged forever — Tailscale Serve → `127.0.0.1:8080` →
  Caddy. Nothing outside the VM ever sees a cutover.

New files: `compose.bluegreen.yml` (with `build:` contexts, following
`compose.personal-server.yml`'s local-build precedent) and
`caddy/Caddyfile.bluegreen`, which `import`s a generated
`active-upstreams.caddy` naming the live colour's containers.

## The switch

Cutover = back up `active-upstreams.caddy`, write the target colour's
upstreams, `caddy validate`, then graceful `caddy reload` (in-flight requests
finish). A failed reload restores the previous file. This is the staging
engine's route-file pattern with Caddy semantics.

## The engine

`scripts/bluegreen-deploy.mjs` (+ `bluegreen-deploy.test.mjs`), importing the
existing cutover-lock, preflight, and transcript-redaction modules from the
production deploy tooling rather than duplicating them. Subcommands: `deploy`
(with `--detach`), `rollback`, `status`, `backup`, `restore-drill`.

Invocation from the operator's machine, staging-style:

```bash
ssh cpops@charitypilot "cd /opt/charitypilot && sudo node scripts/bluegreen-deploy.mjs deploy --detach"
```

Deploy phases, in order, each updating a deploy-status file:

1. **Preflight** — axis env validation, disk space, `git fetch` and
   `HEAD == origin/master` gate, acquire cutover lock.
2. **Backup** — `pg_dump -Fc` + documents tar + sha256 manifest to a dated
   directory with retention. The nightly cron invokes this same subcommand.
3. **Resolve colours** — active colour from the state file; target is the
   other.
4. **Release worktree** at the target commit; keep the 3 most recent as
   rollback candidates.
5. **Build** the target colour's images, tagged with the commit.
6. **Migration safety gate** (below).
7. **Quiesce** scheduler/job singletons.
8. **Migrate** — one-shot runner on the new image against the shared
   database. Safe under load because the gate enforced expand/contract: the
   still-serving old colour tolerates the new schema.
9. **Up the target colour**; wait on compose healthchecks.
10. **Candidate smoke** directly against the target containers: health, login
    page, and a served-commit assertion (the commit is baked into the image;
    smoke verifies the candidate actually runs the bytes just built).
11. **Switch** — write upstreams, validate, graceful reload.
12. **Public smoke through the front door.** On failure: restore the previous
    upstream file, reload, and fail the deploy with traffic back on the old
    colour.
13. **Restart scheduler/jobs** on the new image.
14. **Retire the old colour**: disable its restart policy, stop gracefully,
    keep containers and images.
15. **Record state** (active colour, commit, timestamp), prune to 3 releases,
    release the lock.

`rollback`: flip the upstream file to the previous colour (containers still
present; start if stopped), restart scheduler on that image. Migrations are
**not** undone — expand/contract is the contract that makes old code safe on
the new schema. A deploy that used the destructive override is explicitly not
one-command rollbackable.

## The Postgres migration safety gate

Lints the **pending** migration `.sql` files (CharityPilot migrations are raw
SQL — no ORM parsing). Philosophy from the staging gate; vocabulary for
Postgres:

- **Blocked** without `DEPLOY_ALLOW_DESTRUCTIVE_MIGRATION=1`:
  `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `RENAME` (table or column),
  `ALTER COLUMN … TYPE`, `SET NOT NULL` — each either breaks the
  still-serving colour or takes `ACCESS EXCLUSIVE` for a rewrite.
- **Allowed:** `CREATE TABLE`, `ADD COLUMN` (nullable, or with a default —
  metadata-only on PostgreSQL 11+), `CREATE INDEX CONCURRENTLY`, new enum
  types and `ADD VALUE`, `CREATE`/`ALTER` of constraints declared
  `NOT VALID`.
- **Warned, not blocked:** plain `CREATE INDEX` (takes a SHARE lock that
  blocks writes; harmless at current data volume, and the warning is the
  reminder for when it is not).

The gate's rules are pinned in both directions by tests — every blocked form
proven to block, every allowed form proven to pass, the override proven to
work — so the gate can only change deliberately. Design note carried over from
the staging engine verbatim, because it was earned: *a gate whose only exit is
the override teaches everyone to reach for the override.* Rules should be
narrowed or given proof-carrying exemptions rather than widened.

## Engine testing

`bluegreen-deploy.test.mjs` covers the pure logic: colour resolution,
upstream-file rendering, phase ordering, revert-on-failed-smoke and
revert-on-failed-reload, lock acquisition/release, backup manifest shape.
Acceptance before any VM use: a full local cycle on scratch volumes —
deploy → switch → second deploy → rollback — run on the development host.

---

# P3 — VM cutover

## Mechanism

`compose.bluegreen.yml` references the appliance's named volumes
(`personal-server-db`, `personal-server-documents`) as `external: true` and
pins the same Postgres major (16). Stopping the appliance stack and starting
the blue-green stack changes processes, never data. The existing charity is
tenant #1 as-is; its logins are untouched.

The VM's new env file sets: `CHARITYPILOT_TENANCY=multi`,
`CHARITYPILOT_REGISTRATION=closed`, `CHARITYPILOT_EMAIL_DELIVERY=manual-link`,
`DOCUMENT_STORAGE_DRIVER=local`, `OWNER_JWT_SECRET` (new, ≥32 chars, distinct
from `JWT_SECRET`), `OWNER_CONSOLE_ORIGIN=<the Tailscale origin>`, and drops
every Supabase/Resend/Stripe variable.

## Named prerequisite: `validateProductionEnv` still pins the hosted origins

This VM is `CHARITYPILOT_TENANCY=multi` with no
`CHARITYPILOT_DEPLOYMENT_MODE=personal-server` — it is not the appliance
validation branch, so `validateRuntimeEnv()` runs `validateProductionEnv()`
(apps/api/src/utils/env.ts), unchanged by anything in P1. That validator
today:

- pins `FRONTEND_URL` and `NEXT_PUBLIC_API_URL` to the exact canonical hosted
  origins (`canonicalOriginRole: 'web' | 'api'` ⇒
  `https://app.charitypilot.ie` / `https://api.charitypilot.ie`, checked by
  strict origin equality), and
- requires a public `ERROR_ALERT_WEBHOOK_URL` (`requirePublicHost: true`).

The target VM can satisfy neither: its web/API origins are the Tailscale
Serve origin, not the canonical hosted ones, and there is no requirement that
its alert webhook receiver be publicly reachable. As written, `blue`
container boot — and P2's Preflight phase ("axis env validation", deploy
phase 1, which runs the same `validateRuntimeEnv()`) — fails closed on this
VM's env file before Sequence step 4 ever brings a colour up.

**Resolved by Task 1.** `validateProductionEnv` (and the deadline-reminders
job's own `validateDeadlineRemindersEnv`) now accept two override vars,
`CHARITYPILOT_CANONICAL_WEB_ORIGIN` / `CHARITYPILOT_CANONICAL_API_ORIGIN`:
when set, the exact-origin check pins `FRONTEND_URL` /
`NEXT_PUBLIC_API_URL` to the configured origin (e.g. the Tailscale Serve
origin) instead of the hardcoded `https://app.charitypilot.ie` /
`https://api.charitypilot.ie`; with neither var set, every hosted-SaaS
install keeps today's exact origins unchanged
(`apps/api/src/tests/deployment-origins-env.test.ts`, "defaults unchanged:
canonical charitypilot.ie origins still required with no new vars"). The
public-webhook requirement is relaxed the same way: `CHARITYPILOT_ERROR_ALERTS=none`
drops the `ERROR_ALERT_WEBHOOK_URL` requirement in both the API boot
validator and the job validator, symmetrically (same test file, "job
validator (deadline reminders): alerts=none both directions"). Sequence
step 4 (bringing up the blue colour) is therefore unblocked on this VM's
env file: set both canonical-origin vars to the Tailscale Serve origin and
`CHARITYPILOT_ERROR_ALERTS=none` if no public alert receiver exists.

## Sequence

1. Final appliance backup via the proven `charitypilot-backup.sh`, copied
   off-VM.
2. Hyper-V checkpoint (clean stop → checkpoint → start). Applying this
   checkpoint is the whole-cutover rollback.
3. On the VM: fetch/reset to the target commit; write the new env file;
   `compose down` the appliance stack (containers only).
4. Up the blue-green stack on the same volumes: db → migrate → blue colour →
   scheduler → Caddy. Tailscale Serve unchanged.
5. Bootstrap the platform operator with the `owner:create` job (per the owner
   console runbook) and set the password via the printed link.
6. Verify: existing charity signs in; documents sha256-spot-checked against
   step 1's manifest; the console lists tenant #1; one comped test tenant is
   provisioned end-to-end (create → manual set-password link → new tenant
   signs in); the scheduler is alive.
7. Safety-net acceptance: run the engine `backup`, then the **restore
   drill** — `restore-drill` restores that backup into a scratch container on
   the VM (never over live) and verifies row counts and document hashes both
   ways. Only then does the nightly cron switch to the engine's backup and the
   appliance cron get disabled.
8. One real blue-green deploy of a trivial commit, end to end.
9. Only after 6–8 pass: delete the checkpoint; **archive, never delete** the
   appliance install-state directory (the old recovery key lives there);
   update `D:\CharityPilot-VM\provision\RUNBOOK.md` so blue-green replaces
   §3 Option D as this host's deploy path.

## What the appliance becomes on this host

Nothing running. The installer remains in the repo as the shipped product, and
remains this VM's worst-case rebuild path (provision fresh → engine
`restore`). Day-to-day disaster recovery is engine backups (copied off-VM)
plus Hyper-V checkpoints at deploy time.

## Rollback during cutover

Apply the step-2 checkpoint: the appliance is back exactly as it was,
including its own backup cron. Nothing before step 9 destroys any appliance
state.

---

# Testing and Invariants (cross-project)

- **Appliance compatibility invariant** (P1): mode `personal-server` with no
  new vars resolves every call site exactly as today — per-site assertions.
- **Default-mode invariant** (P1): no new vars in default mode ⇒ today's
  production behaviour.
- **Axis-aware env validation** tested in both directions per conditional.
- **Migration gate pinned both directions** (P2), staging-style.
- **Engine pure-logic tests** in `bluegreen-deploy.test.mjs`; local
  scratch-volume cycle as P2 acceptance.
- **P3 acceptance is operational**: the Section "Sequence" gates 6–8, recorded
  as a runbook checklist rather than automated tests.
- New guarantees are added to `docs/reliability/guarantees.json` (the source
  of truth — `docs/RELIABILITY.md` is generated) and must resolve in
  `npm run reliability:report`.
- The existing structural guards (tenant isolation, sole-writer of
  `Organisation.lifecycleStatus`, owner/tenant token isolation) are untouched
  by all three projects; any new page routes added under `(owner)` must keep
  the pinned dynamic-segment sets green.

# Accepted Risks

- **Forgot-password stays disabled (404) under `manual-link`.** A tenant on
  the self-contained VM who forgets their password needs the platform
  operator; the console has no per-tenant reset-link reissue yet. Follow-up
  work, deliberately out of P1.
- **No reuse detection on owner refresh tokens** (pre-existing, recorded in
  the owner console spec) — unchanged here; the console becoming reachable on
  the VM makes the planned follow-up more relevant, not less.
- **Expand/contract discipline is now load-bearing for deploys.** A
  destructive migration requires the override plus a deliberately planned
  deploy (and forfeits one-command rollback). This is the same trade the
  owner's staging platform lives with.
- **The proven appliance restore path is retired on this host** in favour of
  the engine's backup/restore. Mitigated by the mandatory restore drill in P3
  step 7 and by keeping the final appliance backup off-VM indefinitely.
- **Single shared Postgres** means database failure downs both colours.
  Unchanged from today (the appliance also runs one database); noted so
  nobody mistakes blue-green for database HA.
