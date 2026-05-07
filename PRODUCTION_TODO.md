# CharityPilot Production Readiness Todo

Status marks reflect this implementation pass.

## Security and Auth

- [x] Move browser authentication away from `localStorage` and into HTTP-only cookies.
- [x] Replace stateless refresh JWTs with hashed, revocable, rotating refresh sessions.
- [x] Hash password reset and email verification tokens before storage.
- [x] Add logout and server-side refresh token revocation.
- [x] Add role guards for administrator and owner-only mutations.
- [x] Stop leaking unexpected server error messages in production.
- [x] Add security headers and Content Security Policy.
- [ ] Complete external penetration test before handling real charity data.

## Data and Documents

- [x] Keep document files private and retrieve them through signed download URLs.
- [x] Validate linked governance standards before creating document evidence links.
- [x] Restrict document mutations to owners/admins.
- [ ] Configure production Supabase project, private bucket, backups, and retention policy.

## Build, Release, and Operations

- [x] Replace deprecated `next lint` script with ESLint flat config.
- [x] Add a deterministic Next production server entrypoint.
- [x] Add CI for lint, build, tests, Prisma validation, and dependency audit.
- [x] Add Docker build scaffolding for API and web.
- [x] Disable in-process reminder scheduling in production unless explicitly enabled.
- [ ] Provision production hosting, secrets, observability alerts, and runbook ownership.

## Product Polish

- [x] Remove hardcoded demo credentials from the login screen.
- [x] Make demo seeding opt-in.
- [x] Fix auth error handling to use API error payloads.
- [x] Remove duplicate register-page shell inside the shared auth layout.
- [ ] Run browser QA against the deployed production URL and supported mobile devices.

## Verification

- [x] `npm run lint`
- [x] `npm run test`
- [x] `npm run build -w @charitypilot/shared`
- [x] `npm run build -w @charitypilot/api`
- [x] `npm run build -w @charitypilot/web`
- [x] `npm audit --omit=dev --audit-level=moderate`
- [ ] `npm run check:production -- --env-file=.env.production`
