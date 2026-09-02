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

**Scope note, stated plainly:** everything here is proven against
`docker compose` and a scratch Postgres locally (`scripts/bluegreen-deploy.test.mjs`,
`scripts/bluegreen/*.test.mjs`) and by a local acceptance cycle. The private
Hyper-V VM's cutover from the appliance to this engine is the operational
project in `docs/superpowers/plans/2026-09-02-private-vm-bluegreen-cutover.md`
(Task 8); its "Cutting the private VM over" section below is the operator
sequence, and its evidence is recorded in that plan's task report once run.
Until that report exists, this engine has not run against a real VM.

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
- **`DATABASE_URL`'s `sslmode=verify-full&target_session_attrs=read-write`
  on the private VM is cosmetic, not encryption.** Both query parameters
  exist only because `apps/api/src/utils/env.ts`'s `requireDatabaseUrl`
  demands them for any non-localhost `DATABASE_URL` host — `db` (the
  compose service name) included, since that check draws no exception for
  a same-host Docker network hop. `@prisma/client` 6 recognises only
  `prefer|disable|require` for `sslmode`; it silently downgrades
  `verify-full` to `prefer` and never upgrades to TLS against a server with
  `ssl=off` — so the actual connection to the compose `db` service is
  **plaintext**. That is acceptable only because `db` is reachable solely
  on the compose-internal network and is never published on the host.
  **Never** change it to `sslmode=require`: Prisma honours that value, and
  it fails outright against the plain `db` container. Verified empirically
  2026-09-02 against `postgres:16.4-alpine` with `@prisma/client` 6.19.3.
  `.env.bluegreen.private-vm.example` carries this same note.
- **Canonical-origin axis vars**, when the deployment's `FRONTEND_URL` is
  not a `charitypilot.ie` hostname (e.g. a Tailscale Serve origin):
  `CHARITYPILOT_CANONICAL_WEB_ORIGIN` and `CHARITYPILOT_CANONICAL_API_ORIGIN`
  are both required, or preflight refuses to start. Both must be an
  **exact `https://` origin** — no path, no trailing slash, no
  credentials (preflight now validates the shape, not just presence; the
  same rule `apps/api/src/utils/env.ts` enforces at container boot) —
  UNLESS `BLUEGREEN_ORIGIN` itself is an exact loopback origin
  (`localhost`/`127.0.0.1`/`::1`), which marks the whole deployment as
  local/scratch: in that case both vars may ALSO independently be an
  exact loopback `http://` origin (each just has to be loopback itself —
  preflight does not require it to equal `BLUEGREEN_ORIGIN`'s own
  hostname/port, though in practice it usually should, for the deployment
  to actually work end-to-end). This mirrors the web app's OWN build-time
  override
  (`NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN`, baked in from
  `BLUEGREEN_ORIGIN` above), which has always accepted exact loopback
  `http://` for local acceptance testing — the two vars now agree for a
  loopback `BLUEGREEN_ORIGIN`; for anything else, these two stay
  https-only. See
  `docs/superpowers/specs/2026-08-31-deployment-profile-and-bluegreen-design.md`'s
  "Named prerequisite" section for how these two vars (plus
  `CHARITYPILOT_ERROR_ALERTS=none` to drop the public-webhook requirement)
  unblock a non-hosted deployment target.
- **`AUTH_COOKIE_DOMAIN`**, for the same non-hosted deployment: set it to
  the deployment's own hostname itself (e.g. the Tailscale hostname,
  `vm.tailnet.example`) — **not** a parent domain, even a real one you
  don't fully control (e.g. Tailscale's own shared `.ts.net`). Only a
  split web/api deployment with two DIFFERENT canonical-origin hostnames
  needs a shared parent instead (one with a dot, covering both, per
  `apps/api/src/utils/env.ts`'s validation) — the single-hostname case
  this bullet is about should always use the exact hostname.
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
- **Preflight refuses because another stack holds one of this deployment's
  volumes.** Before anything runs, the engine lists the containers currently
  mounting each volume it is about to use (the `db` volume and the documents
  volume, resolved from `compose.bluegreen.yml` plus
  `BLUEGREEN_COMPOSE_OVERRIDE`/`BLUEGREEN_DOCUMENTS_VOLUME`) and refuses if
  any container outside its own compose project (`charitypilot-bluegreen`)
  is running on one. Verbatim:

  > Refusing to deploy: volume charitypilot-personal-server-db is in use by
  > container(s) charitypilot-personal-server-db-1 from another stack; stop
  > that stack first (a second Postgres on one data directory risks
  > corruption).

  Nothing was touched. Stop the named stack (for the appliance:
  `docker compose --project-name charitypilot-personal-server … down`, never
  `-v`) and re-run. If the engine cannot get an answer at all it says
  "Could not determine whether volume … is already in use" and still
  refuses — it never assumes a volume is free.
- **Migration gate blocks** — the deploy aborts *before quiesce*; nothing
  was touched at all (no container stopped, no lock left held).
- **Any failure between `ensure-db` and the Caddy switch leaves no `db`
  running that the deploy itself started.** `ensure-db` first asks
  `docker compose ps --status running -q db` whether the db was ALREADY
  running. If it was not — a first deploy, or any host where the stack was
  `down` — then every failure return from the backup through the switch
  (backup, gate block, migration, `up`, candidate smoke, Caddy start, Caddy
  reload, and any unexpected error) stops it again and says so:

  > … The db service this deploy started has been stopped again.

  If the stop itself fails, the engine says THAT instead, and never implies
  the db is down:

  > … The db service this deploy started could NOT be stopped (\<error\>)
  > and is STILL RUNNING on this deployment's volumes: stop it by hand
  > (docker compose … stop db) before starting any other stack on these
  > volumes.

  A db that was already running when the deploy began is never stopped (an
  aborted redeploy must not take the site down), and once the switch has
  succeeded the db legitimately stays up — nothing after cutover touches it.
  This is the defect that nearly cost the first VM cutover its data: the
  deploy aborted at phase 2, its `db` stayed attached to the appliance's
  production `PGDATA`, and restoring appliance service then ran a SECOND
  postmaster on the same data directory for ~83 seconds.
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

## Cutting the private VM over from the appliance

**Not yet executed.** This is the operator sequence for the cutover; record
evidence in `docs/superpowers/plans/2026-09-02-private-vm-bluegreen-cutover-report.md`
as you run it, then date this line. Kept here because it is also the recovery
sequence if the VM must ever be re-provisioned through the appliance installer
and then brought back onto the engine.

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
ssh -i $KEY $VM "docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' \$(docker network ls -q)"
```
Gate: no existing network uses `172.31.250.0/24` (`compose.bluegreen.private-vm.yml` pins the engine's internal network to it, and Docker's default address pool `172.17.0.0/12` can hand out addresses that reach `172.31.x`). If something already holds it, stop and change the pinned subnet in the override plus `TRUSTED_PROXY_ADDRESSES` in the env file together.

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
$SHA = "<paste the short sha of the master commit you deployed from>"
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

**GATE — if the deploy failed, run this BEFORE restoring appliance service.**
Never start the appliance while a blue-green container still holds the same
volumes: two postmasters on one `PGDATA` is a corruption risk (it happened on
the first cutover attempt — they overlapped ~83 seconds, and Postgres logged
`database system was not properly shut down; automatic recovery in progress`
followed by `performing immediate shutdown because data directory lock file is
invalid`).

```powershell
ssh -i $KEY $VM "docker ps -a --format '{{.Names}}' | grep charitypilot-bluegreen"
```
Gate: **no output.** Anything listed must be stopped and removed before the
appliance is started:
```powershell
ssh -i $KEY $VM "cd ~/charity-governance && docker compose -f compose.bluegreen.yml -f compose.bluegreen.private-vm.yml -p charitypilot-bluegreen down && docker ps -a --format '{{.Names}}' | grep charitypilot-bluegreen"
```
(No `-v`. Ever — the volumes are the appliance's data, and the override marks
them `external`.) Re-run the `docker ps -a` gate until it prints nothing, and
only then bring the appliance back up. The engine now stops a `db` it started
itself on every pre-switch failure and says so in its own failure message, and
its preflight refuses to deploy onto volumes another stack still holds — this
gate is the belt-and-braces check that both actually happened on this host.

- [ ] **Step 5: Bootstrap the platform operator (DOWNTIME ENDS at the start of this step — the site is already serving).**

```powershell
# Sourcing the env file here would background the assignment at the "&" in
# DATABASE_URL's query string ("?sslmode=verify-full&target_session_attrs=..."),
# so export exactly the three interpolation vars compose needs instead.
ssh -i $KEY $VM "cd ~/charity-governance && TAG=\$(git rev-parse HEAD) && export BLUEGREEN_ENV_FILE=\$HOME/charity-governance/.bluegreen/private-vm.env BLUEGREEN_ORIGIN=\$(grep -E '^BLUEGREEN_ORIGIN=' \$HOME/charity-governance/.bluegreen/private-vm.env | cut -d= -f2-) BLUEGREEN_FRONT_PORT=8080 && BLUEGREEN_BLUE_TAG=\$TAG BLUEGREEN_GREEN_TAG=unbuilt BLUEGREEN_ACTIVE_TAG=\$TAG docker compose -f compose.bluegreen.yml -f compose.bluegreen.private-vm.yml -p charitypilot-bluegreen --profile blue run --rm --no-deps api-blue node dist/jobs/create-platform-operator.js --email=jasper@hour-timebank.ie --name='Jasper Ford'"
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

Update `D:\CharityPilot-VM\provision\RUNBOOK.md`: §1 row "Installed commit" → "Blue-green engine; active colour/commit via `npm run bluegreen:status -- --env-file .bluegreen/private-vm.env`"; row "Nightly backup" → "`~/bin/bluegreen-nightly-backup.sh`, sets under `~/charity-governance/.bluegreen/state/backups/`"; §3 → a new lead paragraph "**Deploy = `git pull --ff-only && npm run bluegreen:deploy -- --env-file .bluegreen/private-vm.env`. See `docs/bluegreen-runbook.md`.**" with Options A–D retitled "History — appliance era (retired on the cutover date)".

Update the agent memory `charitypilot-deploy-procedure.md`: replace "The deploy decision, in one place" with the blue-green command; keep the access/traps sections; mark Option D as history; note the appliance archive path and that `bluegreen:rollback` and `restore-drill` were proven on the host on the cutover date.

Flip the status banners in `docs/hyperv-private-server-deployment.md` (both sections) and date the "Not yet executed" line + the two "the cutover date" placeholders in `docs/bluegreen-runbook.md`.

Finish the report file with: timestamps per step, every gate's output, the operator id and test-tenant id, the two commits deployed in step 8, and the deploy/rollback wall-clock times. Commit the report and the runbook marker:
```bash
git add docs/superpowers/plans/2026-09-02-private-vm-bluegreen-cutover-report.md docs/bluegreen-runbook.md
git commit -m "docs(deploy): private VM cutover to blue-green — executed <date>, evidence report"
git push origin master
```

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

<!-- Task 10 acceptance-run marker (2026-09-01): trivial docs touch used as
     the Step-2 redeploy commit for the local acceptance cycle's blue->green
     cutover proof. Safe to keep or drop. -->

<!-- Task 10 acceptance-run-3 marker (2026-09-01): trivial docs touch used as
     the Step-2 redeploy commit for the local acceptance cycle's blue->green
     cutover proof, run after the Caddy admin-socket fix. Safe to keep or drop. -->
