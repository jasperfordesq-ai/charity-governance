# CharityPilot Agent Notes

This workspace belongs to the CharityPilot / charity governance platform project.

Canonical GitHub repository:

https://github.com/jasperfordesq-ai/charity-governance

Agents working in this directory should treat that GitHub repository as the source-control home for this project.

## Active Continuation Goal

Before starting production-completion work, read:

- [CharityPilot Agent Continuation Handoff](docs/agent-continuation-handoff.md)
- [Full-Platform Remediation Audit](docs/platform-remediation-audit-2026-07-10.md)

Before changing the private, single-charity Windows deployment profile, also
read:

- [Personal Server Deployment on Windows](docs/personal-server-deployment.md)
- [Personal Local Use Readiness](docs/personal-local-use.md)
- [Personal Server 100/100 Readiness Scorecard](docs/personal-server-readiness-scorecard.md)
- [Personal Server Release Maintainer Runbook](docs/personal-server-release-maintainer.md)
- [Security Policy](SECURITY.md)
- [Support Boundaries](SUPPORT.md)

For the separate `personal-server` operating mode, those deployment, local-use,
scorecard, release-maintainer, security and support documents are the current
authority. Older personal-server status snapshots embedded in the full-platform
handoff or remediation/completion audits do not override them; preserve the
full-platform issue ledger for public-production remediation.

That handoff records what has been achieved in the long-running product/production launch session, what remains blocked by real production providers or human review, and how to continue without dropping scope.

The remediation audit is the authoritative human-maintained issue ledger for the
2026-07-10 full-platform audit. Do not treat passing local tests or the generated
platform audit as closure while any item in that ledger remains unresolved.

The compiled `personal-server` profile is a separate operating mode for one
charity. Its front-door web server is Caddy; Caddy routes `/api/v1/*` to the
Fastify API and every other request to the compiled Next.js Node server. Only
Caddy may publish a host port, and that port must remain loopback-only. Routine
start must never migrate or seed. Do not weaken the strict public-production
profile, remove organisation scoping, or treat private-profile verification as
public-launch evidence.

Caddy is the sole dual-homed service: the API, web and database stay on the
`internal: true` application bridge, while Caddy alone also joins the exact
non-internal edge bridge required for Docker Desktop's Windows loopback
publication. Do not attach another service to that edge bridge or broaden the
host bind. Caddy must not trust incoming `X-Forwarded-*` values because direct
loopback and Tailscale Serve share the edge gateway; the configured origin is
authoritative and Fastify trusts only Caddy's fixed internal address.
Every live Docker lifecycle/certification path must re-prove the local Windows
Docker Desktop Linux named-pipe boundary and pin its remaining Docker children
to that endpoint. Keep the explicit Compose project name and case-insensitive
ambient `COMPOSE_*` scrubbing; routine start must not inherit profiles.

## Personal-server invariants

- `scripts/Install-CharityPilot.ps1` is the supported Windows first-install and
  failed-install-resume entry point, and the supported blank replacement-host
  recovery entry point. Do not document or use raw
  `personal:server:init`, Docker Compose, database commands or volume deletion
  as an equivalent operator path.
- A supervised unreleased clean-Git failure may advance source only through the
  installer's explicit `-RepairToGitRevision` initial-phase exception: same
  source/state paths, clean canonical descendant, local image identity and no
  published recovery set. Release, replacement and later-phase resumes remain
  exact-source. Never edit protected state to bypass this gate.
- `scripts/Update-CharityPilot.ps1` is the supported version-bound update and
  permitted pre-cutover-resume entry point. Raw `personal:server:update` is an
  internal receipt-bound delegate, not an operator substitute. Preserve the old
  source, exact images, pending receipt and pre-update recovery set.
- A future release install must use the named `CharityPilot-personal-v*.zip`
  asset from the canonical GitHub Releases page with its checksum/manifest.
  Never treat **Code > Download ZIP** as a release. Do not imply that a release
  exists until the repository actually publishes one.
- Durable state belongs outside the source checkout. Preserve the protected
  state root, `.env.personal-server`, `install-state.json`,
  `recovery-key.hex`, runtime-health reports, recovery sets, the protected
  `%LOCALAPPDATA%\CharityPilot\personal-server-location.json` pointer and the
  `CHARITYPILOT_PERSONAL_SERVER_ENV_FILE` contract.
- Keep the recovery key separate from off-host recovery sets. Do not weaken the
  authenticated-encrypted recovery-set, manifest-HMAC, rehearsal, guarded
  restore, rollback or decommission gates. Key loss and compromise are explicit
  recovery/security incidents.
- `personal:server:rotate-auth-recovery-secret` is the only supported
  authentication-recovery root-key rotation path. Preserve its count-only
  receipt, encrypted pre-invalidation backup, protected pending secret,
  invalidation-before-replacement ordering, ACL checks and resumable
  `auth-recovery-rotating` phase. Completion also requires a separately encrypted
  post-activation recovery set and isolated full-application rehearsal. Never
  document its raw Compose maintenance job or manual environment editing as an
  operator substitute.
- Replacement-host recovery must rebind `AUTH_RECOVERY_SECRET` only through the
  internal replacement-authorized serializable transaction after restored-data
  proof and migration, in both disposable rehearsal and real blank target,
  before any API startup. Never copy the old raw secret into a recovery set.
- Replacement-host recovery must use the Windows installer, exact compatible
  source, selected encrypted set, separate key, recorded source origin and a
  different empty state root. It rotates host secrets and revokes restored
  sessions; it never runs the fresh Owner initializer.
- A decommissioned state root is terminal. Ordinary commands must not recreate
  empty volumes from it. Recovery elsewhere uses the guarded replacement-host
  installer.
- For rollback and origin-rebind restore, omitted-confirmation `--dry-run`
  prints the required phrase without executor or destructive actions; a second
  dry run with that exact phrase shows the full plan.
- Supported remote access is the host's exact Tailscale `.ts.net` HTTPS origin
  through Tailscale Serve. Funnel, Cloudflare Tunnel, public forwarding and
  other tunnels are unsupported by this profile. Exact loopback HTTP is the
  only supported non-Tailscale mode.
- `personal:server:certify` is a bounded runtime-health attestation, not the
  complete readiness score. Never claim install-ready, 100/100, recovered,
  release-certified or director-access-certified unless every named scorecard
  gate has current executable or live evidence.
