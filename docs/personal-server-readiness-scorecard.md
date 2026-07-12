# Personal Server 100/100 Readiness Scorecard

Last reviewed: 2026-07-12

## Purpose

This is the completion contract for CharityPilot's private, single-charity
Windows deployment. It does not score the future public SaaS launch.

Two views are recorded because they answer different questions:

- **repository coverage** records whether the required fail-closed code, tests
  and operator documentation are present without turning that coverage into a
  readiness score; and
- **release/live certification** asks whether a published immutable artifact has
  passed the required clean-host, recovery, reboot and private-access exercises.

Repository coverage must not be described as `100/100`, install-ready or
certified while a named live gate remains open. Passing local tests increases
implementation confidence. It cannot by itself increase a live-certification
item that requires a real release, Windows host, off-host copy, reboot or second
device.

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

## Current named baseline: 2026-07-12 code baseline and live evidence

This baseline records the restore repair beginning at
`c5175eef1ba9ad0c3c9e46371c26165701c4d6a3`, subsequent supported-host
preflight checks and the live evidence gathered against them. The cited
`c5175ee` runs prove that restore slice; later descendant changes require their
own exact-SHA CI. Unrelated pre-existing local full-platform edits are outside
this score. This is not a Release, not clean-host acceptance and not permission
to store important records.

| Area | Max | Repository coverage | Release/live certification | Current evidence and remaining gap |
| --- | ---: | --- | ---: | --- |
| Versioned download and Windows installation | 20 | Implemented and locally verified | 6 | Installer, archive verifier, failed resume, replacement restore and fail-closed release workflow are implemented and locally verified. No public artifact or final clean-release install exists. |
| Compiled runtime and isolation | 15 | Implemented and locally verified | 9 | Compose/security contracts and compiled API/web/migration images are green; a prior live attempt applied all migrations. No final ready install or post-reboot proof exists. |
| Identity, secrets and private access | 15 | Implemented and locally verified | 4 | Transactional Owner bootstrap, distinct-secret/ACL gates, exact origin/Tailscale contracts, replacement-host auth rebind and resumable incident rotation exist. Tailscale and real Owner/second-device invitation/offboarding are unproved. |
| Authenticated-encrypted backup and full recovery | 20 | Implemented; live acceptance incomplete | 4 | AES-256-GCM artifacts, manifest HMAC, fingerprints, full-stack rehearsal, guarded restore, blank-host recovery and post-rotation recovery cleanup/rehearsal are implemented. One live encrypted set and isolated database proof exist, and the repaired read-only stream boundary passed a separate live Windows/Docker proof; no complete full-stack rehearsal, off-host set, guarded live restore or blank-host live recovery has passed. |
| Update, rollback and decommissioning | 10 | Implemented; live acceptance incomplete | 1 | Version-bound updater, receipt resume, rollback and terminal decommission contracts are implemented. No two real releases have completed update/rollback/decommission acceptance. |
| Windows host operations | 10 | Implemented; live acceptance incomplete | 4 | Supported-version, Docker/WSL boundary, two-subnet, ACL, diagnostic and operator contracts are implemented and this host meets the tested runtime versions. Tailscale, reboot/startup and scheduled-backup monitoring proof are absent. |
| Documentation and continuous verification | 10 | Implemented; release evidence incomplete | 3 | The authoritative personal-server operator/security/support/release set, static/profile tests and Windows workflows agree with the implementation; older full-platform status snapshots are explicitly non-authoritative for this separate mode. Exact-SHA CI and E2E are green for the restore repair, but clean-release acceptance remains open. |
| **Total** | **100** | **No known open code-contract item; not a readiness certification** | **31/100** | **The profile is not install-ready because the mandatory external/live gates remain open.** |

### Test evidence for this baseline

- the personal-server contract suite passed 156/156 on 2026-07-12;
- production checks passed 830 with two intentional skips, the PostgreSQL
  backup slice passed 43 with one Windows symlink-privilege skip, and lint,
  compiled builds, secret scanning and SAST passed;
- an independent security review found no remaining actionable concern in the
  streamed-restore slice;
- exact commit `c5175eef1ba9ad0c3c9e46371c26165701c4d6a3` passed canonical
  [CI](https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29194766905)
  and [managed E2E](https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29194766923);
- a real Windows/Docker proof streamed a custom-format dump into a read-only-root
  PostgreSQL target through the committed helper, recovered the exact synthetic
  row and removed every uniquely labelled disposable resource; and
- this evidence is still not a named release or clean-host installation.

### Current external/live state

- no `personal-v*` tag or GitHub Release exists;
- the release environment's least-privilege
  `PERSONAL_RELEASE_ADMIN_READ_TOKEN` is not configured;
- a custom protected state root and location pointer exist from the supervised
  clean-Git certification attempt; its installation is currently preserved in
  `failed` from `initialized-backup-pending`, with five stopped containers, two
  networks, two volumes and one completed authenticated-encrypted recovery set.
  Its isolated database restore proof passed, but its full-application rehearsal
  did not complete under the recorded source;
- because that installation published a recovery set, its source cannot advance.
  A new clean-clone preflight at `c5175ee` passed every other host/source gate and
  correctly failed on the existing protected pointer and Docker resources. The
  old state/resources were not edited or deleted, so this host cannot provide a
  second clean-install result;
- Tailscale is not installed on this host; and
- no reboot, second-device, off-host, previous-release update or live guarded
  restore evidence exists.

The previous 58/100 figure is retired because it mixed implementation progress
with live certification. Use the two named scores above instead.

The live stream proof closes the implementation defect but does not change the
31/100 release/live score: it is narrower than the mandatory full installer,
release provenance, reboot, private-device and recovery acceptance gates.

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
