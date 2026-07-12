# Personal Server 100/100 Readiness Scorecard

Last reviewed: 2026-07-12

## Purpose

This is the completion contract for CharityPilot's private, single-charity
Windows deployment. It does not score the future public SaaS launch.

Two scores are recorded because they answer different questions:

- **implementation completeness** asks whether the repository contains the
  required fail-closed code, tests and operator documentation; and
- **release/live certification** asks whether a published immutable artifact has
  passed the required clean-host, recovery, reboot and private-access exercises.

Passing local tests increases implementation confidence. It cannot by itself
increase a live-certification item that requires a real release, Windows host,
off-host copy, reboot or second device.

The profile may be called **install-ready for real charity use** only when the
release/live score is 100/100 and every critical gate is complete.

## Scoring contract

| Area | Points | Evidence required for full credit |
| --- | ---: | --- |
| Versioned download and Windows installation | 20 | Public immutable release identity, checksum/outer and inner manifests, clean-download instructions, automated preflight, safe installer, external state, failed-install resume, replacement-host entry point and a clean supported-Windows rehearsal. |
| Compiled runtime and isolation | 15 | Caddy-only loopback publication, internal API/database, compiled images, no source mounts/watchers, isolated volumes, an internal application bridge plus Caddy-only edge transport, pinned infrastructure images, health checks, restart/reboot proof and no migration/seed during routine start. |
| Identity, secrets and private access | 15 | One-shot one-charity bootstrap, credential delivery, strong distinct secrets, verified Windows ACLs, exact origin/proxy/cookie controls, provider-free account lifecycle, no public registration, restricted Tailscale Serve proof and second-device invitation/offboarding. |
| Authenticated-encrypted backup and full recovery | 20 | Quiesced database/document capture, source/restored fingerprints, safe archive validation, database/document reconciliation, encryption and manifest authentication, separate key custody, off-host generation, guarded restore, full-stack rehearsal, sampled login/download and blank replacement-host recovery. |
| Update, rollback and decommissioning | 10 | Verified release acquisition, source/image identity, pre-update set, schema-compatible update, resumable pre-cutover receipt, rollback identity, injected failure recovery, previous-to-current rehearsal and guarded terminal decommission. |
| Windows host operations | 10 | Supported-version/resource contract, local Docker Desktop/WSL/Linux-container checks, loopback-port/two-subnet/disk checks, disk encryption/updates/AV/sleep/startup guidance, diagnostics, backup scheduling/monitoring guidance and post-reboot proof. |
| Documentation and continuous verification | 10 | README discoverability, exact clone/release/install/update/restore/reset/decommission instructions, security/support policy, static/profile tests, Windows CI, clean-tree checks, exact-SHA CI and final requirement-by-requirement audit. |
| **Total** | **100** | **All critical gates and all named evidence.** |

## Current named baseline: 2026-07-12 working tree

This baseline is for the current local working tree. It is not a release score,
not a GitHub publication, and not permission to store important records.

| Area | Max | Implementation | Release/live certification | Current evidence and remaining gap |
| --- | ---: | ---: | ---: | --- |
| Versioned download and Windows installation | 20 | 20 | 6 | Installer, archive verifier, failed resume, replacement restore and fail-closed release workflow are implemented and locally verified. No public artifact or final clean-release install exists. |
| Compiled runtime and isolation | 15 | 15 | 9 | Compose/security contracts and compiled API/web/migration images are green; a prior live attempt applied all migrations. No final ready install or post-reboot proof exists. |
| Identity, secrets and private access | 15 | 15 | 4 | Transactional Owner bootstrap, distinct-secret/ACL gates, exact origin/Tailscale contracts, replacement-host auth rebind and resumable incident rotation exist. Tailscale and real Owner/second-device invitation/offboarding are unproved. |
| Authenticated-encrypted backup and full recovery | 20 | 20 | 4 | AES-256-GCM artifacts, manifest HMAC, fingerprints, full-stack rehearsal, guarded restore, blank-host recovery and post-rotation recovery cleanup/rehearsal are implemented. No off-host set, guarded live restore or blank-host live recovery has passed. |
| Update, rollback and decommissioning | 10 | 10 | 1 | Version-bound updater, receipt resume, rollback and terminal decommission contracts are implemented. No two real releases have completed update/rollback/decommission acceptance. |
| Windows host operations | 10 | 10 | 4 | Supported-version, Docker/WSL boundary, two-subnet, ACL, diagnostic and operator contracts are implemented and this host meets the tested runtime versions. Tailscale, reboot/startup and scheduled-backup monitoring proof are absent. |
| Documentation and continuous verification | 10 | 10 | 3 | The authoritative personal-server operator/security/support/release set, static/profile tests and Windows workflows agree with the implementation; older full-platform status snapshots are explicitly non-authoritative for this separate mode. Exact-SHA CI and release acceptance remain live gates. |
| **Total** | **100** | **100/100** | **31/100** | **The repository implementation contract is complete; install-ready certification remains deliberately low because the external/live gates are real work, not paperwork.** |

### Test evidence for this baseline

- the final rebased personal-server contract suite passed 152/152 on
  2026-07-12 after the Docker-boundary, two-network isolation,
  replacement-host auth rebind, incident-rotation resume and post-rotation
  recovery-rehearsal adjustments;
- API, web and real-PostgreSQL migration suites have passed during this work;
- production API and web builds have passed; and
- these local results are not yet bound to a clean published commit or Release.

### Current external/live state

- no `personal-v*` tag or GitHub Release exists;
- the release environment's least-privilege
  `PERSONAL_RELEASE_ADMIN_READ_TOKEN` is not configured;
- a custom protected state root and location pointer exist from the supervised
  clean-Git certification attempt; its installation is currently preserved in
  `failed` from `initializing`, with stopped project resources awaiting the
  supported repaired-source resume, so it is not a ready installation;
- Tailscale is not installed on this host; and
- no reboot, second-device, off-host, previous-release update or live guarded
  restore evidence exists.

The previous 58/100 figure is retired because it mixed implementation progress
with live certification. Use the two named scores above instead.

## Critical exit gates

Every item below is mandatory regardless of arithmetic:

- [ ] The complete implementation/docs slice is committed to canonical
      `master`, exact-SHA CI and managed E2E are green, and the tree is clean.
- [ ] A strict annotated `personal-v*` tag publishes one immutable named ZIP,
      checksum and outer manifest with provenance.
- [ ] That downloaded release installs on a supported clean Windows host using
      only `scripts/Install-CharityPilot.ps1`.
- [ ] Initialization either completes and reveals a usable Owner credential or
      leaves a tested exact `-ResumeFailed` route after every post-commit
      failure.
- [ ] Only Caddy is published to the Windows host, at the exact loopback bind.
- [ ] The Owner signs in after installation and again after a real Windows
      reboot.
- [ ] A separately named director connects through restricted private HTTPS,
      accepts an invitation, signs in, and loses access after offboarding.
- [ ] A recovery set is authenticated-encrypted, copied off-host with its key
      held separately, restored into disposable full-stack resources and proven
      equivalent for database content and document bytes.
- [ ] A guarded real restore succeeds from that set and includes post-restore
      login plus a sampled document download.
- [ ] A blank replacement host restores the same set through the installer,
      rotates host secrets, atomically rebinds authentication recovery, revokes
      sessions, rejects restored reset links, issues and consumes a new reset
      link, and reaches `ready`.
- [ ] The supported authentication-recovery incident rotation survives an
      injected interruption, invalidates old links, activates a new secret,
      creates a post-rotation encrypted set, passes an isolated rehearsal and
      proves a newly issued reset link.
- [ ] An update from the previous supported release succeeds; rollback and an
      injected failure retain a usable verified recovery path.
- [ ] Guarded decommission creates/rehearses a final set, closes private access,
      removes only exact resources, and replacement recovery works elsewhere.
- [ ] State, key, pointer, reports and recovery material have verified
      owner-plus-SYSTEM Windows ACLs.
- [ ] The source tree and every operator document agree with released behavior
      and contain no developer-specific machine path.

## Evidence record for final certification

Record these together without secrets or personal charity data:

- release tag, commit SHA, release URL, workflow URL and artifact SHA-256;
- outer/inner manifest identities and provenance result;
- supported Windows, PowerShell, Node, npm, WSL, Docker and Compose versions;
- installer/preflight command and sanitized report;
- Compose-render digest and live container/image/volume identities plus both
  exact internal and Caddy-only edge network identities;
- exact loopback listener and private HTTPS/Tailscale evidence;
- bootstrap, login, invitation, role, logout and offboarding results;
- recovery-set identifier, key-custody method and off-host location class;
- source/restored database and document inventory fingerprints;
- disposable rehearsal, guarded restore, blank-host restore/auth-rebind and
  restored-link rejection/new-link success reports;
- incident-rotation receipt identity, interruption/resume result and
  post-rotation recovery-set rehearsal result;
- previous/current release identities and update/rollback results;
- decommission and replacement-recovery results;
- post-reboot health/login result;
- exact local test commands and exact GitHub CI/E2E run URLs; and
- confirmation that identities/data were disposable and no personal charity
  data was used during certification.
