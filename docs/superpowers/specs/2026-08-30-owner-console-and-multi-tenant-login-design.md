# Platform Owner Console and Multi-Tenant Login Design

## Purpose

CharityPilot already stores every record against an `Organisation`, and
`AuthService.register` already creates an organisation, its first `OWNER` user and
a trialing subscription in a single transaction. What the platform lacks is any
surface for the person who runs the platform: there is no way to see how many
charities exist, no way to suspend one, and no way to onboard a charity that has
not signed itself up.

This design adds a minimal platform-owner console and makes the tenant login
screen explain itself when a tenant has been suspended.

## Scope

In scope:

1. A `PlatformOperator` identity, separate from tenant users, with its own login.
2. A console that lists and searches tenants, changes tenant lifecycle state, and
   provisions a tenant by hand.
3. A login change so that a suspended tenant's users are told why they cannot sign
   in, without weakening account enumeration defences.

Out of scope, deliberately:

- **Operator impersonation / support login.** The highest-value support feature and
  the most dangerous. It needs its own audit trail, time limits and arguably tenant
  consent. Deferred to its own design.
- **Per-tenant subdomains and branded login.** Rejected during design: it would make
  `User.email` unique per organisation rather than globally, and require wildcard
  TLS. Not needed while one person belongs to one charity.
- **One person in several charities.** Rejected during design. `User.email` stays
  globally unique, so login continues to resolve the organisation from the email
  alone and no organisation picker is required.
- **Operator management from inside the console.** Every operator is created by CLI
  in v1, keeping shell access as the root of trust.

## Current Baseline

Facts established by reading the repository, which this design depends on:

- `User.email` is `@unique` globally, so an email identifies exactly one
  organisation. `AuthService.login` resolves the tenant by `findUnique({ email })`.
- `TokenPayload` is `{ userId, organisationId, role, sessionId }` and
  `verifyAccessToken` rejects any role outside `OWNER | ADMIN | MEMBER`.
- `apps/api/src/tests/team-reliability.test.ts` asserts that `SUPERADMIN` is a
  **rejected** role value on `PATCH /members/:id/role`. This design must keep that
  test passing.
- `OrganisationLifecycleStatus { ACTIVE, SUSPENDED, CLOSED }` exists and is enforced
  on every request (`middleware/auth.ts`) and under a row lock on session issue and
  refresh (`services/session-tokens.ts`). Nothing can currently set it.
- `SecurityAuditEventType` already defines `ORGANISATION_SUSPENDED`,
  `ORGANISATION_REACTIVATED` and `ORGANISATION_CLOSED`. These have **zero emitters**
  anywhere in the codebase, including tests.
- `SecurityAuditActorKind.SUPPORT` is the established convention for out-of-band
  operator actions (`jobs/personal-server-account.ts`, `jobs/recover-team-ownership.ts`).
- `jobs/reconcile-billing-authority.ts` **reads** `Organisation.lifecycleStatus` as
  decision context but never writes it.
- `CHARITYPILOT_DEPLOYMENT_MODE=personal-server` already disables `POST /auth/register`
  and drives conditional UI across the web app.

## Approved Direction

The console lives inside the existing `apps/api` and `apps/web`, isolated by route
prefix, a separate signing secret and a scoped cookie, rather than as a separate
deployable application. Owner routes bind to a configurable origin allowlist,
`OWNER_ALLOWED_ORIGINS`, so the console can later be moved behind Tailscale or a
private hostname without a rewrite. When unset outside personal-server mode it
defaults to the same allowlist the tenant app uses, so the guard is opt-in
tightening rather than a deployment blocker.

## Data Model

Three additions. No existing model changes.

```prisma
model PlatformOperator {
  id              String                    @id @default(cuid())
  email           String                    @unique
  name            String
  passwordHash    String
  lifecycleStatus OperatorLifecycleStatus   @default(ACTIVE)
  sessions        PlatformOperatorSession[]
  createdAt       DateTime                  @default(now())
  updatedAt       DateTime                  @updatedAt
}

model PlatformOperatorSession {
  id         String           @id @default(cuid())
  operatorId String
  operator   PlatformOperator @relation(fields: [operatorId], references: [id])
  tokenHash  String           @unique
  revokedAt  DateTime?
  expiresAt  DateTime
  createdAt  DateTime         @default(now())

  @@index([operatorId, revokedAt, expiresAt])
}

enum OperatorLifecycleStatus {
  ACTIVE
  SUSPENDED
}
```

`PlatformOperator` has no foreign key to `Organisation` or `User` and carries no
`organisationId`. An operator therefore cannot be reached by any tenant-scoped
join, no tenant query needs a new predicate, and the existing `TokenPayload`
contract is untouched.

### Audit

Operator actions reuse `SecurityAuditEvent` rather than introducing a second audit
stream, so a charity's timeline shows platform actions alongside its own:

| Field | Value |
| --- | --- |
| `organisationId` | the affected tenant |
| `type` | `ORGANISATION_SUSPENDED` / `ORGANISATION_REACTIVATED` / `ORGANISATION_CLOSED` |
| `actorKind` | `SUPPORT` |
| `actorUserId` | `null` (nullable; the composite FK `[actorUserId, organisationId]` tolerates null) |
| `actorLabel` | the operator's email |
| `reason` | mandatory operator-supplied justification |
| `context` | `{ operatorId, previousStatus, newStatus, lifecycleVersion }` |

## Owner Authentication

Isolation is by **secret**, not only by claim.

| | Tenant | Owner |
| --- | --- | --- |
| Secret | `JWT_SECRET` | `OWNER_JWT_SECRET` |
| Issuer | `charitypilot-api` | `charitypilot-owner-api` |
| Audience | `charitypilot-web` | `charitypilot-owner` |
| Access cookie | `charitypilot_access` | `charitypilot_owner_access` |
| Cookie `Path` | `/` | `/api/v1/owner` |
| Access TTL | existing | 30 minutes |
| Payload | `{ userId, organisationId, role, sessionId }` | `{ operatorId, sessionId }` |

Two secrets mean a `JWT_SECRET` compromise cannot mint an owner token even with
forged claims. The scoped cookie `Path` means the owner cookie is never sent on
ordinary tenant requests.

Endpoints: `POST /api/v1/owner/auth/login`, `/refresh`, `/logout`, and
`GET /api/v1/owner/auth/me`.

`requirePlatformOperator` verifies the owner token, then re-reads the session row
and confirms `lifecycleStatus: ACTIVE` on every request, mirroring
`middleware/auth.ts` rather than inventing a second pattern. Owner login uses the
same `bodyIdentifierRateLimit(['email'])` configuration as tenant login and the
same constant-time dummy-bcrypt comparison on unknown email, so operator addresses
cannot be enumerated.

### Bootstrap

The first operator cannot be created by a console that requires an operator. A CLI
command mirrors `jobs/personal-server-account.ts`:

```bash
npm run owner:create -- --email=you@example.com
```

It validates a canonical lowercase email, prints a one-time set-password link
rather than accepting a password as an argument, and refuses to run unless
`NODE_ENV=production` and the deployment mode is not `personal-server`.

### Deployment gating

`registerOwnerRoutes` returns before registering anything when
`isPersonalServerDeployment()` is true (`routes/owner/index.ts`), so every
`/api/v1/owner/*` path 404s on a personal-server deployment exactly like any
other unregistered route. This is the whole of the gating: the `(owner)` route
group is NOT excluded from the personal-server web build. That was
considered and rejected — every other personal-server-specific behaviour in
this codebase (`proxy.ts`'s redirects for `/`, `/register`, `/forgot-password`,
`/billing`; `next.config.ts`'s CSP branch) is a runtime check keyed on
`NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE`, not a build-time tree exclusion;
introducing the latter just for `(owner)` would be a new, one-off build
mechanism for marginal benefit, since the pages are already fully inert
without a reachable API: every form in them posts to `/api/v1/owner/...`,
which 404s, so nothing renders real tenant data and no action succeeds. A
personal-server install that somehow navigates to `/owner/tenants` sees a
console shell that cannot do anything. API-side gating is sufficient on its
own; the web pages are unreachable-in-effect, not merely unlinked.

### Boot-time configuration guard

The API refuses to start when, outside personal-server mode, `OWNER_JWT_SECRET` is
unset or equal to `JWT_SECRET`. A misconfiguration that silently collapses the
two-secret isolation would otherwise go unnoticed.

## Owner API

All four endpoints sit behind `requirePlatformOperator`.

```
GET  /api/v1/owner/tenants?q=&status=&cursor=
GET  /api/v1/owner/tenants/:id
POST /api/v1/owner/tenants
POST /api/v1/owner/tenants/:id/lifecycle
```

**List** returns name, `lifecycleStatus`, plan, subscription status, trial end,
user count and created date. Cursor-paginated on `(createdAt, id)`; search matches
name, RCN number, CRO number and owner email.

This is the only legitimate unscoped `organisation.findMany` in the codebase. It
lives in `services/owner-tenants.service.ts`, which no tenant route imports, so the
tenant services remain uniformly org-scoped on inspection.

**Lifecycle transition** accepts `{ action, reason, expectedLifecycleVersion }` and
follows the optimistic-concurrency pattern of `jobs/recover-team-ownership.ts`:
`SELECT ... FOR UPDATE`, compare `lifecycleVersion`, return `409` on mismatch,
then update status, bump `lifecycleVersion`, set `lifecycleChangedAt` and write the
`SecurityAuditEvent` in one transaction. `reason` must be present and non-empty.

State machine:

```
ACTIVE     <-> SUSPENDED          console
ACTIVE     ->  CLOSED             console, requires typing the organisation name
SUSPENDED  ->  CLOSED             console, requires typing the organisation name
CLOSED     ->  anything           CLI escape hatch only, never the console
```

Closing is where data-retention obligations begin, so the console can enter that
state but not leave it.

No session cleanup is required. Suspension takes effect immediately because
organisation lifecycle is already checked on every request and under a row lock on
both session issue and refresh.

**Provisioning** reuses the shape of the register transaction (organisation +
`OWNER` user + subscription) with two deliberate divergences:

1. **No password is supplied by the operator.** The request carries name,
   organisation name, email, plan and trial length; the new tenant owner receives a
   verification and set-password link. An operator never chooses another person's
   credential.
2. **Real errors instead of silent acceptance.** `AuthService.register` returns
   `registrationAccepted()` for an already-registered email to prevent enumeration.
   For an authenticated operator that behaviour is harmful, because it would
   silently no-op and appear to succeed. The owner endpoint returns
   `409 EMAIL_ALREADY_REGISTERED` and creates no partial organisation.

The obvious implementation — calling `AuthService.register` directly — is therefore
incorrect, and the provisioning path must not reuse it unmodified.

## Login Disclosure Change

`AuthService.login` currently collapses a wrong password and an inactive lifecycle
into one generic `401`. The check is reordered so that disclosure happens only
after the password has been proven correct:

```ts
if (!valid) {
  throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
}
// The password is now proven correct; disclosure below leaks nothing an
// attacker does not already possess.
if (user.lifecycleStatus !== 'ACTIVE') {
  throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is no longer active.');
}
if (user.organisation.lifecycleStatus === 'SUSPENDED') {
  throw new AppError(403, 'ORGANISATION_SUSPENDED', 'This organisation is suspended.');
}
if (user.organisation.lifecycleStatus === 'CLOSED') {
  throw new AppError(403, 'ORGANISATION_CLOSED', 'This organisation is closed.');
}
```

The invariant to protect: a **wrong** password against a suspended tenant still
returns the generic `401`. Only a correct password unlocks the explanation. The
existing dummy-bcrypt comparison on unknown email is unchanged, so response timing
does not change.

`403` rather than `401` because the caller is authenticated but not permitted.
`hasActiveLifecycle` remains unchanged for `getMe` and `refresh`, which run after
authentication and should keep failing flat.

The web client's `authFailureNotice` gains the three new codes with plain-language
messages directing the reader to contact support.

## Console UI

Route group `(owner)` in `apps/web`, three pages:

- `/owner/login`
- `/owner/tenants` — searchable table
- `/owner/tenants/[id]` — detail, lifecycle actions, provisioning entry point

Its own minimal layout, deliberately not the tenant dashboard shell: no compliance
navigation, no organisation context, visually distinct chrome so the operating
context is never ambiguous. HeroUI components as elsewhere in the app.

Suspend and reactivate open a confirmation dialog with the mandatory reason field.
Close additionally requires typing the organisation name.

## Testing

New invariants for `docs/RELIABILITY.md`, following the repository's existing
ledger discipline:

| Area | Invariant |
| --- | --- |
| Token isolation | An owner token is rejected by every tenant route, and a tenant token by every owner route, because the signing secrets differ. |
| Deployment gating | Every owner route returns 404 under `CHARITYPILOT_DEPLOYMENT_MODE=personal-server`. |
| Configuration | The API refuses to boot when `OWNER_JWT_SECRET` is unset or equals `JWT_SECRET` outside personal-server mode. |
| Login disclosure | A wrong password against a suspended tenant returns generic `401`; a correct password returns `403 ORGANISATION_SUSPENDED`. |
| Login disclosure | An unknown email still performs the dummy bcrypt comparison and returns generic `401`. |
| Concurrency | A `lifecycleVersion` mismatch returns `409` and performs no write. |
| Atomicity | The status change and its `SecurityAuditEvent` commit in one transaction; a rolled-back transition leaves no orphan event. |
| Provisioning | A duplicate email returns `409` and creates no partial organisation. |
| Sole writer | No code path outside `owner-tenants.service.ts` writes `Organisation.lifecycleStatus`. |
| Operator enumeration | An unknown operator email at owner login is indistinguishable from a wrong password. |

The sole-writer check is structural rather than behavioural, and exists to stop the
design eroding as the codebase grows.

## Accepted Risks

- **No TOTP on the operator account in v1.** A password alone gates the ability to
  suspend every charity on the platform. Mitigated by CLI-only operator creation, a
  30-minute access token and rate-limited login. TOTP should be the next piece of
  work after this lands, not a backlog item.
- **Impersonation deferred.** Reproducing a tenant-reported bug still requires
  asking the tenant for detail; there is no supported way to see their screen.
- **Logical rather than physical isolation.** The owner routes are reachable from
  the public internet, so correctness of `requirePlatformOperator` and the
  deployment gate carries real weight. The origin allowlist exists so the surface
  can be moved behind Tailscale later without redesign.
- **No refresh-token-family replay detection on the owner side.** Owner refresh
  tokens are single-use and rotated on every `/auth/refresh` call
  (`rotateOperatorSession` in `operator-session.service.ts`), but unlike the tenant
  side (`session-tokens.ts`, which revokes the whole session family and records
  `revocationReason: 'REFRESH_REUSE'` on reuse), the owner side does not track
  token families at all. A stolen owner refresh token used alongside the
  legitimate operator's session is not detected: it just races the legitimate
  session for the next rotation, and whichever caller presents the current token
  first wins while the other 401s. Closing this gap needs a schema change (a
  family identifier on `PlatformOperatorSession`) and its own design; it is
  follow-up work, not part of this change.
