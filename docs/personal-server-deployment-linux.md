# Private Personal Server on Linux

Last reviewed: 2026-07-12

## Status and scope

The `private-linux-server` host profile runs the same compiled, single-charity
`personal-server` application stack on a dedicated x86-64 Linux computer or VM.
It exists alongside the Windows profile and the strict public-production
profile; it does not replace or weaken either one.

Repository contract tests cover the Linux installer, local-Docker boundary and
the shared lifecycle/recovery engine. A clean Linux VM installation, reboot,
off-host recovery, replacement-host recovery, update and rollback have **not yet
been executed and accepted**. Until those gates pass, use this profile for
supervised testing with synthetic or replaceable data, not as the only home of
important charity records.

No versioned CharityPilot personal-server release currently exists. A clean
canonical `master` clone may be used as a supervised testing snapshot. GitHub's
generic **Code > Download ZIP** is not a release and is not accepted by the
Linux preflight.

## Architecture

Linux does not need Apache, nginx or a hosting control panel. Docker runs four
compiled services:

```text
Browser on host or Tailscale network
                 |
          exact private origin
                 |
        Caddy (only host port)
          |                 |
     /api/v1/*          every other path
          |                 |
     Fastify API        Next.js server
          |                 |
          +------ PostgreSQL
          +------ protected document volume
```

Caddy binds only `127.0.0.1:<port>`. PostgreSQL, Fastify and Next.js have no
host ports. Caddy alone joins the internal application bridge and the dedicated
edge bridge. Do not change the bind to `0.0.0.0`, open it in a cloud firewall,
forward it through a router, enable Tailscale Funnel or add a public tunnel.

For directors, the supported remote-access design remains the host's exact
private `.ts.net` HTTPS origin through Tailscale Serve. Each director needs an
individual CharityPilot account and an individually authorised Tailscale
identity.

## Host requirements

- dedicated x86-64 Linux VM or computer; Ubuntu 24.04 LTS is the initial
  recommended distribution;
- a dedicated non-root operator account with local Docker access;
- current security updates, full-disk or provider-volume encryption and host
  firewall enabled;
- Node.js 22 or later and the exact npm version declared by `package.json`;
- local Docker Engine API 1.48 or later at `unix:///var/run/docker.sock`;
- Docker Compose 2.33.1 or later with `--wait` and `--wait-timeout`;
- at least 4 GB RAM, 2 vCPU and 40 GB disk recommended;
- at least 20 GiB free on source and state filesystems, plus adequate Docker
  storage;
- Tailscale only when directors require private remote access.

Root is deliberately rejected as the routine operator. Remote Docker contexts,
TCP Docker endpoints, `DOCKER_HOST`, TLS/API overrides, BuildKit overrides and
ambient Compose controls fail closed. The first profile supports x86-64 only;
ARM/Ampere remains an explicit future acceptance target.

## Clean source preparation

Install Git, Node.js, Docker Engine and the Compose plugin using the Linux
distribution and Docker's official instructions. Add the dedicated operator to
the Docker-access group only if the resulting root-equivalent Docker authority
is understood and accepted. Sign out and back in after changing group
membership.

Clone only the canonical repository:

```bash
git clone https://github.com/jasperfordesq-ai/charity-governance.git
cd charity-governance
git switch master
git fetch origin master
git status --short
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)"
npm install --global npm@11.11.0
```

`git status --short` must print nothing. The installer refuses another remote,
branch, dirty checkout or commit that differs from the already-fetched
`origin/master`.

## Mandatory preflight

For the default local port and state directory:

```bash
bash scripts/Install-CharityPilot.sh --preflight-only
```

For a custom encrypted data mount:

```bash
bash scripts/Install-CharityPilot.sh \
  --preflight-only \
  --port 8080 \
  --state-root /srv/charitypilot/personal-server
```

Preflight is read-only. It checks the non-root Linux/x86-64 boundary, clean
source identity, exact Node/npm contract, local Unix-socket Docker Engine,
Compose capabilities, empty external state root, loopback port and free space.

## First supervised installation

Local-host-only installation:

```bash
bash scripts/Install-CharityPilot.sh \
  --owner-email owner@example.org \
  --owner-name "Owner Name" \
  --organisation-name "Charity Name"
```

Custom state and port:

```bash
bash scripts/Install-CharityPilot.sh \
  --owner-email owner@example.org \
  --owner-name "Owner Name" \
  --organisation-name "Charity Name" \
  --origin http://localhost:18080 \
  --port 18080 \
  --state-root /srv/charitypilot/personal-server
```

The installer:

1. runs the mandatory preflight;
2. creates an operator-owned state tree with directory mode `0700` and secret
   file mode `0600`;
3. writes the protected state pointer under
   `${XDG_STATE_HOME:-$HOME/.local/state}/charitypilot`;
4. creates a separate recovery key and distinct application secrets;
5. builds the compiled API, migration and web images;
6. migrates the empty database and creates exactly one verified Owner;
7. prints the generated Owner password once, without storing it;
8. starts PostgreSQL, Fastify, Next.js and Caddy;
9. creates an authenticated-encrypted database/document recovery set;
10. rehearses that exact set in isolated disposable resources;
11. writes a bounded runtime-health report; and
12. records protected phase `ready` only after every gate succeeds.

If a step fails, the installer commands writers to stop, records phase `failed`
and preserves state, recovery files, volumes, networks and containers. Do not
delete or rename them. Linux failed-install resume and replacement-host wrapper
acceptance are still open work; preserve the host for supervised recovery.

The default durable state is:

```text
~/.local/share/charitypilot/personal-server
```

It contains `.env.personal-server`, `install-state.json`, `recovery-key.hex`,
runtime-health reports and encrypted recovery sets. Never commit, email, paste
or attach these files. Keep an encrypted off-host copy of the recovery key
separate from encrypted recovery sets.

## Routine operation

The environment pointer is not automatically imported by new shells. Define it
for the dedicated operator, using the state path chosen during installation:

```bash
export CHARITYPILOT_PERSONAL_SERVER_ENV_FILE="$HOME/.local/share/charitypilot/personal-server/.env.personal-server"
```

Then use only the supported lifecycle commands:

```bash
npm run personal:server:status
npm run personal:server:start
npm run personal:server:stop
npm run personal:server:backup
npm run personal:server:rehearse-restore -- --recovery-set=/absolute/path/to/set
npm run personal:server:certify -- --local-only
npm run personal:server:reset-link -- --email=director@example.org
```

Routine start does not build, migrate or seed. Stop preserves volumes. Never
substitute raw Compose, database commands, volume deletion or `docker system
prune` as an operator procedure.

## Private director access

Before installing with an HTTPS origin, enrol the VM in the charity's Tailscale
network and configure Tailscale Serve to proxy the selected loopback port. Use
the exact HTTPS `.ts.net` origin without a path or trailing slash as `--origin`.
The installer will fail runtime certification if Serve identity, proxy target or
Funnel state is unsafe.

Cloud-provider firewall rules should expose no CharityPilot application port.
SSH should be restricted to an administrative private path or tightly scoped
source addresses. Tailscale access does not replace individual application
accounts, role management, session revocation or offboarding records.

## Backups and recovery

The shared recovery engine quiesces writers, captures PostgreSQL and all
document bytes, proves database identity, reconciles document metadata, encrypts
artifacts with AES-256-GCM, authenticates the manifest with HMAC-SHA-256 and
restarts prior services only after verification. Restore input is streamed into
the read-only-root rehearsal container; it is never copied into that container.

Until clean Linux live acceptance is complete:

- do not keep the only copy of important records in this profile;
- copy verified encrypted sets off the VM;
- keep `recovery-key.hex` separately;
- do not claim successful recovery until a different blank Linux VM restores
  the set and passes authenticated Owner access;
- do not improvise an update by pulling source or changing image tags.

## Updates and present limitations

The Windows version-bound updater is not a Linux operator entry point. A Linux
release updater, failed-install resume wrapper, guarded replacement-host wrapper
and live update/rollback evidence remain required before this profile can be
declared generally supported. For now, preserve the exact installed source and
images and treat upgrades as supervised engineering work.

Repository contract tests are necessary but do not prove cloud firewall,
Tailscale ACL, reboot, scheduled backup, off-host copy, live restore, provider
availability or host hardening. Track those gates in
[`personal-server-readiness-scorecard.md`](personal-server-readiness-scorecard.md).
