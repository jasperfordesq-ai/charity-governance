# Restricted Team Ownership Recovery

This workflow is an exceptional support operation for restoring one accountable
owner when the normal authenticated ownership-transfer flow cannot be used. It
is deliberately implemented only as the API image's offline operator job. It is
not an HTTP endpoint and it never creates a password, reset token, or session.

Run it only from an approved operator environment with the production secret
source, an authorised restricted case, and an independently verified target
identity. Do not paste organisation, user, email, operator, or case identifiers
into shared logs or public tickets.

## Preconditions

- Confirm the organisation, expected current owner, target user, and target
  email from authoritative records.
- Confirm that the case grants authority to change the accountable owner.
- Confirm the target identity through the approved out-of-band process.
- Understand that every unrevoked session belonging to both the previous and
  new owner will be revoked. Neither person receives a replacement session.
- Run the dry-run first, review the exact IDs, role transition, session counts,
  and lifecycle versions, then execute against the same release and database.

## Dry-run

From a built API workspace:

```text
npm run jobs:recover-team-ownership -w @charitypilot/api -- --dry-run --organisation-id <organisation-id> --expected-owner-id <current-owner-user-id> --target-user-id <target-user-id> --expected-target-email <target-email> --operator <operator-identity> --case-reference <restricted-case-reference> --confirm-authority-verified --confirm-target-identity-verified
```

For a deployed Compose image, invoke the same `dist` entrypoint in a one-off API
container with no published port:

```text
docker compose --env-file <production-env> -f compose.production.yml run --rm --no-deps api node dist/jobs/recover-team-ownership.js --dry-run --organisation-id <organisation-id> --expected-owner-id <current-owner-user-id> --target-user-id <target-user-id> --expected-target-email <target-email> --operator <operator-identity> --case-reference <restricted-case-reference> --confirm-authority-verified --confirm-target-identity-verified
```

The dry-run locks and revalidates the live organisation and membership state but
does not write roles, revoke sessions, or append an audit event. Stop if any
identifier, role, lifecycle state, email, verification state, or count is not
expected. It also locks the organisation's billing-authority grant before the
user rows. An unresolved Portal capability, or a Checkout capability that has
not reached an explicitly recorded safe-release time, blocks recovery.
Record the returned `organisationLifecycleVersion`,
`previousOwnerMembershipVersion`, and `targetMembershipVersion` in the
restricted case. Execution requires those exact reviewed values and fails if
any of them changed after the dry-run.

## Execute

Repeat the command with `--execute`, add the three versions returned by the
reviewed dry-run, acknowledge the session impact, and provide the exact
target-and-version-bound phrase. Quote the phrase as one shell argument:

```text
--execute --expected-organisation-version <organisation-version> --expected-owner-version <owner-membership-version> --expected-target-version <target-membership-version> --confirm-session-revocation-understood --confirm-execute "TRANSFER OWNERSHIP TO <target-user-id> AT ORGANISATION <organisation-version> OWNER <owner-membership-version> TARGET <target-membership-version>"
```

Execution locks the active organisation and affected memberships, proves that
there is exactly one active owner and it matches the expected owner, demotes
that owner before promoting the active verified target, revokes both users'
sessions, skips reserved reminders to the previous owner, and appends one
immutable `OWNERSHIP_RECOVERED` event with `SUPPORT` as the actor kind. All
changes share one serializable database transaction; any mismatch or failed
write aborts the transaction, and the database's deferred continuity constraint
refuses a commit without exactly one active owner. An elapsed Checkout grant is
released with immutable system evidence in that transaction before the user
rows are changed. Portal grants are never released merely because time passed;
they require explicit restricted reconciliation evidence.

Retain the restricted command result and corresponding immutable audit event in
the approved incident evidence store. Do not commit operational evidence to
Git. If execution fails, do not bypass the job with ad hoc SQL; reconcile the
live state and obtain fresh authority before attempting another dry-run.
