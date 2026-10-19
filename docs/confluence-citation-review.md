# Historical cited-page review reports

Owners can save a historical report from **Documents → Confluence citations →
Observe cited page → Prepare citation review report**. The report retains the
recorded citation identity/version/times, a fresh page-only provider observation,
the review evidence reference/reason, and an optional separately evidenced
administrator action claim. `instruction: null` explicitly records that there is
no deletion instruction on this path. An operator report is not an instruction,
acknowledgement, permission or proof of permanent erasure.

`POST /integrations/confluence/references/by-id/:referenceId/reviews` requires an
active charity Owner, full-level web session, current target digest, separate
control page, explicit evidence review and a stable UUID request reference.
Reported Trash/purge actions require their own evidence reference and time;
future action times, extra instruction/authority fields and missing evidence
refuse. The observer's uncertain outcome is preserved, not promoted to success.
The citation must still belong to a live document when the report is saved.

## Saved receipt and reconciliation

The append-only `CONFLUENCE_CITATION_REVIEW_RECORDED` audit event stores a bounded,
versioned context. The save transaction locks the organisation and Owner and
rechecks active membership and exact citation identity. Citation creation/removal
uses the same organisation lock. Provider reads run before the transaction;
there is no provider request under a database row lock.

The unique original-request index and canonical parsed input digest make identical
concurrent saves converge to one event. A retry first checks for the original
receipt, without contacting Confluence. Reusing the UUID with a different actor,
input or cited target refuses. A lost save response freezes the form and offers
read-only lookup; it never causes an automatic second POST.

`GET /integrations/confluence/references/reviews/:clientRequestId` accepts the
original UUID or audit event ID and requires the current active Owner. It reads
only that charity's citation-review event, without provider access, and remains
available after unciting. **Integrations → Retired Confluence copies → Look up a
historical cited-page review report** supports a later session. Event IDs are
also visible in the redacted Governance Audit integration feed; full context is
not added to that general feed. The existing deletion-job report lookup remains
separate and cannot read a citation receipt as an erasure receipt.

Every returned receipt remains historical, `operatorReportOnly: true`,
`currentStateVerified: false` and `actionAuthorized: false`. Its observation scope
is `CITED_PAGE_ONLY`; attachments, historical versions, backups and unrecorded
copies are excluded. Neither save nor lookup creates/completes/requeues a
deletion job, changes a citation, consumes disposal permission or writes provider
content. Ordinary purpose-bound OAuth renewal may still update credentials.

## Migration, recovery and verification limits

Two forward migrations add the enum value, then subject-rule admission and a
separate original-request uniqueness index. Existing person-event subject rules,
erasure-review admission, uniqueness and append-only guards remain. Old migration
checksums and old receipt formats are unchanged.

Reports are local audit data included in ordinary full-database backups. They
are not independently current decision history, an addition to execution-ledger
authority, or proof that a backup includes subsequent preservation/disposal
decisions. Independent custody and physical host-loss recovery remain required.

Focused tests cover original receipt reuse, concurrent/lost-acknowledgement saves,
identity changes, revoked Owner, absent instruction, unknown observations and
receipt lookup after unciting. The disposable browser journey checks the actual
application/API/PostgreSQL with a fake provider, including native immutability,
unique-request and preserved person-subject rules. The original erasure-report
browser case is retained to verify the shared form. Dated execution results and
failures are private. Local tests do not establish a live provider action,
deployed release, permanent erasure or independent recovery.

Final local verification passed 165 focused API checks and 427 connector checks
with two existing Windows skips. The disposable browser passed both citation and
existing erasure-report journeys (17.7 seconds total). It verified lost-save
reconciliation, one citation-review event, lookup after unciting, unchanged
citation/zero jobs, native audit edit/duplicate/subject refusals, three widths
and both-theme WCAG checks. API/shared builds, web/E2E types, lint and secret/
control-byte checks passed. Subject-rule text was compared against the previous
migration: only the explicit new event admission differs; old indexes remain.
