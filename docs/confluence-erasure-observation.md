# Recorded Confluence target observation

`GET /integrations/confluence/erasures/:deletionId/observation?controlPageId=...`
is an explicit Owner dashboard operation. It observes the target already recorded
on this organisation's Confluence deletion job. It accepts no replacement site,
page, attachment inventory, deletion disposition or completion instruction.
Admin/Member roles, connector clients and reduced-level sessions are refused.
Responses are not cached.

Supply a different, known accessible current page as the legitimate access
control. The server reads it before the target. It reads the recorded page in
normal and Trash status and each recorded attachment directly and in the bounded
Trash inventory. The provider reader refuses non-GET content operations, more
than 256 requests or starting another request after 30 seconds. An already-issued
request retains the existing HTTP client's retry/deadline bounds; this is not an
absolute 30-second response guarantee. Targets are limited to 100 distinct plain
attachment IDs. Oversized, ambiguous and unsupported targets refuse.

The selected connection/site/generation is checked before and after token
resolution on every HTTP attempt, and again after observation. The recorded
target is reread before accepting a result. No job, audit, permission, deletion
state or source content is written by this observation. Normal purpose-bound
OAuth renewal may still update its credential lifecycle.

## Results and limits

| Result | Meaning |
| --- | --- |
| VISIBLE | At least one recorded object was returned in normal status. |
| TRASHED | No recorded object was observed in normal status and a recorded object was observed in Trash. |
| NOT_OBSERVED | Recorded IDs were not returned by these normal/Trash reads. Permission restrictions may hide them. |
| UNKNOWN | The connection, control, identity, recorded target or provider reads could not establish a consistent observation. |

A successful control page excludes an entirely unusable connection. It does
**not** establish access to a missing target or prove that a permission-masked 404
means absence. Consequently every result keeps `permanentErasureVerified`,
`allCopiesVerified`, `jobUpdated`, `providerMutationIssued` and `actionAuthorized`
false. The response includes the recorded-target digest and check time, not raw
provider errors, token values or download links. Observations are transient.

`COMPLETE_EXTERNALLY_REMEDIATED` remains an operator report. This endpoint does
not turn that report into verified erasure, requeue a job or rerun the destructive
eraser. Recorded IDs do not discover every copy, historical version or backup.
The retained-primary authority and independent recovery gates remain unchanged.

## Verification and continuation

Owners can open **Integrations → Retired Confluence copies → Observe recorded
Confluence target** for a publication with a recorded deletion job. The form
requires a separate accessible control page ID and starts a read only when asked.
It displays the recorded job, target digest, check time and uncertainty. Changing
the input clears the previous result; a failed request cannot leave an old result
presented as current. Result bindings and false authority/completion flags are
checked before display. Admins have no observation action; the endpoint still
enforces Owner, web-client and session permissions independently.

Focused service and actual route/client transport tests cover role/client/session
refusal, tenant-scoped lookup, legitimate control, ordinary/Trash visibility,
permission-ambiguous non-observation, changed site/grant/target, malformed/bounded
targets, redacted provider failure and rejection of a destructive request.
Existing automatic-erasure tests are retained unchanged. These are source/local
test results, not a live provider purge, deployed release or host-loss result.

The dashboard increment's final isolated run passed its one browser journey
against the real application and disposable PostgreSQL with a synthetic provider.
It asserted the complete deletion-job record unchanged, an accessible control,
permission-ambiguous non-observation, cleared stale output and an unavailable
control. The panel fit 320/768/1440 widths; light/dark WCAG checks passed after
correcting helper/panel colours and waiting for rendered theme transitions.
Earlier fixture-order/stamp refusals and contrast failures are preserved privately;
no SQL guard or accessibility rule was disabled. API checks passed 116/116.

Next integrate retained instruction/action/evidence records separately from the
transient provider result. Complete the scoped authorised sandbox
administrator action and subsequent readback. Never change completion semantics
or infer missing authority merely to produce a passing lifecycle result.
