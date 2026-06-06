# CharityPilot Production Readiness Todo

Status marks reflect completed repository hardening work. Open items require real external evidence before CharityPilot can handle production charity data.

## Security and Auth

- [x] Move browser authentication away from `localStorage` and into HTTP-only cookies.
- [x] Replace stateless refresh JWTs with hashed, revocable, rotating refresh sessions.
- [x] Hash password reset and email verification tokens before storage.
- [x] Add logout and server-side refresh token revocation.
- [x] Add role guards for administrator and owner-only mutations.
- [x] Stop leaking unexpected server error messages in production.
- [x] Add security headers and Content Security Policy.
- [ ] Complete external penetration test before handling real charity data; record report and remediation evidence in `docs/production-launch-checklist.md`.

## Data and Documents

- [x] Keep document files private and retrieve them through signed download URLs.
- [x] Validate linked governance standards before creating document evidence links.
- [x] Restrict document mutations to owners/admins.
- [ ] Configure production Supabase project, private bucket, backups, restore testing, and retention policy using `docs/supabase-production-setup.md`.

## Build, Release, and Operations

- [x] Replace deprecated `next lint` script with ESLint flat config.
- [x] Add a deterministic Next production server entrypoint.
- [x] Add CI for lint, build, tests, Prisma validation, and dependency audit.
- [x] Add Docker build scaffolding for API and web.
- [x] Disable in-process reminder scheduling in production unless explicitly enabled.
- [ ] Provision production hosting, DNS/TLS, secrets, observability alerts, and runbook ownership; record evidence in `docs/production-launch-checklist.md`.

## Product Polish

- [x] Remove hardcoded demo credentials from the login screen.
- [x] Make demo seeding opt-in.
- [x] Fix auth error handling to use API error payloads.
- [x] Remove duplicate register-page shell inside the shared auth layout.
- [ ] Run `docs/production-browser-qa.md` against the deployed production URL and supported mobile devices.

## Verification

- [x] `npm run lint`
- [x] `npm run test`
- [x] `npm run test:production-check`
- [x] `npm run build -w @charitypilot/shared`
- [x] `npm run build -w @charitypilot/api`
- [x] `npm run build -w @charitypilot/web`
- [x] `npm audit --omit=dev --audit-level=moderate`
- [ ] `npm run check:production -- --production-env-file=.env.production`
- [ ] Complete `docs/production-launch-checklist.md` with real launch evidence.
