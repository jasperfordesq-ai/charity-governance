# Personal Server Release Maintainer Runbook

This runbook is for the CharityPilot repository owner. End users do not need a
GitHub token: they download a named, immutable release asset after the release
workflow has succeeded.

No `personal-v*` release has been published yet. Until the first complete
release run succeeds, a clean `master` checkout is a supervised test route and
the public download route is not available.

Current external blocker: the `personal-server-release` environment exists, but
`PERSONAL_RELEASE_ADMIN_READ_TOKEN` is not configured. The workflow must stop
before publication until the least-privilege credential below is added.

## Trust controls

The canonical repository is:

```text
https://github.com/jasperfordesq-ai/charity-governance
```

The repository currently uses these distribution controls:

- GitHub immutable releases are enabled;
- private vulnerability reporting is enabled;
- the active `Immutable personal release tags` tag ruleset protects
  `personal-v*` tags from update and deletion with no bypass actor;
- the `personal-server-release` environment accepts only `personal-v*` tags;
- `.github/workflows/personal-server-release.yml` requires the tagged commit to
  equal current canonical `master` both before packaging and immediately before
  publication;
- the candidate ZIP is tested on Windows, content-bound to its inner and outer
  manifests, SHA-256 checked, and provenance-attested; and
- publication starts as a mutable draft, verifies all three asset digests, then
  publishes and fails unless GitHub reports the release immutable.

Do not weaken any of these controls to make a release pass.

## Repair a supervised pre-release clean-Git install

The clean-`master` route exists only for supervised acceptance before the first
official release. If it fails during the initial installer phase because source
code itself needs repair, publish and review the fix on canonical `master`,
fast-forward the same clean checkout, and follow the deployment runbook's
target-bound `-ResumeFailed -RepairToGitRevision <exact HEAD SHA>` procedure.

The installer does not fetch or choose a commit. It accepts only exact clean
`HEAD == origin/master`, proves the old failed SHA is an ancestor, requires the
protected install to be unreleased/fresh/initial-phase with no published
recovery set, and records the advance. Never use this exception for a release
archive, replacement restore, later failed phase or ordinary version update.
Never edit `install-state.json` or delete preserved volumes to make a repair
fit. Once releases exist, ship fixes through a new immutable release and the
version-bound updater instead.

## One-time least-privilege environment secret

GitHub's immutable-release settings endpoint requires repository
`Administration: read`. The normal Actions `GITHUB_TOKEN` cannot receive that
permission. The repository owner must therefore create a separate fine-grained
credential; repository code cannot safely mint it.

In GitHub:

1. Open **Settings > Developer settings > Personal access tokens > Fine-grained
   tokens** for the account that administers the canonical repository.
2. Create a short-lived token restricted to the single
   `jasperfordesq-ai/charity-governance` repository.
3. Grant repository **Administration: Read-only** and no write permission.
   GitHub adds metadata read access automatically.
4. Open the repository's **Settings > Environments >
   personal-server-release** page.
5. Add the token as the environment secret
   `PERSONAL_RELEASE_ADMIN_READ_TOKEN`.
6. Record its expiry in the maintainer's password manager. Rotate it before
   expiry and revoke the old token after the replacement release check passes.

Do not reuse a broad classic PAT, a developer's general `gh` token, a production
provider credential, or an end user's token. Never place the value in a file,
issue, workflow, command line, release note, or repository secret outside the
restricted environment.

The workflow deliberately stops before publication when this secret is absent,
expired, incorrectly scoped, or unable to prove immutable releases are enabled.

## Create a release

1. Confirm every pre-publication code, CI, release-trust and security gate has
   current evidence and the working tree is clean. Publication creates the
   artifact needed for clean-host acceptance; publication alone does not make
   the version supported or 100/100.
2. Confirm local `master` equals `origin/master` and that the exact commit has
   green CI and managed E2E evidence.
3. Choose the next strict version, for example `personal-v1.0.0`. Prerelease
   suffixes and moving an existing version are not supported.
4. Create and push an annotated tag:

   ```powershell
   git switch master
   git pull --ff-only
   git tag -a personal-v1.0.0 -m "CharityPilot Personal Server 1.0.0"
   git push origin personal-v1.0.0
   ```

5. Monitor the `Personal Server Release` workflow. Do not manually create a
   Release while it is running.
6. Treat any failed run as non-release evidence. Investigate the exact gate;
   never retarget, delete, or recreate the protected tag to bypass it.

The workflow refuses an older ancestor of `master`, a lightweight tag, a
changed tag/ruleset, an existing Release, a mutable final release, unverified
assets, an unclean candidate, and a candidate that fails CI, E2E, Windows, ACL,
secret-scan, or personal-server contract checks.

## Verify the published release

After the workflow succeeds:

1. Verify the Release is marked immutable and has exactly the ZIP, checksum,
   and outer manifest named by the workflow.
2. Download all three assets on a separate Windows test account or host.
3. Verify the outer manifest, checksum and provenance:

   ```powershell
   $tag = 'personal-v1.0.0'
   $base = "CharityPilot-$tag"
   $archive = ".\$base.zip"
   $checksum = ".\$base.zip.sha256"
   $manifestPath = ".\$base.manifest.json"
   $actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
   $outer = Get-Content $manifestPath -Raw | ConvertFrom-Json

   if ($outer.format -cne 'charitypilot-personal-server-release/v1' -or
       $outer.profile -cne 'personal-server' -or
       $outer.tag -cne $tag -or
       $outer.archive.file -cne "$base.zip" -or
       $outer.archive.sha256 -cne $actual) {
       throw 'Published outer manifest does not match the release archive.'
   }

   $checksumLine = (Get-Content $checksum -Raw).Trim()
   if ($checksumLine -notmatch '^([A-Fa-f0-9]{64})\s+\*?(.+)$' -or
       $Matches[1].ToLowerInvariant() -cne $actual -or
       [IO.Path]::GetFileName($Matches[2]) -cne "$base.zip") {
       throw 'Published checksum does not match the release archive.'
   }

   gh attestation verify $archive `
     --repo jasperfordesq-ai/charity-governance
   ```

4. Run the documented installer from the extracted bundle while retaining all
   three original assets.
5. Complete clean-host install, reboot/login, private-access, off-host recovery,
   guarded restore, replacement-host authentication-recovery rebind, supported
   incident-secret rotation/resume, post-rotation backup rehearsal, restored-link
   rejection/new-link success, and previous-release update/rollback acceptance.
   A green release workflow is necessary but not sufficient for 100/100.
6. Record the release URL, commit SHA, artifact SHA-256, workflow run URL, and
   clean-host acceptance evidence in the readiness record. Never record the
   Owner password, environment, recovery key, private hostname, or charity data.

GitHub's repository **Code > Download ZIP** archive is never an official
CharityPilot personal-server release and cannot satisfy this runbook.
