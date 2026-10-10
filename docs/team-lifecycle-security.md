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
  transfer ownership. `MEMBER` has read access only to the permitted status,
  ordinary trustee and explicitly Member-visible document views. Sensitive
  registers, complaints, conflicts, full reports and unclassified documents
  remain Owner/Admin-only; Members have no governance-write or team-management
  authority. Actual content and audience classification still need review.

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

## Privileged MFA operating scope

On 8 October 2026, the charity Owner confirmed that personal MFA may remain
optional for the current private working demo. Owner and Admin MFA must be
mandatory before public multi-tenant reliance. This matches the DPO's scoped
30 September advice; it is an operating-mode decision, not public-launch
approval. Local source now has a public-profile enforcement gate:
`CHARITYPILOT_DEPLOYMENT_MODE=production` requires
`CHARITYPILOT_PRIVILEGED_MFA_MODE=required` at API startup and public
preflight. An unenrolled Owner/Admin browser session may call only the
authenticator state/begin/complete routes among ordinary authenticated
routes; the login page sends it to Security & Data. An unenrolled privileged
connector is refused before session issuance. The normal request guard reads
the live account role and factor state, so invitation acceptance, promotion
and existing sessions cannot retain privileged API access without an enrolled
factor. The web proxy also redirects verified pending Owner/Admin sessions
to setup before protected pages render, while preserving the self-renewing
Confluence callback path. The current private VM omits this mode and keeps Jasper's optional
policy. This source is unpushed, undeployed and has no public role journey or
independent acceptance yet.
Account-level enrollment still protects that account's browser and connector
sign-in once activated. The public rule needs a governed lost-all-factors
recovery path, key-rotation procedure, invitation/promotion and existing-
session behavior beyond the source gate, disposable browser/connector role-
journey proof, live deployment evidence and independent DPO review. The live
enrollment count and exact decision receipt
are held in the private DPO review pack.

### Signing-secret rotation without locking out authenticators (October 2026)

Authenticator secrets are sealed under a key derived from the realm's signing
secret: `JWT_SECRET` for charity users, `OWNER_JWT_SECRET` for operators.
Rotating that secret, for example after a suspected exposure, used to make every
enrolled authenticator unreadable at once, leaving only recovery codes. Now:

- New envelopes record which secret sealed them, by fingerprint. Older envelopes
  without one are still read.
- During a rotation, set the old value as `JWT_SECRET_PREVIOUS` (or
  `OWNER_JWT_SECRET_PREVIOUS`). Existing authenticators keep working.
- A charity user's authenticator re-seals itself under the new secret on its next
  successful code. A failed code never re-seals. An operator's sign-in does not
  re-seal, so an operator rotation is finished only by the batch job.
- `npm --prefix apps/api run jobs:reseal-second-factor-secrets user` (or
  `operator`) re-seals the rest. One run walks every row in pages of `--batch`.
  It skips any row that changed meanwhile and reports unopenable rows without
  stopping: a count, plus the first 100 ids. Repeat until `remaining` is 0,
  then remove the `*_PREVIOUS` value.
- The personal server forwards `JWT_SECRET_PREVIOUS` from its env file; leave it
  empty outside a rotation.
- Production validation requires a configured previous secret to be at least 32
  characters and different from both current signing secrets. All four values
  are redacted from logs.

Rotating `JWT_SECRET` does **not** end browser sessions. It invalidates access
tokens only. A refresh token is an opaque value checked against its stored hash
in `AuthSession`, so `/refresh` issues a new access token under the new secret.
When a rotation follows a suspected exposure, revoke sessions as well, after
the new secret is live:

```bash
npm --prefix apps/api run jobs:revoke-all-sessions -- all --reason "<why>"
```

Without `--confirm` it only counts. With `--confirm` it does three things:

- revokes every live charity session as `INSTALLATION_SESSIONS_REVOKED`;
- records one `ALL_SESSIONS_REVOKED` event, with the reason, per affected
  member in that charity's own security log;
- revokes live operator sessions, reporting counts only.

A charity administrator can still revoke one member's sessions from the team
page. The lost-all-factors recovery path and the other public-rule items above
remain open.

## Session security trace (off until a retention period is decided)

Nine `SESSION_REPLAY_DETECTED` events between 21 and 30 September could not
be attributed. Request logs live inside containers, and every blue-green deploy
replaces them. The session security trace keeps a minimal, time-bounded record
in the database instead.

It is **off** unless `SESSION_SECURITY_TRACE_RETENTION_DAYS` is set to a whole
number of days from 1 to 90. Production refuses any other value. A personal
server refuses any value at all, because it has no scheduler to remove expired
rows. The period is a data-protection decision (decision sheet P08/C05), not an
application default.

When it is on, each sign-in, refresh and sign-out request writes one row, on
both the web and the connector routes. Each row records:

- the time, the matched route, the status code and the request ID;
- a one-way fingerprint of the presented refresh token;
- the client's network prefix (IPv4 /24, IPv6 /48);
- a digest of the user agent.

No user, charity, session or token value is stored. Each replay event now
carries the same `presentedTokenFingerprint`. A reviewer can therefore compare
the replaying request with the earlier legitimate presentation of the same
token: was it the same network and the same client? A row is never rewritten,
and none younger than a day can be deleted. Every six hours the scheduler
removes rows older than the period, judged by the database clock. If that ever
fails, it raises a job alert.

## Password recovery integrity

Personal two-step sign-in has a last-code recovery path: a browser session
created with the user's final recovery code can remove that factor with the
account password and no further code for 15 minutes. The removal route checks
the `SECOND_FACTOR_RECOVERY_USED` audit event for the same user, charity and
session family; another family is refused. Migration
`20260929240000_recovery_use_session_subject` permits that event to carry its
family ID while retaining the other security-event constraints. A disposable
PostgreSQL/Chromium journey verified last-code sign-in, the same-family audit,
different-family denial and removal. This does not provide recovery when both
the authenticator and saved codes are gone or prove a deployed account.

A signed-in user of any charity role can change their own password from
Security & Data. The browser route requires the current password and, when
enrolled, an authenticator or unused recovery code. It rechecks the password
hash under the organisation/user locks and the exact live session after hashing the replacement; a
concurrent reset or change cannot leave a newly issued session alive. In the
same transaction it consumes the second-factor proof, terminates outstanding
recovery links, replaces the password, revokes all sessions and appends a
metadata-only `PASSWORD_CHANGED` security event. The response clears browser
cookies and sends the user to sign-in. This is a local source control; an
actual account journey and provider delivery remain to be checked after
deployment.

Public password recovery is enumeration-neutral and asynchronous. Syntactically
valid requests consume durable, keyed-HMAC identifier and network budgets even
when the account is unknown, inactive, or suppressed. The browser receives the
same accepted response for every account and delivery outcome; only a
system-wide recovery-store failure is surfaced as temporary unavailability.
No raw unknown-account email, IP/network value, or reset token is stored.

Recovery links are represented by bounded, hashed `PasswordRecoveryRequest`
rows rather than one replaceable token slot. Up to three unexpired usable links
may coexist, so a second request cannot silently invalidate an email already in
flight. Only unexpired, unterminated `SENDING`, `ACCEPTED`, or `UNCERTAIN` rows
can be consumed. One successful reset locks the request, organisation, user and
sessions; changes the password; terminates every outstanding request; revokes
every active session; appends one immutable, predecessor-compatible
`ALL_SESSIONS_REVOKED` event with a trusted `PASSWORD_RESET_COMPLETED` context
marker (projected as that virtual API label); and queues one registered-address
security notice in the same transaction.

The organisation-wide security audit remains restricted to active Owners and
Admins. The reset subject receives the separate durable email notice. A future
MFA/account-security slice may add a dedicated subject-only activity surface;
the team-wide audit endpoint must not be broadened or filtered implicitly by
role.

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
