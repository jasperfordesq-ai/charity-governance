# Production Browser QA

Run this checklist against the deployed HTTPS production URL. Localhost testing does not verify production DNS, TLS, cookies, CORS, headers, storage downloads, or live provider integrations.

Do not use real charity records for launch QA. Use an approved non-sensitive test workspace and remove test documents after the run when required by policy.

## Repository Preflight

These local checks do not replace deployed production QA, but they should be green before booking a production browser run:

- [ ] `npm run test:e2e:responsive` completed against the local Docker stack.
- [ ] `npm run test:e2e -- tests/accessibility.spec.ts` completed against the local Docker stack.
- [ ] Deployed browser QA credentials exist for an approved non-sensitive test workspace with owner/admin access.
- [ ] Deployed responsive smoke completed with `E2E_DEPLOYED_QA=true`, `E2E_WEB_URL`, `E2E_API_URL`, `E2E_OWNER_EMAIL`, and `E2E_OWNER_PASSWORD` supplied from the secret store.
- [ ] Deployed accessibility smoke completed with the same deployed QA environment, and the transcript is recorded in `browserQa.checks.accessibility-coverage`.

Example deployed responsive smoke command:

```bash
E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=qa-owner@example.com \
E2E_OWNER_PASSWORD='from-secret-store' \
npm run test:e2e:responsive
```

Example deployed accessibility smoke command:

```bash
E2E_DEPLOYED_QA=true \
E2E_WEB_URL=https://app.charitypilot.ie \
E2E_API_URL=https://api.charitypilot.ie \
E2E_OWNER_EMAIL=<secret-store-reference> \
E2E_OWNER_PASSWORD=<secret-store-reference> \
npm run test:e2e -- tests/accessibility.spec.ts
```

Record the accessibility command output in `browserQa.checks.accessibility-coverage`, including the light and dark theme coverage summary.

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
| Desktop | Firefox stable | Open | |
| Desktop | Safari stable, if available | Open | |
| Mobile | iOS Safari | Open | |
| Mobile | Android Chrome | Open | |

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

## Documents

- [ ] Upload a small non-sensitive test document.
- [ ] Uploaded document appears in the relevant document list.
- [ ] Download opens through the app route and a short-lived signed URL.
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
