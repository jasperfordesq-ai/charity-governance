# Production Operations Readiness Design

## Purpose

CharityPilot now has a trustworthy repository release gate, but the remaining production-readiness blockers are operational. The next slice will turn those external blockers into concrete evidence requirements, templates, and operator checklists that can be used to complete launch without committing secrets or pretending that infrastructure has already been provisioned.

This slice is about readiness evidence. It will make the remaining production work explicit, repeatable, and auditable from the repository. It will not mark CharityPilot production ready until real production services, secrets, deployed QA, and external security review are completed and verified.

## Current Evidence

The current checkout is `C:\platforms\htdocs\CharityPilot` on `master`, ahead of `origin/master` by seven release-gate commits.

The current production checklist still has these open items:

- External penetration test before handling real charity data.
- Production Supabase project, private storage bucket, backups, and retention policy.
- Production hosting, secrets, observability alerts, and runbook ownership.
- Browser QA against the deployed production URL and supported mobile devices.
- Production preflight pass with a real `.env.production` file or equivalent generated secret file.

Existing artifacts:

- `.env.example` is local-development oriented and contains localhost URLs and placeholder values.
- `docs/production-runbook.md` lists release checks, basic environment requirements, database migration, jobs, storage, incident basics, and the release gate.
- `scripts/check-production.mjs` validates a selected production env file using `--production-env-file=<path>`.
- API readiness is exposed at `/api/v1/health/readiness`.
- Dockerfiles exist for API and web builds, but there is no production hosting evidence checklist.

## Approved Scope

This slice will create and wire the following repository artifacts:

- `.env.production.example`: a production-only environment template with all required variables, safe placeholder values, source-of-truth notes, and operational notes for cookies, scheduler behavior, and public origins.
- `docs/production-launch-checklist.md`: a launch evidence checklist covering secrets, hosting, DNS/TLS, database, migrations, Supabase storage, backups, monitoring, legal pages, release gates, browser QA, and penetration testing.
- `docs/supabase-production-setup.md`: a Supabase production setup guide for private storage, service role handling, signed URL behavior, bucket verification, database backup expectations, restore testing, and retention.
- `docs/production-browser-qa.md`: a deployed browser QA checklist for desktop and mobile smoke testing across marketing, auth, dashboard, billing, documents, downloads, security headers, and error states.
- Updates to `docs/production-runbook.md` so operators can find the new launch evidence artifacts.
- Updates to the production checklist so remaining open items point to the new artifacts rather than staying broad.

The slice will preserve the current release-gate checks and the current distinction between code readiness and full production launch readiness.

## Out Of Scope

This slice will not:

- Create, commit, or infer real production secrets.
- Provision hosting, DNS, TLS, Supabase, Stripe, Resend, monitoring, or alerting.
- Claim that backups, retention, penetration testing, legal review, or deployed browser QA are complete.
- Change application runtime behavior unless a documentation artifact exposes a clear existing inconsistency.
- Replace the current deployment architecture or choose a hosting provider.

## Architecture

The operations readiness pack will be a set of linked repository documents and templates:

- Environment readiness lives in `.env.production.example` and is mechanically checked by `scripts/check-production.mjs`.
- Launch evidence lives in `docs/production-launch-checklist.md` and acts as the top-level production gate.
- Supabase and storage evidence lives in `docs/supabase-production-setup.md`.
- Deployed browser QA evidence lives in `docs/production-browser-qa.md`.
- `docs/production-runbook.md` remains the short release operator guide and links to the detailed evidence artifacts.
- The production checklist remains a concise status tracker and links open items to the evidence documents.

These artifacts are intentionally provider-neutral where the codebase is provider-neutral, and provider-specific where the app already depends on Supabase, Stripe, Resend, PostgreSQL, and the existing API/web services.

## Evidence Flow

Operators will use `.env.production.example` to create a real production secret file outside git. They will run:

```bash
npm run check:production -- --production-env-file=.env.production
```

The preflight pass becomes evidence that required environment values are present and production-shaped. It does not prove provider-side setup is complete.

Operators will then use `docs/production-launch-checklist.md` as the top-level evidence ledger. Each open launch area will require dated evidence such as:

- production URL and API URL;
- successful release-gate command output;
- successful readiness endpoint response;
- Supabase bucket privacy verification;
- backup and restore-test confirmation;
- monitoring alert destination and test alert result;
- browser QA run details;
- penetration-test report reference.

The repository will not store private reports, screenshots with sensitive data, or secret values. It will store what evidence is required and where an operator should record or attach it in the deployment system.

## Error Handling And Safety

The new production environment template will keep placeholder values deliberately invalid so `check-production` continues to fail until real values are supplied. It will include comments warning against committing `.env.production`.

The launch checklist will avoid checkbox wording that implies external work is complete by default. Open operational requirements will remain open in the production checklist until the actual external evidence exists.

The browser QA checklist will require testing against a deployed HTTPS URL, not localhost, because localhost smoke tests do not prove production DNS, TLS, cookies, CORS, headers, or storage downloads.

## Testing And Verification

Implementation verification for this slice will include:

- `npm run check:production -- --production-env-file=.env.production.example` fails with placeholder and configuration issues.
- `npm run check:production -- --production-env-file=.env.example` continues to fail with local-development placeholder and localhost issues.
- `npm run test:production-check` passes.
- `npm audit --omit=dev --audit-level=moderate` passes.
- Link and reference checks using repository search confirm the runbook and production checklist point to the new documents.

The full production goal remains incomplete after this slice until the external evidence is produced and inspected.

## Production Readiness Impact

After this slice, CharityPilot will have a clear operational path to launch. The remaining production blockers will be specific, evidence-backed work items rather than broad statements. This improves production readiness by making it harder to skip secrets, storage privacy, backups, monitoring, deployed QA, or external security review accidentally.

The app still will not be fully production ready until the top-level launch checklist is completed with real production evidence.
