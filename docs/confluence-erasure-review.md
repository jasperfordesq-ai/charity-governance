# Historical Confluence erasure review reports

An Owner can save a report beside the recorded-target observation in Integrations.
The report preserves three distinct things:

1. The original deletion instruction's time, requester and reason from its job.
2. The Owner's evidence reference, reason and optional report of an administrator
   moving content to Trash or permanently deleting it, with a separate reference
   and reported action time.
3. A fresh bounded provider observation, including uncertainty and the exact
   recorded-target digest. Missing or permission-hidden content remains ambiguous.

The original instruction and an administrator's claim are not provider
acknowledgements. Every saved report remains `operatorReportOnly: true` and
`actionAuthorized: false`. A receipt is explicitly historical and keeps
`currentStateVerified: false`. Neither saving nor reading a report completes,
requeues or deletes a job, consumes a disposal permission, authorises provider
content IO or proves permanent/all-copy erasure.

## Persistence and receipt identity

`POST /integrations/confluence/erasures/:deletionId/reviews` requires an active
Owner, full-level web session, explicit evidence review and a stable UUID request
reference. A current target digest and separate readable control-page ID bind
the requested observation. Reported actions require their own evidence/time;
future action times and extra authority fields refuse.

The new `CONFLUENCE_ERASURE_REVIEW_RECORDED` event uses the existing append-only
`SecurityAuditEvent` table. Its context is bounded, versioned and parsed again
on read. The report transaction locks the charity/Owner, rechecks active
membership and target identity, and saves the original instruction plus observed
facts. No external request runs while those locks are held.

The unique index binds organisation and original request ID for this context
kind. Concurrent identical saves converge on the original event. Changed input,
actor or target with the same request ID refuses. An existing original receipt
is checked against its original input before any new provider observation; an unknown save response
does not authorise another request or reconstruct missing evidence.

`GET /integrations/confluence/erasures/reviews/:clientRequestId` accepts either
the original UUID or the existing audit event ID. It is scoped to the current
Owner's charity and this event type. It reads no provider content. The dashboard
freezes an uncertain save and offers receipt lookup instead of an automatic
second POST. A separate historical lookup supports a new browser session using
the event ID from Governance Audit → Integrations. That general feed remains
redacted; it does not expose report context to an Admin or Member.

## Migration and recovery boundaries

Two forward migrations add the event enum, then its subject-rule admission and
request uniqueness index. The enum value is not used in the transaction that
creates it. Existing person-event subject requirements and append-only triggers
remain. No old migration checksum, table model or historical event is rewritten.

These are local audit records, included in ordinary full database recovery.
They are not independently current control/decision history and are not added
as disposal authority to the eleven-group Confluence execution ledger. An old
backup may omit newer reports. Actual independent custody, source-host loss,
current preservation/disposal decisions and guarded reopening remain separate
requirements. No report permits bypassing those gates.

## Verification scope

Focused tests cover original instruction separation, uncertain observations,
lost-commit receipt reuse, concurrent saves, changed input/target, JSON field
order, revoked Owner and invalid authority/action inputs. The isolated browser
uses the real application/API/disposable PostgreSQL and the private synthetic
Atlassian service. It loses the actual POST reply after commit, retrieves the
original receipt, checks one event, verifies append-only/unique/subject SQL
constraints, reloads and retrieves by event ID, and preserves the full deletion
job record. Exact dated results are private. This is not a real provider purge,
independent recovery or public-production acceptance.

Final local verification: 165 focused API checks passed; connector checks passed
427 with two existing Windows skips; API/shared builds, web/E2E types and ESLint
passed. The final isolated browser journey passed in 5.0 seconds (6.0 total),
including actual PostgreSQL rejection of audit edits, duplicate request identity
and a person-event without a subject. Both themes and three widths remained
covered. The initial native run exposed the missing subject-rule admission;
the forward migration was corrected before publication. No historical migration
or audit immutability rule was weakened. These are synthetic-provider and local
database results, with deployment and live acceptance still separate.
