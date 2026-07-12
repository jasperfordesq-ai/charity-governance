# CharityPilot Production Runbook

This runbook is the short operator guide for release promotion. The full launch evidence ledger is `docs/production-launch-checklist.md`.

## Production Evidence Artifacts

- `.env.production.example` - production env template for the secret manager or untracked `.env.production` file.
- `.charitypilot-launch-evidence/production-launch-evidence.json` - ignored, non-secret external launch evidence ledger initialized with `npm run check:production:evidence:init`.
- `docs/production-launch-checklist.md` - top-level launch evidence checklist and final signoff.
- `docs/supabase-production-setup.md` - Supabase private storage, backup, restore, and retention evidence guide.
- `docs/production-browser-qa.md` - deployed HTTPS desktop and mobile browser QA checklist.
- `PRODUCTION_TODO.md` - concise project status tracker.

## Required Release Checks

Run these before promoting a build:

```bash
npm ci
npm run db:generate -w @charitypilot/api
npx prisma validate --schema apps/api/prisma/schema.prisma
npm run lint
npm run test
npm run build -w @charitypilot/shared
npm run build -w @charitypilot/api
npm run build -w @charitypilot/web
npm audit --omit=dev --audit-level=moderate
npm run check:production -- --production-env-file=.env.production
npm run check:production:github-env -- --environment=production
npm run check:production:github-env -- --environment=production --json
npm run check:production:github-secrets -- --environment=production
npm run check:production:github-secrets -- --environment=production --json
npm run deploy:preflight -- --production-env-file=.env.production
docker compose --env-file .env.production -f compose.production.yml -f compose.production-tls.yml config --quiet
npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/mnt/encrypted/charitypilot/p107a-cutover
npm run check:production:hosting -- --production-env-file=.env.production
npm run check:production:database -- --production-env-file=.env.production --capture-source-identity --json --expected-release-commit-sha=PROMOTED_RELEASE_COMMIT_SHA
npm run check:production:database -- --production-env-file=.env.production --recovery-set-id=RECOVERY_SET_ID --expected-source-database-identity-sha256=EXTERNAL_SHA256 --expected-release-commit-sha=PROMOTED_RELEASE_COMMIT_SHA --backup-output-dir=/mnt/encrypted/charitypilot/recovery/RECOVERY_SET_ID --keep-backup --json
npm run check:production:supabase -- --production-env-file=.env.production
npm run check:production:providers -- --production-env-file=.env.production
npm run check:production:observability -- --production-env-file=.env.production
node scripts/platform-completion-audit.mjs --json
npm run check:production:evidence:init
npm run check:production:evidence:init -- --json
npm run check:production:evidence:status -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json
npm run check:production:evidence:status -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json
npm run prepare:production:evidence-upload -- --json | gh workflow run upload-production-launch-evidence.yml --ref master --json
npm run check:production:release-run -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json
npm run check:production:release-run -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json
npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json
npm run check:production:evidence -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json
```

The production preflight command requires a real `.env.production` file or equivalent generated secret file at release time. Do not commit that file to the repository. Use `.env.production.example` only as a template; it is expected to fail preflight until real values replace the placeholders.

## Published Image Promotion

Production Docker promotion must use digest-pinned GHCR image references from the signed release workflow output. Before running the release workflow, configure the GitHub `production` environment variables that are baked into the web image:

```bash
gh variable set NEXT_PUBLIC_API_URL --env production --repo jasperfordesq-ai/charity-governance --body "https://api.charitypilot.ie"
npm run check:production:github-env -- --environment=production
npm run check:production:github-env -- --environment=production --json
gh workflow run release-images.yml --ref master
gh run watch RELEASE_RUN_ID --exit-status
```

If GitHub `production` is the approved secret store for the deployment, also verify the required production secret names before promotion. This command lists secret metadata only; it does not read secret values:

```bash
npm run check:production:github-secrets -- --environment=production
npm run check:production:github-secrets -- --environment=production --json
```

Download the release-image-digests artifact from the release workflow run and copy the values from `release-image-digests.env` into the approved production secret source:

```bash
CHARITYPILOT_API_IMAGE=ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:<api-digest>
CHARITYPILOT_WEB_IMAGE=ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:<web-digest>
CHARITYPILOT_MIGRATION_IMAGE=ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:<migration-digest>
CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1
CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL=https://api.charitypilot.ie
npm run deploy:preflight -- --production-env-file=.env.production
npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/mnt/encrypted/charitypilot/p107a-cutover
```

The deploy preflight validates the selected production env file, requires the exact reviewed `CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1` line, confirms the promoted web image build origin matches `NEXT_PUBLIC_API_URL`, renders `compose.production.yml` with `compose.production-tls.yml` by default, and runs `cosign verify` against the API, web, and migration image digests. The ordinary CLI rejects stale, absent, or arbitrary compatibility markers. Only the controlled rollback wrapper can supply the internal `p109-restored`, `p006-restored`, or `pre-p006-restored` posture after its manifest-and-restore attestation has passed; those paths cannot be selected by a normal deploy or recovery command. If a managed load balancer or hosting platform terminates HTTPS instead of the repo Caddy overlay, pass `--no-tls-proxy` to `npm run deploy:preflight`, `npm run deploy:production`, any matching `npm run deploy:rollback` rehearsal, `npm run deploy:recover:p109`, and `npm run deploy:recover:p107a`. Do not deploy mutable image tags such as `:latest`, `:sha-*`, or semantic version tags; promote only `@sha256:` image references that pass signature verification.

Before booking the production cutover, restore a recent production backup into an isolated non-production PostgreSQL target and run the exact promoted migration image followed by the exact promoted API reconciliation tool. Record clone age/source and destruction, prove the migration found no out-of-range civil dates, tenant mismatches, renamed/duplicate generated occurrences, legacy AGM reminder evidence, or generated-id collision, and inventory the legacy reminder rows that will require downtime reconciliation. Never point this rehearsal at live production. Resolve anomalies through an approved data plan, take a newer clone, and repeat; discovering a known fail-closed blocker only after production shutdown is not acceptable launch evidence.

The production deploy command is the only supported ordinary Compose migration path for this release; after a recorded P1-09 or P1-07A failure, only the matching locked recovery wrapper documented below is supported. Deploy runs the same preflight and pulls every promoted image before downtime. It then enters fail-closed maintenance mode with `docker compose ... --profile maintenance --profile jobs down --remove-orphans`, which stops and removes the old API, web, production scheduler, one-shot jobs, and Caddy proxy before any database change. The scheduler waits up to 45 seconds for active work and Compose grants 60 seconds before forced termination. With the runtime down, deploy creates and restore-verifies a retained PostgreSQL backup, runs the migration image alone, probes live Prisma history, then runs the digest-pinned API reconciliation tool with `--prepare-quiesced-cutover --confirm-schedulers-quiesced`. That step safely releases residual pre-provider reservations, quarantines residual provider-I/O rows, and refuses startup while any unresolved reminder outcome remains. Only then does it start the promoted runtime and run the public HTTPS smoke.

For transcript verification, the isolated migration step owned by that deploy is equivalent to the following command. Do not invoke it independently against production:

```bash
docker compose --env-file .env.production -f compose.production.yml -f compose.production-tls.yml --profile maintenance run --rm --no-deps migrate
```

Pass `--backup-output-dir` pointing at an approved encrypted filesystem with sufficient capacity. It is a protected base directory: every invocation creates a unique timestamp-and-random-id child, so a later deploy cannot overwrite the sole pre-migration dump. The remote PostgreSQL tool container runs as the native Linux deploy owner's uid/gid, and the helper requests owner-only child-directory/file permissions (`0700`/`0600`) where the host supports POSIX modes. The real backup path is omitted from normal transcripts. Those controls are defence in depth, not encryption. Move or replicate each required dump to approved encrypted off-host storage, apply the human-approved retention/deletion schedule, and record its protected reference and SHA-256 outside Git. Object-storage backup, joint metadata/object recovery, encryption ownership, off-host retention, and secure deletion remain external P0-10 obligations; this cutover dump does not satisfy them by itself.

If image pull fails, the old compatible runtime remains untouched and no migration is attempted. After maintenance mode begins, the runtime remains stopped after any backup, migration, compatibility probe, reminder-reconciliation gate, startup, or smoke failure and never silently restarts an older image. If the reminder gate reports unresolved rows, keep every scheduler stopped, follow the restricted `--list` and one-time reconciliation procedure in `docs/architecture/07-reminder-scheduler.md`, then rerun deploy. Do not manually run `compose up`, restart old containers, or use a previous application image against the migrated database. Use `--dry-run` to review ordered commands without changing runtime state.

P1-09 deliberately fails closed when legacy governance facts contradict its five
database invariants, a conflict record points across organisations, or an
unexpected writer prevents the quiesced migration from acquiring its bounded
locks. A failed `prisma migrate deploy` is recorded in `_prisma_migrations`, so
plainly rerunning deploy is not a recovery procedure: Prisma will reject the
failed history with P3009. Keep the runtime and every scheduler stopped, retain
the pre-migration backup and redacted failure counts, and use only the locked
P1-09 recovery command below.

First, review the failure through the approved database-operations channel. If
the preflight reported contradictory rows, correct them only under an approved
governance-data remediation plan with named ownership and retained evidence. If
it reported a lock timeout, identify and stop the unexpected writer. Rehearse
the exact correction on an isolated recent restore first. Do not continue if the
failed transaction or catalog state is uncertain; restore the retained backup
instead.

Create a non-committed recovery attestation no more than 30 minutes before the
command. Bind it to the SHA-256 of the exact production env file bytes and the
exact digest-pinned migration image selected in that file:

```json
{
  "kind": "charitypilot-p109-failed-migration-recovery-attestation",
  "schemaVersion": 1,
  "environment": "production",
  "migrationName": "20260711230000_add_domain_invariants_referential_safety",
  "assessedAt": "2026-07-11T20:00:00.000Z",
  "productionEnvFile": ".env.production",
  "productionEnvSha256": "<sha256-of-exact-production-env-bytes>",
  "migrationImage": "ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:<64-lowercase-hex-digest>",
  "operator": "named-operations-owner",
  "evidenceReference": "incident://approved-p109-recovery-evidence",
  "runtimeQuiesced": true,
  "failedMigrationTransactionRolledBack": true,
  "targetCatalogRollbackVerified": true,
  "remediationOrUnexpectedWriterResolutionCompleted": true,
  "acknowledgement": "I confirm the production runtime is quiesced, the failed P1-09 transaction rolled back without target catalog residue, the documented governance-data remediation or unexpected-writer resolution is complete, and only migration 20260711230000_add_domain_invariants_referential_safety may be marked rolled back before immediate controlled redeployment."
}
```

Review the non-mutating ordered plan with `--dry-run`, then deliberately run the
same command without that flag:

```bash
npm run deploy:recover:p109 -- --production-env-file=.env.production --backup-output-dir=/mnt/encrypted/charitypilot/p109-recovery --recovery-attestation-file=/secure/p109-recovery-attestation.json --dry-run
npm run deploy:recover:p109 -- --production-env-file=.env.production --backup-output-dir=/mnt/encrypted/charitypilot/p109-recovery --recovery-attestation-file=/secure/p109-recovery-attestation.json
```

The wrapper acquires the same host-wide cutover lock before reading the env or
attestation and holds it throughout recovery. It freezes the attested bytes in
an owner-only temporary env copy, removes that copy before releasing the lock,
and runs standard deploy preflight against those exact bytes. It then pulls the
pinned migration image and hashes all 20 reviewed `migration.sql` files inside
that selected image before re-quiescing the full runtime/jobs/TLS stack. The
repository-owned SQL preflight opens a repeatable-read, read-only transaction
and makes its invariant `DO` block the terminal statement. It deliberately has
no trailing `COMMIT` or `ROLLBACK`: on success the short-lived Prisma process
closes its connection and PostgreSQL rolls back the read-only transaction; on
failure the raised exception remains the terminal result and therefore cannot
be masked by a later successful statement. The preflight requires every
`_prisma_migrations.checksum` to equal the corresponding selected-image SHA-256,
the exact 19-migration applied predecessor chain followed only by one unresolved
failed P1-09 attempt, with no later or unknown migration history; zero target
constraint/index/FK residue; the exact legacy
`ConflictRecord_boardMemberId_fkey` and index, and zero board chronology,
conduct evidence, induction evidence, fundraising chronology, filing evidence,
or conflict-scope blockers. Unknown, partial, or mixed history/catalog state
fails before resolution. Only after those checks does the wrapper mark the exact
transactionally rolled-back migration as rolled back and immediately delegate
the normal production deploy with the same lock. That nested path creates a new
unique restore-verified backup, applies migrations, checks status and reminder
reconciliation, starts the runtime, and completes public smoke. Never invoke a
raw Compose migration-resolution command, never use `--applied` for this failure
path, and never edit `_prisma_migrations` by hand.

P1-07A applies the same fail-closed recovery discipline to migration
`20260712013000_add_password_recovery_integrity`. Its preflight counts legacy
half-pairs, malformed token hashes, expiries more than one hour beyond the
database clock, and account emails longer than 254 characters only for active
users in active organisations. The exact
migration deterministically clears either legacy reset field for inactive
principals and does not create recovery evidence for them. Do not manually
rewrite inactive rows merely to make a count zero. If any active-principal
category blocks migration, keep all runtimes and schedulers stopped, remediate
only the reviewed active rows, retain redacted counts, and expect a plain retry
to fail with P3009.

Create a fresh non-committed attestation, no more than 30 minutes old, bound to
the exact production env bytes and digest-pinned migration image:

```json
{
  "kind": "charitypilot-p107a-failed-migration-recovery-attestation",
  "schemaVersion": 1,
  "environment": "production",
  "migrationName": "20260712013000_add_password_recovery_integrity",
  "assessedAt": "2026-07-11T22:00:00.000Z",
  "productionEnvFile": ".env.production",
  "productionEnvSha256": "<sha256-of-exact-production-env-bytes>",
  "migrationImage": "ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:<64-lowercase-hex-digest>",
  "operator": "named-operations-owner",
  "evidenceReference": "incident://approved-p107a-recovery-evidence",
  "runtimeQuiesced": true,
  "failedMigrationTransactionRolledBack": true,
  "targetCatalogRollbackVerified": true,
  "remediationOrUnexpectedWriterResolutionCompleted": true,
  "acknowledgement": "I confirm the production runtime is quiesced, the failed P1-07A transaction rolled back without target catalog residue, every active-principal legacy reset-token half-pair, malformed hash, unsafe future expiry, and overlong account email has been deliberately remediated, each valid active pre-cutover slot may be backfilled exactly once into the P107A ledger before both User fields are atomically retired, inactive-principal reset fields are accepted only for deterministic clearing without recovery evidence, and only migration 20260712013000_add_password_recovery_integrity may be marked rolled back before immediate controlled redeployment."
}
```

Review the ordered non-mutating plan, then deliberately execute it:

```bash
npm run deploy:recover:p107a -- --production-env-file=.env.production --backup-output-dir=/mnt/encrypted/charitypilot/p107a-recovery --recovery-attestation-file=/secure/p107a-recovery-attestation.json --dry-run
npm run deploy:recover:p107a -- --production-env-file=.env.production --backup-output-dir=/mnt/encrypted/charitypilot/p107a-recovery --recovery-attestation-file=/secure/p107a-recovery-attestation.json
```

The wrapper shares the P1-09 orchestration and host-wide cutover lock. It
revalidates immutable env bytes, pulls the attested image, hashes all 21 exact
`migration.sql` files inside it, re-quiesces, and runs a terminal
repeatable-read/read-only invariant block through that image. Resolution is
refused unless history is exactly 20 distinct applied predecessors plus one
sole unresolved failed P1-07A target with matching selected-image checksums,
there is no target table/type/function/trigger/index residue, the P1-09
predecessor catalog and unchanged `SecurityAuditEventType` remain intact, and
all four active-principal legacy blocker counts are zero. Inactive-principal
rows are inventoried but are allowed only because those exact selected
migration bytes clear both legacy fields. The wrapper marks only the target
`--rolled-back`, then immediately delegates the complete locked production
deploy, including a new retained restore-verified backup, migration, status,
reminder reconciliation, startup, and public smoke. Any failure re-quiesces and
leaves runtime stopped; never use raw Compose, `--applied`, or direct
`_prisma_migrations` edits.

Deploy, rollback, P1-09 recovery, and P1-07A recovery acquire one host-wide production cutover lock before validation. Rollback and recovery pass that exact lock handle reentrantly into the delegated deploy, so no two cutover operations can interleave shutdown, backup, migration, probe, resolution, startup, or smoke. Contention fails before Docker or database work. Nested deploy entry and lock release both re-read the on-disk token and fail closed if the lock disappeared or ownership changed. A release or recovery failure preserves the preceding result but changes the command status to failure with explicit operator guidance; do not begin another cutover until the lock owner and runtime state are reconciled. After a process or host crash, treat a remaining lock as an incident artefact and remove it only after an operator has proved no deploy, rollback, or recovery process is running. Never bypass the lock with raw Compose commands.

For a bad digest promotion, prefer a corrected forward release. Image-only rollback remains exceptional and is limited to P107A-capable images: it requires the same `CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1` marker and a fresh (no more than 30 minutes old) operator attestation bound to the SHA-256 of the exact previous digest manifest. The marker is not trusted by itself. P1-07A retires the legacy `User` recovery slot, so a P1-09 image is behaviorally incompatible with a P107A database even though the old binary can parse much of the schema. Create a non-committed same-line attestation like this:

```json
{
  "kind": "charitypilot-schema-compatibility-attestation",
  "schemaVersion": 1,
  "environment": "production",
  "databaseCompatibility": "p107a-password-recovery-v1",
  "assessedAt": "2026-07-11T20:00:00.000Z",
  "rollbackDigestManifest": "release-image-digests.previous.env",
  "rollbackDigestManifestSha256": "<sha256-of-exact-manifest-bytes>",
  "evidenceReference": "change://approved-schema-compatibility-review",
  "operator": "named-operations-owner",
  "acknowledgement": "I confirm the selected application images are compatible with the live P1-07A database schema and migration history."
}
```

Then run:

```bash
npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env --schema-compatibility-attestation-file=/secure/schema-compatibility-attestation.json --backup-output-dir=/mnt/encrypted/charitypilot/rollback-cutovers
```

Rollback reuses the same maintenance-mode deploy path, including a unique new retained backup, migration isolation, fail-closed startup, and public smoke. It copies the production env file byte-for-byte into an owner-only temporary file and appends only validated rollback image/build-origin/compatibility overrides. After the selected migration image runs, deploy probes live Prisma history and, for P0-06-compatible schemas, runs the same reminder cutover/reconciliation gate before any runtime starts. P1-09 requires an exact pre-P107A restored backup and the internal `p109-restored` posture; it is never a same-line image rollback. Rolling farther back to `p006-deadline-calendar-v1` still requires the existing exact-manifest-and-backup-hash-bound pre-P1-09 restore attestation and retains the P0-06 reconciliation gate. A genuinely pre-P0-06 or markerless legacy rollback still requires the existing bounded restore proof before `pre-p006-restored` may skip the unavailable P0-06 job/schema gate. An env marker alone never authorises any path or skip.

Crossing an incompatible boundary is restore-and-redeploy, not image rollback. For P1-09, keep the runtime stopped and restore the exact protected backup captured before P1-07A. Bind the P1-09 compatibility line, exact P1-09 migration head, and absent P1-07A target migration in the non-committed JSON attestation:

```json
{
  "kind": "charitypilot-database-restore-attestation",
  "schemaVersion": 1,
  "environment": "production",
  "databaseRestoreCompleted": true,
  "runtimeStoppedDuringRestore": true,
  "backupCapturedBeforeIncompatibleMigration": true,
  "databaseRestoreCompletedAt": "2026-07-10T20:00:00.000Z",
  "backupReference": "encrypted-backup://approved-reference",
  "restoreEvidenceReference": "incident://approved-restore-evidence",
  "operator": "named-operations-owner",
  "rollbackDigestManifest": "release-image-digests.previous.env",
  "rollbackDigestManifestSha256": "<sha256-of-exact-manifest-bytes>",
  "restoredBackupSha256": "<sha256-of-exact-restored-backup-bytes>",
  "acknowledgement": "I confirm the production runtime was stopped and the database was restored from a backup captured before the incompatible migration.",
  "restoredDatabaseCompatibility": "p109-governance-integrity-v1",
  "restoredMigrationHead": "20260711230000_add_domain_invariants_referential_safety",
  "incompatibleMigration": "20260712013000_add_password_recovery_integrity",
  "p107aMigrationAbsent": true,
  "p109RestoreAcknowledgement": "I confirm the production runtime was stopped and the exact restored database backup ends at P1-09 before the P1-07A password recovery migration."
}
```

Then deliberately run:

```bash
npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env --database-restore-attestation-file=/secure/database-restore-attestation.json --restored-backup-file=/mnt/encrypted/charitypilot/pre-incompatible-migration/production-check.dump --backup-output-dir=/mnt/encrypted/charitypilot/restored-cutovers
```

The tool rejects future or more-than-30-minute-old attestations, hashes the exact rollback manifest and restored backup file, verifies both hashes, and probes the restored live migration history. The P1-09 path additionally requires every exact field above before it can propagate `p109-restored`. The older `p006-deadline-calendar-v1` and markerless/pre-P0-06 paths preserve their existing generic restore-attestation contract and reconciliation behavior; do not add P1-09 claims to an older restore. Any unknown non-empty marker fails closed even when restore evidence is supplied. The tool cannot prove the external restore itself occurred, so the named operator and restore evidence remain mandatory. Never commit the attestation, backup, database URL, or provider credentials.

## Environment

The API requires configured production values for database, Stripe, Resend, Supabase, and the frontend URL. `JWT_SECRET` must be at least 32 characters. `AUTH_RECOVERY_SECRET` must independently and canonically encode 32-64 random bytes as hex or unpadded base64url, must not be reused as `JWT_SECRET` or `READINESS_API_KEY`, and must be present in every API and scheduler runtime. Refresh tokens are opaque, stored hashed in `AuthSession`, and delivered only through HTTP-only cookies.

Fresh `npm run setup:production-env` output generates `JWT_SECRET`,
`READINESS_API_KEY`, and `AUTH_RECOVERY_SECRET` independently and sets the
current P1-07A compatibility marker. If an operator env file or secret source
predates P1-07A, do not rerun the generator with `--force`: it would replace the
whole file. Add a newly generated independent recovery secret through the
approved secret-store process, set
`CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1` separately,
and let preflight validate both without printing the secret.

The canonical production web origin is `https://app.charitypilot.ie` and the canonical production API origin is `https://api.charitypilot.ie`. The API runtime, deploy preflight, hosting check, provider check, and post-deploy smoke all reject apex-domain or arbitrary-subdomain drift for these public origins.

The web app requires only `NEXT_PUBLIC_API_URL=https://api.charitypilot.ie`; Docker Compose maps it through `CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL`, which must match `NEXT_PUBLIC_API_URL`, and deploy preflight requires the promoted image metadata to match it. `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET` remain in the API/server secret source only. Never expose a Supabase origin or storage capability to the web runtime or browser. Pass the selected production env file with `docker compose --env-file .env.production`.

Configure the API `FRONTEND_URL=https://app.charitypilot.ie` and `AUTH_COOKIE_DOMAIN=.charitypilot.ie` so auth cookies cover the canonical web and API subdomains. Do not use a single-host or apex-host production deployment unless the validators and launch evidence model are deliberately changed first.

## Hosting, DNS, And TLS

Run `npm run check:production:hosting -- --production-env-file=.env.production` before launch. The checker verifies the configured production web and API origins are exactly `https://app.charitypilot.ie` and `https://api.charitypilot.ie`, resolve through public DNS, present authorized TLS certificates with enough remaining lifetime, respond over HTTPS, and include baseline security headers. Record the redacted output in the launch evidence ledger.

## Database

For local/disposable migration verification only, use:

```bash
npm run db:migrate:deploy -w @charitypilot/api
```

Do not run that standalone command against production for P0-06. Production migration is owned by `npm run deploy:production`, which proves the old runtime is down and the pre-migration backup is restore-verifiable first. A managed platform replacement must implement and evidence the same quiesce, backup, isolated-migration, roll-forward, and restore-before-old-image contract.

Use managed PostgreSQL backups with point-in-time recovery enabled. Record the backup owner, schedule, retention, PostgreSQL RPO, and PostgreSQL RTO; confirm backup restore quarterly and record the evidence in `docs/production-launch-checklist.md`.

Never seed restore-sentinel application rows into production. `seed-restore-sentinel` is a disposable local/CI fixture only: it creates application records and is not production recovery evidence, and no remote override is supported. Production recovery proof is a two-step, non-mutating flow. First run the `--capture-source-identity --json` command above from a trusted shell and preserve its redacted output as an immutable external artifact. Then choose one recovery-set identifier and run the proof command with that independently captured SHA-256, an explicit encrypted output directory, `--keep-backup`, and `--json`. The proof holds one `REPEATABLE READ READ ONLY` source snapshot across canonical all-table capture and `pg_dump`, restores only into an internally constructed network-isolated ephemeral target, binds the dump and proof-report digests, and requires exact source/restored covered-schema, table-membership, row-count, and SHA-256 fingerprint equality. It accepts only the repository-approved `postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c` tools image and binds that identity into the report. Source workload and the custom-format dump are hard bounded, including a 64 GiB dump file-size ceiling and output-filesystem capacity preflight. Do not copy the expected source identity from the proof under test, do not store row values in evidence systems, and do not treat a marker without the bound JSON/report as evidence.

Replace `PROMOTED_RELEASE_COMMIT_SHA` in both commands above with the promoted lowercase full 40-character commit SHA. The checker binds its helper implementation to that release. For the second command, use the first command's `sourceDatabaseIdentitySha256` field as `--expected-source-database-identity-sha256`; do not substitute the SHA-256 of the JSON artifact itself.

The certified schema scope is deliberately narrow and machine-readable. It covers only the `public` schema; ordinary and partitioned table rows plus materialized-view rows; and public relations, columns, constraints, indexes, triggers, row-security policies, routines/bodies, types/domains/enums/ranges, sequence definitions and `OWNED BY` relations, extended statistics, and user rules. Non-public schemas, extension installation/membership metadata, comments/security labels, and database-level roles, tablespaces, settings, foreign-data wrappers/servers, publications, subscriptions, and event triggers are excluded and must not be claimed as certified. Supported extension-owned objects in `public` remain fingerprinted by definition. PostgreSQL large objects are excluded and the proof fails unless both source and restore contain zero. The report and launch evidence preserve this complete scope object rather than collapsing it into a generic `schema matched` claim.

The database result is consistency evidence, not provider provenance. Its exact limitation is: `This proof verifies a read-only source snapshot against one isolated restore. PostgreSQL ownership and ACL privileges are intentionally excluded by --no-owner and --no-privileges, sequence runtime state is excluded, and provider retention, immutable external custody, document-object recovery, and operator approval remain separate evidence.` The proof fails unless the public schema has zero sequences, identity columns, and `nextval` defaults; it therefore never implies that non-MVCC sequence values were captured. Preserve separate provider/operator evidence for roles, ownership, grants/default privileges, provider backup retention, and immutable custody. A launch proof must have been captured no more than 24 hours before final approval; an older but internally valid report is stale and cannot pass the launch evidence validator. Crashed labelled helper/restore containers are eligible for strict reaping only after the hard proof timeout plus grace period; active or bounded-age runs are never scavenged. Keep the source-identity capture, retained dump, proof report, provider backup policy, recovery operator/date/notes, and report SHA-256 outside git. The database proof does not cover Supabase object bytes; complete the joint document-recovery gate below with the same recovery-set identifier and database dump SHA-256. The database and document identity digests intentionally use different domains and must not be equated.

Supabase database backup/PITR does not back up Storage object bytes. Configure an independent encrypted, versioned document-object backup with an owned schedule, retention, RPO/RTO, monitoring/alerting, and secure deletion behavior; see `docs/supabase-production-setup.md`. Restore PostgreSQL metadata and document objects together into isolated non-production targets, bind them to one recovery-set identifier, and reconcile the independently captured source and restored metadata/object inventories by identity, key, size, and SHA-256. The launch evidence for `supabaseStorage.checks.supabase-restore-tested` must include the redacted verifier output, manifest and reconciliation digests, owner/date/notes, isolated targets, zero missing/unexpected/mismatch counts, and confirmation that neither production system was overwritten or mutated.

The v1 verifier deliberately rejects a vacuous zero-document exercise. Before the source capture, create and retain at least one approved non-sensitive QA document/object through the deployed application. Never introduce real charity data merely to make the proof pass. Keep that QA object present through the source backup, isolated database/object restore, complete inventory capture, and reconciliation. After the evidence artifacts have been finalized, remove it only through CharityPilot's normal authenticated document deletion flow and allow the audited deletion lifecycle to reach `PROCESSED`; never delete the database row or provider object out of band merely to tidy the rehearsal.

Build the versioned recovery manifest only from provider/operator exports. The repository helper is offline: it has no production client, never downloads objects, never changes either target, rejects secret-looking input, refuses output overwrite, and writes the final manifest atomically with owner-only permissions. Start its deliberately invalid build-input template in ignored or approved encrypted external storage:

```bash
npm run prepare:production:document-recovery-manifest -- template \
  --output-file=.charitypilot-launch-evidence/document-recovery-build-input.json \
  --json
```

Use provider-approved, read-only tooling outside this repository to export four JSON inventories for the same exercise and recovery-set identifiers. Capture each database inventory in one transaction so its `Document`, `DocumentStorageDeletion`, and `DocumentStorageDeletionRecovery` tables share the envelope's decimal `captureTransactionId`. The source metadata export must be taken from the immutable source database capture; the restored metadata export must be taken from the isolated restored database. `inventoryScope` must be `complete-document-and-storage-deletion-tables`; the three declared row counts must exactly match `rows`, `documentStorageDeletions`, and `documentStorageDeletionRecoveries`. A document row contains only `id`, `organisationId`, `fileUrl`, `fileSize`, and `mimeType`; deletion and recovery rows must contain the exact lifecycle/audit columns required by the committed release's `scripts/generate-document-recovery-manifest.mjs`. The generator rejects missing, extra, filtered, cross-tenant, chronologically impossible, or inconsistent rows.

Independently enumerate and download the source backup objects and isolated restored objects, stream each object through SHA-256 without logging its bytes, and produce object rows containing only `fileUrl`, `bytes`, and lowercase `sha256`. Object envelopes use `inventoryScope: "complete-whole-bucket"` and exact `bucketObjectCount`/`bucketTotalBytes` totals. Never put credentials, service-role keys, signed URLs, object bytes, or database connection strings in these files. A minimal metadata envelope shape is:

```json
{
  "kind": "charitypilot-document-metadata-inventory-export",
  "schemaVersion": 1,
  "captureRole": "source",
  "exerciseId": "EXERCISE_ID",
  "recoverySetId": "RECOVERY_SET_ID",
  "capturedAt": "2026-07-11T10:00:00.000Z",
  "inventoryScope": "complete-document-and-storage-deletion-tables",
  "documentRowCount": 1,
  "storageDeletionRowCount": 0,
  "recoveryEventRowCount": 0,
  "captureTransactionId": "123456",
  "rows": [
    {
      "id": "DOCUMENT_ID",
      "organisationId": "ORGANISATION_ID",
      "fileUrl": "ORGANISATION_ID/OBJECT_KEY",
      "fileSize": 1,
      "mimeType": "text/plain"
    }
  ],
  "documentStorageDeletions": [],
  "documentStorageDeletionRecoveries": []
}
```

Use `kind: "charitypilot-document-object-inventory-export"` for object inventories and `captureRole: "restored"` for isolated-restore envelopes. Complete every build-input field from immutable provider/operator evidence. In particular, database and object backup references must contain their exact artifact SHA-256 path segment, and `reconciliation.reportReferenceTemplate` must contain `{reconciliationReportSha256}` exactly once. Then generate the single privacy-preserving manifest; raw document, deletion, recovery-event, organisation, object-path, and MIME-type values are converted to canonical v1 digests and are not written to it:

```bash
npm run prepare:production:document-recovery-manifest -- build \
  --config-file=.charitypilot-launch-evidence/document-recovery-build-input.json \
  --source-metadata-file=/secure/recovery/source-metadata.json \
  --restored-metadata-file=/secure/recovery/restored-metadata.json \
  --source-object-inventory-file=/secure/recovery/source-objects.json \
  --restored-object-inventory-file=/secure/recovery/restored-objects.json \
  --output-file=.charitypilot-launch-evidence/document-recovery-manifest.json \
  --json
```

Retain the redacted generation result and all original source captures immutably outside git before verification. The output conforms to `scripts/charitypilot-document-recovery-manifest-v1.schema.json`, while `scripts/verify-document-recovery.mjs` remains authoritative for cross-field chronology, source bindings, digests, reconciliation, secret screening, and the 16 MiB serialized bound. The current certification ceiling is 5,000 documents, 10 MiB per object, and a 16 MiB manifest. If a complete production capture exceeds 5,000 documents or cannot fit within 16 MiB, stop: that is an external scale/certification blocker requiring a reviewed paginated or streaming v2 contract, not permission to sample or truncate.

Do not reuse the database restore checker's source-identity digest as `source.databaseIdentitySha256`. The database checker binds endpoint and server metadata under its own domain; this document manifest hashes `provider|projectRef|databaseName|schemaName` under `charitypilot:database-identity:v1`. Cross-bind the two exercises with the same `recoverySetId` and `databaseDumpSha256`, not identity-digest equality.

Run `npm run check:production:document-recovery` only with the complete 30-flag argument set printed by `--help` or exposed as `productionLaunchCommands.documentRecovery` by `npm run launch:status -- --json`. The recovery manifest belongs in the ignored `.charitypilot-launch-evidence/` directory or approved encrypted external storage. Every `--expected-*` digest, document/deletion/recovery-event count, capture timestamp, database capture transaction ID, proof-age bound, exercise ID, and recovery-set ID must come from the immutable independent source database/object-backup capture, not from the manifest being checked. Capture `--json` output outside git and bind its manifest, source, inventory, recovery-event, reconciliation, count, chronology, and objective fields into the launch evidence ledger. Record `isolationAttestationRecorded`, both production-not-overwritten attestation fields, and `restoreCredentialsScopedToTargetAttestationRecorded` as attestations only. The verifier checks their presence and internal consistency; it does not authenticate the operator claims or external source provenance, and `sourceProvenanceExternallyVerified` must remain `false`. A success result means `Document recovery reconciliation consistency passed against independently supplied bindings.` Retain the immutable capture report and provider/operator evidence for provenance and for the truth of those attestations.

## Jobs

In production, the API container does not run scheduled jobs in-process. The default Docker Compose stack runs a separate `production-scheduler` service, and the `jobs` profile exposes one-shot reminder and cleanup commands for rehearsal or platform scheduler integrations. Authentication delivery also has a standalone one-shot entrypoint in the selected API image for isolated rehearsal or an approved platform-scheduler replacement. The scheduler stops future timers on SIGTERM, waits up to `PRODUCTION_SCHEDULER_SHUTDOWN_TIMEOUT_MS` (45 seconds by default) for active runs, and has a 60-second Compose grace period:

```bash
node dist/jobs/production-scheduler.js
node dist/jobs/send-deadline-reminders.js
node dist/jobs/cleanup-document-storage.js
node dist/jobs/process-auth-email-delivery.js
```

The scheduled job runtime must receive the same production secret source that passed preflight. For Docker Compose, `production-scheduler` must be running after deploy, and the profile jobs must have successful test-run evidence. A platform scheduler that replaces Compose must implement the same technical quiescence contract: stop new invocations, await/cancel in-flight runs, prove no provider I/O remains active, and run the P0-06 cutover preparation/reconciliation gate before starting the promoted scheduler. Merely disabling a cron expression is insufficient.

Record scheduler ownership, command coverage for all four job entrypoints, an
isolated authentication-worker run, log capture, the two existing job-failure
alerts, and separate authentication-delivery anomaly alert plus incident-system
confirmation in `docs/production-launch-checklist.md`.

### Password-recovery delivery and security notices

Password-recovery links and post-reset notices are durable database work, not
fire-and-forget request side effects. Monitor `PasswordRecoveryRequest` and
`AuthSecurityEmailOutbox` for due `PENDING`, stale `SENDING`, and `UNCERTAIN`
rows. The worker may retry only the immutable row inputs through their recorded
delivery-template version and version-bound idempotency key; it must not mint a
replacement token, change a recipient, or mark an ambiguous provider outcome
accepted merely to clear a backlog. The provider payload is deterministically
rendered, not serialized in the row. Never edit the v1 security-email renderer
or its pinned HTML/plain-text hashes: introduce v2, write v2 on new rows, and
retain v1 until all v1 evidence has aged out. Keep `EMAIL_FROM` stable while any row can be retried,
because sender configuration is part of the provider payload but not row data.

An API or worker restart must leave the database-backed identifier/network
budgets and queued work intact. Ordinary recovery and dummy request rows become
cleanup-eligible after seven days, rate buckets after no more than 48 hours, and
cleanup is bounded to 500 rows per transaction. An unalerted rejected,
uncertain, key-unavailable, or stale-quarantined row is retained beyond that
ordinary window until operator-alert delivery is confirmed. The scheduler
claims those persisted rows with one count-only token, sends one aggregate
sanitized alert, acknowledges only a confirmed webhook response, and releases a
failed or ambiguous send for the next run. A crashed claim is reclaimable after
the bounded stale interval; concurrent schedulers cannot claim the same row.
Never purge an unexpired unterminated request, active provider claim, or
unacknowledged review row.

If the recovery store or queue is unavailable, the public route returns generic
temporary unavailability; it must not fall back to a process-local token. A
successful password reset remains successful if its already-enqueued notice is
later delayed or rejected. Do not repair recovery state with ad-hoc SQL. Restore
the worker, preserve the exact rows, and follow the incident owner’s reviewed
provider evidence.

### Document-deletion dead letters

Document-object deletion is a durable bounded lifecycle, not an infinite hourly retry. The cleanup job makes at most five attempts with deterministic exponential backoff; permanently invalid tenant paths dead-letter on the first attempt. Monitor both `DOCUMENT_STORAGE_CLEANUP_FAILED` (job failure) and `DOCUMENT_STORAGE_DELETION_DEAD_LETTERED` (one or more deletion records require review). A successfully delivered dead-letter alert is acknowledged against its exact claim token so the same row is not alerted on every scheduler run; a failed alert delivery releases the claim for retry.

Do not repair a dead letter with ad-hoc SQL or a direct provider-object mutation. Active entitled tenant owners/admins may only `REQUEUE_UNCHANGED` through the authenticated API, and a permanently rejected path cannot use that disposition. Corrected-path recovery and externally evidenced completion are reserved for the one-shot named platform-operator CLI. Follow the dry-run/review/execute procedure in `docs/architecture/06-document-storage.md`: use the exact production env file, confirm the allowlisted database authority, review attempts/terminal reason and the returned authority/path digests, and copy the target-bound execution confirmation exactly. `COMPLETE_EXTERNALLY_REMEDIATED` records externally proven deletion; it does not claim the provider delete happened inside CharityPilot.

Before launch, prove the migration is deployed, both alert codes reach the incident system, and the documented recovery procedure works against an isolated non-production rehearsal. Do not manufacture a production dead letter merely to create evidence. Retain the named operator, reason, dry-run/execute redacted outputs, external provider evidence where applicable, and append-only `DocumentStorageDeletionRecovery` event reference outside git.

## Storage

Use a private Supabase Storage bucket. Documents are saved as tenant-scoped storage paths and downloaded only through the authenticated `/api/v1/documents/:id/download` byte proxy. The service role remains server-only; the API never returns storage paths, provider URLs, or bearer capabilities to the browser.

Follow `docs/supabase-production-setup.md` before launch. Public monitoring can check `/api/v1/health`; detailed dependency readiness at `/api/v1/health/readiness` must include the internal `x-charitypilot-readiness-key` header. Confirm the keyed readiness response reports `storageConfigured: true` and `storageBucketReachable: true`.

Run `npm run check:production:supabase -- --production-env-file=.env.production` from a trusted shell that can read the production Supabase service role key. The checker verifies the configured bucket is private, uploads a tiny non-sensitive probe object, downloads it through the authenticated service-role path, confirms anonymous direct access is denied, and deletes the probe. Output is redacted and must not be used to store service role keys, object paths, or provider payloads.

## Browser QA

Run `docs/production-browser-qa.md` against the deployed HTTPS production URL and supported mobile devices. Localhost QA does not prove production DNS, TLS, cookies, CORS, security headers, storage downloads, or live provider integrations.

For automated deployed browser evidence, use an approved non-sensitive owner/admin test workspace and supply credentials from the secret store. Record redacted command output in `.charitypilot-launch-evidence/production-launch-evidence.json`; do not record the credential values themselves.

Before running Playwright, verify the deployed QA shell without printing credential values:

```bash
E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run check:production:browser-qa-env
```

```bash
E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:responsive

E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e -- tests/accessibility.spec.ts

E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:deployed:responsive:cross-browser

E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:deployed:accessibility:cross-browser
```

The launch evidence validator requires the redacted deployed browser QA environment preflight transcript in `browserQa.checks.browser-qa-completed`, including `npm run check:production:browser-qa-env` and `Deployed browser QA environment preflight passed`. It also requires deployed responsive and accessibility command transcripts, `E2E_DEPLOYED_QA=true`, the canonical web/API URLs, and references showing `E2E_OWNER_EMAIL` and `E2E_OWNER_PASSWORD` came from the approved secret store. Record the deployed accessibility transcript in `browserQa.checks.accessibility-coverage`, the cross-browser transcripts in `browserQa.checks.cross-browser-coverage`, and real-device or cloud-device iOS Safari proof in `browserQa.checks.ios-safari-device-coverage`.

## Incident Basics

Rotate `JWT_SECRET`, Supabase service role keys, Stripe secrets, and Resend keys
after suspected exposure under their owned incident procedures. Never replace
`AUTH_RECOVERY_SECRET` in place. That key can reconstruct queued tokens, while
already accepted, uncertain, legacy-slot and personal-operator links remain
usable from their stored hashes. Changing only the environment value does not
invalidate those capabilities.

Use the restricted `auth-recovery-secret-rotation` maintenance command before
changing `AUTH_RECOVERY_SECRET`. It terminates every non-suppressed,
unterminated recovery capability as `KEY_ROTATED`, quarantines any residual
`SENDING` claim as `UNCERTAIN`, clears both halves of every legacy `User` reset
slot, deletes the keyed recovery-rate buckets, one-way redacts every retained
identifier/IP/network keyed digest, and deliberately preserves the post-reset
`AuthSecurityEmailOutbox`. The same transaction advances the singleton recovery
generation and leaves recovery blocked with no active key fingerprint. Every
request, reset, worker, cleanup, and review-alert transaction locks that control
row first and refuses a blocked or non-active key, closing the replace/restart
window. All mutations and postcondition checks run in one serializable,
table-locked transaction.

1. Open an approved incident/change record with a named operator and choose
   exactly `PLANNED_KEY_ROTATION` or `SUSPECTED_KEY_COMPROMISE`.
2. Stop the public API, web runtime and production scheduler. Confirm shutdown
   completed and no authentication-email provider call remains in flight. Do
   not use the command's quiescence flag as a substitute for this evidence.
3. Capture and restore-verify a protected encrypted database backup using the
   database procedure above. Label it as a pre-invalidation credential-bearing
   snapshot. A runtime must never be started against that restore until this
   invalidation command has been run again on the isolated restored database.
4. Run the read-only review below with the still-current secret source. It
   prints only counts, the exact deployment profile, a redacted canonical
   database-identity SHA-256, a case-reference SHA-256, and the exact execution
   acknowledgement. It prints no user, request, recipient, token, database URL
   or secret value.

```bash
docker compose --env-file .env.production -f compose.production.yml --profile maintenance run --rm --no-deps auth-recovery-secret-rotation \
  node dist/jobs/rotate-auth-recovery-secret.js \
  --dry-run \
  --reason SUSPECTED_KEY_COMPROMISE \
  --operator "NAMED OPERATOR" \
  --case-reference "APPROVED-CASE-REFERENCE" \
  --confirm-api-and-scheduler-quiesced
```

5. Independently confirm the database-identity digest and `production` profile,
   review all five counts and the current generation, then copy them and the emitted acknowledgement into
   the execute command. Equal counts are insufficient: execution refuses a
   changed database fingerprint or deployment profile.

```bash
docker compose --env-file .env.production -f compose.production.yml --profile maintenance run --rm --no-deps auth-recovery-secret-rotation \
  node dist/jobs/rotate-auth-recovery-secret.js \
  --execute \
  --reason SUSPECTED_KEY_COMPROMISE \
  --operator "NAMED OPERATOR" \
  --case-reference "APPROVED-CASE-REFERENCE" \
  --confirm-api-and-scheduler-quiesced \
  --confirm-outbox-preservation-understood \
  --expected-generation REVIEWED_GENERATION \
  --expected-capabilities REVIEWED_COUNT \
  --expected-request-evidence-rows REVIEWED_COUNT \
  --expected-legacy-slots REVIEWED_COUNT \
  --expected-rate-buckets REVIEWED_COUNT \
  --expected-security-notices REVIEWED_COUNT \
  --expected-database-identity-sha256 REVIEWED_SHA256 \
  --expected-deployment-profile production \
  --confirm-execute "COPY THE EXACT DRY-RUN ACKNOWLEDGEMENT"
```

6. `EXECUTED` must report `recoveryBlocked: true`, the reviewed and blocked
   generations, and zero `remainingCapabilities`,
   `remainingRequestEvidenceRows`, `remainingLegacySlots`, and
   `remainingRateBuckets`. Create a new independent canonical 32-64-byte secret
   in the approved secret store and update every API/scheduler secret source
   without printing either value. Do not start those runtimes yet.
7. With the replacement secret injected only into the restricted maintenance
   container, activate the exact blocked generation. The command rejects any
   key present in the append-only retired-fingerprint history, a changed
   database/profile/generation, or any non-zero rotation
   postcondition:

```bash
docker compose --env-file .env.production -f compose.production.yml --profile maintenance run --rm --no-deps auth-recovery-secret-rotation \
  node dist/jobs/rotate-auth-recovery-secret.js \
  --activate-after-replacement \
  --reason SUSPECTED_KEY_COMPROMISE \
  --operator "NAMED OPERATOR" \
  --case-reference "APPROVED-CASE-REFERENCE" \
  --confirm-api-and-scheduler-quiesced \
  --expected-generation BLOCKED_GENERATION \
  --expected-database-identity-sha256 REVIEWED_SHA256 \
  --expected-deployment-profile production \
  --confirm-activate "COPY THE EXACT ACTIVATION ACKNOWLEDGEMENT"
```

8. Only after `ACTIVATED` reports the exact generation and
   `recoveryBlocked: false` may production preflight and runtime startup proceed.
   Prove login, a new recovery request, reset consumption, and the preserved
   completion-notice worker. An old-key process must fail the database fence.

Retain the named operator, reason, case digest/reference in the restricted
incident system, protected backup reference and digest, selected image/commit,
dry-run and execution count-only outputs, database/profile binding, new
secret-store version reference (never the value), preflight, restart and smoke
evidence. Do not record raw secrets, recipient addresses, tokens, request IDs or
account IDs. A normal worker-side timing-safe mismatch remains a
`KEY_UNAVAILABLE` fail-closed guard, but it is not a substitute for this bulk
rotation procedure.

Password reset invalidates all active sessions and outstanding recovery links for that user, records an immutable event, and queues a registered-address security notice.

Run `npm run check:production:observability -- --production-env-file=.env.production` before launch from a trusted shell. The checker verifies `ERROR_ALERT_WEBHOOK_URL` is an HTTPS public destination, resolves through public DNS, accepts the same sanitized JSON payload shape used by API and job error alerts, and keeps the secret webhook URL out of output. Confirm the received alert in the external incident system and record the redacted evidence reference in the launch ledger.

## Billing And Email

Run `npm run check:production:providers -- --production-env-file=.env.production` from a trusted shell before launch. The checker verifies the four configured Stripe price IDs exist as active live recurring prices, confirms an enabled live Stripe webhook endpoint targets `/api/v1/billing/webhooks` on the configured production API origin, and confirms the Resend sender domain from `EMAIL_FROM` is verified. Output is redacted and must not be used to store Stripe or Resend secrets.

Before launch, prove through the deployed application that one recovery-link
email and one post-reset security notice are accepted from the verified sender,
include deterministic HTML and plain-text alternatives, point only to the
canonical frontend origin where applicable, and carry no raw token in provider
logs or repository evidence. The recovery text alternative must contain the
complete fragment link for clients that do not render HTML. Separately prove that known,
unknown, inactive, suppressed, rejected, and uncertain forgot-password outcomes
remain response-equivalent and that the durable abuse budgets survive an API
restart or second replica.

## Release Gate

Code readiness is not the full production gate. Do not launch with real charity data until hosting, DNS/TLS, secrets, backups, monitoring alerts, legal documents, deployed browser QA, and external security review are complete and recorded in `docs/production-launch-checklist.md`.

Before launch, materialize a non-committed `.charitypilot-launch-evidence/production-launch-evidence.json` file from the external evidence ledger. Use `node scripts/platform-completion-audit.mjs --json` when an operator dashboard or agent handoff needs current machine-readable route, backend, launch, compliance, and next-action audit data without rewriting the committed Markdown audit ledger. Start from `npm run check:production:evidence:init`; add `-- --json` when automation needs machine-readable init status, evidence path, and follow-up commands. Use the generated `requiredEvidenceHints` fields as non-secret prompts, and run `npm run check:production:evidence:status -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json` as you gather evidence to see the area-by-area completion count and the next incomplete checks. Use `npm run check:production:evidence:status -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json` for progress dashboards or operator handoff automation. Replace every placeholder from external evidence systems, run `npm run check:production:release-run -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json` to verify the referenced GitHub Actions release run and `release-image-digests` artifact through the GitHub API, and record that redacted command output. Add `--json` to the release-run checker when CI or an operator dashboard needs machine-readable workflow identity, release binding, artifact name, pass/fail, and issue details. Then run `npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json`. Add `--json` to the strict validator when CI or a launch dashboard needs machine-readable pass/fail, issue count, issue list, completion percentages, and the next incomplete checklist items with evidence hints. The status commands are only progress views; the release-run checker and strict validator are launch gates. The validator requires all launch checklist areas, every machine-readable checklist check including `legalAndCompliance.checks.solicitor-governance-privacy-review`, dated external evidence references, final signoff, and separate `finalSignoff.approvals` entries for engineering, operations, security, legal/compliance, and business owners. It also requires a `release` block binding the evidence to the promoted commit SHA, GitHub Actions release workflow run URL, `.github/workflows/release-images.yml`, a release ref of `refs/heads/master` or `refs/tags/v*`, digest-pinned API/web/migration image refs, and web image build origins from `release-image-digests.env`. It rejects placeholders, local URLs, and raw secret-looking values so evidence capture does not accidentally become secret storage.

For the final launch gate, upload the completed non-secret evidence file as a `production-launch-evidence` artifact with the protected `.github/workflows/upload-production-launch-evidence.yml` workflow. From the trusted workstation that holds the ignored evidence file, run `npm run prepare:production:evidence-upload -- --json | gh workflow run upload-production-launch-evidence.yml --ref master --json`. The helper gzip-compresses and base64-encodes the evidence JSON, calculates its SHA-256, and sends only workflow inputs; the workflow decodes the JSON, verifies the SHA-256, confirms the file parses as a JSON object, and uploads the artifact without committing it to git. If GitHub rejects the workflow-dispatch payload because the compressed evidence is too large, reduce stored transcript size to external evidence references or use another controlled, non-git artifact path approved by operations.

After the upload workflow succeeds, manually run `.github/workflows/production-launch-evidence.yml` from the protected production environment. Provide the successful upload workflow run id as `evidence_artifact_run_id`, keep `evidence_artifact_name` as `production-launch-evidence` unless the artifact was named differently, and keep `evidence_file_name` as `production-launch-evidence.json` unless the artifact contains a different filename. The workflow reruns `check:production:release-run` and `check:production:evidence`, captures each command status, and uploads the redacted `production-launch-evidence-validation` artifact even when validation fails. That artifact must include `production-launch-evidence-validation.log`, `production-release-run-evidence.json`, and `production-launch-evidence-validation.json` so final signoff can cite both the human transcript and machine-readable release/evidence validation outputs.
