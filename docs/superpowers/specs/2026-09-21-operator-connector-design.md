# The operator connector: platform god mode with a wall at personal data

Design agreed 2026-09-20 with the owner, against `master` at `fdbbb58`.

The owner's brief, in their words: *"I want god mode for the platform operator,
as long as it doesn't abuse any GDPR guidelines, rules, and laws... I want to
make this MCP useful for my Claude and Codex coding agents to install the MCP
with full functionality, full enterprise functionality that would be acceptable
for any big company or charity operator."*

## The two identity systems, because they are easy to confuse

They are separate tables, and neither is a role of the other.

| | `User` | `PlatformOperator` |
| --- | --- | --- |
| Belongs to a charity | Always — `organisationId` is NOT NULL | Never — the column does not exist |
| Roles | `OWNER`, `ADMIN`, `MEMBER` | none; an operator is an operator |
| Second factor | no | TOTP with recovery codes |
| Signing secret | `JWT_SECRET` | `OWNER_JWT_SECRET` |
| Cookies | app session cookies | `charitypilot_owner_*`, path `/api/v1/owner` |
| Web surface | `(dashboard)` | `(owner)`, a separate route group at `/owner` |

`UserRole.OWNER` means **owner of one charity**. It has never meant owner of
the platform. That collision is why the platform operator appears nowhere in
the charity admin panel: it was never part of it.

The separation is structural rather than a role check.
`verifyOperatorAccessToken` rejects any token carrying `organisationId` or
`role` — *"A token carrying tenant claims is not an operator token, whatever it
is signed with"* — and the two realms sign with different secrets, issuers and
audiences. A charity `OWNER` has no path to `/owner`.

## The decision that shapes everything: where god mode stops

CharityPilot is a **processor**. Each charity is the **controller** of its own
trustee, conflict, staff and document data. A processor may process that data
only on the controller's documented instructions (GDPR Art. 28(3)(a)).
Technical access is unavoidable — somebody runs the backups. Exercising it
routinely, self-authorised, through a general-purpose agent tool is the part
that is not defensible.

The owner's two goals only conflict if god mode is taken to include tenant
personal data. It does not, and the wall is what makes the rest saleable: no
enterprise data-protection review passes a vendor whose operator can read the
customer's trustee register at will.

So:

- **Full authority over the platform.** Every capability the owner console has,
  the connector has: listing, reading, creating, configuring and moving the
  lifecycle of any tenant, including closing one.
- **No authority over a tenant's records.** The operator realm exposes no
  governance record and no personal data, enforced by a guard with a mutation
  canary rather than by convention.

Verified as the current state, not assumed: `tenantSelect` in
`owner-tenants.service.ts` is `id, name, rcnNumber, croNumber, lifecycleStatus,
lifecycleVersion, createdAt, subscription{plan,status,trialEndsAt}` and
`_count{users}` — a user **count**, never users.
`listTenantAdministrativeEvents` is filtered to `actorKind: 'SUPPORT'` and
operator-caused event types, and returns the operator's own `actorLabel`.

The exact line is the DPO's to confirm. The safe default needs no ruling, so
the refusal is what gets built.

## Hard problems, and what this design does about them

### 1. The operator login sets cookies and returns no tokens

`POST /api/v1/owner/auth/login` calls `setOwnerCookies(reply, tokens)` and
sends only the operator's identity in the body. The connector has no cookie
jar, and `non-browser-client.ts` refuses anything carrying browser evidence.

**Connector-shaped operator auth routes**, at `/api/v1/owner/auth/connector/*`,
mirroring `/api/v1/auth/connector/*` exactly: tokens in the body, no
`Set-Cookie` header ever, and a non-browser check that runs before any
credential is read. The TOTP code is typed once at `connect`, never at serve.

### 2. `PlatformOperatorSession` carries no posture

The charity `AuthSession` has `clientKind`, `accessLevel`, `dataScope` and a
family pinned by database triggers. The operator session has none of it.

Three of the four are added. The fourth is refused, on purpose.

| Column | Added | Why |
| --- | --- | --- |
| `clientKind` | yes | The load-bearing one. It is what stops a browser console session being driven by the connector, and a connector session being replayed in the console. Comes from the route, never the body. |
| `accessLevel` | yes | `READ`, `WRITE`, `ADMIN`. Lets a coding agent be connected read-only, which is the right default for an agent that only needs to look. `ADMIN` is required for `tenant_lifecycle`. |
| `familyId` | yes | Without it an approval dies at the next token rotation — exactly the bug `20260920010000_approval_binds_to_session_family` was written to fix. There is no reason to learn it twice. |
| `dataScope` | **no** | There is no personal data in this realm by the decision above, so the field could only mislead. Its absence states the rule; a flag that does nothing would obscure it. |

Posture is pinned per family by a database trigger, mirroring
`guard_auth_session_principal`, so a rotation that forgets to carry the posture
forward fails the insert rather than silently restoring a narrowed session to
full authority.

### 3. `AuthActionApproval` cannot be reused

The prompt says `organisationId` is NOT NULL with a foreign key. It is worse
than that: `userId` carries a **composite** foreign key to
`User(id, organisationId)`, so the row is bound to an organisation twice. An
operator is not a `User` at all.

Generalising means nullable `userId`, nullable `organisationId`, a new
`operatorId`, and a check constraint that exactly one identity is set — turning
a table with one clean invariant into one with a branching invariant, on the
most security-sensitive record in the product.

**A separate `OperatorActionApproval` table.** Both tables keep simple
invariants. The cost is a second approval path to keep in step, which is paid
by both being thin and by the canaries below.

## What gets built

### Schema — one migration, `20260921000000_add_operator_connector_realm`

- `OperatorSessionClientKind` (`WEB`, `MCP_CONNECTOR`) and
  `OperatorSessionAccessLevel` (`READ`, `WRITE`, `ADMIN`).
- `PlatformOperatorSession` gains `clientKind`, `accessLevel`, `familyId`,
  `familyCreatedAt`, all `ADD COLUMN` with defaults, all additive.
- `OperatorActionApproval`: `id`, `operatorId` (FK, Restrict),
  `sessionFamilyId`, `requestDigest`, `summary`, `method`, `routePattern`,
  `resourceId`, `tenantId` (nullable — the charity the action is about, for the
  summary only), `createdAt`, `expiresAt`, `approvedAt`, `consumedAt`.
- A partial unique index on live approvals per family and digest, matching
  `AuthActionApproval`'s, so asking twice leaves one row rather than two.
- A trigger pinning session posture per family.

Every statement is additive, so the deploy gate passes without an override.
The one thing to check at deploy time is that the new table is listed in
`e2e/helpers/database-safety.cjs`, or the reset refuses to prove itself and no
live test runs at all.

### API

- `apps/api/src/routes/owner/connector.ts` — `login`, `refresh`, `logout`,
  `approve`, `approvals/:id`, `session`. Login requires the TOTP code and
  **refuses an operator with no second factor enrolled**, with a message
  naming `/owner/security`. An agent-installed credential that can close a
  charity on a password alone is the finding that sinks an enterprise review;
  the connector is the reason the second factor finally gets switched on.
- `apps/api/src/middleware/owner-action-approval.ts` — the approval guard for
  operator writes, mirroring `requireActionApproval` including the identical
  refusal for every failure mode and the conditional single-spend update.
- `apps/api/src/services/owner-action-approval.service.ts` — `grantApproval`
  and `listPendingApprovals` for the operator realm.
- `requirePlatformOperator` gains the session posture on `request.operator`.
- The three write routes get `requireOperatorSessionLevel` and the approval
  guard. Every guard **returns** its reply. See the memory note
  `fastify-guards-must-return-the-reply`: until 2026-09-20 every refusal in
  this API was advisory, and the only reason it worked was that exactly one
  `onSend` hook was registered.

### Connector

- `--realm operator`, a separate keychain entry, and a refusal to mix: an
  operator credential is never presented on a charity route, nor the reverse.
- Tools: `tenant_list`, `tenant_get`, `tenant_history`, `tenant_create`,
  `tenant_configure`, `tenant_lifecycle`.
- In the operator realm, every charity tool is **absent from the listing and
  still refused when called by name**, the way an unadvertised tool already is.
- `session_info` reports the realm, the operator, the access level and the
  second-factor state.

## How it is proved

The house rules, from `mcp/HANDOVER.md` and the audit:

- Every new guard gets a **mutation canary**. A green test proves nothing until
  it has been shown to go red. Thirty-one canaries exist; these add to them.
- Tests run from `dist/`, with `node:test`. There is no Vitest.
- Both coverage tests will trip when the owner routes appear. That is the guard
  working: the six tools go in, and `/api/v1/owner/auth/*` gets a written
  reason rather than silence.
- `npm run test:e2e:mcp` drives the built connector over stdio against a
  disposable Docker stack. The new table must be registered in
  `e2e/helpers/database-safety.cjs` first.
- Never write a file containing a backslash through a bash heredoc.
- Work on `master`. Another session shares this checkout: stage explicit paths,
  never `git add -A`.

The refusals that must each have a canary showing them go red:

1. A connector login for an operator with no TOTP enrolled.
2. A wrong or reused TOTP code.
3. A browser-shaped request to an operator connector route.
4. An operator connector token presented on the browser console routes, and a
   console cookie presented on the connector routes.
5. A `READ` operator session offered no write tool, and refused one called by
   name.
6. A write without an approval, and the record unchanged afterwards.
7. An approval spent twice.
8. An approval minted for one operator granted by another.
9. **Any charity governance route reached with a valid operator credential.**
10. A charity connector credential presented on an owner route.

## Deliberately not in this work

- **The remote transport.** Still blocked: the server is on a Tailscale
  address, so a model provider's servers cannot reach it. It needs a publicly
  reachable host and a data protection review, in that order.
- **Confluence setup tools.** Deferred until the publishing model is agreed
  with the DPO.
- **Publishing and `mcpb pack`.** The owner's, because publishing claims a
  public name. `mcpb pack` must additionally run on the platform the bundle is
  for, because it embeds a native module.
- **Reading tenant personal data through the operator realm.** Not a gap. The
  design.
