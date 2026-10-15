# Retained Confluence copy disposal authority

## Status

Contract increment, 15 October 2026. Synthetic engineering only. No runtime
route, durable permission, migration, provider call or deletion capability is
added by this increment. The deployed retained-source refusal remains intact.
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

## Next increments before execution

1. **Durable review and withdrawal:** authenticate the scoped reviewer through
   existing tenant controls; collect source and provider facts server-side;
   persist immutable approval identity, policy/evidence references and target
   snapshot under charity/source/publication locks. Model withdrawal separately.
   Enforce tenant, immutable-target and revision rules in SQL and test against
   disposable PostgreSQL with the restricted runtime role.
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
