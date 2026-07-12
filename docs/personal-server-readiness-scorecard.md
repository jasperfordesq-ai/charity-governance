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
| Compiled runtime and isolation | 15 | Caddy-only loopback publication, internal API/database, compiled images, no source mounts/watchers, isolated volumes/network, pinned infrastructure images, health checks, restart/reboot proof and no migration/seed during routine start. |
| Identity, secrets and private access | 15 | One-shot one-charity bootstrap, credential delivery, strong distinct secrets, verified Windows ACLs, exact origin/proxy/cookie controls, provider-free account lifecycle, no public registration, restricted Tailscale Serve proof and second-device invitation/offboarding. |
| Authenticated-encrypted backup and full recovery | 20 | Quiesced database/document capture, source/restored fingerprints, safe archive validation, database/document reconciliation, encryption and manifest authentication, separate key custody, off-host generation, guarded restore, full-stack rehearsal, sampled login/download and blank replacement-host recovery. |
| Update, rollback and decommissioning | 10 | Verified release acquisition, source/image identity, pre-update set, schema-compatible update, resumable pre-cutover receipt, rollback identity, injected failure recovery, previous-to-current rehearsal and guarded terminal decommission. |
| Windows host operations | 10 | Supported-version/resource contract, Docker/WSL/Linux-container checks, port/subnet/disk checks, disk encryption/updates/AV/sleep/startup guidance, diagnostics, backup scheduling/monitoring guidance and post-reboot proof. |
| Documentation and continuous verification | 10 | README discoverability, exact clone/release/install/update/restore/reset/decommission instructions, security/support policy, static/profile tests, Windows CI, clean-tree checks, exact-SHA CI and final requirement-by-requirement audit. |
| **Total** | **100** | **All critical gates and all named evidence.** |

## Current named baseline: 2026-07-12 working tree

This baseline is for the current local working tree. It is not a release score,
not a GitHub publication, and not permission to store important records.

| Area | Max | Implementation | Release/live certification | Current evidence and remaining gap |
| --- | ---: | ---: | ---: | --- |
| Versioned download and Windows installation | 20 | 19 | 6 | Installer, archive verifier, failed resume, replacement restore and release workflow exist. No public artifact or final clean-release install exists. |
| Compiled runtime and isolation | 15 | 15 | 9 | Compose/security contracts and compiled API/web/migration images are green; a prior live attempt applied all migrations. No final ready install or post-reboot proof exists. |
| Identity, secrets and private access | 15 | 14 | 4 | Transactional Owner bootstrap, secret generation, ACL helper, exact origin and Tailscale contracts exist. Tailscale is absent and real Owner/second-device invitation/offboarding is unproved. |
| Authenticated-encrypted backup and full recovery | 20 | 19 | 4 | AES-256-GCM artifacts, manifest HMAC, fingerprint/document reconciliation, full-stack rehearsal, guarded restore and replacement-host code exist. No off-host set, guarded live restore or blank-host live recovery has passed. |
| Update, rollback and decommissioning | 10 | 9 | 1 | Version-bound updater, receipt resume, rollback and terminal decommission contracts exist. No two real releases have completed update/rollback/decommission acceptance. |
| Windows host operations | 10 | 9 | 4 | Current host has supported Node/npm/Docker/Compose/WSL2 and the preflight/diagnostic contracts. Tailscale, reboot/startup and scheduled-backup monitoring proof are absent. |
| Documentation and continuous verification | 10 | 9 | 3 | Operator/security/support/release documentation and workflows exist locally. They are not yet committed/published or proven by exact-SHA CI and release acceptance. |
| **Total** | **100** | **94/100** | **31/100** | **Implementation is close; certification remains deliberately low because the external/live gates are real work, not paperwork.** |

### Test evidence for this baseline

- the final rebased personal-server contract suite passed 107/107 on
  2026-07-12 after the update/rollback quiescence, source-trust,
  replacement-host, cleanup, confirmation-discovery and password-recovery
  integrity adjustments;
- API, web and real-PostgreSQL migration suites have passed during this work;
- production API and web builds have passed; and
- these local results are not yet bound to a clean published commit or Release.

### Current external/live state

- no `personal-v*` tag or GitHub Release exists;
- the release environment's least-privilege
  `PERSONAL_RELEASE_ADMIN_READ_TOKEN` is not configured;
- the default protected state root, location pointer and personal-server Docker
  resources do not exist on this host;
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
- [ ] Only Caddy listens on the Windows host and it remains loopback-only.
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
      rotates host secrets, revokes sessions and reaches `ready`.
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
- Compose-render digest and live container/image/volume/network identities;
- exact loopback listener and private HTTPS/Tailscale evidence;
- bootstrap, login, invitation, role, logout and offboarding results;
- recovery-set identifier, key-custody method and off-host location class;
- source/restored database and document inventory fingerprints;
- disposable rehearsal, guarded restore and blank-host restore reports;
- previous/current release identities and update/rollback results;
- decommission and replacement-recovery results;
- post-reboot health/login result;
- exact local test commands and exact GitHub CI/E2E run URLs; and
- confirmation that identities/data were disposable and no personal charity
  data was used during certification.
