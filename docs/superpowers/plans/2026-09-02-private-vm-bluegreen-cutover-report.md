# Private VM Cutover to Blue-Green (P3, Task 8) — Evidence Report

Plan: `docs/superpowers/plans/2026-09-02-private-vm-bluegreen-cutover.md` (Task 8).
Operator sequence: `docs/bluegreen-runbook.md` → "Cutting the private VM over from the appliance".
Executed from master `ca02055` (pushed to origin 2026-09-02).

Recording convention: one section per step; every gate's actual output pasted verbatim (secrets redacted); timestamps in local time (Europe/Dublin).

## Pre-conditions

- E2E run 33626756710 on `ca02055`: **success** (job `e2e`). CI run 33626756704: **success** (job `verify`). Both green before step 0 began.
- Deviation from the runbook, agreed with the owner before starting: the blue images are pre-built (`docker compose … --profile blue build`) BEFORE the appliance is stopped, so the outage window is db start + migrations + container start rather than the full image build. Recorded under step 4.

## Pre-step-0 reconnaissance (read-only, while CI ran)

- SSH from Windows Git Bash with `D:\CharityPilot-VM\secrets\charitypilot-server_ed25519` to `cpops@charitypilot.local` works (`SSH_OK`, host `charitypilot`, up 2 days 10:53).
- **Discrepancy vs the private RUNBOOK §1 ("Installed commit 8bd3f78"):** the VM's checkout HEAD is `e136cf9` ("fix: keep the Team route under the oversized-route gate", 2026-08-30), `install-state.json` revision `e136cf93ee…` — they agree with each other, `phase: ready`, porcelain 0, remote = GitHub. `e136cf9` is an ancestor of master and predates the blue-green engine (P2 merged 2026-09-01) — so `scripts/bluegreen-deploy.mjs`, `compose.bluegreen.yml` and the override do not exist in the appliance checkout until step 4's `git reset --hard origin/master`. Ruling: step 0's "HEAD is the appliance commit" gate is satisfied by `e136cf9` (it matches install-state exactly); RUNBOOK §1 is corrected in step 9. `compose.personal-server.yml` is byte-identical between `e136cf9` and master.
- Appliance containers up and healthy (caddy/web/api 9 h, db 2 d). No `.bluegreen/` on the VM yet (expected).
- **Migrations pending on the VM are 4, not 5** (the runbook counted from `8bd3f78`): `20260830201131_add_platform_operator`, `20260831000000/000100/000200_add_owner_provisioned_recovery_*`. Destructive-pattern scan: none. Step 0's `_prisma_migrations` gate therefore expects **+4** after step 4.
- **The appliance env file is CRLF** (16/16 lines carry `\r`, mode 600). Key names present: `AUTH_RECOVERY_SECRET, CHARITYPILOT_PERSONAL_SERVER_{IMAGE_TAG,ORIGIN,PORT}, JWT_EXPIRY, JWT_SECRET, PERSONAL_SERVER_{ORGANISATION_NAME,OWNER_EMAIL,OWNER_NAME}, POSTGRES_{DB,PASSWORD,USER}, READINESS_API_KEY, REFRESH_TOKEN_TTL_DAYS`. With `\r` stripped: `POSTGRES_PASSWORD` is 64 hex chars (URL-safe, no percent-encoding needed); `JWT_SECRET` 68, `AUTH_RECOVERY_SECRET` 64, `READINESS_API_KEY` 74 — all URL-safe; origin is `https://…` (38 chars); `POSTGRES_DB`/`POSTGRES_USER` are 28 chars (= `charitypilot_personal_server`). **Runbook amendment for step 3:** the generator's `get()` adds `| tr -d '\r'` so no carriage return leaks into the engine env file or `DATABASE_URL`. No values were displayed at any point.

- VM tooling (read-only): node `v22.23.2` (engines `>=22.0.0` ✓), npm 11.11.0, Docker 29.7.2, **Docker Compose v5.5.0** (multi-`-f`, `--project-directory`, profiles ✓), git 2.43.0 (worktrees ✓), OpenSSL 3.0.13 (`openssl rand` for `OWNER_JWT_SECRET` ✓), `wget`/`git`/`openssl` on PATH ✓. Root filesystem 55 GiB free; 7 GiB RAM / 6 GiB available; Docker build cache 8.4 GB (6.9 GB reclaimable) — headroom for two colours of images is ample.

## Owner-run blocks, prepared in advance

**Step 2 — Hyper-V checkpoint (ELEVATED Windows PowerShell; Hyper-V cmdlets only, no ssh from this shell):**
```powershell
$SHA = "ca02055"
Stop-VM -Name charitypilot-server
Checkpoint-VM -Name charitypilot-server -SnapshotName "pre-bluegreen-$SHA"
Start-VM -Name charitypilot-server
Get-VMSnapshot -VMName charitypilot-server | Select-Object Name, CreationTime
```

**Step 3 — engine env file generator (paste into an interactive `ssh` session ON the VM; amended from the runbook with `tr -d '\r'` because the appliance env is CRLF):**
```bash
set -euo pipefail
cd ~/charity-governance && git fetch origin master
SRC=$HOME/.local/share/charitypilot/personal-server/.env.personal-server
DST=$HOME/charity-governance/.bluegreen/private-vm.env
TEMPLATE=$(git show origin/master:.env.bluegreen.private-vm.example)
get() { grep -E "^$1=" "$SRC" | head -1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
ORIGIN=$(get CHARITYPILOT_PERSONAL_SERVER_ORIGIN); HOST=${ORIGIN#https://}
[ -n "$HOST" ] && [ "$HOST" != "$ORIGIN" ] || { echo "appliance origin is not https: $ORIGIN"; exit 1; }
get POSTGRES_PASSWORD | grep -qE '^[0-9a-f]+$' || { echo "POSTGRES_PASSWORD is not URL-safe hex; stop and percent-encode by hand"; exit 1; }
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
grep -c $'\r' "$DST" || echo "OK: LF only"
grep -E '^(BLUEGREEN_ORIGIN|FRONTEND_URL|AUTH_COOKIE_DOMAIN|POSTGRES_DB|POSTGRES_USER|BLUEGREEN_COMPOSE_OVERRIDE|BLUEGREEN_DOCUMENTS_VOLUME)=' "$DST"
```
Gate: `OK: no placeholders left`, `OK: LF only`, and the seven non-secret lines show the Tailscale hostname, `charitypilot_personal_server` ×2, the override filename, and the documents volume name.

## Agreed deviation — pre-build before the outage (between steps 3 and 4)

The appliance checkout (`e136cf9`) predates the engine, so the pre-build uses the compose files from a master worktree created exactly where the engine will look for it (`releaseDirFor` = `.bluegreen/state/releases/<sha>`; the engine's phase 4 reuses a worktree whose HEAD matches, and phase 5's build then hits the Docker cache):

```bash
cd ~/charity-governance && git fetch origin master && SHA=$(git rev-parse origin/master) \
 && mkdir -p .bluegreen/state/releases && git worktree add .bluegreen/state/releases/$SHA $SHA \
 && W=$PWD/.bluegreen/state/releases/$SHA \
 && export BLUEGREEN_ENV_FILE=$HOME/charity-governance/.bluegreen/private-vm.env \
    BLUEGREEN_ORIGIN=$(grep -E '^BLUEGREEN_ORIGIN=' $HOME/charity-governance/.bluegreen/private-vm.env | cut -d= -f2-) \
    BLUEGREEN_FRONT_PORT=8080 BLUEGREEN_BLUE_TAG=$SHA BLUEGREEN_GREEN_TAG=unbuilt BLUEGREEN_ACTIVE_TAG=$SHA \
 && docker compose -f $W/compose.bluegreen.yml -f $W/compose.bluegreen.private-vm.yml -p charitypilot-bluegreen --project-directory $W --profile blue build
```
Gate: `docker image ls --format '{{.Repository}}:{{.Tag}}' | grep charitypilot-bluegreen` lists `-api`, `-web`, `-migrations` at `<sha>`. The appliance keeps serving throughout.

## Step 0 — Pre-checks (read-only) — 2026-09-02 ~13:00 local — ALL GATES PASS

```
HEAD=e136cf93ee579e01e19ae16b32027e9062166020     (= install-state revision; the appliance commit)
remote=https://github.com/jasperfordesq-ai/charity-governance.git
porcelain=0
=== tailscale serve status ===
https://charitypilot.tailae0b07.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8080                   (exactly one 443 listener → 8080; Serve is NOT touched by the cutover)
=== volumes ===
charitypilot-personal-server-db
charitypilot-personal-server-documents
=== network subnets in use ===
bridge: 172.17.0.0/16
charitypilot-personal-server-edge: 172.30.251.0/24
charitypilot-personal-server-internal: 172.30.250.0/24   (no 172.31.250.0/24 → override subnet is free)
=== row counts ===
Organisation=1  User=2  Document=51  _prisma_migrations=25   (expect _prisma_migrations=29 after step 4: +4 pending, none destructive)
=== readiness via Tailscale origin, from the VM host ===
{"status":"ready","checks":{"database":true,"authRecoveryControlReady":true,"billingConfigured":false,"emailConfigured":false,"storageConfigured":true,"storageBucketReachable":true},"timestamp":"2026-09-02T12:01:00.259Z"}
```
Tooling/disk/memory: see "VM tooling" above (node v22.23.2, Compose v5.5.0, 55 GiB free).

## Step 1 — Final appliance backup, plaintext fingerprints, copy off-VM — ~13:02 local — GATES PASS

```
bash ~/bin/charitypilot-backup.sh → backup_exit=0
Verified recovery set: ~/.local/share/charitypilot/personal-server/recovery/personal-server-2026-09-02T12-01-39-687Z-33a11349
2026-09-02 13:02:03  OK: backup verified. newest=…/personal-server-2026-09-02T12-01-39-687Z-33a11349/ total_sets=6 free=55GiB
set contents: database.dump.enc database.restore-proof.json documents.tar.enc manifest.hmac-sha256 manifest.json manifest.sha256 (8.9M)
```
Plaintext fingerprints (`~/precutover/`): `documents.sha256` = **51 lines**; files in the volume = **51**; `Document` rows = **51** → gate met exactly. `documents.err` contained only `Status: Downloaded newer image for alpine:3.20`. Volume size 8.4M; zero zero-byte files. `census.txt` = 38 tables (`Organisation=1 User=2 Document=51 _prisma_migrations=25`; no `PlatformOperator` yet).
Off-VM copies under `D:\CharityPilot-VM\backups\pre-bluegreen\`: `precutover/` (documents.sha256 51 lines, census.txt 38 lines) and the recovery set `personal-server-2026-09-02T12-01-39-687Z-33a11349/` (6 files, 8.9M; local `sha256sum -c manifest.sha256` → `manifest.json: OK`). Step 1 complete at ~13:03.

## Step 2 — Hyper-V checkpoint (operator, elevated PowerShell) — 13:04 local — GATE PASS

Owner ran `Stop-VM` → `Checkpoint-VM -SnapshotName pre-bluegreen-ca02055` → `Start-VM`. `Get-VMSnapshot` output:
```
Name                  CreationTime
pre-deploy-e136cf9    30/08/2026 18:52:02     ← pre-existing, never deleted after the 30/08 Option-D deploy; remove in step 9 with the owner's go
pre-bluegreen-ca02055 02/09/2026 13:04:34     ← this cutover's whole-cutover rollback
```
Rollback from here to the end of step 8: `Restore-VMSnapshot -Name "pre-bluegreen-ca02055" -VMName charitypilot-server -Confirm:$false`.
Guest-back check at 13:05:27 — `up 0 min`; `charitypilot-personal-server-{api,caddy,db,web}-1 Up 47 seconds (healthy)`. Gate met; the appliance is serving again exactly as before the checkpoint.

## Step 3 — Engine env file generated ON the VM (operator)

Pre-build part 1 done first (no dependency on the env file), 13:06: `git fetch origin master` → `origin/master=ca02055249597a3c7326079437eabbffb2c27531`; template visible via `git show origin/master:.env.bluegreen.private-vm.example` (16 placeholder lines); release worktree created at `.bluegreen/state/releases/ca02055249597a3c7326079437eabbffb2c27531` (HEAD `ca02055`; both compose files present). Main checkout untouched at `e136cf9`. `porcelain=1` there is expected: `.bluegreen/` is untracked under the OLD `.gitignore` at `e136cf9` (master's `.gitignore` ignores it; `git reset --hard` never removes untracked directories; the engine's clean-tree preflight runs after the reset).

13:08 — the owner pasted the bash block into the ELEVATED Windows PowerShell instead of an ssh session on the VM: every line failed on Windows (bash syntax / missing coreutils); nothing reached the VM and no file was created anywhere (verified: no `.bluegreen/private-vm.env`; `.bluegreen/` holds only `state/`). To remove the interactive-session step, the agent placed the generator on the VM as `~/generate-bluegreen-env.sh` (mode 700, LF, `bash -n` clean, 34 lines; it contains NO secret values — it reads them on the VM at run time and prints only non-secret gate lines), so step 3 is one command from a normal Windows PowerShell:
`ssh -i D:\CharityPilot-VM\secrets\charitypilot-server_ed25519 cpops@charitypilot.local "bash ~/generate-bluegreen-env.sh"`
13:10 — the owner's attempt failed before reaching the VM (`ssh` not found: the elevated PowerShell is the 32-bit shell — the known trap). Ruling: the agent runs the generator itself — with the script on the VM, no secret passes through the agent or the conversation, which was the only reason this step had been the operator's. Output (non-secret gate lines only):
```
placeholders_left=0
cr_bytes=0
mode=600
BLUEGREEN_ORIGIN=https://charitypilot.tailae0b07.ts.net
BLUEGREEN_COMPOSE_OVERRIDE=compose.bluegreen.private-vm.yml
BLUEGREEN_DOCUMENTS_VOLUME=charitypilot-personal-server-documents
POSTGRES_DB=charitypilot_personal_server
POSTGRES_USER=charitypilot_personal_server
FRONTEND_URL=https://charitypilot.tailae0b07.ts.net
AUTH_COOKIE_DOMAIN=charitypilot.tailae0b07.ts.net
generator_exit=0
=== engine preflight dry-check (scripts/bluegreen-deploy.mjs from the master worktree) ===
preflight clean
preflight_exit=0
```
Step 3 complete. GATE PASS.

## Pre-build (agreed deviation) — blue images built before the outage

(in progress — `~/precutover/prebuild.sh` under nohup, log `~/precutover/prebuild.log`)
Pre-build complete `PREBUILD_EXIT=0` (13:12:52 → ~13:18): `charitypilot-bluegreen-{web:941MB, api:547MB, migrations:409MB}` at `ca02055…`. Appliance served throughout.

## Step 4 — FIRST ATTEMPT FAILED AND WAS ROLLED BACK (13:19:08 → 13:23:01, outage 3m53s)

Sequence (all from a detached script on the VM, `~/precutover/step4.log`):
```
T_STOP_START=13:19:08   appliance `compose down` (no -v)  → STOP_EXIT=0, containers_now=0, personal_server_volumes=2
                        git reset --hard origin/master     → HEAD=ca02055…, porcelain=0
T_DEPLOY_START=13:19:09 npm run bluegreen:deploy -- --env-file .bluegreen/private-vm.env
Blue-green deploy failed: pre-migration backup failed: docker run --rm --network none --read-only
  --cap-drop ALL --security-opt no-new-privileges=true
  --mount type=volume,src=charitypilot-personal-server-documents,dst=/documents,readonly
  [redacted-credentials]@sha256:d9e853… tar -cf - -C /documents . failed with exit code 1:
  tar: can't change directory to '/documents': Permission denied
DEPLOY_EXIT=1  T_DEPLOY_END=13:19:16
```
Status history: `preflight → ensure-db → backup`. No `state.json` written — the engine aborted before taking ownership, exactly as designed. Nothing migrated, no traffic switched, no volume touched.

### DEFECT 1 (engine, blocks the cutover): documents tar/hash containers run without `--user`
The appliance's documents volume root is `0700` owned by uid 1000 (`compose.personal-server.yml`'s
`install -d -o 1000 -g 1000 -m 0700 /data/documents`). `scripts/bluegreen/backup.mjs`'s
`documentsTarCommand` / per-file hash container pass no `--user`, so they run as the image's default
user and cannot enter the directory. Invisible in the P2 acceptance because the scratch
`charitypilot-bluegreen-documents` volume was created with a root-owned root directory.

### DEFECT 2 (engine, DATA-INTEGRITY, introduced by this plan's Task 3): a failed deploy leaves `db` running
`ensure-db` starts the `db` service before the backup, and no failure path stops it. With the private-VM
override that container is a **live postmaster on the appliance's production PGDATA**. It stayed up
(`restart: unless-stopped`) after the abort; restoring appliance service then started a **second**
postmaster on the same data directory. Appliance postgres log (UTC):
```
12:19:10  (bluegreen postgres had the directory; control file "last known up at")
12:22:19  appliance db: database system was interrupted; last known up at 12:19:10
12:22:20  appliance db: database system was not properly shut down; automatic recovery in progress
12:22:20  appliance db: database system is ready to accept connections     ← two postmasters live
12:24:20  appliance db: performing immediate shutdown because data directory lock file is invalid
12:24:20  appliance db: database system was shut down at 12:23:43 UTC; ready to accept connections
```
Concurrency window ≈ 83 s (12:22:20 → 12:23:43). The blue-green instance had **no clients** (nothing was
brought up on its network), so its only writes were background checkpointer/stats activity.

### Integrity verification after the incident — NO DETECTABLE DAMAGE
- Row census, 38 tables: **identical** to the 13:02 pre-cutover baseline (`diff` clean).
- `pg_dump -Fc` of the whole database: **exit 0**, 395,756 bytes — every heap page of every table read.
- `amcheck` `bt_index_check` over **all 156 persistent public btree indexes**: `btree_indexes_failing=0`
  (verifies index structure and index↔heap agreement).
- Documents: **51/51 sha256 identical** to the 13:02 fingerprints.
- No `FATAL` / `PANIC` / `corrupt` anywhere in the postgres log.

### State after rollback (13:23:01)
Checkout re-pinned to the install revision `e136cf9` (so `personal:server:restore` stays valid);
appliance stack up and healthy; readiness through the Tailscale origin `{"status":"ready",…}`;
`charitypilot-bluegreen-db-1` stopped and removed; no blue-green containers or volumes remain
(one empty `charitypilot-bluegreen-internal` network, harmless); `pre-bluegreen-ca02055` checkpoint intact.

## Attempt 2 — FAILED AND ROLLED BACK (14:14:31 → 14:22:22, outage 7m51s)

Fixes merged as `707a446` first (documents `--user 1000:1000`; deploy never leaves a db it started;
preflight refuses volumes another stack holds; preflight refuses a documents-volume name that
disagrees with the compose declaration). Full suite on `707a446`: exit 0, 4/4 turbo tasks, 0 failures.
Images rebuilt for the new SHA before the outage (`BUILD_EXIT=0`, appliance serving throughout).
Pure preflight dry-check against the new engine: `preflight clean`.

```
T_STOP_START=14:14:31  STOP_EXIT=0 containers_now=0 personal_server_volumes=2
HEAD=707a446053a7d1b23a7636a8b54d11c92375b3ff porcelain=0
T_DEPLOY_START=14:14:32
Blue-green deploy failed: pre-migration backup failed: docker run … --user 1000:1000
  --mount type=volume,src=charitypilot-personal-server-documents,dst=/documents,readonly
  <image> tar -cf - -C /documents . failed with exit code unknown.
  The db service this deploy started has been stopped again.
DEPLOY_EXIT=1  T_DEPLOY_END=14:14:39
=== containers ===            (empty)
```
**The Defect-2 fix worked**: the message names the stop, `docker ps` was empty, and the postgres log
after the restore shows only `database system is ready to accept connections` — no
`not properly shut down`, no lock-file conflict, no concurrent postmaster. Status history:
`preflight → ensure-db → backup`; no `state.json`.

### DEFECT 3 (engine): `spawnSync` without `maxBuffer` — Node's 1 MiB cap kills any real backup
`defaultRunCommand` in `scripts/bluegreen-deploy.mjs` never sets `maxBuffer`, so a command whose
stdout exceeds 1 MiB is killed and returns `status: null` with `error.code === 'ENOBUFS'` — and the
engine's message reads only `status`/`stderr`, hence the useless `failed with exit code unknown`.
Proven on the VM:
```
documents_tar_bytes= 8779776
spawnSync('head',['-c','3000000','/dev/urandom'])                → status=null err=ENOBUFS stdout_bytes=1064960
spawnSync(… , {maxBuffer: 64*1024*1024})                          → status=0            stdout_bytes=3000000
```
The documents volume root is `drwx------ 1000 1000`, so `--user 1000:1000` was correct — this failure
is purely output size. The P2 acceptance passed because its seeded document set was a few KB. The same
cap sits under `pg_dump` (dump is 395 KB today — it would break silently as the database grows) and
under every captured-stdout probe (row census, per-file hash listings).

### Integrity after attempt 2 — clean, and no concurrency occurred
Census identical to the 13:02 baseline; documents 51/51 sha256 identical; postgres log shows a single
clean start. No restore needed.

### Process failure of mine, recorded
The restore was delayed ~4 minutes because I ran the new leftovers gate (`docker ps | grep …`) and the
restore launch in one SSH command; the gate hung and the launch never fired. **Restore service first,
in its own command, then run diagnostic gates.** Outage 2 was 7m51s instead of ~3m for this reason.

### Pre-attempt-3 gate added (was missing before attempts 1 and 2)
`~/precutover/rehearse-backup.sh` on the VM: clones both volumes (`cp -a`, ownership preserved),
points a rehearsal override + env at the clones, brings up only `db`, then runs `bluegreen:backup`
and `bluegreen:restore-drill` against them with a separate state dir — exercising the tar of the real
8.4 MB document set, the real `pg_dump`, and the drill's non-degenerate census and per-file hashes,
with the appliance serving and zero production risk. Teardown is a trap-on-EXIT that removes the
clone volumes and verifies no blue-green containers remain.

## Pre-attempt-3 rehearsal against CLONES of the real volumes — PASSED (14:35:54 → 14:36:07)

Ran the FIXED engine (`fix/bluegreen-output-buffering` @ `384e409`) straight from a git worktree — no
merge, master untouched, appliance serving throughout. Clones made with `cp -a` as root so ownership
survived: clone documents root `drwx------ 1000 1000`, 51 files (identical shape to production).

```
=== 4. bluegreen:backup against the clones (THE FAILING PATH) ===
Backup created at …/rehearsal-state/backups/2026-09-02T13-36-01-910Z
BACKUP_EXIT=0
-rw------- 395989   database.dump
-rw------- 8779776  documents.tar      ← the exact size that killed attempts 1 and 2
-rw-rw-r-- 15057    manifest.json
=== 5. bluegreen:restore-drill ===
Restore drill … passed: {"AuthSession":29,"BoardMember":14,"ComplianceAuditEvent":92,"ComplianceRecord":32,
 "ConflictRecord":4,"Deadline":55,"Document":51,"DocumentStandardLink":91,"GovernancePrinciple":6,
 "GovernanceStandard":49,"GoverningAct":20,"GoverningActVoid":5,"Member":7,"Organisation":1,
 "Resolution":38,"RiskRecord":22,"TeamInvite":4,"User":2,"_prisma_migrations":25, …}
DRILL_EXIT=0
=== TEARDOWN === containers_left=0  clone_volumes_left=0  appliance: 4 containers up
```
The drill restored that dump into a throwaway container and matched the census AND re-hashed every
manifested file — a genuinely non-degenerate verification at production data size. This is the gate
that should have existed before attempt 1.

Two script bugs of mine on the way (both fixed, neither touched production): the first rehearsal run
assumed a release worktree already existed for the target commit (true for master via the pre-build,
false for a branch), so every step failed in one second and the teardown could not parse a
nonexistent compose file, leaving the attempt-2 `charitypilot-bluegreen-db-1` container in place —
**exited**, explicitly stopped, so inert, but attached to the production db volume. Removed manually;
`docker ps -a | grep charitypilot-bluegreen` now returns nothing. Worth noting the runbook gate greps
`docker ps` (running only) by design, so it does not surface an exited container like that one: the
pre-attempt gate below uses `docker ps -a`.

**Gate before attempt 3:** `docker ps -a --format '{{.Names}}' | grep charitypilot-bluegreen` must
print nothing, and `docker volume ls | grep rehearsal` must print nothing.

## Attempt 3 — SUCCEEDED. Outage 14:55:12 → 14:55:43 = **31 seconds**

Master `2ab4a18` (buffering fix merged). Images rebuilt for the new SHA in 4 s (cache) with the
appliance serving. Pre-attempt gate: no blue-green containers, no rehearsal volumes, appliance 4/4
healthy, `preflight clean`.

```
T_STOP_START=14:55:12  STOP_EXIT=0 containers_now=0
HEAD=2ab4a184cefcd1a28af481f212aa08e92f12afa5 porcelain=0
T_DEPLOY_START=14:55:13
Blue-green deploy completed: blue is now live at 2ab4a184…
DEPLOY_EXIT=0  T_DEPLOY_END=14:55:43
gate: 4 pending, 0 blocked, 4 warned → migrate → up → candidate-smoke → switch → public-smoke → jobs → retire → record
```
Front door (Tailscale Serve): `{"status":"ready",…,"buildCommit":"2ab4a184…"}`. Five containers healthy:
`db`, `caddy`, `api-blue`, `web-blue`, `scheduler`.

### Step 6 — data verification: PASS (owner-facing items outstanding)
- Documents: **51/51 sha256 identical** to the 13:02 pre-cutover baseline.
- Census delta vs baseline is exactly the migration effect and nothing else:
  `+PlatformOperator=0`, `+PlatformOperatorSession=0`, `_prisma_migrations 25 → 29`.
- `/login` and `/owner/login` both return `HTTP/1.1 200` through the front door with the real title.
- **Outstanding, needs the owner:** the charity owner signing in, the console listing tenant #1, and
  provisioning a comped test tenant end-to-end. These need credentials the agent does not hold.

### Step 5 — platform operator bootstrapped
`Created platform operator cmtk5z35q0000mk0112ft7n80 (jasper@hour-timebank.ie)`. The one-time
set-password link (valid 24 h, shown once) was written to `~/owner-setup-link.txt` mode 600 on the VM
rather than printed into the transcript. `PlatformOperator` row count = 1.

### Step 7 — safety net: PASS
`bluegreen:backup` exit 0 (`documents.tar` 8,779,776 B; `database.dump` 402,171 B).
`bluegreen:restore-drill` exit 0, non-degenerate census including the post-migration state
(`PlatformOperator:1`, `_prisma_migrations:29`); no drill containers left. Nightly cron switched:
exactly one entry, `30 3 * * * /home/cpops/bin/bluegreen-nightly-backup.sh`; the appliance entry is gone.
Backup copied to `D:\CharityPilot-VM\backups\bluegreen\2026-09-02T14-06-05-582Z\` and verified locally —
both artifacts' sha256 match the manifest, 51 document entries, row census in `meta`.

### Step 8 — real deploy, real rollback, real re-deploy: PASS (zero downtime)
| Stage | Duration | Front-door `buildCommit` |
|---|---|---|
| deploy blue→green | 22 s (15:05:27→15:05:49) | `2ab4a18` → `2613362` |
| rollback green→blue | 15 s (15:05:49→15:06:04) | `2613362` → `2ab4a18` |
| re-deploy blue→green | 21 s (15:06:04→15:06:25) | `2ab4a18` → `2613362` |

Every transition confirmed externally through Tailscale Serve, and `Rollbackable: true` throughout.
**This is the first rollback ever executed on this host.**

### Step 9 — DELIBERATELY INCOMPLETE, and why
The plan gates step 9 on steps 6–8 all passing. Step 6's owner-facing checks are outstanding, so the
agent has NOT archived the appliance install-state directory and has NOT deleted the Hyper-V
checkpoints. `pre-bluegreen-ca02055` remains the whole-cutover rollback, and the appliance stack can
still be brought back with `~/precutover/restore-appliance.sh`.

**Also found and fixed during step 9 (unrelated to the cutover, and the most valuable disaster-recovery
finding of the day): the off-VM appliance recovery key was STALE.** `D:\CharityPilot-VM\secrets\charitypilot-server-recovery-key.hex`
(Aug 30 07:48) did not match the VM's current key (Aug 30 18:57) — sha256 `0cd931ff…` vs `478cd0eb…` —
so every appliance recovery set made after the rebuild, **including today's verified pre-cutover
backup now sitting on `D:`**, would have been unopenable had the VM been lost. Refreshed and
hash-verified (`478cd0eb…` both sides); the stale copy is preserved as
`charitypilot-server-recovery-key.hex.stale-20260830-superseded-20260902` rather than overwritten.

### Remaining for the owner
1. Set the operator password via `~/owner-setup-link.txt` (24 h), then complete step 6's owner-facing checks.
2. Then, from an ELEVATED PowerShell, delete both checkpoints — this cutover's and the stale
   `pre-deploy-e136cf9` from 30/08, which has been growing a differencing disk ever since:
   `Remove-VMSnapshot -VMName charitypilot-server -Name "pre-bluegreen-ca02055" -Confirm:$false`
   `Remove-VMSnapshot -VMName charitypilot-server -Name "pre-deploy-e136cf9" -Confirm:$false`
3. Then archive (never delete) `~/.local/share/charitypilot/personal-server` and update
   `D:\CharityPilot-VM\provision\RUNBOOK.md` §1/§3, and flip the status banners in
   `docs/hyperv-private-server-deployment.md` + date the runbook's "Not yet executed" line.
