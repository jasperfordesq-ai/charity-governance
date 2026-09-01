# Blue-Green Deploy Runbook

The blue-green engine (`scripts/bluegreen-deploy.mjs`, driving
`compose.bluegreen.yml` and the primitives in `scripts/bluegreen/`) is a
colour-scoped deploy: `api`/`web` run twice (`blue`/`green`), Postgres and
Caddy are shared singletons, and cutover is a Caddy upstream-file swap plus
graceful reload — never a container restart on the front door. It follows
the same operational conventions as `docs/production-runbook.md`
(cutover lock, transcript redaction, `--detach` for a backgrounded run) but
owns its own state directory, env file, and compose project
(`charitypilot-bluegreen`) so it never collides with the production
compose stack.

**This document is register-format**, matching
[`docs/owner-console-runbook.md`](owner-console-runbook.md): preconditions,
then the operational sequences an operator actually runs.

**Scope note, stated plainly:** this engine has never been run against a
real production VM. Everything below is proven against `docker compose`
and a scratch Postgres locally (`scripts/bluegreen-deploy.test.mjs`,
`scripts/bluegreen/*.test.mjs`) and, separately, a local acceptance cycle.
Cutting an actual VM over to it — the Hyper-V checkpoint, the appliance
comparison, wiring the nightly cron — is a later project (P3 in
`docs/superpowers/specs/2026-08-31-deployment-profile-and-bluegreen-design.md`'s
own numbering) and is **not** covered by anything in this repo yet.

## Preconditions

- **Host binaries.** The operator's own machine (not a container) must
  have `docker`, `git`, and `wget` on `PATH` — the engine spawns all
  three directly (compose, the release worktree, and the public-facing
  smoke tests that hit the front door from outside any container). A
  missing one now fails the phase-1 preflight by name instead of
  surfacing as an opaque error deep into the run.
- **One env file, self-consistent.** Every container reads application
  config from a single file via `env_file: ${BLUEGREEN_ENV_FILE:?...}`
  (`compose.bluegreen.yml`'s header comment). That same file must declare
  `BLUEGREEN_ENV_FILE` pointing at its own resolved path — the engine's
  preflight (`preflightIssues` in `scripts/bluegreen-deploy.mjs`) rejects a
  mismatch before anything runs, so a stale or copy-pasted env file can
  never be used by accident.
- **`DATABASE_URL`** must resolve to hostname `db` exactly (the compose
  `db` service) — preflight rejects any other host.
- **`READINESS_API_KEY`** must be set (candidate- and public-smoke both
  authenticate readiness calls with it) and **`BLUEGREEN_ORIGIN`** must be
  set (the single origin Caddy serves web and API on; the web image build
  also bakes it in as `NEXT_PUBLIC_API_URL` /
  `NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN`). **`BLUEGREEN_FRONT_PORT`**
  is optional (defaults to `8080`) but must be a plain positive integer
  when set.
- **`BLUEGREEN_DOCUMENTS_VOLUME`** is optional (defaults to the compose
  file's own `charitypilot-bluegreen-documents` volume name) — set it
  only if this deployment's document storage volume was named
  differently.
- **Canonical-origin axis vars**, when the deployment's `FRONTEND_URL` is
  not a `charitypilot.ie` hostname (e.g. a Tailscale Serve origin):
  `CHARITYPILOT_CANONICAL_WEB_ORIGIN` and `CHARITYPILOT_CANONICAL_API_ORIGIN`
  are both required, or preflight refuses to start. Both must be an
  **exact `https://` origin** — no path, no trailing slash, no
  credentials (preflight now validates the shape, not just presence; the
  same rule `apps/api/src/utils/env.ts` enforces at container boot). Note
  this is stricter than the web app's OWN build-time override
  (`NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN`, baked in from
  `BLUEGREEN_ORIGIN` above), which additionally accepts an exact loopback
  `http://` origin for local acceptance testing — the two vars serve
  different layers and are validated differently on purpose. See
  `docs/superpowers/specs/2026-08-31-deployment-profile-and-bluegreen-design.md`'s
  "Named prerequisite" section for how these two vars (plus
  `CHARITYPILOT_ERROR_ALERTS=none` to drop the public-webhook requirement)
  unblock a non-hosted deployment target.
- **Owner-console vars**, if this deployment is meant to run the owner
  console (multi-tenant, not `personal-server` mode): `OWNER_JWT_SECRET`
  (≥32 chars, distinct from `JWT_SECRET`) and `OWNER_CONSOLE_ORIGIN` (or
  `APP_ORIGIN`) — see `docs/owner-console-runbook.md`'s own Preconditions.
  Bootstrap the first operator with `npm run owner:create` per that
  runbook once the target colour is live.
- **`NODE_ENV=production` forbids `--skip-backup`.** The engine refuses
  outright — backups are mandatory for a production deploy, no override.
- **Caddy's admin API must stay a unix socket — never copy personal-
  server's `admin off` into `caddy/Caddyfile.bluegreen`.** Every `caddy
  reload` this engine runs (switch, rollback, and their best-effort
  restore-on-failure paths) talks to that admin API; with it off there is
  no listener and every deploy/rollback fails deterministically at the
  cutover. The Caddyfile pins it to
  `admin unix//tmp/caddy-admin.sock` — a container-local socket on the
  existing `/tmp` tmpfs, reachable only from inside the container via
  `docker compose exec`, never over the network.

## Invocation

From the operator's machine, staging-style (mirrors
`docs/production-runbook.md`'s own SSH pattern):

```bash
ssh cpops@charitypilot "cd /opt/charitypilot && sudo npm run bluegreen:deploy -- --env-file /path/to/bluegreen.env --detach"
```

`--detach` probes the cutover lock in the foreground (so contention fails
loudly here, not silently in the background), then spawns the real deploy
and prints the log path to tail:

```text
Deploying in the background. Tail the log: /opt/charitypilot/.bluegreen/state/deploy-2026-08-31T12-00-00-000Z.log
```

The five subcommands, each wired as an npm script in the root
`package.json` (`bluegreen:deploy`, `bluegreen:rollback`,
`bluegreen:status`, `bluegreen:backup`, `bluegreen:restore-drill` →
`node scripts/bluegreen-deploy.mjs <cmd>`), all accept `--env-file`
(required) and `--state-dir` (defaults to `.bluegreen/state` under the
repo root):

```bash
npm run bluegreen:deploy       -- --env-file <path> [--detach] [--allow-destructive-migration] [--skip-backup]
npm run bluegreen:rollback     -- --env-file <path>
npm run bluegreen:status       -- --env-file <path>
npm run bluegreen:backup       -- --env-file <path>
npm run bluegreen:restore-drill -- --env-file <path>
```

## Reading status

```bash
npm run bluegreen:status -- --env-file /path/to/bluegreen.env
```

prints the recorded `state.json` (active/previous colour + commit,
`deployedAt`, whether a one-command `rollback` is available), a live
`docker compose ps -a`, and the last 10 entries of the deploy-status
history (`deploy-status.json` under the state directory — one entry per
phase, capped at 50 total, so a long-lived VM's history file never grows
unbounded).

## What each failure mode looks like, and what the engine already did

Every phase below writes a status entry before it runs, so `status`'s
history always shows exactly how far a deploy got.

- **Preflight fails** (bad env, a malformed canonical-origin override, a
  missing host binary — `docker`/`git`/`wget` — dirty worktree, `HEAD`
  not at fetched `origin/master`) — nothing was touched; the cutover
  lock is released.
- **Migration gate blocks** — the deploy aborts *before quiesce*; nothing
  was touched at all (no container stopped, no lock left held).
- **Migration run fails** — the scheduler (stopped at quiesce) is
  restarted on the **old** commit; the old colour was never touched and
  remains serving.
- **Candidate smoke fails** (the new colour's own readiness/`/login` check,
  before any traffic switch) — the switch is never executed; the scheduler
  is restarted on the old tag.
- **Caddy reload fails while switching** — the previous
  `active-upstreams.caddy` file is restored and reloaded; the scheduler is
  restarted on the old tag; traffic was never switched.
- **Public smoke fails after the switch** (traffic is already on the new
  colour and the front-door readiness check fails) — the engine reverts:
  restores the previous upstream file, reloads Caddy, restarts the
  scheduler on the old commit, and **re-verifies the front door reports
  the OLD commit** before returning failure. Verbatim from
  `scripts/bluegreen-deploy.mjs`:

  > Blue-green deploy failed: public smoke test failed after switching to
  > \<target\>: \<error\>. Traffic was reverted to the old colour and
  > re-verified.

  On a **first deploy** (no old colour to revert to), the revert block is
  skipped entirely with its own explicit message — traffic stays on the
  new colour, which failed its own public smoke test, and needs manual
  inspection.
- **Recording state fails right after cutover** (traffic has already
  switched and been verified, but the atomic `state.json` write itself
  failed — disk full, permissions, a stray temp-file collision). The
  engine does **not** pretend nothing happened: it logs a
  `state-write-failed` status entry and returns an operator-actionable
  message naming the exact fields to write by hand. Verbatim:

  > Traffic has ALREADY been switched to \<target\> (commit
  > \<targetCommit\>) and verified, but recording state failed (\<error\>).
  > state.json still names \<oldColor or "none"\>. DO NOT run another
  > deploy until state is corrected: write { activeColor: '\<target\>',
  > commit: '\<targetCommit\>' } manually or fix the underlying filesystem
  > issue and re-run 'status'.

  Rollback has the exact same guard on its own post-verification state
  write, naming `previousColor`/`previousCommit` instead.
- **Starting the scheduler on the new tag fails, or stopping the old
  colour fails** (both *after* cutover and state are already recorded) —
  traffic is serving the new colour and state is correct; only job
  restart / old-colour retirement is incomplete. Inspect with `status`,
  re-run the missing step by hand, or `rollback`.
- **The cutover lock itself fails to release** — every one of the above
  paths, and any unexpected error, releases the lock in a `finally`-style
  step; if *that itself* throws, the engine says so explicitly and refuses
  to imply anything else succeeded: "Do not start another deploy or
  rollback until the lock owner and runtime state are reconciled."
- **`unknownApplied` migrations** (the live database already has migrations
  this release's checkout doesn't contain) are a loud **warning**, never
  an abort — expected during a rollback-style deploy, where the release
  being deployed is older than the database.

## Rollback

```bash
npm run bluegreen:rollback -- --env-file /path/to/bluegreen.env
```

Verifies the previous colour's containers still exist, brings them up and
waits for them to report healthy (mirrors deploy's own up-before-switch
ordering — traffic must never point at an unconfirmed colour), THEN
switches Caddy back to them (validate → reload, same restore-on-failure as
deploy), starts the scheduler on the previous commit, and re-verifies the
front door reports the previous commit before recording the rollback. A
verification mismatch or a failed smoke command leaves `state.json`
**unflipped** and logs a `rollback-uncertain` status entry naming the
observed vs. expected commit — the operator must inspect manually rather
than trust either state.

**Rollback is refused outright** when:
- there is no recorded state, or it's corrupt;
- the current deploy used `--allow-destructive-migration`
  (`rollbackable: false`) — see below;
- no previous colour/commit is recorded (nothing to roll back to);
- the previous colour's containers are gone (pruned).

## The destructive-migration override, and its cost

```bash
npm run bluegreen:deploy -- --env-file <path> --allow-destructive-migration
```

`scripts/bluegreen/migration-gate.mjs` blocks a pending migration matching
a destructive-class pattern (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`,
`RENAME TABLE`/`RENAME COLUMN`, an `ALTER COLUMN ... TYPE`/`SET DATA TYPE`,
or `SET NOT NULL`) by default. `--allow-destructive-migration` flips the
gate's `ok` to `true` but does **not** clear the blocked list — the same
findings are recorded verbatim in `overridden`, so what was permitted is
always visible after the fact in the `gate` status-history entry.

**The cost:** a deploy that used the override is recorded with
`rollbackable: false`. There is no one-command rollback afterward — the
old colour's schema is no longer compatible with data the destructive
migration already changed. Recovery is **restore from backup**
(`restore-drill` proves the mechanism; an actual restore is a manual,
deliberate operation, not a subcommand this engine exposes). Only pass
this flag after confirming the old colour genuinely tolerates the change,
or accepting that recovery means restoring data, not flipping a switch.

## Backup and restore-drill

`npm run bluegreen:backup -- --env-file <path>` runs standalone (outside a
deploy) and takes a live row census, a `pg_dump -Fc` of the compose `db`
service, a tar of the documents volume, and a sha256 manifest of every
artifact — to a dated directory under the state directory's `backups/`,
then prunes anything older than 14 days. A deploy runs this same backup
automatically at phase 2, before migrations, unless `--skip-backup` is
passed (refused under `NODE_ENV=production`, see Preconditions).

`npm run bluegreen:restore-drill -- --env-file <path>` restores the
**most recent** backup into a throwaway, network-isolated scratch
container — never `docker compose`, never the live `db` service or its
container-name family, never a connection string whose host is `db` — and
proves two things: the restored row census matches the manifest's
recorded census, and every manifested file (the dump, the documents tar,
and every extracted document) re-hashes clean. It fails loudly and tears
the scratch container down either way, capturing `docker logs` first on
any failure for diagnostics.

**The row-census race, honestly stated:** in this engine's phase order,
backup runs *before* the deploy quiesces the scheduler/job singletons —
the app is still live-serving writes while the backup runs. The row
census is taken immediately before `pg_dump` to keep that window as small
as possible, but it is a **near-in-time reference, never a
same-transaction snapshot**. `restore-drill`'s comparison against that
census is **exact (zero tolerance) by default**. Set
`BLUEGREEN_DRILL_CENSUS_TOLERANCE` (a non-negative integer, "rows per
table" allowance, read from the env file) only when the backup being
drilled is *known* to have been taken while the app was live-serving —
widen it deliberately, per-invocation, never as a new silent default.
Leave it at `0` for a backup taken while genuinely quiesced (e.g. a manual
pre-maintenance backup).

**Retention:** 14 days, pruned after every deploy and after every
standalone `backup` call. Best-effort — a pruning failure never aborts a
completed deploy or backup.

## The nightly cron (not yet wired)

The VM's nightly backup, once P3 wires it up, will invoke this same
`bluegreen:backup` subcommand — not a separate backup mechanism. **This
repo does not wire that cron yet**; P3 (the actual VM cutover project) owns
provisioning it, alongside disabling the appliance's own backup cron. Until
then, run `bluegreen:backup` manually, or via whatever scheduler the
deployment target already uses, pointed at this same command.

<!-- Task 10 acceptance-run marker (2026-09-01): trivial docs touch used as
     the Step-2 redeploy commit for the local acceptance cycle's blue->green
     cutover proof. Safe to keep or drop. -->

<!-- Task 10 acceptance-run-3 marker (2026-09-01): trivial docs touch used as
     the Step-2 redeploy commit for the local acceptance cycle's blue->green
     cutover proof, run after the Caddy admin-socket fix. Safe to keep or drop. -->
