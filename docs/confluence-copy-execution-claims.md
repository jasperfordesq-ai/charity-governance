# Retained-copy execution claims

## Current capability

The internal `ConfluenceCopyExecutionClaimService` durably consumes one local
permission into an immutable, tenant-bound claim. There is no execution route,
scheduler caller or provider request. Every claim has phase `QUARANTINED` and
`providerIOAuthorised=false`, enforced by database constraints. A claim cannot
be edited, deleted or truncated to renew the permission.

The database serialises the organisation, active Owner, permission, current
review/source/publication, scope and connected integration. It checks expiry,
withdrawal, source holds and revision, exact grant generation/site, and durable
WAL settings. Uniqueness permits one claim per permission and one operation ID
per organisation. A caller-provided timestamp is replaced by the database clock.

This checks local state and the recorded digest. It does not freshly download
source bytes, observe remote inventory or independently authenticate current
history. Responses explicitly carry `currentSourceChecked=false`. The existing
single-attempt transport primitive is not called by this service.

## Lost responses and restart

The operation ID is chosen before consumption. If its commit response is lost,
reconcile the existing receipt under an active Owner session in the same tenant.
The receipt is historical evidence, not renewed authority. A new operation ID
cannot consume the same permission again. A newly connected database client can
read the original record; this is distinct from testing physical host loss.

No automatic destructive retry or expiry-based lease takeover is implemented.
An eventual coordinator must retain independent current authority and execution
outcomes, reconcile ambiguous requests, and separately check exact provider
state before proceeding. Claim expiry must never erase consumption history.

## Recovery compatibility

Current purge/restore comparison is format14 and includes hashed claim records.
It rejects a restored state missing a later claim. Exact format13 inventory and
SQL remain available for older databases, alongside earlier explicit formats;
format mismatch cannot be treated as a successful current comparison. The
schema probe refuses partially present newer structures.

The independent Confluence V1 archive still contains eight decision/publication
groups. It does not contain these claims. A new database guard therefore refuses
creating a V1 archive capture when the organisation has a claim. Existing archives
remain evidence of their stated scope; they cannot establish recovered execution
history or permission to reopen. Compatible independent claim/outcome publication
and recovery are required before activating a provider consumer. The database
comparison alone does not supply independent freshness or an off-host source.

## Verification boundary

The joined disposable PostgreSQL proof races two claims and observes one commit,
reads its receipt through a new client, rejects mutation/truncation and unsafe
WAL, and rejects an older snapshot missing the claim. It also checks refusal of
a new archive capture that omits claim history. Provider inventory in the parent
permission fixture is synthetic. No real consent, deletion, independent custody,
physical-crash recovery or complete user journey is established by this proof.


A separate synthetic permission exercises an acknowledgement lost after a real
PostgreSQL commit. The service reports an unresolved operation without exposing
the injected private error; a new client finds the exact committed claim by its
original operation ID. A subsequent claim attempt inserts no second row. This
proves database-response reconciliation, not reconciliation of a provider request.
