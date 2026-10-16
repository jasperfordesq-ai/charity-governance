# Register an exact synthetic Confluence copy scope

This maintenance command records the exact synthetic scope needed before the
separate Owner permission stage. It does not issue that permission, consume it,
enqueue erasure or contact Atlassian. Do not use ad hoc SQL for registration.

Prerequisites: built API source containing this command; a current Owner-recorded
retained-copy review; the organisation's active Owner; no independent-recovery
binding requiring a different recording path; and the dedicated maintenance
database credential in `DATABASE_MAINTENANCE_URL`. The runtime credential is not a
fallback. The database must prove that the connected session role itself owns
the scope table. Public-production verified TLS rules remain applicable.

## Prepare the input

Use a protected local JSON file, at most 16 KiB, with these exact fields:

```json
{
  "organisationId": "synthetic-organisation-id",
  "approvedById": "active-owner-id",
  "reviewId": "current-review-id",
  "expectedSnapshotSha256": "replace-with-the-64-character-reviewed-snapshot-sha256",
  "evidenceRef": "SYNTHETIC-SCOPE-001",
  "disposalPolicyEvidenceRef": "SYNTHETIC-COPY-DISPOSAL-001",
  "expiresAt": "2026-10-16T15:00:00.000Z"
}
```

The identifiers, hash and expiry above are placeholders, not an executable
approval. Expiry must be in the future, within one hour of the database clock
and no later than the review expiry. The review must bind the same Owner,
organisation and exact snapshot. Review and scope evidence must explicitly cover
the synthetic retained-primary case; a file title is insufficient.

## Preview and register

From the canonical checkout, after building the API:

```text
npm run jobs:register-confluence-synthetic-scope --workspace @charitypilot/api -- --input <absolute-input-file>
```

Without `--confirm`, this returns `PREVIEW` and writes no policy or scope. Check
the organisation, Owner, review, snapshot, evidence, expiry and database fingerprint
in the plan. Then repeat the same command with:

```text
--confirm <confirmationSha256-from-that-exact-preview>
```

Any changed input or database binding requires a fresh preview. Registration uses
one short locked transaction and the existing database source/review/Owner guards.
The database records its actual maintenance role and registration time. The
result is `REGISTERED` with the original scope ID. A matching current retry returns
`ALREADY_REGISTERED` without a second insert; different original scope evidence is
refused rather than replaced. An expired or changed review cannot be renewed by
retrying this command. Preserve the receipt and investigate ambiguous outcomes.

The fingerprint binds the observed database name/role/address/port for this plan;
it is not a certificate of physical-host identity, old-writer isolation or an
independent recovery quorum. A preview or existing receipt is never permission to
erase. Every result retains `providerIOAuthorised=false`.

## Subsequent stages

Owner permission issuance, durable one-use execution, unknown-outcome quarantine,
real-provider purge/readback/all-copy verification and independently recoverable
current authority remain separate. This command must not be used to bypass the
retained-primary guard in the ordinary erasure workflow. Specific live synthetic
registration and provider operations still require their operational authority.

See [review preparation](confluence-retained-copy-review.md) and
[product decisions](product-governance-decisions.md).
