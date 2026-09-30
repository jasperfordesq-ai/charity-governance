# CharityPilot DPO reviewer navigation

Source checked: 2026-09-30. This guide maps the current checkout, not Nikita's
deployed dashboard. Routes and controls below need checking on the exact
reviewed tenant and release before they are offered as live evidence. A
CharityPilot Owner or Admin can see the charity-wide review areas; a Member
has narrower record access and can manage only their own sign-in controls.

Document access, lifecycle and publication decisions, deletion holds,
written-provider verification and controlled Data Requests cases require a
web session. The connector's metadata-only or excluded tool catalogue is also
enforced at these API routes. A web session alone does not establish that a
reviewer inspected the file or that a case outcome is legally approved.
Governance Audit feeds and risk control verification/history likewise require
web review; their connector tool exclusions are enforced by the API.
Detailed organisation, deadline, Minute Book and compliance histories and
replay diagnostics also require web review; the authorised Team Security
Audit connector read remains separate.
The Vault's replacement, mirror, control and deletion review feeds and
Confluence copy/citation inventories also require web review. Authenticated
connector file delivery remains a separate, full-data-scoped operation.
The browser action-approval list/grant and Confluence connection setup also
require web sessions. The terminal connector approval command retains its
separate password-confirmed route.

In Documents, use **Load older documents** until the list reports all files
loaded before using evidence counts as a complete on-screen inventory. While
more pages remain, the summary and evidence prompts are labelled partial.
Older pages use a tenant-bound file cursor. Refresh when the screen flags a
changed count or when files are changed during review; this navigation does
not classify file contents or create a fixed database snapshot.

| Nikita's requested area | Dashboard location | What the current source provides | Boundary for review |
| --- | --- | --- | --- |
| Minute Book, Governing Acts and Written Resolutions | **Minute Book** at `/minute-book` | Current governing acts, written resolutions, void history and related Board approval records. Act and resolution edits have a separate append-only change history in Governance Audit. | Owner/Admin only while the records' Member audience remains unclassified. The AI irreversible-actions page at `/approvals` is a separate human approval queue, not the Minute Book. |
| Governance/application audit trail | **Governance Audit** at `/governance-audit`; **Team & Permissions** at `/team` for Security & Ownership Audit | Paged retained feeds cover organisation, deadlines, reminder state changes, Minute Book, documents and visibility, Vault download preparations, risk and register changes, control verification, compliance and report preparations, storage-deletion queue/attempt/recovery events, data-request review/target/actual-response/source-area changes and evidence links, human action approvals and Confluence integration events. The reminder feed contains status transitions without recipient addresses, deadline titles, provider IDs or error text. The source-area feed shows structured decision metadata; reasons and controlled-archive references stay in the individual Data Requests case. | Events begin only when their relevant migrations and code are deployed; older changes cannot be reconstructed. Reminder events record application/database status, not independent email receipt. A prepared download/report event proves server-side preparation, not client receipt. A reviewer-recorded response date is not independent delivery proof. Integration connect/disconnect auditing has documented best-effort windows. These feeds are not a complete history of every application mutation. |
| Document-level access and visibility | **Documents / Evidence Vault** at `/documents` | Owner/Admin can assess full-file content as `UNASSESSED`, `MEMBER_SUITABLE` or `RESTRICTED_SENSITIVE`, separately from lifecycle and `RESTRICTED`/`MEMBER_VISIBLE` visibility. A new suitable assessment requires a prior authenticated download preparation by the same reviewer for the same document revision and bytes. Member list, detail, search, activity and download require an expressly Member-suitable assessment, verified written provider, stored byte fingerprint and reviewed lifecycle. Download checks the served size and SHA-256 after storage access. The decision and actor are retained in document history. | Older approvals without a fingerprint are withheld until a fresh reasoned review; the Vault labels these rows for re-review. A reviewer must download and inspect the actual bytes and metadata before marking a file suitable for every active Member. The server's preparation receipt does not prove client receipt or human inspection. A released file is downloadable in full. Statutory-member records, complaints, conflicts and the full Compliance Record remain Owner/Admin-only. Actual tenant files and Confluence audiences need controller/DPO review; Confluence permissions are separate. |
| Authentication/security settings | **Security & Data** at `/security-data`, then **Team & Permissions** at `/team` | Each signed-in user can manage personal authenticator MFA, password change/recovery and their own active session families. Owner/Admin can manage charity-wide roles, invitations, sessions and the Security & Ownership Audit; replay diagnostics are in Security & Data. Expired protected pages now renew in the browser after a no-store redirect, avoiding refresh calls from separate web workers. | MFA enrolment is available per account; role-wide mandatory MFA is not established. New replay diagnostics and the source fix cannot explain earlier events retroactively. The exact reviewed account, browser posture and event logs must be correlated before assigning a cause. |
| Retention, deletion, recovery and erasure administration | **Data Requests** at `/data-lifecycle`, **Documents** at `/documents`, **Governance Audit** at `/governance-audit`, and **Integrations** at `/integrations` for Confluence copies | Owners/Admins can record an opaque request reference and assessment history, review eight data-source areas individually with reasoned, retained assessments, set or withdraw a case-specific response target, record/correct/withdraw an actual sent time with a controlled-archive evidence reference, review past unresolved targets in a separate queue, link reviewed Vault/storage evidence, place a per-document hold on ordinary Vault deletion, and inspect provider-pinned deletion jobs and attempts. Governance Audit pages deletion summaries and response-change metadata; the Admin storage-deletion history API pages detailed job metadata. Integrations pages recorded non-retired copies for audience review and separately pages retired copies with a reasoned, typed-confirmation erasure request for an eligible publication. | An area begins **Not reviewed**. An `IN_SCOPE`, `NEEDS_FOLLOW_UP` or `NOT_APPLICABLE` entry is a reviewer assessment, not proof of full discovery, deletion or case completion. Response targets are manually entered operational markers, not calculated statutory deadlines or deletion authority. An actual sent time is a reviewer assertion, not independent delivery proof or a calculated retention expiry. The case queue does not perform erasure or declare completion. Ordinary Vault deletion is limited to an unheld draft and has no deleted-item restore. The document hold is not an application-wide legal-hold decision. No approved application-wide schedule, automatic per-class disposal, deleted-item recovery or permanent-purge console is implemented. A recorded page or queued erasure job does not prove provider existence or purge. Unrecorded/independent copies and actual Confluence audiences remain outside this inventory. Primary-object absence checks do not prove versions, exports, replicas or backup expiry. |

## Related first-pass review points

- **Connector change outcomes:** Governance Audit now includes a paged
  Owner/Admin feed of recorded connector write attempts, including refusals.
  It shows method, matched route, HTTP status and request ID without the
  connector session ID or supplied free-text reason. An unmatched request
  path is masked. This log is written after the response; a missing row or
  successful HTTP status must be checked against operational alerts and the
  relevant domain history before asserting an action outcome.

- **Member access review freshness:** an edit to a file's card after it was
  assessed as Member-suitable resets the content assessment and restricts
  Member visibility together. The restricted history records the change. A
  reviewer must inspect the revised record before releasing it again. A file
  with unverified written storage custody cannot be assessed as Member-suitable
  or released; legacy unknown-provider rows are hidden from Member paths.
  Changing the recorded file identity also requires withdrawing the prior
  assessment. A Member download now checks the current file size and SHA-256
  against the server-recorded assessment fingerprint; an overwrite at the
  same path is withheld. Provider history and human review remain separate
  evidence questions.

- **Draft deletion decision:** the Owner/Admin Vault asks for a reason before
  deleting an unheld draft. A draft with a linked standard or cited
  charity-managed Confluence page must have that link reviewed separately
  before deletion; the database also prevents a direct row deletion while a
  link remains. The reason stays in restricted document change history after
  the row is removed. The action does not create a restorable deleted item or
  prove stored-file, version or backup purge.
- **Failed storage cleanup:** the Owner/Admin Documents page now lists failed
  deletion jobs in pages and can submit a reasoned, typed-confirmation retry
  for eligible jobs. This schedules another attempt to delete the recorded
  target. It cannot restore a removed Vault document or prove permanent purge.

- **Compliance Record exports:** `/export` offers the full internal report to
  Owner/Admin and a separately labelled minimised approved-snapshot review
  draft. Its external recipient, field-level disclosure policy and statutory
  suitability have not been approved. Both preparations are recorded in
  Governance Audit.
- **C1 data-protection risk:** `/registers` exposes risk history, dated control
  verification and records needing review to Owner/Admin. Do not change C1's
  status until the original admin-email fix, verifier, date, evidence and
  affected release are matched to the current risk revision.
- **Session replay:** `/security-data` has bounded Admin replay diagnostics;
  `/team` has the separate security event history. New events carry correlation
  fields. The proxy now leaves browser refresh rotation to the cross-tab
  renewal flow. If cross-tab Web Locks are unavailable, an expired browser
  session is sent to sign-in without spending its refresh token. Nikita's historical `SESSION_REPLAY_DETECTED` events still
  need restricted event/log review on the exact tenant. A quarantine event
  alone does not establish benign concurrency or compromise.
- **Confluence copies:** the Vault shows whether a recorded page belongs to
  the currently connected site, the connection is inactive, or the recorded
  page site cannot be compared. Those cases are
  flagged for original-site review rather than shown as a healthy current
  copy or offered for retry. The retry API also checks the active destination
  and recorded site. A publication approval now names the selected site and
  space. A later destination change needs a reasoned reapproval when no page
  was recorded; a recorded page in another site or space requires separate
  copy review before publication can resume. The migration withdraws older
  unbound approvals without erasing provider pages, so those files need
  individual review after deployment. The Vault warns when approval has been
  withdrawn but a page remains recorded. The recorded reference and cached
  state do not prove that the page still exists or that a provider purge occurred.
  When approving again, an Owner/Admin sees the selected site and space in
  the document control dialog; a changed selection refuses the saved decision.
  The decision transaction holds the selected destination row until commit,
  including when another administrator changes the space concurrently.
  A recorded page whose stored site or space differs is flagged for copy
  review and cannot be reapproved through that dialog.
  The Admin MCP `confluence_publications` read pages the same retained retired
  references through `before`/`nextCursor`; its privacy gate keeps the page
  cursor. The Integrations lists now show the recorded site, space and page
  IDs before review. The non-retired list also compares the document's saved
  publication approval with that recorded destination; an unmatched or
  unknown result needs review. Missing site/page IDs prevent the retired
  UI erasure request. The connector's closed personal-data gate withholds
  those identifiers. Neither interface is a live provider inventory or
  purge receipt. Integrations also pages current charity-managed cited pages
  separately, showing the recorded site/page and cited version with the
  linked Vault status; CharityPilot does not erase these pages. A current
  citation must be reviewed and removed before its Vault document can be
  deleted. Removing the citation removes its current row, so this list is not
  historical evidence of all pages ever cited.

The dashboard-only Confluence setup/citation/erasure and Vault retry controls
require web sessions at the API, including when a connector session calls the
route directly. Invitation-link retrieval, ownership transfer and billing
checkout/portal starts also require a web session. This channel check does not verify the operator's judgment or
prove that a remote page or backup was purged.

The private DPO work ledger is `.charitypilot-private/ROADMAP.md`; the
full-platform issue status is `docs/platform-remediation-audit-2026-07-10.md`.
Neither local tests nor this navigation guide are a DPO sign-off or evidence
that these controls are deployed to Nikita's tenant.
