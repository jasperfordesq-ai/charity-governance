# Confluence acceptance and data-flow matrix

Current continuation baseline: 19 October 2026. This maps the selected-document
architecture to implementation and the evidence still required. A source path or
a passing fake-provider test does not establish live provider acceptance.
Private dated execution receipts belong in the ignored continuation handoff.

## Dated live-provider observation

### Historical cited-page reporting

An Owner may now save an evidence-referenced historical cited-page report,
including the exact recorded citation, a fresh uncertain observation and a
separately evidenced optional action claim. The instruction is explicitly null.
Original-request/receipt lookup survives unciting, without another provider
request. See [the report contract](confluence-citation-review.md). This source
increment closes the need to invent a deletion job to retain a report; it does
not establish independent custody, current-release live provider acceptance,
actual disposal or physical host-loss recovery. Old dated observations below
retain their original source and evidence limits.

The subsequent supervised real-sandbox run used exact source `ef164249` and schema
199. Supported Owner controls observed the existing page/control and saved one
historical citation report with `instruction: null`, `NOT_REPORTED` administrator
action and a fresh VISIBLE observation. A fresh Integrations view retrieved the
original report by audit ID. Independent SQL compared the complete citation,
citation-audit and report rows: saving preserved the citation/audit rows, and
receipt lookup changed none of them; zero deletion jobs remained. The exact
source archive had no application overlays, with only a generated Next declaration.
No new grant, provider content write, actual Trash/purge or VM deployment ran.
This closes the scoped real-provider-backed local report/readback check, while
current independent custody, host loss and actual disposal remain open. Exact
receipts and any action-time authority are held privately.

### Cited-page lifecycle observation without deletion intent

Owners can explicitly observe an existing citation's page using a separate
accessible control, without queuing disposal. The result distinguishes visible,
Trash, permission-ambiguous non-observation and unknown states. It is page-only;
no attachment inventory is recorded in a citation. The final read rechecks the
citation and live linked document, and the current site/grant is checked around
provider access. This is separate from version comparison and the deletion-job
observer. See [the scoped contract](confluence-citation-observation.md). Exact
test/live results remain private; no real provider acceptance, durable jobless
review report, permanent erasure or host-loss completion follows from the source.

On 19 October a fresh exact archive of `6f7090a8` ran in the existing supervised
loopback synthetic runtime, retaining its approved real sandbox OAuth connection.
The supported Vault form cited an existing synthetic page at version 3. The new
observer read that page with a separate existing accessible sandbox page as the
control and returned VISIBLE. Independent SQL readback showed the complete saved
citation and selected citation-audit metadata unchanged and zero deletion jobs. Reconstructed
selected-row SHA-256, with the database's UTC timestamp interpretation, matched
the displayed target digest. No migration, seed, new grant or provider content
write ran. Application source had no overlays; Next regenerated its declaration.

This is real provider/OAuth page-read evidence for that exact source in a
supervised development runtime. It does not establish Trash/purge, attachment or
historical-version coverage, deployed personal-server/public-production acceptance,
durable jobless review reporting or independent recovery. The synthetic citation
remains available for further testing; removal is a separate local action. Exact
identities, timestamps, digest and screenshots are in the private dated live receipt.

### Citation workflow

Owners and administrators can open **Documents → Confluence citations** beside
a named Vault record. The form shows the connected site, accepts a page ID,
records the title/version read by the API and provides explicit local citation
removal. This does not publish, approve or erase the Confluence page. Recorded
versions are historical observations; refreshing the citation list does not
check current upstream versions or replace the cited version.

Each saved citation also has an explicit **Check upstream version** action.
`GET /integrations/confluence/references/by-id/:referenceId/check` reads only
that scoped citation's page through the current recorded-site connection. It
returns a timestamped CURRENT, SUPERSEDED or UNKNOWN observation without changing
the cited version. The live authorisation generation is checked around token
resolution and the provider read. Changed/disconnected sites, unavailable pages,
provider errors and lower/invalid versions cannot prove CURRENT. No scheduler or
list refresh keeps unused grants alive. Results are not retained as approvals or
historical-content verification. The disposable browser proves CURRENT through
the application/client. A later supervised live sandbox run against application
source `9611bd9f` observed CURRENT, an actual upstream edit, SUPERSEDED with the
original citation unchanged, and specifically approved unciting with source
preservation. See the scoped observation below; production-profile acceptance is
still separate.

The web-only `GET /integrations/confluence/reference-target` returns only the
connected site ID and URL (null when disconnected), under the existing Admin
route guard. `POST /integrations/confluence/references/:documentId` now requires
`expectedSiteId` with `pageId`; a changed site refuses before provider read.
Deploy the matching API/web together. Citation creation also rechecks the live
Vault record under the organisation lock after the provider read. This closes
the race with removal into Deleted Items. Member and connector refusals remain.

The browser journey checks normal create/remove, independently read audit rows,
zero deletion jobs, a lost save response without duplicate POST, and modal bounds
at 320/768/1024/1440 pixels against the disposable application/fake provider.
Separate sandbox browser evidence observed a real page citation at version 2,
its specifically approved local removal and unchanged upstream version history.
The live runtime used documented source overlays; it is not a clean deployed
release, purge or host-loss acceptance.

### Live version monitoring and source preservation

The later 19 October run used a fresh archive of `9611bd9f`, retained synthetic
database and previously approved sandbox OAuth grant, without application-code
overlays, migration or seed. The application cited a real sandbox page at its
current version, checked CURRENT, then observed SUPERSEDED after a labelled
synthetic edit through Confluence. Independent database readback proved the full
citation and citation-audit rows were unchanged by both checks. After specific
action-time authority, unciting removed only that row and added its audit event;
no storage-deletion job appeared. Confluence history retained the new current
version and earlier versions. Its attachment inventory retained the same ID,
size and current version; this run did not re-download and hash attachment bytes.

This is actual OAuth/provider and exact application-source evidence in a
supervised loopback development runtime. Next.js regenerated its type declaration
file; no application source was patched. The attempted compiled web runtime
refused plain HTTP under public-production HTTPS guards, which were preserved.
It is not private-VM/public-production certification, provider-wide inventory,
purge, independent recovery or verification of historical page contents.
Detailed identities, startup attempts and proof are held privately in
`citation-monitor-live-run-2026-10-19.md`.

On 19 October, a signed-in read-only check of the existing synthetic sandbox
page observed its current version and version history. Its attachment inventory
showed one current attachment version; an authenticated browser download returned
243 bytes whose SHA-256 matched the original fixture and the retained 8 October
restored-file receipt. This proves current access and byte identity for that one
synthetic attachment. It is not an application OAuth test on the latest release,
an exhaustive provider inventory, a new Trash/purge execution or host-loss proof.
Exact targets, hash, downloaded bytes and screenshot remain in the private receipt
`confluence-live-readback-2026-10-19.md`.

## Evidence reconciliation: 19 October

The following completed observations should be reused. They do not turn a
historical or synthetic result into current hosted acceptance.

| Requirement | Evidence already collected | Remaining proof |
| --- | --- | --- |
| Owner retained-copy permission and withdrawal | The isolated browser run for `e25d6c99` passed all eight composed cases, including successful issuance/withdrawal and lost-response reconciliation through the real application API and disposable PostgreSQL. Provider observations were explicitly synthetic. | Actual disposal authority, provider execution and independently recoverable outcomes remain separate. The missing positive browser journey is no longer an implementation task. |
| Local disconnect versus upstream revocation | The 11 October sandbox run on `db776db8` observed two sealed credentials before disconnect and zero afterward. Atlassian still listed the app after an accepted revoke call; subsequent administrator removal was observed. This drove the audit-field correction. | This is historical live evidence. It does not prove the state of the later reconnected grant or a fresh disconnect on the current release. Keep the approved active test connection until a scoped lifecycle run needs its removal. |
| Current disconnect semantics | Current integration route records `atlassianRevokeEndpointAccepted`, always warns that upstream withdrawal is unconfirmed, and the service deletes credential rows transactionally with DISCONNECTED state. | Source inspection supports the intended distinction; it is not a new provider execution, current grant readback or independently held recovery receipt. |
| Reference/version monitoring and source preservation | The clean `9611bd9f` supervised sandbox run described above observed CURRENT then SUPERSEDED; unciting retained upstream history and produced no deletion job. | Historical body/attachment-version byte verification, disposal and host-loss evidence are not supplied by citation monitoring. |

Private original receipts: `permission-browser-evidence-2026-10-19.md` and
`c01-runtime/evidence/c01-connect-disconnect-revocation-2026-10-11.md`.
No new disconnect, upstream access removal or disposal is authorised by this
reconciliation. Provider account setup is not a prerequisite for this matrix.

## Ownership and data-flow requirements

| Data / operation | Authority and implementation | Acceptance evidence required |
| --- | --- | --- |
| Selected existing pages | Confluence owns document content. `confluence-reference.service.ts` records a checked site/page/version citation; removal only uncites. | Cite an authorised synthetic page, edit it upstream, show staleness without silently replacing the cited version, then uncite and verify the page is unchanged. |
| Structured governance | CharityPilot owns roles, approvals, deadlines, audit history and approved snapshots. Confluence properties are integration metadata. | Application role/tenant denial plus authorised control; immutable historical snapshot despite subsequent upstream edits. |
| Deliberately published copies | Separate from references: `document-publication.service.ts`, `confluence-publish-target.service.ts`, publishing and reconciliation services. Destination review precedes approval. | Exact site/space/source/destination approval; changed destination refuses; original operation identities reconcile unknown responses without duplicate writes. |
| Page and attachment identity | `confluence-retained-copy-source.ts` and `confluence-retained-copy-inventory.ts` recheck local bytes, connection generation, page versions and bounded attachment version bytes. | Exact inventory, repeated-current checks, changed/missing version and incomplete inventory refusal; live attachment readback remains a separate gate. |
| Retained primary / copy disposal | Review, maintenance synthetic scope, Owner permission and execution authority are distinct (`confluence-retained-copy-*.ts`, execution journal/ledger). | Positive browser permission/withdrawal and missing-scope refusal; current holds/source/authority checked again at execution; independently durable outcomes and original acknowledgements. Permission alone never proves disposal. |
| Ordinary removal | Reference removal leaves the source unchanged. Local Vault removal must not imply remote erasure. | Before/after identities and current upstream readback, retained audit and correct UI wording. |
| Trash / permanent erasure | `confluence-erasure.ts` and erasure request service distinguish recoverable Trash from purge. | Authorised exact synthetic target, Trash status, permanent action or explicit administrator action, final verified outcome and provider limitations. A 404 alone is insufficient without authenticated access controls and target evidence. |
| Administrator-action follow-up | The Owner web-only [recorded-target observation](confluence-erasure-observation.md) reads a saved deletion target and separate legitimate control without invoking the destructive eraser. [Historical review reports](confluence-erasure-review.md) separately preserve the original instruction, operator claim/evidence and fresh observation in the append-only audit log. | API/client and disposable browser evidence covers uncertain reads, unchanged jobs, mobile/themes, lost-save receipt recovery, audit immutability/uniqueness and lookup after reload. Actual provider outcomes and independently current custody remain open. Reports never assert permanent/all-copy erasure or close a job. |
| Disconnect | Integration routes and `confluence-connection.service.ts` destroy locally stored credentials; upstream revocation outcome is separate. | Local credential absence, refused subsequent local use, retained audit and independently recorded upstream grant state. Endpoint acceptance is not a claim of verified revocation. |
| Enabled reconciliation / dormancy | `confluence-reconcile.service.ts`, `production-scheduler.ts`: empty work returns before connection/token refresh. | No-work test makes no refresh; enabled work can refresh for its purpose; dormancy sweep follows actual work and does not preserve unused access. |

Service filenames above are relative to `apps/api/src/services/`, except the
scheduler under `apps/api/src/jobs/` and integration routes under
`apps/api/src/routes/integrations/`.

## Residency and custody evidence

Treat current administration observations as authoritative over an intended
configuration in correspondence. An unset location is not EU pinning and does
not, by itself, prove that data is outside the EU. Observe the production site
and sandbox separately. Before requesting a move, review its exact app scope,
Marketplace compatibility and downtime; do not change organisation-wide defaults
as a shortcut. [Atlassian's migration guidance](https://support.atlassian.com/security-and-access-policies/docs/move-data-to-another-location/)
describes the interruption and editor implications. Keep tenant-specific settings,
billing and contributor observations in the ignored private inspection record.

| Material | Required observation |
| --- | --- |
| Confluence pages and attachments | Actual site/app residency setting, in-scope coverage, current plan/entitlement and exclusions. Tenant declaration and independently observed setting remain distinct. |
| Application database, audit and snapshots | Chosen provider's actual region, replicas, operator/support access, retention, export and restore arrangements. |
| Local uploads and temporary attachment bytes | Selected storage location, cache/temp handling, access controls and disposal; do not infer location from Confluence residency. |
| OAuth tokens and integration root key | Organisational app ownership/recovery, least scopes, encrypted credentials and separate key custody/rotation/recovery. Never include credential values in evidence. |
| Logs, monitoring and recovery history | Each destination's location, retention, access and independent custody, including deletion/preservation decisions after the last backup. |
| Recovery sets and keys | Independent failure domain, separately held key, exact-source compatibility, usable restoration and actual host-loss drill. A same-host copy is insufficient. |

The [application custody procedure](confluence-app-custody.md) distinguishes app
ownership, site consent, local credential storage and independent recovery. The
19 October read-only synthetic-app inspection found a sole Owner/Admin, the
expected eight API scopes and local callback; local grant metadata additionally
records `offline_access`. Multi-admin OAuth app ownership is supported without a
Forge rewrite. This inspection closes the unknown test-app inventory, not the
backup-operator, production-app or independent key-recovery gates. No access was
changed and no secret was opened.

## Scoped sandbox run

1. Bind the exact release, isolated tenant, approved sandbox site/space and synthetic
   page/attachment identifiers. Record the original IDs and local byte hashes.
2. Record read-only site residency, entitlement and OAuth ownership observations;
   label inaccessible settings unverified. Do not infer them from old emails.
3. Exercise references and version staleness first. Review any publishing
   destination independently; retain legitimate access and denied-access controls.
4. Exercise held/changed-source refusal, retained-primary permission withdrawal,
   reference removal and disconnect. Preserve original records and receipts.
5. Before any provider mutation requiring specific authority, present its exact
   synthetic targets and intended action. Approval of the plan is not action-time
   authority to purge, grant access, accept terms or incur spend.
6. For authorised disposal, observe Trash and permanent-erasure outcomes
   separately, reconcile unknown responses, and verify primary retention plus
   independent decision/outcome custody. Stop on uncertainty; do not reconstruct
   missing acknowledgements.
7. Produce a release-bound result for each row: observed pass, observed failure,
   unverified or blocked by a named external dependency. Keep actual provider and
   physical host-loss acceptance separate from local simulation.

Confluence remains optional for other organisations. Do not transfer real
Governance Hub content or sensitive records as part of this synthetic run.

## Hosting compatibility boundary

Supplier selection remains open, but storage implementation is not yet supplier
neutral. `apps/api/src/services/storage.service.ts` supports local/Supabase
provenance; the strict public-production guard in `apps/api/src/utils/env.ts`
rejects local default storage. An alternative document store needs a supported
adapter and verification of per-record provenance, authenticated delivery,
retention, cleanup and recovery before activation. Preserve the strict guard
while evaluating alternatives. Confluence references do not replace storage for
all sensitive records, and a cheaper VM does not remove operating responsibilities.
