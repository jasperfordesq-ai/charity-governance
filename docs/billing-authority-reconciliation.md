# Restricted Billing Authority Reconciliation

This is an exceptional offline operator workflow for releasing one unresolved
`BillingAuthorityGrant` after the provider state has been investigated. It is
implemented only as the API image's standalone job. It is not an HTTP route and
must never be exposed through an authenticated or public API endpoint.

Run it only from an approved restricted operator environment against the
intended release and database. Never use ad hoc SQL to release or delete a
grant. Store the incident evidence outside Git, and put only a redacted finding
or evidence-store reference in `--provider-evidence`. Do not supply a Checkout
or Portal URL, API key, webhook secret, raw provider payload, or personal data.

## Modes

List unresolved grants from a built API workspace:

```text
npm run jobs:reconcile-billing-authority -w @charitypilot/api -- --list
```

The list contains organisation, actor, session, provider-resource, and timeline
identifiers. Treat its output as restricted incident material.

Dry-run one exact grant after independently verifying the operator's authority
and provider evidence:

```text
npm run jobs:reconcile-billing-authority -w @charitypilot/api -- --dry-run --organisation-id <organisation-id> --grant-id <grant-uuid> --expected-state <CLAIMED|PROVIDER_STARTED|CAPABILITY_ISSUED> --reason <release-reason> --operator <operator-identity> --case-reference <restricted-case-reference> --provider-evidence "<redacted-finding-or-evidence-reference>" --confirm-authority-verified
```

The dry-run opens a serializable transaction, locks the organisation first and
the exact organisation-bound grant second, and validates the expected state,
reason, provider timeline, and existing release fields. It performs no update.
Review every returned identifier and run the release against the same build and
database. If the live state changes, obtain fresh evidence and dry-run again.

Release requires the same arguments, `--release`, and this exact target-bound
phrase as one quoted argument:

```text
--confirm-release "RELEASE BILLING AUTHORITY <grant-uuid> FOR <organisation-id> FROM <expected-state> AS <release-reason>"
```

For `CLAIMED` or `PROVIDER_STARTED`, the quiescence procedure below is also
mandatory. Add `--confirm-billing-provider-io-quiesced`, and the exact phrase is:

```text
--confirm-release "RELEASE BILLING AUTHORITY <grant-uuid> FOR <organisation-id> FROM <expected-state> AS <release-reason> WITH BILLING PROVIDER IO QUIESCED"
```

The phrase binds the exact release reason as well as the grant, organisation,
and expected state. Changing any of them requires a fresh phrase and dry-run.

For a deployed Compose image, invoke the same built entrypoint in a one-off API
container with no published port. For example, replace `<mode-and-arguments>`
with one of the complete argument sets above:

```text
docker compose --env-file <production-env> -f compose.production.yml run --rm --no-deps api node dist/jobs/reconcile-billing-authority.js <mode-and-arguments>
```

## Mandatory provider-I/O quiescence for pre-capability states

A database state of `CLAIMED` or `PROVIDER_STARTED` does not prove that no
provider create call is in flight. Releasing the grant while such a call runs
could allow a Checkout or Portal capability to appear after ownership changes.
The job therefore fails closed unless the operator supplies the explicit
quiescence attestation for either expected state. The flag is an attestation,
not a mechanical substitute for these controls:

1. Enter an approved billing maintenance mode that blocks every Checkout and
   Portal mutation at all API replicas.
2. Stop or pause every worker or administrative process that can initiate the
   same provider operations.
3. Drain existing billing requests and prove from the approved runtime and
   provider observability that no provider create call remains in flight.
4. Record the maintenance window and quiescence proof in the restricted case.
5. Run the dry-run and release while the controls remain in place.
6. Keep billing mutations paused until the dependent ownership or lifecycle
   operation has completed and its resulting state has been verified. Only then
   restore normal billing traffic.

Do not supply `--confirm-billing-provider-io-quiesced` when those facts cannot
be proved. `CAPABILITY_ISSUED` releases do not accept that flag because their
safety must instead be established by the recorded capability and selected
provider reason.

## Allowed reasons and required evidence

Every mode requires a non-empty, redacted `--provider-evidence` value. The job
also checks the persisted provider timeline before accepting the reason.

| Grant kind | Release reason | Required persisted/provider facts |
| --- | --- | --- |
| `PORTAL` | `RESTRICTED_OPERATOR_ATTESTATION` only | Restricted case authority plus provider evidence that the issued Portal capability is no longer usable or otherwise safe to release. Time alone is never sufficient. |
| `CHECKOUT` | `PROVIDER_CONFIRMED_NOT_ISSUED` | No recorded capability-issued time and no provider resource. A `CLAIMED` or `PROVIDER_STARTED` release also requires the maintenance/quiescence attestation. |
| `CHECKOUT` | `PROVIDER_CAPABILITY_REVOKED` | Recorded provider-start time and provider resource, plus provider evidence that it was revoked. |
| `CHECKOUT` | `PROVIDER_CAPABILITY_TERMINAL` | Recorded capability-issued time and provider resource, plus provider evidence of terminal state. |
| `CHECKOUT` | `CHECKOUT_SAFE_RELEASE_AFTER_ELAPSED` | The immutable `safeReleaseAfter` exists and has elapsed. |

`RESTRICTED_OPERATOR_ATTESTATION` is never accepted for Checkout. A Checkout
release must use one of the four concrete provider-not-issued, revoked,
terminal, or elapsed-safe-time reasons above and satisfy its persisted facts.

The operator identity, case reference, provider evidence, authority
confirmation, previous grant and organisation state, provider timeline,
quiescence requirement and attestation, target-bound phrase, release reason,
and timestamp are written to `releaseEvidence`. The update uses an exact
compare-and-set inside the lock-holding serializable transaction. Database
constraints and triggers reject invalid transitions, deletion, mutation of
identity/timeline evidence, and any later change to a released row.

Retain the restricted command result and corresponding case evidence under the
approved retention policy. A failed comparison, reason check, write, or
transaction means no release occurred. Investigate the live state; do not edit
the grant directly or retry with a looser reason.
