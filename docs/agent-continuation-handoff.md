# CharityPilot Agent Continuation Handoff

Last updated: 2026-07-08

This document exists so a new Codex, Claude, or other coding agent can continue the same CharityPilot production-completion goal without relying on chat memory or a pasted prompt.

## Project

- Workspace: `C:\platforms\htdocs\CharityPilot`
- Canonical GitHub repository: `https://github.com/jasperfordesq-ai/charity-governance`
- Default branch: `master`
- Branch policy from the user: work on `master`; do not create feature branches unless explicitly told otherwise.
- Commit policy: commit and push completed work to `origin/master` in small verified increments.

## Current Launch State

Run this first in a fresh session:

```powershell
git status --short --branch
npm run launch:status -- --json
npm run audit:platform
```

Known current state from `npm run launch:status -- --json` on 2026-07-08:

- Phase: `ENV_INCOMPLETE`
- `.env.production` exists but still has 23 values needing real production data.
- Production values complete: `1 / 24`.
- Launch evidence ledger exists at `.charitypilot-launch-evidence/production-launch-evidence.json`.
- Machine-readable launch evidence completion: `9 / 85`.
- `approvedForLaunch`: `false`
- Final signoffs approved: `0 / 5`
- Real charity data remains blocked.

The 23 missing production values are:

- `TRUSTED_PROXY_ADDRESSES`
- `DATABASE_URL`
- `FRONTEND_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_ESSENTIALS_MONTHLY_PRICE_ID`
- `STRIPE_ESSENTIALS_YEARLY_PRICE_ID`
- `STRIPE_COMPLETE_MONTHLY_PRICE_ID`
- `STRIPE_COMPLETE_YEARLY_PRICE_ID`
- `RESEND_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ERROR_ALERT_WEBHOOK_URL`
- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL`
- `CHARITYPILOT_WEB_NEXT_PUBLIC_SUPABASE_URL`
- `CHARITYPILOT_API_IMAGE`
- `CHARITYPILOT_WEB_IMAGE`
- `CHARITYPILOT_MIGRATION_IMAGE`
- `CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL`
- `CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL`

## Non-Negotiable Product Posture

Do not claim CharityPilot is legally guaranteed, "100% legally bombproof", or a substitute for legal advice.

Correct posture:

- review-ready;
- source-cited;
- evidence-led;
- difficult to misuse;
- clear that solicitor, governance, privacy, accounting, safeguarding, employment, and other professional review may be required.

## What Has Been Achieved

### UI/UX and Product Surface

- Full UI/UX revamp has been carried across the main P0 flows:
  - marketing;
  - auth;
  - dashboard;
  - compliance overview;
  - compliance principle detail;
  - documents;
  - deadlines;
  - board;
  - registers;
  - regulator;
  - organisation;
  - team;
  - billing;
  - export;
  - loading, error, empty, disabled, and not-found states.
- Light and dark mode support is present across the app.
- Route files have been decomposed: no route page remains over 450 lines according to the platform audit.
- P0 dashboard routes now use extracted panels, workflow hooks, and shared primitives rather than large monolithic route files.
- Shared UI primitives are in place for:
  - loading states;
  - empty states;
  - error states;
  - locked-feature states;
  - review warnings;
  - inline status;
  - save status;
  - source references;
  - file upload;
  - form alerts;
  - action buttons.
- HeroUI controls are now used for key binary/choice/input surfaces:
  - switches;
  - checkboxes;
  - radio groups;
  - buttons;
  - inputs;
  - file upload.
- Lucide icons have replaced route-local inline SVGs across the main route chrome and key actions.
- Pricing page metadata is ASCII-safe and pricing feature/comparison icons use `lucide-react` directly.
- Marketing blog search uses the shared empty-state primitive for no-result filters; marketing landing signal tiles use shared status panel styling; dashboard annual regulator summary, summary cards, progress cards, deadline lists, and board-alert cards use shared status panel styling; compliance overview summary, principle cards, and detail standard editor cards use shared status panel styling; compliance standard autosave, organisation profile saving, governance register saving, document vault mutations, export board sign-off, and board/deadline/team mutations use the shared save-status primitive; export controls and board-approval panels use shared status panel styling; billing checkout and portal handoffs use shared visible status; billing current-plan summary and plan prices use shared/flat panel treatment instead of nested route-local cards; team permission-denied messages use shared permission hints instead of route-local hidden or bespoke status markup.
- Dashboard mobile navigation has explicit ARIA controls, Escape handling, focus recovery, and focus trapping.
- Breadcrumbs and principle labels are source-backed and meaningful.

### Compliance and Legal-Readiness Model

- Irish compliance source metadata was refreshed against official sources on 2026-07-08.
- The matrix includes source metadata, last-checked dates, professional-review flags, and commencement status.
- The product includes explicit not-yet-commenced monitoring rows for relevant Charities (Amendment) Act 2024 provisions.
- Conditional obligation profile facts were added for:
  - staff/workers;
  - volunteers;
  - public fundraising;
  - child-facing services/safeguarding;
  - personal-data processing/GDPR;
  - premises/events;
  - public-sector context;
  - processors.
- Conditional obligation prompts now surface through documents, deadlines, registers, regulator, export, and organisation workflows.
- Export readiness is broader than missing explanations:
  - missing standard records;
  - missing actions;
  - missing evidence;
  - missing explanations;
  - missing conditional-profile facts;
  - profile-triggered professional-review prompts.
- API-rendered exports include:
  - source/professional-review appendix;
  - not-legal-advice/non-certificate disclaimer;
  - source counts;
  - professional-review flags;
  - not-yet-commenced monitoring metadata.

### Backend, Security, and Reliability

- Tenant isolation, auth/session guards, role guards, plan gates, validation, redaction, document privacy, and billing degradation are covered by tests and tooling.
- Browser auth moved away from localStorage and into HTTP-only cookies.
- Refresh sessions are hashed, revocable, and rotating.
- Password reset and verification tokens are hashed before storage.
- Logout and server-side refresh revocation exist.
- Identifier-aware throttles exist for:
  - email;
  - reset/verify token;
  - refresh token;
  - bearer/access-cookie credentials.
- Stripe customer reconciliation was added:
  - organisation-scoped idempotency key;
  - metadata verification before checkout/portal reuse;
  - stale or wrong-organisation IDs repaired through metadata reconciliation.
- Document storage paths include UUIDs to avoid same-millisecond filename collisions.
- Document file privacy is preserved through private storage and signed download URLs.
- Document metadata responses do not expose internal storage object keys.
- Production error handling redacts sensitive values.
- Alert webhook and production checker transcript redaction is in place.
- Backup/restore helper transcript redaction is in place.

### Production and Launch Tooling

- Canonical production origins are aligned:
  - web: `https://app.charitypilot.ie`
  - API: `https://api.charitypilot.ie`
- Production deploy defaults include `compose.production.yml` plus `compose.production-tls.yml`.
- A `--no-tls-proxy` escape hatch exists for managed platform TLS.
- Caddy/TLS runbook, environment template, smoke checks, evidence validators, and release workflow all align around the canonical hostnames.
- Release workflow builds and publishes digest-pinned runtime/migration images.
- Deploy preflight validates digest-pinned images and web build-origin metadata.
- Production deploy and rollback scripts run preflight and public HTTPS smoke checks.
- Launch status output groups missing production values by source:
  - hosting/proxy;
  - PostgreSQL;
  - Stripe;
  - Resend;
  - Supabase;
  - observability;
  - release image promotion.
- Launch status has JSON output for operator dashboards and handoffs.
- Production launch evidence initializes outside the repo root in `.charitypilot-launch-evidence/`.
- Launch evidence status has read-only progress output and strict final validation.
- The platform audit generator records launch evidence state and falls back to direct `.git` metadata reads if shelling out to git is unavailable.

### Launch Evidence Hardening

The launch evidence model has been tightened substantially:

- Evidence references must use HTTPS URLs on approved hosts.
- Approved references are limited to `*.charitypilot.ie` or the canonical GitHub repository.
- GitHub evidence must point to `github.com/jasperfordesq-ai/charity-governance`.
- Signed URLs and token-bearing query strings are rejected.
- Evidence descriptions and references reject raw secret-looking values.
- Evidence file path errors are redacted.
- Pentest evidence must bind to the promoted `release.commitSha`.
- Deployed browser QA evidence must bind to the promoted `release.commitSha`.
- Final signoff evidence must bind to the promoted `release.commitSha`.
- Final signoff requires five roles:
  - engineering;
  - operations;
  - security;
  - legal/compliance;
  - business.
- Legal/compliance evidence must include solicitor/governance/privacy review.
- Browser QA evidence requires:
  - deployed responsive coverage;
  - deployed accessibility coverage;
  - cross-browser coverage;
  - real iOS Safari or cloud-device proof;
  - full route inventory across desktop/mobile and light/dark.
- Supabase evidence requires private bucket, signed URL behavior, backup/PITR evidence, and restore-test ownership.
- Billing/email evidence requires Stripe webhook event proof, webhook-secret secret-store proof, Resend accepted-send proof, and production email-link origin proof.
- Evidence chronology now allows the package to be prepared before evidence is collected, while requiring every checklist evidence entry to be captured no later than `finalSignoff.approvedAt`.
- Deploy-smoke evidence hints now name the actual accepted command:

```powershell
node scripts/smoke-production-deploy.mjs --production-env-file .env.production
```

## Recent Verification Evidence

Recently successful checks in this workstream:

- `npm test -w @charitypilot/web`
  - 220 web tests passed after public attribution, shared auth status icons, and shared auth loading-state polish.
- `npm run lint -w @charitypilot/web`
  - Passed after the same auth/public trust-surface work.
- `npm run release:ready -- --no-e2e`
  - Passed on 2026-07-08 at commit `e2a98ee`.
  - Security scan, lint, build, workspace tests, dependency audit, and reliability ledger passed.
  - Playwright E2E intentionally skipped.
- `npm run test:production-check`
  - Passed on 2026-07-08 with 299/299 production-tooling checks passing.
  - Covers production validators, launch evidence validation, provider checker contracts, deployment tooling, backup/restore tooling, and CI/release workflow guards.
- `npm run lint -w @charitypilot/web`
  - Passed after the shared blog empty-state and compliance save-status primitive cleanup.
- `npm run build -w @charitypilot/web`
  - Passed after the same shared-state cleanup.
- `npm run test:production-check`
  - Passed again with the production-tooling checks after the shared-state cleanup.
- Focused launch-evidence tests
  - Passed after the evidence hardening updates.
- Web wiring tests
  - Passed after the pricing/icon polish.
- `npm run audit:platform`
  - Passed.
- `npm run launch:status -- --json`
  - Passed and still reports the real blockers.

Important limitation:

Local/repo checks do not prove production launch readiness. They must be rerun against the final production config and live HTTPS deployment.

## What Is Left To Do

### External Launch Blockers

These require human/operator/provider access and must not be faked:

1. Fill real production secrets/provider values in `.env.production` or an approved secret store.
2. Configure production hosting, DNS, TLS, reverse proxy, and public HTTPS smoke evidence.
3. Prove PostgreSQL production backup and restore before real charity data.
4. Prove Supabase production private bucket, signed URL behavior, backup, and restore.
5. Configure Stripe live products/prices/webhook.
6. Configure Resend sender domain and live email evidence.
7. Configure observability:
   - logs;
   - uptime checks;
   - readiness checks;
   - alert routing;
   - incident owner;
   - backup owner;
   - escalation path;
   - test alert.
8. Complete solicitor/governance/privacy review.
9. Complete external penetration test.
10. Remediate or formally accept pentest findings.
11. Complete deployed browser QA and accessibility checks.
12. Complete all 85 machine-readable launch evidence checks.
13. Complete final engineering, operations, security, legal/compliance, and business signoffs.

### Launch Evidence Still Open

The evidence ledger is currently `9 / 85`. Those completed checks are local/CI
release-gate basics only; they do not replace real production env validation,
digest-pinned deployment, public HTTPS smoke, rollback, provider, backup/restore,
deployed browser QA, legal, pentest, or final signoff evidence.

The first incomplete evidence checks currently reported are:

- `releaseGate.check-production`
- `releaseGate.deploy-preflight`
- `releaseGate.deploy-production`
- `releaseGate.deploy-smoke`
- `releaseGate.deploy-rollback`

Do not fill these with local or fake evidence. They need final real production
configuration, deployment, rollback, and public HTTPS smoke evidence tied to the
promoted release.

### Deployed Browser QA Still Open

Local browser/accessibility checks have been run previously, but deployed production QA remains open.

Required deployed QA must cover:

- public/auth routes;
- dashboard routes;
- desktop;
- mobile;
- light mode;
- dark mode;
- auth flow;
- dashboard flow;
- billing flow;
- document upload;
- signed download;
- logout;
- error states;
- accessibility;
- cross-browser;
- real iOS Safari or cloud-device iOS Safari.

### Legal/Compliance Still Open

The product is review-ready but not legally signed off.

Still required:

- production privacy policy approval;
- terms/service agreement approval;
- retention policy approval;
- support/data deletion contact publication;
- named solicitor review;
- named governance review;
- named privacy review;
- review dates and evidence references outside git.

## Recommended Next Agent Workflow

1. Confirm the baseline:

```powershell
git status --short --branch
git log --oneline -5
npm run launch:status -- --json
```

2. If no real production/provider access is available, continue repo-side closure only:

- search for stale command drift;
- tighten validators;
- improve launch evidence clarity;
- strengthen runbooks;
- run focused tests;
- commit and push.

3. If production/provider access is available, work through this order:

```powershell
npm run check:production -- --production-env-file=.env.production
npm run check:production:hosting -- --production-env-file=.env.production
npm run check:production:database -- --production-env-file=.env.production --expect-operational-sentinel
npm run check:production:supabase -- --production-env-file=.env.production
npm run check:production:providers -- --production-env-file=.env.production
npm run check:production:observability -- --production-env-file=.env.production
npm run deploy:preflight -- --production-env-file=.env.production
npm run deploy:production -- --production-env-file=.env.production
npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env
npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json
```

4. For deployed browser QA, use the commands and evidence slots in:

- `docs/production-browser-qa.md`
- `docs/production-launch-checklist.md`
- `.charitypilot-launch-evidence/production-launch-evidence.json`

5. Commit only repo changes. Do not commit:

- `.env.production`;
- real secrets;
- production launch evidence JSON;
- screenshots with sensitive data;
- pentest reports;
- legal review reports;
- provider credentials;
- backup dumps.

## Percentage Remaining

Strict launch evidence metric:

- `76 / 85` machine-readable launch checks remain.
- Strict launch evidence is still mostly incomplete because the remaining checks
  include the real production environment, deploy, rollback, provider,
  backup/restore, deployed QA, legal, pentest, and final signoff gates.
- Final signoffs remain `0 / 5`.
- Production values remain `1 / 24` complete, with 23 real provider/hosting/image-promotion values still missing.

Whole-goal estimate:

- Repo-side engineering and UI polish are substantially advanced.
- Actual production launch readiness is still dominated by external provider setup, deployed evidence, legal/privacy/governance review, external security review, backup/restore proof, and final signoffs.
- Evidence-based estimate: about 65-70% of the overall production-completion goal remains, even though the codebase itself is much further along.

Repo-side-only estimate:

- About 10-15% remains, mostly defects that may be discovered by live QA, security review, or production provider checks.

## Final Rule For Future Agents

Do not redefine success around passing local tests. CharityPilot is not launch-ready until the real production environment, live providers, deployed QA, legal/compliance review, external security review, backup/restore evidence, all 85 launch evidence checks, and all five final signoffs are complete and recorded.
