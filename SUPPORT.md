# Support

## Installation and operation

Start with:

- [`README.md`](README.md) for the supported deployment choices;
- [`docs/personal-server-deployment.md`](docs/personal-server-deployment.md) for
  the private Windows installation and operating runbook; and
- [`docs/personal-server-readiness-scorecard.md`](docs/personal-server-readiness-scorecard.md)
  for the evidence required before important charity records are stored.

No versioned personal-server release has been published yet, and these support
instructions do not declare the profile 100/100 ready. When a release is
published, download only its named `CharityPilot-personal-v*.zip`, checksum and
manifest from the canonical
[GitHub Releases page](https://github.com/jasperfordesq-ai/charity-governance/releases).
Do not install GitHub's generic **Code > Download ZIP** archive.

For a new Windows installation, failed-install resume or blank replacement-host
recovery, use only `scripts/Install-CharityPilot.ps1`. For a verified release
update or its permitted pre-cutover resume, use only
`scripts/Update-CharityPilot.ps1`. On an existing installation, use the exact
documented start/status/stop/backup/rehearsal/restore/reset/decommission npm
commands. The low-level `personal:server:init`/`update` commands, raw
`docker compose` mutation, manual database migration/restore, volume deletion
and Docker Desktop factory reset are not supported substitutes.

Private remote access currently means the exact `.ts.net` HTTPS origin managed
by Tailscale Serve. Tailscale Funnel, Cloudflare Tunnel, router forwarding and
other tunnels are unsupported. Local-only use must remain on the exact loopback
HTTP origin selected during installation.

## Safe diagnostics

These commands are the first supported, non-destructive checks for an existing
installation:

```powershell
npm run personal:server:status
npm run personal:server:certify -- --local-only # exact loopback-HTTP installs only
npm run personal:server:certify                # Tailscale private-HTTPS installs
tailscale status
tailscale serve status
```

The `certify` command name refers to a bounded runtime-health attestation. It
does not certify the complete installation, backup, restore, reboot,
second-device or 100/100 readiness contract. Do not add `--report-file` merely
for a support request; generated reports belong under the protected state root
and still require review before sharing.

If an operator command fails, preserve its original output and run:

```powershell
npm run personal:server -- help
```

Use the protected phase to select the supported route:

| Phase or condition | Supported response |
| --- | --- |
| Fresh/restore installation `failed` | Repeat the exact installer binding with `-ResumeFailed`; do not initialize again. |
| `pending-update.json` in `prepared` or `pre-cutover` | Repeat the exact verified updater with `-ResumePending`. |
| `updating` after an ambiguous/later cutover | Preserve both sources, images, receipt and recovery sets; ordinary commands remain blocked pending supervised recovery. |
| `restoring` | Keep writers stopped and preserve both selected and preservation recovery sets. |
| `decommissioning` | Retry only with the exact final recovery set recorded in protected state/output. |
| `decommissioned` | Status only. Recover on another empty state root through the replacement-host installer. |

For rollback or an origin-rebind restore, an omitted-confirmation `--dry-run`
prints the exact required confirmation and performs no executor or destructive
action. Review it, then repeat dry-run with that confirmation before the real
operation.

Do not troubleshoot by deleting or renaming `.env.personal-server`,
`install-state.json`, `recovery-key.hex`, the installation-location pointer,
Docker volumes, or recovery-set files.

For a non-sensitive defect or documentation problem, open a GitHub issue at:

<https://github.com/jasperfordesq-ai/charity-governance/issues>

Include the exact release tag or commit, Windows version, Docker Desktop and
Compose versions, the command that failed, and sanitized output. Remove email
addresses, private hostnames, filesystem usernames, container environment,
tokens, cookie values, secrets, recovery-set paths and charity records. Never
paste raw `docker inspect`, environment, installation-state, location-pointer,
runtime-health, database or document output into a public issue.

This open-source project does not promise an always-available help desk,
managed hosting, emergency data recovery or legal/governance advice. Keep an
independently tested recovery path and do not make the only copy of important
records dependent on support availability.

Loss or compromise of `recovery-key.hex` is a security/recovery incident, not a
routine support case. Keep the remaining host and backup state intact, do not
place a replacement key beside old recovery sets, and follow the incident
guidance in [`SECURITY.md`](SECURITY.md).

## Security and sensitive incidents

Do not use a public issue. Follow [`SECURITY.md`](SECURITY.md) and open a private
GitHub Security Advisory.
