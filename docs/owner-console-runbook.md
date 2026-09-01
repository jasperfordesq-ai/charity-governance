# Owner Console Runbook

The owner console is the platform-operator surface: a `PlatformOperator`
identity outside the tenant graph, with its own JWT secret
(`OWNER_JWT_SECRET`) and `Path=/api/v1/owner`-scoped session cookies, used to
list tenants, provision new ones, and change tenant lifecycle status
(suspend/reactivate/close). It does not exist on a personal-server
deployment: the API 404s every `/api/v1/owner/*` route there
(`routes/owner/index.ts`), and the console pages are inert without it.

This is the same restricted-operator category as
[Team Ownership Recovery](team-ownership-recovery.md): run it only from an
approved operator environment with the production secret source, and do not
paste operator emails, tenant identifiers, or reset tokens into shared logs
or public tickets.

## Preconditions

- `OWNER_JWT_SECRET` is configured, at least 32 characters, and distinct
  from `JWT_SECRET` (`.env.production.example`, `validateProductionEnv`
  in `apps/api/src/utils/env.ts`). The API refuses to boot outside
  personal-server mode without it.
- `OWNER_CONSOLE_ORIGIN` (or `APP_ORIGIN`) is set to the console's absolute
  public origin, e.g. `https://console.example.org`. The bootstrap CLI uses
  this to build the set-password link it prints; it does not send email.
- Optionally, `OWNER_ALLOWED_ORIGINS` restricts which browser `Origin` the
  owner routes will answer, on top of the ordinary tenant-app CORS policy
  (`routes/owner/index.ts`'s `ownerOriginGuard`).

## Bootstrap the first operator

Run the job directly against the deployed image's `dist` build — like every
sibling job in `apps/api/package.json`'s `jobs:*` scripts, this must NOT be
preceded by a local build: the production API image contains no
`typescript`, `tsx`, `turbo`, or `src` (CI asserts this), so a build step
cannot succeed there and is never required — `dist/` is already built into
the image.

From a built API workspace (matching `docs/team-ownership-recovery.md`'s
`-w @charitypilot/api --` convention):

```text
npm run owner:create -- --email=owner@example.org --name="Jane Doe"
```

Equivalently, for a deployed Compose image, invoke the same `dist`
entrypoint directly:

```text
docker compose --env-file <production-env> -f compose.production.yml run --rm --no-deps api node dist/jobs/create-platform-operator.js --email=owner@example.org --name="Jane Doe"
```

This creates the `PlatformOperator` row with a discarded, unusable
password (the operator never receives a password from the command line,
only a link to set their own) and prints a one-time set-password link,
shown once:

```text
Created platform operator <operator-id> (owner@example.org).
Set-password link (valid 24h, shown once):
https://console.example.org/owner/set-password#token=<token>
```

Share this link with the operator through your usual verified out-of-band
channel — it is equivalent to a password for the platform console. If it
expires or is lost before use, reissue a fresh one (invalidates the
previous token):

```text
npm run owner:create -- --email=owner@example.org --reissue
```

If the operator already exists and `--reissue` is not passed, the job
fails loudly rather than silently reissuing — this is a bootstrap tool for
a trusted operator, not a public flow, so `owner:create` must not
guess intent.

## Set password

The operator opens the printed link. `apps/web/src/app/(owner)/owner/set-password/page.tsx`
reads the token from the URL fragment (via `useSensitiveQueryToken`, the
same mechanism `/reset-password`, `/verify-email`, and `/accept-invite`
use — `proxy.ts` rewrites the query-string token into the fragment before
the page renders, and the page scrubs it from browser history once read),
and calls `POST /api/v1/owner/auth/set-password` with the token and a new
password (at least 12 characters). On success the operator is sent to
`/owner/login`.

## Log in

`/owner/login` calls `POST /api/v1/owner/auth/login`, which sets the
`Path=/api/v1/owner`-scoped access and refresh cookies. These cookies are
never sent on ordinary tenant requests (the browser enforces the Path
scope), and the owner console's web client (`lib/owner-api.ts`) never
shares state with the tenant client (`lib/api.ts`) — separate 401-refresh
interceptors, separate redirect targets. The access token is short-lived
(30 minutes); the console single-flights concurrent refreshes so
simultaneous requests don't race each other's rotation (see
`lib/owner-api.ts`'s comment on `refreshOwnerSession` for the current
limits of that protection — owner refresh tokens are single-use and
rotated, but have no cross-session reuse detection yet; see the spec's
Accepted Risks).

To end a session from the UI, use the "Sign out" control in the console
header (calls `POST /api/v1/owner/auth/logout`).

## Suspend, reactivate, or close a tenant

From `/owner/tenants`, open a tenant and use the lifecycle controls at
`/owner/tenants/[id]`. Every transition requires a reason (recorded in the
audit trail) and is guarded by `expectedLifecycleVersion` — a stale tab
gets a `409 TENANT_LIFECYCLE_CONFLICT` instead of silently overwriting a
concurrent operator's change. The allowed transitions are:

```text
ACTIVE     ->  SUSPENDED          console
SUSPENDED  ->  ACTIVE             console (reactivate)
ACTIVE     ->  CLOSED             console, requires typing the organisation name
SUSPENDED  ->  CLOSED             console, requires typing the organisation name
CLOSED     ->  anything           CLI escape hatch only, never the console
```

The status change and its `SecurityAuditEvent` are written inside one
database transaction (`owner-tenants.service.ts`'s `transitionTenantLifecycle`):
a failed audit-event write rolls back the status change too, not just the
audit event (verified in `apps/api/src/tests/owner-tenant-lifecycle.test.ts`
against a stub that actually models transactional rollback). No session
cleanup step is required — organisation lifecycle is checked on every
tenant request and under a row lock on both session issue and refresh, so
suspension takes effect immediately.

## Provision a new tenant

From `/owner/tenants`, use "Provision tenant" (`/owner/tenants/new`) to
create an organisation and its `OWNER` user without supplying a password —
the operator never chooses another person's credential. The new owner
receives two emails: a welcome/verification email (the same
`sendWelcomeEmail`/`sendEmailVerification` methods `register()` uses) and
a set-password email reusing the same `/reset-password` link mechanism a
self-service password reset uses (`services/owner-provisioning.service.ts`).
An already-registered email returns `409 EMAIL_ALREADY_REGISTERED` and
creates nothing — unlike self-service registration, which silently accepts
a taken email to avoid enumeration; that behaviour would be harmful for an
authenticated operator, who needs to see the real conflict.
