# Team Lifecycle and Session Security

CharityPilot treats team membership, authentication sessions, ownership, and
billing authority as one security boundary. A role label alone is not an
offboarding control: sensitive access is granted only while the user,
organisation, and exact session are active.

## Membership states and roles

- `ACTIVE` members may authenticate and use the permissions attached to their
  current database role.
- `SUSPENDED` members retain their account record and governance history but
  cannot authenticate. Reactivation creates no session and restores no prior
  session.
- `REMOVED` is a terminal soft-removal state. Historical foreign keys and audit
  evidence remain intact; the account cannot be reactivated through the normal
  team workflow.
- `OWNER` is unique per organisation and must be active. `ADMIN` can manage
  ordinary members; only the current owner can manage admins, change roles, or
  transfer ownership. `MEMBER` is a view/download role for governance records
  and has no governance-write or administrative team authority.

The database increments `membershipVersion` whenever role, lifecycle status, or
organisation membership changes. Every mutation carries the version the
operator reviewed and fails with `MEMBERSHIP_VERSION_CONFLICT` if it is stale.

## Offboarding and session revocation

Suspension and removal run in one transaction that locks the organisation and
the actor/subject memberships, reauthorises the live roles, changes lifecycle
state, clears account verification/reset tokens, revokes every unrevoked auth
session, cancels reserved reminders, and appends an immutable security event.
Because `authGuard` validates the session plus live user and organisation state
on every request, a previously issued access token cannot preserve read or
write access after the transaction commits.

Owners and authorised administrators can inspect a privacy-minimised session
family inventory and revoke one family or every active session. Users can do
the same for their own sessions. Self-service and administrator revocations use
different revocation reasons and audit context. Revoking the current session
clears browser credentials and redirects locally without depending on a
successful network logout.

Refresh rotation and logout take the same organisation-user-family lock order.
Logout revokes the whole presented token family, so a concurrent refresh either
fails before creating a successor or returns a successor that the logout has
already revoked.

## Ownership continuity

Normal ownership transfer is a serializable transaction with lock order:

1. organisation;
2. unresolved billing-authority grant;
3. affected users in stable id order.

PostgreSQL serialization conflicts (`P2034`) are retried at most three times;
exhaustion returns a stable ownership-write conflict and never falls back to a
weaker isolation level.

The current owner and target versions must match, the target must be active and
email verified, and both principals' sessions are revoked. The old owner is
demoted before the target is promoted: an immediate partial unique index blocks
a transient second owner, while a deferred constraint refuses commit unless
there is exactly one active owner.

An unresolved Checkout or Billing Portal capability blocks ownership change.
Checkout may proceed only after concrete terminal/revocation evidence or its
provider-backed safe-release time; Portal authority requires restricted
operator reconciliation. See [Billing Authority
Reconciliation](billing-authority-reconciliation.md).

When the current owner cannot use the authenticated workflow, the offline-only
recovery job requires independently verified authority and target identity, a
reviewed dry run, exact organisation/owner/target versions, a target-and-version
bound phrase, dual-principal session revocation, and an immutable `SUPPORT`
audit event. It never creates credentials. See [Restricted Team Ownership
Recovery](team-ownership-recovery.md).

## Invitation and capacity safety

Invitation creation and acceptance lock the organisation before capacity
checks. Acceptance rechecks the organisation lifecycle, subscription access,
invite state, expiry, global email uniqueness, and plan capacity after password
hashing and immediately before consumption. Failures use the same generic
invalid-invite response so tenant, account, and capacity state are not disclosed
through a public token endpoint.

## Evidence and verification

Security events are append-only database records. Browser DTOs deliberately
exclude raw request/session identifiers and arbitrary audit context. Each event
stores a bounded subject-label snapshot; later member or invitation edits do
not rewrite visible history. Team lists re-lock and reauthorise the live actor,
and expose session counts only for targets that actor may inspect. Real-stack
E2E coverage proves concurrent refresh-token reuse and logout/refresh handling,
immediate read and write denial after suspension/removal, dual-session
revocation on ownership transfer, and exactly-one-owner continuity against
PostgreSQL.
