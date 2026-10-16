# Review a retained source's synthetic Confluence copy

This API supports review preparation and Owner permission decisions for the
optional Confluence integration. It does not execute a provider deletion or
consume the recorded permission as one-use authority.

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
| `GET /publications/:publicationId/reviews` | Page through review receipts for one publication, including after a lost recording response. |
| `POST /:reviewId/permission` | Record one exact Owner permission decision against the registered synthetic scope, after the existing service re-observes the source and copy. |
| `GET /:reviewId/permission` | Read the tenant-scoped decision receipt and any permission/review withdrawal, including after a lost issuance response. This does not refresh source evidence. |
| `POST /permissions/:permissionId/withdraw` | Withdraw the recorded permission with an evidence reference and reason, retaining the original decision. |

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
`authorisesProviderIO=false` for reviews. Permission responses retain
`providerIOAuthorised=false`; the receipt lookup also returns
`currentSourceChecked=false`. Integration connection identifiers are not exposed
by issuance responses. Permission issuance is limited to four requests/minute
and an 8 KiB body, as distinct from the 128 KiB review body.

Issuance requires the exact scope/digest/evidence/expiry and explicit synthetic
purge/retain-primary attestation accepted by the existing permission service.
The authenticated organisation and actor are not body fields. The original
review can issue only one permission; withdrawal does not renew it. Use receipt
lookup to reconcile an unknown response, not a new issuance attempt. A stored
receipt, even if unexpired, is not a current-source check or permission to invoke
an arbitrary provider deletion.

No execution endpoint is exposed by this module. A current observation or stored
review must not be presented as proof of all provider-held copies, permission to
publish, permission to erase or proof of permanent erasure. Ordinary erasure still
refuses while a primary remains retained.

## Remaining execution stages

The [maintenance scope-registration command](confluence-synthetic-scope-registration.md)
provides preview-bound registration of the exact synthetic review. Owner
permission recording and withdrawal now use the guarded HTTP paths above.
Durable one-use consumption and uncertain-outcome quarantine, provider action/readback and
independent recovery are separate stages. They must be implemented and verified
before claiming the retained-source synthetic purge journey is complete. Existing
internal permission and ledger modules are not an operational shortcut around
those stages. Do not create scope rows using ad hoc SQL.

Product decision authority and the required recovery boundary are described in
[Product governance decisions](product-governance-decisions.md). Real provider
consent/purge actions require their specific operational authority; synthetic
route tests neither grant it nor certify a live provider.


## Reconcile a lost review response

Use the publication-scoped receipt list before recording another review when a
save response is lost. It returns at most 25 receipts plus an optional `nextCursor`.
Pass that exact opaque ID as `before` for another page; a cursor must belong to
the same authenticated organisation and publication. Unknown query fields and
foreign cursors are refused. Ordering is by opaque ID descending, not a claim
that IDs establish the time of human review. Compare the original evidence
reference, reviewer, reviewed/recorded times and snapshot digest; ambiguous
receipts require review rather than choosing a permission automatically.

The projection contains those receipt fields, expiry and withdrawal time. It
omits the complete stored review/inventory and connection identity. Empty results
do not disclose another charity's receipts. The route has a ten-request/minute
limit and returns `no-store`, including refusals. Receipt lookup performs no
provider observation or mutation and carries `currentSourceChecked=false` and
`providerIOAuthorised=false`; an unexpired receipt is not execution authority.

An empty page does not prove that an in-flight save cannot still commit. The
response carries `absenceProvesFailure=false`; retain the uncertainty instead
of automatically repeating a save because a receipt was not yet found.
