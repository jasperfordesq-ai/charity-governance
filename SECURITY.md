# Security Policy

## Supported versions

CharityPilot has not yet published a versioned personal-server release. A clean
`master` checkout with successful repository CI may be evaluated only as a
supervised testing snapshot; it is not a published release and is not evidence
that the private Windows profile has reached 100/100 installation readiness.

After releases begin, a named `personal-v*` asset becomes supported only after
its release workflow and clean-host acceptance evidence succeed. The latest
successfully accepted release will ordinarily be the supported self-hosted
version. Older releases may be asked to upgrade before a fix can be provided
safely. Use only the named `CharityPilot-personal-v*.zip` release asset with its
checksum and manifest. GitHub's repository-level **Code > Download ZIP** archive
is not a release bundle and is unsupported for installation.

The Windows personal-server host baseline is Windows 11 24H2 or later (kernel
build 26100+), with current security updates. Installer preflight fails closed
when the Windows build is missing, malformed or below that baseline.

This policy does not turn the public/commercial production profile into a
launched service. The private Windows profile and the future public service have
separate deployment and evidence requirements.

## Report a vulnerability privately

Do not open a public issue containing an exploitable vulnerability, personal
data, credentials, access tokens, private URLs, database contents, recovery
keys, or backup material.

Use the repository's **Security** tab and choose **Report a vulnerability** to
open a private GitHub Security Advisory:

<https://github.com/jasperfordesq-ai/charity-governance/security/advisories/new>

Include, where safe:

- the affected commit or release tag;
- the affected deployment profile (`personal-server`, development, or public
  production);
- a minimal reproduction using disposable data;
- the impact and preconditions;
- whether exploitation has been observed; and
- suggested remediation, if known.

Never attach a real CharityPilot backup, `.env` file, database dump, document,
private invitation/reset URL, or screenshot containing charity records. Use
redacted or synthetic evidence.

## Response and disclosure

The maintainer will acknowledge a complete private report when it is reviewed,
triage severity and supported versions, coordinate a fix and verification, and
agree a responsible disclosure point with the reporter where practical. No
specific response or remediation time is guaranteed by this volunteer/open
source project.

Security fixes should be bound to a commit or release, pass the applicable
tests, and avoid disclosing exploit detail before supported users can update.

## Personal-server trust boundary

The supported private-access choices are exact loopback HTTP for use on the
Windows host itself, or the host's exact private `.ts.net` HTTPS origin through
Tailscale Serve. Tailscale Funnel, Cloudflare Tunnel and other public or
third-party tunnels are not supported by the current installer or runtime-health
attestation. Do not make Caddy public to work around this boundary.

Caddy alone joins both the internal application bridge and a dedicated
non-internal Docker edge bridge because Docker Desktop cannot publish a Windows
loopback port from an internal-only network. The edge bridge contains no API,
web or database service, uses an exact reviewed subnet/gateway, and does not
weaken the `127.0.0.1` host bind. Treat any other edge attachment or non-loopback
publication as a security failure.

Caddy deliberately trusts no incoming `X-Forwarded-*` values. Direct Windows
loopback requests and Tailscale Serve reach its published port through the same
Docker edge gateway, so treating that gateway as a trusted proxy would let a
local process spoof a client address. Caddy replaces those headers before
proxying. Fastify trusts only Caddy's fixed internal address
`172.30.250.10`; do not broaden either boundary.

The installer preflight and every live lifecycle/runtime-health command verify
the local Windows Docker Desktop Linux named-pipe endpoint and Engine API before
using Docker, then pin every Docker child in that operation to the verified
named pipe. Remote daemon and forced API-version environment overrides fail
closed. Compose invocations pin the exact project name and scrub ambient
`COMPOSE_*` controls so a parent shell cannot activate maintenance or
initializer profiles during routine start.

Recovery rehearsal keeps the disposable PostgreSQL container root filesystem
read-only. Its authenticated custom-format dump remains a protected host file,
is opened as one non-empty regular file and is streamed to
`docker exec -i ... pg_restore` through standard input. It is never staged with
`docker cp`. Docker remains pinned to the verified local endpoint, and the file
descriptor closes on both success and failure.

The supported Windows entry point for a fresh install, failed-install resume or
blank replacement-host recovery is `scripts/Install-CharityPilot.ps1`.
Version-bound updates use `scripts/Update-CharityPilot.ps1`. Running the
low-level `personal:server:init`/`update` commands, raw Docker Compose, ad-hoc
database commands, or manual volume deletion bypasses installer receipts,
source checks, ACL enforcement and recovery gates. Those are not supported
installation or recovery procedures.

Authentication-recovery root-key incidents use only
`npm run personal:server:rotate-auth-recovery-secret`. That lifecycle command
owns the operation lock, local-Docker pin, count-only receipt, verified encrypted
backup, invalidation-before-replacement transaction, protected temporary secret,
ACL verification, activation, resumable fail-closed state, and a separately
verified post-activation recovery set with an isolated restore rehearsal. The
credential-bearing pre-invalidation set is incident evidence, not an ordinary
restore source. The underlying
maintenance job, raw Compose service and manual environment edits are not
operator procedures. Replacement-host restore uses a different internal-only
atomic rebind because the old raw host secret is intentionally absent; it must
run in both the disposable rehearsal and blank target before API startup.

An ordinary failed-install resume remains bound to its exact recorded source.
Before the first official release only, a clean-Git test install failed from
`initializing`, or from `initialized-backup-pending` before any recovery
directory was created, may adopt a reviewed canonical descendant by supplying
its exact SHA through `-RepairToGitRevision`. The installer requires clean
canonical `master`, exact `HEAD == origin/master`, ancestry from the failed
commit, local/unreleased image identity, zero published and zero incomplete
recovery directories, the same source/state paths and an explicit target match.
It records the advance in protected state. This exception cannot rebind a
release archive, replacement restore or any other failed phase, and it is not an
update mechanism.

Once a recovery set has been published, preserve the failed installation's
pointer, exact source, images, containers, networks, volumes, set and separate
key. Do not delete or rename those resources to make a new install preflight
pass. A separate acceptance attempt requires a genuinely blank supported
Windows profile and Docker daemon.

## Protected state and recovery keys

The installer keeps durable private state outside the source checkout. Its
default state root is
`%LOCALAPPDATA%\CharityPilot\personal-server`; a deliberately selected
`-StateRoot` on an encrypted drive is also supported. The state root contains
the private environment, install state, recovery key, runtime-health reports and
recovery sets. A protected
`%LOCALAPPDATA%\CharityPilot\personal-server-location.json` pointer and the
user-level `CHARITYPILOT_PERSONAL_SERVER_ENV_FILE` value allow supported
operator commands to find a custom state root.

The Windows installer applies protected NTFS ACLs for the installing operator
and LOCAL SYSTEM. These controls do not protect against either principal, a
Docker administrator, malware running as the operator, or loss of the Windows
host. Never commit, email or attach the state files, location pointer,
environment file, recovery key, runtime-health report or recovery set to a
public issue.

`recovery-key.hex` is separate from `.env.personal-server`. Keep an encrypted
offline copy of the key separately from off-host recovery sets. If the key is
lost, encrypted sets cannot be restored; do not delete the remaining host state
or improvise a plaintext backup/update as a workaround. Preserve the host and
seek supervised recovery. If the key or Windows operator account is
compromised, treat every recovery set protected by that key as disclosed,
remove private access where safe, preserve incident evidence, revoke affected
sessions and credentials, and create a new independently protected recovery
generation only through a reviewed recovery procedure. A stolen key cannot be
made unable to decrypt copies that an attacker already obtained.

Installed recovery sets protect database and document artifacts with
AES-256-GCM and authenticate the recovery manifest with HMAC-SHA-256. These
controls do not make a recovery set safe to publish: names, paths, non-secret
operational metadata and encrypted personal data still require restricted
handling.

Guarded decommission is destructive and terminal for its protected state root.
It must create, verify and rehearse a fresh final recovery set before removing
the exact runtime resources. Recovery elsewhere uses the Windows installer with
the separately held key, exact compatible source and a different empty state
root; do not attempt to recreate empty volumes from decommissioned state.

## Self-hosting responsibilities

The software cannot protect data from an administrator who controls the Windows
host, Docker daemon, operating-system account, recovery key, or unencrypted
backup. Self-hosting operators remain responsible for host updates, disk
encryption, individual accounts, private-network policy, encrypted off-host
backups, restore rehearsals and physical security. See
[`docs/personal-server-deployment.md`](docs/personal-server-deployment.md).

Do not expose the personal-server Caddy port through a router, public firewall
rule, Tailscale Funnel, Cloudflare Tunnel, or another unsupported tunnel.
