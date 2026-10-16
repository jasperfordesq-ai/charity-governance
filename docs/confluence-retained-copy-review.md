# Review a retained source's synthetic Confluence copy

This API is the review-preparation stage of the optional Confluence integration.
It does not issue a purge permission or execute a provider deletion.

## Access and target binding

All paths below require an active, verified organisation Owner using a full-data
web session. Admin, Member, connector, revoked and withheld-data sessions are
refused before inventory or review operations. The session supplies the actor and
organisation. Callers cannot select another organisation or integration through
query parameters. Responses use `Cache-Control: no-store`.

Base path: `/api/v1/integrations/confluence/retained-copy-reviews`.

| Method/path | Purpose |
| --- | --- |
| `POST /observe/:publicationId` with `{}` | Observe the exact retained local source and its stored Confluence target using the organisation's existing connection. No caller-supplied site, page, storage path or hash is accepted. |
| `POST /` | Record the complete explicit synthetic review accepted by `prepareRetainedConfluenceCopyReview`. The service and database recheck actor, tenant and current source/publication. |
| `POST /:reviewId/withdraw` | Withdraw a review with a strict evidence reference and reason; immutable original evidence is retained. |

The observation route has a four-request/minute route limit and passes a
60-second cancellation signal to the existing bounded observer. Observations
read source bytes and remote inventory and may refresh the existing OAuth token.
They do not establish a new grant or perform a remote mutation. Configured
provider permissions, scope and network access must already exist.

## Review meaning

The recorded review binds the authenticated reviewer, an exact source revision
and hash, a retired publication and its target/inventory, review time/expiry and
explicit retention, hold, inventory and synthetic-evidence references. Review
preparation retains the primary and proposes purging only the synthetic remote
copy. The service validates the strict review schema and existing database guards;
recording a review does not independently prove a human synthetic assertion.

Observation responses deliberately omit internal connection identity. They retain
`syntheticVerified=false`, `allCopiesVerified=false`, and
`actionAuthorized=false`. Recording/withdrawal responses retain
`authorisesProviderIO=false`.

No execution endpoint is exposed by this module. A current observation or stored
review must not be presented as proof of all provider-held copies, permission to
publish, permission to erase or proof of permanent erasure. Ordinary erasure still
refuses while a primary remains retained.

## Remaining execution stages

Maintenance scope registration, separate Owner permission, durable one-use
consumption and uncertain-outcome quarantine, provider action/readback and
independent recovery are separate stages. They must be implemented and verified
before claiming the retained-source synthetic purge journey is complete. Existing
internal permission and ledger modules are not an operational shortcut around
those stages. Do not create scope rows using ad hoc SQL.

Product decision authority and the required recovery boundary are described in
[Product governance decisions](product-governance-decisions.md). Real provider
consent/purge actions require their specific operational authority; synthetic
route tests neither grant it nor certify a live provider.
