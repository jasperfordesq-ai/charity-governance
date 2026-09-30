# CharityPilot Full-Platform Remediation Audit

> **Independent hold recovery gate recheck, 2026-09-30 23:30 Dublin:**
> ordinary API hold changes refuse an active enforcement binding, but the
> database hold-event trigger is not yet bound to independent publication.
> The internal published-hold helper has no supported Owner/Admin workflow,
> and the outcome row lacks a durable writer/publication receipt. Do not
> activate the binding or claim all-writer/host-loss readiness. The private
> analysis records the ordered implementation and verification gates. No
> code, migration, provider or live setting changed by this review. Private
> evidence: `.charitypilot-private/complaint-hold-writer-gate-analysis-2026-09-30.md`.


> **August Governance Policy Index exact-source review, 2026-09-30:** the
> manifest-matched DOCX has 27 entries, omits two March-adopted policies,
> and retains blank Board approval date/signature fields. The live Owner
> Vault calls it unadopted. It cannot stand in for the March 31-document
> adoption schedule. Private proposal is Company Secretary/DRAFT/RESTRICTED
> pending Board/current-source review. Nineteen of 63 rows have source
> evidence, 18 have some proposal, 45 have none, all 63 PENDING. No live
> change. Private evidence:
> `.charitypilot-private/august-index-source-review-2026-09-30.md`.


> **March Governance Policy Index source found, 2026-09-30:** retained
> approval email attachment and external Policies DOCX have identical
> extracted main-document text. The signed-in Owner Vault shows all 63
> records but no full March DOCX, contrary to its text stub's `uploaded` and
> `safe to delete` narrative. The August index is a distinct unadopted draft.
> Preserve the stub's unique record note, verify a separate original record,
> and seek controller lifecycle/owner/audience decisions before live changes.
> Private proposal is Board/HISTORICAL/RESTRICTED for the stub. Eighteen of
> 63 rows have source evidence, 17 have some proposal, 46 have none, all
> PENDING. No live metadata changed. Private evidence:
> `.charitypilot-private/text-stub-source-review-2026-09-30.md`.


> **Garda Vetting adopted-text mismatch, 2026-09-30:** exact backup Vault
> DOCX matches the plain local policy and the plain March email attachment's
> extracted body. The retained approval schedule names item 6 as the ECRIS
> Update and includes a distinct ECRIS attachment; later replies support
> adoption of the 31-item suite. Resolve which exact text is operative and
> retain it in the Vault before relying on this record or its standards links.
> Existing plain-file worksheet proposal is Board/HISTORICAL/RESTRICTED,
> pending controller review. Eighteen of 63 rows have source evidence, 16
> have some proposal, 47 have none, all 63 PENDING. No live metadata changed.
> Private evidence: `.charitypilot-private/garda-vetting-source-review-2026-09-30.md`.


> **March approval drafts source review, 2026-09-30:** both exact DOCX files
> match the post-release backup manifest. The board-meeting draft has blank
> execution fields; the 25-item written draft conditions its effect on email
> confirmations not embedded in that file. The separately retained March
> correspondence supports a 31-document adoption. Two live standard 3.4
> links to the drafts are not execution proof. Private worksheet proposals
> are Board/HISTORICAL/RESTRICTED, pending controller/current-revision checks.
> Seventeen of 63 rows have source evidence, 15 have some proposal, 48 have
> none, all 63 PENDING. No live metadata changed. Private evidence:
> `.charitypilot-private/unexecuted-approval-source-review-2026-09-30.md`.


> **Five legacy text stubs reviewed, 2026-09-30 23:15 Dublin:** exact backup
> bytes and hashes match for all five. Four cite full September PDFs present
> with matching hashes; private P01/P02 proposals link them as restricted
> superseded renderings, pending controller acceptance. The March Governance
> Policy Index stub has no claimed March DOCX in the 63-file backup. The
> different August index has a blank approval block and is not a proved
> replacement. A `safe to delete` narrative gives no disposal authority.
> Fifteen of 63 rows have source evidence, 13 have some proposal, 50 have none,
> and all 63 remain PENDING. No live record changed. Private evidence:
> `.charitypilot-private/text-stub-source-review-2026-09-30.md`.


> **Volunteer template source review, 2026-09-30:** exact verified backup PDF
> is a blank three-page Volunteer Register and Induction Record. CWR-2026-11
> Resolution 3 adopts the circulated form and assigns the Company Secretary,
> while leaving standard 3.2 open until the register is populated. The P01/P02
> worksheet proposes CURRENT **template** / RESTRICTED, not completed
> induction or a populated register. Former-volunteer retention remains
> unresolved. Ten of 63 rows have source evidence, nine have a proposal and
> all 63 remain PENDING. Private evidence:
> `.charitypilot-private/volunteer-register-source-review-2026-09-30.md`.

> **Sensitive register source review, 2026-09-30:** exact verified backup
> bytes of the Register of Interests/Declaration Form contain named trustees'
> financial and related-party conflicts. The private P01/P02 worksheet
> proposes Company Secretary ownership and RESTRICTED audience; lifecycle and
> replacement await adoption, signed-return and current-source review. The
> file's own permanent-retention statement is not application policy approval.
> Nine of 63 rows have source evidence, eight have a proposal and all 63 remain
> PENDING. No live metadata changed. Private evidence:
> `.charitypilot-private/interests-register-source-review-2026-09-30.md`.

> **Privacy Notice provenance follow-up, 2026-09-30:** the circulated V2 PDF
> retained in the Vault is an earlier uncorrected snapshot. Signed-in
> Confluence page 2326571 V10 (22 September) and the directly inspected public
> `https://hour-timebank.ie/privacy` Version 2.0 notice effective 30 September
> both show Nikita's named DPO contact and the corrected section 20. The
> rendered notice bodies matched from opening sentence to final DPO contact
> after whitespace and twenty heading-period normalizations (24,744
> characters each); page metadata/footer and PDF bytes were not compared.
> DPO mailbox access and retirement of the unused address remain unverified.
> The 63 Vault worksheet decisions
> remain PENDING; do not publish the stale circulated PDF. Private evidence:
> `.charitypilot-private/privacy-notice-source-review-2026-09-30.md`.

> **Verified private VM release, 2026-09-30 22:57 Dublin:** source
> `674be7107220acdf8335e107dbb1aa7234f249d8` runs on blue. Exact CI
> 36780803672 and E2E 36780803674 succeeded (239 browser tests); migration
> gate 0 pending, blocked or warned. API/web/scheduler and DB are healthy,
> previous green `2f4ffbf9` is stopped and rollbackable, and only Caddy
> publishes the loopback port. All 120 existing backup files stayed identical;
> two new sets were copied off the VM and verified by hash and manifest.
> Supported isolated restore passed (139 migrations, 63 documents, 22 risks,
> 22 governing acts). Owner read-only checks reached Registers and Security &
> Data. Nine historical replay events and scoped C1 remain. Ordinary complaint
> hold API refusal under recovery enforcement is deployed, while independent
> recovery is inactive. Direct SQL/other writer coverage, provider custody,
> host-loss reopening, policy decisions, real role acceptance and DPO sign-off
> remain open. Private evidence:
> `.charitypilot-private/release-674be710-acceptance.md`.

> **Private P01/P02 worksheet:** exact backup/source review of the March Data
> Protection Policy and March/V2 Privacy Notices added bounded lifecycle and
> restricted-audience proposals. The circulated Privacy Notice V2 still needs
> two corrections before publication. Eight of 63 rows have source evidence,
> seven have a proposal and all 63 remain PENDING. No live metadata changed.

> The following 22:30 release and source-only guard notes are historical
> checkpoints retained for the sequence of work.

> **Verified private VM release, 2026-09-30 22:30 Dublin:** source
> `2f4ffbf92a71b886a8daf9fa31bddad44f1fb69c` runs on green. Exact CI
> 36778029710 and E2E 36778029677 succeeded (239 browser tests); migration
> gate reported 0 pending, blocked or warned changes. API/web/scheduler are
> healthy, prior blue `6687cc47` is stopped and rollbackable, and only Caddy
> publishes the loopback port. All 114 existing backup files stayed identical;
> two new sets were copied off the VM and verified by hash. Supported isolated
> restore passed (139 migrations, 63 documents, 22 risks, 22 governing acts).
> Signed-in Owner read-only checks reached Security & Data and Registers.
> Committed primary/hold outcome resumption is deployed but inactive. The
> independent provider, all-writer coverage, supported host-loss reopening,
> policy decisions, real role acceptance and DPO sign-off remain open. Private
> evidence: `.charitypilot-private/release-2f4ffbf9-acceptance.md`.

> **Historical source-only DPO-05 checkpoint before 674be710:** the ordinary complaint hold API
> now refuses a hold change if an append-only independent recovery binding is
> present for that charity. It checks the active Admin/Owner first and runs
> under the charity lock at ReadCommitted. Focused and real PostgreSQL protocol
> tests cover the refusal. This does not yet gate every database writer or
> activate independent recovery; it was not in the verified `2f4ffbf9` image
> and is now deployed in `674be710`.

> The following 22:05 `6687cc47` release and source-only `2f4ffbf9` notes
> are historical checkpoints retained for the sequence of work.


> **Verified private VM release, 2026-09-30 22:05 Dublin:** source
> `6687cc4736c786d4812e322ff4fbca2a8cc0e93d` runs on blue. Exact CI
> 36775042860 and E2E 36775042630 succeeded (239 browser tests); the two
> migrations had no blocked or warned changes. API/web are healthy, previous
> green is stopped and rollbackable, all 108 pre-existing backup files remain
> identical, two new backup sets were copied and verified, and isolated
> restore passed with 139 migrations and 63 documents. Signed-in Owner
> read-only navigation reached Security & Data and Registers. The new complaint
> hold/cancellation recovery services are deployed but inactive. Independent
> provider custody, all-writer fencing, total-host-loss reconciliation, policy
> decisions and DPO acceptance remain open. Private evidence:
> `.charitypilot-private/release-6687cc47-acceptance.md`.

> DPO-05 post-release source work: a same-writer completion helper reads an
> already committed primary-disposal or hold outcome, verifies its exact
> published preparation and current control, and completes publication/release
> without executing the original action again. Local API, PostgreSQL and real
> protocol checks pass; hosted gates remain pending. It is not in verified 6687.

> DPO-05 interrupted cancellation completion (deployed inactive path): an
> internal helper resumes an already committed cancellation using the same writer. A preparation
> head permits preserving/publishing that exact receipt; a terminal head goes
> directly through the committed release verifier. Missing published bytes are
> never regenerated. This does not replay restored records, create cancellation
> decisions, execute disposal, transfer writer authority or activate the provider.


> DPO-05 cancellation release (deployed inactive path): a dedicated
> service compares the authenticated published cancellation with its exact
> committed database receipt and current writer before conditional reservation
> release. No timeout clearing or takeover is permitted. This path is
> deployed but inactive, verified by local API/database/protocol tests; independent custody, recovery
> replay and the
> original DPO acceptance requirements remain separate and incomplete.


> DPO-05 cancellation evidence publication: dedicated authenticated cancellation
> envelopes and create-only storage now bind operation kind, scope and source.
> Typed terminal journal entries follow the exact primary/hold preparation and
> exclude a later outcome for the same operation. Published readers verify full
> current history and exact payload bytes. Publication retains reservations
> until separate committed release; recovery replay, all-writer/provider custody and original acceptance remain open.


> DPO-05 cancellation composition: an inactive service authenticates the exact
> reserved primary/hold preparation and unchanged independent writer/head before
> local cancellation. It rechecks current actor and local writer, and retries only
> the same decision. A committed reader validates preparation bindings and emits
> a minimal receipt. Cancellation still retains the independent reservation;
> terminal encryption/publication/release and recovery replay remain incomplete.


> DPO-05 local cancellation boundary: a new append-only cancellation record
> targets exactly one disposal or hold preparation. Database guards serialize
> cancellation against prepared execution/outcomes with the charity lock, reject
> executed operations and require current charity authority plus the exact writer.
> Cancellation does not clear independent reservations. Publication, cancellation
> release, recovery replay, all-writer coverage and provider acceptance remain open.


> DPO-05 committed hold release: an internal service now authenticates the
> published hold outcome, compares its exact committed database receipt and
> conditionally clears only the matching current reservation. Lost acknowledgements
> retry without duplicate effects; missing evidence and changed writers/heads
> leave the reservation unresolved. This is not cancellation, takeover, provider
> activation or all-writer enforcement. Hosted/live evidence remains separate.


> DPO-05 hold outcome publication: authenticated hold outcomes now publish only
> after their exact hold preparation, retaining the operation reservation. Readers
> verify both payload hashes, decision fields and stable current history. Lost
> acknowledgements resume exact bytes; disposal and hold pairs cannot mix. This
> inactive internal protocol is not independent provider custody, reservation
> release, all-writer enforcement or a production-readiness claim.


> DPO-05 hold outcome storage: strict minimal facts and separately authenticated
> hold-outcome envelopes now support create-only ciphertext preservation and
> exact-byte recovery reads. This is an inactive storage primitive. A locally
> computed digest is not an independent published head; journal publication,
> reservation release, cancellation/replay and provider custody remain open.

> DPO-05 hold execution composition: the internal execution service now verifies
> the reserved published preparation and unchanged current writer/head before
> applying the atomic local hold/outcome transaction. Retry retains one event
> and the reservation is not released. This does not close all-writer database
> enforcement, independent outcome publication, cancellation/replay or provider
> custody. Hosted and deployed evidence must identify the resulting revision.

> DPO-05 source checkpoint, 2026-09-30: atomic local hold outcomes now pair the
> exact prepared transition with an append-only receipt in one database
> transaction. Current authority, previous hold and complaint revision are
> rechecked. Failed outcomes roll back the transition. The minimal committed
> reader verifies provenance bindings and omits free-text reasons. This inactive
> internal primitive is not independent publication or all-writer enforcement;
> execution fencing, cancellation/replay, other classes/stores and original DPO
> acceptance remain open. Exact hosted/deployment evidence is still separate.

> DPO-05 source checkpoint, 2026-09-30: inactive complaint execution enforcement
> now binds a durable charity/writer identity to a same-transaction execution,
> claim and outcome. Real PostgreSQL tests cover direct-claim refusal, rollback
> without outcome, stale holds, Owner/withdrawal changes and exact retry. Local
> API2519 and PostgreSQL5 checks passed. No live activation or deployment is
> implied. All preservation writers, other record/worker/copy paths, approved
> provider custody, replacement isolation and original DPO acceptance remain
> unresolved; this does not close DPO-05 or public-production readiness.

> DPO-05 release-status correction, 2026-09-30: the private release receipt
> records d31ac597 deployed after exact CI 36737004873 and E2E 36737004807
> passed (238 tests), followed by restore rehearsal and off-host hash checks.
> Both backup preservation and surviving-document restore comparison are in
> that release. Earlier source-only notes below are historical. Independent
> recovery authority remains incomplete: local journal/checkpoint development
> is not wired into disposal or reopening, and cannot prove latest-history
> freshness. Policy, real-role/privacy acceptance and wider lifecycle gaps remain.

> DPO-05 backup preservation, 2026-09-30: reproduced age-only deletion after
> backup/deploy. Removed automatic disposal; both commands preserve sets and
> report age-review counts. All 118 backup/deployment tests pass locally.
> Capacity review and separately authorized backup disposal remain required;
> this guard is not expiry compliance, independent authority or recovery reopening.

> DPO release checkpoint, 2026-09-30: exact 5f02c28e CI and 238 browser tests
> passed; private-host deployment, backup hashes, restore rehearsal and bounded
> signed-in Owner checks passed. This supersedes earlier source-only statements
> for that release. A newly reproduced surviving-document restore-control gap
> is repaired locally with full row hash comparison; 44 tests pass, including
> actual restored PostgreSQL control drift and restore-command refusal/cleanup.
> This follow-up still awaits exact CI and deployment.
> Independent durable recovery authority, other stores/classes, real policy
> approval and original privacy acceptance remain unresolved.

> DPO-05 Admin preservation navigation, 2026-09-30: metadata-only scope
> discovery now links committed claims to existing hold controls in both
> dashboards. Separate Admin browser journeys pass; Owner authority remains
> restricted. Exact deployment and full live/privacy acceptance remain open.

> DPO-05 lifecycle audit, 2026-09-30: metadata feeds now cover retention
> revisions/withdrawals, complaint recoverable removal and both families of
> disposal review/withdrawal/claim. 35 API tests and two populated browser
> journeys pass. Deployment and full live/privacy acceptance remain open.

> DPO-05 scoped authority dashboard, 2026-09-30: Owner review/withdrawal
> forms now bind current policies and scope revisions, and later observations
> can explicitly cite the reviewed authority. Both compiled isolated journeys
> pass. Admin preservation navigation, further audit coverage, deployment and
> full live acceptance remain outstanding; this is not provider erasure proof.

> DPO-05 copy policy dashboard, 2026-09-30: separate copy-class proposal,
> approval and withdrawal controls are wired into Documents and Registers.
> Both compiled isolated browser journeys pass; scoped authority forms, Admin
> preservation access, deployment and broader DPO acceptance remain open.

> DPO-05 preservation dashboard, 2026-09-30: Owner copy-observation forms
> now support scoped hold/release review with complete history and confirmation.
> Both compiled isolated browser journeys pass; Admin dashboard access, copy
> authority forms, release and wider acceptance remain outstanding.

> DPO-05 copy audit integration, 2026-09-30: six restricted metadata feeds
> now cover both families of copy authority, preservation holds and observations.
> API tests, build, web types and targeted lint pass; browser/deployment proof,
> remaining lifecycle histories and copy-review dashboard forms remain open.

> DPO-05 copy review API, 2026-09-30: both families now have browser-only
> authority/hold history and reviewed writes, plus separate copy policies.
> Owner approval, Admin proposals/preservation and ADMIN session-level gates
> are tested. Audit/dashboard integration, browser proof, deployment and the
> broader copy-provider/recovery acceptance requirements remain open.

> DPO-05 Vault policy ambiguity, 2026-09-30: source now rejects removal,
> disposal authorization and claim when another approved draft policy remains
> unwithdrawn. Recovery takes the organisation lock before document/policy locks
> and returns review guidance before reading file bytes. This addresses the
> newly reproduced database-state gap; deployment and broader DPO scope remain.

> DPO-05 copy-policy and observation binding, 2026-09-30: source binds later
> copy decisions to distinct approved copy policies and exact scoped authority.
> Current hold, expiry, retention and withdrawal checks prevent stale reuse;
> unresolved facts remain recordable. Review-management API/UI, metadata audit,
> browser/deployment verification and broader erasure/recovery work remain open.

> DPO-05 scoped-copy holds, 2026-09-30: source now retains revisioned
> preservation decisions after primary disposal and requires new copy authority
> to bind the current unheld scope. Restore inventories include this history.
> Policy/observation binding, API/UI/audit and deployment remain open; this is
> not end-to-end copy disposal or independent host-loss recovery authority.

> DPO-05 scoped-copy authority persistence, 2026-09-30: append-only,
> time-limited Owner review/withdrawal histories now exist in source for both
> documents and complaints. Original-plan observation guards remain unchanged.
> This does not yet enable later disposition changes: authority binding,
> current policy/hold checks, API/UI/audit integration and deployment remain
> open, alongside the existing broader erasure and recovery requirements.

> DPO-05 restore-drill comparison, 2026-09-30: bluegreen restore drills now
> compare current live purge authority with the isolated restored database,
> then recapture authority to detect changes. Stale, unreadable or changed
> history fails with cleanup. All 117 backup/deployment tests pass locally.
> The real PostgreSQL backup/restore comparison proof also passed separately.
> Live integrated verification, actual file/copy reconciliation, independently
> durable authority and supported personal-server recovery integration remain
> open. Passing a drill does not authorize reopening restored application data.

> DPO-05 downstream-evidence dashboard, 2026-09-30: Owner scoped observations
> and append-only corrections now have UI controls. Isolated Chromium proves
> retained-backup evidence, reopening review, history after reload and no
> primary-job mutation. Local build/type/lint checks pass. Actual copy disposal,
> backup restore reconciliation, other record classes and deployment/live
> acceptance remain open; recorded evidence is not complete erasure.

> DPO-05 downstream disposition evidence, 2026-09-30: append-only scoped
> observations and Owner-only browser API now distinguish pending, failed,
> reviewer-verified absence and approved retention for versions, Confluence,
> exports, audit and backups. No primary job is dispatched by these records;
> no aggregate erasure result exists. Dashboard editing, real provider evidence,
> complete inventories, backup restore reconciliation, other record classes
> and deployment/live acceptance remain open.

> DPO connector exclusion follow-up, 2026-09-30: one-time invitation-link
> retrieval, charity ownership transfer and billing checkout/portal starts
> now require a web session at the API, including legacy billing aliases.
> API build, 38 focused Team/billing tests and 15 connector route-contract
> tests pass locally. Live grants, provider behavior and DPO review are open.

> DPO connector mutation boundary, 2026-09-30: direct Admin connector
> sessions are now refused by the API for browser-only Confluence callback,
> setup, citation, erasure and disconnect actions, plus Vault publication
> retry and failed storage-deletion requeue. This enforces existing connector
> tool exclusions at the server. API build and 181 focused route tests pass.
> External-provider deletion, live tenant behavior and DPO review are open.

> DPO browser approval and Confluence setup boundary, 2026-09-30: direct
> Admin connector sessions now cannot list or grant browser action approvals
> or fetch the Confluence authorization URL/live setup spaces. Terminal
> connector approvals remain separate. API build, 97 approval/integration
> tests and 22 connector approval tests pass. The private connector boundary
> map distinguishes intentional file/session/terminal tools from dashboard
> exclusions. Nikita's grants, provider state and DPO review are unverified.

> DPO-01/03/05 Vault and Confluence review reads, 2026-09-30: replacement,
> mirror, document-control and storage-deletion review endpoints and recorded
> external-copy/citation inventories now require a web session at the API.
> This prevents direct Admin connector reads of dashboard-only data. The
> separately gated document-download tool remains. API build and 165 focused
> route tests pass; live pages, audiences, purge and Nikita's tenant remain
> unverified.

> DPO-02/06 detailed-history channel guard, 2026-09-30: organisation,
> deadline, Minute Book and compliance change histories and replay
> diagnostics now require a web session at the API. This blocks a direct
> Admin connector request even though those tools were already excluded.
> API build and 107 focused route tests pass. The permitted Team Security
> Audit tool is unchanged. Historical incident/C1 and live-tenant proof remain
> open.

> DPO-06 application-audit boundary, 2026-09-30: risk/register control
> histories and verification writes, plus all Governance Audit feeds, now
> deny direct Admin connector requests at the API. This enforces their
> dashboard-only tool exclusion; web Owner/Admin access remains. API build
> and 135 focused route tests pass. Later 2026-09-30 passes checked the
> named Vault, Confluence and approval exclusions; C1/live-host evidence
> remains open.

> DPO-01/05 controlled-route channel guard, 2026-09-30: document hold and
> written-provider verification, plus every data-request case route, now
> refuse a direct Admin connector session before the controlled read or write.
> Web Owner/Admin routes remain available. API build and 90 focused route
> tests pass. This enforces the existing connector-tool exclusion at the API;
> it is not evidence of human review, legal disposition or Nikita's tenant.

> DPO-01 connector decision guard, 2026-09-30: the document PATCH API refuses
> visibility, content suitability, lifecycle and publication-approval changes
> from an MCP connector session, including a direct call outside its
> metadata-only tool. Metadata edits still work. The API build and 68 route
> tests pass locally. An interactive web session is not evidence of actual
> human inspection, and Nikita's deployed tenant remains unverified.

> DPO-01 current-checkout Member boundary, 2026-09-30: the guarded isolated
> PostgreSQL/API/production-web/Chromium authorization journey passes 1/1
> with runner exit 0. It denies direct detail and download for a restricted
> Vault file, downloads an expressly reviewed file, and keeps Board,
> Compliance and Registers read-only to a Member. This is synthetic local
> evidence, not actual content review or proof on Nikita's deployed tenant.

> DPO accumulated local verification, 2026-09-30: the compiled non-migration
> API suite passes 2,357/2,357 with local Docker access, four separately named
> real PostgreSQL migration suites pass 4/4, and the compiled web suite passes
> 542/542 using a private test-only Windows account-lookup preload. Two stale
> web source assertions were aligned with the current Member release and
> draft-delete wording. Earlier host-dependent broad-suite failures are
> historical checkpoints, not current failing checks. This does not close
> actual-file review, hosted verification, retention decisions or DPO review.

> DPO-01 Vault inventory navigation, 2026-09-30: the Documents dashboard now
> exposes older pages beyond its former first 50 files and marks evidence
> counts partial until all pages are loaded. A disposable Owner browser journey
> reached the oldest of 52 synthetic restricted files even after a newer file
> was added between pages. The tenant-bound cursor preserved the older page;
> the count mismatch prompted a refresh. This supports actual-file review but
> does not perform classification, hold a fixed live snapshot through every
> concurrent edit, or verify Nikita's tenant.

> DPO-01 reviewer-download receipt, 2026-09-30: migrations 50-51 bind a new
> `MEMBER_SUITABLE` assessment to an earlier authenticated download preparation
> by the same actor for the same revision and SHA-256. The populated
> 64-baseline/51-DPO upgrade, 101 focused API tests and rendered refusal-then-
> release journey pass locally. An earlier disposable attempt caught the
> concurrent-index transaction issue; the split migration passed cleanly.
> Server preparation does not prove client receipt or human inspection. Real
> file review, hosted verification and DPO acceptance remain open.

> DPO-01 rendered release proof, 2026-09-29: the isolated Owner/Member
> Chromium journey passes 1/1 after the strict disposable database reset
> inventory was updated for the earlier `DeadlineReminderAudit` model. Its
> 50 safety tests pass and runner cleanup exits 0. The journey covers a new
> test file's reviewed release, Member download and a restricted comparison;
> real content, hosted version and DPO acceptance remain unverified.

> DPO-01 reviewed-byte release, 2026-09-29: migration 49 requires a valid
> fingerprint for new/updated Member-visible rows while preserving legacy rows
> for re-review. The API fingerprints server-read bytes at Owner/Admin
> assessment, hides unhashed rows from Member paths and checks current size
> and SHA-256 before Member download. The populated 64-baseline/49-DPO
> PostgreSQL rehearsal, 116 focused API tests and production web build pass
> locally. Human full-file review, real legacy inventory, hosted verification
> and DPO acceptance remain open.

> DPO-01 written-provider Member gate, 2026-09-29: migration 48 refuses new
> or updated Member-visible files without a known written provider, while
> Member API paths hide legacy unknown-provider rows. Assessment itself now
> waits for custody verification. A populated 64-baseline/48-DPO PostgreSQL
> rehearsal, API build and 162 focused tests pass locally. The `NOT VALID`
> constraint awaits actual legacy-row review; provider bytes and hosted proof
> remain unverified.

> DPO-01 recorded-file identity guard, 2026-09-29: migration 47 prevents a
> direct database change of storage path, provider, size, MIME type or version
> from retaining `MEMBER_SUITABLE`. A populated 64-baseline/47-DPO PostgreSQL
> rehearsal and blue-green SQL gate pass locally. Same-path provider byte
> integrity, real file review, deployed proof and DPO acceptance remain open.

> DPO-01 assessment freshness, 2026-09-29: editing a reviewed Vault card now
> withdraws its Member-suitable assessment and any Member access in the same
> transaction, with restricted history. Migration 45 refuses direct metadata
> changes that preserve the old assessment. Populated PostgreSQL, authenticated
> Admin PATCH and subsequent Member denial pass locally. Real file review and
> hosted proof remain open.


> DPO-01 Vault content assessment, 2026-09-29: Member document reads now
> require an expressly reviewed `MEMBER_SUITABLE` class as well as visibility
> and lifecycle. Migration 45 leaves existing rows `UNASSESSED`; the API hides
> legacy visible rows and a `NOT VALID` constraint refuses unsafe new/updated
> rows. A populated PostgreSQL upgrade and focused API and Owner/Member browser
> journeys pass locally. Actual file classification, any prior exposure,
> Confluence permissions, reviewed-tenant proof and DPO acceptance remain open.


> DPO-03/05 linked-evidence deletion guard, 2026-09-29: ordinary draft DELETE
> refuses current standard links or cited charity-managed Confluence pages
> before storage cleanup, and a new database trigger blocks direct row deletion
> while either link remains. A populated PostgreSQL 16 upgrade applied 64
> baseline plus 44 DPO migrations, refused both direct deletions and preserved
> the links, with gated cleanup exit 0. API build, 131 focused tests and 71
> migration-gate tests and a focused unlinked-draft Owner browser journey
> pass. Human link review, deleted-item restoration,
> approved retention and provider/backup purge remain open under P0-08.

> DPO-05/06 reasoned draft deletion, 2026-09-29: ordinary Vault DELETE now
> requires a bounded administrator reason and writes it to retained restricted
> document history in the record-removal transaction. The dashboard and
> connector supply that reason. API/web builds, E2E TypeScript, 129 focused
> API tests, 397 connector passes with four skips and two disposable Owner
> browser journeys pass locally. This improves deletion accountability; P0-08
> still needs an approved recovery period, actual deleted-item restoration,
> per-class retention, provider/backup purge and reviewed-tenant evidence.

> DPO-05/06 source-area audit continuation, 2026-09-29: Governance Audit now pages data-request coverage decisions as restricted metadata, with charity-bound cursors and Member denial. Reasons and controlled-archive references stay in the case history. Connector coverage explicitly excludes the case reads and human assessment write. API/web builds, E2E TypeScript, 15 focused audit tests, the disposable Owner browser journey and connector suite (397 passed, four skipped) pass locally. P0-08 still needs approved retention, deleted-item recovery, provider/backup purge and live tenant proof.

> DPO-02 no-Web-Locks replay guard, 2026-09-29: the browser refresh
> coordinator now refuses to spend a single-use token when cross-tab locking
> is unavailable and a current-session probe still returns 401. Protected-page
> renewal and timeout extension direct to login with a clear explanation;
> genuine server replay quarantine is unchanged. Web build, 56 compiled tests,
> E2E TypeScript and all five disposable Chromium replay cases pass. This does
> not explain Nikita's historical events or verify her deployment; the P0
> investigation remains open.

> DPO-05 data-source coverage review, 2026-09-29: Data Requests now lists
> eight source areas as unreviewed until an Admin records a reasoned,
> append-only assessment. The three outcomes record scope review only, not
> deletion or case completion. Migration 43 enforces tenant/case binding and
> immutable events. API/web builds, 20 focused API tests and a representative
> 64-baseline/43-DPO populated PostgreSQL upgrade and focused disposable Owner
> browser journey pass. Approved retention,
> full subject-data matching, deleted-item restore, provider purge and backup
> expiry remain open under P0-08.

> DPO-02 web-worker replay prevention, 2026-09-29: the protected-page proxy
> validates `/auth/me` but no longer spends a refresh token in a web worker.
> On 401 with a refresh cookie it redirects to the no-store `/session-renew`
> page, where the browser's shared lock and current-session probe perform
> renewal. A four-case disposable replay browser suite passes, including
> an expired page, two tabs, invalid-cookie denial and deliberate spent-token
> quarantine. This does
> not identify Nikita's historical event cause, prove her deployed topology,
> or cover browsers without Web Locks. The P0 investigation remains open.

> DPO-05 actual-response evidence, 2026-09-29: Admins can now record,
> correct or withdraw an actual data-request response sent time with an
> opaque controlled-archive evidence reference and append-only case history.
> Governance Audit pages only response-change metadata. A focused Owner
> browser journey and the combined 19-case DPO suite pass locally; a populated
> 64-baseline/42-DPO migration rehearsal preserves unknown legacy responses as
> null and refuses a pre-receipt date. This does not prove delivery, calculate
> a retention expiry, authorise deletion, approve a policy or verify Nikita's
> tenant. P0-08 remains open.

> DPO-06 register action history, 2026-09-29: the Admin API and Registers
> page now page retained conflict, complaint, fundraising and risk record
> changes beyond 100. Focused API tests and a disposable Owner browser
> journey across 52 synthetic rows pass locally; the combined DPO browser
> suite passes 19/19. Historical gaps and Nikita's reviewed tenant remain
> unverified.

> DPO-06 compliance detail history, 2026-09-29: the restricted Compliance
> page and API now page detailed decisions past 100 within a charity and
> reporting year. Focused API tests and a disposable Owner browser journey
> across 52 synthetic rows pass locally. The reviewed tenant and actual C1
> evidence remain unknown.

> DPO-06 Minute Book detail history, 2026-09-29: Owner/Admin now have
> tenant-bound paging past 100 detailed governing-act and resolution changes,
> with collapsed before/after records on `/minute-book`. Focused API tests
> and a disposable Owner browser journey across 52 rows pass locally.
> Earlier actions are not backfilled; the reviewed tenant is unverified.

> DPO-06 risk detail history, 2026-09-29: the Admin risk-audit API and
> Registers panel now page retained detailed changes past 100 with a
> charity-bound cursor. The panel also correctly displays control-review
> attention and a selected risk's retained claims from API responses.
> Focused API tests and a disposable Owner browser journey pass, including
> a synthetic stale C1 claim and 52 change rows. Nikita's original C1
> closure evidence and reviewed tenant remain unverified.

> DPO-05 held-document guard, 2026-09-29: the ordinary Vault delete already
> checked a reasoned administrative hold. Migration
> `20260929390000_document_deletion_hold_delete_guard` also refuses a direct
> database DELETE while that hold is set. A populated 64-baseline/41-DPO
> upgrade and a disposable Owner browser/database journey passed locally.
> This does not approve a retention period or legal hold, restore an item,
> prove permanent purge or verify Nikita's reviewed tenant. P0-08 remains open.

> DPO-03 citation review, 2026-09-29: Admin Integrations now has a paged,
> read-only inventory of current charity-managed Confluence citations,
> separate from CharityPilot-published pages. It displays recorded page and
> cited version alongside linked Vault lifecycle/visibility. API/web/MCP
> builds, 103 focused API tests and three disposable browser journeys pass.
> The later linked-evidence guard requires unciting before Vault deletion;
> unciting removes the current row and the control audit lacks its full
> target snapshot, so historical external-reference retention still
> needs a controller decision. No current provider audience was verified.

> DPO-03 recorded-target review, 2026-09-29: Owner/Admin Integrations now
> displays saved Confluence site, space and page IDs on both copy lists and
> compares the non-retired page with the document's saved publication
> approval target. Missing retired site/page IDs prevent the UI erasure
> request. The connector withholds provider IDs when its personal-data gate
> is closed. API/web/MCP builds, 102 focused API tests, connector suite,
> edited web lint, E2E TypeScript and two disposable browser journeys pass.
> This remains local reference evidence, not a live audience or purge check.

> DPO-03 recorded-copy inventory, 2026-09-29: Admin Integrations adds a
> separate paged read of recorded non-retired Confluence pages, joined to
> same-charity current Vault lifecycle and publication approval. Missing,
> non-CURRENT or unapproved documents receive a review warning; there is no
> erase action from this list. API/web builds, 93 focused API tests, edited
> web lint, E2E TypeScript and a corrected disposable PostgreSQL/Chromium
> journey pass. It is not a live provider scan or proof of page audience,
> existence or purge; Nikita's tenant remains unknown.

> DPO-03/05 connector follow-up, 2026-09-29: the retired-copy MCP read now
> supports all 50-row pages and preserves the next cursor inside the API's
> wrapped response when the personal-data gate is closed. It calls these
> retained local references, not proof of live or purged Confluence pages.
> Response-target controls remain in the human Admin case review, and new
> document destination IDs are withheld from the connector. MCP build and
> tests pass locally (397 passed, 4 skipped); the actual tenant and provider
> remain unverified.

> DPO-03/05 retired-copy administration, 2026-09-29: the Admin Integrations
> page now surfaces the existing separate Confluence erasure request for a
> retained `RETIRED` publication, with a reason and typed confirmation. The
> tenant-scoped listing is cursor paged past its former silent 200-row cap.
> API/web builds, 91 focused integration tests and a disposable PostgreSQL/
> Chromium Owner journey pass. The synthetic request recorded a linked
> deletion job; it proves neither provider purge nor the policy authority
> for any actual page. Non-retired external copies and the reviewed tenant
> remain unverified. No migration was added.

> DPO-05 response-target control, 2026-09-29: migration 40 adds an optional
> case-specific date with reasoned append-only change/withdrawal history.
> The Admin case page surfaces past entered targets separately from the
> received-date queue; Governance Audit shows target-change metadata without
> reasons. No deadline is calculated and no old case is assigned one. API/web
> builds, 30 focused API tests, a disposable PostgreSQL/Chromium Owner journey
> and the populated 64-baseline/40-DPO upgrade pass. The target neither
> authorises erasure nor closes the open approved-schedule, recovery, full
> purge, C1 evidence and reviewed-tenant gates.

> DPO-03 concurrent destination evidence, 2026-09-29: the approval transaction
> now locks the selected Confluence integration row. A disposable browser and
> PostgreSQL test held a concurrent space change open, observed the approval
> query waiting, then committed the change. The API returned 409 and saved no
> approval; a fresh review against the restored selection passed. API build,
> 111 focused tests, E2E TypeScript and gated teardown pass. This does not
> inspect Nikita's tenant, provider permissions or existing remote copies.


> DPO-03 isolated browser evidence, 2026-09-29: all three connector Chromium
> journeys pass against the disposable PostgreSQL/API/web stack and fake
> Atlassian. The extended Vault journey verifies a stale destination is
> refused with no stored approval, then a fresh review binds the exact
> selected site/space. The runner supplies a per-run integration encryption
> key; its 40 contract tests, static validation and E2E TypeScript pass. This
> does not verify Nikita's tenant, actual space permissions or remote copies.


> DPO-03 reviewed-destination handoff, 2026-09-29: the Admin Vault dialog
> displays a freshly read selected Confluence site and space and submits their
> exact IDs with the reasoned approval. The API requires those IDs and rejects
> a changed or unavailable target before any document write or approval audit.
> The dialog also refuses approval when a recorded page's stored site/space
> differs from the current target, pending review of that older copy;
> the worker retains its post-approval binding check. Shared 57, focused API
> 106, broad API 2,321 (two host-dependent checks excluded) and focused web 50
> tests pass with API/web builds, web test TypeScript and edited web lint.
> This is local source evidence, not verification of Nikita's tenant, the
> selected space's audience, existing copies or DPO acceptance.


> DPO-wide local verification follow-up, 2026-09-29: a stale Confluence
> erasure target-reference fixture was corrected to the canonical shape. A
> broad API run passes 2,320 tests with the separate real-PostgreSQL
> publication-table check and a host-sensitive Windows child-process check
> excluded by name. Migration 39 has independent disposable PostgreSQL
> rehearsal evidence. This is not an unrestricted full gate or live review.


> DPO-03 destination-bound approval, 2026-09-29: local source now binds each
> reasoned Confluence publication approval to the selected site and space,
> audits changes, and checks that binding at queue, retry and worker boundaries.
> A recorded page in another site or space blocks reuse until its copy is
> reviewed. Migration 39 withdraws legacy unbound approvals with a system
> event; existing remote pages are untouched and the Vault warns when a
> recorded page remains without approval. A disposable PostgreSQL upgrade
> through all 39 DPO migrations, 192 focused API tests, 50 focused web tests,
> builds, web test TypeScript and edited-file lint pass. Migration lint has no
> block and one validating-CHECK lock warning. Coordinate cutover because an
> overlapping old API may attempt an unbound approval that the new constraint
> rejects. Live tenant, provider audience, remote copies and DPO acceptance
> remain unverified; do not mark DPO-03 or public-production review closed.


> DPO-03 previous-site and disconnected-copy display, 2026-09-29: the mirror
> response distinguishes a recorded page on another Confluence site, an
> inactive connection, or an unverified page site from an absent page link. Retained site facts after
> disconnect cannot create an active link. The Vault warns about either case,
> does not show cached visible state as current health, and withholds retry pending
> review. The Admin retry route rejects inactive destinations and recorded
> pages on another site before queueing; the worker retains its independent
> different-site guard. API/web builds, 70 focused API and 48 focused web tests, web test TypeScript
> and edited web-file lint pass locally; web tests used the existing gitignored
> Windows `tsx` fallback. No live tenant/provider or DPO approval was checked.
> At that checkpoint the publication-approval boolean was not tied to a
> reviewed Confluence site/space. The newer destination-binding entry above
> addresses this source-level gap; deployment and live review remain open.

> DPO-03 recorded-page response correction, 2026-09-29: a page URL can be null
> because the Confluence site address is unavailable even when a page ID is
> recorded. The Admin mirror response now exposes a page-recorded boolean,
> without a separate raw page-ID field (a valid URL includes the ID). The browser treats missing old-response evidence as unknown
> and keeps pending/failed/historical wording accurate without claiming
> external absence. Page links also require the publication site ID to match
> the current connection, preventing a link that combines an old page ID with
> a newly connected site's address. The Admin route test checks matching and
> reconnected sites and Member denial. API/web production builds, 68 focused
> API mirror/route tests (14 service tests), 47 web mirror/copy tests, web test
> TypeScript and edited web-file lint pass locally. The API workspace lacks an
> ESLint config; its build and focused tests pass. The
> web tests needed the existing gitignored workaround for this host's
> pre-assertion `tsx` user-info ENOMEM. This supersedes the earlier URL-based
> source claim, not live remote/tenant verification or provider purge.

> DPO-03 partial Confluence copy display, 2026-09-29: a stopped or pending
> publication can already have a recorded external page reference. The Vault
> now distinguishes that case from an attempt without a recorded page and
> avoids claiming the copy is absent. Non-CURRENT files retain a separate
> external-review cue and cannot be republished without current approval.
> Test TypeScript, 32 focused mirror-copy tests and edited-file lint pass.
> This is local wording based on the recorded reference, not a live Confluence
> check, tenant classification or withdrawal/purge proof.

> DPO-01 Vault download source recheck, 2026-09-29: the authenticated byte
> proxy now confirms after provider I/O that the current tenant record still
> names the storage path and written provider just read. A changed source
> returns 409 without bytes or a preparation-audit event. API build and 34
> focused document-reliability tests pass, including path/provider race cases.
> This is source-level proof, not provider/tenant verification; legacy null
> providers still need custody review, and a later change remains a bounded
> race.

> DPO reviewed-host follow-up, 2026-09-29: the September access correspondence
> identifies the private host where Nikita signed in to review the then-deployed
> demo. A fresh visit reached only its public landing page, with no authenticated
> CharityPilot session; the earlier unsigned health response gave no tenant or
> build identity. A historical VM row count is not evidence of the reviewed
> tenant. Jasper does not know that tenant/environment or where the C1 closure
> evidence is kept. C1 reconciliation and the historical replay-event cause
> remain unverified; no live record was accessed or changed.

> DPO-04/06 evidence follow-up, 2026-09-29: a source review found the
> minimised approved-snapshot renderer still matches the private field
> matrix; the existing export test checks omission of internal narratives,
> approver particulars and snapshot identifiers. No disclosure policy or
> export behavior changed. Bounded work-mailbox, Atlassian Rovo and Linear
> searches found the 28 September DPO thread and unrelated general records,
> not dated C1 admin-email closure evidence. This does not prove absence or
> identify the reviewed tenant. C1 status remains unchanged pending its
> original evidence and current risk revision.

> DPO-06 local evidence search follow-up, 2026-09-30: text extraction from
> 288 local Word files and 241 PDFs in the controlled Timebank Ireland folder
> found a generic March C1 risk row but no dated admin-email closure receipt.
> Seven PDFs could not be extracted. This does not cover mail, image-only
> content or Nikita's tenant; the live C1 claim remains unchanged.

> DPO-02 proxy/browser refresh handoff, 2026-09-29: a proxy rotation can
> update shared cookies without advancing the browser's refresh stamp. The
> browser now probes `/auth/me` under its Web Lock when a reactive retry sees
> no newer stamp, including when the unchanged stamp is non-null, and reuses a current
> session without submitting a spent token. Two regression cases, 23 focused
> tests, test TypeScript, edited-file lint and the production web build pass.
> Server replay quarantine remains intact. This narrows sequential timing;
> simultaneous proxy/browser refresh, proactive renewal without shared
> storage, multi-process proxy behavior and Nikita's historical cause are
> unverified. No deployment or incident disposition follows.

> DPO-05 queued deletion identity, 2026-09-29: migration 38 rejects updates
> to a deletion job's ID, provider, JSON target, reason and requesting actor.
> A disposable populated PostgreSQL 16 upgrade through all 38 DPO migrations
> rejected each direct identity edit and exercised audited corrected-path
> dead-letter recovery. Changing the linked retired
> publication's page ID then caused a retry with zero fake-provider calls;
> restoring it allowed processing. The runner removed its loopback-only
> container, and 71 migration-gate tests pass. This supersedes the earlier
> 37-migration maximum. It is not Atlassian deletion, versions/backup purge,
> approved withdrawal, deployment or reviewed-tenant evidence.

> DPO-05 queued-target integrity, 2026-09-29: the Confluence worker now checks
> that the queued cloud, page and attachment IDs match the uniquely linked,
> same-charity retired publication before provider I/O. A changed target
> records a retry without a provider call. API build and 246 related tests pass
> with one Windows host-dependent subprocess test excluded. A disposable
> populated PostgreSQL 16 upgrade through all 37 DPO migrations exercised a
> changed queued page ID (retry, zero fake-provider calls) and restored target
> (processed, one fake-provider call); Admin audit reflected both attempts.
> The container was removed and an independent local-engine listing found no
> remainder. This supersedes older no-PostgreSQL-worker/245-test notes below.
> Atlassian, provider versions/backups, approved withdrawal, deployment and
> the reviewed tenant remain unverified.

> DPO-05 Confluence source-ID correction, 2026-09-29: migration 37 extends
> the source-document trigger so a post-deletion Confluence job may carry its
> original ID only after a same-charity retired publication is stamped with
> the exact deletion ID and path. Ordinary local/Supabase jobs still require
> the live document/path at insertion. The request stamp, job and actor audit
> remain transactional. API build, 185 focused tests and migration lint pass.
> A populated disposable PostgreSQL 16 upgrade through all 37 DPO migrations
> passed request refusal for a live document, valid linked insertion, forged
> job rejection and worker refusal/eligibility around a reappearing document.
> The container was removed. Atlassian, backups, policy-approved withdrawal,
> the reviewed tenant and deployment remain unverified.

> DPO-01/03 migration-36 rehearsal, 2026-09-29: a disposable PostgreSQL 16
> populated upgrade applied 64 baseline and all 36 DPO migrations. It
> preserved a synthetic legacy `DRAFT`/`MEMBER_VISIBLE` row under the
> `NOT VALID` guard while refusing a new row and an update with that unsafe pair.
> Prisma reported up to date; the container was removed and an independent
> local-engine listing found no remainder. Older migration-36-unrun notes are
> superseded. Nikita's tenant, real document classification and production
> upgrade remain unverified.

> DPO-05 queued erasure recheck, 2026-09-29: explicit Confluence deletion jobs
> now retain the source document ID. Before provider I/O, the cleanup worker
> verifies exactly one charity-scoped `RETIRED` publication link, source-ID agreement
> where present, and absence of a live local document. Legacy null-ID jobs
> still require the unique publication link. API build and 245 related tests pass
> excluding one Windows `tsx` subprocess test that fails before assertions on
> host `uv_os_get_passwd` ENOMEM. The source-ID path has since passed disposable PostgreSQL; Atlassian and reviewed-tenant
> proof remain open, as do withdrawal policy and actual purge evidence.

> DPO-05 erasure live-document fence, 2026-09-29: the explicit Confluence
> erasure request refuses a `RETIRED` publication if the charity's local
> document still exists. The 409 path leaves no deletion job or request audit.
> API build and 99 focused fake-datastore tests pass. A later disposable PostgreSQL
> rehearsal passed; Atlassian and the reviewed tenant remain unverified; a policy-approved
> withdrawal and hold design for formerly published live files is still open.

> DPO-01/03 draft visibility correction, 2026-09-29: working DRAFT files can
> no longer be newly released to Members. Member list, detail, download,
> search and dashboard activity also withhold legacy visible drafts, with a
> post-storage-I/O download recheck. The Admin Vault disables the release;
> migration 36 adds a `NOT VALID` CHECK for new and updated database rows.
> API/web builds, 112 focused API tests, edited UI lint and the migration
> gate pass locally. A subsequent disposable PostgreSQL rehearsal passed, but
> the reviewed tenant, legacy rows and actual file audiences remain unreviewed.

> DPO-05/06 erasure audit correction, 2026-09-29: an explicit Confluence
> erasure request now commits its queued deletion, publication stamp and
> actor-bound request event in one transaction. Failure to write the event
> rolls back the request. API build and 97 focused tests pass using
> rollback-aware fakes; PostgreSQL, Atlassian and the reviewed tenant are
> unverified. The request is still reachable only for a RETIRED publication
> after its CharityPilot document is deleted, while ordinary Vault deletion
> is DRAFT-only. A reviewed path for formerly published live documents and
> provider-copy disposition remains an open DPO-05 issue.

> DPO web-suite follow-up, 2026-09-29: the ordinary Windows command still
> fails before web assertions on this sandbox's `tsx`/`os.userInfo()` ENOMEM.
> A gitignored test-only preload handles that exact host error without app
> changes. Five stale wiring assertions were updated to check the present
> Member-facing compliance/organisation/delete wording and Admin-only register
> summaries. Test TypeScript and the full compiled suite pass 539/539 under
> that preload. This is not normal-runner, deployed browser or DPO-tenant proof.

> DPO-01/05 connector classification, 2026-09-29: the schema-drift test found
> newly added `Document.storageProvider` absent from the connector's field
> policy. It is now withheld from generic closed-personal-data projections;
> a projection test and the full connector suite pass (395 tests, four platform
> skips). This leaves Admin custody controls intact and does not verify the
> reviewed tenant or classify document contents.

> DPO source-regression check, 2026-09-29: a fresh production build passes all
> three packages. The broad API run found that the new Confluence environment
> audit event was absent from the shared event union and that two report tests
> had stale fake databases without the required preparation-audit writer.
> Both are corrected; nine focused tests pass. On repetition, the API suite
> passes 2,300/2,302, with only sandbox Docker `EPERM` and host `tsx` startup
> ENOMEM failures. Excluding those exact host-dependent cases yields
> 2,300/2,300; the full suite is not green on this host. The root production
> check passes 1,090 tests with two skips and two separate host failures in
> Windows ACL restriction and Docker-on-PATH proof. No live-tenant or public
> production assurance is inferred from this build and bounded test evidence.

> DPO-05 legacy storage custody review, 2026-09-29: Owner/Admin can check an
> unverified Vault key against both active providers. Both stores must answer,
> only one may have the key, and its byte size must match the document row.
> The provider and actor-bound `STORAGE_PROVIDER` audit event commit together
> under a revision check; every ambiguous or unavailable check leaves deletion
> blocked. Migration 35, API/web builds, 167 focused API tests, 11 connector
> route-coverage tests and the disposable PostgreSQL 16 upgrade through 64
> baseline plus 35 DPO migrations pass locally. A targeted isolated Chromium
> journey confirms the unverified UI and fail-closed local-only provider check.
> This is point-in-time active
> object evidence, not a byte-identity check, historical upload proof,
> deleted-item restore, version/backup purge, policy approval or live-tenant
> verification.

> DPO-05 written Vault provider, 2026-09-29: new files carry the provider that
> actually received their bytes; migration 34 backfills only exact attached
> reservations, leaving unmatched legacy files unverified. The provider is
> immutable once known and an intent cannot attach with a contradictory value.
> Downloads and ordinary draft deletion use the pinned provider; unknown
> legacy custody blocks deletion before a false cleanup claim. API build,
> Prisma validation, 163 focused tests and 71 migration-gate tests pass. The
> first sandboxed Docker attempt returned `EPERM`; an authorised local-pipe
> retry passed a disposable PostgreSQL 16 upgrade with all 34 DPO migrations,
> exact provider backfill, unmatched-null preservation and both guards. This
> is not deleted-item restore, final purge,
> policy approval or live-tenant evidence.

> DPO-02 no-Web-Locks reactive fallback, 2026-09-29: after a 401, the web
> client now probes the current session before using a refresh token when Web
> Locks are unavailable. A sequential retry after another tab's rotation
> reuses the current cookies; a failed probe cannot present the token. Eight
> focused tests, test TypeScript, edited-file lint and production web build
> pass. Simultaneous tabs without Web Locks remain a race; historical replay
> cause and deployed-tenant proof remain open. This turn's source/commit search
> yielded no C1 admin-email closure evidence, so C1 status is unchanged.

> DPO-06 Confluence publish-target integrity, 2026-09-29: the provider space
> check now completes before a database transaction writes the target and
> actor-bound audit event together. The update requires the connection to
> remain on the validated site. API build and 109 focused tests pass, including
> a simulated site switch and audit-write rollback. Real PostgreSQL and
> Nikita-tenant verification remain open; no earlier target changes are
> backfilled.

> DPO-06 Confluence citation history, 2026-09-29: citation add/remove now
> appends an actor-bound, metadata-only document-control event transactionally
> with the reference change. It carries opaque document/reference IDs, not
> page title, URL or content. Migration 33 permits the new constrained kind;
> 33 DPO migrations are in this checkout. API/web builds and 23 focused tests
> pass; migration lint warns about the validating CHECK window without a block.
> PostgreSQL migration and live tenant proof remain unavailable; prior citation
> changes were not reconstructed.

> DPO-02 browser storage fallback, 2026-09-29: after a 401, the Web Locks
> refresh coordinator now probes `/auth/me` under the lock if the shared
> rotation stamp is unavailable. A current session skips another refresh;
> probe failure does not present a possibly rotated token. Six focused tests,
> test TypeScript, web build and lint pass locally. The compiled tests passed
> directly with Node after this host's optional `tsx` preload failed with
> ENOMEM. Web Locks absence, multi-process behavior and Nikita's historical
> replay events still need separate evidence.

> DPO-06 Confluence declaration audit, 2026-09-29: the Owner/Admin plan and
> residency declaration write now appends an actor-bound security event in the
> same transaction. Its `RECORDED`/`CLEARED` action omits the declared values;
> Governance Audit includes the metadata and its UI identifies the event.
> This was DPO migrations 31-32, bringing that checkpoint to 32 DPO migrations.
> API/web builds and 101 focused tests pass. Migration lint has one expected
> validation-window warning on the revised subject check. No real PostgreSQL
> migration, deployed-tenant inspection, historical backfill or C1 closure was
> proved by this slice. The disposable migration rehearsal stopped at the
> local Docker Desktop Linux named pipe with `EPERM` before creating a fixture.

> DPO-05/06 case overview minimisation, 2026-09-29: the separate Admin
> `/data-lifecycle/audit` recent feed no longer fetches `evidenceRef` across
> cases; individual controlled case history still returns it with the reason.
> API build and 14 focused intake tests pass. This is response minimisation,
> not deletion, live review or approved retention. A fresh renderer check found
> no extra dynamic field in the minimised Compliance Record outside the private
> disclosure matrix; recipient-specific approval remains open.

> DPO-01/06 overview projection, 2026-09-29: the four remaining whole-row
> Governance Audit feeds (organisation, deadlines, registers, reports) now
> select named metadata fields. The shared direct-feed contract requires a
> projection and its 17-feed route test checks for one; the merged case-link
> feed already uses explicit selections. API build and 12 focused archive
> tests pass. Future schema fields cannot surface there by default. This is
> source-level minimisation, not live tenant, erasure or DPO sign-off proof.

> DPO-01/06 overview minimisation, 2026-09-29: the Admin Governance Audit
> feed no longer selects the free-text compliance reason or data-request
> evidence reference for its expandable cross-domain JSON view. Restricted
> record histories still carry them. API build and 12 focused archive tests
> pass. This does not erase stored values or prove live-tenant behaviour.
> Automatic approval review rejected a read-only browser open of the
> historically mentioned private Tailscale host because the actual reviewed
> environment/tenant is unconfirmed and private data could be exposed. The
> local Tailscale status pipe also denied access. Do not bypass the rejection;
> live replay/C1 review needs an expressly authorised target.

> DPO-05 schema coverage, 2026-09-29: the data lifecycle model map names all
> 70 current Prisma models in eight groups and a production-check test requires
> exact coverage as the schema changes. This is a source inventory, not an
> approved retention schedule or a deleted-item restore/purge control. Vault
> draft deletion still removes its row and queues primary-byte cleanup; the
> deletion-job recovery path cannot restore it. Off-schema stores, legal holds,
> recovery period, provider versions and backups remain policy/proof gaps.
> The new map test and 15 launch-status tests pass. The full production-check
> run on this shell has 1,090 passes, two skips and two host-dependent failures
> (owner-only Windows ACL publication; live PATH check with Docker unavailable).
> The full gate remains unverified until both pass on a capable host.

> DPO public-production evidence gate, 2026-09-29: the launch evidence
> contract requires a 90th check for disposition of Nikita's feedback against
> the reviewed tenant and exact promoted commit, covering six findings, four
> interface locations, first-pass review and remaining actions. Missing or
> wrong-commit evidence fails the validator. The checklist now requires all
> DPO migrations in the promoted release, currently 33 source migrations.
> Launch-evidence, launch-status and preflight suites pass locally (80 tests
> with one platform skip, 21 and 180 respectively). This is a source gate,
> not live migration, provider proof or formal DPO production sign-off.

> DPO-05/06 deletion-overview minimisation, 2026-09-29: the Admin Governance
> Audit no longer selects free-text Confluence erasure reasons from storage
> deletion jobs. API build and 12 archive tests pass; the saved reason remains
> in its controlled record. A separate source check found a fixed seven-day
> cleanup of eligible authentication-email delivery evidence. It is a narrow
> existing operational rule, not approval of whole-application retention or
> proof of provider/log/backup purge. See the private lifecycle inventory.

> DPO-06 integration audit navigation, 2026-09-29: Governance Audit now pages
> eight named Confluence/security event types using tenant- and type-bound
> cursors and a metadata-only selection. The response omits site URLs, names,
> reasons and context. API/web builds, 12 archive tests and an isolated
> PostgreSQL/Chromium Owner journey pass with gated teardown. Older or failed
> best-effort audit writes are not reconstructed; an erasure-request row is not
> provider-purge evidence. Nikita's reviewed tenant remains unidentified.

> DPO-05/06 case-evidence audit feed, 2026-09-29: Admin Governance Audit now
> merges tenant-bound metadata for Vault/job case links and withdrawals into
> one stable 50-row cursor feed. It excludes reasons, paths and provider errors;
> detailed reasons remain in the controlled case view. API build, 11 focused
> archive tests, E2E TypeScript and an isolated PostgreSQL/Chromium Owner
> journey pass with gated teardown. This uses existing migrations 25/30 and
> supplies no live tenant, erasure, recovery or approved-retention proof.

> DPO-05 case-to-live-Vault lineage, 2026-09-29: A controlled Owner/Admin
> reviewer can append a reasoned link from a data request to an exact live
> Vault document ID and later withdraw the association without rewriting it.
> Migration 30 verifies tenant and live row at insertion and keeps the opaque
> ID after an eligible draft is removed; the MCP connector excludes these
> routes. API/web/MCP builds, 14 intake tests, 11 route-coverage tests,
> 115 isolated-runner safety checks, a populated 30-migration PostgreSQL
> upgrade and two isolated Chromium Owner journeys pass. The migration gate
> has no block and one new-table index warning. This is evidence linkage,
> not a subject match, erasure decision, deleted-item recovery, provider/backup
> purge or live DPO review. The private roadmap has the exact limits.

> DPO-04 disclosure boundary, 2026-09-29: a private field-by-field matrix now
> records the minimised approved-snapshot draft's exact dynamic fields,
> omitted internal details and outstanding recipient decisions. API build and
> 26 focused export tests pass; the source review found no further renderer
> field leak. Aggregate inference, policy approval, downloaded copies and live
> tenant verification remain open. See the gitignored
> `.charitypilot-private/report-disclosure-matrix.md` before changing the
> report audience or claiming it is regulator-ready.

> DPO-05 source-job discovery, 2026-09-29: Admin Data Requests can now search
> technical deletion jobs by exact source Vault document ID and choose one for
> the existing reasoned case-link action. The lookup is tenant-bound and
> cursor-paged, excludes paths/provider errors, and cannot find legacy jobs
> with no recorded source. Migration 29 uses a concurrent partial index.
> API/MCP builds, 12 case tests, five connector coverage tests, edited web
> lint, E2E TypeScript, blue-green gate, isolated PostgreSQL/Chromium Owner
> journey and representative 29-migration populated upgrade pass. Subject
> matching, policy, full purge and Nikita's live tenant remain unresolved.

> DPO-02 replay-timing evidence, 2026-09-29: future replay audit events now
> record the presented session's previous revocation time. The restricted
> diagnostics validates and shows it beside request and family correlation
> facts; historical events remain without it. Shared/API builds, 50 focused
> auth/team tests, edited web lint and E2E TypeScript pass. An isolated
> PostgreSQL/Chromium replay journey confirmed the database event and restricted
> Owner display, with gated teardown. A short delay alone cannot classify
> the cause. Nikita's event/log correlation and deployed proof remain open.

> DPO-05 source-document lineage, 2026-09-29: migration 28 adds an optional,
> immutable source-document ID to storage-deletion jobs. New ordinary Vault
> draft deletions record it in the same transaction as row removal; a database
> guard checks the charity and exact path at insertion. The Admin Data Request
> case view displays the ID on a linked job. Legacy and orphan jobs stay null.
> API build, 59 focused tests, edited web lint, E2E TypeScript, blue-green
> gate and an isolated PostgreSQL/Chromium deletion-and-case journey pass.
> A representative populated-data upgrade through 64 baseline and all 28
> DPO migrations passes with two retained legacy documents; production-scale
> data shapes and lock time remain unverified.
> This is source lineage, not subject identification or full erasure proof;
> policy, recovery, replicas/backups, live tenant and DPO review remain open.

> DPO-02 protected-page validation burst control, 2026-09-29: Concurrent
> Next.js requests sharing an auth credential and origin now share only a
> pending `/auth/me` call in one process. Completed checks are not cached;
> subsequent requests still reach the API and revocation/replay controls.
> The focused proxy suite passes 24/24, edited lint and the production web
> build pass, and all five DPO review journeys pass against disposable
> PostgreSQL/Chromium with gated teardown. Earlier combined runs hit an auth
> 503 before a long browser test was split; the later pass does not establish
> the cause of those errors or of Nikita's historical replay events. The
> reviewed live tenant and cross-process behavior remain unverified.

> DPO-01/03 unreviewed-file release guard, 2026-09-29: The Admin Vault now
> disables Member release of an `UNREVIEWED` document and explains the required
> lifecycle classification. The API refuses the same transition. Migration 27
> adds a `NOT VALID` database CHECK that enforces new and updated rows without
> claiming older rows comply; an existing unreviewed/visible row needs review
> and classification or restriction before an update. The API build, 48 route
> tests, edited UI lint, E2E TypeScript and static migration gate pass. The
> focused isolated PostgreSQL/Chromium Owner journey passes, including the
> disabled button and direct database CHECK denial; gated teardown exited 0.
> The earlier combined navigation suite hit an authentication-service 503 on
> reload twice and is not a clean suite result for this edit.
> Actual file contents, Nikita's tenant, approved audience and live rollout
> remain unverified.

> DPO-01 legacy-read follow-on, 2026-09-29: Member Vault list, detail and
> download, Search and dashboard activity now exclude `UNREVIEWED` documents
> even if a retained row says `MEMBER_VISIBLE`. Download checks lifecycle again
> after storage I/O; its session-role check treats such a row as restricted.
> API build and 106 focused document/search/dashboard tests pass. This is a
> source boundary, not a classification of legacy rows, a retrospective access
> finding or deployed-tenant evidence. External Confluence copies need their
> own audience review.

> DPO recovery-family boundary: a disposable PostgreSQL/Chromium rerun
> refused blank-code MFA removal from a different synthetic session family
> with 401 and left the factor enrolled; the recovery-authenticated family
> then removed it successfully. The gated runner exited 0.

> DPO authentication recovery, 2026-09-29: A disposable PostgreSQL/Chromium
> browser journey used the final recovery code to sign in, verified its
> session-family audit event, and removed MFA with the password and blank code
> from that family. The run found and fixed an invalid empty-code UI request
> and a database CHECK that rejected family-bearing recovery-use events.
> Migration 26 permits that event's optional family ID while preserving the
> other event constraints. The corrected journey and gated teardown pass.
> The blue-green gate warns of an existing-row CHECK validation; live tenant,
> role-wide enforcement and DPO approval remain open.

> DPO-05 case-to-deletion evidence, 2026-09-29: Owner/Admin Data Requests can
> link an existing same-charity storage-deletion job to an unresolved case with
> actor and reason, then withdraw a mistaken link with a separate immutable
> reason while retaining both records. Composite database foreign keys enforce
> the charity boundary. The case feed omits paths and provider errors and
> labels job status as technical evidence, not an erasure verdict. Migration 25,
> local builds and focused tests pass; all four DPO review journeys pass
> together against disposable PostgreSQL/Chromium after a separate queue-test
> boundary assertion was corrected. The gated runner exited 0. The blue-green gate
> warns about a non-concurrent index on existing deletion rows. Policy,
> versions/backups, live deployment and Nikita's tenant remain unresolved.

> DPO-05 case lookup, 2026-09-29: Owner/Admin Data Requests can now open a
> case by exact opaque archive reference through a tenant-scoped API lookup.
> Member access and personal-identifier inputs are refused. Eight focused
> intake tests, API/production web builds, E2E TypeScript and edited-page lint
> pass; a disposable PostgreSQL/Chromium Owner journey opened a case outside
> page one by reference. This does not approve or perform erasure.

> DPO-05 intake queue paging, 2026-09-29: The Admin Data Requests list now
> uses a tenant-bound `(receivedAt, id)` cursor instead of offset pages. A
> new case cannot shift older cases out of the next page; the web deduplicates
> appended rows and rejects stale in-flight pages after refresh. API and
> production web builds, seven intake tests, edited-page lint and E2E TypeScript
> pass locally. An isolated Chromium Owner journey reached two older cases after
> a 53rd was inserted into disposable PostgreSQL between pages; the runner
> exited successfully. This does not implement erasure, recovery, retention or
> live-tenant proof.

> DPO-01/06 audit overview minimisation, 2026-09-29: The Admin Governance Audit
> feed now selects event metadata for Minute Book, document control/visibility,
> risk, control verification and compliance changes rather than loading full
> before/after snapshots or narrative reasons into the cross-domain overview.
> Detailed record histories remain available to authorised reviewers. API build
> and 10 focused archive tests pass locally; this does not erase retained rows,
> verify C1 or establish deployed-tenant behavior.

> DPO-06 review-list refresh, 2026-09-29: The Registers risk-control panel now
> refreshes its attention list after a verification, withdrawal or parent risk
> revision reload, and discards older in-flight responses. Edited-page lint and
> the production web build pass. This fixes locally stale UI state; it does not
> verify C1's closure.

> DPO review navigation rerun, 2026-09-29: All three isolated Chromium Owner/Member
> journeys pass together, including the uploaded-draft storage-deletion audit
> outcome; gated teardown exits successfully. The earlier transient
> authentication-unavailable page did not recur. This is local synthetic proof,
> not verification on Nikita's reviewed host or a replay-event diagnosis.

> DPO-05 connector copy follow-up, 2026-09-29: Six MCP removal tool
> descriptions, its missing-reason error and README approval example now
> describe active-record removal without claiming permanent erasure. The MCP
> build and 61 focused tool/session tests pass. Audit and backup copies may
> remain; disposal mechanics and P0-08 status are unchanged.

> DPO rendered deletion-audit follow-up, 2026-09-29: A focused isolated
> Chromium Owner journey uploaded a synthetic draft, removed it through
> the Vault, and showed the matching committed storage-deletion outcome
> and active-object absence receipt on Governance Audit. The test uses
> the retained upload intent to correlate the separate document and
> deletion-job IDs; E2E TypeScript and gated teardown pass. This is a
> local provider/tenant fixture, not deployed or backup-purge proof.

> DPO deletion-attempt audit follow-up, 2026-09-29: Migration 24 captures
> pending-deletion retry, dead-letter and completion outcomes as separate
> append-only database events, exposed through a tenant-scoped Owner/Admin
> Governance Audit feed without storage paths or provider errors. A populated
> disposable PostgreSQL 16 upgrade, API and web builds, nine focused audit
> tests and reset-safety checks pass locally. Earlier attempts are not
> backfilled; an event does not establish provider-version or backup purge.

> DPO failed-cleanup administration, 2026-09-29: The Owner/Admin dead-letter
> queue now pages retained failed deletion jobs instead of stopping at 100.
> Documents exposes eligible jobs with a reasoned, typed-confirmation retry
> using the existing recovery action. API/web builds, 13 route tests with
> 203 jobs and a disposable PostgreSQL/Chromium Owner journey with 52 jobs,
> a committed retry and gated teardown pass. A retry can later delete the
> recorded target; it is not deleted-item restoration or purge proof.

> DPO document history follow-up, 2026-09-29: The detailed Owner/Admin
> Documents change-history feed now pages the retained control and visibility
> events 50 at a time instead of stopping at 100. A tenant-bound cursor and
> stable cross-table order preserve tied timestamps. API/web builds, 35 focused
> API tests including a 202-event fixture, edited UI lint and E2E TypeScript
> pass locally. A disposable PostgreSQL/Chromium Owner journey loaded all five
> pages in the rendered Documents UI and passed gated teardown (exit 0).
> This does not reconstruct pre-audit changes or verify Nikita's deployment.

> DPO deletion-history follow-up, 2026-09-29: The detailed Owner/Admin
> storage-deletion history API now pages 50 retained jobs at a time with a
> charity-bound cursor instead of silently stopping at 100. API build and 57
> focused route tests, including a 202-job fixture and Member/foreign-cursor
> checks, pass locally. This is review navigation, not deleted-item recovery
> or permanent provider/version/backup purge evidence.

> DPO deletion audit follow-up, 2026-09-29: The existing retained
> storage-deletion recovery decisions are now visible as a paged,
> tenant-bound Owner/Admin Governance Audit feed with sensitive paths,
> reasons, operator identity and nonce excluded. The deletion queue
> feed describes current status; it does not record each worker attempt.
> This is local source work, not proof of provider purge, a deployed
> tenant, deleted-item restoration or approved retention policy.

> DPO stale-upload cleanup follow-up, 2026-09-29: Repeated failure of the
> oldest upload reservations can no longer starve later orphaned objects.
> Migration 23 records a guarded reconcile-attempt timestamp; the worker
> orders less recently attempted reservations first and retains failures for
> retry. API build, Prisma validation, 40 focused tests and a populated
> PostgreSQL 16 upgrade/service rehearsal pass. The blue-green gate warns
> about a non-concurrent index on an existing table. No deployed scheduler,
> provider purge, backup expiry or approved retention policy is proved.

> DPO Confluence scheduler follow-up, 2026-09-29: Local orphan-publication
> retirement now runs before remote reconciliation, so a tenant-listing or
> provider failure cannot skip that local recovery step. Sweep failure alerts
> separately and does not suppress the remote pass. API build and 120 focused
> tests pass; Nikita's scheduler and Confluence provider remain unverified.

> DPO Confluence discoverability follow-up, 2026-09-29: The scheduler's
> orphan-publication sweep now filters for a missing CharityPilot document
> before bounding the batch and includes failed publications with a recorded
> Confluence page. This prevents older live publications from indefinitely
> hiding a later stranded page after immediate retirement failed. API build,
> 118 focused tests and a disposable PostgreSQL 16 query proof pass. The
> scheduler and provider remain unverified on Nikita's unknown deployment;
> no external page was erased or retention decision made.

> DPO replay follow-up, 2026-09-29: In an isolated local Chromium run, two tabs
> sharing one synthetic Owner session recovered after their access cookie became
> invalid with exactly one browser refresh request and no replay event in the
> disposable tenant. The runner's 115 safety checks and gated teardown passed.
> This covers one ordinary browser timing, not every interleaving or the cause
> of Nikita's observed events. Her deployed event/log correlation remains open.

> DPO Member Vault follow-up, 2026-09-29: A local isolated Chromium journey now
> proves a synthetic Member can list/download a deliberately released file while
> a second file left at the `RESTRICTED` default is absent from the Member list.
> The web API client also preserves all metadata beside `data`, preventing a
> paged replay/governance audit response from being silently unwrapped into an
> array; 13 focused client tests and the targeted browser journey pass. This
> is neither real-content classification nor deployed-tenant verification;
> the DPO and public-production gates remain open.

> DPO Vault file-scope follow-up, 2026-09-29: A connector with personal data
> withheld can no longer request whole-file Vault downloads. The connector
> hides/refuses the file tool, and the API checks the session scope before
> storage access and again after provider I/O. A read-only connector is also
> denied by the API even if it calls the GET endpoint directly. Local builds and focused tests
> pass. Existing document contents still need controller classification and
> the reviewed deployment remains unverified.

> DPO report-access follow-up, 2026-09-29: Full working and approved reports
> now require a `FULL` personal-data session as well as Owner/Admin role;
> the connector's full-report file tool is hidden and refused when its gate is
> closed. Direct API calls from read-only connectors are also denied. Both
> report variants recheck the live role and session after
> generation, before audit and HTML delivery. API/connector builds and focused
> suites pass locally. The minimised draft still needs audience/field approval,
> and no reviewed-tenant or browser proof exists.

> DPO retention-source correction, 2026-09-29: The March 2026 hOUR Timebank
> Document Retention Schedule was attached to the 21 March governance-suite
> email. The complete eight-message thread includes Sridevi's express approval
> of all 31 documents and Jasper's confirmation that the resolutions passed.
> Jasper's earlier 30 August email saying assent was missing was corrected by
> his later [version 3 verification](https://docs.google.com/document/d/1v6nyLUsa-Rf1q2HUkeJsK6KwXQD_Z2cG6ja4_0Ejnvw/edit),
> which identified a truncated Gmail preview. The private roadmap records the
> message IDs and schedule categories. The schedule's seven-year former-member
> entry differs from CharityPilot's former one-year `retentionDeleteAt`; local
> source no longer derives or exposes that date, while stored values await
> reconciliation. The later Data Protection Policy V2 discussion calls for
> category-specific justification. A controller-approved current-policy map,
> exceptions, recovery and purge evidence remain open; no automatic expiry
> follows from this historical approval evidence.

> DPO Vault-access audit follow-up, 2026-09-29: A successful authenticated
> download now needs a metadata-only, append-only preparation event after the
> post-storage session and document/Member-visibility checks. Failed audit
> writes withhold bytes. Governance Audit exposes the tenant-scoped event to
> Owner/Admin. The twenty-second DPO migration, focused tests, web/API builds
> and a populated disposable PostgreSQL 16 upgrade pass locally. This records
> preparation, not client receipt, and is not live-tenant or retention proof.

> DPO evidence-location follow-up, 2026-09-29: Prior work correspondence gives
> a private-host/charity lead for Nikita's dashboard, but her 28 September
> review did not confirm that host, tenant or deployed revision. Narrow work
> mailbox and connected Drive searches did not locate a dated C1 admin-email
> verification or a CharityPilot-approved retention schedule. A subsequent
> connected Confluence search found a requirement to maintain a schedule, but
> no adopted schedule or C1 closure artifact. No live record
> or policy status was changed; search scope and the lead are in the private
> roadmap.

> DPO authentication-settings navigation, 2026-09-29: Security & Data now
> directs every charity role to its own Team session inventory and revocation
> control, alongside personal MFA and password change. Charity-wide audit and
> data controls stay Owner/Admin-only. This navigation has local source/build
> proof but no Nikita-tenant browser proof.

> DPO password-control verification, 2026-09-29: A populated disposable
> PostgreSQL 16 upgrade through all 21 DPO migrations exercised the real
> Fastify Member password-change route. Its first run caught an audit-row
> session-subject constraint violation; the corrected event passed with
> cookie clearing, old-session denial, recovery-link termination, two session
> revocations and a `PASSWORD_CHANGED` Team audit result. The fixture was
> removed. This is local proof, not a live tenant or rendered-browser check.

> DPO password-control follow-up, 2026-09-29: Every signed-in charity role can
> change its own password in Security & Data after current-password and, when
> enrolled, second-factor proof. The locked transaction invalidates recovery
> links and sessions and writes a metadata-only security event, displayed as
> `PASSWORD_CHANGED`. The connector cannot invoke this human credential route.
> Local builds and focused tests pass; no live browser or Nikita-tenant proof
> exists. The older recovery-only note below describes an earlier checkpoint.

> DPO follow-up, 2026-09-29: Report rendering now writes a metadata-only row in the separate append-only report-preparation audit before returning working, approved or minimised-review HTML; audit failure withholds the report. The Admin Governance Audit labels these events. The twenty-first DPO migration, 28 focused export/archive tests and a populated disposable PostgreSQL 16 upgrade with append-only event check pass locally. The event proves preparation for delivery, not receipt or disclosure approval. Older exports and Nikita's live tenant remain unverified. Member role guidance no longer promises broad governance-record downloads.

> DPO follow-up, 2026-09-29: Future session-replay events record a one-way presented-session-row fingerprint and active-session quarantine count. The Admin diagnostics view allowlists and explains both; older rows have null values. Shared/API/web builds and 50 focused auth/Team tests pass locally. Matching fingerprints correlate repeat presentation of one spent row but do not decide whether Nikita's events were a client race or token theft. Her historical events and deployed logs remain uninspected.

> DPO navigation follow-up, 2026-09-29: Security & Data now shows each charity role its own password-recovery link beside personal authenticator controls. The Owner/Admin administration map remains role gated. This uses the existing recovery flow and is not a new password-change endpoint or a live journey check.

> DPO follow-up, 2026-09-29: The local Team Security & Ownership Audit now pages through retained events 50 at a time with a tenant-bound, stable timestamp/ID cursor and current Owner/Admin checks. The connector accepts the cursor and preserves its personal-data gate on the paged response. Shared/API/web/connector builds, edited-page lint, focused lifecycle tests, the connector suite and a disposable PostgreSQL 16 upgrade through all 20 DPO migrations pass. This makes older retained events reviewable; it is not a live tenant check, replay-cause finding, retention decision or production sign-off.

> DPO follow-up, 2026-09-29: Browser and connector attempts to grant a human action approval that are refused now write a tenant-scoped security event with account, channel and time only. The offered ID, password and specific failure cause are omitted; the response remains opaque. Two new migrations update the enum and subject constraint. Focused tests and a populated disposable PostgreSQL 16 upgrade through all 20 DPO migrations pass. This records future attempts after deployment, not earlier attempts or Nikita's unknown live tenant.

> DPO follow-up, 2026-09-29: The local Admin Governance Audit includes tenant-scoped, append-only human connector approval request, renewal, grant and use events with server-derived record IDs for correlation. The eighteenth DPO migration backfills retained approval timestamps and installs database triggers for future transitions. Backfilled events are labelled and leave original expiry unknown. A disposable PostgreSQL 16 upgrade, transition/immutability checks and Admin/Member API checks passed; the fixture was removed. Approval summaries, digests and session-family IDs stay out of the overview. Refusal attempts are in the separate Team security audit; historical renewals and a complete cross-domain application audit remain outside this feed. This is local evidence, not deployed or DPO sign-off.

Last updated: 2026-09-29 (DPO follow-up; historical baseline retains its stated date)

This is the authoritative, human-maintained remediation ledger for the full
CharityPilot audit completed on 2026-07-10. It is intentionally separate from
`docs/platform-completion-audit.md`, which is generated by
`scripts/platform-completion-audit.mjs`.

The objective is to fix every confirmed repository-side defect, gap, misleading
claim, accessibility issue, security concern, reliability weakness, and
operational deficiency recorded here, while keeping genuine production,
provider, legal, security-review, and human-signoff work explicit.

## 2026-09-28 onward: DPO follow-up to this historical audit

A disposable PostgreSQL 16 DPO-01 rehearsal now uses real Fastify routes, Prisma and signed browser/MCP-connector sessions against synthetic statutory-member, complaint and document records. Member requests were denied for statutory members, complaints, conflicts, full export and restricted document detail/download; Vault lists omitted restricted documents. Admin requests read seeded restricted records, an explicitly visible fixture file appeared to Members, and a database role demotion defeated an old Admin token. This is local API/database evidence, not actual file or tenant inspection, a rendered browser/full connector CLI journey or production access certification.

The DPO-06 scheduler now scans latest active verified risk-control claims daily for unknown or changed risk revisions, logging only an aggregate count. The existing Admin Registers attention list supplies tenant-scoped records for review. A scan failure alerts through the sanitized scheduler path and fails run-once. The cadence is bounded from one hour to seven days in production config/preflight. API build, 27 focused scheduler/observability tests, all 180 production-preflight tests and a disposable PostgreSQL query rehearsal pass locally. This does not reconcile C1's missing admin-email closure evidence or verify Nikita's live tenant or scheduler deployment.

Current migration evidence (2026-09-29): all 81 repository migrations, including the 17 DPO migrations, applied successfully to an empty, loopback-only disposable PostgreSQL 16 database; Prisma reported the schema up to date. The container was stopped/removed and absence was verified. The earlier dated "unapplied" statements below describe their then-current checkpoints, not this clean-database proof. This clean-database run alone leaves populated-data upgrade and DPO trigger behavior untested; providers, deployment and Nikita's tenant lack evidence from either run. No full-platform or DPO sign-off follows from these checks.

A second disposable run deployed the 64 pre-DPO migrations, seeded an organisation/Owner and two synthetic legacy documents, then applied the 17 DPO migrations. Both documents retained restricted/unreviewed/unapproved/unheld defaults; database checks rejected unsafe publication and forged upload-intent transitions while accepting a matching attachment. Schema status and container cleanup passed. This is representative upgrade/trigger proof, not a full populated production rehearsal or live-host evidence. The repeatable harness is in the private, Git-ignored roadmap area.

The latest DPO-05 local follow-on bounds local and Supabase provider writes after upload reservation (five-minute default, 30-minute maximum) below the one-hour orphan-reconciliation age. A stalled Supabase request is aborted. The connector and human action-approval descriptions also no longer promise immediate permanent Vault-file or Confluence purge. API/MCP builds, 30 focused storage/upload-intent tests, nine action-summary tests, 391 connector passes with four platform skips, and 179 production preflight tests pass locally. The upload-intent migration and real provider behavior remain unverified; this does not supply a retention period, deleted-item recovery or backup purge.

The local DPO authentication slice adds opt-in TOTP for charity accounts with one-time recovery codes. Setup requires the account password, activation requires a current code, and activation/removal revoke existing sessions. Browser and connector login verify the factor after the password but before issuing a session, under the locked principal transaction; accepted TOTP counters and recovery codes are single-use. Invalid code attempts share an account-wide five-attempt, 15-minute budget after password proof. The personal setting is visible to every charity role, while charity-wide security controls remain Owner/Admin-only. Security audit events record activation, removal and recovery use without secrets. The sixteenth and seventeenth DPO migrations create factor storage and widen the audit subject constraint; both remain unapplied to PostgreSQL. API/MCP and production web builds, Prisma validation, 2,246 broad API tests with environment-only Docker/child-process checks excluded, and 391 connector tests with four platform skips pass locally. This does not set a role-wide MFA requirement, decide recovery authority when both authenticator and codes are lost, prove a live deployment or close P1-07. `JWT_SECRET` rotation requires a recovery/re-enrolment plan for sealed TOTP secrets.

The latest DPO-01 source check closed an approval-summary read gap after role demotion. Browser pending approvals and grants, plus connector approval previews and grants, now require the database-derived current Owner/Admin role; a demoted Member cannot read an old summary naming a restricted record. API build, 34 focused tests, 2,236 broad API tests and 389 connector tests (four platform skips) pass locally. This is not a deployed Member journey or a retrospective account of summaries already viewed.

The latest DPO-05 source slice persists a provider-pinned upload reservation before writing document bytes. Document creation and attachment of that reservation are transactional. The recurring and standalone cleanup jobs reconcile reservations older than one hour: a live same-tenant document is preserved; an orphan is queued for provider-pinned deletion atomically, with failed queue attempts left retryable and alerted by count. The deletion worker checks for a live document again before erasure. API build, Prisma schema validation, 101 focused tests and 2,235 broad API tests pass locally, with Docker-backed PostgreSQL checks and a local child-process ENOMEM check excluded. The fifteenth DPO migration remains unapplied; no PostgreSQL trigger, live provider, deleted-item recovery, backup purge or approved retention schedule has been verified.

Member login, `/auth/me` and invite acceptance now avoid fetching four private organisation fields for Member accounts. Login reads organisation lifecycle first, then uses a role-matched public-user query before a locked password and role check for session issuance; the account read resolves the current role before choosing a database selection. Owner/Admin profile data remains available. The API build and 48 focused auth/team tests pass locally. This resolves a source-query minimisation gap, not the controller's Member audience decision or a live tenant verification. No DPO or production gate is closed by it.

The private DPO-01 source map at `.charitypilot-private/member-read-surface-inventory.md` now covers the registered API read families, Member projections, Owner/Admin gates, connector boundaries and outstanding audience decisions. It is a source inventory, not a live tenant or content inspection. The Vault's profile-triggered evidence prompt also checks `CURRENT` lifecycle status directly before counting a linked file, so historical links cannot satisfy it if a future caller passes a mixed list. The production web build and edited lint pass locally; the controller classification and deployed Member journey remain open.

An Admin-only, tenant-scoped `/governance-registers/risks/control-review-attention` route now pages through the latest active claim for each control whose captured risk revision is unknown or differs from the current risk. The Registers page loads this list on entry and offers refresh and further pages; withdrawn controls are omitted. The connector excludes the route and withholds revision and deletion-hold fields. API and production web builds, 50 focused register tests, 389 connector tests with four platform skips, Prisma validation and edited web lint pass locally. This is an on-page review check, not scheduled scanning, C1 evidence reconciliation or a control-effectiveness verdict. The fourteenth DPO migration has not run on PostgreSQL; live tenant behavior remains unverified.

New control claims now record the integer revision of the tenant-scoped risk seen by the verifier; each risk edit advances that revision. The Admin per-risk history asks for reassessment when the latest active verification for a control predates the current risk, and flags older active claims whose revision cannot be known. Withdrawn and superseded claims remain in history without an active cue. The fourteenth DPO migration guards revision transitions and new claim capture but remains unapplied to PostgreSQL. Local API build, 49 focused register tests, production web build, three compiled cue tests, Prisma validation and edited web lint pass. This does not establish C1 closure, assess the original evidence or provide a periodic check; the reviewed tenant and closure artifact remain unidentified.

Ordinary Vault deletion now rejects `UNREVIEWED`, `CURRENT`, `SUPERSEDED`,
`RETIRED` and `HISTORICAL` evidence before it creates a cleanup job; only an
unheld `DRAFT` can use the existing delete path. The final database delete
rechecks lifecycle and hold together. The Admin Vault disables Delete for
retained or unreviewed records and points to retention review. This interim
preservation gate has 103 passing focused document route/storage/reliability
tests and an API build. It does not implement a controller-approved purge,
restore window, or historical-document disposition. The migrations and live
tenant remain unverified.

New local/Supabase primary-storage delete attempts check active-path absence
after the provider call. Supabase requires an authenticated HEAD 404; present,
malformed, failed and timed-out reads enter the existing retry/dead-letter
path. A guarded nullable `activeObjectAbsentAt` receipt now distinguishes new
processed local/Supabase observations from old processed and Confluence rows.
The thirteenth DPO migration remains unapplied. The 102 focused
document/storage tests, 31 erasure/scheduler tests, five archive tests,
13 adjacent reliability tests,
Prisma validation and API build pass locally. This is no proof of old rows,
object versions, backups, a recovery window or live provider behaviour.

The Admin Registers screen now pages through retained verification claims for
one risk, with an optional exact control-reference filter. Tenant, risk and
filter-bound cursors make older C1 claims inspectable without relying on the
charity-wide latest-100 list. The 23-test register route suite, API/MCP and
production web builds, edited web lint and connector route coverage pass
locally. The original C1 closure evidence and reviewed live tenant remain
unknown; the new path does not establish whether C1 is verified, and its DPO
migration remains unapplied.

Governance Audit now pages through eleven retained domain histories via an
Owner/Admin-only archive route. Tenant-bound cursors and deterministic ordering
allow older records to be reviewed without unbounded queries. Deletion paths
and free-text data-request reasons stay out of the overview. Five focused API
tests, API/MCP and production web builds, edited web lint and connector route
coverage pass locally. This is not a legacy backfill or a complete audit of
every application mutation; the DPO migrations remain unapplied.

Future replay audit events now preserve the presented token row's prior
revocation reason in restricted context. The Admin diagnostic allowlists and
shows the reason, which helps distinguish a previously rotated, logged-out or
already-quarantined token. It does not prove why the token was presented or
alter older events. Focused tests and shared/API builds pass locally; Nikita's
live events remain uninspected.

The Admin-only replay diagnostic now includes the immutable event ID alongside
the existing safe correlation fields and pages through older retained events
50 at a time with a tenant-bound timestamp/ID cursor. Focused service tests
confirm role denial, narrow selection and stable paging; shared/API/web builds
pass. Nikita's event cause and exact tenant remain unverified.

A 2026-09-29 DPO-05 local slice adds an administrative deletion hold to
documents. Owner/Admin may place or release it with a reason and expected
revision; the change is actor-audited. Ordinary Vault deletion checks the hold
and conditionally deletes only an unheld record, including when placement
races deletion. Focused route tests, Prisma validation and API/MCP/production
web builds pass locally. The twelfth DPO migration is unapplied. This control
does not define a legal hold, retention period, restoration window or full
erasure policy, and it does not gate separate Confluence erasure or existing
storage-cleanup work. No PostgreSQL or live-tenant proof exists.

The Member Team read now returns active accounts only and withholds other
account holders' email and verification fields at the query boundary; the
response uses null placeholders and the screen explains the limited view.
Owner/Admin management access is unchanged. Shared/API/MCP and production web
builds, 16 focused Team API tests, 20 compiled Team UI/permission tests, 52
connector tests and edited web lint pass locally. This is not a complete
Member access review or deployed-role verification.

Member risk and fundraising list/detail queries now select only the fields
needed by their existing limited responses; full Owner/Admin reads are
unchanged. Annual-readiness and financial-control Member queries likewise
select only the visible status, flag and date fields. The 22-test register
route suite checks field selection, tenant scope and withheld response text;
the 25-test service suite and API build pass. The wider classification and
live Member access review remain open.

Search delegates now select only IDs and fields allowed for matching or title
display in the caller's scope. This prevents a Member search from loading
hidden trustee, document or deadline columns even when the response had already
withheld them. The 16-test search route suite applies and verifies the database
field selection; the API build passes. Live role checks and controller
classification remain open.

Member compliance record list/detail queries now select only the existing
standard/status/revision view without loading evidence narratives or editor
relations. Member sign-off reads now select visible metadata and the current
snapshot evidence hash without approver particulars or the latest historical
snapshot. The live evidence hash is still computed internally when approved,
preserving `approvalCurrent`; Owner/Admin reads remain complete. The 21-test
compliance suite, seven export-snapshot tests and API build pass. Live and
controller review remain open.

The later document lifecycle follow-on adds a database trigger that allows a
new standard link only while the document is `CURRENT`, serialising insertion
with lifecycle changes. Existing links persist as historical evidence after a
status change. The API reports a concurrent refusal as a conflict; 40 focused
route tests and the API build pass locally. This eleventh DPO migration is
unapplied and has no PostgreSQL or hosted proof.

The Vault now flags a recorded Confluence copy on a non-current document for
separate review, rather than using a green published badge. It does not claim
that a lifecycle change withdrew the external page. Failed jobs on non-current
files no longer offer a retry that the API will refuse. Thirty-one focused
copy tests, edited-file lint and the production web build pass locally; actual
Confluence withdrawal and hosted verification remain open.

The Board approval mutation now rejects empty changes and skips the database
write and `BOARD_APPROVAL` audit event for a repeated identical value. A newly
selected resolution still needs approved Minute Book evidence. Shared/API builds
and 36 focused governing-act tests pass locally; deployed behavior and older
audit rows remain unverified.

Governance Audit now includes a recent Admin-only, tenant-scoped data-request
review feed with no free-text case reasons in its overview. Individual case
history retains the reason for controlled review. Focused access tests,
connector route-coverage tests, API/MCP and production web builds pass locally.
The intake migration is unapplied and this feed is not a retention or purge
control.

Current local follow-on: organisation profile edits now append a metadata-only,
actor-bound audit event in the edit transaction. An Admin-only, tenant-scoped
feed appears in Governance Audit. This adds an eighth unapplied DPO migration;
it does not backfill older edits or complete the application-wide audit.
Statutory Members register create/edit actions also append metadata-only events
to the existing register feed; a ninth unapplied migration permits their kind.
Interactive deadline create/edit/complete/archive actions now have a separate
metadata-only, actor-bound Admin audit feed. Organisation-profile edits that
regenerate the calendar also append actor-bound `GENERATE` and `SUPERSEDE`
entries for changed occurrences in the same transaction. Its tenth migration
is unapplied; reminder delivery remains in separate operational history.

This 2026-07-10 ledger remains the full-platform baseline. Nikita Serkevich's
later demo feedback is recorded in the local gitignored
`.charitypilot-private/ROADMAP.md` (obtain the private handoff if absent). It
adds six open privacy/control work items: sensitive-record Member access,
session-replay investigation, structural document lifecycle, minimised report
exports, application-wide retention/erasure, and reconciliation of stale C1
verification evidence. The 2026-09-28 local implementation slice adds
Owner/Admin-only full exports and conflict/complaint reads, plus a default
restricted document visibility field with Member filtering and a reasoned audit
of visibility changes. It has not been migrated or verified on a live host.
Other personal-data surfaces, external Confluence publication, and the eventual
classification policy still require review. The live replay events and C1
record were not inspected.
The subsequent local source slice adds reasoned document lifecycle transitions,
a separately approved Confluence publication gate and recent document-control
history. Existing Confluence copies remain to be inventoried and managed. It
also adds a minimised Compliance Record **draft** from a verified approved
snapshot; audience and field disclosure require DPO/owner review. Focused tests
pass, but both migrations, managed browser flows and live tenant behavior are
unverified. Application-wide retention/recovery/purge and the cross-domain
governance audit trail remain open.
The 2026-09-29 export follow-on removes the internal snapshot ID/hash from the
minimised draft and sets no-store/nosniff response headers for both report
variants. The API build and seven focused snapshot-export tests pass locally;
this does not approve an external disclosure or prove live cache behavior.
The Admin Data Requests case view now pages through retained intake/triage
events beyond its former 100-row cap, with a tenant-and-case-bound cursor.
API and production web builds and six focused lifecycle tests pass locally;
this does not resolve application retention, recovery or purge.
Member BoardMember list/detail now select only ordinary trustee evidence, and
Search applies Member field scope, excludes conflict/complaint/risk/fundraising hits, and filters
document hits by visibility. These are local source/test results, not a live
personal-data exposure assessment.
The Member dashboard activity feed now omits compliance editor and document
uploader IDs/names and does not fetch those relations for Member requests.
The focused dashboard/search suites pass 26/26; live exposure remains untested.
Member-visible document list/detail now withhold unreviewed description,
owner, board-minute reference and uploader ID at selection and response;
Member search matches only the visible document name. Download still requires
current authorisation. Focused document/search tests pass 41/41; controller
classification and live access evidence remain open.
The separate statutory membership register's GET also exposed postal
addresses and former members to signed-in Members. It is now restricted to
Owner/Admin at the API boundary, with a focused Member-denial test. A reviewed
register-by-register classification and live tenant check remain open.
Another local source slice now limits Member reads of risk/fundraising, annual
readiness, financial controls and compliance records/sign-off to explicit
status/flag/date projections. Arbitrary titles and narratives, names, minute
references and editor/approver details are withheld; the web screens describe
that limited view. Owner/Admin reads remain complete. API build and 41 focused
route tests passed, but classification and live exposure review remain open.
The removed Minute Book record feed is now Owner/Admin-only because it includes
historic titles, removal reasons and remover emails; the Member screen does not
request it. Current act and resolution list/detail reads are also Owner/Admin-only
as an interim rule; Member search and navigation omit them. Final audience and
field classification and live review remain open. The governing-act/search
suites passed 50 focused tests locally.
The Board-submissions route is also Owner/Admin-only because it includes
resolution text and approval particulars. It now selects only documents with
`CURRENT` lifecycle status, so superseded or unreviewed files cannot appear as
current Board evidence. The 33-test governing-acts suite checks Member denial
before a document read and the current-only query. Current act/resolution reads
are now restricted to Owner/Admin; classification and live review remain open.
New Minute Book act/resolution create and update writes now record actor-bound
before/after snapshots atomically with each edit. The append-only table feeds
an Owner/Admin-only, tenant-scoped recent list in Governance Audit, and the
MCP connector excludes that feed. The 32-test route suite, API build and Prisma
schema validation passed locally. Document board-approval link/assertion
changes now also write actor-bound previous/next states to the document-control
history in the same transaction. The unapplied lifecycle migration includes
that new event kind. This fourth migration is unapplied and legacy edits are
not backfilled; other application changes still need audit coverage.
Ordinary document metadata edits now also leave actor-bound field names and
revision timestamps in the same append-only history, without copying free-text
content or storage paths. Uploads record the actor and restricted draft state
atomically with document creation; an audit-write failure fails the upload and
enters the storage cleanup path. Document DELETE also records the actor and
database-record removal in the same transaction, before provider cleanup; this
does not attest byte or Confluence erasure. The metadata write is guarded
against a concurrent revision. Governance-standard link and unlink now add
actor-bound events in the mutation transaction, with no event for a repeated
no-op unlink. The 32-test local document route and 32-test storage-cleanup
suites cover the events and relevant failure paths. Legacy changes and other
application domains remain outside a complete audit.
A fifth local migration adds an Admin-only erasure/retention request intake and
triage queue with immutable intake facts, append-only review events and a
tenant-bound event foreign key. The `/data-lifecycle` screen accepts only an
opaque external case reference, a data area and received time, then records
unresolved review states with actor/reason/evidence reference. It cannot mark
erasure complete. A private source inventory maps major database, object,
integration, export, log and backup classes. Four focused route tests, API
build, Prisma validation, edited web lint and connector tests passed. No
retention policy, deletion/recovery/purge action or live verification exists.
The MCP connector relies on the API read boundary. Its tool descriptions,
route exclusions and document field policy were updated for these DPO controls;
the local connector contract suite passed (388, with four platform skips).
Browser tabs now coordinate refresh with Web Locks where supported; the live
replay events still need restricted event correlation.
The server proxy now shares only an in-flight refresh within one process for
the same credential header and origin, keyed by a digest. Completed rotations
are not cached, so later reuse reaches API replay quarantine. The compiled
proxy suite passed 23/23. This does not cover multiple web processes or prove
the cause of Nikita's historical events.
Future replay audit events also capture the server request ID for log
correlation, without token material; the 27-test auth-isolation suite passed.
Earlier events and their cause remain unverified. Risk changes and dated
control claims now have separate append-only histories, and an Admin-only
`/governance-audit` page presents recent document, risk, control, compliance
and storage-deletion histories with links to the Minute Book and Team security
log. The route and UI work passed focused local tests/build; it has not been
migrated or checked on Nikita's instance. These histories are bounded and do
not cover all legacy actions. C1 verification has not been changed without its
dated source evidence. At that checkpoint all five DPO migrations were unapplied; application-wide
retention, recovery and purge remain open.
The control-verification path now locks the tenant-scoped risk before examining
its latest claim; a database-assigned append sequence orders claims even when
their timestamps tie. Focused register tests and the API build pass locally.
This remains an unapplied source change, not C1 closure or live concurrency proof.
A sixth local DPO-03 migration adds a tenant-bound optional successor link for
superseded documents. New supersession requires a different current document in
the same category and tenant, with an atomic replacement audit event. An Admin
can search candidates and see lineage in the Vault. Member responses and the
connector withhold the successor ID because it could identify a restricted
file; the database foreign key blocks deletion of a referenced replacement.
The API and still-unapplied sixth migration now also prevent later category
edits from breaking a recorded replacement relationship; the migration's
row-locking trigger awaits PostgreSQL execution and concurrency proof.
Legacy superseded rows are not assigned invented successors. Focused document
API suites passed 92/92; the broad API suite passed 2166 tests with Docker
and sandbox-failing child-process proofs excluded, while the connector suite
passed 388 with four platform skips. Prisma/schema, build and edited web lint
checks passed locally. None of the six DPO migrations has run against PostgreSQL;
browser, hosted, classification and DPO review remain open.
Another local DPO-01 read pass restricts custom and legacy calculated deadline
titles for Members across list, history, direct reads, Search, dashboard and
activity. Members retain current-rule generated deadlines; Owner/Admin retain
the full calendar. Focused API tests passed 35/35 and the broader API suite
passed 2168 tests with Docker-backed and sandbox-failing child-process proofs
excluded. The connector suite passed 388 with four platform skips. The Member
view states its limit. Controller classification and live/browser checks remain
open, and the six DPO migrations are still unapplied.
Member organisation-profile and authenticated-user responses now omit registered
address, contact email/phone and conditional obligation facts, since the address
may be a trustee home. The Member page shows only basic details and explains the
limited view; Owner/Admin retain the full profile. Focused organisation/auth
tests passed 34/34. The profile route omits these fields at database selection;
auth/user loading still selects them internally before response projection.
No live/browser privacy proof exists.
An Owner/Admin-only `/security-data` page now provides a direct map to tenant
sessions, security events, password recovery, governance history, data-request
triage, document/storage deletion and Confluence copy management. It identifies
tenant MFA settings, approved application-wide retention enforcement, legal
holds, deleted-item recovery and permanent-purge administration as pending.
Edited web lint passed; live access and all missing controls remain unverified.
A later local DPO-02 slice adds an Owner/Admin replay-diagnostics view with a
bounded request ID, client kind, time and one-way family fingerprint; it does
not establish the cause of the historical replay events. A seventh DPO source
migration adds append-only, metadata-only trustee, conflict, complaint and fundraising
create/edit/delete history, plus annual-report and financial-control create/edit
history, shown in Governance Audit without copying personal details or narratives. Focused
service/route tests, schema validation and builds passed locally. All seven DPO
migrations remain unapplied to PostgreSQL, and historical actions are not
backfilled. The live tenant, C1 evidence and
retention policy remain unidentified.
Her email is expressly **not** production sign-off. Do not close P0-08, privacy
review, or any strict launch gate on this intake alone.

## Baseline Verdict and Current Launch Snapshot

- Manual audit score: **669 / 1000**.
- Backend, security, and data integrity: **228 / 300**.
- Frontend, accessibility, UX, and product truth: **218 / 300**.
- QA, release engineering, operations, and documentation: **188 / 300**.
- Legal/compliance assurance: **35 / 100**.
- Current strict production launch score: **18 / 121 gates, or 149 / 1000**.
- Launch phase: `ENV_INCOMPLETE`.
- Production values: `9 / 27` complete.
- Launch-evidence checks: `9 / 89` complete.
- Final signoffs: `0 / 5` complete.
- `approvedForLaunch`: `false`.

The `669 / 1000` manual score is the historical 2026-07-10 audit baseline; the
strict launch figures are the refreshed 2026-07-12 workstation/schema snapshot. Refresh them with
the live commands below at the start and end of every remediation session.

## Completion Definitions

### Repo-side complete

Repo-side completion means every P0-P3 repository item in this document has:

1. a root-cause fix rather than a cosmetic workaround;
2. focused regression coverage where practical;
3. appropriate wider test, lint, build, security, and audit verification;
4. consistent product copy, documentation, runbooks, and accessibility;
5. a recorded commit SHA and successful CI run;
6. no unapproved deferral or silent risk acceptance; and
7. been pushed to `origin/master` in a coherent verified slice.

### Launch complete

Launch completion requires repo-side completion **plus** genuine production
configuration, live provider checks, promoted release images, public HTTPS
deployment, rollback proof, database and object-storage recovery evidence,
deployed browser QA, professional legal/governance/privacy/accounting review,
an external penetration test, remediation or formal human risk acceptance, and
all five named final signoffs.

Passing local tests is not launch completion. A `1000 / 1000` claim is prohibited
until production values are `27 / 27`, evidence checks are `89 / 89`, strict
gates are `121 / 121`, final signoffs are `5 / 5`, and all evidence is genuine
and bound to the promoted release.

## Live Baseline Commands

Run these before selecting work:

```powershell
git status --short --branch
git branch --show-current
git remote -v
git fetch origin
git rev-list --left-right --count origin/master...master
git log --oneline -10
npm run launch:status -- --json
npm run audit:platform:check
node scripts/platform-completion-audit.mjs --json
```

Audit-time Git state:

- branch: `master`;
- baseline SHA: `8809bac3a897afe6078df82142097c3fcc924e8f`;
- upstream: `origin/master`;
- pre-existing user work:
  - `apps/web/src/app/(marketing)/page.tsx`;
  - `apps/web/src/lib/web-wiring.test.ts`.

Do not revert, overwrite, stash, or silently absorb those edits into unrelated
work. Inspect them live. If they form a completed valid slice, verify and commit
them separately; otherwise preserve them.

## Issue Status and Evidence Contract

Use only these statuses:

- `CONFIRMED`: reproduced or evidenced, not yet fixed;
- `IN_PROGRESS`: actively being repaired;
- `CODE_COMPLETE`: implementation exists but verification is incomplete;
- `LOCALLY_VERIFIED`: focused and applicable local gates pass;
- `CI_VERIFIED`: pushed commit and required CI gates pass;
- `BLOCKED_EXTERNAL`: requires a credential, provider, infrastructure, named
  professional, external tester, business decision, or repository-owner action;
- `FULLY_VERIFIED`: every applicable code, test, CI, documentation, and external
  evidence requirement is complete.

For every item, record in this document or a linked evidence-safe ledger:

```text
ID | priority | status | risk | reproduction/evidence | affected files/symbols
required result | acceptance tests | commit SHA | CI run | external owner/blocker
```

Do not mark an item verified merely because code was written or a test title
exists.

## Non-Negotiable Safety Rules

- **Run the default E2E suite only through the P0-05 managed runner, which must
  independently prove an explicitly disposable database before any reset or
  truncation path can execute. Never bypass or weaken that proof.**
- Never target a production, personal, shared, or ambiguously named database
  with destructive test logic.
- Prefer `npm run personal:ready` for non-destructive local confidence.
- Never commit or expose `.env.production`, secrets, tokens, private evidence
  JSON, database dumps, sensitive screenshots, provider credentials, pentest
  reports, or legal-review reports.
- Never populate a missing production value with a placeholder merely to turn a
  validator green.
- Never fabricate provider acceptance, backup/restore results, deployed browser
  QA, legal conclusions, penetration-test results, release binding, or signoff.
- Agent-authored legal text is not professional approval.
- A database restore is not a document-storage restore.
- A mock provider success is not live-provider proof.
- An old CI run attached to another SHA is not current release evidence.
- Do not process real charity data before the complete launch and recovery gates
  pass.
- Derive behavior from this repository's documented contracts and current Irish
  primary sources rather than importing assumptions from unrelated products.
- Only the coordinating agent performs Git staging, commits, pushes, and ledger
  integration when subagents are used.

## P0: Launch-Blocking Repository Work

### P0-01 - Unsafe annual-reporting legal and accounting claims

Status: `CI_VERIFIED`

Evidence:

- `apps/web/src/content/blog/annual-reporting-guide-irish-charities.tsx:120-184`
  presents EUR10k/EUR100k/EUR250k/EUR500k bands as current law and states that
  income over EUR500,000 always requires an audit.
- The Irish Statute Book does not list a section-50 regulation prescribing that
  table.
- Current Charities Regulator material labels a different accounting regime as
  proposed, while relevant Charities (Amendment) Act 2024 changes remain
  uncommenced.

Required result:

- Immediately contain or remove unverified prescriptive claims.
- Replace them only with current, official-primary-source-backed wording.
- Add visible source metadata, last-checked dates, legal-form qualifications,
  commencement status, and professional-review warnings.
- Review all blog, marketing, deadline, register, export, and compliance text for
  the same unsupported threshold assumptions.
- Keep accountant/solicitor approval external; do not manufacture it.

Acceptance:

- Content tests prevent unsupported thresholds or certainty language from
  returning.
- Source log and visible copy agree.
- Official-source verification is dated.
- Named accounting/legal approval remains an explicit launch-evidence item.

Repository remediation completed on 2026-07-10:

- Replaced the unsupported income-band and universal audit claims with a dated,
  source-checked guide that distinguishes current law, proposed guidance,
  uncommenced amendments, legal-form differences, CRO company obligations, and
  professional review.
- Removed the same unsupported threshold, carry-over, and nonexistent-regulation
  claims from the adjacent simple/complex and Governance Code articles.
- Added `apps/web/src/lib/legal-content-safety.test.ts` to scan the full blog
  corpus for the removed claims and require the current revised-Act, regulator,
  commencement, SORP, and CRO sources.
- Updated `docs/product-revamp/irish-source-log.md` with the targeted 2026-07-10
  recheck while preserving the truthful 2026-07-09 whole-matrix check date.

Local verification:

- `npm test -w @charitypilot/web`: `244 / 244` passed.
- `npm test -w @charitypilot/shared`: `19 / 19` passed.
- `npm run lint -w @charitypilot/web`: passed.
- `npm run build -w @charitypilot/web`: passed.
- `npm run audit:platform:check`: passed after regenerating the audit's web-test
  inventory from 17 to 18 files.
- `npm run test:production-check`: `396 / 396` passed after aligning the
  continuation-handoff assertion with its current documented gate count.
- Final repository search found the removed legal claims only inside the new
  negative regression patterns, not in public product copy.

Commit SHA / CI run:

- `97f64b0285eb2d19489c062cda52134fda8f9a53`
- `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29073803773`

External owner/blocker: named qualified-accountant and Irish-solicitor review is
still required launch evidence. Agent-authored containment is not professional
approval.

### P0-02 - Resend resolved failures counted as successful delivery

Status: `CI_VERIFIED`

Evidence:

- `apps/api/src/services/email.service.ts:259-271` returns success after awaiting
  `resend.emails.send()` without inspecting a resolved `{ data: null, error }`
  response.
- Verification, reset, invitation, and reminder mail can be rejected while the
  application reports success.
- Reminder delivery can be marked `SENT` and become non-retryable.

Required result:

- Handle both rejected promises and resolved provider-error results.
- Treat delivery as successful only after provider acceptance.
- Keep failed reminders retryable with sanitized diagnostics.
- Preserve enumeration resistance and provider degradation behavior.

Acceptance:

- Tests cover provider success, resolved error, thrown exception, sanitized
  logging/alerting, endpoint behavior, and reminder retry state.
- No secret, address, token, or provider payload leaks into client responses.

Repository remediation completed on 2026-07-10:

- Email delivery now succeeds only when Resend returns `error: null` and a
  non-empty provider acceptance ID. Resolved provider errors, malformed success
  envelopes, and thrown SDK/network errors all return `false`.
- Resend's plain-object error shape now flows through the shared bounded provider
  redactor, preserving safe name/code/status diagnostics while removing email
  addresses, tokens, provider keys, storage paths, and raw payloads.
- Failed deadline sends are finalized as `FAILED`, remain reclaimable on the next
  run, and are processed before the job throws one count-only
  `DeadlineReminderDeliveryFailure` so the existing production scheduler emits a
  sanitized operational alert.
- Resend-verification still returns its safe `503 EMAIL_DELIVERY_FAILED`; forgot
  password and team invitation flows retain enumeration-resistant neutral
  responses when delivery resolves `false`.

Local verification:

- `npm run build -w @charitypilot/api`: passed.
- Focused email/degradation/reminder/auth/team/scheduler/idempotency tests:
  `73 / 73` passed from the API workspace.
- `npm test -w @charitypilot/api`: `438 / 438` passed.
- `npm run test:production-check`: `396 / 396` passed.

Commit SHA / CI run:

- `fbd5ce4`
- `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29074651622`

External evidence note: these tests prove the SDK contract and retry/alert state
with controlled provider responses. A real Resend-domain/provider acceptance
check remains a separate production launch-evidence gate.

### P0-03 - Duplicate Stripe subscription and double-billing path

Status: `CI_VERIFIED`

Evidence:

- `apps/api/src/services/billing.service.ts:435-456` always creates a new
  subscription Checkout Session.
- `apps/web/src/app/(dashboard)/billing/billing-plan-sections.tsx:119-138`
  exposes Checkout for non-current plans even when a subscription is active.
- The single local subscription row can be overwritten with the newer Stripe
  subscription ID while the original subscription keeps billing.

Required result:

- Prevent new-subscription Checkout for an active or otherwise incompatible
  existing subscription.
- Use an explicit, safe plan-change path through the portal or a verified
  server-side update flow.
- Define trial, active, past-due, cancelled, and incomplete transition behavior.
- Preserve organisation-scoped idempotency and webhook reconciliation.
- Handle concurrent plan-change and webhook races.

Acceptance:

- Tests prove one organisation cannot acquire two active subscriptions through
  CharityPilot plan switching.
- Current-plan, upgrade, downgrade, cancellation, retry, stale-customer, and
  webhook-order cases are covered.
- UI copy matches the implemented Stripe behavior.

Repository remediation completed and CI-verified on 2026-07-10:

- Added the `BillingCheckoutAttempt` model, enum, migration, one-row-per-
  organisation constraint, Stripe-session uniqueness, expiry index, and
  database interval constraint. A serializable transaction now claims one
  plan/interval attempt and uses its UUID as the Stripe idempotency and metadata
  boundary.
- Checkout now reconciles the stored/search-derived customer and any saved
  subscription, lists all provider subscriptions for that customer, and permits
  a first purchase or restart only when Stripe confirms there is no
  non-terminal subscription. The restart-terminal set is deliberately limited
  to `canceled` and `incomplete_expired`; unknown or ambiguous state fails
  closed.
- Same-plan concurrent/retried Checkout calls reuse the attempt-bound Stripe
  session. A conflicting live attempt is rejected. Before replacing an expired
  attempt, the API retrieves its Stripe session, explicitly expires an open
  session, and blocks replacement when an old session completed but has not yet
  reconciled.
- Checkout webhooks are bound to the current attempt, session, organisation,
  customer, requested plan/interval, exact prior subscription snapshot, and
  provider subscription. A completion is rejected when another non-terminal
  subscription exists. Updated/deleted events re-retrieve authoritative Stripe
  state rather than trusting the event object's mutable fields.
- Subscription persistence now retains `stripeStatus`, `billingInterval`, and
  `cancelAtPeriodEnd`. The configured contract requires exactly one line item at
  quantity one and maps the exact price ID to both plan and interval.
- Existing Stripe-managed subscriptions are portal-only. The API pins
  `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`; production checks require an exact
  active/live two-product/four-price allow-list, price changes without quantity
  changes, explicit recognised proration settings, and at-period-end
  cancellation.
- Billing status now returns server-owned `canStartCheckout` and
  `canOpenPortal` capabilities. The web UI fails closed on those capabilities,
  removes existing-subscription Checkout controls, and no longer promises
  unverified proration.
- Production setup/checklist documentation now requires a legacy open-Checkout
  inventory and expiry/reconciliation pass before rollout because old provider
  URLs cannot be invalidated by the new local attempt table retroactively.

Local verification:

- `node --test apps/api/dist/tests/billing-subscription-integrity.test.js apps/api/dist/tests/billing-reliability.test.js apps/api/dist/tests/billing-reminders-hardening.test.js apps/api/dist/tests/idempotency-reliability.test.js`:
  `50 / 50` passed after the authoritative-ordering, customer-recovery, and
  concurrent-idempotency regressions were added.
- `node --test scripts/check-production-providers.test.mjs`: `13 / 13` passed.
- `npm test -w @charitypilot/shared`: `19 / 19` passed.
- `npm test -w @charitypilot/web`: `248 / 248` passed.
- `npm run lint -w @charitypilot/web`: passed.
- `npm run build -w @charitypilot/web`: passed.
- `npm test -w @charitypilot/api`: `454 / 454` passed after all final focused
  P0-03 regressions were integrated.
- `npm run test:production-check`: `488 / 488` passed.
- `npm run reliability:report -- --write`: green with `454` API and `248` web
  tests, and `365 / 365` covered-guarantee links resolved.
- `npm run audit:platform:check`: passed; the generated platform audit is
  current.

Commit SHA / CI run:

- implementation: `ce9a5ed9701776bb2a957da647b3620288be173b`;
- launch-counter repair: `cba1a5df10538ccb2b84445123de097d0db7a57e`;
- production-readiness assertion repair and verified head:
  `7ffc8f862d863f559365668c19550be00d0bb382`;
- successful CI:
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29077589143`.

External owner/blocker: an accountable billing operator must prove the pinned
live Stripe portal policy, inventory and expire every legacy open
subscription-mode Checkout session, reconcile customer/subscription history,
confirm no organisation/customer has multiple non-terminal subscriptions, and
exercise purchase, duplicate-click, portal change, scheduled cancellation,
terminal restart, and webhook retry/order against the promoted release. No live
Stripe/no-duplicate evidence is claimed by the controlled local tests.

### P0-04 - Compliance autosave data loss and stale board approval

Status: `CI_VERIFIED`

Evidence:

- `apps/web/src/app/(dashboard)/compliance/[principleId]/use-principle-detail-workflow.ts:118-143`
  lets an older autosave response clear a newer pending edit and display
  `Saved`.
- `apps/api/src/services/compliance.service.ts:326-384` permits records to change
  after approval.
- Approval checks at `apps/api/src/services/compliance.service.ts:430-475` are
  not bound to an immutable record revision.
- Export combines current records with the old signoff.

Required result:

- Make client autosave sequence-aware so an older response cannot clear or
  overwrite newer state.
- Add server-side optimistic concurrency or revision checks.
- Bind approval and export to an immutable revision/snapshot/hash.
- Either prohibit post-approval mutation or explicitly invalidate approval and
  require reapproval.
- Add an append-only audit history for governance-significant changes.

Acceptance:

- Tests cover reordered promises, edits during an in-flight save, retries,
  concurrent clients, mutation after approval, approval invalidation, export
  binding, reapproval, and history preservation.
- The UI never reports `Saved` for data that was not durably stored.

Repository remediation completed on 2026-07-10:

- Compliance records and annual sign-off now carry explicit revisions. Writes
  run in serializable transactions behind an organisation-row lock and use
  compare-and-swap semantics. Exact stale retries/no-ops succeed without a
  second revision or audit event; unrelated unique errors are not hidden by the
  narrowly scoped concurrency retry policy.
- Each record and sign-off change appends canonical before/after history.
  PostgreSQL triggers reject updates or deletes to `ComplianceAuditEvent` and
  `ComplianceApprovalSnapshot`; current-snapshot validation binds the pointer to
  the same organisation, reporting year, and approval sequence.
- Board approval rebuilds deterministic evidence, checks the evidence hash the
  client reviewed, and creates an immutable canonical snapshot in the same
  transaction. The snapshot binds organisation/profile/plan scope, standards,
  record revisions and provenance, readiness, conditional review prompts, and
  compliance-matrix metadata. Its SHA-256 hashes are integrity checks, not
  signatures or evidence that a meeting occurred.
- A later approved-record mutation returns the sign-off to draft, clears the
  current pointer, preserves the prior snapshot, and records approval
  invalidation. A stale board-review draft is reset without being misreported
  as an invalidated approval. Scope/profile/plan drift also makes
  `approvalCurrent` fail closed until trustees deliberately reapprove.
- The migration records full truthful baselines and downgrades pre-contract
  `APPROVED` rows to `DRAFT` with `LEGACY_APPROVAL_UNBOUND`; it does not invent
  historical evidence from mutable deployment-time records.
- Working exports render live evidence and never attach a stale approval.
  Approved exports select a tenant-and-year-scoped retained snapshot, verify
  row metadata and both hashes, and render only the snapshot payload. Current
  and approved HTML carry both an HTTP CSP and an in-document blob-safe CSP.
- The web editor now serializes one revision-aware queue per standard, coalesces
  newer drafts, treats same-revision server no-ops as durable, preserves failed
  and conflicted drafts, and offers an explicit confirmed reload of the server
  version with a generation-race guard. Principle loads are request-sequenced.
- Board sign-off uses live draft generation ownership, so response A cannot
  overwrite or report `Saved` over edit B. Failed conflict refresh stays on the
  page with the draft preserved, dirty SPA navigation requires explicit discard,
  and report retrieval uses the authenticated Axios refresh path before opening
  an opener-isolated, revoked object URL.

Local verification:

- Prisma client generation and schema validation passed.
- All `14` migrations deployed cleanly to the dedicated throwaway
  `charitypilot_ci` PostgreSQL database. Transactional probes verified that a
  mismatched current-snapshot sequence is rejected and that snapshot mutation
  and audit deletion are blocked; the proof transaction was rolled back and the
  throwaway container removed.
- API `477 / 477`, web `272 / 272`, and shared `23 / 23` tests passed.
- Root lint and all production builds passed.
- Secret/SAST scans passed across `481` files; production-only and full
  dependency audits reported zero vulnerabilities.
- Production tooling passed `488 / 488`; local-Docker tooling passed `43 / 43`.
- Reliability linkage is green with `374 / 374` covered guarantees linked to
  passing tests; the generated reliability and platform-audit documents were
  refreshed.

Deliberate limitation: the destructive Playwright suite was not run. A real
PostgreSQL concurrency/reset/browser proof must use the isolated disposable
database delivered under P0-05; the personal local-development database remains
strictly out of scope. No browser or destructive-reset evidence is claimed by
the controlled API/web/database verification above.

Commit SHA / CI run:

- `e03b80a44150c384485b5e47e524b9ee60475f70`
- `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29082113651`

### P0-05 - Destructive E2E database identity guard

Status: `CI_VERIFIED`

Evidence:

- `scripts/run-isolated-e2e.mjs` is now the only supported local destructive
  entry point.
  It generates a UUID and high-entropy credentials, constructs a positive
  allow-list build context, rejects Docker/Buildx endpoint overrides, proves and
  pins a local Docker socket plus the integrated builder, reads and validates
  the Compose source once, writes the exact validated UTF-8 text to a private
  `0600` snapshot, uses only that snapshot for config/build/up/logs/down with an
  explicit repository project directory, and owns exact-project cleanup.
- `compose.e2e.yml` uses dedicated loopback ports and runner-scoped images.
  PostgreSQL, API, and web have zero published ports and remain solely on the
  internal bridge. A dedicated pinned Node gateway target contains only an
  audited fixed-route TCP proxy, receives no environment/secret/mount, and is
  the only service on both the internal and project-scoped non-attachable edge
  bridges and the only loopback publisher. Read-only application/gateway roots,
  tmpfs for PostgreSQL, documents, and `/tmp`, and the baked production web
  build require no host mount or persistent volume. API builds the shared app
  image once; web reuses it without a second same-tag build/export. Database,
  API, and web each receive
  one exact unique alias under `charitypilot-e2e.invalid`; the gateway routes
  only to their absolute trailing-dot names so failed internal resolution cannot
  fall through a DNS search path. Its `/proc/net/tcp` healthcheck proves all
  three listeners without repeatedly connecting to upstream services.
- `e2e/helpers/database-safety.cjs` requires the exact local host, port,
  database, user, schema, application name, protected database comment, UUID
  marker, restricted connected role, exact public-table inventory, and final
  same-session identity proof. The reset transaction locks every listed table,
  rejects `ON TRUNCATE` triggers and truncate-publishing logical publications,
  and uses per-relation `ONLY`, `CONTINUE IDENTITY`, and `RESTRICT` without
  `CASCADE`.
- `apps/api/src/routes/health/index.ts` exposes a non-production, keyed binding
  canary that proves the API is connected to the same immutable UUID marker and
  restricted role. The rendered Compose validator pins the API migration/seed
  DSN to the isolated `db` service before any container can start.
- `e2e/global-setup.ts` requires direct identity and keyed API binding before a
  local reset. Exceptional manual remote mode additionally holds a suite-wide
  advisory lease on a required direct/session-affine endpoint. Every remote
  worker database seam proves that exact lease is active; the reset primitive
  proves its own physical session owns it before `BEGIN`. Transaction or
  statement poolers are unsupported, and direct remote `resetDb()` is rejected.
- The parent runner installs one bounded lifecycle before local, deployed, or
  remote dispatch and rechecks abort authority at the final Playwright spawn
  boundary. POSIX completion requires both group absence and leader close;
  checked Windows taskkill is used for abnormal termination. Native-Windows
  remote-destructive mode is rejected until a Job Object-backed lifetime proof
  exists, while local-disposable and non-destructive deployed QA remain
  supported.
- After a remote child group is proven absent, a fresh-connection outer janitor
  re-proves database identity, reacquires the suite lease, verifies API binding,
  resets from the centralized frozen table inventory, verifies again, releases,
  and disconnects. Unproven child termination skips the janitor (or local Docker
  cleanup), fails red, and preserves recovery inputs instead of racing a live
  descendant.
- The retired boolean flag is rejected, `release:ready` delegates to the managed
  runner with a bounded cleanup margin, and CI supplies no reusable database
  credential or reset authority.
- `scripts/isolated-e2e-runtime-attestation.mjs` binds the three random image
  tags to distinct immutable post-build IDs, then, after `up --wait` and before
  endpoint polling or Playwright reset, proves exactly one healthy labelled
  container for each service. It fails closed on image/label/replica drift,
  wrong or extra networks and aliases, host publications, bind/volume coupling,
  weakened tmpfs, writable/privileged/root/capability/NNP drift, or secretful
  gateway environment. `pretest:e2e` runs the complete pure isolation contract
  before a direct `npm run test:e2e` can call Docker.
- The first complete managed run exposed a real production-relevant auth
  bottleneck: every server-side Next session check shared the web service's
  proxy-IP rate bucket. `GET /auth/me` now layers a 60/minute credential bucket
  under an independent 1,000/minute coarse IP ceiling. One case-insensitive,
  authoritative Bearer parser is shared by authentication, limiting, and origin
  enforcement; logout remains origin-sensitive because it consumes refresh
  credentials. The web proxy accepts only exact `200` auth responses, treats
  only explicit `401` as permission to refresh or redirect, requires exactly
  two strictly parsed nonempty rotation cookies, and forwards only two validated
  deletion cookies after a definitive refresh `401`. Every throttle, upstream
  error, redirect, malformed cookie, network failure, and bounded timeout fails
  closed with a no-store `503` and sanitized `Retry-After`.

Current local verification:

- `npm run test:e2e:contract` passed `113 / 113`, including the runner, database
  safety, gateway, Compose-snapshot race, DNS-alias, and hostile runtime-inspect
  contracts.
- `npx tsc -p e2e/tsconfig.json --noEmit` passed.
- `node --check scripts/run-isolated-e2e.mjs` and
  `node --check e2e/helpers/database-safety.cjs` passed.
- `node --import tsx --test apps/api/src/tests/e2e-database-identity.test.ts`
  passed `5 / 5`.
- `npm run test:e2e:isolated:validate` passed and explicitly started no
  containers.
- `node --test scripts/check-local-docker.test.mjs` passed `44 / 44`, and
  `node --test scripts/check-production.test.mjs` passed `159 / 159`.
- A focused managed live regression passed `4 / 4`, covering the previously
  failing billing, compliance approval, pending-navigation, and responsive
  principle-detail journeys.
- The complete managed `npm run test:e2e` gate passed all `113 / 113` isolation
  contracts followed by `96 / 96` Playwright tests in `9.6m` against the real
  UUID-marked disposable PostgreSQL instance and baked production web runtime;
  the full fresh-build, test, teardown, and residue-verified command took
  approximately `25.0m`.
  It covered accessibility, auth/session expiry, tenant isolation, billing,
  compliance, documents, input validation, and every launch-critical route in
  desktop/mobile and light/dark Chromium states.
- Both managed live runs returned through exact-project teardown. Follow-up
  checks found no E2E containers, images, networks, volumes, build context, or
  private Compose state. The personal web/API/database container IDs remained
  exactly `6a238023d3b9`, `2be515b0ae70`, and `8462752f63f2`.
- Full repository verification passed API `488 / 488`, web `295 / 295`, shared
  `23 / 23`, production tooling `512 / 512`, local-Docker tooling `44 / 44`,
  root lint, all workspace production builds, secret/SAST scans across `497`
  files, and production-only plus full dependency audits with zero reported
  vulnerabilities.
- `npm run reliability:report -- --write` is green with `374 / 374` covered
  guarantees linked to passing tests; `npm run audit:platform:check` passes and
  the generated platform audit is current.

Published SHA-bound verification:

- Commit `e9f63038a5e8fe0c0680dcc015566dff2525a56b` contains the complete P0-05
  implementation and documentation slice.
- GitHub CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29116192805`
  completed successfully for that exact SHA, including the isolation contract,
  E2E type-check and Compose validation, security scan, migrations,
  backup/restore, lint, repository tests, reliability linkage, local-Docker
  smoke, production builds/images/smokes, and dependency audit.
- GitHub E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29116192729`
  completed successfully for the same SHA. It re-ran the managed runner
  contract and standalone Compose validation before the isolated browser gate,
  which passed `96 / 96` Playwright tests in `3.2m` and uploaded the report.
- This is repository CI/E2E evidence, not release-promotion or deployed-browser
  evidence. Those independent requirements remain tracked under P0-09.

Repository verification is complete for P0-05 at the exact SHA and workflow
URLs above. Release-promotion, deployed-browser, and live repository-protection
evidence remain separate P0-09 requirements.

Required result:

- Parse and validate host, port, database name, user, schema, and environment.
- Require an explicit disposable-database identity and deny production,
  personal, shared, default, or ambiguous targets.
- Make `release:ready` prove the target identity rather than silently authorise
  reset.
- Provide an exceptional remote-test path only with a deliberately named,
  strongly warned override and independent identity checks.

Acceptance:

- Rejection tests cover public/remote production-like hosts, local personal
  database names, default databases, malformed URLs, mismatched sentinels, and
  missing opt-ins.
- Positive tests cover only a known disposable target.
- The safely isolated E2E suite is run only after these guards pass. Local and
  exact-SHA CI/E2E browser/database proof are complete; release-promotion and
  deployed-browser proof remain tracked under P0-09.

### P0-06 - Incorrect derived deadline dates and recurrence state

Status: `CI_VERIFIED`

Evidence:

- The audited implementation used JavaScript `setMonth()` overflow semantics,
  so 31 August plus ten months could become 1 July instead of the intended
  end-of-June planning date.
- The audited constant-title upsert could reuse a completed AGM occurrence and
  its completion timestamp instead of creating a genuinely new recurrence.
- The repaired implementation now treats every governance date as an exact
  civil date and every generated deadline as a versioned occurrence with
  immutable completed/superseded history.

Required result:

- Define explicit Irish governance calendar semantics.
- Use safe month arithmetic with documented end-of-month behavior.
- Generate or reset a genuinely incomplete recurrence without erasing history.
- Make calculations timezone-independent.

Acceptance:

- Exact-date tests cover all month ends, leap years, DST/timezones, 31 August
  plus ten months, changed financial years, completed recurrences, duplicate
  prevention, and reminder visibility.

Repository remediation completed on 2026-07-10:

- Added shared strict `YYYY-MM-DD` civil-date parsing, formatting, comparison,
  day arithmetic, clamped month arithmetic, Europe/Dublin calendar extraction,
  Irish public-holiday calculation, and Companies Act working-day adjustment.
  All twelve month-end classes, leap/non-leap years, DST boundaries, and
  invalid dates are regression tested.
- Replaced title-based generation with source-input fingerprints, stable rule
  keys, rule/generation versions, explicit provenance, current/superseded links,
  and history-preserving reconciliation. A completed generated occurrence is
  never reopened; changed facts supersede it and create a new incomplete
  successor, while removed or unconfirmed facts supersede without inventing a
  replacement.
- Removed the unverified default `CLG` legal form. Company and CRO rules now
  require explicit confirmation; confirmation can be revoked through the UI,
  which supersedes affected current occurrences. Chronology, future-event,
  contradiction, and derivation-safe-range checks fail closed.
- Implemented source-cited planning calculations for the charity annual report,
  CLG financial statements, AGM/member action, and CRO annual return. The
  charity rule follows section 52's ten-month period; company statements follow
  section 341's nine-month period; AGM planning reflects sections 175 and 1202;
  and CRO planning uses the confirmed ARD plus the section 343 filing window.
  Companies Act dates apply section 3 weekend/public-holiday adjustment.
- Labels month-end clamping and the sole-member written-resolution twelve-month
  review cadence as internal planning conventions rather than statutory claims.
  Legal/accounting professional approval remains external and no generated date
  is presented as legal advice or certification.
- Manual deadlines now use history-preserving archive, deliberate reopen, and a
  `scheduleVersion` that advances only when reminder occurrence identity changes.
  Generated deadlines are immutable except for one-way atomic completion.
- Reminder selection pages through every current eligible deadline and delivers
  separately to every verified owner. It revalidates the exact recipient,
  subscription, occurrence, schedule version, due date, and reminder window
  under a deterministic organisation-then-deadline lock order before reserving.
- Reminder logs are immutable per-attempt occurrence records with explicit
  `RESERVED`, `SENDING`, `SENT`, `FAILED`, `SKIPPED`, and `UNCERTAIN` states.
  Post-cutover `SENT` requires a substantive unique provider acceptance id;
  bare booleans, malformed responses, crashes, timeouts, 409s, 5xxs, and unknown
  SDK shapes fail closed as `UNCERTAIN`. Active uniqueness includes recipient,
  window, and schedule version. Every retry is a fresh row with a new token and
  attempt-scoped Resend key.
- Pre-provider rereading narrows, but does not falsely claim to eliminate, the
  non-atomic boundary between database state and first external provider I/O.
  A durable `SENDING` transition occurs before I/O, so a crash after possible
  acceptance becomes `UNCERTAIN` rather than retryable. Unresolved ambiguity
  alerts on every run. Restricted one-time reconciliation records immutable
  actor/time/reference evidence: provider acceptance or an unknowable outcome
  continues suppression, while only conclusive proof that the provider never
  accepted/created the original message permits a fresh later attempt. Bounce
  or inbox-delivery failure never qualifies as provider non-acceptance.
- The deadline/reminder UI now separates current, generated history, and
  admin-only reminder delivery history; exposes source/provenance and exact
  civil dates; paginates through all current/history rows; explains and confirms
  one-way generated completion; supports manual reopen; surfaces uncertain
  reminder outcomes; and truthfully labels legacy completions whose date was
  never recorded.
- Organisation and manual-deadline writes are version-bound to `updatedAt`, so
  stale browser tabs receive a conflict instead of overwriting newer legal-form,
  calendar, completion, reminder, or archive state.
- The upgrade migration fails closed on non-midnight/out-of-range civil dates,
  deadline/user tenant mismatches, ambiguous/duplicate/renamed generated rows,
  legacy AGM delivery evidence, and deterministic generated-id collision. Exact
  current annual occurrences are promoted in place with id/completion/log
  identity preserved; genuine prior-year rows remain archived evidence. Every
  legacy `SENT`/`FAILED`/`SKIPPED` claim becomes `UNCERTAIN`, with no fabricated
  provider start, acceptance id, or exact email snapshot; only the original
  unverified status/timestamp survive in explicit legacy fields.
- The production cutover now fully quiesces the old runtime, protects and
  restore-verifies a unique off-repository backup, migrates and probes history in
  isolation, releases residual pre-I/O reservations, quarantines interrupted
  provider I/O, and blocks runtime start until ambiguity is reconciled. The
  scheduler waits for active work inside a bounded grace period. Cross-boundary
  rollback can skip the P0-06 gate only through a fresh exact-backup-bound restore
  attestation, never an env marker. A real PostgreSQL 16 historical-upgrade
  fixture covers eleven fail-closed scenarios and runs before fresh migration in
  both CI and release-image publication.

Current local verification:

- Full API, web, and shared suites pass at `545 / 545`, `313 / 313`, and
  `35 / 35` respectively.
- Prisma schema validation passes. Static migration tests cover exact-date
  conversion, removal of the unverified CLG default, generated-history
  retention, lifecycle constraints, clamped backfill fingerprints, and reminder
  state conversion.
- Disposable PostgreSQL 16 verification passed both from zero and as an upgrade
  through all 15 migrations. It proved the delivery-state check constraint,
  current-profile uniqueness after completion, active-reminder uniqueness, and
  concurrent claim behavior.
- A live non-UTC PostgreSQL session (`America/Los_Angeles`) exposed and then
  verified the repair of a final boundary bug: the row-lock predicate now binds
  the civil ISO string directly, so stored, bound, and snapshotted
  `2030-01-15` remain identical. Both organisation/deadline lock arrival orders
  completed without deadlock.
- `git diff --check` and the focused deadline/calendar/reminder suites pass.
- Root lint and all workspace production builds pass. Production tooling is
  `544 / 544`, local-Docker contracts are `44 / 44`, the managed E2E safety
  contract is `113 / 113`, secret/SAST scans pass across `545` staged files, and both
  production-only and full dependency audits report zero vulnerabilities.
- Focused managed browser regressions passed for the Organisation light-theme
  accessibility defect, the migrated-profile conditional-save defect, and the
  irreversible generated-completion confirmation.
- The complete managed `npm run test:e2e` gate then passed `113 / 113`
  isolation contracts and `97 / 97` Playwright tests against the runner-owned
  disposable PostgreSQL stack. Verified teardown left no runner residue or
  personal-stack drift.
- The unified reliability report is green with `396 / 396` covered guarantees
  linked to passing tests, and the generated platform audit is current.

Published exact-SHA verification:

- Commit `8474ab1d8b44e016f4782bf5c99302509cbd692f` contains the complete
  deadline-calendar, lifecycle, reminder, migration, cutover, UI, and evidence
  implementation. Follow-up test-contract corrections are included in final
  verification SHA `096619cf3ee84ae7d3f62826b3510af388defd85`.
- GitHub CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29136095002`
  completed successfully for that final SHA, including the historical
  PostgreSQL upgrade fixture, fresh migration, root tests, reliability,
  local-Docker, production builds/images/smokes, security, and dependency audit.
- GitHub E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29136095004`
  completed successfully for the same SHA with `97 / 97` ordinary Playwright
  passes in `3.2m`, no flaky tests, and the managed runner's verified teardown.

Primary-source basis:

- Charities Act 2009, section 52:
  `https://revisedacts.lawreform.ie/eli/2009/act/6/section/52/revised/en/html`.
- Companies Act 2014, sections 3, 175, 341, 343 and 1202:
  `https://revisedacts.lawreform.ie/eli/2014/act/38/revised/en/html`.
- CRO annual-return filing guidance:
  `https://cro.ie/Annual-Return/Filing-an-Annual-Return/`.
- Organisation of Working Time Act 1997, Schedule 2, plus S.I. 50/2022 for the
  current public-holiday set:
  `https://www.irishstatutebook.ie/eli/1997/act/20/schedule/2/enacted/en/html`
  and `https://www.irishstatutebook.ie/eli/2022/si/50/made/en/print`.

External production verification:

- Named Irish legal/governance and accounting reviewers must approve the rule
  interpretation and user-facing framing before production launch; that is
  professional launch evidence, not repository work.

### P0-07 - Team offboarding, session revocation, and ownership continuity

Status: `CI_VERIFIED`

Implemented:

- Team members now have explicit active/suspended/removed lifecycle state,
  optimistic membership versions, suspension/removal/reactivation operations,
  role changes, immediate session revocation, last-owner protection, and a
  serializable ownership-transfer path with bounded conflict retry.
- Session security exposes only bounded, non-reversible family summaries. It
  supports tenant- and version-bound single-family/all-family revocation and
  uses ordered organisation -> user -> token-family row locks. Refresh creates
  one same-family successor; replay quarantines only the affected family, and
  logout racing refresh revokes any successor before it can survive.
- Invitation acceptance rechecks organisation lifecycle and subscription
  access inside the consumption transaction. Expired trials, past-due outside
  grace, cancelled, expired, suspended, and otherwise inactive states fail
  without consuming the invitation or creating a user; active and in-grace
  states remain valid.
- Ownership transfer and the restricted offline recovery job both interlock
  with durable Checkout/Portal authority grants. Only the exact provider-start
  compare-and-swap winner can create a capability, ambiguous provider-started
  authority cannot be request-locally released, and reconciliation is explicit
  and evidence-bound.
- Immutable security audit rows retain bounded subject-label snapshots after a
  rename or soft removal. Database constraints enforce lifecycle, family,
  ownership, grant, evidence, and tenant invariants, and both P0-07 migrations
  own explicit atomic transaction boundaries.
- Emergency ownership recovery is an offline, dry-run-first command with exact
  target/evidence confirmation; it is not exposed through an HTTP route.

Local verification:

- Full suites: API `658 / 658`, web `335 / 335`, and shared `40 / 40`.
- Production tooling `545 / 545`; local-Docker tooling `44 / 44`; secret and
  SAST scans passed across `576` files; Prisma schema validation and web lint
  passed.
- The live PostgreSQL P0-07 upgrade fixture applied the historical boundary and
  passed lifecycle, owner, session-family, tenant, immutable-audit, and atomic
  fail-closed rollback probes, including truncation-bound label canonicalization.
- The reliability ledger is green: `415` guarantees, `395 / 395` covered links,
  and `20` explicitly not-applicable rows. Its family-rotation wording matches
  the implemented affected-family-only quarantine.
- The managed logout-vs-refresh race passed `113 / 113` isolation contracts,
  all `18` migrations, and `1 / 1` real Playwright scenario with exact-project
  teardown. Team and billing-authority scenarios also passed in the combined
  managed stack.
- A fresh current-tree managed document run passed the same `113 / 113`
  contracts, production build, all `18` migrations, and the real upload then
  authenticated-download journey `1 / 1`; post-run proof found zero processes,
  containers, volumes, networks, runner images, or recovery directories.

CI evidence:

- Implementation commit `6fb1bdd29bb862dd43558d4fc09bc7c03f5d68a8`
  plus CI-repair commit `1970995d00d8981f0a0d352ac535f092b4e3b51e`
  passed exact-SHA GitHub CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29146063800`
  and managed E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29146063808`.
  The latter passed `113 / 113` isolation contracts and `103 / 103` Playwright
  scenarios in `3.4m`.
- Production/provider evidence remains governed by the separate launch ledger
  and must not be fabricated.

### P0-08 - Product, legal, pricing, role, reminder, retention, and privacy truth

Status: `IN_PROGRESS`

Baseline contradictions, with remediation state recorded below:

1. Terms promise full Complete-plan trial access, while registration creates
   `ESSENTIALS` in `apps/api/src/services/auth.service.ts:105-112`.
2. Pricing CTAs do not carry a selected plan into registration.
3. Member-role copy says Members can maintain governance records, while most
   mutations require Owner/Admin and the UI still exposes failing controls.
4. Resolved by P0-06 (`CI_VERIFIED`): reminder scheduling and user-facing copy
   use 30/14/7 days, and immutable reminder-delivery history is available
   through the API and UI with fail-closed provider-outcome handling.
5. Terms promise expired-trial suspension and deletion after 30 days, but no
   account-expiry deletion workflow exists.
6. Privacy promises deletion within 30 days of closure without an implemented
   closure/deletion workflow or approved retention schedule.
7. Cookie consent only stores `accepted`/`declined`, controls no analytics, has
   no version/expiry, and cannot be reopened despite the published promise.
8. Privacy copy says Supabase provides database hosting and authentication,
   while CharityPilot uses custom auth and separate PostgreSQL/Supabase Storage
   responsibilities.
9. Privacy copy says CharityPilot stores card last-four and billing name, but
   the schema does not.
10. Buying surfaces show EUR19/EUR39 without the Terms' `exclusive of VAT`
    qualification.
11. Support, privacy, deletion, and legal-entity contact claims require verified
    operational mailboxes and professional approval.

Required result:

- Decide and document the intended product behavior with the user when the
  choice is material.
- Align implementation, API contracts, UI affordances, tests, marketing, Terms,
  Privacy, and provider configuration.
- Do not resolve a contradiction merely by hiding a broken control when a
  promised paid capability is intended.
- Keep professional legal/privacy/accounting approval external.

Acceptance:

- Contract and browser tests cover each promise.
- Privacy notices reflect actual processing, providers, retention, and rights
  workflows.
- Pricing surfaces disclose VAT treatment consistently.
- Role-based UI affordances match server enforcement on every route.

Repository progress on 2026-07-11:

- Role/member authorization sub-slice: `CI_VERIFIED`. `OWNER` and `ADMIN`
  remain the governance mutation roles. `MEMBER` retains legitimate reads,
  navigation, authenticated document downloads, and export access while mutation
  controls are hidden or read-only across Team, Board, Documents, Compliance,
  Dashboard, Registers, Deadlines, Organisation, and Export.
- Exact `403` plus `FORBIDDEN` stale-role denials now fail closed in place:
  privileged modals, drafts, queues, and timers are cleared; persisted or
  canonical state is restored where required; authentication is refreshed; and
  the user is not redirected away from the current route.
- Privacy/cookie processing-truth sub-slice: `CI_VERIFIED`. The draft notice
  now reflects PostgreSQL through Prisma, custom authentication, private Supabase
  document storage only, the Stripe identifiers and subscription state actually
  stored, and the implemented Resend transactional-email purposes. It explicitly
  leaves the controller, legal bases, retention, rights workflow, production
  providers and regions, transfer safeguards, and contacts unapproved.
- The cookie UI is now an informational necessary-authentication-cookie notice,
  not invented analytics consent. Dismissal stores only a local acknowledgement
  and migrates the legacy accepted/declined values.
- Local proof passed web `351 / 351`, API `662 / 662`, shared `40 / 40`,
  production tooling `546 / 546`, local-Docker tooling `44 / 44`, web lint and
  production build, E2E typecheck, `113 / 113` isolation contracts, and `3 / 3`
  focused managed Playwright scenarios. The browser proof uses a real disposable
  `MEMBER`, real seeded trustee and document records, authenticated byte download,
  absence of privileged mutation requests, a live `ADMIN` to `MEMBER` demotion
  producing the real API denial, and rendered privacy/cookie assertions. Teardown
  left no managed E2E container residue.
- The complete managed gate then passed `113 / 113` isolation contracts and
  `105 / 105` Playwright scenarios locally without a flaky retry. Implementation
  commit `44ff57b596b0ac6b527a3f338bddc71a095ca2cc` plus final rate-limit and
  teardown repair SHA `42888a41e86bd7235891e82a18623208b921d773` passed exact-SHA
  GitHub CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29150323690`
  and E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29150323669`.
  The latter passed `113 / 113` runner contracts and `105 / 105` browser
  scenarios in `3.5m`, with the final disposable-database binding/reset proof
  succeeding after all browser traffic.
- Follow-up deterministic test-discovery and evidence SHA
  `2734dc167777765ceec297917940615f05770590` passed exact-SHA CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29150668596`
  and E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29150668600`.
  The main CI `Test` step itself discovered and passed web `351 / 351`, API
  `662 / 662`, and shared `40 / 40`; E2E passed `113 / 113` runner contracts and
  `105 / 105` browser scenarios in `3.7m`.

P0-08 remains `IN_PROGRESS`. Trial entitlement and selected-plan propagation,
expired-trial and account-closure deletion, the approved retention and rights
workflows, VAT treatment, final controller/provider/region/transfer/contact
claims, operational mailboxes, and professional legal, privacy, and accounting
approval remain unresolved. These require product, business, professional, or
external-provider decisions and evidence; they must not be inferred from passing
repository tests.

2026-09-29 local DPO-05 truth follow-up: destructive connector approval prompts
for six governance/deadline record types now describe active-record removal and
possible retained audit/backup copies. The Minute Book removal UI discloses its
retained full snapshot, actor email and reason without promising a permanent
retention period. The Confluence connection disclosure describes remote
delete/purge as an attempt and limits a current-page 404 check to that endpoint,
not versions or backups. API builds and 46 focused approval/connector plus 87
integration-route tests pass; edited Minute Book lint passes. This improves the
accuracy of future prompts and disclosures only. P0-08 remains `IN_PROGRESS`:
no controller-approved record schedule, full application erasure, backup-expiry
proof, reviewed-tenant validation or DPO sign-off follows from these changes.

### P0-09 - Executed browser assurance and repository/release protections

Status: `IN_PROGRESS`

Evidence:

- The audited baseline ran E2E only on pull requests or manually. P0-05 commit
  `e9f63038a5e8fe0c0680dcc015566dff2525a56b` now runs E2E on direct `master`
  pushes; GitHub E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29116192729`
  executed successfully for that exact SHA with `96 / 96` Playwright tests.
- The latest read-only GitHub refresh on 2026-07-12 found no `master` branch
  protection. One active ruleset protects immutable personal-release tags, but
  it does not govern `master`. The `Production` environment exists but allows
  admin bypass, has no protection rules/reviewers, and has no deployment branch
  policy.

Repository progress on 2026-07-11:

- Release-image promotion now calls the same reusable managed E2E workflow used
  on direct `master` pushes, and the publish job cannot start until that browser
  gate succeeds. The called gate has read-only repository permission; package
  and OIDC write authority is scoped only to the dependent publish job.
- `scripts/reliability-report.mjs` now reports `E2E linkage` and explicitly says
  `EXECUTED E2E: NOT VERIFIED BY THIS COMMAND`. Successful static linkage is
  `LINKAGE CHECK: COMPLETE`, never an overall browser `GREEN` result. The
  generated reliability ledger carries the same distinction.
- Local proof passed production tooling `548 / 548`; the regenerated linkage
  report executed API `660 / 660` and web `351 / 351`, found all `31` expected
  Playwright titles, and reported `395 / 395` covered-guarantee linkage complete
  without claiming that Playwright executed.
- Implementation SHA `62170e55ac3bafe6f7cdd105eace11faaeba5d2c` passed
  exact-SHA CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29151170819`
  and E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29151170810`.
  CI passed web `351 / 351`, API `662 / 662`, shared `40 / 40`, production
  tooling `548 / 548`, local-Docker tooling `44 / 44`, and the corrected
  reliability output (`660 / 660` API, `351 / 351` web, `395 / 395` linkage,
  `EXECUTED E2E: NOT VERIFIED BY THIS COMMAND`). Managed E2E passed `113 / 113`
  contracts and `105 / 105` browser scenarios in `3.5m`.
- This repository-only sub-slice is `CI_VERIFIED`. Overall P0-09 remains open
  for repository-owner-approved live branch/ruleset and Production-environment
  protections plus a controlled release-promotion run. No protection setting
  was silently enabled and no publishing workflow was triggered for test proof.

Required result:

- Preserve the now-proven direct-`master` managed E2E gate and its exact-SHA
  evidence; local results or static title linkage must never substitute for it.
- Run E2E on release promotion, or introduce a repository workflow that
  provides equivalent enforced evidence.
- Distinguish static title linkage from an executed result bound to a SHA.
- Prepare and validate branch/status-check and production-environment approval
  rules.
- Do not silently enable rules that would lock out the user's required
  direct-`master` workflow; activation is a repository-owner action unless
  explicitly authorised.

Acceptance:

- Reliability output cannot be `GREEN` solely from title linkage.
- Required browser gates execute for and bind to the final SHA.
- Protected release/evidence workflows have documented, live-enforced approval
  and branch rules.

### P0-10 - Complete backup and recovery for metadata and document bytes

Status: `IN_PROGRESS` overall; repository proof tooling is `LOCALLY_VERIFIED`

Evidence:

- PostgreSQL stores document metadata; Supabase Storage stores file bytes.
- The audit-baseline checklist/evidence wording could be satisfied by database backup/PITR
  language even though database backups exclude Storage objects.
- Audit-baseline production restore-sentinel instructions conflicted with the helper's remote
  safety guard.

Repository remediation on 2026-07-11:

- Production instructions and workflows now forbid sentinel writes and use a
  two-step, non-mutating database flow: independently capture the read-only
  source identity, then prove one snapshot-bound dump against an internally
  constructed network-isolated ephemeral restore target.
- The PostgreSQL proof binds every supported public schema descriptor (including
  routines, views, types/domains, constraints, indexes, trigger enabled state,
  and policy roles), table membership, counts, and all table rows within explicit
  source-workload bounds. Unsupported object kinds and sequence-backed identity
  state fail closed. Artifact descriptors, hashes, publication, owner-only
  storage, cleanup, redaction, and helper/checker canonical-hash compatibility
  are independently tested.
- Source encoding, collation, ctype, libc locale provider, and collation version
  are now fingerprinted. The isolated database is created from those source
  settings, and helper, checker, launch-evidence, CI, and release contracts all
  fail closed unless the source, restored, and restore-target environments match.
- The report explicitly excludes PostgreSQL role ownership, ACL/default
  privileges, and non-MVCC sequence runtime state; it cannot be used to claim
  those recovery controls or provider provenance.
- `scripts/generate-document-recovery-manifest.mjs` builds an owner-only,
  no-overwrite v1 manifest offline from four complete provider/operator exports.
  `scripts/verify-document-recovery.mjs` requires immutable independent source
  bindings and reconciles metadata plus object identities, keys, sizes, and
  SHA-256 values with zero missing, unexpected/orphan, or mismatched items.
  Sampling is forbidden; certification fails above 5,000 documents, 10 MiB per
  object, or a 16 MiB manifest pending a reviewed streaming/paginated v2.
- Launch evidence now requires both structured database proof and joint document
  recovery. The two exercises cross-bind only on `recoverySetId` and the exact
  database dump SHA-256; their deliberately different database-identity domains
  are not equated.
- A fresh adversarial disposable C-locale restore passed with source and restored
  environments both `UTF8 / C / C / libc`, explicit
  `databaseEnvironmentMatched=true`, source-driven target initialization, and
  proof-report SHA-256
  `d2d1c63842bad568fae76ae4af4a1e75d621d0a8ee79bc77e3d7cab985f50df1`.
  The temporary database, containers, and artifacts were removed. This is local
  implementation evidence, not production-provider or production-restore proof.
- Final-tree local verification includes `npm run test:production-check` at `745`
  passed / `0` failed / `2` Windows symbolic-link privilege skips (`747` total),
  database checker `32 / 32`, database helper `39` passed / `1` Windows skip,
  API production-environment validation `51 / 51`, and generated platform-audit
  freshness. Exact commit and CI evidence will be added after push.

Required result:

- Define separate encrypted/versioned object backup, retention, ownership,
  monitoring, and deletion behavior.
- Define RPO and RTO for both PostgreSQL and document bytes.
- Perform an isolated non-production joint restore and reconcile every restored
  metadata row to the expected object and checksum.
- Replace unsafe production-sentinel instructions with a controlled,
  auditable, non-destructive recovery proof.

Acceptance:

- Evidence validation requires both database and object recovery.
- A database-only restore cannot pass the document recovery gate.
- Restore target isolation, owner, date, recovery notes, reconciliation, and
  confirmation that production was not overwritten are recorded outside Git.

## P1: Security, Integrity, and Service Resilience

### P1-01 - Bcrypt input boundary

Status: `CI_VERIFIED`

- Register, login, reset-password, and accept-invite now share one browser-safe
  UTF-8 byte-length guard and reject inputs above bcrypt's 72-byte boundary
  before account lookup, token lookup, password hashing, or comparison.
- Shared tests cover exact 72/73-byte ASCII and multibyte boundaries, legacy
  complexity rules, non-string inputs, and two different passwords with the same
  first 72 bcrypt bytes; both over-boundary inputs are rejected. API route tests
  prove the boundary is wired before service/database work.
- Local proof passed shared `46 / 46`, focused API route `2 / 2`, API and web
  production builds, and reliability linkage `395 / 395`.
- Implementation SHA `e32520c55760d886bf4c2664daf8c3de861bd598` plus the
  exact-title linkage correction in verification SHA
  `21c7a52c4efa2a5f99d620a5eec7892b507e159f` passed CI run
  `29155302868` and managed E2E run `29155302860`.

Acceptance:

- Enforce a maximum of 72 **encoded bytes**, not characters, or use a carefully
  specified and reviewed pre-hash construction.
- Cover ASCII and Unicode boundary cases and ensure two passwords differing
  after byte 72 cannot authenticate as the same credential.

### P1-02 - Refresh-token race and token-family revocation

Status: `CI_VERIFIED`

- Refresh, replay, and logout use ordered organisation -> user -> token-family
  row locks. Successful rotation creates one same-family successor; replay or
  logout quarantines the affected family without revoking unrelated device
  families.
- API race/replay/family tests pass, and the managed concurrent
  logout-vs-refresh browser scenario passed with all `18` migrations and
  verified zero-residue teardown.
- Exact verification SHA `1970995d00d8981f0a0d352ac535f092b4e3b51e`
  passed CI run `29146063800` and all `103 / 103` scenarios in managed E2E run
  `29146063808`, including browser-origin logout plus original and returned
  successor access/refresh rejection.

### P1-03 - Inactive invitation acceptance

Status: `CI_VERIFIED`

- Invite consumption now transactionally rechecks lifecycle and subscription
  access after locking the invitation and organisation.
- Focused tests cover expired trial, past-due outside grace, cancelled, expired,
  active, and past-due inside grace. Every rejected state proves the invitation
  remains unconsumed and no user is created; suspension is covered by the
  concurrent inactive-organisation regression.
- Exact verification SHA `1970995d00d8981f0a0d352ac535f092b4e3b51e`
  passed CI run `29146063800` and managed E2E run `29146063808`.

### P1-04 - Document deletion retry lifecycle

Status: `LOCALLY_VERIFIED`; exact-SHA CI re-verification is pending after the
scheduled-job smoke assertion is refreshed for the expanded cleanup summary

- Add bounded attempts, exponential backoff, `nextAttemptAt`, terminal/dead-letter
  state, idempotency, alerting, and operator recovery.
- Prevent malformed or permanently forbidden objects from alerting hourly
  forever.
- Implementation is published through
  `8c573e3d0ea3729293201b32e14bafc7d4365ae0`. Managed E2E run
  `29159686871` passed; CI run `29159686841` reached the scheduled-job smoke and
  then failed only because its grep still expected the older cleanup summary.
  The updated workflow assertion is locally verified but must pass on the next
  exact pushed SHA before this item can become `CI_VERIFIED`.

### P1-05 - Sanitized root-cause diagnostics

Status: `CI_VERIFIED`

- Route-caught unexpected 5xx errors now emit one structured, sanitized local
  diagnostic before alert delivery is attempted, so a saturated, rejected, or
  failed alert transport cannot erase the original root cause.
- Production responses remain generic. Error messages, one-level causes, and
  structured code/status fields redact credentials, provider keys, bearer/JWT
  material, database URLs, emails, and storage paths; nested provider payloads
  and `AppError.details` are not logged.
- The duplicate billing-webhook direct error log was removed so the centralized
  sanitized diagnostic is authoritative. Focused diagnostics, alert/redaction,
  and adjacent degradation tests passed `21 / 21`, and the full API suite
  passed `664 / 664` before publication.
- Exact verification SHA `e4e45f68fb3b54f7447042918f3fe4ee3bd25dc2`
  passed CI run `29155835494` and managed E2E run `29155835492`.

- Route-caught unexpected 5xx errors must log the original sanitized diagnostic
  even when alert delivery fails.
- Keep client responses generic and prove secrets/provider payloads are redacted.

### P1-06 - Graceful scheduler shutdown

Status: `CI_VERIFIED`

- `apps/api/src/jobs/production-scheduler.ts` tracks the active job, stops the
  interval before shutdown, waits within the configured bounded grace window,
  reports a timed-out active job as a failure, and disconnects Prisma for both
  `SIGTERM` and `SIGINT`.
- `apps/api/src/tests/production-scheduler.test.ts` covers normal stop, waiting
  for an in-flight run, and timeout behavior.
- Implementation commit `8474ab1d8b44e016f4782bf5c99302509cbd692f` is included
  in exact verification SHA `096619cf3ee84ae7d3f62826b3510af388defd85`, which
  passed CI run `29136095002` and managed E2E run `29136095004`.

Acceptance:

- Track in-flight reminder and cleanup jobs.
- On SIGTERM/SIGINT, stop scheduling, await active work within a bounded timeout,
  then disconnect Prisma and exit with an actionable status.

### P1-07 - MFA, session management, and recovery

Status: `IN_PROGRESS` overall; P1-07A password-recovery integrity is
`CI_VERIFIED`

- Add MFA suitable for privileged users, session inventory, per-session and
  all-session revocation, breached-password controls, ownership recovery, and
  appropriate audit events.
- Treat recovery as a security-sensitive workflow with rate limits and explicit
  human/business policy.

P1-07A repository remediation on 2026-07-12:

- Replaced the mutable `User` reset slot and process-local-only recovery limit
  with a bounded `PasswordRecoveryRequest` ledger, database-backed
  domain-separated keyed identifier/network budgets, and up to three concurrent
  usable one-hour links. Unknown, inactive, suppressed, provider-rejected, and
  provider-uncertain requests keep the same neutral public response and do not retain the
  submitted unknown-account address or raw caller/network/token values.
- Added a durable versioned Resend worker and separate reset-completion outbox.
  Provider timeouts and ambiguous acceptance quarantine work as `UNCERTAIN`;
  retries reuse immutable row inputs and a version-bound idempotency key rather
  than minting a new capability. Review-worthy anomalies have durable count-only
  claims and cannot age out before alert acknowledgement.
- A successful reset now changes the password, terminates every outstanding
  link, revokes every active session, appends predecessor-compatible immutable
  audit evidence, and queues the registered-address notice in one ordered
  transaction. Live two-client proofs cover concurrent reset and login/reset
  races.
- `AUTH_RECOVERY_SECRET` is bound to a singleton database generation fence and
  append-only retired-fingerprint history. The quiesced operator workflow
  invalidates capabilities and keyed evidence before replacement, blocks
  recovery between phases, and rejects every historically retired secret.
- Migration `20260712013000_add_password_recovery_integrity` preserves each
  valid active legacy slot exactly once, clears inactive legacy slots without
  creating recovery evidence, fails closed on active account emails longer than
  254 characters, retires both legacy `User` fields, and installs the durable
  transition/retention/authority guards. Ordinary deploys now use
  `CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1`; P1-09 is a
  restore-only rollback boundary requiring an exact pre-P1-07A backup plus the
  checksum-bound read-only restored-history/P1-07A-absence probe before backup
  or migration.
- Final local verification passed shared `55 / 55`, API `810 / 810` plus four isolated
  real-PostgreSQL proofs `4 / 4`, web `371 / 371`, production tooling `827`
  passed / `0` failed / `2` expected Windows symbolic-link privilege skips
  (`829` total), personal-server `24 / 24`, local-Docker `45 / 45`, and the final
  local managed disposable E2E gate: runner contracts `113 / 113` plus browser
  scenarios `105 / 105` in `7.6m`, followed by clean isolated teardown. Lint,
  E2E typecheck, Prisma validation,
  shared/API/web optimized builds, secret/SAST scans, the production image
  dependency audit, reliability `395 / 395`, historical migration verifiers,
  built-image recovery/rollback probes, and launch-evidence contracts passed.
- The local managed browser rerun is complete. Implementation commit
  `1e639c89b49ce5ed27a8ea3b887ef140c7f142b5` first reached CI run
  `29184769464`, which failed only at the fresh scheduled-job image smoke's
  recovery binding; managed E2E run `29184769502` passed. The follow-up repaired
  CI/release setup, and a local built-image replay passed
  `migrate -> bind -> scheduler` with zero residue.
- Exact final verification SHA
  `b2138acfe0b7b7a9127a14667f10a771982a0e3b` passed GitHub CI run
  `29185333589` in `8m24s`, including the repaired scheduled-job image smoke.
  Managed E2E run `29185333588` passed in `6m41s` with `105 / 105` browser
  scenarios. P1-07A is therefore `CI_VERIFIED`; this does not claim deployment,
  production-provider evidence, MFA/breached-password/ownership-recovery policy,
  or any legal or human approval.

Remaining under the parent P1-07 item:

- review and enforcement policy for the locally implemented opt-in charity-user MFA, plus live migration and browser/connector verification;
- breached-password source and outage/fail-open/fail-closed policy; and
- the remaining reviewed account/ownership-recovery policy and human authority
  decisions. P1-07A must not be used to claim those product decisions are closed.

### P1-08 - Immutable governance audit history

Status: `CI_VERIFIED`

- `ComplianceApprovalSnapshot` stores append-only, revision-bound approval
  payloads with evidence and snapshot SHA-256 hashes; current approval points to
  a preserved snapshot rather than rewriting the approved history.
- Canonicalization, integrity verification, concurrency, migration, service, and
  export tests prove later edits cannot silently mutate the approval evidence
  used for board/regulator output.
- Exact implementation SHA `e03b80a44150c384485b5e47e524b9ee60475f70`
  passed CI run `29082113651`.

Acceptance:

- Extend P0-04 beyond the mutable activity feed.
- Preserve who changed what, when, from which approved revision, and why.
- Ensure deletion or later edits cannot erase the history used for board and
  regulator evidence.

### P1-09 - Domain invariants and referential safety

Status: `CI_VERIFIED`

Implemented:

- Shared create, patch, and complete-state validators now reject reversed board
  terms, contradictory conduct/induction completion evidence, reversed closed
  fundraising periods, and `FILED` annual-report states without a filing date.
  One-sided patches deliberately defer the final decision until the API merges
  them with the persisted row. Board and register forms apply the same rules,
  expose accessible conditional date requirements, preserve valid open-ended
  fundraising periods, and show safe API errors without discarding the draft.
- Board, conflict, fundraising, and annual-readiness writes now acquire the
  organisation row before reading or changing dependent state. Services merge
  and validate the complete state inside the transaction, map only the exact
  known constraint/race contracts, and leave unrelated database failures
  visible to the existing root-cause handling. Board deletion transactionally
  detaches same-tenant conflict pointers so immutable conflict history survives;
  the composite relation prevents cross-tenant pointers.
- Migration `20260711230000_add_domain_invariants_referential_safety` is one
  atomic, no-row-rewrite change. It preflights all six invalid-data categories,
  installs five named `CHECK` constraints, adds the board-member composite key,
  and replaces the conflict pointer with a restrictive tenant-scoped composite
  foreign key and index. The migration locks writers in application-compatible
  order and fails with exact remediation counts rather than inventing repairs.
- CI and release publication run a historical 19-migration upgrade verifier.
  It proves invalid legacy data fails atomically, Prisma records one unresolved
  target attempt, a plain retry fails with `P3009`, deliberate fixture
  remediation leaves no target residue, exact resolution/redeploy succeeds, and
  catalog, history, tenant relation, data, and edge behavior are correct. Every
  disposable database is uniquely named, bounded, force-cleaned, and checked for
  residue.
- At the P1-09 exact verification SHA, ordinary deploy and recovery required
  `CHARITYPILOT_DATABASE_COMPATIBILITY=p109-governance-integrity-v1`; only the
  separately attested historical rollback paths can select the older modelled
  compatibility lines. The owner-only recovery wrapper binds a fresh attestation
  to the exact env bytes and digest-pinned migration image, hashes all 20
  migration SQL files inside that image, compares every Prisma history checksum,
  requires the exact failed-history/catalog/data state, and holds the cutover
  lock through exact resolution and immediate full redeploy. Its repeatable-read,
  read-only SQL ends at the invariant `DO` block so Prisma cannot mask an error
  with a later successful transaction statement.

Local verification:

- Shared `54 / 54`, API `749 / 749` plus isolated two-client PostgreSQL `2 / 2`,
  and web `369 / 369` pass. The production build, lint, Prisma validation,
  secret scan, and SAST scan pass.
- Production tooling passes `791` checks with `0` failures and `2` expected
  Windows symbolic-link privilege skips (`793` total); local-Docker contracts
  pass `44 / 44`, and the rebased personal-server contracts pass `21 / 21`.
- The exact built migration image proof captured all 20 checksums. The failed
  target deploy and `P3009` retry returned nonzero; a deliberately tampered
  target checksum made image `db execute --stdin` return nonzero with the exact
  selected-image invariant; the pristine preflight, exact rolled-back resolve,
  redeploy, and final migration status returned zero. The complete before/after
  logical fingerprint was identical, all recovered assertions passed, and final
  database/container inventory was empty.
- Implementation commit `c71481791b6716a06818c341d130fe25d7f32b7b`, the
  adjacent Windows personal-server fixture parser repair
  `3aba948962cbacf075d018564385acf972cb7dc5`, and the rebased evidence refresh
  produced exact verification SHA `812b9ff83e0407146e50a2dd0e87fea05561addb`.
  GitHub CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29168177797`
  and managed E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29168177757`
  both passed for that SHA. E2E passed `113 / 113` runner contracts and
  `105 / 105` browser scenarios in `3.6m`.
Original audit acceptance wording retained from the stashed 2026-07-11 working
snapshot:

- Prevent board term end before appointment, fundraising end before start,
  contradictory induction/conduct booleans and dates, and `FILED` states without
  filing dates.
- Add database constraints where safe and shared/API validation everywhere.

## P2: Release Engineering and Production Operations

### P2-01 - Supported stable dependency posture

- Replace `next@16.3.0-canary.14` with a supported stable release using official
  migration guidance.
- Test proxy/auth behavior, CSP, SSR, Docker, static generation, and every route.
- Keep unrelated major upgrades in separately verified slices.

### P2-02 - Meaningful coverage gates

- Add statement/branch/function coverage with justified thresholds and critical
  module minimums.
- Do not game coverage with broad exclusions or substitute coverage for
  behavior-focused tests.

### P2-03 - Security scanning depth

- Add history-aware secret scanning, GitHub secret scanning/push protection,
  Dependabot/security updates, CodeQL/Semgrep or equivalent, container scanning,
  SBOM generation, and provenance/attestation verification.
- Include safe tests/fixtures without allowing fixture secrets to hide real
  issues.

### P2-04 - Migration-aware rollback

- Adopt expand/contract schema discipline.
- Test previous-application/new-schema compatibility, backup prerequisites,
  roll-forward, and rollback.
- Image rollback alone must not claim database rollback readiness.

### P2-05 - Container and host hardening

- Add appropriate CPU/memory constraints, health behavior, Docker log rotation,
  disk monitoring, and durable capacity guidance.
- Pin the Caddy image immutably like application images.
- Harden host provisioning, SSH exposure, patching, and operational ownership.

### P2-06 - Observability and incident operations

- Define RPO, RTO, SLOs, severity levels, metrics, traces where useful,
  scheduler heartbeat, alert ownership, escalation, communications, and
  postmortems.
- Validate the documented alert provider payload. Slack incoming webhooks, for
  example, require a compatible message body rather than arbitrary structured
  JSON.
- Capture meaningful client errors outside browser console-only logging while
  protecting sensitive data.

### P2-07 - Durable release and rollback artifacts

- Preserve digest manifests as durable release assets rather than relying only
  on a 90-day workflow artifact.
- Bind release, rollback, evidence, and final signoff to the same immutable
  identity.

### P2-08 - Protected-route indexing posture

- Add appropriate route metadata/headers for protected application surfaces.
- Correct `robots` coverage, while documenting that robots directives are not
  access control.

### P2-09 - Scale and retention hygiene

- Purge expired/revoked auth sessions and old processed Stripe webhook events
  under an approved retention policy.
- Paginate Complete-register and export-heavy queries where necessary.
- Avoid loading every incomplete deadline into memory before filtering.

### P2-10 - Database tenant-isolation defence in depth

- Assess PostgreSQL RLS and composite cross-tenant foreign keys for high-value
  tables.
- Implement safe database backstops where practical without weakening the
  existing application-layer tenant tests.
- Any deferral requires explicit human risk acceptance, not agent self-approval.

### P2-11 - Uploaded-file defence in depth

- Validate OOXML package structure rather than ZIP magic alone.
- Define malware scanning/quarantine behavior and failure handling appropriate
  to governance documents.
- Keep files private and never parse untrusted content in the application
  process without isolation.

### P2-12 - Production restore evidence consistency

Status: `LOCALLY_VERIFIED` for the repository contract; external proof remains under
P0-10

- Sentinel-based production instructions have been removed. The canonical flow
  is the independently bound `source-identity` plus `prove-restore` database
  check and the separate joint document-recovery manifest/verifier described in
  P0-10.
- Workflow, runbook, launch-status, generated-audit, checker JSON, and launch
  evidence contracts now share the same commands, exclusions, recovery-set/dump
  cross-bindings, and no-production-write semantics.

- Reconcile the runbook's sentinel requirement with the helper's remote safety
  guard.
- Use representative, controlled proof that does not require unsafe synthetic
  writes to production.

## P3: Product, Accessibility, and Documentation Polish

### P3-01 - Organisation unsaved-navigation protection

- Guard in-app Next navigation, not only `beforeunload`.
- Reuse the compliance navigation-confirmation pattern and cover keyboard,
  sidebar, browser-back, save, discard, and retry behavior.

### P3-02 - Reliable authenticated downloads

Status: `CI_VERIFIED`

- The browser now fetches the exact authenticated CharityPilot API document
  route as bytes; it does not wait for or navigate to a provider-signed URL.
- URL trust accepts only the expected CharityPilot API origin and exact document
  download route, with an exact marker-bound loopback origin only inside the
  disposable production-build E2E runner. Lookalike markers, localhost aliases,
  alternate ports, queries, Supabase origins, and signed storage paths are
  explicitly rejected.
- The API streams private bytes only after tenant/session checks, revalidates the
  session after storage I/O, applies a bounded storage/body timeout, and never
  returns the internal object key or a reusable provider capability.
- API `658 / 658` and web `335 / 335` pass. The fresh managed document journey
  passed `113 / 113` isolation contracts, the production build, all `18`
  migrations, and upload/download `1 / 1`, followed by zero-residue teardown.
- Exact verification SHA `1970995d00d8981f0a0d352ac535f092b4e3b51e`
  passed CI run `29146063800` and managed E2E run `29146063808`; the latter
  completed `103 / 103` scenarios in `3.4m`.
- Deployed WebKit/Safari click-journey evidence remains part of the external
  browser QA gate.

### P3-03 - Cookie preference lifecycle

Status: `CI_VERIFIED` for the current essential-only processing posture

- The application currently has no page-view analytics, advertising cookies, or
  optional-cookie processing. The former consent UI was replaced with an
  informational essential-cookie notice: it offers no misleading `Accept All`
  control and stores only a local acknowledgement preference.
- Source-truth and managed browser tests fail if optional analytics claims or
  consent controls reappear without an implemented processing purpose.
- Implementation commit `44ff57b596b0ac6b527a3f338bddc71a095ca2cc` is included
  in exact verification SHA `42888a41e86bd7235891e82a18623208b921d773`, which
  passed CI run `29150323690` and managed E2E run `29150323669`.
- A persistent settings/reopen lifecycle is not applicable while there is no
  optional processing decision to change. Introducing any non-essential cookie
  reopens this item and requires an approved, versioned consent-and-withdrawal
  mechanism before that processing is enabled.

Acceptance:

- Add a persistent, accessible reopen/settings control.
- Version and expire consent appropriately.
- Wire the decision to actual optional processing, or remove claims and controls
  for analytics that do not exist.

### P3-04 - Short-height dashboard navigation

- Make the sidebar/nav vertically scrollable without hiding lower links beneath
  the footer.
- Test landscape mobile, zoom, large text, and reduced viewport height.

### P3-05 - Complete filter semantics

- Make blog category filters ordinary pressed buttons or implement the full tabs
  pattern with tabpanel association, roving focus, and arrow-key behavior.

### P3-06 - Meaningful auth-page titles

- Give Login, Register, Forgot Password, Reset Password, Verify Email, and Accept
  Invite distinct document titles.

### P3-07 - Accessibility test depth

- Review the accessibility suite's filtering of moderate findings.
- Add justified severity handling, keyboard tests, focus-order checks, zoom/large
  text, short-height layouts, and visual regression coverage.

### P3-08 - Documentation drift

- Refresh `docs/RELIABILITY.md` so linked E2E titles are not described as
  executed evidence.
- Refresh `docs/DEPENDENCIES.md` from the current lockfile and remove frozen-SHA
  assumptions.
- Refresh `docs/SECURITY-REVIEW.md` after the remediation/security pass while
  retaining its internal-review limitation.
- Keep the continuation handoff, production TODO, platform audit, launch guide,
  runbook, and checklist mutually consistent.

### P3-09 - Dead configuration requirements

- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is currently required by production
  validation but not consumed or built into the web application.
- Either deliberately wire a justified client-side use or remove the dead
  requirement from templates, validators, docs, and evidence tooling.

### P3-10 - Full state and responsive recheck

- After relevant changes, recheck every route across loading, empty, error,
  denied, locked, disabled, slow-provider, success, mobile, desktop, light, dark,
  keyboard, and screen-reader-relevant states.

## Separate private personal-server operating profile

This audit continues to govern the future public/commercial launch. A separate
`personal-server` profile was added on 2026-07-11 for the user's immediate
single-charity Windows use; it must not be counted as remediation closure for a
public-production issue or launch-evidence slot.

Status: `LOCAL_CONTRACT_VERIFIED`, not live-deployment or public-launch proof.

- Caddy is the only loopback-published web front door; it routes one browser
  origin to the compiled Next.js and Fastify services.
- The fixed Docker gateway/Caddy addresses define the trusted proxy chain;
  private HTTPS redirects, CSP and refresh-origin validation stay bound to the
  configured public origin, and internal health probes use `/login` without
  following the public redirect.
- PostgreSQL/documents use isolated personal-server volumes; the development,
  E2E and public-production stores are not reused.
- One-shot initialization, provider-free private auth/invitations, safe account
  reset links, lifecycle operations and paired database/document backup tooling
  are implemented.
- `726 / 726` API, `363 / 363` web and `21 / 21` personal profile contracts
  passed, alongside all three Compose config renders and lint.
- Native public/personal optimized web builds passed and Docker exported the
  migration/API images. Web-image export exceeded a 15-minute local bound on a
  loaded Docker Desktop host, so live image/runtime certification remains open;
  the installer now builds targets sequentially.
- A separate actual-Caddy validation attempt was blocked by a transient Docker
  registry blob-download `EOF`; static Caddy/trusted-proxy contracts passed, so
  binary validation remains part of real initialization rather than claimed
  local evidence.
- No real personal-server initialization, second-device Tailscale test,
  off-host encrypted backup or full application restore rehearsal has yet been
  claimed.

The authoritative operating runbook is
`docs/personal-server-deployment.md`. Do not weaken organisation scoping or the
strict public validator to simplify this adapter. A later VM migration should
move the same schema/data through a verified recovery set and then satisfy this
audit's public-production gates independently.

## External and Repository-Owner Blockers

These must remain visible and must not cause an autonomous session to stop while
other safe repo work exists.

Live blocker refresh from the checked workstation and GitHub on 2026-07-12:

- The ignored `.env.production` still has 18 counted provider/hosting/image
  values needing real data. It also predates P1-07A and lacks the separately
  required `AUTH_RECOVERY_SECRET` and
  `CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1`; those two
  prerequisites are not included in the 18-value launch-status count.
- Missing GitHub production secret names:
  - `AUTH_RECOVERY_SECRET`;
  - `DATABASE_URL`;
  - `STRIPE_SECRET_KEY`;
  - `STRIPE_WEBHOOK_SECRET`;
  - `RESEND_API_KEY`;
  - `SUPABASE_SERVICE_ROLE_KEY`;
  - `ERROR_ALERT_WEBHOOK_URL`.
- Unresolved `app.charitypilot.ie` and `api.charitypilot.ie` DNS/HTTPS.
- No complete release binding or current promoted image set.
- `master` has no branch protection. The GitHub `production` environment still
  permits administrator bypass and has no protection rules or deployment branch
  policy. The separate immutable personal-release tag ruleset does not close
  those public-production gates.
- Live PostgreSQL, Supabase, Stripe, Resend, hosting, DNS/TLS, and observability
  setup/evidence.
- Digest-pinned production deployment and rollback rehearsal.
- Deployed responsive, accessibility, Chromium, Firefox, WebKit, and real/cloud
  iOS Safari QA.
- Full PostgreSQL plus document-object backup/restore drill.
- Solicitor, governance, privacy, and accounting review.
- External penetration test and remediation/retest or formal human acceptance.
- Engineering, operations, security, legal/compliance, and business signoffs.

When blocked, record the exact missing input, accountable owner, risk, required
evidence, and safe next command, then continue with the next repo-owned item.

## Autonomous Execution Loop

Repeat this loop until all repo-side work is complete or only genuine external
blockers remain:

1. Read `AGENTS.md`, `docs/agent-continuation-handoff.md`, and this document in
   full.
2. Refresh Git, launch, generated audit, and CI state.
3. Select the highest-priority unblocked issue, respecting dependencies.
4. Reproduce it or prove the gap with a focused failing test or concrete
   evidence.
5. Implement the smallest complete production-quality repair, including schema,
   migration, API, UI, accessibility, logging, tests, docs, and runbook changes
   that belong to that slice.
6. Run focused verification, then proportionate wider gates.
7. Review the diff for tenant isolation, authorization, data integrity,
   security, accessibility, product truth, failure handling, and unrelated user
   changes.
8. Update this ledger and the continuation handoff with exact evidence.
9. Stage only explicit files or hunks and inspect `git diff --cached`.
10. Commit the coherent verified slice to `master`, push to `origin/master`, and
    watch the resulting CI to completion.
11. Diagnose and repair failures before claiming the slice.
12. Immediately select the next item and repeat.

**Do not stop after one fix, one commit, one green suite, a plan, or a progress
summary. Continue while any safe in-scope repository work remains.**

Ask only when the missing decision would make the next action destructive,
irreversible, externally visible, legally substantive, or materially change
product policy. Otherwise make the safest reasonable assumption, document it,
and continue.

## Verification Baseline

The 2026-07-10 audit passed:

- API: `431 / 431` tests;
- web: `241 / 241` tests;
- shared: `19 / 19` tests;
- production tooling: `396 / 396` tests;
- local Docker tooling: `43 / 43` tests;
- reliability linkage: `354 / 354` linked guarantees;
- lint;
- production builds;
- secret and repository SAST scans across 476 files;
- production-only and full dependency audits with zero reported vulnerabilities;
- generated platform-audit currency check;
- main CI for the baseline SHA.

Important baseline limitations (since remediated where stated below):

- Reliability linkage did not prove an executed E2E result.
- The baseline default Playwright suite was deliberately skipped because P0-05
  was not yet fixed. P0-05 has since passed its managed disposable-database
  `113 / 113` contract gate and `96 / 96` live Playwright gate locally, then
  passed both CI run `29116192805` and E2E run `29116192729` for exact commit
  `e9f63038a5e8fe0c0680dcc015566dff2525a56b`.
- API health returned HTTP 200 during the audit.
- The listening local web service returned no bytes during the live HTTP check,
  so rendered browser QA was not completed.

Safe disposable-database browser execution is now part of the required gate set
through `npm run test:e2e` only.

## Final Repo-Side Exit Gate

Before declaring repo-side completion:

1. confirm every P0-P3 item is `CI_VERIFIED` or `FULLY_VERIFIED`;
2. confirm every deferral is genuinely external and names an owner/evidence need;
3. run all focused regressions;
4. run full applicable unit, integration, lint, build, security, dependency,
   production-tooling, local-Docker, audit, and safely isolated browser gates;
5. validate clean-install and migration-upgrade paths;
6. perform a fresh gap, placeholder, stale-copy, and unsafe-claim search;
7. verify a clean, scoped worktree and pushed commits;
8. bind successful CI to the final SHA;
9. refresh this document, the continuation handoff, generated platform audit,
   production TODO, and launch checklist; and
10. report before/after repository score and strict launch score separately.

The final report must list verified items, commit SHAs, CI runs, test evidence,
remaining external blockers and owners, and an explicit confirmation that no
provider evidence, legal approval, pentest result, recovery proof, release
binding, or signoff was fabricated.
