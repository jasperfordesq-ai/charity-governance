# Retained Confluence copy disposal authority

## Status

Review contract and durable evidence-storage increments, 15 October 2026.
Synthetic engineering only. The source adds an internal review/withdrawal
service and migration; no runtime route, executable permission, provider call
or deletion capability is added. The migration is not deployed. The deployed
retained-source refusal remains intact.
Private item-specific decisions and evidence stay in the ignored roadmap.

## Two distinct decisions

Retaining a governance record in the Vault and disposing of its Confluence
publication are separate decisions. Retiring a document or withdrawing its
publication approval does not grant permission to purge either object.
The existing DRAFT-only primary-removal workflow must remain unchanged.

`confluence-retained-copy-review.ts` prepares a review candidate for a retained
RETIRED source with withdrawn external approval and no asserted deletion hold.
The candidate binds charity, source identity/revision/hash, publication
identity/revision, cloud/site/space/page, page versions and attachment versions,
hashes and sizes. Explicit review, synthetic-scope, retention, hold and inventory
evidence references and caller-specified review/expiry times are required.
There are no invented retention periods or default approval lifetimes.

Inventories reject duplicates, missing current versions, versions ahead of the
reported current version, incomplete or Trash status, malformed identifiers,
unexpected fields and ambiguous origins. Ordering is canonicalised. A fresh
observation of identical content may have a later observation time; comparison
requires that time to be at or after review and no later than the supplied
current time. Content and revision changes require a new review.

Every candidate explicitly carries `authorisesProviderIO: false`. A digest
compares content; it is not a signature, an authenticated reviewer, proof of
inventory completeness, proof of a synthetic tenant or a durable permission.
Caller-supplied evidence and flags must not be trusted as any of those things.
The parser bounds inventories to100attachments and1000versions per attachment
or page. Exceeding a bound refuses the candidate, never truncates the inventory.

## Durable evidence storage

`ConfluenceRetainedCopyReviewService` records parsed review evidence under the
authenticated charity Owner's identity and the database clock. SQL repeats
Owner/charity, retained-source/hold, publication, revision, target and time
checks under locks. The original row is append-only; withdrawal is a separate
tenant-bound, append-only row. Both reject UPDATE, DELETE and TRUNCATE.
`authorisesProviderIO` is constrained to false even for direct SQL inserts.
The service has no route and neither erasure request nor worker imports it.

Provider inventory, byte hashes, synthetic status and evidence references are
still assertions to review: storage does not establish their truth or sign a
policy. SQL does not recompute the JavaScript canonical snapshot hash or prove
all nested version inventories. Future permission issuance must independently
collect/revalidate those facts and the complete contract; it cannot treat a
stored row, matching digest or absence of a withdrawal as execution authority.

Existing independent-recovery bindings refuse new review/withdrawal writes
until independently recorded outcomes are supported. Conversely, review history
prevents new binding activation until its baseline/history can be replayed.
Those symmetric refusals preserve the missing-history gate; they do not supply
independent storage, replay or a host-loss recovery result.

## Next increments before execution

1. **Permission issuance after fact collection:** internal Owner-scoped review
   storage, separate withdrawal and SQL immutability/revision checks now exist
   with disposable PostgreSQL tests under a restricted DML role. Still collect
   provider facts and source byte proofs server-side, establish the scoped
   synthetic fixture and selected disposal policy, then implement explicit
   permission issuance under the same transaction locks. Stored review evidence
   alone is not that permission.
2. **Independent recovery:** retain the authority, withdrawal, possible-copy
   facts and execution intent in the applicable independent history. Prove
   replay after stale-backup recovery; a restored approval cannot resurrect a
   withdrawn or spent execution permission.
3. **One-use provider execution:** request and worker must recheck the same
   approved policy, holds, exact target inventory and source state. Persist the
   decision before provider I/O; handle crashes, lost acknowledgements and
   retries without turning a stale approval into renewed destructive authority.
   Only then add an explicitly guarded retained-source alternative to the
   existing request, SQL insertion and worker checks. Do not remove those
   checks as a standalone change.
4. **Synthetic journey and provider acceptance:** build matching synthetic
   source/publication fixtures through supported flows, freshly review complete
   target inventories, and obtain separately scoped connection/action authority.
   Test concurrent withdrawal, holds, changes and retries before the provider
   operation. Distinguish recoverable Trash, recorded-target purge/readback,
   UNKNOWN outcomes and all-copy/provider-retention limitations.

These increments remain part of the full acceptance work. No production
retention policy, provider grant, live governance record disposal or independent
reviewer acceptance follows from the contract tests.
