# Exact-version custody for synthetic standard-write evidence

17 October 2026. `S3ManagedWriteEvidence` implements independently addressed
baseline and refusal-report publication for the
[synthetic standard-write probe](supabase-credential-write-proof.md).
It is an internal custody component. Current maintenance protocol4 does not call
it or the active write probe; there is no public command, job or route.

## Binding and publication

Configuration requires explicit installation, exact attempt/plan/source/epoch,
expected probe-registry digest, bucket, AWS account and Ireland KMS key. Explicit
credentials are mandatory; no ambient endpoint, credential or region fallback is
used. SDK requests use the exact Ireland endpoint, one attempt and no region
redirect. This does not itself demonstrate independent operator/key custody.

Objects are addressed only as:

- `managed-maintenance/<installation>/<attempt>/write-baseline.json`
- `managed-maintenance/<installation>/<attempt>/write-observation.json`

The caller cannot select arbitrary keys. Each publication uses `If-None-Match:*`,
the expected bucket owner, SSE-KMS and the full body SHA-256 checksum. Existing
objects are never overwritten by this component. Missing response metadata,
unversioned storage, a changed KMS key or uncertain acknowledgement is failure;
there is no automatic retry, compensation, replacement or deletion.

A pin contains only kind, exact VersionId, full SHA and byte length. It is returned
only after GET of that exact version, validated account/key/version/length,
bounded canonical UTF-8 JSON and full body equality. A successful PUT alone never
produces an acknowledged pin. Observe methods use exact-version GETs only.

## Evidence integrity

Shared strict schemas now serve both the probe producer and custody component.
Baseline validation requires unique sorted credential UUIDs and an exact
maintenance binding and registry digest. Reports require 401/403 statuses for
each standard operation, unique sorted UUIDs, consistent retained-object count,
the original core observation digest, and explicit narrow scope with all broader
authority/quiescence flags false.

Reports are checked against the retained baseline: original body SHA, registry,
exact tested IDs and chronological ordering must match. Recomputing a substituted
report's own hashes cannot make it match another baseline or credential cohort.
These are integrity checks; a digest is not an attestation that someone executed
the probe. Actual custody, publisher identity and source-bound execution remain
separate acceptance requirements.

Baseline bodies remain bounded to 8KiB and reports to 16KiB. The maintenance
control head retains its existing 8KiB limit; putting both full 50-key artifacts
inside it is not required or permitted by this implementation. Each SDK operation
has a 15-second deadline, and read bodies are destroyed on abort or exit.

## Uncertainty and next coordinator integration

Each component instance permits one publication attempt per kind. Conditional
creation also prevents a fresh instance overwriting an existing object. An
unacknowledged object can remain in storage; it must not be treated as permission
to revoke credentials or fill a missing original control transition. Observe
requires a supplied exact pin and does not guess a version after a lost response.
Read-only discovery/reconciliation of an unreferenced object is a separate future
operation, with no automatic promotion to dispatch authority.

The parent coordinator must next bind the probe registry without a circular plan
hash, create the active probe using its acknowledged acquired attempt, publish
and read back its baseline, and durably CAS the exact baseline pin into the
installation head before any revocation. After active refusal verification it
must publish/check the report and pin it with the final head observation. A lost
response at any barrier must remain consumed and unresolved. Read-only inspection
must read saved write reports; it must never repeat active write verification.
This integration has not yet been implemented, and the custody component alone
does not advance the default coordinator's phase or authority.

## Executed verification and limits

AWS SDK command models cover conditional creation, checksum/account/KMS
parameters, exact-version readback, fresh-instance observation, lost publication
acknowledgement, metadata/byte/pin tampering, recomputed compound substitution,
50-key size boundaries, explicit endpoint/retry settings and stalled-body abort.
The real writer component's existing HTTP-model tests use the shared baseline
schema. No real AWS bucket, IAM principal, retention setting or key was used.

No deployment, tenant policy adoption, external disclosure, cloud data transfer,
purge or source-host-loss test is implied. Common capture, active write/capability
and in-flight/control-plane fencing, current authority, full restoration,
independent physical custody and real provider/host-loss/reopening proof remain
within the full goal.
