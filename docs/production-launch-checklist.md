# CharityPilot Production Launch Checklist

Use this checklist as the top-level launch evidence ledger. Keep every item open until the named production evidence exists outside git or in the deployment system. Do not record secret values in this document.

## Evidence Rules

- Record owners, dates, command output locations, ticket links, deployment links, or report references.
- Keep screenshots, private reports, and secrets out of the repository.
- Machine-readable evidence entry references must use HTTPS URLs on approved evidence hosts, currently `*.charitypilot.ie` or the canonical `github.com/jasperfordesq-ai/charity-governance` repository.
- Do not use signed URLs or token-bearing query strings as machine-readable evidence references.
- Checklist evidence may be gathered after the package `preparedAt` timestamp, but every checklist evidence entry must be captured no later than `finalSignoff.approvedAt`.
- Run all checks against the deployed HTTPS production URL, not localhost.
- Treat a passing code release gate as necessary but not sufficient for launch.

## Launch Summary

| Area | Required evidence | Status |
| --- | --- | --- |
| Release gate | Command output for all release checks | Open |
| Secrets and env | Passing preflight against real secret source | Open |
| Hosting and DNS/TLS | Public web/API URLs with valid TLS | Open |
| Database | Production migration and backup evidence | Open |
| Supabase storage | Private bucket, authenticated service-role read/anonymous-denial proof, backup, and restore verification | Open |
| Jobs | Scheduler or explicit in-process job decision | Open |
| Billing and email | Live Stripe webhook and Resend send evidence | Open |
| Observability | Alert destination and test alert evidence | Open |
| Legal and compliance | Approved production policies and owner signoff | Open |
| Browser QA | Desktop and mobile deployed QA run | Open |
| Security review | External penetration test report reference | Open |

## 1. Release Gate

- [ ] `npm ci` completed on the release build machine.
- [ ] `npm run db:generate -w @charitypilot/api` completed.
- [ ] `npx prisma validate --schema apps/api/prisma/schema.prisma` completed.
- [ ] `npm run lint` completed.
- [ ] `npm run test` completed.
- [ ] `npm run build -w @charitypilot/shared` completed.
- [ ] `npm run build -w @charitypilot/api` completed.
- [ ] `npm run build -w @charitypilot/web` completed.
- [ ] `npm audit --omit=dev --audit-level=moderate` completed with no moderate-or-higher production vulnerabilities.
- [ ] `npm run check:production -- --production-env-file=.env.production` completed against the real production secret source.
- [ ] `npm run check:production:github-env -- --environment=production` completed before release image promotion, proving GitHub `production` has the required public web build variables without reading secret values.
- [ ] `npm run check:production:github-secrets -- --environment=production` completed if GitHub `production` is the approved secret store, proving the required production secret names exist without reading secret values.
- [ ] `npm run deploy:preflight -- --production-env-file=.env.production` completed with digest-pinned API, web, and migration images.
- [ ] Before scheduling downtime, the exact digest-pinned P0-06 migration and API images were rehearsed against a recent isolated restore of production. Evidence records clone age/source, confirms the live target was never used, proves no range/tenant/renamed/duplicate/AGM-evidence/id-collision migration blocker, inventories every legacy reminder ambiguity through the restricted tool, rehearses the immutable reconciliation decisions, and records isolated-clone destruction. Any anomaly was resolved through an approved production data plan and re-rehearsed on a newer clone.
- [ ] `npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=<approved-encrypted-path>` completed on the production Docker host using `compose.production.yml`, `release-image-digests.env`, and digest-pinned images. Evidence shows preflight/pull before downtime; old API/web/scheduler/jobs/proxy down before backup and migration; a retained restore-verified backup with owner-only permissions; migration alone; live Prisma-history probe; quiesced reminder preparation; zero unresolved reminder blockers; promoted-runtime startup; and no automatic old-image fallback. Record either the default Caddy/TLS overlay evidence with `compose.production-tls.yml`, or managed-load-balancer/hosting TLS evidence with `--no-tls-proxy`.
- [ ] The deploy command's post-deploy public HTTPS smoke completed against the production web and API origins.
- [ ] Rollback rehearsal proves an image-only rollback is accepted only when the previous manifest declares `CHARITYPILOT_DATABASE_COMPATIBILITY=p006-deadline-calendar-v1`, a fresh `--schema-compatibility-attestation-file` matches the exact manifest SHA-256, a protected `--backup-output-dir` is supplied, and the live Prisma migration-history probe passes before runtime start. A pre-P0-06/legacy manifest fails closed without a fresh manifest-and-backup-hash-bound `--database-restore-attestation-file` plus the exact `--restored-backup-file`. Any cross-boundary rehearsal uses an isolated restored database and post-rollback public HTTPS smoke proof. Evidence also confirms the original production env bytes survive unchanged, the owner-only temporary merged env is removed and redacted, and any cleanup-failure recovery command references the durable original env rather than the deleted temporary file.
- [ ] Each cutover backup occupies a unique child under approved encrypted storage and cannot overwrite an earlier deploy's dump; its SHA-256, off-host copy/reference, retention owner/window, secure-deletion date, access controls, and restore result are recorded outside Git. Native-Linux uid/gid ownership and local `0700`/`0600` modes do not substitute for encryption or P0-10 joint database/object recovery evidence.
- [ ] Deployment evidence shows the host-wide production cutover lock was acquired before preflight/attestation validation, shared reentrantly by rollback and delegated deploy, rejected a concurrent rehearsal before Docker/database work, and was released after success/failure. Reentrant entry and release prove the persisted token still matches; missing/tampered ownership and release failures return structured fail-closed errors without discarding the preceding result. Any crash-stale lock removal names the operator and proof that no cutover process remained.
- [ ] `cosign signature verification` passed for all promoted image digests.
- [ ] The release workflow evidence identifies `.github/workflows/release-images.yml` and a release ref of `refs/heads/master` or `refs/tags/v*`.
- [ ] `npm run check:production:release-run -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json` verified the GitHub Actions run metadata and `release-image-digests` artifact through the GitHub API.
- [ ] `npm run check:production:release-run -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json` was captured when machine-readable release workflow identity, artifact, release binding, and issue details were needed for operator handoff automation.
- [ ] `npm run prepare:production:evidence-upload -- --json | gh workflow run upload-production-launch-evidence.yml --ref master --json` uploaded the completed non-secret evidence JSON as a protected `production-launch-evidence` artifact without committing it to git.
- [ ] The successful `upload-production-launch-evidence.yml` run id was used as `evidence_artifact_run_id` for `.github/workflows/production-launch-evidence.yml`.
- [ ] The protected `production-launch-evidence-validation` artifact uploads even on validation failure and contains `production-launch-evidence-validation.log`, `production-release-run-evidence.json`, and `production-launch-evidence-validation.json`.
- [ ] Release image digest manifest artifact `release-image-digests.env` was downloaded from the signed release workflow and used as the promoted image source.
- [ ] The release manifest's web image build origins match the promoted production public origins.
- [ ] `npm run check:production:evidence:init` was used to create `.charitypilot-launch-evidence/production-launch-evidence.json` as the starting schema for the non-committed external launch evidence ledger.
- [ ] `npm run check:production:evidence:init -- --json` was captured when machine-readable init status, evidence path, and follow-up status/validation commands were needed for operator handoff automation.
- [ ] `npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json` passed against the machine-readable external launch evidence ledger.
- [ ] `npm run check:production:evidence -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json` was captured for machine-readable strict validation status, issue list, completion counts, and next incomplete evidence hints.
- [ ] Machine-readable launch evidence includes command-output entries for `npm ci`, Prisma generation/validation, lint, tests, workspace builds, and production dependency audit.

Progress helper: while filling the non-committed evidence file, run `npm run check:production:evidence:status -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json` to see area-by-area completion and the next incomplete checks. Use `npm run check:production:evidence:init -- --json` for machine-readable evidence-template initialization and `npm run check:production:evidence:status -- --json --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json` for progress dashboards or operator handoff automation. The GitHub production environment and secret-store checkers also accept `--json` when an operator dashboard needs required-name and missing-name status without printing provider values. The strict launch gate is still `npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json`; add `--json` to that strict validator when CI or a launch dashboard needs machine-readable pass/fail, issue count, issue list, completion percentages, and the next incomplete checklist items with evidence hints.

Evidence:

| Field | Value |
| --- | --- |
| Owner | |
| Date | |
| Build identifier | |
| Release workflow run URL | |
| Release workflow file | `.github/workflows/release-images.yml` |
| Release git ref | |
| GitHub API release-run verification output | |
| Evidence location | |
| Digest-pinned image refs | |
| Web image build origins | |

## 2. Secrets And Environment

- [ ] Real production values were created from `.env.production.example`.
- [ ] `.env.production` or the platform-generated equivalent is excluded from git.
- [ ] `NODE_ENV=production` is set for the API, web app, and scheduled job runtime.
- [ ] `JWT_SECRET` is high entropy and at least 32 characters.
- [ ] `FRONTEND_URL=https://app.charitypilot.ie` and `NEXT_PUBLIC_API_URL=https://api.charitypilot.ie`.
- [ ] `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET` are available only to API/server runtimes and are absent from the web runtime and browser bundle.
- [ ] `CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL` is set for Docker Compose and matches `NEXT_PUBLIC_API_URL`.
- [ ] `AUTH_COOKIE_DOMAIN=.charitypilot.ie` covers the canonical web and API subdomains.
- [ ] Stripe keys are live-mode production keys; the four price IDs are distinct, and `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` identifies the approved dedicated live portal configuration.
- [ ] Resend sender domain is verified for production sending.
- [ ] Supabase service role key is stored only in the API secret store.
- [ ] Machine-readable launch evidence names each required secret/origin fact without recording raw secret values.

Evidence:

| Field | Value |
| --- | --- |
| Secret store path | |
| Preflight output location | |
| Rotation owner | |

## 3. Hosting, DNS, And TLS

- [ ] Web app is deployed at `https://app.charitypilot.ie`.
- [ ] API is deployed at `https://api.charitypilot.ie`.
- [ ] DNS records are managed by the approved owner, with `app.charitypilot.ie` and `api.charitypilot.ie` record evidence.
- [ ] TLS certificates are valid for the web and API origins, with certificate issuer and expiry date recorded.
- [ ] API CORS allows only the canonical `FRONTEND_URL` origin and rejects an unapproved origin probe.
- [ ] Security headers are present on API responses, including HSTS max-age evidence.
- [ ] `npm run check:production:hosting -- --production-env-file=.env.production` completed from a trusted shell and recorded redacted evidence.
- [ ] Machine-readable launch evidence names the canonical web/API origins, DNS owner, TLS validity, CORS restriction, and security headers.

Evidence:

| Field | Value |
| --- | --- |
| Web URL | |
| API URL | |
| DNS owner | |
| DNS record evidence | |
| TLS evidence location | |
| TLS issuer/expiry | |
| CORS rejection evidence | |
| Security header/HSTS evidence | |

## 4. Database And Migrations

- [ ] Production PostgreSQL database is provisioned.
- [ ] Production `DATABASE_URL` is present only in the secret store.
- [ ] The `npm run deploy:production` transcript proves the digest-pinned migration image completed alone after bounded runtime quiescence and restore-verified backup; live Prisma history passed; quiesced reminder cutover preparation released residual reservations, quarantined interrupted provider I/O, and found no unresolved ambiguity; only then did API/web/scheduler start. Do not run the standalone workspace migration command against production for P0-06.
- [ ] `npm run check:production:database -- --production-env-file=.env.production --capture-source-identity --json --expected-release-commit-sha=PROMOTED_RELEASE_COMMIT_SHA` completed from a trusted shell after replacing the release placeholder with the promoted lowercase full 40-character SHA; its redacted source-identity digest was stored immutably outside git before the restore proof ran.
- [ ] `npm run check:production:database -- --production-env-file=.env.production --recovery-set-id=RECOVERY_SET_ID --expected-source-database-identity-sha256=EXTERNAL_SHA256 --expected-release-commit-sha=PROMOTED_RELEASE_COMMIT_SHA --backup-output-dir=/mnt/encrypted/charitypilot/recovery/RECOVERY_SET_ID --keep-backup --json` completed after replacing the release placeholder with the promoted lowercase full 40-character SHA, using the independently captured identity digest, and recorded the retained dump/proof-report SHA-256 values. The absolute path is an operator example, not proof of encryption; separately evidence the approved encrypted filesystem, access controls, off-host custody, retention, and deletion policy.
- [ ] Managed backups or point-in-time recovery are enabled with backup window, retention period, backup owner, PostgreSQL RPO, and PostgreSQL RTO recorded outside git.
- [ ] The database proof confirms one snapshot-bound `REPEATABLE READ READ ONLY` capture, a network-isolated ephemeral non-production restore target, exact source/restored certified-scope/table/row SHA-256 equality, zero mismatches, stable dump bytes, verified cleanup, bounded source workload, a pre-enforced 64 GiB dump ceiling/capacity check, and no production write or overwrite path. Evidence binds the exact approved tools-image digest and the full machine-readable schema certification scope.
- [ ] Database scope is not overclaimed: only `public` relations/columns/constraints/indexes/triggers/policies/routines/types/sequence definitions/extended statistics/user rules and ordinary/partitioned/materialized-view rows are certified. Non-public schemas, extension membership, comments/security labels, and database-level objects are explicit exclusions; large objects are excluded and must have a zero source/restore count.
- [ ] Database proof limitations are recorded exactly: PostgreSQL role ownership and ACL/default privileges are excluded by `--no-owner --no-privileges`; non-MVCC sequence runtime state is excluded; and the proof fails unless public sequences, identity columns, and `nextval` defaults are all zero. Separate provider/operator evidence covers ownership, grants/default privileges, and recovery custody.
- [ ] The database proof was captured no more than 24 hours before final approval; an older report cannot be reused for a current launch ledger.
- [ ] Restore test evidence exists with owner, restore date, recovery notes, the shared recovery-set identifier, immutable source-identity capture, retained dump/proof report, and the exact database-proof provenance limitation.
- [ ] Machine-readable launch evidence binds PostgreSQL provisioning, secret-store ownership, migration output, backup/PITR coverage, backup ownership, source identity, dump/report/fingerprint digests, recovery set, restore date, recovery notes, and production-not-overwritten proof.

Evidence:

| Field | Value |
| --- | --- |
| Migration output location | |
| Backup policy location | |
| Backup window/retention/owner/RPO/RTO | |
| Immutable source-identity capture location and SHA-256 | |
| Recovery-set identifier | |
| Retained dump location and SHA-256 | |
| Restore-proof report location and SHA-256 | |
| Source/restored database fingerprint SHA-256 | |
| Restore owner/date/recovery notes | |

## 5. Supabase Storage

- [ ] Supabase production project is separate from local or staging projects.
- [ ] `documents` bucket exists or `SUPABASE_STORAGE_BUCKET` points to the approved private bucket.
- [ ] Bucket is private.
- [ ] `npm run check:production:supabase -- --production-env-file=.env.production` completed from a trusted shell and recorded redacted evidence.
- [ ] API readiness endpoint reports `storageConfigured: true` when called with `x-charitypilot-readiness-key`.
- [ ] API readiness endpoint reports `storageBucketReachable: true` when called with `x-charitypilot-readiness-key`.
- [ ] Document upload and authenticated API byte download are verified through the deployed app without exposing a provider URL or object path.
- [ ] At least one approved non-sensitive QA document/object exists through the source backup, isolated database/object restore, complete inventory capture, and reconciliation; no real charity data was introduced merely to satisfy the proof. After evidence finalization, cleanup uses the normal authenticated document deletion flow and the audited deletion lifecycle reaches `PROCESSED`, with no out-of-band database-row or provider-object deletion.
- [ ] A separate encrypted, versioned backup of the actual document object bytes exists in an approved independent destination; PostgreSQL/Supabase database backup or PITR evidence is not accepted as object-byte backup evidence.
- [ ] Document-object backup evidence records schedule, owner, retention, RPO, RTO, monitoring/last-success proof, failure alerting, and secure deletion behavior outside git.
- [ ] A joint PostgreSQL-metadata and document-object restore was completed against isolated non-production targets and bound to one recovery-set identifier.
- [ ] Every source `Document` row and independently inventoried object was reconciled to restored metadata and bytes by canonical identity, object key, size, and SHA-256, with zero missing, unexpected/orphan, metadata, key, size, or checksum mismatches.
- [ ] `npm run prepare:production:document-recovery-manifest -- template --output-file=.charitypilot-launch-evidence/document-recovery-build-input.json --json` created the deliberately invalid, non-secret operator template in ignored or approved encrypted external storage.
- [ ] Provider-approved read-only tooling exported complete versioned source/restored database envelopes from one transaction per capture. Each envelope includes the exact `Document`, `DocumentStorageDeletion`, and `DocumentStorageDeletionRecovery` inventories, their declared counts, the capture transaction ID, exercise/recovery-set IDs, and `inventoryScope: "complete-document-and-storage-deletion-tables"`. The object export independently enumerated, downloaded, and SHA-256 hashed every source/restored whole-bucket object into versioned envelopes (`fileUrl`, `bytes`, `sha256`) without storing credentials, signed URLs, or object bytes in JSON.
- [ ] `npm run prepare:production:document-recovery-manifest -- build` ingested all four envelopes, rejected no rows as out of bounds, wrote the one hashed manifest atomically with owner-only permissions, and its captured JSON result supplied canonical inventory/source-binding/reconciliation digests from the independently retained captures.
- [ ] The complete production capture contains at most 5,000 documents, each object is at most 10 MiB, and the generated manifest is at most 16 MiB. If production exceeds 5,000 documents or the manifest exceeds 16 MiB, launch remains blocked pending a reviewed streaming/paginated v2 certification contract; sampling or truncation is forbidden.
- [ ] The database restore checker identity digest was not reused as the document manifest database identity. The exercises are cross-bound by equal `recoverySetId` and `databaseDumpSha256`; the document manifest separately computes `charitypilot:database-identity:v1` from `provider|projectRef|databaseName|schemaName`.
- [ ] The joint recovery verifier reported `Document recovery reconciliation consistency passed against independently supplied bindings.` using all 30 mandatory independent bindings: immutable source-capture report and database/object identities; source/restored document, deletion, recovery-event, and object inventory digests/counts; capture timestamps and database transaction IDs; proof-age bound; exercise/recovery-set IDs; and backup/reconciliation digests. Its redacted output and reconciliation report SHA-256 are stored outside git. This is a consistency check; real source provenance and the recovery exercise still require external evidence. Supply every `--expected-*` value from the independent source capture, never by copying it from the recovery manifest under test:

```bash
npm run launch:status -- --json
npm run check:production:document-recovery -- --help
```

Copy `productionLaunchCommands.documentRecovery` from the launch-status JSON,
replace every `EXTERNAL_*` placeholder from the independent source capture, and
run it unchanged. It is generated from the verifier's complete set of 30
mandatory `--expected-*` binding flags; omitting even one flag is a usage error.

- [ ] A named operator's external evidence confirms both production systems were not overwritten or mutated and that restore credentials were target-scoped. The verifier output records `isolationAttestationRecorded`, both production-not-overwritten attestation fields, and `restoreCredentialsScopedToTargetAttestationRecorded`; it does not authenticate those attestations, and `sourceProvenanceExternallyVerified` remains `false`.
- [ ] Machine-readable launch evidence names the separate production project, private bucket, readiness checks, deployed upload/download proof, object-byte backup controls under `supabaseStorage.checks.supabase-backups-enabled`, and the verifier-bound joint recovery summary under `supabaseStorage.checks.supabase-restore-tested`.

Evidence:

| Field | Value |
| --- | --- |
| Setup guide | `docs/supabase-production-setup.md` |
| Readiness output location | |
| Document QA evidence location | |
| Document-object backup policy/monitoring location | |
| Versioned source/restored inventory export locations | |
| Manifest generation result and schema version | |
| Source database dump/inventory digest evidence | |
| Source object-backup manifest digest evidence | |
| Immutable source-capture report and source identity digest evidence | |
| Isolated restore test location | |
| Non-production restore target reference | |
| Reconciliation report location and SHA-256 | |
| Production database/object-store not-overwritten confirmation | |

## 6. Jobs

- [ ] Production job scheduling is owned by the Docker Compose `production-scheduler` service or an explicitly approved platform scheduler replacement.
- [ ] The deployed scheduler command is `node dist/jobs/production-scheduler.js`.
- [ ] Reminder job test evidence covers `node dist/jobs/send-deadline-reminders.js`.
- [ ] Document storage cleanup test evidence covers `node dist/jobs/cleanup-document-storage.js`.
- [ ] The scheduler and one-shot job runtimes receive the same production secret source that passed preflight, either as injected environment variables or as a non-committed env file materialized for the job runtime.
- [ ] Scheduler and job logs are captured.
- [ ] Failure alerts are tested for both `deadline-reminders` and `document-storage-cleanup`.
- [ ] Incident routing distinguishes `DOCUMENT_STORAGE_CLEANUP_FAILED` from the actionable `DOCUMENT_STORAGE_DELETION_DEAD_LETTERED` alert; a failed alert delivery is retried and a successfully acknowledged dead letter is not alerted every scheduler run.
- [ ] The document-deletion recovery runbook was rehearsed only against an isolated non-production target: tenant users can only `REQUEUE_UNCHANGED`, corrected-path/external-completion dispositions require the named platform-operator dry-run/review/execute flow, and no ad-hoc SQL or direct provider mutation bypasses the append-only recovery event.
- [ ] No production dead letter was manufactured for launch evidence. Any real recovery evidence records the named actor, reason, reviewed attempts/terminal reason, database-authority/path digests, exact execution confirmation, disposition, append-only `DocumentStorageDeletionRecovery` reference, and external provider proof where applicable.
- [ ] Machine-readable launch evidence names scheduler ownership, command surface, shared production secret source, captured scheduler logs, and both job failure alerts.

Evidence:

| Field | Value |
| --- | --- |
| Scheduler owner | |
| Scheduler service evidence location | |
| Reminder job test output location | |
| Cleanup job test output location | |
| Failure alert evidence location | |
| Dead-letter alert/retry evidence location | |
| Recovery rehearsal/operator evidence location | |

## 7. Billing And Email

- [ ] Stripe Essentials monthly/yearly prices share one product, Complete monthly/yearly prices share a different product, and all four price IDs are distinct.
- [ ] The four Stripe prices are active live recurring EUR prices with interval count 1 and exact approved contracts: Essentials EUR19/month and EUR190/year; Complete EUR39/month and EUR390/year.
- [ ] The dedicated `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` resolves to the exact active live configuration passed by the API, without recording the raw production value in repository evidence.
- [ ] The pinned portal configuration enables subscription price changes, forbids quantity changes, and allow-lists exactly the two approved products and four approved prices.
- [ ] The pinned portal configuration has an explicit business-approved proration policy; customer-facing copy was checked against that policy and makes no unsupported proration promise.
- [ ] Portal cancellation is enabled in `at_period_end` mode with an explicit approved proration policy.
- [ ] Stripe webhook points to the deployed API webhook endpoint and is subscribed to `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`.
- [ ] Stripe webhook signing secret matches `STRIPE_WEBHOOK_SECRET` in the production secret store without recording the raw secret.
- [ ] Before deploying the attempt-bound Checkout release, the billing owner inventoried every CharityPilot customer, subscription, and legacy subscription-mode Checkout session; duplicate/ambiguous customer mappings were resolved, every customer had at most one non-terminal subscription, and every legacy open Checkout session was explicitly expired.
- [ ] Every completed legacy Checkout session was reconciled to its organisation/customer/subscription before rollout; any charge, cancellation, or refund decision was approved by the accountable billing owner and recorded outside Git.
- [ ] The `BillingCheckoutAttempt` migration deployed before the guarded API release, and the post-deploy provider inventory again showed at most one non-terminal subscription per organisation/customer.
- [ ] Deployed proof covers first purchase, rapid duplicate clicks, supported portal plan/interval change, scheduled cancellation, final cancellation webhook, terminal restart, and webhook retry/order without creating two non-terminal subscriptions.
- [ ] Resend API key can send from `EMAIL_FROM` on the verified production sender domain, with an accepted message id or equivalent provider delivery reference recorded outside git.
- [ ] Password reset and verification email links point to the production frontend origin.
- [ ] `npm run check:production:providers -- --production-env-file=.env.production` completed from a trusted shell and recorded redacted evidence proving the exact price amounts/cadences/currency/product grouping, safe pinned portal policy and allow-list, enabled live webhook endpoint and events, and verified Resend sender domain.
- [ ] Machine-readable launch evidence identifies all four approved active live recurring Stripe prices and the pinned safe portal-policy result without recording raw secret/provider values.

Evidence:

| Field | Value |
| --- | --- |
| Stripe evidence location | |
| Stripe catalogue and portal-policy review owner/date | |
| Legacy customer/subscription/open-Checkout inventory | |
| Duplicate-subscription resolution reference | |
| Deployed purchase/portal/cancellation/restart proof | |
| Resend evidence location | |
| Test message location | |

## 8. Observability And Incidents

- [ ] API logs are captured by the production platform with log-sink and retention evidence.
- [ ] Web logs or platform events are captured with log-sink and retention evidence.
- [ ] Error alert destination is configured and tested with sanitized test-alert delivery and incident-system confirmation.
- [ ] `npm run check:production:observability -- --production-env-file=.env.production` completed from a trusted shell and the received test alert was confirmed in the incident system.
- [ ] Public uptime monitoring checks `/api/v1/health` and records the monitor owner plus alert route.
- [ ] Internal readiness monitoring checks `/api/v1/health/readiness` with `x-charitypilot-readiness-key`, with monitor owner and secret-store reference recorded outside git.
- [ ] Primary incident owner, backup owner, and escalation path are recorded outside git.
- [ ] Machine-readable launch evidence names API/web log capture and retention, sanitized test-alert confirmation, uptime/readiness monitor owners, incident owner, backup owner, and escalation path.

Evidence:

| Field | Value |
| --- | --- |
| Alert destination | |
| Test alert output location | |
| Incident owner | |

## 9. Legal And Compliance

- [ ] Privacy policy is approved for production with policy version, effective date, and privacy approver recorded outside git.
- [ ] Terms or service agreement is approved for production with terms version and effective date recorded outside git.
- [ ] Data retention policy is approved for production with retention schedule and deletion workflow evidence.
- [ ] Support and data deletion contact path is published with published URL and support mailbox evidence.
- [ ] Solicitor, governance, and privacy review confirms the production wording remains review-ready, source-cited, and clear that CharityPilot is not a substitute for legal advice, with named reviewers and review date recorded outside git.
- [ ] Machine-readable launch evidence includes the approved privacy policy, terms/service agreement, data-retention policy, support/data-deletion contact, and `legalAndCompliance.checks.solicitor-governance-privacy-review` evidence with version/date/reviewer details.

Evidence:

| Field | Value |
| --- | --- |
| Policy location | |
| Policy versions/effective dates | |
| Approver | |
| Approval date | |
| Published support/data deletion URL | |
| Named solicitor/governance/privacy reviewers | |

## 10. Browser QA

- [ ] `docs/production-browser-qa.md` has been completed against the deployed production URL.
- [ ] `npm run check:production:browser-qa-env` passed in the deployed QA shell without printing owner credential values; keep the redacted text or JSON transcript in `browserQa.checks.browser-qa-completed`, including `Deployed browser QA environment preflight passed`.
- [ ] Machine-readable launch evidence includes deployed `npm run test:e2e:responsive` command output with `E2E_DEPLOYED_QA=true`, canonical web/API URLs, and secret-store owner credential references, or all four focused responsive route chunk transcripts from the same deployed QA environment.
- [ ] Machine-readable launch evidence includes deployed `npm run test:e2e -- tests/accessibility.spec.ts` command output with the same deployed QA environment.
- [ ] Machine-readable launch evidence records that command output in the dedicated `browserQa.checks.accessibility-coverage` check.
- [ ] Machine-readable launch evidence includes deployed cross-browser responsive/accessibility transcripts in `browserQa.checks.cross-browser-coverage`.
- [ ] Machine-readable launch evidence includes real-device or cloud-device iOS Safari proof in `browserQa.checks.ios-safari-device-coverage`.
- [ ] Desktop browser coverage is recorded with deployed responsive-smoke evidence for both the public/auth and dashboard desktop light/dark route matrices.
- [ ] Mobile browser coverage is recorded with deployed responsive-smoke evidence for both the public/auth and dashboard mobile light/dark route matrices.
- [ ] Auth, dashboard, billing, document upload, authenticated API download, logout, and error states are covered in `docs/production-browser-qa.md` and the machine-readable launch evidence.
- [ ] Every browser QA evidence slot records the exact promoted `release.commitSha`: `browserQa.checks.browser-qa-completed`, `browserQa.checks.desktop-coverage`, `browserQa.checks.mobile-coverage`, `browserQa.checks.accessibility-coverage`, `browserQa.checks.cross-browser-coverage`, `browserQa.checks.ios-safari-device-coverage`, and `browserQa.checks.critical-flows-covered`.

Evidence:

| Field | Value |
| --- | --- |
| QA run owner | |
| QA date | |
| QA evidence location | |

## 11. External Security Review

- [ ] External penetration test is complete before handling real charity data, with the testing provider, testing scope, tested production web/API origins, and exact promoted `release.commitSha` recorded.
- [ ] Critical and high findings are remediated or formally accepted by the accountable owner, with finding tracker, risk acceptance approver, and acceptance date recorded outside git.
- [ ] Retest evidence exists for fixed findings, with retest date and retest result recorded.
- [ ] Report reference is stored outside git and referenced in the machine-readable launch evidence with report version and report date.

Evidence:

| Field | Value |
| --- | --- |
| Testing provider | |
| Testing scope | |
| Release commit | |
| Report reference | |
| Report version/date | |
| Remediation evidence location | |
| Risk acceptance reference | |
| Retest evidence location | |

## Final Signoff

The machine-readable `.charitypilot-launch-evidence/production-launch-evidence.json` file must include a `finalSignoff.approvals` object with separate `engineering`, `operations`, `security`, `legalCompliance`, and `business` approvals. The top-level final signoff evidence must include launch approval and the exact promoted `release.commitSha`. Each role approval must have `status: "approved"`, an owner, an ISO `approvedAt` timestamp, and role-specific non-secret external evidence references that include that approval role, launch approval, and the exact promoted `release.commitSha`.

| Role | Name | Date | Evidence reference |
| --- | --- | --- | --- |
| Engineering owner | | | |
| Operations owner | | | |
| Security owner | | | |
| Legal/compliance owner | | | |
| Business owner | | | |
