# Production Browser QA

Run this checklist against the deployed HTTPS production URL. Localhost testing does not verify production DNS, TLS, cookies, CORS, headers, storage downloads, or live provider integrations.

Do not use real charity records for launch QA. Use an approved non-sensitive test workspace and remove test documents after the run when required by policy.

## Repository Preflight

These local checks do not replace deployed production QA, but they should be green before booking a production browser run:

- [ ] `npm run test:e2e:responsive` completed through the managed isolated runner, or all four focused route chunks below completed through that runner and their transcripts were kept together as one local responsive evidence set.
- [ ] `npm run test:e2e -- tests/accessibility.spec.ts` completed through the managed isolated runner.
- [ ] Deployed browser QA credentials exist for an approved non-sensitive test workspace with owner/admin access.
- [ ] `npm run check:production:browser-qa-env` passes in the same shell that will run deployed Playwright checks. Use `npm run check:production:browser-qa-env -- --json` for a redacted machine-readable preflight transcript, and record the command plus `Deployed browser QA environment preflight passed` in `browserQa.checks.browser-qa-completed`.
- [ ] Deployed responsive smoke completed with `E2E_DEPLOYED_QA=true`, `E2E_WEB_URL`, `E2E_API_URL`, `E2E_OWNER_EMAIL`, and `E2E_OWNER_PASSWORD` supplied from the secret store, either as one full run or as all four focused route chunks below.
- [ ] Deployed accessibility smoke completed with the same deployed QA environment, and the transcript is recorded in `browserQa.checks.accessibility-coverage`.
- [ ] Cross-browser deployed responsive and accessibility smoke completed where runner support exists for Chromium desktop, Chromium mobile, Firefox, and WebKit, with evidence recorded in `browserQa.checks.cross-browser-coverage`.
- [ ] Real-device or cloud-device iOS Safari evidence completed and recorded in `browserQa.checks.ios-safari-device-coverage`.

Local browser preflight resets only the runner-created UUID-bound disposable
database after direct identity and keyed API-binding proof. Its exact migration
DSN and standalone Compose model are checked before startup, and it never layers
over the personal development stack. Cleanup residue is a failed preflight, not
a green browser result:

```bash
npm run test:e2e:responsive
npm run test:e2e -- tests/accessibility.spec.ts
```

In the examples below, replace the `SECRET_STORE_*` labels with values loaded
from the approved secret store before running the command. The preflight rejects
literal `SECRET_STORE_*` placeholders and does not print the credential values.

Example deployed responsive smoke command:

```bash
E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run check:production:browser-qa-env

E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:responsive
```

Example deployed cross-browser responsive and accessibility commands:

```bash
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

If the full route matrix is too large for the local browser host or deployed QA
runner, run the four focused chunks instead and keep all four command transcripts
together under the same browser QA evidence reference:

```bash
E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:responsive:public:desktop

E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:responsive:public:mobile

E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:responsive:dashboard:desktop

E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e:responsive:dashboard:mobile
```

The managed local stack serves a precompiled production web build. Its
best-effort public-route readiness sweep can still be shortened for a focused
diagnostic run with `E2E_SKIP_ROUTE_WARMING=true` or lower
`E2E_ROUTE_WARM_TIMEOUT_MS` / `E2E_ROUTE_WARM_BUDGET_MS`. Do not use that as a
substitute for the normal full local suite or for deployed production QA; the
launch ledger still requires deployed HTTPS evidence.

If the responsive or accessibility suite reports an HTTP 500, a Next.js/runtime
overlay, an unexpected login redirect, or a browser JavaScript `pageerror` while
resolving a protected route, treat it as a launch-blocking QA finding until it is
reproduced, fixed, or formally risk-accepted. Do not downgrade it to a selector
flake without stronger evidence.

Use the same `E2E_DEPLOYED_QA=true`, URL, and secret-store credential environment
shown above when those chunks are run against production.

Example deployed accessibility smoke command:

```bash
E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=SECRET_STORE_E2E_OWNER_EMAIL \
E2E_OWNER_PASSWORD=SECRET_STORE_E2E_OWNER_PASSWORD \
npm run test:e2e -- tests/accessibility.spec.ts
```

Record the accessibility command output in `browserQa.checks.accessibility-coverage`, including the light and dark theme coverage summary.
Record the cross-browser command output in `browserQa.checks.cross-browser-coverage`, and keep separate real-device or cloud-device iOS Safari evidence in `browserQa.checks.ios-safari-device-coverage`.

## QA Run

| Field | Value |
| --- | --- |
| Web URL | |
| API URL | |
| Run owner | |
| Run date | |
| Evidence location | |

## Browser Matrix

| Platform | Browser | Result | Notes |
| --- | --- | --- | --- |
| Desktop | Chrome stable | Open | |
| Desktop | Edge stable | Open | |
| Desktop | Firefox stable | Open | Covered by `deployed-firefox-desktop` where Playwright Firefox is supported. |
| Desktop | Safari stable, if available | Open | Covered by `deployed-webkit-desktop` as a Safari-engine proxy where native Safari is unavailable. |
| Mobile | iOS Safari | Open | Manual device or cloud-device evidence required; Playwright WebKit desktop is not a substitute for real iOS Safari. |
| Mobile | Android Chrome | Open | Covered by `deployed-chromium-mobile` as a mobile Chrome emulation baseline; real-device evidence is still preferred. |

## Launch-Critical Route Inventory

Every route below must have desktop, mobile, light-mode, and dark-mode evidence before browser QA can close. Automated responsive smoke can supply this evidence for rendered routes; manual notes should cover route-specific workflow checks, permission states, empty states, and any production-only provider behavior.
Every browser QA evidence slot recorded in the launch ledger must name the exact
promoted `release.commitSha`, including `browserQa.checks.browser-qa-completed`,
`browserQa.checks.desktop-coverage`, `browserQa.checks.mobile-coverage`,
`browserQa.checks.accessibility-coverage`,
`browserQa.checks.cross-browser-coverage`,
`browserQa.checks.ios-safari-device-coverage`, and
`browserQa.checks.critical-flows-covered`.
The `browserQa.checks.browser-qa-completed` evidence must also include the
redacted deployed environment preflight transcript from
`npm run check:production:browser-qa-env`.
The `browserQa.checks.critical-flows-covered` evidence must explicitly confirm
pending-navigation confirmation, conditional obligations, and readiness blockers
were exercised against the promoted production release.

| Route | Area | Required evidence |
| --- | --- | --- |
| `/` | Marketing | Public landing page renders, navigation works, and CTAs point at production routes. |
| `/about` | Marketing/legal attribution | About page renders, AGPL/source attribution remains visible, and public contact links work. |
| `/features` | Marketing | Feature content renders without layout overlap. |
| `/pricing` | Marketing | Public plan messaging and billing entry points render safely. |
| `/blog` | Marketing | Blog index renders with filters/search usable on mobile. |
| `/blog/understanding-the-charities-governance-code` | Marketing | Blog detail renders with source/navigation links usable. |
| `/privacy` | Legal/policy | Production policy page renders and matches approved policy reference. |
| `/terms` | Legal/policy | Production terms page renders and matches approved policy reference. |
| `/login` | Auth | Login form, validation, cookie-consent interaction, and error state work. |
| `/register` | Auth | Registration form, validation, password controls, and success path work. |
| `/forgot-password` | Auth | Reset request form submits and points email links at production frontend. |
| `/reset-password` | Auth | Reset-token form renders safely and handles invalid/expired token states. |
| `/verify-email` | Auth | Verification page handles success, pending, and invalid-token states. |
| `/accept-invite` | Auth/team | Invite acceptance handles valid, invalid, expired, and signed-in states. |
| `/dashboard` | Dashboard | Summary, actions, plan status, and empty/progress states render after login. |
| `/compliance` | Compliance | Principle overview, filters, review warnings, and source flags render. |
| `/compliance/${principleId}` | Compliance | Standard editor, autosave, retry, pending-navigation confirmation, and invalid principle states work. |
| `/documents` | Documents | Upload, list, link, download, delete, empty, and permission states work. |
| `/deadlines` | Deadlines | Generated/custom deadlines, completion toggle, add/edit/delete, and empty states work. |
| `/board` | Board | Trustee list, add/edit, conduct/induction evidence, tenure flags, and empty states work. |
| `/registers` | Registers | Complete-plan gate, register lists, forms, review prompts, and empty states work. |
| `/regulator` | Regulator | Source-cited readiness matrix and priority prompts render. |
| `/organisation` | Organisation | Charity profile, complexity, conditional obligations, dirty-state guard, and validation work. |
| `/team` | Team | Invite form, pending invites, role controls, loading/error/empty states, and role gates work. |
| `/billing` | Billing | Plan state, checkout/portal actions, degradation state, and provider-safe errors work. |
| `/export` | Export | Readiness blockers, report preview, board approval, export action, and not-legal-advice wording render. |

## Network And Security Basics

- [ ] Web URL loads over HTTPS with a valid certificate.
- [ ] API URL loads over HTTPS with a valid certificate.
- [ ] Visiting `/api/v1/health` returns `status: ok`.
- [ ] Visiting `/api/v1/health/readiness` without `x-charitypilot-readiness-key` returns `401` and does not expose dependency checks.
- [ ] Calling `/api/v1/health/readiness` with the internal `x-charitypilot-readiness-key` returns `status: ready` before launch.
- [ ] API responses include `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and `Content-Security-Policy`.
- [ ] Production API responses include `Strict-Transport-Security`.
- [ ] Cross-origin API requests succeed only from approved frontend origins.

## Marketing And Public Pages

- [ ] Home page loads without console errors.
- [ ] Pricing or billing entry points render the expected production plans.
- [ ] Navigation links work on desktop and mobile.
- [ ] Page metadata and titles are production appropriate.
- [ ] Error and not-found states are understandable and do not expose server internals.

## Authentication

- [ ] Register flow creates an account for the approved test workspace.
- [ ] Login succeeds with the test user.
- [ ] Auth cookies are `HttpOnly`.
- [ ] Auth cookies are `Secure`.
- [ ] Auth cookies use the intended domain scope.
- [ ] Logout clears the access and refresh cookies.
- [ ] Password reset request submits successfully.
- [ ] Password reset email link points to the production frontend origin.

## Dashboard And Governance Workflows

- [ ] Dashboard loads after login.
- [ ] Organisation data pages load without unauthorized data exposure.
- [ ] Governance registers can be viewed.
- [ ] Deadlines can be viewed.
- [ ] Owner or administrator-only actions are not visible or fail safely for lower-privilege users.
- [ ] API errors show user-safe messages.

## Team Security

- [ ] Ordinary members cannot see pending-invite metadata, active-session counts, or administrative security controls.
- [ ] Owner/admin lifecycle controls have unique accessible names and require a meaningful reason.
- [ ] Suspending or removing a test member immediately denies both a representative read and write from that member's existing session.
- [ ] Per-device-family and all-session revocation update the inventory without exposing raw internal session identifiers.
- [ ] Ownership transfer requires current versions and explicit confirmation, revokes both principals, leaves exactly one owner, and redirects the previous session to login without waiting on network logout.
- [ ] A stale membership-version action refreshes the team state and does not offer an endless retry with the stale version.

## Documents

- [ ] Upload a small non-sensitive test document.
- [ ] Uploaded document appears in the relevant document list.
- [ ] Download is fetched through the authenticated CharityPilot API route, returns attachment bytes with private/no-store caching, and never exposes or opens a provider URL.
- [ ] The real Download control completes in desktop WebKit and real iOS Safari/cloud-device Safari without a popup, blank tab, or lost transient-user-activation failure.
- [ ] Direct public access to the underlying storage path fails.
- [ ] Delete or clean up the test document when the QA run is complete.

## Billing

- [ ] Checkout entry points are disabled or safe when Stripe is not configured for the environment being tested.
- [ ] With live production Stripe configured, checkout uses live products and prices.
- [ ] Stripe webhook delivery is visible in the Stripe dashboard or deployment logs.
- [ ] Billing errors do not expose secret values or raw provider payloads to users.

## Email

- [ ] Email verification, if enabled in the tested flow, uses the production frontend origin.
- [ ] Password reset emails send from the approved `EMAIL_FROM` address.
- [ ] Email failures are logged for operators without exposing secrets in the browser.

## Mobile Usability

- [ ] Login form fits without horizontal scrolling.
- [ ] Dashboard navigation is usable on narrow screens.
- [ ] Document upload controls are reachable on supported mobile browsers.
- [ ] Buttons and links remain tappable without overlap.

## Exit Criteria

- [ ] No critical or high-severity browser QA defects remain open.
- [ ] Remaining medium or low defects have an owner and launch decision.
- [ ] `docs/production-launch-checklist.md` has the browser QA evidence reference.
