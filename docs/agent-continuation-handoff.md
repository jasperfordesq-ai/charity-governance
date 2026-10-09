# CharityPilot Agent Continuation Handoff

> **9 October document-source binding race, local only:** Document metadata
> edits, storage-provider verification and document Board-approval changes
> now acquire the charity's Organisation row lock inside their write
> transaction, then recheck `DocumentRecoveryEnforcement`. This serialises
> them with a concurrent recovery binding and returns the intended 409 if
> binding committed after the route precheck. The SQL source trigger remains
> the direct-writer fence. Focused tests passed 152/152, and the complete
> API suite passed 2,720/2,720 plus 14/14 serial real PostgreSQL migration
> tests. Upload-reservation error mapping and independent document-source
> replay still need work; no recovery binding, push or live deployment was
> performed. A follow-up now also reserves uploads under that same lock,
> returning 409 when binding wins between the route precheck and reservation,
> before any provider write. The upload-focused 113/113, full API 2,721/2,721,
> serial PostgreSQL 14/14 and production-check 1,123 passed (five Windows
> skips). The complete isolated Chromium suite then passed 245/245 on
> exact runtime commit `1bfe6a3f`, with its disposable stack removed.
> See the private 9 October document-source API response note and release
> diff gate. Hosted CI, deployment, live role checks and Nikita acceptance
> remain separate.

> **9 October publication row-ID fence, local only:** Cumulative SQL
> review confirmed the earlier purge fence already makes a publication's
> charity, source document and provider immutable. A full-schema
> PostgreSQL test then demonstrated that its primary row ID could still
> change, detaching the append-only upload/page-create intents that name
> that ID. Forward migration
> `20261009130000_document_publication_row_id_immutable` refuses that
> UPDATE. The full-schema test failed before the migration and passed
> after it; API 2,717/2,717, serial PostgreSQL 14/14 and production-check
> 1,123 passed with five platform skips. This is local source evidence,
> not a hosted migration, independent Confluence history or DPO approval.

> **9 October complete isolated browser gate, local only:** The full
> current-source Chromium suite passed 245/245 after two test fixtures were
> corrected. The first full attempt passed 208, failed two and left 35
> unrun: the new minimised-export case reused a charity already populated
> by an earlier compliance case, and a connector case exhausted the real
> per-email sign-in limit after earlier tests. The export case now creates
> its own verified synthetic Owner/charity; the connector case uses its
> already seeded second-charity Owner. The focused rerun passed 71/71,
> the complete rerun passed 245/245, E2E TypeScript and all 116 contract
> checks passed. The disposable stack was removed. These results do not
> establish hosted deployment, real Member/Owner acceptance, real Board
> approval or DPO sign-off. Private logs and the morning handoff retain
> the failed first attempt and final run.

> **9 October isolated disposal browser gate, local only:** On clean
> `d828f497`, a fresh disposable stack passed all three existing browser
> journeys: draft Deleted Items/byte-identical restricted restore with
> retained audit, reviewed primary document disposal with cancellation,
> and reviewed complaint primary disposal. The tests use synthetic
> policies, expiry and retained-copy decisions; they do not approve
> hOUR Timebank policy periods, prove provider/backups erased, establish
> independent recovery or authorize a live purge. No live state changed.

> **9 October minimised export synthetic browser demonstration, local only:**
> New isolated `dpo-minimised-export.spec.ts` seeds only a disposable
> charity's annual compliance evidence, uses the ordinary Owner Board
> sign-off workflow, verifies one retained hashed approval snapshot, then
> opens both approved report audiences. The full internal HTML contains
> synthetic action/evidence/minute/approver markers; the minimised HTML
> contains aggregate statuses and omits those markers and register detail.
> Chromium 1/1, E2E contract 116/116 and E2E TypeScript passed. A real
> Board-approved snapshot, external/regulator audience and field approval,
> hosted release and Nikita acceptance are still open.

> **9 October Member/DPO isolated browser gate, local only:** A disposable
> current-source Chromium run passed `authz.spec.ts` and
> `dpo-review-navigation.spec.ts` together, 23/23. The first run found
> two stale Confluence-copy fixtures: newer SQL correctly rejects a
> publication created without a live same-charity document. Each fixture
> now creates the source, records the copy, then removes the source to
> exercise the historical missing-Vault case. Focused 2/2 and full 23/23
> reruns passed. The ordinary document/compliance smoke also passed 3/3,
> but that smoke does not prove the minimised report. Live Member access,
> approved snapshot/export audience, hosted deployment and Nikita review
> remain separate gates.

> **9 October isolated replay browser verification, local only:** Clean
> `e56ef16c` built a disposable API/web/database stack with all current
> migrations and ran `tests/dpo-session-replay-concurrency.spec.ts` in
> Chromium. All 8 scenarios passed, including two-tab refresh, sign-out
> races, lost logout/refresh responses, Web Locks absence and a rejected
> invalid cookie. The isolated Docker project was removed after exit 0.
> This verifies synthetic current-source behavior, not attribution of the
> nine historical VM `SESSION_REPLAY_DETECTED` events or hosted acceptance.

> **9 October production-check gate repair, local only:** The first current
> `test:production-check` run exposed 19 failures: synthetic public deploy
> fixtures lacked the now-required production/MFA fields; the isolated E2E
> static contract rejected three explicit auth-response fault injections in
> the replay spec; and Windows exposed a WSL `bash` launcher with no Linux
> `/bin/bash`. Test fixtures now exercise the strict production requirement,
> the route exception is confined to the exact replay requests and real
> backend responses, and the Bash syntax test skips only that missing WSL
> interpreter. The full suite now passes 1,123, fails 0, skips 5 on this
> Windows host; focused tests pass 116, fail 0, skip 1. The five skips are
> environment-specific and do not constitute Linux/hosted acceptance.

> **9 October current-candidate API verification, local only:** On clean
> `9e75cc86`, `npm.cmd test` in `apps/api` completed with exit 0: TypeScript
> and seed builds passed, 2,717 API tests passed, and all 14 serial real
> PostgreSQL migration tests passed. This refreshes the earlier API-suite
> result after the recent SQL/web changes. It is local source evidence;
> exact release CI, hosted migration, role checks and Nikita acceptance
> remain open. See private `overnight-handoff-2026-10-09.md`.

> **9 October calendar retention SQL test gate, local only:** The existing
> disposable PostgreSQL UTC anniversary proof was not included in the CI
> retention command. It now runs through `test:retention-policy`, which
> passed 3/3 with populated upgrade and recovery-bound policy proofs.
> Controller policy approval, live migration and independent recovery
> remain OPEN; see private `calendar-retention-ci-gate-2026-10-09.md`.

> **9 October browser logout ordering, local only:** A red cross-tab test
> showed the shared logout stamp was absent while revocation was in flight.
> The web coordinator now writes the stamp before the request under the
> refresh lock and reasserts it afterward. Focused session tests 15/15,
> web suite 558/558 and edited-file lint pass. This narrows a future
> tab-exit replay window; it does not attribute the nine historical events,
> prove hosted behavior or constitute Nikita's disposition. See private
> `logout-fence-before-request-2026-10-09.md`.

> **9 October publication intent binding completeness, local only:** The
> eighteenth unreleased migration now checks append-only Confluence upload
> and page-create intent tables in its existing-binding preflight and new
> binding trigger. Current ordinary SQL guards retain parent publication
> rows; the additional check fails closed for malformed or privileged
> historical data. Focused red/green PostgreSQL and current full-schema
> composition passed. Pinned read-only VM counts found zero publication,
> intent and binding rows at 156/174 migrations. Repeat before release;
> independent copy recovery and Nikita acceptance remain OPEN.

> **9 October bound upload-intent mutation fix, local only:** Review of the
> unreleased source/upload migration found that old reconciled upload intents
> could be changed or deleted after recovery binding. A red direct-SQL test
> reproduced it. The migration now fences INSERT, UPDATE and DELETE for a
> bound charity and checks both old and new charities on retargeting. Focused
> PostgreSQL 1/1, composed byte authority 1/1, retention 2/2 and byte fence
> 2/2 passed locally. See private
> `upload-intent-bound-update-review-2026-10-09.md`. VM release, independent
> recovery authority and Nikita acceptance remain OPEN.

> **9 October recovery script compatibility, local only:** Current
> disposable retention/bound-policy tests passed 1/1 each, composed
> complaint recovery passed 1/1, and document byte-fence passed 2/2 after
> fixtures were aligned with the new source, upload-intent and copy gates.
> The historical complaint-copy section bypasses only those new gates in a
> labelled synthetic privileged scenario, then restores and rechecks them;
> ordinary bound copy writes remain forbidden. See private
> `recovery-script-matrix-2026-10-09.md`. Live release and independent
> recovery/DPO evidence remain OPEN.

> **9 October full-schema restricted-role composition, local only:** The
> disposable byte-authority PostgreSQL proof was updated for the interim
> publication recovery gate. An unbound synthetic charity retains
> publication/purge tests; a separate bound charity exercises byte authority
> and refuses new publication/upload reservations. All 174 migrations,
> restricted runtime grants and composed proof passed 1/1; the disposable
> container was removed. The VM still lacks 18 migrations and its actual
> runtime role must be rechecked after release. See private
> `full-schema-byte-proof-2026-10-09.md`.

> **9 October 04:10 Dublin private VM read-only preflight snapshot:** The
> clean VM at `96c8b1e8` has zero `ConfluenceReference`, zero
> `DocumentPublication` and zero `DocumentRecoveryEnforcement` rows, with
> 75 Vault documents. Applied migration names match the first 156 of 174
> local directories; the final 18 remain undeployed. The two Confluence
> mismatch checks are clear only at this snapshot; repeat before release.
> Count-only PostgreSQL ran inside a read-only transaction on the pinned
> local Docker socket. See the gitignored
> `publication-live-inventory-2026-10-09.md`. No binding was activated.

> **9 October Confluence publication interim gate, OPEN:** Local
> `20261009120000_document_publication_recovery_binding_gate` rejects a
> charity's binding if any publication row exists, freezes publication DML
> after binding and refuses legacy coexistence or cross-charity publication
> source mismatches during migration. New publication rows require a live
> same-charity Document; historical rows may outlive source deletion. Inspect
> live mismatches before release. It
> serializes binding and new queue rows on the Organisation lock. A focused
> real PostgreSQL two-order race test and full API 2,717 plus serial PG 14
> tests passed, including blank full-schema migration. This
> provisional freeze is not independently replayable copy history, does not
> authorize activation and is not Nikita acceptance.

> **9 October Confluence publication binding gap, OPEN:** Source audit found
> that a PENDING or requeued `DocumentPublication` can still lead to a remote
> page/attachment write after future document recovery binding. Existing
> purge/identity fences do not give independent host-loss copy history.
> Before binding, prove publication quiescence, a writer/worker fence and
> authenticated copy/UNKNOWN replay in synthetic Confluence. This is a
> source finding, not a live incident or Nikita acceptance. See private
> `document-publication-recovery-binding-gap-2026-10-09.md`.

> **9 October ~03:57 Dublin Vault writer responses, OPEN:** Local API
> now returns `DOCUMENT_SOURCE_RECOVERY_REQUIRED` 409 for already-bound
> metadata edits, provider review, Board approval and Deleted Items
> remove/restore. The latter checks under the charity lock before reading
> bytes. Full API 2,716/2,716 and 14/14 serial PostgreSQL tests pass.
> SQL remains the race authority; a bind after a route precheck can still
> surface a generic API error. This is unreleased and binding inactive.
> Independent source history/replay, policy, release and Nikita review remain
> OPEN. See private `document-source-api-response-2026-10-09.md`.

> **9 October ~03:46 Dublin Vault source/upload boundary, OPEN:** Local
> `20261009110000_document_source_upload_recovery_gate` serializes future
> document recovery binding with upload reservations, refuses binding while
> reservations or unfinished cleanup are present, and freezes ordinary
> Document INSERT/UPDATE and new reservations after binding. The upload API
> returns 409 before provider I/O for an already-bound charity. Full API
> 2,712/2,712 and serial real PostgreSQL 14/14 passed; a separate focused
> two-order reservation/binding race passed. This seventeenth forward
> migration is undeployed and binding remains inactive. Other Document
> writer API responses, independent source history/baseline/replay, policy,
> release and Nikita acceptance remain OPEN. See private receipt.

> **9 October ~03:36 Dublin Vault standard-link gate, OPEN:** Local
> `20261009100000_document_standard_link_recovery_gate` freezes
> `DocumentStandardLink` INSERT/UPDATE/DELETE after document recovery
> binding, including direct SQL retargets; Document charity identity is
> immutable. The supported API returns 409 before writing linked evidence.
> Full API 2,710 and 14 serial real-PostgreSQL tests passed, including
> a current blank-schema migration chain. This sixteenth forward
> migration is undeployed. Link baseline/replay, controller policy,
> release and Nikita acceptance remain OPEN. See private receipt.

> **9 October ~03:29 Dublin Confluence citation boundary, OPEN:** Local
> migration `20261009090000_confluence_reference_recovery_tenant`
> refuses pre-existing cross-charity citation/document mismatches, adds
> a same-charity composite foreign key, and freezes citation add/edit/
> remove under document recovery binding. The API refuses an already
> bound cite before provider read and checks again under the charity
> lock. Prisma validation and API build passed; full local API 2,709 and
> 13 serial PostgreSQL tests passed, including a blank full-chain
> migration. This fifteenth forward migration is undeployed. Live
> mismatch inventory, independent citation replay, policy, release and
> Nikita acceptance remain OPEN. See private receipt.

> **9 October ~03:23 Dublin complaint source writer fence, OPEN:** Local
> API and forward SQL now refuse ordinary `ComplaintRecord` create/update
> after a charity's recovery binding, including direct database writes.
> Unbound charities continue; separately guarded permanent purge remains
> reachable. Full local API 2,708 and 12 serial disposable PostgreSQL
> migration tests passed. This fourteenth forward migration is not on the
> private VM. No independently committed source fact, baseline, trusted
> head, approved custody, host-loss replay, live binding or Nikita
> acceptance exists. See private
> `recovery-bound-complaint-source-gate-2026-10-09.md`.

> **9 October ~03:20 Dublin unattended source review:** A bounded review of
> the unreleased browser refresh/logout/MFA paths and selected recovery and
> calendar-retention migrations at `e78be948` found no new concrete bypass
> in its sampled scope. See private
> `unreleased-auth-retention-review-2026-10-09.md` for files and limits.
> This is not full release review, CI, hosted proof or DPO sign-off; the
> private VM remains 13 migrations behind. No login, push or live change
> was made overnight.

> **9 October ~03:13 Dublin complaint source commit boundary, OPEN:**
> Source review confirms the local complaint PostgreSQL transaction
> cannot commit atomically with the separate encrypted S3 candidate.
> DB-first can lose a committed edit on VM loss; candidate-first can
> leave an uncommitted fact. The private commit-protocol decision memo
> defines `UNKNOWN` fail-closed recovery and the controller choice
> needed before a writer or replay integration. Do not treat candidate
> objects as committed records or activate recovery binding.

> **9 October ~03:11 Dublin complaint source S3 candidate, OPEN:** Local
> `2e21d2eb` adds a separate scoped object prefix for encrypted source
> candidates, with structural binding checks and the existing explicit
> bucket-owner, conditional-create and SSE-KMS metadata rules. Fake-S3
> transport, API build and six focused tests pass. No real AWS contact,
> controller-approved data custody, current head, source-writer binding,
> baseline, replay or host-loss acceptance. See private source receipt.

> **9 October ~03:10 Dublin complaint candidate readback, OPEN:** Local
> `1d80444b` adds atomic create-if-absent candidate semantics, readback
> after creation and an expected-digest read. A synthetic lost-acknowledgement
> retry, changed-fact conflict, concurrent winner and missing/replaced
> object cases pass; API build and five focused tests pass. The digest in
> those tests is local, not an independently authenticated current head.
> There is no real provider adapter, policy, baseline, replay, writer
> gate or live binding. See private source-candidate receipt.

> **9 October ~03:08 Dublin complaint source candidate, OPEN:** Local
> `3871fd73` defines a strict versioned full `ComplaintRecord` source
> fact and an encrypted candidate envelope bound to installation,
> charity, operation, writer epoch, source revision and KMS key ID.
> Synthetic create/baseline/update, malformed and tamper checks pass
> (three focused tests); API TypeScript build passes. No provider call,
> source-writer integration, head, complete baseline, replay, database
> fence, controller policy, release or host-loss proof exists. The
> `ComplaintRecoveryEnforcement` rows must remain unused. See private
> `complaint-source-candidate-2026-10-09.md` and the host-loss contract.

> **9 October ~03:04 Dublin C1-adjacent sender eligibility, OPEN:**
> Separate NEXUS isolated branch `codex/c1-pending-profile` commit
> `19c17b6a9` checks both locked connection participants are active,
> approved and in the same tenant. An active unapproved Admin's synthetic
> request returned 201 before the fix; after it, 422 with no row. Focused
> red/green and disposable 32-test/75-assertion controller suite passed.
> Provisional NEXUS F-576; branch 13 ahead, unpushed/unmerged/undeployed.
> This is not hosted token, original C1 admin-email, or Nikita acceptance
> evidence. See private `c1-unapproved-connection-sender-2026-10-09.md`.

> **9 October 01:54 UTC C1 adjacent stale ranked-cache visibility,
> OPEN:** Separate NEXUS isolated branch `codex/c1-pending-profile`
> commit `d1e55c525` rechecks a ranked candidate's current privacy,
> search opt-in, approval and status before selecting profile fields.
> Red synthetic route disclosed a newly private cached member; broader
> green suites passed 137/398. Branch is 12 ahead of origin/main,
> unpushed/unmerged/undeployed. Provisional NEXUS F-575; original C1,
> hosted replay and Nikita review remain OPEN. See private receipt.

> **9 October complaint source-state audit, OPEN:** The current
> complaint recovery protocol does not independently preserve ordinary
> complaint creates or edits. Register audit has only field names;
> source snapshot comparison needs a surviving current database.
> Existing intent-journal capacity and data classification do not
> support reusing it as a case-edit journal. No activation or provider
> change was made. See private host-loss contract before new gates.

> **9 October 01:43 UTC P05/P07 complaint resolution writer, OPEN:**
> Local forward SQL and API now refuse `ComplaintResolutionEvidence`
> recording or withdrawal after complaint recovery binding. A focused
> 35/35 suite, direct PostgreSQL migration proof 1/1, and full API
> 2,701 plus 11 PostgreSQL tests passed. Complaint record edits and
> existing-fact activation replay remain unresolved. This is inactive
> local source, not independent recovery or Nikita acceptance. See
> private `recovery-bound-complaint-resolution-2026-10-09.md`.

> **9 October 01:36 UTC C1 adjacent private-profile visibility, OPEN:**
> In isolated NEXUS branch `codex/c1-pending-profile`, local commit
> `336b6f1a1` fixes red-tested directory/search disclosure of a
> connections-only profile to an active unapproved Admin account.
> Broader synthetic suite passed 136/382; final focused search and
> surname check passed 1/11. Branch is 11 ahead of origin/main,
> unpushed/unmerged/undeployed. This is provisional NEXUS F-574;
> original C1 closure evidence, hosted proof and Nikita/risk-owner
> decision remain OPEN. See private C1 receipt.

> **9 October 01:25 UTC P05/P07 primary disposal decisions, OPEN:**
> Local forward SQL and API guards now refuse document/complaint purge
> authorization and withdrawal inserts after the matching recovery
> binding. Existing same-transaction claim execution remains. Focused
> API 31/31, synthetic direct-SQL migration proof 1/1 and full API
> 2,699 plus 11 real PG tests passed. This is inactive local source, not live
> recovery or DPO acceptance. See the private decision receipt.

> **9 October 01:19 UTC P05/P07 copy writer fence, OPEN:** A local
> forward migration and API guards now refuse document/complaint
> copy authority, hold and observation inserts after the matching
> recovery binding. Focused API 39/39 and disposable PostgreSQL
> direct-SQL proof for six tables passed. Full API 2,695 plus 11 PG
> passed before a safe race-error translation was rebuilt and
> retested in the focused suite.
> No live activation, deployment, independent custody/replay or
> Nikita acceptance is implied. See the private copy writer receipt.

> **9 October 01:14 UTC P05/P07 document hold, OPEN:** Local API and
> forward database trigger now refuse ordinary Vault deletion-hold
> placement and release after document recovery binding. The
> disposable direct-SQL proof covers both transitions and an unbound
> charity; combined retention proofs passed 2/2. Full API passed
> 2,691 tests plus 11 real PostgreSQL migration tests. This is an
> inactive partial writer guard, not independent recovery activation,
> approved preservation policy, hosted evidence or Nikita acceptance.
> Private receipt: `recovery-bound-document-hold-2026-10-09.md`.

> **9 October 01:07 UTC P04/P05 policy-writer boundary, OPEN:** A
> local forward migration and `RetentionPolicyService` guard now
> refuse policy revisions/withdrawals for all four supported classes
> after the corresponding document or complaint recovery binding.
> The full API package passed 2,690 tests plus 11 real PostgreSQL
> migration tests; the combined disposable retention proof passed
> 2/2 and is wired to CI. This is inactive source, not a live binding,
> controller policy, complete writer/replay fence or independent
> recovery acceptance. Both available CharityPilot browser tabs were
> at `/login` at 00:58 UTC; live Member checks wait for Jasper.
> Private receipt: `recovery-bound-policy-four-class-2026-10-09.md`.

> **9 October 00:57 UTC C1-adjacent profile Admin exemption, OPEN:**
> NEXUS isolated local `621a3c415` makes shared profile visibility
> grant its Admin exemption only to active, approved staff. A
> suspended-admin synthetic regression failed before the fix; the
> corrected affected suites passed 134 tests/373 assertions on
> disposable MariaDB. The branch is ten ahead of origin/main,
> unpushed/unmerged/undeployed. This is no hosted session-revocation,
> C1 mail or DPO acceptance proof. Private receipt:
> `c1-bulk-profile-visibility-2026-10-09.md`.

> **9 October 00:52 UTC C1 test follow-up:** NEXUS isolated local
> commit `1345a4f15` adds an accepted-connection regression for the
> pending-profile bulk gate. The focused disposable MariaDB run
> passed 1 test/5 assertions. The branch is now nine ahead of
> origin/main, unpushed/unmerged/undeployed. The 110-test broad run
> below covered the preceding source commit `cc8537c7f`; C1 remains
> OPEN for hosted, original-evidence and independent review gates.

> **9 October 00:49 UTC C1-adjacent NEXUS source checkpoint, OPEN:**
> Isolated `codex/c1-pending-profile` local commit `cc8537c7f`
> closes a bulk-profile predicate gap that allowed a pending/public
> account into member-visible SQL results despite direct-profile
> and directory gates. A synthetic pre-fix test reproduced the leak;
> corrected affected suites passed 110 tests/272 assertions on a
> disposable MariaDB 10.11 network. The NEXUS branch is eight commits
> ahead of origin/main, unpushed, unmerged and undeployed. The
> original C1 admin-email evidence, hosted recipient/visibility
> checks and risk-owner/Nikita disposition remain OPEN. Private
> receipt: `c1-bulk-profile-visibility-2026-10-09.md`.

> **9 October 00:42 UTC restricted DB login, OPEN for DPO review:**
> The pinned read-only live checker on clean green private VM
> `96c8b1e8` verified active API and scheduler `current_user =
> cp_runtime`, 11/11 role restrictions, zero memberships/ownership
> and unexpected executable definers, and twelve protected tables
> present/selectable with zero write-like role privileges. The web
> configuration also names `cp_runtime`. Eight local SQL migrations
> remain undeployed; repeat exact role/grant checks after any release.
> This proves a point-in-time restricted login, not read-only database
> operation or Nikita's independent acceptance. Private receipt:
> `runtime-role-recheck-2026-10-09.md`.

> **9 October 00:41 UTC DPO-04 current export prerequisite, OPEN:**
> Clean local `d6d611d3` rebuilt the API; the compiled minimised
> renderer reproduced both invented review HTML hashes exactly, and
> the focused export suite passed 9/9. A guarded read-only query on
> clean serving VM `96c8b1e8` counted one charity, zero genuine
> approved snapshots and zero current approved signoffs. No live
> report, Board approval or disclosure was created. Field, recipient
> and small-count decisions plus Nikita acceptance remain OPEN.
> Private receipt: `minimised-export-current-state-2026-10-09.md`.

> **9 October 00:39 UTC DPO-02 live recheck, OPEN:** The clean private
> VM still serves `96c8b1e8`. A guarded local-Unix-Docker, PostgreSQL
> `BEGIN READ ONLY` metadata query returned nine historical
> `SESSION_REPLAY_DETECTED` rows, latest 30 September 08:54 UTC, with
> no newer row in that table. The old seven lack decisive diagnostics;
> the two later WEB rows retain 137/134 ms prior-LOGOUT gaps; the
> connector event remains unattributed. The query printed no subject
> or credential identifier. Exact private receipt:
> `replay-read-only-recheck-2026-10-09.md`. Risk-owner and Nikita
> incident disposition remains OPEN; local client fixes are undeployed.

> **9 October ~01:37 Dublin public MFA page-boundary follow-up, OPEN:**
> The API `/auth/me` now sends a no-store setup header for a verified,
> unenrolled Owner/Admin under required public MFA. The Next.js protected
> route proxy uses it to redirect a pending session to `/security-data`
> before rendering other protected pages; Confluence's self-renewing
> callback still runs in place without copying OAuth code/state to a
> redirect. The focused API route tests (6/6), web suite (557/557), API
> build and edited-file lint pass locally. This remains unpushed,
> undeployed and unreviewed independently.

> **9 October ~01:34 Dublin public privileged MFA increment, OPEN:**
> Local source now requires `CHARITYPILOT_PRIVILEGED_MFA_MODE=required`
> for the explicit public `CHARITYPILOT_DEPLOYMENT_MODE=production` profile.
> The public Compose API fixes both values and preflight rejects absent or
> optional MFA. Owner/Admin privileged requests check current role and
> enrolled factor; unenrolled browser sessions reach only authenticator
> setup and account bootstrap, and unenrolled connector login is denied.
> Login and session reload direct pending users to setup without rendering
> other dashboard pages. The current private VM's optional MFA scope is
> unchanged. Full API (2,688 plus 11 PostgreSQL migration tests), web
> (556), public preflight (181), production builds and edited-file lint
> pass locally. No push, deployment, live public journey, governed lost-
> factors recovery, key-rotation rehearsal or Nikita sign-off has occurred.
> See private `nikita-mfa-decision-pack-2026-10-06.md` for exact scope.

> **9 October ~01:18 Dublin cleanup migration broad gate:** Exact clean
> local commit `12ab8719` passed the full API test command after the
> cleanup-job charity identity migration: 2,683 main tests and 11
> serial real-PostgreSQL migration tests, zero failures/skips in both
> phases. Private log: `document-cleanup-org-api-suite-2026-10-09.log`.
> This is local integration evidence; no push, deployment, live policy,
> independent recovery provider or DPO review followed.

> **9 October ~01:20 Dublin document cleanup identity fence:** A red
> disposable PostgreSQL test proved an unclaimed cleanup job could be
> moved from charity A to charity B without changing provider/path,
> bypassing the old alias trigger's fast path. A new local migration
> makes the job's `organisationId` immutable. The isolated green test,
> combined byte-fence tests (2/2) and full current-migration document
> byte-authority PostgreSQL proof passed. Receipt and red/green logs are
> private. This is source-only: the live database lacks this migration,
> and independent provider custody, complete all-writer byte execution,
> controller policy and DPO acceptance remain OPEN.

> **9 October ~01:11 Dublin C1 local recipient matrix:** At the same
> isolated, unpushed NEXUS commit `73490953e`, two synthetic registration
> routes exercised all nine staff recipient-selection classes, seven
> additional locale samples, and ordinary/suspended/foreign exclusions.
> Each variant persisted 16 bells and 16 sent email-log rows, then rolled
> back to zero fixture rows. All 32 Mailpit messages passed exact
> recipient, localized-subject (11 catalogs), synthetic-particulars
> omission and usable staff-link checks. The final test explicitly loaded
> all locales; the default testing preload only includes en/ga/de.
> Disposable resources were removed. Exact private receipt/log/runner:
> `c1-local-recipient-matrix-receipt-2026-10-09.md`. This still does not
> prove hosted delivery, historic C1 closure or independent DPO review.

> **9 October ~01:05 Dublin C1 full local route/capture proof:** At exact
> unpushed NEXUS commit `73490953e`, two disposable HTTP-kernel
> registrations (ordinary and approval-required) returned 201 and each
> produced two scoped staff bells and two sent email-log rows. A private
> Mailpit captured all four SMTP notices; full subject/HTML/text checks
> found no synthetic registrant name/address or numeric profile link,
> and both Admin/Broker destinations matched the intended lists. Both
> database fixtures rolled back to zero rows; disposable containers and
> network were removed. Receipt, log and guarded rerun script are in
> `.charitypilot-private/`. This adds local route-to-capture evidence,
> not hosted delivery, every recipient/locale or C1 closure. Branch
> remains unpushed, unmerged and undeployed; risk-owner/DPO gates remain.

> **9 October 00:59 Dublin C1 actual bell fan-out proof:** Separate NEXUS
> worktree `C:\platforms\htdocs\staging-codex-c1-pending`, branch
> `codex/c1-pending-profile`, now includes test-only commit `73490953e`.
> A new integration test invokes the real registration listener and checks
> persisted notifications for role Admin, flag-only Admin and Coordinator,
> exclusion of ordinary/inactive/foreign-tenant users, correct staff links,
> tenant binding and duplicate suppression. Its synthetic `.example` mail
> addresses are rejected before provider contact. Fresh disposable MariaDB
> 10.11/PHP 8.2.30 run passed 24 tests/44 assertions with no skips; log and
> repeatable runner are private. This replaces one quarantined fan-out
> assertion with real bell persistence evidence. It does not prove delivered
> mail, hosted registration, all recipients/locales, or C1 closure. Both
> repositories remain unpushed/undeployed; no live identity was used.

> **9 October 00:55 Dublin C1 broader isolated run:** NEXUS branch
> `7f69208dc` passed a combined recipient, Admin Users, profile and
> onboarding PHPUnit run in a fresh disposable MariaDB/PHP environment:
> 99 tests, 272 assertions, 12 pre-existing quarantined fan-out skips.
> The exact database/network were removed. This is stronger local
> branch evidence but does not prove skipped fan-out, hosted email/bell
> delivery, recipient-wide minimisation or C1 risk-owner/DPO closure.
> The branch remains unpushed/unmerged/undeployed.

> **9 October 00:49 Dublin retention removal policy shape:** Local
> document and complaint removal services now refuse contradictory
> REVIEW_REQUIRED/day/year terms; document removal also refuses an invalid
> recovery window before reading file bytes. This supplements the existing
> PostgreSQL policy constraints. Focused tests and the complete API package
> passed: 2,683 main tests and 11 disposable PostgreSQL migration tests.
> The first full run exposed stale policy mocks (10 failures); corrected
> current-row fixtures and the green rerun are logged privately. This is
> source-only, with year-mode creation still fenced and no controller
> retention rule, live policy, erasure or DPO acceptance established.

> **9 October 00:41 Dublin document-byte projection correction:** A full
> current-migration disposable PostgreSQL proof initially failed because
> its synthetic signed policy omitted the nullable `retentionYears` field
> now returned by Prisma. The proof fixture now includes that field.
> The projection also treats a missing field in an older signed preparation
> as equivalent to current `null` only; a non-null year term or other policy
> change still refuses. API build, three focused projection tests and the
> full current-migration disposable PostgreSQL byte-authority proof passed.
> Original failure and successful rerun logs are private. This remains
> local, non-authorizing evidence, with no independent custody, all-writer
> execution fence, live release or DPO acceptance.

> **9 October 00:36 Dublin isolated C1 source proof:** The separate
> NEXUS C1 branch is clean at `7f69208dc`, six local commits ahead,
> unpushed/unmerged/undeployed. In a disposable MariaDB 10.11 database,
> its registration-alert PHPUnit class passed 23 tests/38 assertions.
> A new staff-list API test passed 1 test/7 assertions for Admin,
> Broker and Coordinator finding an incomplete private registrant and
> ordinary Member denial. The synthetic resources were removed. This
> supports the neutral alert's staff-list route but does not prove
> hosted email/bell delivery, broad C1 closure or DPO acceptance.

> **9 October 00:30 Dublin overnight source checkpoint:** Clean local
> CharityPilot `master` `6093fa9f` remains 33 commits ahead of origin,
> unpushed/undeployed. The accumulated change passed
> `git diff --check origin/master...HEAD` and the complete API test
> command, including 11 serial disposable PostgreSQL migration tests.
> In the separate NEXUS C1 worktree, clean local `2600751b8` routes
> neutral registration alerts to staff member lists while preserving
> pending-approval routes and profile privacy. PHP syntax, locale JSON,
> six direct routing cases and diff checks passed; full isolated Laravel
> and hosted C1 journeys remain. No new Nikita email was found after
> 8 October. Login-dependent Member/Owner checks, controller retention
> rules, independent custody/replay, release and DPO acceptance remain.
> Private resume and C1 decision notes contain the exact next steps.

> **9 October 00:20 Dublin P04 claim error parity:** The local document
> purge service now translates the new database calendar cutoff refusal
> to its existing `PURGE_NOT_DUE` 409 response, and an unsupported mode
> to a safe review-conflict 409. Focused tests simulate the real Prisma
> unknown-request error shape and ensure arbitrary database details are
> not returned. API build and all 17 document purge tests pass. This is
> response parity behind the policy creation fence, not a live purge.

> **9 October 00:18 Dublin P04 activation-fence regression:** A focused
> API test now proves that both DRAFT and APPROVED calendar-year creation
> requests are rejected before any database lock/write for each of the
> four retention classes. API build and nine policy tests pass. The
> separate SQL activation trigger remains; neither gate is approval of
> a live term. Review of older day-only SQL found later calendar guards
> on the effective document/complaint disposal paths. Independent
> recovery custody remains a separate unimplemented live gate.

> **9 October 00:15 Dublin P04 read-only policy display, still fenced:**
> The document recovery-policy listing now includes valid year-mode
> candidates and their `retentionYears` field for Owner review. The
> retention history, document disposal policy selector and complaint
> purge review show calendar years explicitly. The policy form does not
> offer year-mode creation and cannot copy a historical year term into
> that form; the SQL activation fence is unchanged. API build, web
> TypeScript check and 69 document route tests pass. No live policy,
> approval, release or DPO evidence changed.

> **9 October 00:13 Dublin P04 integrated copy proof, still fenced:**
> Disposable full PostgreSQL document and complaint migration suites now
> each test a calendar copy policy through real authority and observation
> triggers: missing anchor and early leap-day term rejected; elapsed term
> authorized and bound to verified absence. Both suites pass after the
> document reconciliation fixture expected one additional authority.
> The year-policy insertion bypasses only the activation trigger inside
> disposable test databases, restores it immediately, and never touches
> live data. The general document-recovery manifest's `retentionDays`
> describes backup custody, not this application policy; do not rewrite
> that manifest as a year-term verifier. Policy input/UI, approved term,
> release and independent DPO review remain open.

> **9 October 00:10 Dublin P04 copy review UI, still fenced:** The local
> copy authority panel now recognises bounded year terms, shows calendar
> years from copy creation, requires the reviewed creation timestamp for
> a calendar policy, and refuses malformed or unknown terms before a
> decision or observation selection. Web TypeScript check and all 554
> web tests pass. The SQL copy validator remains the authoritative
> cutoff check. No integrated year-mode event/observation or live proof;
> policy creation and human/controller approval remain closed.

> **9 October 00:09 Dublin P04 recovery preparation, still inactive:**
> Document and complaint signed preparation parsers now carry a valid
> `AFTER_CALENDAR_YEARS` policy and non-null 1–100 year term for both
> current and original removal policy identities. They reject mixed
> day/year terms, absent year/anchor and missing or withdrawn complaint
> resolution evidence. Older signed preparations without `retentionYears`
> still parse and retain their original bytes. API build and 17 focused
> tests pass. Copy review service delegates cutoff enforcement to the
> shared SQL validator; integrated event/observation proof remains.
> The policy activation fence, input/listing, human UI, recovery verifier,
> controller decision, release and DPO review remain open. No live data changed.

> **9 October 00:06 Dublin P04 API cutoff parity, still inactive:**
> Document removal, complaint removal and complaint retention assessment
> now use the shared UTC calendar-year cutoff for a valid year-mode policy.
> Complaint removal also matches the SQL requirement that recorded
> resolution cannot precede receipt. API build and 10 focused tests pass,
> including early/elapsed leap-day cases. The mode creation fence,
> policy input, recovery preparation for non-null years, copy review
> service, recovery-policy listing, human UI, controller decision,
> release and Nikita review remain open. No live data changed.

> **9 October 00:04 Dublin P04 complaint purge SQL:** Forward migration
> `20261009010000_complaint_calendar_purge_guards` extends effective
> complaint purge authorization and claim functions to validate a
> current calendar policy and matching recorded resolution, with the
> UTC cutoff rechecked at claim time. Full disposable PostgreSQL
> complaint migration test passed an original review-policy removal,
> withdrawal/replacement by a calendar policy, early claim refusal and
> elapsed full claim/delete, all rolled back. The fixture briefly aged
> its immutable recovery deadline with only that append-only trigger
> disabled so the claim could isolate retention; all normal claim and
> dispatch triggers ran. The mode fence remains; API decisions, recovery
> preparation format, human review, controller policy, release and DPO
> acceptance are still open.

> **8 October 23:59 Dublin P04 copy cutoff:** Forward migration
> `20261008070000_copy_calendar_cutoff_guard` updates the shared SQL
> copy-policy validator used by document and complaint copy authority
> and observation paths. Full disposable PostgreSQL migration proof
> passed: both copy classes refused premature six-year disposal and
> accepted elapsed retention in rolled-back synthetic transactions.
> This is direct function proof; integrated copy-authority and
> observation tests for the year mode remain. The policy activation
> fence, complaint purge and API/UI/controller gates remain open.

> **8 October 23:57 Dublin P04 complaint removal, still fenced:** Forward
> migration `20261008060000_complaint_calendar_removal_guard` evaluates
> the recorded `RESOLVED_AT` evidence with the UTC year cutoff. Full
> disposable complaint migration proof rejects a 2024 leap-day + six-year
> early removal and accepts a 2020 leap-day + six-year elapsed removal,
> both rolled back. The added nullable `retentionYears` field initially
> broke strict recovery-preparation parsing; both document and complaint
> parsers/stores now handle new null fields while allowing older signed
> facts to omit it. API build, complaint migration and 14 focused
> preparation tests pass. Complaint purge, copy, API decision/UI parity
> and the activation fence remain open; no live policy changed.

> **8 October 23:53 Dublin P04 claim cutoff proof:** The full disposable
> PostgreSQL migration test now isolates the new `DocumentPurgeClaim`
> calendar trigger. A 2024 leap-day + six-year early claim is refused;
> a 2020 leap-day + six-year elapsed claim passes the cutoff trigger.
> Other claim/dispatch user triggers were disabled only inside those
> rolled-back synthetic transactions, so this proves the cutoff decision,
> not an end-to-end purge. The full migration test passed. The mode fence
> and all remaining complaint/copy/API/UI gates stay open.

> **8 October 23:51 Dublin P04 document SQL guard:** Forward migration
> `20261008050000_document_calendar_cutoff_guards` adds a UTC calendar
> cutoff check to direct document removal and purge claims, without
> changing existing day-mode logic or lifting the mode fence. Full
> disposable PostgreSQL migration test passed. A synthetic direct removal
> before the six-year leap-day cutoff was rejected; a separate elapsed
> six-year case entered Deleted Items inside a rolled-back transaction.
> The purge-claim trigger installed but still needs an explicit full
> claim before/at cutoff fixture. Complaint/copy SQL guards and all API/
> review consumers remain open. No live data or approved policy changed.

> **8 October 23:47 Dublin P04 policy shape, still inactive:** Prisma and a
> forward migration add nullable `retentionYears`, separate from the
> existing `retentionDays`. The strengthened period constraint rejects
> mixed, missing, zero and excessive year terms. Full disposable
> PostgreSQL migration proof passed, including original day-row
> preservation and synthetic schema-only probes with the mode fence
> temporarily disabled inside rolled-back transactions. Prisma generation
> and API build passed. The fence remains installed; API input still
> rejects the year mode, and no SQL disposal path uses the new field.

> **8 October 23:45 Dublin P04 activation fence:** Forward migration
> `20261008030000_retention_policy_mode_fence` prevents creation of an
> unknown retention mode independently of the original policy constraint.
> The full disposable PostgreSQL retention migration test passed after
> deliberately dropping that old constraint inside a rolled-back synthetic
> attempt: `AFTER_CALENDAR_YEARS` still failed, while an existing
> `REVIEW_REQUIRED` policy succeeded. A future calendar mode must replace
> this fence only in the same releasable change that updates every direct
> SQL disposal guard and API/review consumer. This is local source proof,
> not approved policy, deployed migration or live erasure support.

> **8 October 23:42 Dublin P04 safe preparation, source only:** Isolated
> `retention-calendar-years` checkout adds a PostgreSQL UTC calendar-year
> cutoff helper, with disposable PostgreSQL 16 leap-day, millisecond and
> invalid-input proof. Document and complaint removal now reject an unknown
> policy mode; the document policy shape is checked before file reads, and
> the recovery-policy listing uses an explicit allowlist. Focused API tests
> pass. The helper adds **no creatable calendar policy or disposal authority**.
> Direct database removal/purge/copy guards, schema/input/review contracts,
> controller decisions, deployment and DPO acceptance remain outstanding.

> **8 October 23:38 Dublin P04 calendar parity:** Disposable PostgreSQL
> 16 `make_interval(years => 6)` and local UTC helper both yield
> 2030-02-28 for a 2024-02-29 anchor at the same time; `365*6` days yields
> 2030-02-27. Private `calendar-retention-parity-and-guard-map-2026-10-08.md`
> lists the effective document, complaint and copy database guards plus
> API/UI consumers. A year mode must not become creatable until all guards
> reject premature direct writes. No live DB, policy or disposal changed.

> **8 October 23:37 Dublin P04 calendar primitive, source only:** Local
> commit `3b9e12f4` adds a UTC whole-year anniversary calculation using
> the shared civil-date clamp. API build and 3/3 focused tests passed,
> including leap-day and exact cutoff cases. No policy input, schema,
> SQL guard, API preview, UI or disposal path uses it; no live policy or
> controller approval exists. The P04 calendar/class implementation and
> P05–P08 independent recovery/erasure decisions remain open.

> **8 October 23:34 Dublin P04–P08 decision preparation:** The private
> `nikita-retention-recovery-morning-decisions-2026-10-08.md` consolidates
> the charity's 24-row schedule/V2 evidence and current code into a
> controller/Board review brief. It records missing anchors/calendar
> semantics, recovery window, primary/copy disposal, holds, independent
> custody and reopening authority. This is **not approval**; no live
> retention setting, provider account or deletion changed. The current
> day-based service, 10,000-entry full-scan journal cap and independent
> host-loss proof remain technical gaps before activation.

> **8 October 23:32 Dublin C1 connection read paths:** Separate NEXUS
> branch `codex/c1-pending-profile` now ends at amended local commit
> `4a096b27e`, four ahead of fetched `origin/main` `05c17bf94`.
> Synthetic red tests reproduced pending-ID confirmation (connection
> status 200) and first name/bio/location in a legacy connection row.
> Ordinary Members now get NOT_FOUND for status and no such partner card;
> approved private recipients and coordinator review remain available.
> Final connection suites passed 50/142, staged hook 31/73. The
> pre-amend `3298f2ffe` hash is obsolete. **No push, merge, deployment,
> hosted C1 retest or DPO acceptance; C1 OPEN.**

> **8 October 23:27 Dublin C1 numeric-ID connection follow-on:** NEXUS
> `codex/c1-pending-profile` now has local tip `7d6059b5a`, three commits
> above fetched `origin/main` `05c17bf94`. Red synthetic route test
> proved an ordinary Member could create a connection request to a
> pending registrant by guessed/forwarded ID (HTTP 201). The service now
> checks active/approved/tenant state under its locked user rows, before
> creation; both pending and active-but-unapproved targets receive a
> generic refusal without a new connection. Controller/service suites
> passed 47/130, staged hook 28/61. **Unpushed, unmerged, undeployed; C1
> OPEN.** No live, original closure or Nikita acceptance proof followed.

> **8 October 23:24 Dublin C1 additional local route fix:** The separate
> NEXUS `codex/c1-pending-profile` branch now has tip `a6e90fd62`, two
> commits above fetched `origin/main` `05c17bf94`; `cfdc4e00f` below is
> its first commit. Red synthetic tests reproduced an ordinary Member 200
> for a pending target's activity dashboard and pending/unapproved entries
> in connection suggestions. The shared by-ID profile gate and raw
> suggestion query now require an active, approved target for ordinary
> viewers. Activity, availability, suggestion and main-profile suites
> passed 85 tests/195 assertions; staged hook passed 27/45 twice. Branch
> clean and **unpushed, unmerged, undeployed**. C1 remains OPEN; hosted
> synthetic retest, original closure evidence, risk-owner and DPO review
> remain outstanding. Private receipt and NEXUS register E-098/F-573 hold
> detail. The older 23:17 source checkpoint below remains valid for its
> first commit but is not the current branch tip.

> **8 October 23:17 Dublin C1 source continuation, local only:** The
> separate clean NEXUS branch `codex/c1-pending-profile` now points to
> `cfdc4e00f` (one commit above fetched `origin/main`), superseding the
> `a276322a0` hash below. It extends the pending/unapproved profile guard
> to member search, ordinary and ranked directories, nearby results and
> mention autocomplete. A stale search-index result containing no eligible
> hit falls back to current SQL so an approved member remains findable.
> Final local affected suites passed 83 tests/231 assertions with three
> skips; the explicit staged hook passed 64/190, schema-skip and credential
> gates. The branch is **unpushed, unmerged and undeployed**. Private NEXUS
> security register E-098/F-573 and CharityPilot C1 receipt hold the
> details. No hosted retest, C1 verification row or Nikita acceptance followed.

> **8 October 21:59 UTC DPO-02 connector failure path, source local only:**
> Commit `437dabdc` clears the exact MCP connector credential after a
> thrown refresh request or ambiguous HTTP outcome; a later process
> cannot offer the possibly spent token when the store clears normally.
> The full connector suite passed 413 tests with two existing skips, and
> an isolated real-API test proved committed rotation, client response
> loss, one refresh attempt and zero added replay events. This is
> **unpushed and undeployed**. The historical connector event remains
> unattributed; risk-owner/Nikita incident review is open. Private
> receipt: `.charitypilot-private/replay-connector-uncertain-response-2026-10-08.md`.

> **8 October 21:54 UTC DPO-02 failure-path mitigation, source local only:**
> Commit `3be71c53` extends the Web Lock sign-out mitigation with a
> noncredential reauthentication fence after ambiguous logout or refresh
> response loss. Renewal fails closed without Web Locks or usable shared
> storage. Thirty focused web tests and three isolated PostgreSQL/
> Chromium browser cases passed, including server-spent/browser-stale
> cookies and zero added replay audit rows. This is **unpushed and
> undeployed**. The nine historic live events, especially the connector
> case, remain unattributed and require risk-owner/Nikita disposition.
> Private receipt: `.charitypilot-private/replay-uncertain-response-fence-2026-10-08.md`.

> **8 October 21:37 UTC DPO-02 logout/refresh race, source local only:**
> Browser refreshes already shared a cross-tab Web Lock; sign-out did not.
> Local `master` commit `ebf72ebd` holds the same lock through logout and
> noncredential completion signalling. A disposable PostgreSQL/Chromium
> two-tab journey held the logout response after server revocation and
> triggered a second-tab 401: zero refresh POSTs and zero new replay
> events. Twenty-eight focused unit tests, web production build, edited
> lint and E2E typecheck pass. The fix is **unpushed and undeployed**.
> The nine historical events, particularly the MCP connector event,
> remain unattributed and require risk-owner/Nikita incident disposition.
> Private receipt: `.charitypilot-private/replay-logout-lock-2026-10-08.md`.

> **8 October 21:28 UTC restricted runtime database role, private VM:** A
> pinned read-only check on serving green `96c8b1e8` confirmed active
> API/web/scheduler configuration names `cp_runtime`, and actual SQL
> `current_user` from the API and scheduler is `cp_runtime`. Eleven
> restrictive login/database/schema flags passed; the role had no
> memberships, public-object or database ownership, or unexpected
> executable SECURITY DEFINER functions. All 12 named protected tables
> had SELECT and no write-like grant. This is point-in-time evidence on
> the private VM, not a public-production or independent DPO sign-off.
> Exact private receipt: `.charitypilot-private/live-runtime-role-current-2026-10-08.md`.

> **8 October 21:25 UTC C1 audience fix strengthened; source local only:**
> Synthetic NEXUS staging `2ff23039c` returned HTTP 200 to an ordinary
> same-tenant Member for a pending registrant's numeric profile, exposing
> first name and location, while anonymous and foreign-tenant requests were
> denied and private contact/DOB fields were absent. A local NEXUS branch
> `codex/c1-pending-profile` commit `a276322a0` now guards both non-active
> and active-but-unapproved profiles from ordinary Members, with approved
> staff and activation controls tested (full profile suite 57/136; native
> producer inventory 237 calls; schema-skip and staged credential checks
> passed). The worktree's generated Git hook shim was absent; the scoped
> tests and checks were run explicitly, not through that shim. The branch
> is **unpushed, unmerged and undeployed**; hosted
> behavior remains the staging finding. Product/risk-owner and Nikita
> review, CI/release-bound retest and the original C1 closure evidence are
> pending. CharityPilot C1 stays OPEN with zero verification rows. Full
> private evidence: `.charitypilot-private/c1-pending-profile-access-2026-10-08.md`.

> **8 October minimised aggregate release, DPO acceptance OPEN:** PR #55
> exact head `67948218` passed CI `37834828825`, E2E `37834828822`
> and Greptile, then merged as master `96c8b1e8`. Exact merged-master
> CI `37836687158` and E2E `37836687440` passed. A guarded private-VM
> blue-green cutover put green live at `96c8b1e8` with blue rollback;
> restricted runtime role, protection guards, profile parity and both
> loopback/Tailscale health and login passed. Deploy backup set
> `2026-10-08T20-17-32-892Z` passed isolated restore and same-host
> three-file hash matching. The correction counts an unrecorded snapshot
> standard as NOT STARTED in the minimised draft. The reviewed tenant
> still has zero genuine approved Board snapshots, zero approved
> VAULT_DRAFT policies, nine historical session-replay events and zero
> risk-control verifications. Real report audience/field acceptance,
> independent recovery, retention/erasure decisions, replay/C1 review and
> Nikita's independent sign-off remain open. Jasper kept the temporary
> Member active for more testing. Private receipt:
> `.charitypilot-private/release-96c8b1e8-minimised-count-2026-10-08.md`.

> **Earlier 8 October source checkpoint, superseded by release above:** The
> minimised draft aggregate previously skipped snapshot standards with no
> record, while the full report rendered them as NOT STARTED. A focused
> regression reproduced that discrepancy; branch
> `codex/minimised-report-missing-status` counts them as NOT_STARTED and
> passes 9/9 focused export tests and API TypeScript checking. This is source
> evidence pending PR/CI/merge and, if released, live verification. The
> reviewed tenant has no genuine Board-approved snapshot; field-by-field
> controller/DPO acceptance and external-disclosure authority remain open.
> Private field review: `.charitypilot-private/minimised-export-field-review-2026-10-08.md`.

> **8 October live Member certificate test, acceptance still open:**
> With Jasper's exact-file controller approval and separate upload/access
> confirmations, Owner created `cmuzx67s40006o901zappjqgm` as a local
> Vault copy, verified its 120,955 bytes, classified it HISTORICAL with
> a reason, and granted MEMBER_SUITABLE / MEMBER_VISIBLE. A guarded live
> database read and control/visibility audits confirmed these changes;
> the old null-provider row `cmtfks26m003ypb01ao66i8gk` remained
> restricted/unassessed. The separate smaller scan was not approved.
> There are 75 active Vault rows. A separate signed-in in-app session
> showed `Jasper test account.` as Member in Team. Its Vault listed only
> the reviewed certificate; the restricted legacy row was absent. The
> authenticated Member download returned HTTP 200 PDF, 120,955 bytes and
> SHA-256 `85b24b00d4302a50f3de18d842ac0009b9002511090acd7dc1a8b6d68c602d1e`,
> matching the controller-approved source. The read-only audit reread
> recorded MEMBER_VISIBLE download preparation. Direct negative
> navigation was blocked by the browser client before an HTTP response;
> no live server-side 404 is claimed. Complete that check through a
> supported path if possible. Jasper explicitly chose to keep the
> temporary Member active for further testing; its removal dialog was
> cancelled. No public/Confluence publication or
> independent Nikita acceptance is inferred. Exact private receipts:
> `.charitypilot-private/member-certificate-candidate-review-2026-10-08.md`,
> `read-only-new-certificate-postgrant-20261008.txt`, and
> `read-only-certificate-audit-postmember-20261008.txt`.

> **8 October post-grant recovery checkpoint:** A guarded standalone
> blue-green backup after the live certificate grant produced set
> `2026-10-08T19-29-08-832Z`. The isolated newest-set restore drill
> passed with 75 document rows and 156 migrations. All three set files
> copied to the established workstation backup path matched VM hashes.
> This is still on one physical host; independent host-loss recovery,
> approved retention/disposal and restored-application reopening remain
> open. Private receipt:
> `.charitypilot-private/post-member-backup-acceptance-2026-10-08.md`.

> **8 October historical-document lifecycle release (Member acceptance
> open):** PR #52 added a reasoned DRAFT-to-HISTORICAL transition for
> uploaded dated evidence, without relaxing provider, byte-review,
> content-assessment, Member-visibility or publication gates. Its exact
> head passed CI `37823760144`, E2E `37823759791` and review. Squash-
> merged master `1d9a9d0066cbe9911c1db9b20e42d82ed671517f` passed
> CI `37825550618` and E2E `37825550637`. A guarded private-VM blue
> cutover, restricted-runtime/profile postflight, copied SHA-matched
> recovery set and isolated restore drill passed. The copy is on the
> same physical host, so independent host-loss recovery remains open.
> The reviewed charity still had 74 Vault rows, zero approved snapshots,
> zero approved VAULT_DRAFT policies, nine historical replay events and
> zero risk-control verifications. Jasper approved the exact reviewed
> incorporation certificate's all-Member audience as controller, but
> **no certificate was uploaded or made Member-visible** at the release
> checkpoint. The old null-provider row remains restricted; a supported
> new exact-byte upload, truthful historical classification, authenticated
> byte review, content assessment, separate access-grant confirmation,
> live Member positive/negative tests and Nikita's independent review are
> still required. Exact private receipts:
> `.charitypilot-private/release-1d9a9d00-historical-lifecycle-2026-10-08.md`
> and `.charitypilot-private/member-certificate-candidate-review-2026-10-08.md`.

> **8 October DPO MFA scope decision (public gate open):** Jasper confirmed
> personal opt-in MFA for the current private working demo and mandatory
> Owner/Admin MFA before public multi-tenant reliance, consistent with
> Nikita's 30 September scoped advice. A guarded read-only query of the
> reviewed private VM found no enrolled factor among its active Owner,
> Admin or temporary Member accounts; no account was changed. This is a
> current operating choice, not implementation of role-wide enforcement.
> Lost-all-factors recovery, key rotation, actual enrollment, public role
> journeys and independent Nikita acceptance remain open. Exact count and
> decision evidence stay in the gitignored private MFA pack.

> **8 October Member Vault copy release (live wording checked):** PR
> #49 merged as `679dd1bdd3d3ced29dd5fc707cd122922336bd01` after exact
> merged-master CI `37812122754` and E2E `37812122603` passed. A guarded
> private-VM green cutover completed at 17:05:40 UTC, retaining blue
> `9696fb5b` for rollback. Initial/final postflight, two same-host copied
> and SHA-matched backup sets, and two isolated restore drills passed;
> final backup inventory was 420 files with prior hashes unchanged. The
> role-specific Vault empty-state wording was then observed in the
> signed-in temporary Member's live `/documents` page: zero available
> documents and `No documents available to you` with the access-level
> explanation. Direct `/export` still withheld the internal report. This
> is one UI role check, not a direct API probe. The release did not
> change visibility rules, approve a real file for Members, settle policy
> or establish Nikita's acceptance. Private receipt:
> `.charitypilot-private/release-679dd1bd-member-vault-copy-2026-10-08.md`.

> **8 October Member report-navigation release (DPO acceptance open):** PR
> #47 merged as `9696fb5b7e344975210e38de08ec040a22fcde11` after
> exact merged-master CI `37805072036` and E2E `37805072114` passed.
> A guarded private-VM blue cutover completed at 16:12:46 UTC; green
> `937b8b9a` remains the rollback colour. Final postflight proved restricted
> runtime roles, configured profile parity, database guards and health on
> loopback and the exact Tailscale origin. In the signed-in temporary Member
> browser, dashboard report/export and sign-off actions, sidebar Export,
> and regulator Export Pack were absent; direct `/export` still withheld
> the full internal report. This is live UI evidence for one Member, not
> direct API probing or a positive classified-document download. Two new
> backup sets copied to the same physical host matched remote SHA-256 and
> passed isolated restore; final 414-file inventory was unchanged. These
> copies do not prove independent VM-loss recovery. The reviewed charity
> still has zero approved report snapshots or approved VAULT_DRAFT policies.
> Real-record classification, recipient review, historical replay/C1
> disposition, policy and independent recovery, temporary Member removal
> and Nikita's sign-off remain open. Exact private receipt:
> `.charitypilot-private/release-9696fb5b-member-navigation-2026-10-08.md`.

> **8 October signed-in live Member UI checkpoint (acceptance open):**
> Jasper used the accepted temporary Member account in the reviewed
> private VM through Codex's in-app browser. Team identified the account
> as `Member`. The Board page displayed only ordinary trustee evidence
> fields; the Vault listed zero available documents. The full report,
> Governance Audit, Minute Book and charity-wide Security & Data panels
> withheld content. Registers showed risk summaries and fundraising
> status while withholding conflicts, complaints and detailed risk notes.
> The in-app browser blocked direct `/api/v1` navigation, so this is UI
> evidence, not a live API 403 matrix. Nikita must assess whether Team
> names/roles and risk summary fields suit this Member audience. A
> positive real-file download requires exact-byte classification first;
> temporary-account cleanup and independent DPO acceptance remain open.
> Private receipt: `.charitypilot-private/member-live-ui-2026-10-08.md`.

> **8 October synthetic minimised-export workflow (real acceptance open):**
> In the isolated C01 tenant, the Owner filled three missing standard
> explanations and the conditional profile with labelled synthetic data.
> The UI then saved test-only approved snapshot #1 and exposed `Open
> minimised draft for audience review`; clicking it opened a tab titled
> `Minimised Compliance Record draft`. Browser policy blocked inspection
> of that local `blob:` tab, so its exact fields were not observed in this
> browser run. Eight focused API export tests passed separately, including
> snapshot verification and omission of narrative/approver particulars.
> The reviewed hOUR tenant still has no approved Board snapshot. A genuine
> Board decision, field-level recipient review and Nikita acceptance remain
> open. Exact private receipt:
> `.charitypilot-private/minimised-export-c01-2026-10-08.md`.

> **8 October C01 restored attachment bytes (DPO-05 still open):** A
> signed-in download from the restricted Confluence sandbox returned the
> restored `att524289` attachment as 243 bytes. Its SHA-256 was
> `148bb885a9cbafe13cab35c131d11eb9d60d1a701fca3881eff8dd8e48829242`,
> matching the original synthetic upload digest. The exact downloaded
> bytes are retained in the ignored private C01 evidence folder. This
> closes the earlier restored-byte equality gap for that one attachment;
> it does not exercise permanent erasure, prove all-copy reconciliation,
> authorize a retention decision, or establish Nikita acceptance. See
> `.charitypilot-private/c01-runtime/README.md` for the bounded receipt.

> **8 October live Member prerequisite and profile release (acceptance open):**
> A user-controlled, temporary Member invitation was accepted in the
> reviewed hOUR Timebank CLG workspace. A read-only VM check confirmed the
> accepted MEMBER invite and matching User; the Owner Team page listed it.
> The API had been configured for manual invitation links while the web
> build omitted the matching public profile flags, discarded a one-time
> link and showed an email-sent toast. CharityPilot sent no email: the
> replacement link was delivered through Jasper's separate Gmail account.
> Its first version was invalidated after appearing in browser tool output;
> the correction email's link was accepted. PR #42 fixed blue-green web/API
> profile parity and inline-comment parsing. Exact PR-head CI, E2E and
> review passed; merged master `937b8b9a` passed CI `37776127169` and E2E
> `37776126994`. A guarded green private-VM cutover passed final web/API
> profile, restricted-runtime, loopback/Tailscale, 408-file backup inventory
> and two SHA-matched copied/isolated-restored recovery sets. The prior
> 402 backup hashes were unchanged. Private exact receipt:
> `.charitypilot-private/release-937b8b9a-email-profile-2026-10-08.md`.
> A signed-in live Member route/UI matrix, real Vault classification and
> positive reviewed-file check, temporary-account cleanup, independent
> host-loss recovery and Nikita acceptance remain OPEN. This private-profile
> release is not public-production evidence.

> **Later 8 October isolated positive Member Vault check (acceptance still open):**
> In the disposable C01 tenant, the synthetic Owner uploaded a 95-byte
> plain-text fixture, downloaded its exact bytes to create the review
> receipt, and classified it CURRENT / MEMBER_SUITABLE / MEMBER_VISIBLE.
> A synthetic Member then saw the one reviewed fixture and downloaded it
> with HTTP 200; the returned bytes matched the fixture SHA-256 digest.
> The same Member's restricted synthetic Vault download remained a
> concealing 404. The test Member was removed through the supported
> lifecycle service. This is isolated API evidence, not classification
> of real records, live VM/Member UI proof or Nikita acceptance. Exact
> receipt: `.charitypilot-private/member-boundary-isolated-2026-10-08.md`.

> **Later 8 October isolated Member route check (acceptance still open):**
> In the disposable C01 CharityPilot tenant, a synthetic Member signed in
> through the application service and received a three-trustee minimal
> view, with no address, birth date, email or phone keys. Its Vault list
> had zero of five Owner-visible documents. The Member received 403 for
> statutory membership, conflicts, complaints, deleted items, document
> control audit, governance audit and full Compliance Record; an exact
> retired/restricted synthetic Vault download returned a concealing 404.
> A synthetic Owner control received 200 on every compared route. Five
> temporary synthetic Member accounts were removed through the supported
> lifecycle service, leaving no active test sessions. This is isolated
> API evidence from the C01 snapshot, **not** a live VM/Member UI check
> or Nikita acceptance. A later isolated positive fixture test is above. Private
> matrix: `.charitypilot-private/member-boundary-isolated-2026-10-08.md`.

> **Later 8 October C01 sandbox restoration (goal still open):** With Jasper's
> specific approval, only synthetic page `491521` was restored from
> recoverable Trash into restricted `CPC01SYN`. The sandbox Trash then had
> no items. A live Confluence v2 read returned `status=current`, version 2,
> and attachment inventory `[att524289]`; while trashed, the same page's
> attachment list had returned `[]`. The isolated CharityPilot tenant's
> read-only reconciliation recorded `PROCESSED|VISIBLE|2|` with no error.
> No permanent purge or erasure worker ran. Earlier notes below saying the
> page remains trashed describe prior checkpoints. This restores current
> attachment visibility for one synthetic page; retained published Vault
> disposal, all-copy/UNKNOWN evidence, controller policy, independent
> recovery and Nikita acceptance remain open. Private exact receipt:
> `.charitypilot-private/c01-runtime/README.md`.

> **8 October verified C01 v2 trash source release:** PR #38 revised head
> `bc97b1b6` passed exact CI `37758626399`, E2E `37758626354` and
> automated review after two fail-closed corrections. Merged master
> `32a09fc1` passed CI `37760142983` and E2E `37760143036`, then a
> guarded private-VM cutover moved serving to blue at `32a09fc1`.
> Restricted runtime, loopback/Tailscale health/login, protected count and
> trigger checks, preservation of all 396 preceding backup SHA/path
> entries, SHA-matched workstation copies of two new recovery sets and
> isolated restores of both (156 migrations, 68 documents) passed. Final
> inventory held 402 unchanged entries. The deployed code recognises v2
> `status=trashed`, marks malformed reads per-page UNKNOWN and refuses
> permanent erasure of an already-trashed page without a complete current
> attachment inventory. Synthetic Confluence page `491521` remains in
> recoverable sandbox Trash; **no purge or real erasure worker ran**.
> Production has zero Confluence integration/publication rows. The private
> receipt is `.charitypilot-private/release-32a09fc1-c01-v2-trash-2026-10-08.md`.
> C01/DPO-05 retained-document disposal, all-copy/unknown outcomes,
> controller policy, independent recovery and Nikita acceptance remain OPEN.
> Earlier uncommitted/undeployed checkpoints below are dated history.

> **Later 8 October C01 real sandbox correction, source only:** A separate
> loopback synthetic CharityPilot tenant published a 243-byte fixture to
> restricted Confluence sandbox space `CPC01SYN` (page `491521`, attachment
> `att524289`). Provider UI confirmed the attachment hash; a synthetic
> external edit raised the page to version 2. The source Document was
> classified RETIRED, withdrawing approval; the page was moved to
> recoverable Trash, **not purged**. Real v2 page GET returned HTTP 200
> with `status=trashed`; v2 `?status=trashed` also worked, while the old v1
> trash endpoint returned 410. The deployed reader incorrectly reported
> VISIBLE. Branch `codex/c01-v2-trash-readback` changes normal/status-
> filtered readback and the fake provider; API build and 160 focused tests
> pass. The patched disposable runtime read-only probe and reconcile
> observed TRASHED version 2. **Uncommitted and undeployed** at this
> checkpoint. A retained formerly published Document still has no
> supported disposal/erasure request journey. Private exact receipt:
> `.charitypilot-private/c01-runtime/README.md`. C01/DPO-05, policy,
> historical copies, independent review and Nikita acceptance remain OPEN.

> **PR #38 review follow-up, later 8 October:** Automated review found that
> an invalid provider status could stop a reconciliation batch and that
> treating a trashed page as absent could skip the eraser's attachment
> preflight. The revised source records such malformed page reads as
> per-page UNKNOWN and continues. It refuses permanent erasure of an
> already trashed page until the page is restored and its current attachment
> inventory can be checked. Live synthetic trash-page attachment listing
> returned an empty list despite an earlier attached file, confirming that
> list is not safe as completeness proof. This is fail-closed source work,
> pending revised PR tests/CI/review and release; no purge was attempted.

> **8 October current-page attachment preflight release:** PR #35 revised
> head `0190fe88` passed exact CI `37740754874`, E2E `37740754893` and
> automated review after a later-page regression was added. Merged master
> `213707913b1892279bc8f340a8cf55d11e682e44` passed CI `37742234421`
> and E2E `37742234386`. A guarded private-VM release moved serving from
> blue `05d4d975` to green `21370791`; postflight, loopback/Tailscale checks,
> restricted runtime, two SHA-matched workstation backup copies and two
> isolated restores passed. All 390 prior backup SHA/path entries were
> preserved; final inventory has 396 unchanged entries. The new preflight
> refuses an unrecorded attachment found anywhere in the current page's
> paginated list before delete/purge. It does not reconcile historical,
> already trashed, backup or UNKNOWN copies, and no real Confluence provider
> test or DPO acceptance occurred. A separate Confluence-only sandbox is
> online and marked Never copied from production. It contains Atlassian
> starter content and a restricted synthetic space (`CPC01SYN`). Its Users
> list includes two Atlassian app principals as Admin. The separate
> CharityPilot test tenant, OAuth connection and C01 first-contact exercise
> remain open. See the
> private ignored release receipt
> `.charitypilot-private/release-21370791-current-inventory-2026-10-08.md`
> and C01 decision sheet for identifiers.
> DPO-05, C01–C05/P01–P09/MFA, independent P05/P08, Member/export/deletion,
> replay/C1 and Nikita acceptance remain OPEN.

> **8 October verified `05d4d975` private-VM release:** PR #33 revised head
> `24d5a6f7` passed exact CI `37732949371`, E2E `37732949376` and
> automated review after correcting the v2 trash-read and cancelled
> pagination findings. Merged master `05d4d975` passed exact CI
> `37733998701` and E2E `37733998665`. Guarded blue cutover,
> restricted-runtime/front-door/zero-row postflight, preservation of all
> 384 earlier backup hashes, SHA-matched workstation copies of deployment
> and post-activation sets, and isolated restores of both (156 migrations,
> 68 documents) passed. Final 390-file backup inventory was unchanged after
> restore. Private receipt:
> `.charitypilot-private/release-05d4d975-erasure-readback-2026-10-08.md`.
> The eraser now checks recorded page and attachment IDs after purge using
> direct and trash reads, with bounded, cancellable pagination. This is not
> real provider proof or complete copy discovery. DPO-05 all-copy/UNKNOWN,
> C01–C05/P01–P09/MFA, independent P05/P08, Member/export/deletion,
> replay/C1 and Nikita acceptance remain OPEN. Older checkpoints below are
> dated history.

> **8 October verified `2f7aec1d` private-VM release:** PR #31's
> Confluence erasure-request stamp guard passed exact-head and merged-master
> CI/E2E and automated review. Guarded green cutover, restricted runtime,
> trigger/migration postflight and both front doors passed. All 378
> precutover backup-file hashes were preserved; deployment and
> post-activation sets were copied to the workstation with matching hashes.
> Isolated restores passed for the 155-migration pre-upgrade and
> 156-migration current sets, each with 68 documents. Blue `58bfc20f` is
> previous. Private receipt:
> `.charitypilot-private/release-2f7aec1d-erasure-stamp-2026-10-08.md`.
> This makes the first Confluence erasure stamp immutable but does not
> authorize provider purge. DPO-05 all-copy/UNKNOWN, C01-C05/P01-P09/MFA,
> independent P05/P08, Member/export/deletion, replay/C1 and Nikita
> acceptance remain OPEN. Older checkpoints below are dated history.

> **8 October verified `58bfc20f` private-VM release:** PR #29's
> read-only Confluence saved-page marker candidate passed exact PR-head and
> merged-master CI/E2E plus automated review. Guarded blue cutover,
> restricted-runtime/zero-row postflight, both front doors, preservation of
> 375 precutover backup hashes, SHA-matched workstation copy, isolated
> 155-migration/68-document restore and repeat postflight passed. Green
> `bd804986` is previous. Private receipt:
> `.charitypilot-private/release-58bfc20f-page-marker-observer-2026-10-08.md`.
> The observer has no production caller or real Confluence provider use;
> a marker match is non-authorizing. C01-C05/P01-P09/MFA, DPO-05
> all-copy/UNKNOWN, independent P05/P08, Member/export/deletion,
> replay/C1 and Nikita acceptance remain OPEN. Older checkpoints below
> are dated history.

> **8 October verified `bd804986` private-VM release:** PR #27's opt-in
> synthetic Confluence page-create body marker passed exact PR-head and
> merged-master CI/E2E plus automated review. Guarded green cutover,
> restricted-runtime/zero-row postflight, both front doors, preservation of
> 372 precutover backup hashes, SHA-matched workstation copies of both new
> sets, isolated 155-migration/68-document restore and repeat postflight
> passed. Blue `2dd0a427` is previous. Private receipt:
> `.charitypilot-private/release-bd804986-page-marker-probe-2026-10-08.md`.
> Production scheduler callers do not enable the marker and there has been
> no real Confluence call. DPO-05 all-copy/UNKNOWN, C01-C05/P01-P09/MFA,
> independent P05/P08, Member/export/deletion, replay/C1 and Nikita
> acceptance remain OPEN. Older checkpoints below are dated history.

> **8 October verified `2dd0a427` private-VM release:** PR #25's
> page-create operation-ID source prerequisite passed exact merged-master
> CI `37713125501` and E2E `37713125382`, then guarded blue cutover,
> restricted-runtime/zero-row postflight, both front doors, preservation of
> 366 prior backup hashes, SHA-matched workstation copy, isolated
> 155-migration/68-document restore and repeat postflight. Green
> `e566870d` is previous. Private receipt:
> `.charitypilot-private/release-2dd0a427-page-create-id-prerequisite-2026-10-08.md`.
> The outbound page body has no provider-visible marker and there has been
> no real Confluence call. DPO-05 all-copy/UNKNOWN, C01–C05/P01–P09/MFA,
> independent P05/P08, Member/export/deletion, replay/C1 and Nikita
> acceptance remain OPEN. Older checkpoints below are dated history.

> **8 October verified `e566870d` private-VM release:** PR #23's
> saved-intent Confluence page content-candidate observer passed exact
> PR-head and merged-master CI/E2E plus automated review, then guarded green
> cutover, restricted-runtime/zero-row postflight, both front doors,
> preservation of 363 earlier VM backup hashes, SHA-matched three-file
> workstation copy, isolated 155-migration/68-document restore and repeat
> postflight. Blue `c98c26fb` is previous. Private receipt:
> `.charitypilot-private/release-e566870d-saved-page-candidate-2026-10-08.md`.
> This reader has no production caller or provider use; content similarity
> is not exact operation identity. DPO-05 all-copy/UNKNOWN, C01–C05/P01–P09/
> MFA, independent P05/P08, Member/export/deletion, replay/C1 and Nikita
> acceptance remain OPEN. Older checkpoints below are dated history.

> **8 October verified `c98c26fb` private-VM release:** PR #21's inert
> Confluence page-storage/parent reader passed exact updated-head CI/E2E
> and automated review, then exact merged-master CI `37702538043` and E2E
> `37702538021`. Guarded blue cutover, restricted-runtime/zero-row
> postflight, both front doors, preservation of all 360 earlier VM backup
> hashes, SHA-matched workstation copy of the three new files, isolated
> 155-migration/68-document restore and repeat postflight passed. Green
> `3f137c36` is previous. Private receipt:
> `.charitypilot-private/release-c98c26fb-page-storage-readback-2026-10-08.md`.
> The reader has no production caller or provider use. DPO-05 exact page
> identity/all-copy/UNKNOWN, C01–C05/P01–P09/MFA, independent P05/P08,
> Member/export/deletion, replay/C1 and Nikita acceptance remain OPEN.
> Older checkpoints below are dated history.

> **7 October verified `3f137c36` private-VM release:** PR #19's
> title-only Confluence page-adoption fence passed exact PR-head CI/E2E and
> automated review, then exact merged-master CI `37695270803` and E2E
> `37695271218`. Guarded green cutover, restricted-runtime/zero-row
> postflight, both front doors, preservation of all 357 prior VM backup
> hashes, SHA-matched three-file workstation copy, isolated 155-migration/
> 68-document restore and repeat serving postflight passed. Blue
> `a0ab2d0e` is previous. An unrecorded title match now refuses document
> bytes; a 409 after committed page-create reservation stays UNKNOWN.
> Private receipt: `.charitypilot-private/release-3f137c36-title-adoption-fence-2026-10-07.md`.
> No real provider first contact, exact page identity, all-copy/UNKNOWN
> resolution, independent P05/P08 host-loss, controller/MFA, Member/export/
> deletion, replay/C1 or Nikita acceptance follows. Older checkpoints below
> are dated history.

> **7 October verified `a0ab2d0e` private-VM release:** PR #16's immutable
> local Confluence page-create intent, bounded copy digest and unresolved-
> page purge fence passed exact merged-master CI `37688978306` and E2E
> `37688978258`. Guarded blue cutover, restricted runtime, zero protected
> and publication rows, enabled page-intent guard/purge fence, both front
> doors, all 354 prior VM backup hashes, three SHA-matched workstation
> copies and isolated 154-migration/68-document restore with repeat serving
> postflight passed. Green `edc9e15d` is previous. Thirteen backup sets were
> flagged for approved age review; none were deleted. Private exact receipt:
> `.charitypilot-private/release-a0ab2d0e-confluence-page-create-intent-2026-10-07.md`.
> No real Confluence provider call, provider-visible page identity, complete
> all-copy/UNKNOWN outcome, retry or erasure authority follows. DPO-05,
> C01–C05/P01–P09, privileged MFA, independent P05/P08 host-loss,
> Member/export/deletion, replay/C1 and Nikita acceptance remain OPEN.
> Older release checkpoints below are dated history.

> **7 October verified `edc9e15d` private-VM release:** PR #15's bounded
> local-copy observation includes immutable Confluence attachment-upload
> intents and advances its digest format so older leases/facts fail closed.
> Exact merged-master CI `37685855309` and E2E `37685855311` passed.
> Guarded green cutover, restricted `cp_runtime` roles, zero protected and
> publication rows, enabled upload-intent guard, both front doors, all 351
> prior VM backup SHA/path entries, three SHA-matched workstation copies and
> isolated 153-migration/68-document restore with repeat serving postflight
> passed. Blue `c4e5040d` is previous. The deployer flagged 13 older backup
> sets for approved age review and deleted none. Private exact receipt:
> `.charitypilot-private/release-edc9e15d-confluence-upload-intent-observation-2026-10-07.md`.
> There was no real Confluence provider use; this adds no all-copy proof,
> UNKNOWN disposition, retry or erasure authority. DPO-05, C01–C05/P01–P09,
> privileged MFA, independent P05/P08 host-loss, Member/export/deletion,
> replay/C1 and Nikita acceptance remain OPEN. Older release checkpoints
> below are dated history.

> **7 October verified `c4e5040d` private-VM release:** PR #12's bounded
> repeat Confluence attachment-version observation passed exact PR and
> merged-master CI/E2E (240 browser tests on merged master). Guarded blue
> cutover, restricted runtime/zero protected and publication rows, both
> front doors, preservation of all 348 prior VM backup hashes, three
> SHA-matched workstation files and isolated 153-migration/68-document
> restore with repeat serving postflight passed. The observer remains inert:
> no production caller, real provider use or operation binding. Private
> receipt: `.charitypilot-private/release-c4e5040d-confluence-repeat-observation-2026-10-07.md`.
> DPO-05, all-copy/UNKNOWN outcome, independent P05/P08 host-loss,
> controller/MFA, Member/export/deletion, replay/C1, disposable test-site
> and Nikita acceptance remain OPEN. Older release checkpoints below are
> dated history.

> **7 October verified `9f495a15` private-VM release:** Exact merged-master
> CI `37658637396` and E2E `37658637505` passed. Guarded green cutover,
> corrected serving postflight, restricted runtime and zero protected
> rows, loopback/Tailscale checks, preservation of all 345 prior VM
> backup hashes, three SHA-matched workstation files and isolated
> 153-migration restore with repeat serving postflight passed. Confluence
> attachment-version metadata and explicit-version byte-hash readers are
> deployed but have no production caller or provider use. Private receipt:
> `.charitypilot-private/release-9f495a15-confluence-version-readback-2026-10-07.md`.
> DPO-05, identity-bound remote outcome/all-copy reconciliation,
> independent P05/P08 host-loss, controller/MFA, Member/export/deletion,
> replay/C1, disposable Confluence test-site and Nikita acceptance remain
> open. Older release checkpoints below are dated history.

> **7 October verified `fb90a5f2` private-VM release:** Exact merged-master
> CI `37650977087` and E2E `37650977300` passed. Guarded blue cutover,
> restricted runtime, zero protected rows, both front doors, preservation of
> all 342 prior VM backup hashes, three SHA-matched workstation files and
> isolated 151-migration restore with repeat postflight passed. The new
> committed-before-write Confluence reservation and UNKNOWN quarantine have
> zero live publication rows and no provider call. Exact private receipt:
> `.charitypilot-private/release-fb90a5f2-confluence-write-reservation-2026-10-07.md`.
> DPO-05, remote-copy/version reconciliation, independent P05/P08 host-loss,
> controller/MFA, Member/export/deletion, replay/C1, disposable Confluence
> test-site and Nikita acceptance remain open. Older release checkpoints
> below are dated history, not current serving-state claims.
>
> **7 October verified `7cd64f4b` private-VM release:** Exact hosted CI
> `37638631678` and E2E `37638631629` passed. Guarded green cutover,
> restricted `cp_runtime`, zero protected rows, both front doors, all 339
> earlier VM backup hashes, SHA-matched workstation copy of the new set,
> isolated 151-migration restore and post-restore checks passed. The new
> encrypted independent UNKNOWN publication path has no production caller,
> provider I/O, live fact or erasure result. DPO-05, independent P05/P08
> host-loss, policy/MFA, Member/export/deletion, C1/replay, disposable
> Confluence test-site and Nikita acceptance remain open. Exact private
> receipt: `.charitypilot-private/release-7cd64f4b-independent-unknown-2026-10-07.md`.

> **7 October verified `6dea7e5a` private-VM release:** Exact hosted CI
> `37633656389` and E2E `37633656362` passed. Guarded blue cutover,
> restricted `cp_runtime`, zero protected rows, both front doors, all 336
> earlier VM backup hashes, SHA-matched workstation copy of the new set,
> isolated 151-migration restore and post-restore checks passed. The new
> committed-start UNKNOWN reader has no production caller, provider I/O or
> independent result publication. DPO-05, independent P05/P08 host-loss,
> policy/MFA, Member/export/deletion, C1/replay, disposable Confluence
> test-site and Nikita acceptance remain open. Exact private receipt:
> `.charitypilot-private/release-6dea7e5a-unknown-facts-2026-10-07.md`.

> **7 October 13:46 UTC C1 production negative:** NEXUS production API
> `/version.php` reported build `2ff23039`; unauthenticated GET for
> synthetic `/api/v2/users/0` with tenant ID 1 returned 401
> `auth_required`, no personal data and matching `X-Build`. The inspected
> CTA, auth, tenant and React guard files are identical between that
> deployed commit and source `06850f22`. This proves one deployed API
> denial, not hOUR delivered mail, logged-in Member access, frontend
> redirect or original C1 closure. C1 remains OPEN with zero verification
> rows; private `c1-cta-source-access-2026-10-07.md` has the receipt.

> **7 October C1 CTA source boundary:** A read-only trace at current NEXUS
> source `06850f22` found the ordinary registration notice's numeric-ID
> `/profile/{id}` link behind React login and an authenticated,
> resolved-tenant API profile read with privacy checks. The link is not
> Admin-only: a same-tenant signed-in Member may view a visible public
> profile. The pending-approval CTA uses the Admin queue or broker list.
> This is source evidence, not deployed-route or delivered-mail proof.
> No PHP runtime test, risk-owner decision or C1 verification row follows;
> keep C1 OPEN. Exact hashes and limits are in private
> `c1-cta-source-access-2026-10-07.md`.

> **7 October ~14:19 Dublin C1 read-only evidence:** Exact live
> `cdece785` still has one C1 risk OPEN at revision 2 and zero control
> verification rows. Current NEXUS source `4af219ee` retains the May
> notification fix; all 132 ordinary/pending registration-notice fields
> across 11 locales have no dynamic token beyond `community`. This is
> source scope only, not production recipient delivery, CTA access proof
> or the original closure receipt. The risk-owner/Nikita decision remains
> pending. See private `c1-evidence-recheck-2026-10-06.md` and
> `c1-decision-for-review-2026-10-06.md`.
>

> **7 October ~14:11 Dublin verified `cdece785` release:** Exact hosted
> CI `37624657895` and E2E `37624658032` (240 browser checks) passed.
> Guarded green private-VM cutover, restricted runtime, zero protected
> rows, both front doors, all 330 prior backup hashes, six SHA-verified
> workstation copies and isolated 151-migration restore with 68 documents
> and zero leases/attempts passed. Blue `e3f9d9e4` is previous. The
> checked provider-start composition has no production caller, provider
> I/O or byte authority; a committed marker requires UNKNOWN
> reconciliation. Approved final facts/inventory, worker/results,
> all-copy, independent P05/P08 host-loss, P01–P09/MFA, Member/export/
> deletion, replay/C1, Confluence test-site and Nikita acceptance remain
> open. Exact private receipt:
> `.charitypilot-private/release-cdece785-provider-start-composition-2026-10-07.md`.
> The source-only checkpoint below is dated history.
>

> **7 October ~13:55 Dublin source-only provider-start composition:**
> `startVerifiedDocumentByteProviderAttempt` compares the current
> authenticated independent decision with the claimed local lease, invokes
> the existing one-use SQL start marker, then rechecks the started marker
> and current decision. It has no production caller, provider I/O or byte
> authorization. Focused synthetic composition, API build and full 2,570
> unit plus seven PostgreSQL migration tests, separate disposable SQL
> proof, production-check (1,121 pass/four skips) and security scan pass
> locally. Exact hosted CI/E2E and guarded VM release are pending; live
> remains `e3f9d9e4`. A committed marker means possible I/O and must be
> reconciled as UNKNOWN after failure. Real approved final facts/provider
> inventory, worker/result state, all-copy and independent P05/P08 host-loss
> proof, controller/Board policy/MFA, Member/export/deletion, replay/C1,
> Confluence test-site and Nikita acceptance remain open.
>

> **7 October ~13:45 Dublin verified `e3f9d9e4` release:** Exact hosted
> CI `37621177956` and E2E `37621177985` (240 browser tests) passed.
> Guarded blue private-VM cutover, restricted runtime, zero protected rows,
> both front doors, all 324 prior backup hashes, six SHA-verified
> workstation copies and isolated 151-migration restore with 68 documents
> and zero leases/attempts passed. Green `8e88e617` is previous. The
> privileged final-decision-to-SQL claim composition has no production
> caller and returns `actionAuthorized: false`. Approved real facts,
> provider/copy inventory, worker/UNKNOWN handling, all-copy and P05/P08
> host-loss, P01–P09/MFA, Member/export/deletion, replay/C1, Confluence
> test-site and Nikita acceptance remain open. Exact private receipt:
> `.charitypilot-private/release-e3f9d9e4-atomic-byte-claim-2026-10-07.md`.
> The source-only checkpoint below is dated history.
>
> **7 October source-only DPO-05 privileged claim composition:**
> `claimVerifiedDocumentByteExecutionLease` now requires the authenticated
> current final decision, unchanged bounded local copy/hold facts and exact
> recorded candidate binding, then inserts and consumes the protected
> one-use SQL lease in one transaction. A post-commit independent/local
> read checks the claimed result. It returns `actionAuthorized: false` and
> has no production caller or provider I/O. The final facts publisher,
> approved provider/copy inventory, worker, UNKNOWN reconciliation and
> P05/P08 host-loss proof remain absent; all other Nikita gates remain
> open. Hosted CI/E2E and VM release are pending.
>
> **7 October ~13:20 Dublin verified `8e88e617` release:** Exact hosted
> CI `37618385376` and E2E `37618385565` (240 browser tests) passed.
> Guarded green private-VM cutover, restricted runtime, zero protected
> rows, both front doors, all 318 prior backup hashes, six SHA-verified
> workstation copies and isolated 151-migration restore with 68 documents
> and zero leases/attempts passed. Blue `a9199b59` is previous. The
> post-start independent/local read always returns
> `actionAuthorized: false` and has no production worker/provider caller.
> DPO-05, all-copy, independent P05/P08 host-loss, P01–P09/MFA, Member/
> export/deletion, replay/C1, test-site connector and Nikita acceptance
> remain open. Exact private receipt:
> `.charitypilot-private/release-8e88e617-started-attempt-read-2026-10-07.md`.
> The source-only checkpoint below is dated history.
>
> **7 October source-only DPO-05 started-attempt read:** A new
> `readMatchedStartedDocumentByteDecision` rechecks the authenticated
> independent fourth-stage head and current local claimed lease after a
> durable provider-start marker, including exact marker/lease transaction,
> target and decision lineage. It still returns `actionAuthorized: false`
> and has no production worker caller. API build, full unit suite 2,570,
> seven real PostgreSQL migration tests and focused negative cases pass
> locally. Hosted CI/E2E and guarded release are pending; live remains
> `a9199b59`. Approved final facts/inventory, actual worker, UNKNOWN
> reconciliation, all-copy and P05/P08 host-loss remain open, as do all
> controller, role, historical, connector and Nikita gates.
>
> **7 October ~12:56 Dublin verified `a9199b59` release:** Exact hosted
> CI `37615526028` and E2E `37615526020` (240 browser tests) passed. The
> guarded private-VM deployment moved blue live with an append-only,
> one-use provider-start marker tied to a committed claimed exact lease.
> Restricted runtime, both migrations, zero protected rows and both front
> doors passed initial and post-restore checks. All 312 earlier backup hashes
> survived; six new files were copied and SHA-verified on the workstation.
> Isolated restore passed 151 migrations and 68 documents, with zero leases
> or attempts. Green `cac64564` is previous. No production worker calls the
> marker or provider; it records possible I/O rather than erasure. DPO-05,
> all-copy, independent P05/P08 host-loss, P01–P09/MFA, Member/export/
> deletion, replay/C1, test-site connector and Nikita acceptance remain
> open. Exact private receipt:
> `.charitypilot-private/release-a9199b59-provider-attempt-2026-10-07.md`.
> The earlier checkpoint below is dated history.
>
> **7 October ~12:15 Dublin verified `cac64564` release:** Exact hosted
> CI `37611085510` and E2E `37611085454` (240 passed), guarded green
> private-VM cutover, restricted runtime, zero protected claims/leases and
> both front doors passed. All 306 earlier backup hashes survived, six
> new workstation copies matched and isolated restore passed 150
> migrations/68 documents/zero leases. Blue `00299a59` is previous.
> The matched claimed-decision reader remains non-authorizing and unused by
> a provider worker. DPO-05, all-copy, independent P05/P08 host-loss,
> P01–P09/MFA, Member/export/deletion, replay/C1, test-site connector and
> Nikita acceptance remain open. Exact private receipt:
> `.charitypilot-private/release-cac64564-matched-claimed-byte-decision-2026-10-07.md`.
> The source-only checkpoint below is dated history.
>
> **7 October ~12:00 Dublin source-only DPO-05 pair:** Pushed
> `cac645646c8ca7e68deb966a4ea00944a7154249` adds a non-authorizing
> matched read of the current authenticated fourth-stage decision and
> consumed SQL lease, provider target and local copy/hold observations.
> Focused synthetic negative cases, full API 2,570 plus seven PostgreSQL
> migrations, build and local security scan pass. Hosted CI/E2E and guarded
> private-VM release are pending; live is still `00299a59`. No real-facts
> publisher, protected provider worker, UNKNOWN handler, all-copy proof or
> independent P05/P08 host-loss authority exists. Policy/MFA,
> Member/export/deletion, replay/C1, connector and Nikita gates remain open.
> See the private worker permit contract and goal audit for next steps.
>
> **7 October ~11:49 Dublin live post-claim observation release:** Exact
> `00299a598cbeabe096401d6d4c3245f4e10781c9` passed hosted CI
> `37607966539` and E2E `37607966538` (240 passed), guarded blue cutover,
> restricted runtime/zero protected rows, 300 unchanged prior backup
> hashes, six new SHA-verified workstation copies and isolated 150-migration
> restore with 68 documents. Green `1fae37fc` is previous. The local
> consumed-lease reader is non-authorizing and has no production caller.
> DPO-05, all-copy, P05/P08 host-loss, P01–P09/MFA, Member/export/deletion,
> replay/C1, test-site connector and Nikita acceptance remain open. Exact
> private receipt: `.charitypilot-private/release-00299a59-postclaim-local-authority-2026-10-07.md`.
> The previous release checkpoint below is dated history.

> **7 October ~11:12 Dublin live SQL claim release:** Green
> `1fae37fc343bedeb48ded1661b67f309e3dbdd1f` serves after repaired
> hosted CI `37604105082` and E2E `37604104862` (240 passed), guarded
> cutover, restricted-role/zero-lease postflight, preservation of 294 older
> backup hashes, six SHA-verified new workstation copies and isolated
> format-5 restore (150 migrations, 68 documents). Blue `cc4922b4` is
> previous. The first `77ac0547` attempt stopped safely after migration at
> a second runtime-role check; its exact cause and repair are in
> `.charitypilot-private/release-1fae37fc-one-use-byte-lease-2026-10-07.md`.
> The live SQL lease table is empty. No production final-fact binder,
> independent pre-provider check, protected provider worker or UNKNOWN
> outcome path exists. DPO-05, all-copy, P05/P08 host-loss, P01–P09/MFA,
> Member/export/deletion, replay/C1, test-site connector and Nikita review
> remain open. The source-only/failure checkpoints below are dated history.

> **7 October ~10:56 Dublin guarded release repair:** Exact `77ac0547`
> passed hosted CI `37602214934` and E2E `37602214937` (240 tests).
> Guarded private-VM deployment applied the lease migration, then stopped
> before candidate services because `verifyAppRuntimeRole` still rejected
> every reachable security-definer function. Jobs restarted on the prior
> blue `cc4922b4`; loopback health is 200 and protected lease/claim counts
> are zero. The grant script already had a narrowly checked exception, but
> this separate pre/postflight check needed the same exception. Source now
> adds it, with a 90-test local suite, security scan and a read-only run of
> the exact generated SQL against the VM returning `safe`. This repair is
> source-only until its own exact hosted CI/E2E and guarded continuation
> pass. The first deploy handle is terminal; start any repair attempt only
> after the new hosted gates. Its log is
> `.bluegreen/state/deploy-2026-10-07T09-54-39-196Z.log`.

> **7 October ~10:40 Dublin source-only one-use SQL lease:** A new
> `DocumentByteExecutionLease` migration binds an owner-installed final
> decision digest, exact candidate and deletion job, and SHA-256 of a
> one-use UUID capability. The restricted `cp_runtime` role has SELECT-only
> table access and can claim through one exact, schema-qualified security-
> definer function. A deferred constraint requires insertion and consumption
> in the same transaction; the byte fence accepts only that first exact
> job claim. There is still **no production final-decision binder, provider
> byte caller, pre-provider independent head check or UNKNOWN-result path**.
> No live lease or document deletion is authorized. Restore inventory format
> 5 includes the lease; older formats 3 and 4 remain version-separated.
> Disposable real PostgreSQL, local API 2,569 + seven migration tests,
> production-check 1,120 passes (four skips), schema validation and security
> scan passed. Exact hosted CI/E2E and deployment are pending; the private VM
> still serves `cc4922b4`. P05/P08 host-loss, all-copy, P01–P09/MFA,
> Member/export/deletion, replay/C1, connector first contact and Nikita
> review remain open. See the private worker permit contract and goal audit.

> **7 October ~10:19 Dublin local copy/hold observation release:** Exact
> `cc4922b47cd6e2974c454c92e8493ab1a91c64b2` passed hosted CI
> `37598264337` and E2E `37598264292` (240 tests). Guarded private-VM
> cutover serves blue `cc4922b4`, with green `434ded09` retained as the
> previous version. Restricted `cp_runtime`, all prior fences, empty
> protected claims/aliases, format-4 inventory and both front doors passed.
> All 285 earlier backup hashes survived, six new off-VM copies match, and
> isolated restore passed with 149 migrations. The local copy/hold digests
> are observations only: no approved final publisher, one-use SQL lease,
> worker caller, provider inventory or independent P05/P08 host-loss proof.
> All policy/MFA, Member/export/deletion, replay/C1, connector first-contact
> and Nikita acceptance gates remain open. Private exact receipt:
> `.charitypilot-private/release-cc4922b4-local-copy-hold-observation-2026-10-07.md`.
> The source-only checkpoint below is dated history.

> **7 October source-only local copy/hold observation:** The existing
> serializable document byte-authority transaction now returns distinct
> bounded digests for its local copy and hold evidence, without changing
> its original full digest or `actionAuthorized: false`. Unit and disposable
> PostgreSQL tests show stable reads and a changed publication affecting
> the copy digest without changing the hold digest. Full local API 2,569
> units plus seven migration tests, API build and security scan pass.
> These are database observations, not approved dispositions or provider
> inventory; no final publisher, one-use SQL lease or worker permit exists.
> Exact hosted checks and deployment are pending. Live remains `434ded09`.

> **7 October ~09:54 Dublin inert decision-protocol release:** Exact
> `434ded0948d63e1e62660e843c176cfc03b525e5` passed hosted CI
> `37595114545` and E2E `37595114546` (240 tests). Guarded private-VM
> cutover serves green `434ded09`, with blue `516f020e` retained as the
> previous version. Restricted `cp_runtime`, prior database fences, zero
> protected claims/aliases, format-4 inventory and loopback/Tailscale routes
> passed read-only postflight. All 279 earlier backup hashes survived; six
> new files were SHA-verified off the VM; isolated restore passed with 149
> migrations. The fourth-stage decision protocol remains inert: no real
> publisher, protected one-use lease or worker caller. DPO-05, all-copy,
> independent P05/P08 host-loss, policy/MFA, Member/export/deletion,
> replay/C1, connector first contact and Nikita acceptance remain open.
> Private receipt: `.charitypilot-private/release-434ded09-final-decision-protocol-2026-10-07.md`.
> The source-only checkpoint below is dated history.

> **7 October source-only fourth-stage decision protocol:** A distinct
> `DOCUMENT_BYTE_EXECUTION_DECISION_V1` journal kind and encrypted immutable
> object can be checked against the exact candidate and current independent
> head. The reader never authorizes bytes; there is no production publisher,
> protected one-use SQL lease or worker caller. Synthetic object/head
> acknowledgement-loss, substitution, tamper and missing-object tests pass.
> Full local API 2,569 units plus seven real-PostgreSQL migration tests and
> security scan pass. No real copy/hold/provider inventory has been
> approved or published. Live remains `516f020e`; exact hosted/deployment,
> all-copy, P05/P08/host-loss and human acceptance gates remain open.

> **7 October ~09:19 Dublin cleanup-alias fence live:** Exact source
> `516f020e` passed hosted CI `37591101119` and E2E `37591101216`.
> Guarded private-VM cutover now serves blue `516f020e`, with green
> `5dfa72b3` retained as rollback. Restricted `cp_runtime`, the new
> migration and both triggers, prior guards, zero claims/aliases,
> format-4 inventory and loopback/Tailscale health/login passed read-only
> postflight. All 273 earlier backup hashes survived; two new sets were
> copied off the VM with six matching SHA-256 hashes; isolated restore
> passed with 149 migrations. Private exact receipt:
> `.charitypilot-private/release-516f020e-cleanup-alias-fence-2026-10-07.md`.
> This does not activate protected byte execution or settle all-copy,
> independent P05/P08 host-loss recovery, policy/MFA, Member/export/
> deletion, replay/C1, real connector first contact or Nikita acceptance.
> The source-only checkpoint below is dated history.

> **7 October source-only cleanup-alias fence:** A new migration makes a
> primary purge claim refuse another cleanup job for the exact provider
> key, and refuses a new matching job after claim. The production worker
> skips any exact-key alias under recovery enforcement; current byte
> authority also rejects one. Disposable real-PostgreSQL proof covers
> pre/post-claim refusal, a privileged synthetic alias, worker exclusion
> and unrelated cleanup. Local API suite 2,568 + seven migration tests,
> focused PostgreSQL proof, Prisma validation and security scan pass.
> Exact hosted checks and private-VM release are pending; live remains
> `5dfa72b3`. This closes one cleanup alias route, not the final one-use
> byte permit, all-copy audit, P05/P08 custody or Nikita acceptance.

> **7 October source-only worker baseline:** The disposable real-PostgreSQL
> document byte-authority proof now invokes the production
> `DocumentService.retryPendingStorageDeletions` claimant shared by both
> cleanup entry points. Under recovery enforcement, an unrelated orphan
> job is processed while the exact purge-claim job remains PENDING,
> unclaimed and at zero attempts; its direct SQL update is still refused.
> Focused proof passes locally. No worker permit, final independent
> authority, post-claim current-head check or live byte execution was
> added. Live remains `5dfa72b3`; the private worker-permit contract records
> the required exact transition, UNKNOWN outcome and activation gates.

> **7 October ~08:33 Dublin upload-intent/purge fence release:** Exact
> `5dfa72b3` hosted CI/E2E passed and green serves the guarded private VM;
> blue `312eb93e` is the previous version. The new migration and both
> triggers are present. Restricted runtime, prior byte/copy guards, zero
> recovery and claim rows, five historical ATTACHED intents, format-4
> inventory and both front doors passed. All 267 earlier backup hashes
> survived; two new sets, six SHA-verified off-VM files, and isolated
> 148-migration restore passed. This fences one exact-path upload-reservation
> race; it is not a worker byte permit, all-copy or historical-copy proof.
> Independent P05/P08 custody/host-loss and policy, role/export/deletion,
> replay/C1 and Nikita acceptance gates remain open. Private receipt:
> `release-5dfa72b3-upload-intent-purge-fence-2026-10-07.md`.
> Older source-only and release checkpoints below are dated history.

> **7 October source-only upload-intent/purge fence:** A new migration
> makes a primary claim refuse an unresolved or different-document upload
> reservation for its exact provider/object path, while preserving the
> historical `ATTACHED` intent for that document. New reservations for a
> previously claimed target are refused before provider bytes are written.
> Both trigger paths lock the organisation row; migration refuses an existing
> conflicting pair. Disposable real-PostgreSQL positive/negative proof,
> API 2,568 units plus seven migration tests, production checks (1,120 pass,
> four intentional skips with Git Bash) and security scan pass locally.
> Exact hosted CI/E2E and guarded release are pending; live remains
> `312eb93e`. This is another specific writer fence, not a worker byte
> permit, all-copy proof, provider custody, host-loss reopening or Nikita
> acceptance. Older release checkpoints below remain dated evidence.

> **7 October ~08:08 Dublin Confluence publication/purge fence release:**
> Exact `312eb93e` hosted CI/E2E passed and blue serves the guarded private
> VM; green `9c6e795b` is the previous version. The new migration and both
> publication/claim triggers are present. Restricted runtime, empty
> recovery/publication rows, format-4 inventory and both front doors passed;
> all 261 earlier backup hashes survived. Two new sets, six SHA-verified
> off-VM files, and isolated 147-migration restore passed. This fences one
> known Confluence outbox race, not all document copies or historical remote
> absence. Byte execution remains disabled; worker lease/current-head,
> all-copy coverage, independent P05/P08 custody/host-loss reopening and all
> policy, role/export/deletion, replay/C1 and Nikita acceptance gates remain
> open. Private receipt:
> `release-312eb93e-confluence-publication-purge-fence-2026-10-07.md`.
> Older checkpoints below are dated history.

> **7 October ~07:34 Dublin authenticated inert binding release:** Exact
> `9c6e795b` hosted CI/E2E passed and green serves the guarded private VM;
> blue `0e517dfb` remains rollbackable. Restricted runtime, empty binding
> and recovery rows, byte/binding guards, format-4 inventory, both front
> doors, 255 preserved earlier backup hashes, six SHA-verified off-VM new
> files and isolated 146-migration restore passed. The new insertion has
> no production caller or byte authority. DPO-05 still needs worker lease
> and pre-provider current-head checks, all-copy fencing and independent
> P05/P08 custody/host-loss reopening. Policy, MFA, Member/export/deletion,
> replay/C1 and Nikita acceptance remain separate open gates. Private
> exact receipt: `release-9c6e795b-authenticated-inert-binding-2026-10-07.md`.
> Older source-only checkpoints below are dated history.

> **7 October ~07:18 Dublin source-only candidate insertion:** Pushed
> `9c6e795b` adds authenticated, serializable local candidate insertion and
> independent/local rechecks. The result is inert, has no production caller,
> and the existing byte fence remains denying. Local build, focused tests,
> security scan, disposable projection proof and production checks pass.
> API units passed 2,568/2,568; one unrelated password-recovery migration
> test failed once and passed on isolated rerun. Exact hosted checks and
> guarded deployment remain pending. Live blue remains `0e517dfb`.
> DPO-05 still needs worker lease/pre-provider validation, all-copy fencing,
> independent P05/P08 custody and supervised host-loss reopening. Nikita's
> 3 October Admin review leaves Member, approved export/deletion/recovery,
> MFA, replay/C1 and scope-specific DPO acceptance open. Private goal audit
> and release receipts have the exact continuation scope.

> **7 October ~07:08 Dublin inert candidate-binding release:** Exact
> `0e517dfb` hosted CI/E2E and guarded blue private-VM cutover passed.
> Green `b25128d7` is rollbackable. The owner-only binding table is empty,
> `cp_runtime` cannot write it, both byte and binding guards are present,
> format-4 restore inventory passes, and loopback/Tailscale health/login
> return 200. All 249 prior backup hashes survived; two new sets were
> SHA-verified off-VM and isolated restore passed 146 migrations. The
> binding has no production caller or worker execution authority. DPO-05
> still needs authenticated insertion, exact worker lease/pre-provider
> checks, all-copy fencing, P05/P08 custody and host-loss reopening. All
> policy, role/export/deletion, replay/C1 and Nikita acceptance gates stay
> open. Private exact receipt:
> `release-0e517dfb-inert-candidate-binding-2026-10-07.md`.
> Older checkpoints below are dated history.

> **7 October ~06:27 Dublin inert byte-candidate publisher release:** Exact
> `b25128d7` hosted CI/E2E and guarded private-VM cutover passed. Green
> serves it; blue `a5234cca` is rollbackable. Restricted runtime, empty
> recovery tables, byte fence, both front doors, 243 unchanged prior backup
> hashes, two SHA-verified off-VM sets and isolated 145-migration restore
> passed. The disposable real-PostgreSQL projection proof also passed exact
> hosted checks. The publisher has no production caller and returns no byte
> execution authority. DPO-05 remains open for SQL/worker permit, all-copy
> fencing, P05/P08 custody and supervised host-loss reopening. Policy,
> MFA, Member/export/deletion, replay/C1 and Nikita acceptance remain open.
> Private receipt: `release-b25128d7-inert-publisher-2026-10-07.md`.
> Older checkpoints below are dated history.

> **7 October ~05:36 Dublin guarded current-authority projection release:**
> Exact `a5234cca` hosted CI/E2E succeeded and blue serves the private VM.
> Restricted runtime, empty recovery tables, byte fence, both front doors,
> 237 unchanged prior backup hashes, two copied/SHA-verified off-VM sets and
> isolated 145-migration restore passed. Green `05087bbf` is rollbackable.
> The projection is inert and returns `actionAuthorized: false`; its full
> composed query still needs disposable real-PostgreSQL proof. There is no
> publisher, SQL/worker byte permit, complete copy-writer fence, P05/P08
> custody or supervised host-loss reopening. DPO-05 and policy, live-role,
> export/deletion, replay/C1 and Nikita acceptance remain open. Private
> receipt: `release-a5234cca-current-authority-2026-10-07.md`. Older notes
> below are dated history.

> **7 October ~05:04 Dublin guarded encrypted candidate release:** Exact
> `05087bbf` hosted CI/E2E succeeded and green now serves the private VM.
> Restricted runtime, empty recovery/enforcement, byte-fence trigger,
> format-3 inventory and both front doors passed. All 231 previous backup
> hashes survived; two new sets were copied and SHA-verified off-VM; an
> isolated 145-migration restore passed. Blue `dc10b848` is rollbackable.
> The encrypted candidate and current-history read are non-executable;
> `actionAuthorized` remains false. No safe local-authority publisher,
> database/worker permit, all-copy fence, P05/P08 custody or host-loss
> reopening exists. Keep enforcement inactive and DPO-05 open. Private
> receipt: `release-05087bbf-byte-permit-candidate-2026-10-07.md`; older
> source-only/release notes below are dated history.

> **7 October ~04:40 Dublin guarded byte-permit journal release:** Exact
> `dc10b848` hosted CI/E2E passed and blue now serves the private VM after
> guarded cutover. Live checks proved restricted `cp_runtime`, shared mount,
> empty recovery/enforcement tables, byte-fence trigger, format-3 inventory
> and loopback/Tailscale health/login. All 225 prior backup hashes survived;
> two new sets were copied and SHA-verified off-VM; a 145-migration isolated
> restore passed. Green `4adf8aa9` is rollbackable. The new journal stage
> has `actionAuthorized: false`: no encrypted permit body, SQL permit,
> worker current-head check, all-copy fence, P05/P08 custody or host-loss
> reopening exists. Keep enforcement inactive. The operative remaining-work
> scope and exact evidence are in private `nikita-remaining-goal-audit-2026-10-07.md`
> and `release-dc10b848-byte-permit-journal-2026-10-07.md`. Older source-only
> notes below are dated history.

> **7 October source-only byte-permit journal chain:** A distinct
> `DOCUMENT_BYTE_PERMIT_V1` journal kind can immediately follow the exact
> `DOCUMENT_OUTCOME_V1` under the same reserved independent control. The
> journal now verifies the three-entry predecessor chain and exact replay;
> its receipt still has `actionAuthorized: false`. The S3 release allowlist
> rejects this kind. API build and 53 focused journal/document/S3 tests pass
> locally. Source `1065c6f6` is committed/pushed, with exact hosted CI
> `37566033387` and E2E `37566033470` queued at first observation. CI
> failed a cancellation-branch assertion; replacement `dc10b848` repairs
> the regression. Its local full API suite passed 2,559/2,559 plus seven
> real-PostgreSQL tests. Exact replacement CI `37566595641` and E2E
> `37566595511` are active. This is not an encrypted permit candidate,
> database permit, worker callback
> or deployment. No live enforcement is
> authorized. Inspect `git status` and private `RESUME-HERE.md` before
> continuing; the live VM remains green `4adf8aa9`.


> **7 October guarded worker claim release:** Exact `4adf8aa9` hosted
> CI/E2E passed and green serves the private VM. The production SQL worker
> skips document purge jobs under active recovery enforcement, so an
> intentionally blocked job does not roll back ordinary cleanup in the
> same batch; the database trigger remains the race guard. Live postflight
> proved `cp_runtime`, empty enforcement/recovery tables, format-3 inventory,
> shared mount and loopback/Tailscale health/login. All 219 prior backup
> hashes survived, two new sets were copied/SHA-verified off-VM, and a
> 145-migration isolated restore passed. Blue `b0cff53a` is rollbackable.
> This is not a verified byte-execution permit. Keep enforcement inactive;
> all-copy, P05/P08 custody, host-loss, policy, role/export, replay/C1 and
> Nikita review gates remain open. Private receipt:
> `.charitypilot-private/release-4adf8aa9-worker-claim-2026-10-07.md`.
> The source-only note below is dated history.


> **7 October worker claim source candidate:** The production SQL claimant
> now omits a `DocumentPurgeClaim` deletion job when that organisation has
> active `DocumentRecoveryEnforcement`, allowing ordinary cleanup in the
> same batch to continue. The byte-fence trigger remains the final
> activation/claim race guard. API build, 29 focused worker/eraser tests and
> the dedicated real-PostgreSQL trigger test pass locally. This source is
> committed/pushed as `4adf8aa9`, but not yet hosted-tested or deployed and does
> not introduce a verified byte-execution permit. Inspect `git status` and
> private `RESUME-HERE.md` before advancing. The live VM still serves
> `b0cff53a`; the release note below remains authoritative.


> **7 October guarded byte-fence release:** Exact `b0cff53a` hosted CI/E2E
> passed and blue now serves the private VM. Live postflight proved the
> `DocumentRecoveryByteFence` migration/trigger, restricted `cp_runtime`,
> empty recovery/enforcement tables, format-3 inventory, shared document
> mount and loopback/Tailscale health/login. All 213 prior backup hashes
> survived; two new sets were copied and SHA-verified off-VM; a 145-migration
> isolated restore passed. Green `f06075dd` is rollbackable. This is a
> fail-closed prerequisite only. Do not activate enforcement: there is no
> verified byte-execution permit, all-copy fence, P05/P08 custody or
> supervised host-loss reopening. Nikita's separate policy, role/export,
> replay/C1 and scope-specific review gates remain open. Exact private
> receipt: `.charitypilot-private/release-b0cff53a-byte-fence-2026-10-07.md`.
> Older checkpoints below are dated history.


> **7 October source-only byte fence candidate:** Migration
> `20261007040000_document_recovery_byte_fence` serializes document
> enforcement activation with purge-job updates, refuses activation over
> unfinished legacy purge jobs and blocks direct updates to a guarded job.
> Dedicated real-PostgreSQL and full retention migration proofs pass locally;
> CI runs the dedicated test. No independent byte-execution permit, all-copy
> fence, custody or host-loss proof exists, and enforcement must remain
> inactive. Check private `RESUME-HERE.md` for commit/hosted/release status.
> Last proved VM release is green `f06075dd`; older notes below are history.

> **7 October 03:34 Dublin guarded document-outcome release:** Exact
> `f06075dd` hosted CI/E2E succeeded and green now serves the inactive
> authenticated document primary-claim outcome publication/read path. Blue
> `aa4d529b` is rollbackable. Postflight proved `cp_runtime`, zero recovery
> rows/binding, format-3 restore inventory, shared mount and both front
> doors. All 204 previous backup hashes survived, three new sets were copied
> and SHA-verified off-VM, and a 144-migration isolated restore passed.
> This is not byte/copy erasure, live provider custody, host-loss reopening
> or DPO-05 closure. Worker/all-copy fences, P05/P08, P01-P09/MFA,
> Member/approved export/deletion, replay/C1 and Nikita review remain open.
> Private receipt: `.charitypilot-private/release-f06075dd-document-outcome-2026-10-07.md`.
> Older checkpoints below are dated history.

> **7 October 03:18 Dublin source-only document outcome path:** The worktree
> adds an inactive committed document claim reader, encrypted independent
> outcome envelope, separate S3 namespace, reserved journal publication and
> current-history read. It retains the reservation and does not assert byte
> or copy erasure. Six focused document tests, API build, S3 release refusal,
> lint, lifecycle-map and retention migration passed. Main API tests passed
> 2,559/2,559; serial PostgreSQL passed 6/7 because a password-recovery
> concurrency assertion failed once, then passed in an isolated rerun. The
> aggregate command is not green. This source is uncommitted/unhosted at this
> checkpoint; no caller, provider or live binding exists. Read the private
> `RESUME-HERE.md` before committing or releasing. DPO-05 and the other
> Nikita acceptance gates remain open. Older checkpoints below are history.

> **7 October 03:10 Dublin active-goal audit:** The existing Nikita goal is
> active and unblocked; use the operative remaining-work scope and closure
> rule in `.charitypilot-private/nikita-goal-audit-2026-10-06.md` without
> marking it complete merely to change wording. Last proved private-VM
> release is `aa4d529b`. After source baseline `9d881f95`, two untracked
> document-outcome source/test files pass an API build and three local tests,
> but are not committed, hosted, deployed or independently published.
> Continue result publication, worker/copy fences and P05/P08 custody and
> host-loss proof. P01–P09/MFA, Member/approved export and deletion journeys,
> replay/C1 and Nikita's scope-specific review remain open. Read
> `.charitypilot-private/RESUME-HERE.md` first. Older checkpoints below are
> dated history.

> **7 October format-3 private-VM release:** Exact `aa4d529b` hosted CI/E2E
> and guarded cutover passed. Blue serves a live format-3 purge restore
> comparison that hashes all four document recovery tables; their row
> counts are zero. Restricted runtime, front doors, preservation of 198
> prior backup hashes, two copied/SHA-verified workstation sets and a
> 144-migration isolated restore passed. Green `20ef847e` is rollbackable.
> This closes the current restore-inventory subtask, not authenticated
> independent claim/result publication, byte-worker/all-copy fencing,
> approved custody, host-loss reopening, Member/export/policy journeys,
> replay/C1 or Nikita DPO acceptance. Private receipt:
> `.charitypilot-private/release-aa4d529b-restore-format3-2026-10-07.md`.
> Older checkpoints below are dated history.

> **7 October private-VM document claim transaction release:** Exact
> `20ef847e` hosted CI/E2E and guarded cutover succeeded; green serves and
> blue `7a982c8f` is rollbackable. Postflight proved the new migration,
> restricted `cp_runtime` grants, zero recovery operation rows/binding,
> shared document mount and loopback/Tailscale front doors. All 192 prior
> backup hashes survived, two new sets were copied and SHA-verified off-VM,
> and isolated restore passed with 144 migrations. This is inactive local
> claim/job SQL, not authenticated independent result publication,
> byte-worker/all-copy fencing, approved custody or host-loss reopening.
> Extend the versioned restore inventory before live binding. Nikita's
> policy, Member/export, replay/C1 and DPO acceptance gates remain open.
> Private receipt: `.charitypilot-private/release-20ef847e-document-claim-2026-10-07.md`.
> Older source-only notes below are dated checkpoints.

> **7 October 02:30 Dublin Nikita goal audit:** The active goal remains
> relevant. Its precise remaining-work objective and closure test are at
> `.charitypilot-private/nikita-goal-audit-2026-10-06.md`; resume from
> `.charitypilot-private/RESUME-HERE.md`. Last proven private-VM release is
> blue `7a982c8f`. Current uncommitted document claim/result SQL and Prisma
> candidate passed Prisma validation and one synthetic real-PostgreSQL
> retention migration proof only. It has no authenticated independent
> publication, byte-worker fence, all-copy coverage, approved custody or
> host-loss acceptance. The three new models still need lifecycle-map and
> disposable E2E reset inventory entries, then final local/hosted checks.
> Nikita's 3 October Admin-only review remains his latest substantive
> CharityPilot acceptance email; Member, policy, export, replay/C1 and DPO
> review gates remain open. Older checkpoints below are dated history.

> **7 October format-2 restore gate deployed:** Blue `7a982c8f` serves the
> private VM; green `c994174f` is rollbackable. The purge restore comparison
> now includes `DocumentRecoveryPreparation`. Exact hosted CI/E2E, guarded
> release, live format-2 snapshot, restricted role, 186 preserved prior
> backup hashes, two verified off-VM copies and 143-migration isolated
> restore passed. This is not an independent document claim/result, byte
> worker fence, external custody, host-loss reopening, approved policy,
> Member journey or DPO acceptance. The private receipt is
> `.charitypilot-private/release-7a982c8f-restore-inventory-2026-10-07.md`.
> Older source/release checkpoints below are historical.
>

> **7 October guarded private-VM release and goal audit:** Exact `c994174f`
> hosted CI/E2E succeeded, and green now serves the inactive encrypted document
> recovery preparation. Postflight proved the migration, restricted runtime,
> document mount and front doors; 180 prior backup hashes survived, two new
> sets were copied and verified, and a 143-migration isolated restore passed.
> This is not independent live document recovery, provider custody, host-loss
> reopening, approved retention/export, Member or DPO acceptance. The active
> Nikita goal remains relevant; its current remaining-work statement is in
> `.charitypilot-private/nikita-goal-audit-2026-10-06.md`, and the exact release
> receipt is `.charitypilot-private/release-c994174f-document-preparation-2026-10-07.md`.
> Older source-only and release-pending checkpoints below are historical.
>

> **7 October document recovery publication source continuation:** The inactive
> document preparation now has a domain-separated encrypted envelope, a
> distinct S3 object namespace and `DOCUMENT_PREPARATION_V1` reserved journal
> kind. Publication verifies the original ciphertext against the exact
> reservation; reads require current independently verified history and
> authenticated original bytes. Local API build, 2 focused publication tests,
> 2,555 API application tests and 7 real PostgreSQL tests passed. This does
> not bind a document claim, storage worker, preservation/copy writer, live
> provider or host-loss reopening. Hosted checks and deployment of this new
> source are pending; no P05/P08 or DPO approval is inferred. Private scope:
> `.charitypilot-private/document-recovery-preparation-2026-10-07.md`.


> **7 October document recovery preparation, source-only candidate:** A typed,
> bounded, append-only `DocumentRecoveryPreparation` capture path now records
> exact Owner authorization, approved/current and original removal policy,
> removal/withdrawal and object identity facts without document bytes or
> descriptive Vault fields. It has no live caller, independent publication,
> execution permit or worker fence. Focused API and real PostgreSQL trigger
> tests, the full retention migration chain, API build and full API suite
> passed locally. Hosted CI/E2E and any VM release are pending. The existing
> pre-migration restore inventory intentionally does not query this new table;
> update versioned restore coverage after the schema is deployed and before
> any live capture. This narrows DPO-05 preparation only; independent custody,
> claim/job/worker outcomes and host-loss reopening remain open. Private
> source note: `.charitypilot-private/document-recovery-preparation-2026-10-07.md`.
> Earlier live-release statements below are dated checkpoints.

> **7 October complaint policy recovery-gate private VM release:** Blue
> `38b735c1` is live after exact hosted CI/E2E and guarded cutover. Service
> and SQL now reject ordinary COMPLAINT retention-policy revisions and
> withdrawals once independent recovery enforcement is bound; the live
> binding count remains zero. Restricted `cp_runtime`, migration, loopback/
> Tailscale, authenticated Owner MCP reads, preservation of 174 prior backup
> hashes, two copied/verified new sets and a 142-migration isolated restore
> passed. Green `4d03f890` is stopped/rollbackable. This closes one inactive
> writer gap, not independent recovery, host-loss authority, approved
> retention, Member/browser or DPO acceptance. Exact private receipt:
> `.charitypilot-private/release-38b735c1-complaint-policy-gate-2026-10-07.md`.
> Earlier live-colour statements below are dated checkpoints.

> **7 October complaint recovery-gate private VM release:** Green `4d03f890`
> is live after exact hosted CI/E2E and guarded deployment. The new SQL and
> service gate refuses ordinary complaint removal/restoration if independent
> recovery enforcement is bound; the dashboard then explains that the
> ordinary removal review is unavailable. Live binding count is zero, so no
> provider or policy was activated. API/web/scheduler retain restricted
> `cp_runtime`; SQL/grants, loopback/Tailscale, authenticated Owner MCP reads,
> preservation of 168 earlier backup hashes, two verified workstation
> copies and post-migration isolated restore (141 migrations) passed. Blue
> `bc371350` is stopped/rollbackable. This is one inactive writer boundary,
> not all-writer recovery, host-loss authority, Member/browser or DPO
> acceptance. Exact private receipt:
> `.charitypilot-private/release-4d03f890-complaint-gate-2026-10-07.md`.
> Earlier live-colour statements below are dated historical checkpoints.

> **6 October restricted-role private VM release:** Guarded env promotion and
> blue-green deployment made blue `bc371350` live at 22:43:07 UTC. API, web
> and scheduler now receive `cp_runtime`; API and scheduler SQL
> `current_user` confirm it. The post-migration role has no privileged
> attributes, memberships, public-table ownership, database/schema CREATE
> or write grants on the named protected recovery tables. Exact hosted
> CI/E2E, front-door and read-only connector checks, shared documents mount,
> preservation of 165 earlier backup file hashes, verified workstation copy
> and isolated restore drill passed. Previous green `915f44f9` is stopped
> and rollbackable. This closes the *live private-VM credential cutover*
> milestone, while authenticated browser/Member acceptance, genuine policy
> and Board decisions, historical replay/C1 disposition, independent
> recovery authority and Nikita's DPO review remain open. Private receipt:
> `.charitypilot-private/release-bc371350-restricted-role-2026-10-06.md`.

> **6 October local erasure mount finding — verified private VM release:** A production-mode
> disposable `cp_runtime` cleanup job reported a processed local deletion
> while the file remained in the API volume. The blue-green scheduler and
> cleanup service had no documents mount. Source now shares the mount and
> adds a fail-closed production local-storage mount check. Corrected
> synthetic deletion and container probes passed. Exact `915f44f9` hosted
> CI/E2E (240 browser checks) and a guarded VM cutover passed; green is live,
> blue `843ff8b6` rollbackable. Postflight verified API/scheduler share the
> private documents volume, the deployed image refuses an unmounted local
> path, 159 prior backup hashes survived, the new set matched its workstation
> copy and isolated restore passed. The reviewed live database has zero
> `provider=local` deletion rows. This is bounded technical remediation, not
> complete erasure or DPO acceptance. Private proof:
> `.charitypilot-private/release-915f44f9-acceptance.md`.

> **6 October 2026, live role/C1 read-only check:** On exact live
> `843ff8b6`, the owner env has no separate application DB env configured;
> API-blue, web-blue and scheduler each receive the broad
> `charitypilot_personal_server` database role. No credential or row changed.
> Combined guarded provisioner, production-mode app, nonempty-job and rollback
> acceptance still precede a live restricted-role cutover. The 2 May C1
> source fix remains an ancestor of the clean current NEXUS checkout, but a
> targeted May–June Nikita mail search found no original closure receipt.
> C1's bounded live wording remains OPEN pending scope acceptance or stronger
> proof. Private notes: `.charitypilot-private/live-db-role-2026-10-06.md`
> and `.charitypilot-private/c1-evidence-recheck-2026-10-06.md`.

> **6 October 2026, bounded replay follow-up:** Read-only metadata on exact
> live `843ff8b6` still found nine replay events and no new row after
> 30 September. Both 30 September web events presented sessions previously
> revoked for LOGOUT, 134–137 ms earlier, with zero newly quarantined active
> sessions. One family had a prior ROTATED row. Restricted context has request
> IDs/fingerprints, but no request-log correlation was completed. The pattern
> supports a post-logout race; it does not establish client identity or an
> incident verdict. Older events, including the connector event, remain
> incompletely attributed. Private exact query and limits:
> `.charitypilot-private/live-replay-review-2026-09-30.md`.

> **6 October 2026, verified private VM release:** Exact
> `843ff8b6daa7cc30b316c0dcb7f45f3b0dfbb580` is live on blue after
> hosted CI `37527573161` and E2E `37527573150` success (240 E2E checks),
> guarded cutover, healthy loopback and Tailscale health/login responses,
> preservation of 156 prior backup file hashes, verified workstation copy
> of the new set and successful isolated restore drill. Prior green
> `98220f3c` is stopped and rollbackable. The release includes the export
> wording correction and locked production dependency fixes. Count-only
> live checks still show zero approved report snapshots, zero approved
> VAULT_DRAFT policies, three Nikita test documents and nine replay alerts
> (latest 30 September). Nikita has not rechecked the release. Member
> acceptance, MFA policy, live restricted DB credential, historical replay
> attribution, C1 evidence, retention/recovery decisions, independent
> custody/host-loss reopening and DPO sign-off remain open. Full private
> receipt: `.charitypilot-private/release-843ff8b6-acceptance.md`. The
> source-only 6 October section below is a superseded pre-release checkpoint.

> **6 October 2026, export clarification is source-only:** Commit
> `2d543517` labels both ordinary report controls as full internal and
> explains that the minimised draft needs a retained Board-approved
> snapshot. Local web tests (546/546), production web build, edited-file
> lint and existing synthetic approved-snapshot API tests (8/8) passed.
> Hosted CI/E2E, deployment and Nikita's recheck are still pending. The
> last independently verified live release was `98220f3c` on 3 October;
> its tenant had no approved snapshots. No policy or Board approval was
> created. Newer Nikita emails about NEXUS testing, continuity, Atlassian
> and Help Desk are routed separately in private
> `.charitypilot-private/nikita-mail-triage-2026-10-06.md`.


> **3 October 2026, Nikita DPO acceptance update:** Nikita reported a light
> Admin-account pass of disposable document lifecycle/replacement and
> Governance Audit. This is not production sign-off; Member validation was
> skipped. Three restricted, unpublished test documents remain in the Vault.
> Read-only live counts found no approved report snapshots and no approved
> VAULT_DRAFT policy: minimised export depends on an approved snapshot, and
> draft deletion/recovery cannot yet be tested. The `/export` explanatory
> text currently mentions a minimised draft even while its button is hidden;
> correct that wording. Owner/Admin MFA policy, live restricted DB credential
> cutover, historical replay attribution and C1 verification remain open.
> The private VM now runs green `98220f3c` (exact CI/E2E success), still with
> broad ordinary DB access. Detailed email, exact limits and next actions:
> `.charitypilot-private/nikita-acceptance-feedback-2026-10-03.md`.

> **1 October ~03:23 Dublin, guarded role provisioner tested on a
> disposable database:** Clean canonical master `d61025b1` ran the actual
> Linux `bluegreen-runtime-role-provision.mjs` against the existing synthetic
> `charitypilot-bluegreen` database through a local Unix Docker socket.
> Preflight, backup, isolated restore drill, restricted-role grant
> reconciliation, password check and completed receipt all passed for an
> existing role. A second synthetic preflight confirmed a fresh role was
> absent; its full backup/restore/create/grant/password flow also passed,
> with a completed receipt and no pending operation. The source and database identities were
> checked, and both test containers were stopped. This exercised an
> role on Docker Desktop Linux; it did not switch the private VM credential or combine provisioner
> and full app routes in one production-mode run. The live VM remains on
> broad ordinary database access. Private evidence:
> `.charitypilot-private/linux-role-provision-disposable-proof-2026-10-01.md`.


> **1 October ~02:50 Dublin, Nikita continuation:** Source master
> `b701d209` includes the connector renewal fix from PR #9. The prior
> connector's hash-selected mutex port collided with Linux TCP TIME_WAIT
> inside the ephemeral range during hosted E2E. New connector sessions use
> separate v2 credential storage and a checked lower port range, so an
> older process cannot refresh the same single-use token under a different
> lock. Exact master CI and E2E passed (240 browser checks). A
> separate-process synthetic old/new build
> check showed independent rotation; live users must connect again and
> revoke their older Team session when upgrading. This does not attribute
> the nine historical replay events. A count-only VM check at 01:51 UTC
> found nine total and none recorded
> since the `8d4a0058` cutover; this short observation does not close them.
> Separately, a disposable full app
> ran under the restricted database role through API/web/scheduler startup,
> selected Owner/Admin/Member routes, restricted download, empty-queue jobs
> and rollback. That run manually provisioned the synthetic role and used
> `NODE_ENV=test`; the guarded Linux provisioner and production-mode VM
> switch remain unaccepted. A guarded blue-green release then deployed
> master `5752590f` at 02:08:30 UTC. API/web/scheduler and front door are
> healthy; prior `8d4a0058` remains rollbackable. All 132 pre-release
> backup file hashes were preserved, the new three-file set matched its
> workstation copy, and isolated restore passed. The VM still uses its
> broad database credential and has zero recovery bindings. Private evidence and
> resume instructions: `.charitypilot-private/RESUME-HERE.md`,
> `.charitypilot-private/split-role-full-stack-proof-2026-10-01.md` and
> `.charitypilot-private/nikita-review-pack-2026-09-30.md`, plus the
> private `release-5752590f-acceptance.md` receipt. This is not DPO
> sign-off, live connector upgrade or independent recovery certification.

> **1 October ~02:00 Dublin, source-only provisioning candidate:** A
> Linux-only `bluegreen-runtime-role-provision.mjs` source command now
> preflights the exact local Docker socket, canonical Git origin/HEAD,
> owner/app env separation, Compose project/database volume and protected
> receipt directory outside the checkout. It takes and rehearses a backup
> before creating/reconciling the role, verifies actual app login and
> restricted grants, and keeps a pending receipt for checked resume. A
> disposable fake-command failure/resume flow and real Linux filesystem
> checks passed; the SQL/secret transport was separately proved against
> disposable PostgreSQL/Compose. This command has **not** been run against
> a full disposable CharityPilot stack or the private VM. It is not yet an
> accepted operator procedure or authority to switch live credentials.
> Exact hosted CI/E2E for preceding `f16ba57a` passed. The private VM
> remains green `8d4a0058` with zero recovery bindings.


> **1 October 01:42 Dublin, source-only grant reconciliation:** With the
> optional separate application env, blue-green deployment now verifies
> the app password through Compose-network TCP before backup, checks the
> restricted role again after owner-only migration, reconciles ordinary
> table/sequence grants through bounded stdin, then rechecks role and
> password before candidate startup. Reconciliation does not rotate an
> existing password, preserving the serving colour during rollback. A
> disposable Compose fixture proved wrong-password refusal, old-password
> continuity and grants; the full migrated complaint protocol (78.4s),
> 88 deployment tests and local security scan passed. The VM has no app
> env/role switch and still runs `8d4a0058`. Supported role provisioning,
> all-route/job acceptance and separate recovery publisher remain open.


> **1 October 01:35 Dublin, source-only role boundary:** The optional
> blue-green runtime-role gate now refuses any inherited membership,
> ownership of public relations/functions, and executable non-system
> `SECURITY DEFINER` functions. The internal transactional grant map also
> rolls back when a reachable security-definer function exists. The full
> migrated complaint protocol (80.1 seconds), 85 deployment tests and local
> security scan passed. Disposable PostgreSQL negative controls proved
> owner-relation and definer-function refusal, including grant rollback.
> This has not been deployed to the private VM and does not constitute a
> supported runtime-role provisioner. See the private roadmap and proof.

> **1 October 01:24 Dublin, source-only grant map:** Internal
> `scripts/bluegreen/runtime-role-grants.psql` is transaction-bound, grants
> ordinary app DML and restricts recovery receipt/binding tables and Prisma
> migration history. The full disposable protocol now runs it and passes
> 99-model reads, a permitted hold-preparation service write and protected
> insert denials. Its 77.6-second run, 85 deployment tests and security
> scan passed. A separate disposable check refused an already-unsafe role.
> This is not a supported provisioner or VM credential change; no recovery
> binding is active. Private receipt and open gates are in
> `.charitypilot-private/runtime-role-grants-proof-2026-10-01.md`.

> **1 October 01:11 Dublin, restricted-role read proof:** The disposable
> full-migration complaint protocol now reads every generated Prisma model
> through a separate restricted login (99 models at this revision), while
> preserving its protected-write and role-escalation negative controls.
> The real PostgreSQL protocol passed in 77.7 seconds. This proves SELECT
> compatibility only; application writes, jobs, rollback and a provisioned
> VM role remain open. Private status: `.charitypilot-private/ROADMAP.md`.

> **1 October 01:08 Dublin, source only:** The blue-green command runner now
> supports bounded stdin with exact-value redaction on stdout, stderr and
> errors; its child-process test and 85 deployment tests pass. This allows
> a future role-provisioning path to avoid password-bearing command arguments.
> No provisioner, role grant map or rotation workflow is active. The private
> VM remains on `8d4a0058`. See `.charitypilot-private/ROADMAP.md`.

> **Runtime-role acceptance scope, 2026-10-01:** Normal isolated E2E uses a
> non-superuser runner that also migrates/seeds and has CREATE on public.
> Its passing browser suite cannot prove the new restricted runtime role
> works across routes or rollback. Build a disposable owner/runtime split,
> then test API/web/jobs and Member/Admin/Owner journeys before configuring
> the private VM. Do not put a role password in command arguments or logs.
> Private detail: `.charitypilot-private/nikita-review-pack-2026-09-30.md`.

> **1 October 01:03 Dublin, source-only refinement:** The optional runtime
> role guard now also refuses INHERIT, REPLICATION and database CREATE.
> Disposable PostgreSQL 16 accepted the restricted baseline and rejected
> each elevated case; 84 deployment tests and the local security scan pass.
> No VM credential or binding changed. Full hosted checks for this exact
> source and all-route compatibility are still required before any use.
> Private receipt: `.charitypilot-private/role-gate-proof-2026-10-01.md`.

> **1 October 00:57 Dublin, source only:** Opt-in blue-green app credentials
> now receive a read-only PostgreSQL role/privilege check before backup and
> after migration; unsafe privilege grants refuse deployment before candidate
> startup. The focused 84-test deploy suite and local security scan pass.
> A disposable PostgreSQL role check accepted a restricted login and rejected
> superuser and protected-table INSERT grants. No VM role was provisioned;
> live release remains `8d4a0058`. This is a deployment guard, not recovery
> activation or all-writer acceptance. Private evidence and next gates are
> in `.charitypilot-private/ROADMAP.md`.

> **1 October 00:52 Dublin hosted result:** Exact CI `36792206222` and
> E2E `36792206256` both succeeded on source commit `e1b09a26`. The
> prior `8a74c178` CI failure remains in the record. The private VM still
> runs verified `8d4a0058`; optional restricted runtime credentials are
> unconfigured and independent recovery is inactive. This is source
> validation, not a release or DPO acceptance. Private checkpoint:
> `.charitypilot-private/RESUME-HERE.md`.

> **1 October 00:40 Dublin source/checkpoint:** The private VM remains on
> verified `8d4a0058`. Latest pushed source is `e1b09a26`, which repairs
> the disposable role proof's security-scan failure on `8a74c178` and adds
> validation of an optional app runtime role name. Local security scan,
> 82 blue-green deployment tests and full 140-migration complaint protocol
> pass. Exact hosted checks on `e1b09a26` are still required; its role path
> is not configured on the VM. The requested post-23:15 update to Nikita was
> sent at 00:39 Dublin, confirmed in Sent. Private details and message ID
> are in `.charitypilot-private/RESUME-HERE.md`.

> **Restricted runtime feasibility, 2026-10-01:** source now supports an
> optional separate blue-green app env file for API/web/jobs while DB and
> migration retain the owner file. Rendered Compose and deployment tests
> pass (108). The full disposable PostgreSQL complaint protocol also
> exercises a separate non-superuser runtime login against the completed
> migration set: it cannot insert recovery outcomes, assume the owner role,
> disable the hold trigger or insert a direct post-binding hold. These are
> source/test proofs, not a provisioned VM role or accepted independent
> recovery boundary. Do not activate enforcement. Private details:
> `.charitypilot-private/complaint-hold-writer-gate-analysis-2026-09-30.md`.

> **Private VM release, 2026-10-01 00:22 Dublin:** Exact CI
> `36789520000` and E2E `36789520093` passed on `8d4a0058`; guarded
> blue-green cutover made that revision live on green, retaining
> `674be710` for rollback. The new deferred trigger is enabled and
> recovery enforcement has zero bindings. Service, local host boundary,
> preserved backup hashes, two copied recovery sets and isolated restore
> (140 migrations, 63 documents) passed. This is a partial inactive
> relational gate, not independent recovery or DPO acceptance. Private
> receipt: `.charitypilot-private/release-8d4a0058-acceptance.md`.

> **Complaint hold relational gate, 2026-10-01:** migration
> `20261001020000_complaint_hold_recovery_event_gate` adds a deferred
> same-transaction outcome check to every hold-event insert once a charity
> has a recovery enforcement binding. Direct post-binding inserts are
> refused; the prepared outcome's event-before-row trigger still commits.
> The complete real-PostgreSQL complaint recovery proof and API build pass.
> This does not authenticate independent publication: the current broad
> database credential can still insert outcomes. Runtime/executor privilege
> separation, emergency preservation workflow, provider custody and
> host-loss acceptance remain required. No live binding was activated.

> **Disposable hold-role proof, 2026-10-01:** All 139 migrations applied to
> local PostgreSQL 16.4. Independent non-superuser login roles proved the
> ordinary role can be denied hold-outcome INSERT and cannot assume the
> executor role or disable its trigger. The executor passed the table
> privilege check and reached the existing preparation guard. Ordinary
> hold INSERT needs UPDATE privilege on lock-bearing Organisation,
> ComplaintRecord and User tables; SELECT alone fails at `FOR UPDATE`.
> This is a bounded role feasibility result, not full app compatibility,
> independent publication, deployment or activation. Private proof:
> `.charitypilot-private/hold-role-proof-result-2026-10-01.md`.

> **Hold writer identity topology, 2026-10-01:** The private blue-green
> stack gives DB and API the same env file; Prisma uses one `DATABASE_URL`,
> and deploy preflight equates its user with `POSTGRES_USER`. Current
> migrations have no privilege separation. A trusted executor role would
> require coordinated deployment and migration changes; a signed attestation
> would require a key outside the ordinary API/database writer. A trigger
> trusting the present connection role or a shared secret is forgeable.
> Neither boundary is implemented. See the private hold writer-gate analysis.

> **Original CWR-2026-11 reply check, 2026-09-30:** Work Gmail thread
> `1a0c32a545331eaa` contains the corrected six-document circulation
> and Catherine, Sridevi and Jasper's 21 September agreements. The three
> September Facebook/Related Party attachment names and lengths match
> their verified Vault PDFs. The original Gmail attachment binaries were
> retrieved read-only and SHA-256 matched to all three verified Vault PDFs.
> Later publication/pinning and revisions remain unverified. No mailbox
> write occurred. Private evidence:
> `.charitypilot-private/three-september-adopted-pdfs-source-review-2026-09-30.md`.

> **Hold publication identity boundary, 2026-09-30:** current outcome SQL
> applies a prepared hold atomically but its row has no authenticated
> publication receipt. Adding a same-transaction event/outcome join or
> digest fields alone would not prove remote publication to a broad
> database writer. The private writer-gate analysis records two candidate
> boundaries: restricted database roles or database-verifiable attestation
> signed outside the ordinary writer. Neither is approved or implemented;
> supported emergency preservation and direct-SQL rejection remain gates.

> **Complaint writer inventory, 2026-09-30:** bounded current-source search
> found the ordinary hold service and the hold-outcome SQL trigger both
> writing `ComplaintHoldEvent`. The existing disposable protocol proof
> directly inserts a hold *after* enforcement binding, confirming that
> its fixture relies on the remaining database gap. Purge claim, removal
> and resolution paths are separately listed in the private writer-gate
> analysis. Static inventory does not prove all-writer enforcement;
> provider and supported hold workflow remain inactive. Private evidence:
> `.charitypilot-private/complaint-hold-writer-gate-analysis-2026-09-30.md`.

> **63-row source-reference milestone, 2026-09-30:** all private document
> worksheet rows now have some source evidence reference, 62 have some
> proposal, and every decision remains PENDING. The Document Retention
> Schedule deliberately has no proposal pending policy reconciliation.
> Last three source PDFs (Facebook Privacy V1, Facebook Safety/Moderation
> V1 and Related Party Transactions V1.0) match backup hashes; retained
> CWR-2026-11 evidence names their adoption after pre-adoption labels.
> Evidence strength varies; current live bytes, roles, publication and
> DPO/controller acceptance remain open. No live change. Private evidence:
> `.charitypilot-private/three-september-adopted-pdfs-source-review-2026-09-30.md`.

> **Three corporate records, 2026-09-30:** exact certificate,
> Constitution and Revenue enquiry PDFs match backup hashes. The
> Constitution is an image-only 44-page scan with current filed amendments
> unchecked. The Revenue file is a conditional 2022 ROS reply, not proof
> of current exemption. Private worksheet proposes Board/RESTRICTED for
> all, HISTORICAL dated evidence for certificate and enquiry, and leaves
> Constitution lifecycle open. Counts: 56/63 source evidenced, 55 with
> some proposal, eight with none, all PENDING. No live change. Private
> evidence: `.charitypilot-private/three-corporate-records-source-review-2026-09-30.md`.

> **Two added March policies, 2026-09-30:** the retained original email
> chain starts with 29 documents, records Sridevi's Asset Management and
> Dissolution gap, Jasper's two added PDFs and later director replies for
> the expanded 31. All normalised main-body tokens of each exact verified
> Vault DOCX occur in its emailed PDF in order; this is not binary or full
> visual equivalence. Private worksheet proposes Board/CURRENT March
> text/RESTRICTED for both, pending later revisions and approval-chain
> review. Counts: 53/63 source evidenced, 52 with some proposal, 11 with
> none, all PENDING. No live change. Private evidence:
> `.charitypilot-private/two-added-march-policies-source-review-2026-09-30.md`.

> **Four website terms/privacy files, 2026-09-30:** the verified Vault
> backup DOCX files for hour-timebank.ie Terms v2, Privacy v1 and Cookie
> Policy, plus timebank.global Platform Terms v1, match the named March
> approval-email attachment main-body tokens. Actual current website
> versions and later approvals were not checked. Private worksheet
> proposes Board/RESTRICTED Vault audience, leaving lifecycle and external
> publication open. Counts: 51/63 source evidenced, 50 with some proposal,
> 13 with none, all PENDING. No live change. Private evidence:
> `.charitypilot-private/four-website-terms-source-review-2026-09-30.md`.

> **Fourteen further March governance documents, 2026-09-30:** the retained
> adoption email explicitly names fourteen more files whose manifest-verified
> Vault DOCX main bodies match their email attachments token for token.
> Binaries differ; later revisions and actual audience are unchecked.
> Private worksheet proposes Board/CURRENT adopted March text/RESTRICTED
> for these exact copies only. The comparison log now covers nineteen
> matches. Counts: 47/63 source evidenced, 46 with some proposal, 17 with
> none, all PENDING. No live change. Private evidence:
> `.charitypilot-private/march-fourteen-policy-source-review-2026-09-30.md`.

> **Five March governance documents, exact main-body review,
> 2026-09-30:** the retained March approval email names Child Safeguarding,
> Complaints & Feedback, Conflict of Interest, Safeguarding and the March
> Risk Register. Each matching verified backup Vault DOCX has identical
> extracted main-body tokens to its email attachment, although binary
> hashes differ. Later revisions and operational control performance are
> unchecked. Private worksheet proposes Board/RESTRICTED for all,
> CURRENT adopted March text for four policy/statement files, HISTORICAL
> for the dated risk snapshot. Counts: 33/63 source evidenced, 32 with
> some proposal, 31 with none, all PENDING. No live change. Evidence:
> `.charitypilot-private/march-five-policy-source-review-2026-09-30.md`.

> **Three Board minutes exact-source review, 2026-09-30:** March, July and
> August 2026 DOCX files match verified backup hashes. July and August source
> copies explicitly say DRAFT; the August draft records approval of July,
> but no signed final July copy was established. March signing fields are
> blank. The private worksheet proposes Company Secretary/RESTRICTED for
> all, DRAFT for exact July/August Vault copies, and leaves March lifecycle
> open. This does not invalidate underlying meetings or resolutions.
> Counts: 28/63 source evidenced, 27 with some proposal, 36 with none,
> all PENDING. No live change. Private evidence:
> `.charitypilot-private/board-minutes-source-review-2026-09-30.md`.

> **Annual-accounts exact-source review, 2026-09-30:** FY2021, FY2022,
> FY2024 and FY2025 PDFs in the verified backup each match manifest hashes.
> They cover distinct year-end periods. Vault `CRO-filed` labels and exact
> public copies remain unverified. The private worksheet proposes Board and
> RESTRICTED for all four, HISTORICAL for FY2021/2022/2024, and leaves FY2025
> lifecycle open. No publication or retention decision was made. Counts:
> 25/63 source evidenced, 24 with some proposal, 39 with none, all PENDING.
> No live metadata changed. Private evidence:
> `.charitypilot-private/abridged-accounts-source-review-2026-09-30.md`.

> **Trustee master-template source review, 2026-09-30:** exact backup
> Induction Pack and separate Code of Conduct Declaration matched manifest
> hashes. The March approval email names the pack as item 20 and its
> attached body matches Vault text; both files have blank individual
> signature fields. The private worksheet proposes Board/CURRENT adopted
> **template**/RESTRICTED for the pack and Company Secretary/DRAFT blank
> **master**/RESTRICTED for the declaration, pending current revision,
> separate adoption and signed-return checks. No induction completion,
> signed declarations or permanent-retention approval is inferred.
> Twenty-one of 63 rows have source evidence, 20 have some proposal, 43 have
> none, all PENDING. No live metadata changed. Private evidence:
> `.charitypilot-private/trustee-templates-source-review-2026-09-30.md`.


> **Independent hold recovery gate recheck, 2026-09-30 23:30 Dublin:** the
> released ordinary hold service refuses changes once an enforcement binding
> exists, but the database hold-event trigger still lacks an enforced
> publication binding. The published-hold executor is internal with no
> supported Owner/Admin route; binding enforcement now would block ordinary
> preservation changes. The outcome row does not carry a durable
> writer/publication receipt, so a deferred same-transaction join alone is
> insufficient. The private writer-gate analysis gives the ordered
> receipt/constraint/workflow/test/provider path. No migration, provider or
> live activation occurred. Private evidence:
> `.charitypilot-private/complaint-hold-writer-gate-analysis-2026-09-30.md`.


> **August Governance Policy Index exact-source review, 2026-09-30:** the
> verified 17,412-byte backup DOCX has 27 entries, omits the Asset Management
> and Dissolution Policies, and has blank Board approval fields. The live
> Owner Vault calls it unadopted. It is not the March adopted 31-document
> schedule or a proven successor to the March Index. Private worksheet
> proposes Company Secretary/DRAFT/RESTRICTED pending Board/current-source
> review. Nineteen of 63 rows have source evidence, 18 have some proposal,
> 45 have none, all 63 PENDING. No live change. Private evidence:
> `.charitypilot-private/august-index-source-review-2026-09-30.md`.


> **March Governance Policy Index source found, 2026-09-30:** the retained
> 21 March approval email and external Policies folder each hold a March
> Index DOCX with identical extracted main-document body tokens, despite
> different binary hashes. The live Owner Vault loaded 63/63 records and has
> only a near-complete text stub (with unique 22 September provenance note),
> not the full March DOCX. Its `uploaded`/`safe to delete` narrative is
> contradicted. The August DOCX is a separate unadopted index. Private
> worksheet proposes Board/HISTORICAL/RESTRICTED for the stub, no successor
> until the original has a verified Vault record and controller decision.
> Eighteen of 63 rows have source evidence, 17 have some proposal, 46 have
> none, all 63 PENDING. No live metadata changed. Private evidence:
> `.charitypilot-private/text-stub-source-review-2026-09-30.md`.


> **Garda Vetting adopted-text mismatch, 2026-09-30:** the exact backup Vault
> DOCX is byte-identical to the plain local policy and its extracted body
> matches the plain 21 March email attachment. The retained resolution email
> expressly names an ECRIS Update for item 6 and attaches a distinct ECRIS
> body; later director replies support the 31-item adoption. The mismatch is
> about the operative text, not the existence of that adoption. Existing
> plain Vault row proposes Board/HISTORICAL/RESTRICTED pending Board/DPO
> decision, verified ECRIS record and standards-link reconciliation. Eighteen
> of 63 worksheet rows have source evidence, 16 have some proposal, 47 have
> none, all 63 PENDING. No live metadata changed. This finding postdates the
> 23:15 Nikita email. Private evidence:
> `.charitypilot-private/garda-vetting-source-review-2026-09-30.md`.


> **March approval drafts source review, 2026-09-30:** two exact DOCX files
> match the verified post-release backup. The board-meeting instrument has
> blank execution fields; the written instrument lists 25 and conditions its
> effect on director email confirmations absent from that file. Neither is
> the separately evidenced 31-document WR-2026-03-21 adoption. The live Owner
> Vault links both drafts to standard 3.4; those links do not prove execution.
> The private P01/P02 worksheet proposes Board/HISTORICAL/RESTRICTED pending
> controller review and current live revision. Seventeen of 63 rows have
> source evidence, 15 have some proposal, 48 have none, all 63 PENDING. No
> live metadata changed. Private evidence:
> `.charitypilot-private/unexecuted-approval-source-review-2026-09-30.md`.


> **Five legacy text stubs reviewed, 2026-09-30 23:15 Dublin:** all five
> `ZZ SUPERSEDED STUB` files match exact verified post-release backup bytes.
> Four cite full September PDFs present in the backup with matching hashes;
> their private worksheet rows propose SUPERSEDED/RESTRICTED and exact
> successors. The March Governance Policy Index stub has no claimed real
> March DOCX in the 63-file backup; an August index with a blank approval
> block is a separate source, not a proven replacement. `safe to delete` is
> not disposal authority. Fifteen of 63 worksheet rows now carry source
> evidence, 13 have some proposal, 50 have none, and all 63 are PENDING.
> No live metadata changed. Private evidence:
> `.charitypilot-private/text-stub-source-review-2026-09-30.md`.


> **Volunteer template source review, 2026-09-30:** the exact three-page PDF
> matches a verified backup entry and is blank. CWR-2026-11 Resolution 3 adopts
> the circulated Volunteer Register and Induction Record and assigns the
> Company Secretary; it says standard 3.2 stays open until the register is
> populated. The P01/P02 worksheet proposes CURRENT **template** / RESTRICTED,
> not operational completion. Former-volunteer retention and any populated
> record remain to check. Ten of 63 rows have source evidence, nine have a
> proposal and all 63 remain PENDING. Private evidence:
> `.charitypilot-private/volunteer-register-source-review-2026-09-30.md`.

> **Sensitive register source review, 2026-09-30:** exact verified backup
> bytes of the Register of Interests/Declaration Form include named trustees'
> financial and related-party conflicts. The private P01/P02 worksheet
> proposes Company Secretary ownership and RESTRICTED audience; lifecycle and
> replacement are left for adoption/signed-return/current-source review. The
> file's own permanent-retention statement is not accepted as application
> policy. Nine of 63 rows now have source evidence, eight have a proposal and
> all 63 remain PENDING. No live metadata changed. Private evidence:
> `.charitypilot-private/interests-register-source-review-2026-09-30.md`.

> **Privacy Notice provenance follow-up, 2026-09-30:** the circulated V2 PDF
> retained in the Vault is an earlier uncorrected snapshot. A signed-in
> read-only check of Confluence page 2326571 showed current page V10 (22
> September) with Nikita's named DPO contact and corrected section 20. Direct
> read-only inspection of `https://hour-timebank.ie/privacy` showed a public
> Version 2.0 notice effective 30 September with both corrections. The rendered
> notice bodies matched from the opening sentence to the final DPO contact
> after whitespace and twenty heading-period normalizations (24,744
> characters each). Page metadata/footer and PDF bytes were outside that
> comparison. DPO mailbox access and retirement of the unused address remain
> unverified. The Vault worksheet remains PENDING;
> do not publish the stale circulated PDF. Private evidence:
> `.charitypilot-private/privacy-notice-source-review-2026-09-30.md`.

> **Verified private VM release, 2026-09-30 22:57 Dublin:** source
> `674be7107220acdf8335e107dbb1aa7234f249d8` runs on blue. Exact CI
> 36780803672 and E2E 36780803674 succeeded (239 browser tests); the migration
> gate reported 0 pending, blocked or warned changes. API/web/scheduler and DB
> are healthy, previous green `2f4ffbf9` is stopped and rollbackable, and only
> Caddy publishes the loopback port. All 120 existing backup files stayed
> identical; two new sets were copied off the VM and verified by hash and
> manifest. Supported isolated restore passed (139 migrations, 63 documents,
> 22 risks, 22 governing acts). Signed-in Owner read-only checks reached
> Registers and Security & Data; nine historical replay events and scoped C1
> remain. The ordinary complaint-hold API guard is deployed but independent
> recovery remains inactive. Direct SQL/other writer coverage, independent
> provider custody, host-loss reopening, policy decisions, real role acceptance
> and DPO sign-off remain open. Private evidence:
> `.charitypilot-private/release-674be710-acceptance.md`.

> **Private P01/P02 decision preparation:** the March Data Protection Policy,
> March Privacy Notice and circulated Privacy Notice V2 were checked against
> exact verified backup bytes and retained CWR-2026-11 evidence. March versions
> are proposed SUPERSEDED and V2 proposed CURRENT/RESTRICTED; the circulated
> Privacy Notice V2 still shows two required corrections before publication.
> Eight of 63 worksheet rows have source evidence, seven have a proposal and
> all 63 remain PENDING. No live document or policy setting was changed.

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


Last updated: 2026-09-30

## Resuming the DPO remediation after an interruption

Start with `.charitypilot-private/RESUME-HERE.md` on Jasper's existing workstation.
It records the original email, exact source/live separation, unresolved work,
failed and running checks, authority boundaries and evidence locations. That
folder is deliberately gitignored and absent from a fresh clone. If it is
missing, retrieve the private handoff archive from the operator's existing
backup custody before making claims about private-host or DPO acceptance.
Revalidate the checkout, hosted jobs and live release; a dated handoff is not
proof of current state. Never discard uncommitted continuation work.

## Atomic local preservation outcomes

Private release 24e9ca03 is deployed with bounded runtime, backup, restore and
Owner-navigation acceptance; the private release receipt records exact evidence.
Independent recovery remains inactive and incomplete.

The next source change adds `ComplaintHoldRecoveryOutcome`: insertion applies
the original prepared hold and records its outcome in one PostgreSQL transaction.
The ordinary hold guard rechecks current charity administrator authority and
record/revision state. The outcome guard additionally checks the exact preceding
hold and supplies its own event ID, transaction ID and timestamp. Rollback or an
outcome constraint failure leaves no hold transition. Outcomes are append-only.
The committed evidence reader verifies the original preparation and every hold
decision field, emitting a minimal receipt without reasons or evidence text.

This is an inactive internal primitive, with no route or ordinary service caller.
It does not verify remote publication or enforce the independent writer; that
execution gate, encrypted outcome publication, safe reservation cancellation,
release/replay and other preservation writers remain required before activation.
Do not treat a local outcome as independent custody or reopening authority.
Current source verification is recorded in the private hold-outcome logs; hosted
gates and deployment must be evidenced separately for the resulting revision.

`executePublishedComplaintHold` now composes authenticated published-preparation
verification with the atomic local transition. It requires the exact current
reservation, writer/epoch and latest journal entry, unchanged control throughout
verification, then an exact local writer binding and preparation under the charity
lock. Provider IO finishes before that transaction. A committed retry returns the
existing outcome without another transition; the reservation remains occupied.
The disposable PostgreSQL/crypto protocol test uses a separate charity for this
path and retains the earlier unresolved disposal reservation unchanged. This is
still an internal orchestration path, not database enforcement across all hold
writers. Outcome publication/release, safe cancellation and replay remain open.

Hold outcome preservation now has a strict minimal fact schema and a separate
authenticated `COMPLAINT_HOLD_OUTCOME` envelope with its own encryption domain
and `hold-outcomes/` object namespace. Create-only retries retain original bytes;
published readers require an independently trusted digest and never reconstruct
missing referenced bytes. The real database protocol test also preserves and
opens its committed outcome through real encryption and synthetic S3/KMS.
This storage primitive does not publish a journal entry or release a reservation.
Provider custody, published-outcome verification and all-writer enforcement remain
separate requirements; no live provider configuration or activation is added.

## Inactive complaint database execution gate

The next preservation-writer slice adds `ComplaintHoldRecoveryPreparation` and
`ComplaintHoldRecoveryPreparationStore.capture`. It records a typed, immutable
apply/release candidate with the exact preceding hold, under charity/record/actor
locks and current Admin/Owner authority. Retry returns the original decision;
changed operation meaning is refused. No hold changes or independent publication
occur during capture. The schema excludes complaint narrative and the database
checks the prior event, current revisions, identity and digest. Both restore and
reset inventories include it. Local evidence is recorded in the private hold
preparation logs: API2,523, PostgreSQL5, inventory/reset/restore57 and the full
production-migration integration passed without failures or skips.

The follow-up hold envelope has its own authenticated payload kind and bounded
`hold-preparations/` object namespace. Publication decrypts the original candidate,
checks its reserved facts and unchanged writer/epoch/control, then records
`COMPLAINT_HOLD_PREPARATION_V1` through the existing reserved journal protocol.
Older readers reject this new kind. The published reader verifies full current
history and exact ciphertext, with no recreation fallback for missing bytes.
Candidate storage, journal-entry and head acknowledgement losses resume exact
bytes and operation identity. These are synthetic-provider tests, not AWS custody
acceptance. All receipts still grant no action permission; the reservation stays
occupied. Hold execution/outcome, safe cancellation of stale disposal reservations
and recovery replay remain required before activation. The original role/file,
report, replay-event, C1 and policy acceptance requirements remain open.

Hold-publication verification: API2,525 and separate PostgreSQL5 tests passed
with no failures/skips. SDK transport is synthetic. Keep the resulting revision
steady for exact hosted CI/E2E and supported deployment review before starting
another source slice. Deployment must keep recovery activation off; independent
provider custody and complete execution/replay are not supplied by this release.

Migration `20260930234500_complaint_recovery_execution` adds a durable, immutable
charity/installation/writer binding and transaction-bound execution receipts.
There is no supported activation, disable or writer-replacement command. With a
binding present, old service code and direct claims require a matching execution
in the same transaction; a deferred constraint requires the matching outcome.
Existing Owner, policy, hold, removal and retention guards remain in force.
Application rollback must preserve this binding and fail closed.

`executePublishedComplaintOperation` authenticates the current reserved published
preparation before opening a bounded local transaction. The transaction binds
the exact local preparation and enforced writer, then commits execution, claim
and outcome together. Provider IO stays outside database locks. Both new models
participate in restore comparison. This is inactive complaint-primary support,
not full all-writer protection, external-provider acceptance or permission to
reopen after server loss. No live provider or user-facing path is activated.

Local build, 2,519 API tests, five PostgreSQL checks, 57 inventory/reset/restore
checks and the initial complete guarded-protocol test passed. An expanded
protocol test also passed with Owner/hold/withdrawal changes between receipt
and claim. Final evidence is recorded privately. Hosted gates
and deployment remain separate. Next: durable preservation writer coverage,
document/worker/copy paths, approved custody, replacement isolation and the
original DPO acceptance requirements.

## Recovery protocol composition verification (earlier checkpoint)

The disposable production-migration complaint test now runs
`scripts/complaint-recovery-protocol-proof.mjs`: real Prisma/PostgreSQL capture,
reservation, authenticated preparation publication, atomic claim/outcome,
reconnection, authenticated outcome publication and exact release retry after
a lost acknowledgement. The local run passed without failures or skips.
Encryption is real; S3/KMS transport is synthetic and proves no provider custody.

This is test-only integration of the inactive recovery components. Ordinary
deletion paths still lack mandatory independent-publication enforcement at the
database boundary. Next work must enforce exact preparation/operation/writer
identity in the claim transaction, preserve current dependency guards, and prove
that bypassing the service cannot bypass an activated gate. Do not activate or
claim server-loss readiness from this test. Hosted checks, deployment, real
provider acceptance, replacement isolation and the original DPO acceptance
requirements remain separate gates.

## Current recovery publication checkpoint

The private release receipt `release-6afddb4f-acceptance.md` records deployment
and bounded acceptance of 6afddb4f, superseding the older source-only and d31
release statements below. Independent recovery remains inactive and incomplete.

The local `publishVerifiedComplaintPreparation` integration authenticates and
decrypts existing candidate bytes, checks their canonical facts against the
exact reservation, rechecks the control after decryption, and publishes the
ciphertext digest through the reserved journal path. It never recreates missing
bytes or grants execution authority. Five focused publication tests pass,
including lost acknowledgement and rejection of re-encrypted replacement bytes.
Local suite results are recorded in the private roadmap; hosted verification
and deployment of this follow-up remain separate gates. Outcome/release,
database enforcement, provider activation and full host-loss acceptance remain.

## Inactive recovery reservation acquisition

`recovery-operation-reservation.ts` adds acquisition against a strict format-2
control contract: charity/installation binding, current writer ID and epoch,
journal checkpoint, and one non-expiring operation/preparation digest. Atomic
conflicts and lost acknowledgements require reconciliation or exact retry;
receipts still return `actionAuthorized: false`. No live caller, provider adapter,
release, initialization, writer replacement or database execution fence is wired.
The provider integration must use one authoritative control resource for journal
publication, reservations and writer changes. Do not combine this with a separate
format-1 head or interpret it as host-loss recovery readiness. Preparation facts
and encrypted envelope bytes have distinct digests and must remain distinguished.
Local verification: four focused reservation tests, 2,502 main API tests and four
separate PostgreSQL migration tests pass. Hosted verification and deployment of
this addition remain pending; the private release receipt is authoritative.

The follow-up S3 adapter implements format-2 read/acquisition on the existing
`head.json`, with its existing bounded encrypted/versioned object I/O and ETag
conditional write. Format-1 and format-2 head readers reject one another. The
adapter refuses release and writer/epoch changes. Reserved complaint preparation
publication now advances one journal generation while preserving the exact
active operation and writer. Outcome transitions and database integration remain
unfinished. This is not a
second independent head or an automatic protocol upgrade. No AWS resources,
credentials or live caller have been activated. Focused adapter/reservation
verification passed 22 tests before the subsequent publication integration.
`appendReservedComplaintPreparation` rechecks the writer/epoch/preparation on
every projected head read and conditional write, then uses existing journal
chain/retry verification. The envelope digest must already have been verified by
the caller; this method records it, does not fetch or decrypt it. Publication
retains the reservation and grants no execution permission. Full local tests for
this follow-up are recorded in the private roadmap; hosted/live acceptance remains
separate.

## Recovery authority development and corrected release status

The inactive recovery reader now joins full journal/current-head verification
to exact encrypted preparation bytes through `readPublishedComplaintPreparation`.
The new `COMPLAINT_PREPARATION_V1` kind explicitly binds `factsDigest` to the
envelope SHA-256; older generic kinds are not interpreted as this payload, and
older readers reject the new kind. Missing/replaced envelopes and a head revision
change during decryption refuse the read. This is evidence retrieval only, not
writer reservation, execution fencing, replay application or permission to reopen.
No production caller or provider has been activated. Preserve the separate trusted
checkpoint and provider contracts; never source the expected digest solely from a
restored local database or recreate a missing published envelope.

Hosted verification for the inactive recovery foundation at
4b7eae1edfe16bf168069b9b45b7a9b992d6671a passed: CI 36742905676 and E2E
36742905671 (238 browser tests). It is not deployed or a completed independent
recovery capability. The subsequent aggregate scan-deadline change has separate
local verification; do not attribute that change to the earlier hosted result.

The private release receipt records d31ac597d6af47e307921edb1990353cf10eb618
deployed on 30 September at 15:43 UTC after CI 36737004873 and E2E
36737004807 passed (238 browser tests). It includes both the surviving-document
restore comparison and backup preservation guard described below. Post-release
restore rehearsal and off-host backup hash checks passed. This supersedes their
earlier source-only status, but does not authorize host-loss reopening.

Independent recovery authority is still under development. The new journal
primitive is not connected to production actions. It requires an explicitly
supplied, charity/installation-bound checkpoint from separate trusted custody;
reads and writes refuse history shorter than that checkpoint or with a different
digest at that generation. This detects loss or replacement of known history,
not truncation after an old checkpoint. Receipts never authorize actions.

The separate `inspectCurrent` operation also requires a live independent head
source: it compares complete observed history with two validated head reads and
refuses a changing revision, missing head or unpublished journal suffix. Its
provider contract requires authenticated uncached reads and non-reused revisions.
This is an observation only: action fencing is not implemented, and another
writer can advance immediately afterwards. Do not use it as an execution permit.

The subsequent local `appendPublished` protocol adds conditional head publication
through an abstract provider contract. It resumes the exact operation after loss
of either object-write or head-write acknowledgement, refuses a different pending
operation, and rejects a head behind the separately trusted checkpoint. It does
not create an initial head. Successful receipts still cannot authorize actions.
Real provider integration, durable custody and fencing remain required.

The S3 intent-object adapter is now implemented for explicit credentials, an
Ireland endpoint, expected bucket owner and a configured KMS key. It uses
create-only conditional writes and bounded current-version reads. Its tests
include SDK request serialization/signing through an isolated HTTP handler.
The S3 head adapter now reads a strict envelope, derives a revision from the
bound request/version/ETag/body, and conditionally advances one generation with
a fresh publication UUID. ETag conditional writes are not version-ID conditions;
privileged out-of-band replay remains a custody/policy threat. Missing heads do
not initialize automatically. Combined synthetic journal/adapter restart tests
cover lost publication acknowledgement. Explicit operation deadlines include
response streaming; the SDK warning-only timeout default is overridden.
Each full journal scan also has a 30-second deadline, propagated to S3 reads.
Cancellation cannot be interpreted as an absent object or empty history. This
bounds each scan, not the full multi-phase publication or a database transaction;
it does not replace the durable mutation fence or justify holding locks remotely.
Measured synthetic SDK counts for the current full-scan implementation are
4N+9 GETs and two PUTs per successful publication with N existing entries.
The private deployment/cost review records regional rate sources and assumptions.
Before paid activation, replace repeated whole-history append scans with verified
incremental traversal and make full recovery resumable; also resolve the
10,000-entry capacity/rollover boundary. Do not weaken chain/freshness checks or
raise deadlines as a substitute. No live resource has been provisioned.

An opt-in VERIFIED_PREFIX append mode now reuses only history fully verified in
the same process, rereads its boundary and verifies new entries. Measured warm
appends at 10 and 100 existing entries use 12 S3 GETs and two PUTs. FULL remains
the default; recovery inspection always traverses every entry. Prefix mode does
not re-audit older bytes on every append and must stay disabled until immutable
entry storage is independently enforced and reviewed. Failures invalidate reuse;
known history cannot silently shrink on fallback. Restarts require verification
again. Resumable full recovery, rollover, mutation fencing and activation remain
unfinished; this optimization is not a recovery or disposal authorization.
No S3 resource has been provisioned or live-tested. Provisioning, bucket
policy/retention, independent key custody, fencing and end-to-end recovery
acceptance still gate activation.

Replay/fencing design must account for the actual claim triggers: both primary
records are deleted in the claim transaction; only document byte cleanup is
deferred. A worker-only journal check or post-claim publication is too late.
The ignored replay/fencing contract and source map cover 17 ledger models plus
three mutable state/job models. Review their field-level retention and dependency
requirements before exporting data. Current head observations do not fence a
later hold, and replacement-host writes need an independent writer epoch. Do
not replay old claims through ordinary insert triggers during restore planning.

Before integration, implement fresh independent authority, protected replay
facts, provider durability/permissions, action fencing and supported recovery
reconciliation. The bounded sequential prototype must not be presented as the
complete store protocol or used as permission to reopen. No paid storage or
retention terms have been activated. Full original DPO scope remains open;
private proposal and review pack retain the decisions and evidence.

## Backup preservation guard - 30 September 2026 (source only)

Inspection found age-only recursive deletion of backup sets after deploy and
standalone backup, independent of approved terms or preservation holds. A real
filesystem test reproduced loss of an aged synthetic set. Both commands now
preserve all sets and report the count needing age review; fourteen days is only
a review reminder. No disposal permission or retention term is inferred. All 118
deployment/backup tests pass, including byte-preservation checks through both
command paths. Evidence: private backup-preservation-red.log and
backup-preservation-green.log. No live backup was changed by these tests.

The next release must include this guard together with 289e61f9's restored
document-control comparison. Exact hosted checks and deployment remain pending.
Capacity monitoring, approved backup disposal with current holds, independent
durable authority and supported recovery reopening remain open. Do not deploy
the intermediate restore-only candidate as the final remediation release.

## Verified release and next restore guard - 30 September 2026

Release 5f02c28ea016805c4988976fbe03a7da93486623 passed exact CI
36733408484 and E2E 36733408468 (238 tests) and is deployed on the private
review host. Runtime, local-only host publication, off-host backup hashes and
the supported restore drill passed. Signed-in Owner read-only checks loaded
the new audit feeds and empty document/complaint copy policy and claim histories.
No real policies, holds or disposal decisions were created. Private receipts
and the original six-finding acceptance table remain in the ignored review pack.
This supersedes older source-only release statuses below, not their limitations.

A further restore gap was reproduced in an isolated PostgreSQL restore:
changing a surviving document's hold was accepted when purge history matched.
The comparison now includes full surviving document row hashes, covering
recovery and visibility controls without returning raw fields. All 44 focused
tests pass, including actual PostgreSQL restore drift for hold, active/removed
state, recovery deadline and Member visibility, plus orchestrator refusal and
cleanup. Evidence: private document-restore-controls-verified.log (runner 67734,
exit 0). This additional guard is not yet deployed. Independent durable
authority, supported host-loss reopening and broader original DPO scope remain open.

## Release gate fixture repair - 30 September 2026 (verification running)

Broader CI exposed two stale removal mocks after the policy ambiguity guard:
one still expected the document lock before the organisation lock; one returned
the selected policy for the competing-policy query. Both reproduced locally.
The fixtures now assert the scoped lock/query contracts, and the route scenarios
include a competing approval refusal. All 102 tests in the two affected files
pass. No application guard or expected refusal was weakened.

Evidence: private release-ci-failed.log, removal-fixtures-red.log and
removal-fixtures-green.log. The full API test command is now running; exact new
CI/E2E acceptance and deployment remain pending. Runtime remains e39edbe8.

## Admin copy preservation navigation - 30 September 2026 (source only)

Documents and Registers now include copy preservation administration for existing
Owner/Admin viewers. It discovers committed primary claims through the metadata
archive, then loads exact scope/revision metadata through a new browser-only
copy-scopes endpoint. The service rechecks active Owner/Admin identity, same
charity parent and committed claim; it excludes observation reasons/evidence.
Admins retain no access to Owner-only complaint disposal plans or copy authority.

The panel requires complete scope pages before selection, supports a newly
identified scope at observation revision zero, and opens the existing guarded
hold/release form. Stale revisions are rejected server-side. New-scope entry is
implemented but not separately exercised in the new Admin browser journey.

Nine API/service tests pass, including the role/client/session-level matrix and
scoped metadata selection. API build, web/E2E types and targeted lint pass.
Both compiled isolated Chromium journeys pass (27.5s and 35.1s): a separate
Admin discovers a claimed scope, records a hold and reloads it; Owner approval
controls remain absent. Existing Owner policy/authority/observation/audit flows
also run. Evidence: private admin-copy-browser.log. Runner 81078 completed exit 0.
Runtime remains e39edbe8. No real policy or business record changed. Exact release
verification and live acceptance, plus broader original DPO scope, remain open.

## Retention and disposal audit coverage - 30 September 2026 (source only)

Nine additional metadata feeds cover retention policy revisions/withdrawals,
complaint recoverable removal, and document/complaint primary disposal authority,
withdrawal and claim. Authorization/claim feeds page by their own recorded times
with an ID tie-breaker. The dashboard displays those timestamps and explicitly
labels document claims as requiring a storage receipt. It excludes decision
reasons, evidence references, disposition plans, storage paths and transaction IDs.

All 35 audit API tests pass (nine initial missing-feed failures preserved in
private lifecycle-audit-red.log; green run in lifecycle-audit-green.log).
API build, web/E2E types and targeted lint pass. Both compiled isolated browser
journeys pass in 55.3s, including populated policy, primary and copy audit feed
responses and rendered decision labels, with private fields absent from payloads.
Evidence: private lifecycle-audit-browser.log. Runner 37220 is terminal exit 0.
Runtime remains e39edbe8; source is not yet deployed. Admin preservation navigation,
release checks, live acceptance and broader original DPO scope remain outstanding.

## Scoped copy authority dashboard - 30 September 2026 (source only)

Owners can now load complete scoped authority/hold histories and copy-policy
history from the existing document and complaint observation forms. Exactly one
unwithdrawn approved copy policy is required. The form records explicit scope,
observation, predecessor and hold revisions, separate retention/hold evidence,
reason, expiry and a reviewed creation anchor for timed policies. It supports
withdrawal without grant fields. Changing evidence clears confirmation; every
submission invalidates review state, including uncertain responses.

An explicit selection attaches current scoped authority to a later observation
and changes the available outcomes to its reviewed disposition. The database
still rechecks ownership, policy, retention, holds, chronology and expiry.
Loading/refreshing review clears the selected observation authority. This UI
is not provider erasure or aggregate-erasure proof.

Two scope/policy selection unit tests pass. Web/E2E type checks and targeted lint
pass. Both compiled isolated Chromium journeys pass (58.4s), including copy
policy proposal/approval/withdrawal, hold/release, a retained scope reauthorized
for disposal, an explicitly bound absence observation, and authority withdrawal.
Evidence: private copy-authority-ui-browser.log. Session 76759 is terminal exit 0.
Runtime remains e39edbe8; no live business record or policy changed. Admin
preservation navigation, remaining lifecycle audit coverage, exact release and
live acceptance plus the original broader DPO requirements remain open.

## Copy retention policy dashboard - 30 September 2026 (source only)

Documents and Registers now expose separate DOCUMENT_COPY and COMPLAINT_COPY
policy panels through the existing restricted policy component. Admins can
propose terms; Owner approval and withdrawal use the established server gates.
Timed rules name reviewed copy creation as their anchor. No period is supplied
automatically. Copy-specific text distinguishes recorded recovery terms from
actual provider recovery and requires separate scoped authority for disposal.

Both compiled isolated Chromium journeys pass (48.1s): each retains a proposal,
requires explicit approval confirmation, approves a separate copy policy,
withdraws it and displays both historical revisions. They also repeat primary
disposal and copy hold/release coverage. Web/E2E type checks and targeted lint
pass. Evidence: private copy-policy-ui-browser.log. Session 24571 is terminal,
exit 0. No live policy changed. Runtime remains e39edbe8; deployment, scoped
copy-authority forms, Admin preservation access and wider DPO acceptance remain.

## Scoped copy preservation dashboard - 30 September 2026 (source only)

The document and complaint copy-observation forms now provide preservation
history and exact-scope hold/release review. A changed scope or observation
remounts review state; the complete paginated hold history is required before
submission. Evidence changes clear confirmation. Every submission, including an
uncertain response, invalidates the loaded revision before another attempt.
Release explicitly does not approve deletion or revive earlier copy authority.
The existing parent screens currently expose this workflow to the Owner;
Admin dashboard access and copy-authority review forms remain outstanding.

The scope-selection test, web/E2E type checks and targeted lint pass. Both
isolated Chromium journeys pass (39.5s total): each family records/releases a
hold, retains both decisions and clears confirmation when evidence changes.
The compiled disposable stack passed its readiness gates. Evidence: private
copy-hold-ui-browser.log. All handles are terminal. Runtime remains e39edbe8;
these are synthetic local checks, not live charity acceptance or deployment.

## Copy review audit integration - 30 September 2026 (source only)

Governance Audit now exposes six metadata-only feeds: document and complaint
copy authority decisions, scoped preservation holds and copy observations.
The dashboard names each history and links back to its restricted record area.
Reasons, scope references and evidence references are excluded from the overview.
Observations are labelled as observations, not proof of aggregate erasure.

All 26 audit API tests pass, including six new cases covering Member/connector
refusal, same-charity cursors, equal-timestamp pagination and exact response
projections. API build, web type check and targeted page lint pass. Private
copy-audit-red.log preserves six initial missing-feed failures; copy-audit-green.log
records the passing run. No live records changed. Runtime remains e39edbe8;
real browser verification, remaining lifecycle audit feeds, copy-review forms,
deployment and the broader original DPO scope remain open.

## Copy review API - 30 September 2026 (source only)

Document and complaint families now expose browser-only copy-authority and
copy-hold history/write endpoints beneath their purge authorization, plus
separate copy-policy proposal/approval/withdrawal endpoints. Authority review
and its history require the active Owner; holds allow active Owner/Admin.
Policies allow Admin drafts and Owner approval/withdrawal. All mutations require
ADMIN session level; direct connector access is refused. The server selects
DOCUMENT_COPY/COMPLAINT_COPY, never a submitted record class.

Strict review bodies require explicit confirmations, exact prior/scope/observation
and hold revisions, evidence and bounded dates. Withdrawal cannot smuggle grant
fields. Transactions recheck actor and same-charity primary claim, paginate
history within that parent and convert named database conflicts into safe review
guidance. No endpoint dispatches provider deletion or declares aggregate erasure.

42 focused API/service tests pass, including both route prefixes, every role,
WEB/connector sessions, READ/WRITE/ADMIN levels, controlled IDs, confirmations,
scoped pagination and independent copy-policy histories/anchors. API build and
408 connector tests pass (two Windows skips). Evidence: private
copy-review-api-final.log, copy-review-build-final.log and copy-review-mcp.log;
initial missing-module failures are retained in the red logs. All handles are
terminal. Metadata-only governance audit integration, dashboard controls,
real browser journeys and exact hosted/deployment acceptance remain next.
Runtime remains e39edbe8. No live policy or record changed.

## Vault policy ambiguity guard - 30 September 2026 (source only)

The legacy document-retention proof exposed a real guard gap: a selected
approval could still support removal/authorization/claim while another approved
VAULT_DRAFT policy remained unwithdrawn. Normal policy replacement already
withdraws previous approvals; this fix also rejects ambiguous direct database
state. Migration 2200 adds the check at all three transitions without editing
historical policy decisions or creating a cleanup job on refusal.

Recovery API transactions now lock the organisation before the document, matching
policy and purge ordering. Removal refuses competing approvals before reading
stored bytes. Withdrawal of the competing approval permits the reviewed operation;
original recovery deadlines, retention checks, holds and atomic deletion remain.
No evidence establishes that this ambiguous state exists in the live charity.
Runtime remains e39edbe8; this migration and the copy-control changes await release.
Review-management API/UI, metadata audit and full original DPO scope remain open.

Ambiguity proof: the initial database and service tests accepted the operation
and failed as expected. Final populated PostgreSQL proof passes in 65.38s,
including an explicitly lock-ordered concurrent approval/claim refusal, no
cleanup dispatch on refusal, and successful rollback-contained disposal after
reviewed withdrawal. All 21 focused recovery/purge API tests and API build pass.
Migration 2200 gate: zero blocked, zero warnings, no override. Private evidence:
document-policy-conflict-{red,api-red,api-green,final,build}.log and gate.json.
All test handles are terminal. The previously recorded primary-policy invariant
gap is fixed in source; live deployment/acceptance remains outstanding.

## Copy policy and observation binding - 30 September 2026 (source only)

Migration 2100 binds later document/complaint copy authority to a separately
approved DOCUMENT_COPY or COMPLAINT_COPY policy. Timed rules require a reviewed
copy-creation anchor and elapsed retention; permanent rules permit retention,
not disposal. Policy creation/withdrawal serialize with review consumers.
No policy is seeded or approved by this migration.

Observations can reference an exact current scoped authority. The database
rechecks its scope, active Owner, expiry, policy and unheld revision; evidence
cannot predate that authority. Withdrawal/expiry cannot silently reactivate the
original plan. Original-plan final observations also require that original
policy to remain current. NEEDS_REVIEW/FAILED facts remain recordable without
claiming a new disposal permission. Existing observations retain their original
binding; no evidence is retroactively attached to a newer decision.

Document and complaint observation APIs accept and return the controlled
copyAuthorityId, and translate these database refusals into safe review guidance.
Creating/reviewing copy policies, authorities and holds through restricted API/UI,
metadata audit integration, real browser journeys, hosted gates and deployment
remain next. External evidence and supplied anchor dates still require reviewer
verification; this does not independently prove provider disposal or all copies
absent. Runtime remains e39edbe8; migrations 1900/2000/2100 are not deployed.

Binding evidence: complaint PostgreSQL proof passed in 65.27s (the complaint
result in copy-binding-database-final.log); final document proof passed in
61.86s in copy-binding-document-final.log after explicitly resolving the
fixture's ambiguous approvals. Coverage includes policy withdrawal racing an
observation, hold racing an observation, release requiring a fresh review,
expiry, no fallback after withdrawal, scoped binding/chronology, timed and
permanent policy checks, original-policy withdrawal and populated restore.
All 27 focused API tests and 94 supporting restore/model/reset/backup tests
pass; Prisma validation/generation and API build pass. Pending migrations
1900/2000/2100 pass the static gate: zero blocked, three warnings, no override.
API evidence: copy-binding-api-{red,green}.log; build-final/unit/gate receipts
use the copy-binding prefix. All local handles are terminal. No live changes.

## Scoped copy preservation - 30 September 2026 (source only)

Migration 2000 adds immutable document/complaint copy-hold histories under the
retained primary disposal authorization. Active same-charity Owner/Admin review
can preserve a named area/scope even before its first observation. Releases
require the exact next revision; stale observation reviews, repeated states,
foreign actors and immutable-history edits are refused. Primary records need
not exist. Restore comparison and disposable reset/model inventories include
both ledgers.

New scoped authority records bind an explicit hold revision and require the
current scope to be unheld; withdrawals remain possible while held. A hold
arriving after a review is retained independently, so eventual consumers must
recheck that hold revision rather than treating the older review as current.
This is persistence and database enforcement only: API/UI, metadata audit,
current policy binding and observation-time authority checks remain to be
implemented. No external copy was deleted and no policy decision was approved.
Runtime remains e39edbe8; migrations 1900/2000 are not deployed.

Scoped-hold evidence: final real PostgreSQL complaint proof passed in 58.69s
and document proof in 54.76s. Coverage includes Owner/Admin versus Member,
suspended and foreign actors; newly discovered scopes; release/stale binding;
withdrawal while held; both explicitly lock-ordered hold/review races; and
populated restore rejection when hold history is missing. Supporting 94 tests,
Prisma validation/generation and API build passed. Combined pending migrations
1900/2000: zero blocked, two index warnings, no overrides. Private evidence:
copy-hold-{red,database-final,unit,build}.log and copy-hold-migration-gate.json.
All local test/build sessions are terminal. No live deployment occurred.

## Scoped copy authority persistence — 30 September 2026 (source only)

Migration 1900 adds separate document and complaint scoped authority histories.
An active same-charity Owner can append a time-limited reviewed decision against
an existing primary claim and exact area/scope observation revision. Exact
predecessor identity and revision prevent stale replacement. Separate controlled
retention and hold-review references are mandatory; withdrawal grants nothing,
and replacement preserves every prior decision. No primary plan is rewritten.
Restore comparison hashes both histories and disposable-reset/model inventories
include them. References are reviewer evidence, not independent verification.

This is the persistence increment, not an enabled disposal workflow. No API or
UI can create these records yet; existing observations deliberately continue
using the original plan and reject contradictory absence assertions. Next:
bind observations to exact scoped authority, recheck current policy/holds and
expiry under the shared locks, add restricted browser review and metadata audit,
and prove withdrawal/policy/hold races and both browser journeys. No provider
operation, policy approval, production migration or live data change occurred.
Runtime remains e39edbe8. Broader original DPO scope remains open.

Persistence evidence: real disposable PostgreSQL complaint proof passed in
53.98s and document proof in 51.32s, including stale restore rejection, immutable
withdrawal/replacement history, original-plan preservation, no implicit absence
authority and competing complaint authority revisions. All 94 supporting
restore/model/reset/backup tests pass; Prisma validation/generation and API
build pass. Migration gate: zero blocked, one new-table index warning, no
override. Private logs: copy-authority-database-final.log,
copy-authority-unit-final.log, copy-authority-build.log; initial missing-table
failure is recorded in copy-authority-red.log. All test handles are terminal.

## Verified deployment — 30 September 2026

Private runtime e39edbe8f220c9118d248ab7d92d95a603ba1cbb is live on green
since 13:49:34.968 UTC (14:49 Irish time). Exact CI 36722795524 and E2E
36722795397 succeeded; all 238 browser tests passed. The four migrations
1500/1600/1700/1800 passed the gate with zero blocked, four warnings and no
override. Candidate/front-door smoke, runtime health and exact scheduler
identity passed. Previous blue e5e988a3 is stopped and retained for rollback.
Only Caddy publishes 127.0.0.1:8080; the local Docker boundary was re-proved.

Complaint holds, Owner disposal authorization/withdrawal/claim, immutable
receipts, per-scope copy evidence and complaint-aware restore reconciliation
are now deployed. Signed-in Owner read-only acceptance reached Registers and
the fully loaded complaint-disposal panel, showing no disposal reviews. No
live retention policy, complaint purge or copy observation was created.

Cutover backup 2026-09-30T13-48-44-971Z and post-migration backup
2026-09-30T13-50-38-535Z have off-host copies with all three file hashes
verified against the host; dump/archive hashes also match their manifests.
The supported isolated restore drill passed with 129 migrations, 63 documents,
22 risks and 22 governing acts. Live complaint/policy/purge ledgers are empty;
populated destructive-workflow proof comes from isolated tests. This drill
is not authority to reopen a restored application after host loss.

Later approved changes to copy dispositions, independent durable purge
authority, supported recovery reopening, remaining classes/stores, real
record/audience decisions, historical replay attribution, role-specific live
acceptance and DPO/controller approval remain open. This is bounded private
release evidence, not public-launch or formal DPO sign-off.

The implementation checkpoints below are historical. Their source-only and
pending-deployment wording is superseded by the verified release above.

Complaint copy-evidence dashboard checkpoint (source only): shared evidence
controls now map complaint scopes/endpoints explicitly while retaining the
document workflow. Owner history supports new scope observations, follow-up
dates and append-only later observations without claiming aggregate erasure.
Isolated Chromium passed both journeys on first attempt: complaint 14.9s,
document regression 21.4s, total 37.8s; runner 83685 exited 0. Complaint proof
includes retained-backup evidence, revision-two reopening, historical revision
preservation, reload, exact actor and primary absence. Document proof preserves
its separate primary deletion-job state. Web/E2E type checks and edited-file
lint passed. Evidence: private complaint-copy-browser.log. All local handles
are terminal. Later changes to approved copy dispositions, exact hosted gates,
deployment/live acceptance, independent durable restore authority and broader
DPO scope remain open. Runtime remains e5e988a3; no live data changed.

Complaint copy-evidence API checkpoint (source only): Owner browser GET/POST
disposition routes now expose scoped, paginated history and append-only reviewed
observations. Writes require ADMIN session level, active charity Owner and a
primary disposal claim; strict input excludes primary disposition, spoofed actor
fields and unconfirmed evidence. Retained/unresolved statuses require follow-up
dates. Database guards remain authoritative for times, revisions and approved
plan consistency; conflicts return safe review guidance. No deletion is
dispatched by copy observations, and no aggregate erasure claim is returned.
Initial focused tests failed for missing methods; implementation passed 42
API/route tests, 408 MCP tests (two Windows skips) and API build. Private logs:
complaint-copy-api-{red,green,mcp,build}.log. Dashboard observation controls,
synthetic browser proof, separately reviewed later disposition changes, exact
hosted gates and deployment/live acceptance remain. Runtime remains e5e988a3.

Complaint copy-disposition persistence checkpoint (source only): migration 1800
adds immutable per-scope observations for snapshots, exports, audit/evidence,
backups and other copies. The primary deletion result remains its separate
claim receipt. Same-charity active Owner authority, an existing claim, exact
scope revision, consistency with the reviewed plan, bounded observation time
and future follow-up for retained/unresolved scopes are enforced in PostgreSQL.
Concurrent corrections accept exactly one. Restore inventories now include this
ledger; old populated backups lose authority and are refused. Real complaint
migration/backup proof passed in 51.5s, 94 reconciliation/model/reset/backup tests
passed, Prisma validate/generate and API build passed. Static migration gate:
zero blocked, one new-table index warning, no override. Private logs use prefix
complaint-copy-ledger. Initial test correctly failed for the missing ledger.
API/UI recording and real browser proof remain next. Retained scopes needing a
later change of approved disposition also require separately reviewed authority;
the immutable original plan must not be silently changed. Exact hosted gates,
deployment/live checks and wider record/store coverage remain open.

Complaint purge dashboard checkpoint (source only): Owner-only Registers panel
now supports explicit six-area copy-plan review, exact recovery/hold/policy
binding, withdrawal, separate permanent-action confirmation and paginated
retained history. No disposition defaults are chosen for downstream copies.
Confirmation is required; successful claim refreshes the recovery list without
unmounting the review. Receipts explicitly distinguish primary disposal from
erasure of retained copies. Synthetic Chromium journey passed in 10.5s (runner
83953 exit 0), including authorization, withdrawal, second review, confirmation,
primary absence, exact Owner receipt, recovery-list refresh and history after
reload. Initial run failed on exact selector-label lookup; explicit accessible
labels fixed it. Web/E2E types and edited-file lint passed. Evidence: private
complaint-purge-browser-fixed.log; initial failure is retained separately.
Scoped downstream disposition evidence, exact hosted gates, deployment and live
acceptance remain required. Runtime remains e5e988a3; no live records changed.

Complaint purge API checkpoint (source only): Owner browser routes now list
paginated reviews, authorize an exact removed revision/recovery decision,
withdraw unclaimed authority and explicitly confirm a primary purge claim.
Writes require ADMIN session level; every service transaction rechecks active
same-charity Owner membership. Input binds original recovery deadline, removal,
policy, record/hold revisions and all six reviewed copy-plan areas. Database
guards remain authoritative for changed holds/policies and expiry. A retry
returns the existing receipt without another deletion; transaction IDs are
excluded. API conflicts give a refresh/review message without raw database text.
Focused API tests: 44 passed. MCP: 408 passed, two Windows skips. API build
passed. Read/write connector coverage explicitly excludes all four new routes.
Private evidence: complaint-purge-api-final.log, complaint-purge-mcp.log and
complaint-purge-api-build-final.log. Dashboard confirmation/history, scoped
copy-disposition records, real browser proof, exact hosted gates and deployment
remain; no live purge or policy change occurred. Runtime remains e5e988a3.

Complaint purge concurrency checkpoint (source only): populated PostgreSQL
tests now prove both orderings of hold/claim, withdrawal/claim and restore/claim.
Each ordered test keeps the first transaction open until pg_stat_activity
confirms the second connection is waiting on a database lock. A hold or
withdrawal committed first blocks claim; claim committed first prevents a new
hold/withdrawal. Valid restoration invalidates the reviewed removed revision;
a raw restoration UPDATE waiting behind deletion affects no row and cannot
resurrect it (the recovery service separately returns not-found). A valid
single-Owner transfer also refuses the former Owner's claim. The first fixture
incorrectly attempted an ownerless charity and was rejected by the existing
continuity constraint; the corrected transaction transfers ownership legally.
Full populated migration/backup proof passed in 47.2s. Evidence is in private
complaint-purge-race-db-fixed.log. This closes the named database race gap;
API/idempotency, confirmation UI, downstream copy evidence, hosted gates and
deployment/live acceptance still remain. Live runtime is still e5e988a3.

Complaint purge claim persistence increment (not deployed): a claim rechecks
unwithdrawn same-Owner authority, exact removed record, current approved policy,
unchanged unheld revision, original recovery deadline and elapsed retention.
Database-generated transaction identity binds the guarded primary DELETE to the
claim; an AFTER trigger deletes exactly one complaint and appends metadata audit
atomically. Any later transaction error restores all three. Claims are immutable,
unique per complaint/authorization, prevent identity reuse and prohibit later
withdrawal. Restore reconciliation includes claim history and rejects any
claimed complaint still present even when source and restored snapshots agree.
Real proof covers early/withdrawn/stale-policy/stale-hold refusal, rollback after
delete and two competing claims accepting exactly one. Explicit hold/withdrawal/
restore-versus-claim race coverage, API/idempotent retry UI, downstream evidence,
hosted gates/deployment and bounded live acceptance remain required before
calling complaint purge operational. No live records or policies changed.

Earlier complaint purge review persistence checkpoint (superseded by the claim checkpoint above; not deployed): immutable
ComplaintPurgeAuthorization binds the current removed closed complaint revision,
removal decision and original recovery deadline, latest unheld revision, active
same-charity Owner and one current approved COMPLAINT policy. Timed policies
require resolution evidence matching the original removal revision. The plan
covers PRIMARY, SNAPSHOTS, EXPORTS, AUDIT, BACKUPS and OTHER_COPIES with controlled
references. Owner withdrawals retain history. Both tables participate in restore
reconciliation. These are reviewed intentions only: hard DELETE remains blocked,
no execution route exists and no copy is erased. Next implement a separately
verified atomic claim/delete receipt, rechecking policy/hold/owner/record and
retention/recovery expiry; prevent withdrawal after claim, retain metadata audit,
and extend restore resurrection checks before enabling the API/dashboard flow.

Complaint-aware restore reconciliation increment: the current-authority snapshot
now hashes complaint resolution, removal and hold ledgers plus current complaint
revision/recovery pointers. This refuses an old restore that loses hold decisions
or reactivates removed records even when append-only history alone would match.
Raw narratives, evidence references and reasons remain inside PostgreSQL.
Missing complaint inventories fail closed. The real complaint migration proof
now dumps/restores old and current populated databases: old history/state is
refused and the current copy matches. This is bounded same-host authority proof,
not independently durable authority or permission to reopen after host loss.
Exact successor hosted gates, private deployment and live restore drill remain
required. Continue complaint purge authorization/claim and broader R4 scope.

Complaint hold application checkpoint: browser-only Owner/Admin hold history and
state-change routes are implemented, with Admin session level for writes, active
actor checks, charity/record/actor locks and exact record/hold revisions. Active
holds now produce explicit retention/removal refusals. Governance Audit lists
hold transition metadata without case reasons/references. Registers supports
reviewed apply/release for active and recoverable complaints, preserving the
selection and refreshing assessment after changes. Isolated Chromium passed
first-attempt after a UI fix (16.8s, runner exit 0): apply blocks removal, release
permits reviewed removal, a new hold on the removed record survives restoration,
contents remain identical and all three hold events bind the exact actor.
The initial test found a whole-page refresh losing the selected complaint; only
hold history/assessment now refresh. All 58 focused API tests, 408 runnable MCP
tests (two Windows skips), API build, web/E2E types and edited UI lint pass.
Evidence: private complaint-hold-api.log, complaint-hold-mcp.log and
complaint-hold-browser-fixed.log. Security & Data wording changed after the
browser snapshot and passed focused lint. Exact hosted/deployment gates remain
required; runtime remains e5e988a3. Next implement guarded complaint purge,
copy disposition and complaint-aware restore reconciliation, preserving all
broader record/store, durable authority, reopening and DPO acceptance scope.
Older hold checkpoints below describe implementation order, not current API scope.

Complaint hold persistence increment (not yet deployed): append-only
ComplaintHoldEvent records alternating apply/release decisions, exact complaint
and hold revisions, active same-charity Owner/Admin, controlled evidence and
reason, with database timestamps. Holds apply to active and removed records
without changing complaint content or resolution revisions. Database guards
reject removal decisions and removal/purge while held; restore preserves the
hold. Retained hold identities cannot be reused. Real PostgreSQL proof covers
unauthorized/stale transitions, append-only history, holds arriving after removal
review, restoration without clearing a hold and competing hold writes.
Restricted API, dashboard, metadata audit feed, assessment/removal messages and
isolated browser proof remain required before calling this a usable hold control.
Then continue complaint purge and the full remaining scope below.

Current private runtime: e5e988a364c7ace46c7e77ac1a6821fb8cd2f17e on blue,
deployed at 12:46:33 UTC. Exact CI 36715435652 and E2E 36715435558 succeeded;
all 237 browser tests passed first-attempt, including the complaint recovery
journey. Two migrations passed the deployment gate without override. API/web
health, front-door smoke and exact scheduler version passed. Only Caddy publishes
127.0.0.1:8080; Tailscale Serve remains tailnet-only. Previous 442eb788 on green
is retained for rollback. Cutover/post-migration backups have verified off-host
copies; the supported isolated restore drill passed with 125 migrations.
Live complaint, policy and purge ledgers are empty, so this drill does not replace
populated synthetic proof or authorize host-loss reopening. Signed-in Owner
read-only acceptance confirms complaint resolution/recovery/policy panels,
empty policy history and Governance Audit. No live policy or complaint changed.

Next: audited complaint holds before permanent purge, then separate Owner
authorization/claim, retained-copy evidence and complaint-aware restore
reconciliation. Preserve broader R4 record/store coverage, independently durable
purge authority, supported recovery reopening, role/content acceptance and all
original policy/historical review decisions. Security & Data wording/navigation
is corrected in the working source after this release; it is not yet deployed.
The private release-e5e988a3-acceptance.md and complaint-purge-implementation-contract.md
record the restricted operational evidence and next implementation contract.
Older checkpoints below are historical and do not override this runtime status.

Complaint recovery application checkpoint: browser-only Admin-level remove and
restore routes now use charity/record/actor locks, current revision checks and
transactional policy/evidence validation. Removal retains the immutable decision;
restoration is limited by the recorded deadline. Both append actor-bound register
audit transitions without copying complaint narratives. Registers now offers
reviewed removal, a paged recovery list and confirmed restoration. Legacy DELETE
remains refused and points to these controls. The isolated Chromium journey
passed first-attempt (10.5s): active-list removal, recovery listing, content-identical
restore, both exact actor audit entries and stale resolution evidence afterward.
Runner exit 0. All 121 affected API tests, 408 runnable MCP tests (two Windows
skips), API build, web/E2E types and edited-file lint pass; the real recovery
migration proof passes again (25.3s). Exact successor hosted checks and private
deployment are not yet accepted. Prioritize finishing those gates and deploying
this complete recovery increment before the next purge implementation. Complaint
purge, other record classes/stores, durable purge authority and recovery reopening
remain in scope, alongside policy and role/content acceptance decisions.

Complaint recovery persistence checkpoint: ComplaintRemoval now retains scoped,
immutable actor/policy/evidence decisions and a database-calculated recovery
deadline. ComplaintRecord has a guarded removal pointer and timestamp. The
database requires a closed complaint without board evidence, current approved
complaint policy and elapsed matching resolution evidence for timed rules.
Removal and restoration preserve content; removed records cannot be edited or
receive resolution evidence, stale authority cannot be reused, and hard deletion
is refused pending the separate purge workflow. Ordinary lists/details, edits,
counts, search and working exports exclude removed complaints. The application
removal/restore service, UI, actor-bound restore audit and browser acceptance
remain open; no new runtime deployment occurred. Real PostgreSQL migration
proof passes, including restoration, withdrawn evidence/policy and expired
recovery refusal (expiry uses fixture-only time travel with append-only
protection re-enabled before testing). All 119 affected API/search/export tests,
51 model/reset checks, schema validation, API build and 408 runnable MCP tests
pass (two Windows skips). CI now names both complaint migration proofs.

38ed10ad CI 36713260937 failed because the legacy delete blocker returned 409
instead of scoped not-found for another charity's record. The implementation
now performs the same-charity active-record lookup before refusing deletion;
the existing cross-tenant contract passes without weakening its assertion.
Exact successor hosted gates remain required. E2E 36713260920 was still running
at its last observation; do not infer completion from the failed CI result.

Complaint policy/assessment checkpoint: the policy service now separates
COMPLAINT from VAULT_DRAFT, with RESOLVED_AT as the complaint timed anchor.
Browser-only administration permits Admin proposals and Owner approval or
withdrawal. A read-only assessment requires one current approved class policy
and the latest matching resolution evidence; it never authorizes removal.
Registers exposes policy history/administration and assessment. Legacy immediate
complaint deletion is refused with COMPLAINT_RECOVERY_REQUIRED until recoverable
removal is implemented, so new policies cannot coexist with that API bypass.
Forty-two focused API tests pass, including class isolation and deletion refusal.
The two isolated Chromium journeys pass first-attempt (complaint assessment and
existing exact-byte Vault recovery); runner exit 0. The deletion guard was added
after that browser image was built and is covered by the focused API tests.
MCP checks pass (408 runnable, two Windows skips); web/E2E types and edited web
lint pass. Hosted successor gates and deployment remain pending. Next implement
policy-bound recoverable complaint removal/restore, then purge; retain the
broader R4 stores, independent purge authority and recovery-reopening scope.

Complaint resolution review increment: Owner/Admin browser-only history and
submission routes, a Registers review panel and a metadata-only Governance Audit
feed are implemented locally. Both record and evidence revisions are checked
under the charity lock. The isolated Chromium journey passed first-attempt:
two competing browser reviews produced one 201 and one 409; withdrawal and
correction preserved history; reopening invalidated the earlier evidence.
The managed runner completed with exit 0. Fifty focused API/audit tests,
408 runnable MCP tests (two Windows skips), API build, web/E2E type checks
and edited web-file lint pass. The browser proof preceded the additive audit
feed and callback cleanup; exact successor hosted acceptance remains required.
No new private deployment occurred. Policy consumption, recoverable complaint
removal, purge and broader record/store coverage remain technical work.

Complaint retention persistence checkpoint: a new, locally verified migration
adds database-maintained complaint revisions and append-only resolution evidence.
Evidence requires the current closed complaint, a valid resolution date and an
active administrator of the same charity. Corrections and withdrawals retain
history; subsequent complaint edits invalidate the earlier anchor, and removed
identities with retained evidence cannot be reused. Existing complaints receive
no inferred resolution date. The disposable PostgreSQL migration proof passes,
as do schema validation, API build, 51 model/reset checks and 408 runnable MCP
checks (two Windows skips). This slice is not deployed. Restricted API, review
UI, concurrent request proof, policy consumption, recoverable complaint removal
and purge remain open. No policy is activated and no live complaint is changed.

Private deployment checkpoint: 442eb788920bb79b021eaef668c1a97af3bf81ce is live
on the existing private host from 11:44:52 UTC. Exact CI and E2E succeeded;
E2E recorded234 first-pass and two retry passes. Eight migrations passed the
unchanged migration gate; candidate/front-door checks and runtime health pass.
Pre/post-migration backups have matching off-host copies and the supported
post-migration isolated restore drill passed. The previous321a0c84 runtime is
retained for rollback. The live purge ledger is empty: this drill does not
prove recovery of populated purge history or authorize reopening after host
loss. Owner browser checks confirm the22-act Minute Book, governance audit,
empty recovery/policy lists and nine existing replay events. No live policy,
classification, report approval or deletion was performed. Broader record
classes, independently durable purge authority and recovery reopening remain
technical scope; policy decisions and role-specific acceptance remain open.

The two442eb788 retry cases are repaired locally: register history now owns its
charity; the token-disclosure journey owns its integration and explicitly tests
disconnected and connected-without-a-space states. It no longer assumes that
every connected account offers Change the space. Both complete spec files pass
together,24 first-attempt journeys (1.2m), managed runner exit0. TypeScript and
all116 runner contracts pass. This follow-up changes tests only, not runtime
behavior; exact successor hosted results are not yet available.

Further browser isolation checkpoint: 5b0e7c66 E2E completed with234 first-pass
tests and two retry passes. Compliance pagination inherited six earlier audit
rows; the Confluence connection journey inherited an existing integration.
Both journeys now create their own verified charity and fenced browser context.
The focused pair passes first-attempt locally (9.9s), managed runner exit0;
E2E TypeScript and all116 runner contracts pass. Assertions and product behavior
are unchanged. Exact successor hosted checks remain required. The efa2e27e CI
has passed local Docker smoke and the Linux MCP connector gate; its complete
CI/E2E results were still pending at this checkpoint. No new deployment.

Connector inventory follow-up: 41c00edf CI 36707087273 passed the previously
failing local Docker smoke, then found missing route and field classifications
in the MCP coverage ledger. Recovery/policy/purge administration is now explicitly
excluded with human-review reasons, matching existing API web-session guards;
eight new Document fields are classified as withheld by the connector privacy
filter. The inventory also names sibling-file purge reads and dynamically
registered claim/withdraw actions. No connector tool or access was added.
All408 runnable connector tests pass locally; two POSIX/symlink tests are skipped
on Windows and remain required in Linux CI. Exact successor checks are pending.

Browser retry follow-up: the three 6671d6fd retries were traced to fixture/input
behavior. The exact-count history test shared a worker charity, inheriting seven
earlier rows and leaving 202 future-dated rows ahead of later removal events.
It now uses its own charity and fenced context. The purge datetime fixture now
uses Chromium's canonical datetime-local value and checks millisecond fidelity;
Playwright rejects a noncanonical value such as .800 when Chromium stores .8.
All three affected journeys pass together on the first local attempt (34.3s),
runner exit0, with unchanged product behavior and no relaxed assertions. E2E
TypeScript and all116 isolation contract tests pass. Exact hosted confirmation
for this test revision remains required.

Local Docker startup follow-up: 6671d6fd CI 36705637183 passed the main tests,
reliability ledger and PostgreSQL backup/restore, then its smoke API exited.
A disposable PostgreSQL/application reproduction identified the demo seed's
missing required deadline-audit actor. It now passes the seeded Owner ID and
preserves an existing sample risk instead of overwriting its reviewed state on
restart. First and repeat seed through all 123 migrations pass, retaining four
starter documents and four same-charity deadline audit entries. Seed TypeScript
checking is now part of the API test command; 45 local-stack and 116 runner
contract tests pass. No live host was changed. Exact successor gates remain.

6671d6fd E2E 36705637418 completed successfully: 233 passed and three flaky
tests passed on retry (purge observation timestamp input, document history
pagination, and retained case linkage after removal). These are recorded
follow-ups, not a clean first-attempt result or successor/deployed evidence.

Logout release-gate correction: 60b07ed9 CI 36704289527 and E2E 36704289606
failed the isolated-runner contract because the new browser tests installed
request handlers over the origin fence. The earlier three-test pass below is
superseded for release acceptance. Replacement delayed-logout checks hold the
synthetic organisation database row and pass through the unchanged fence;
both dashboard and idle checks pass, as do all 116 runner contract tests.
Offline diagnostics exposed the Logout button's lazily loaded ripple animation:
its failed chunk download triggered a reload without a connection. Disabling
that button's ripple preserves the visible retry. All three replacement
Chromium journeys now pass (including no page errors on offline retry), along
with E2E TypeScript and edited-file lint. Exact successor hosted checks and
deployment remain required. The recovery runbook also records the current
purge-history comparison and its explicit refusal to authorize reopening.

Reliability ledger follow-up: 2e2267be CI 36703357729 passed the test step but
found eight stale guarantee links. Their claims still described immediate
document deletion/cleanup and broad Member deadline reads. Existing IDs now
describe provider-pinned upload reservations, recoverable removal, reviewed
purge claim retry and current-rule Member deadline scope, linked to the actual
tests. The executed reliability command reports API 2561/Web 542 passing test
titles and all 509 covered links verified; docs/RELIABILITY.md is regenerated.
Those are report/title counts, not new independent or deployed acceptance.

DPO-02 logout ordering repair: dashboard navigation and idle expiry previously
started logout without waiting for the response that clears cookies. Both now
wait; logout never triggers refresh interception, and failed sign-out retains a
visible retry instead of claiming success. The delayed-response browser test
fails against the previous implementation. Three corrected Chromium journeys
pass: delayed dashboard logout, network-failure retry and idle expiry. The
dashboard test verifies cleared cookies and no synthetic-charity replay event.
Web unit tests (543), web/E2E TypeScript and edited-file lint pass. This is local
proof of a reproduced defect, not attribution of all historical replay alerts;
exact hosted release and live observation remain required.

Hosted follow-up: f9857ed6 CI 36702789366 failed the web audit-summary test,
which assumed there could be no remaining decorative-page findings. The
refreshed audit flags Minute Book. The assertion now follows the recorded
route findings. Workspace test caching is disabled because source-wiring tests
also read repository-level docs/scripts outside package cache inputs. A direct
uncached web run passes all 542 tests; broader uncached verification is recorded
in the private release evidence. The earlier root-command success included
cached workspace results and is not proof of this changed audit assertion.

Data Requests release-gate repair: request state, API operations and stale-response
guards now live in a route-local hook, with shared typed records separate from
the 381-line display route. Rendered forms and request handling are preserved.
The local route inventory now counts all 41 routes; strict progress assertions
validate arithmetic instead of requiring a different checkout's July score.
The generated audit has been refreshed, without closing the human issue ledger.
Web build, TypeScript, scoped lint, all 45 local-Docker tests and six isolated
Chromium journeys pass (intake/pagination, response corrections, retained Vault
associations, review navigation and Member restrictions). The complete root test
command also passes. Exact revised hosted CI/E2E and deployment/live acceptance
remain outstanding. Prior cf955dcf CI failed the now-corrected 37-route assertion.

Windows release-check repair: Node-spawned Windows PowerShell inherited the
bundled PowerShell edition's module search path. The ACL helper now imports its
executing PSHOME Security module; archive-test creation likewise selects its
native Archive module. No execution-policy or ACL gate was weakened. All 164
personal-server tests pass. The complete local test command now reaches the
local-Docker suite, which exposes stale route-count expectations (37 versus 41)
and an actual 893-line data-lifecycle page. Resolve that page's structure before
claiming the full local gate; do not just relax the zero-oversized-page check.

Canonical CI 36701064283 for 63ca0da5 passed the full PostgreSQL backup/restore
step, resolving the sequence incompatibility with the unchanged verifier. The
later API suite exposed a stale cross-charity delete fixture: missing recovery
policy/version/evidence fields stopped at validation. The fixture now submits
the current request and asserts tenant-scoped lock/read plus no deletion or
recovery update. API build and all 36 document reliability tests pass locally.
Whole revised CI/E2E and deployment/live acceptance still remain required.

Audit-ordering backup compatibility candidate: the integer cursor now uses a
transactional database-default allocator. Populated upgrade/down/upgrade keeps
historical rows and high-water ordering; append-only, concurrent allocation,
rollback and snapshot visibility pass in managed PostgreSQL (two tests, exit 0).
All 50 disposable database safety tests pass. See
`docs/architecture/risk-verification-ordering.md`. The backup guard is unchanged;
exact-candidate CI backup/restore proof and deployment remain outstanding.

Browser gate repair: login and retention-help contrast now passes the actual
light/dark accessibility checks. Connector expectations now enforce Member
denial for approval readiness and unclassified Minute Book reads, and withheld
whole-file download refusal before a FULL/write authorised byte comparison.
The real browser approval journey exposed and fixed ApprovalsPage's duplicate
response-envelope unwrapping, which hid pending approvals. All 68 connector
tests now pass in the managed disposable stack, including UI password approval
and subsequent connector consumption; runner exit 0. No live change yet.

Remaining release blocker: CI 36698825672 at 78009bac now seeds the backup
sentinel successfully, but snapshot-bound proof refuses the PostgreSQL sequence
behind RiskControlVerification.sequence. Preserve audit ordering and backup
consistency when resolving this compatibility issue; do not bypass the guard.

Backup gate follow-up: CI 36698387739 for 86b5433d failed while seeding its
synthetic restore sentinel, before backup began. Its PENDING-to-PROCESSED
local-storage fixture omitted the activeObjectAbsentAt receipt required by
the new database guard. The fixture now supplies its synthetic fixed timestamp
in the same completion update; no production guard is relaxed. The backup
CLI suite passes 43 tests with one platform skip. Actual PostgreSQL CI backup
and restore verification and exact-candidate E2E remain required before deploy.

CI security follow-up: the synthetic worker proof uses tagged constant DDL and
the trusted repository identity SQL through Prisma's supported query API.
Integration control-character expressions now use explicit Unicode escapes;
the same 65 control-code-point boundaries are covered by a new API test.
Secret/SAST/control-byte scans and API build pass. The actual isolated worker
proof passes again (including the real five-minute retry) and the Owner purge
Chromium journey passes; managed runner exit 0. The regular production-check
suite now includes the purge/restore tests: 1,101 pass, zero fail, two platform
skips. These correct the failed security gate for candidate 486dcd4c; a revised
candidate still needs exact-SHA CI/E2E and deployment/live acceptance.

Release gate repair: Windows recovery-manifest ACL publication failed when a
Node child inherited the bundled PowerShell edition's module search path.
Both ACL setup and verification now explicitly import the Security module from
the executing Windows PowerShell's PSHOME. Owner-only ACL semantics and
fail-closed checks are unchanged; no execution-policy bypass was added. The
real owner-only directory/file test passes, and test:production-check passes
1,096 tests with zero failures and two platform skips when installed Git Bash
is selected instead of the unavailable WSL launcher. This is local evidence;
deployment and live acceptance remain outstanding.

Restore archive follow-up: the bluegreen drill now checks extracted regular
files against hashed current claimed local-storage keys. Matching paths fail
even if bytes differ or primary cleanup is pending. Path ambiguity and duplicate
entries fail validation. Tests cover conflict cleanup and charity-path scope;
remote copies and alternate filesystem links are outside this bounded check.
No destructive reconciliation is performed and no reopen approval is issued.

Restore-drill integration checkpoint: bluegreen/backup.mjs now invokes purge
reconciliation after artifact verification. It obtains current history with a
SELECT-only query to the configured live database, compares the disposable
restore, and recaptures authority to detect intervening changes. Missing schema,
unreadable authority and mismatches fail the drill with existing cleanup. The
117 backup/deployment tests pass, including stale/unreadable/changed-authority
refusals. The command explicitly denies application-reopen authority.
These are local orchestration tests plus the earlier real database primitive
proof; an integrated live drill has not run. Actual file/copy reconciliation,
independent durable authority after host loss and personal-server recovery
integration remain open. No private-host recovery entry point was altered.

Backup reconciliation checkpoint, 30 September: the new database comparison
primitive rejects missing/changed/unexpected purge history and reappearing
claimed documents. Four focused tests and the populated PostgreSQL migration
proof pass. That proof restores actual pre-claim and current pg_dump backups
into separate disposable databases: the older restore resurrects a document
and is rejected; the current restore matches the database ledger. Objects and
external copies still require reconciliation. This is local proof only.

Next: wire independently authenticated current authority into recovery paths,
preserve durable authority independently of old backups, handle concurrent
source changes, and check restored files/copies before reopening. The existing
bluegreen/backup.mjs runRestoreDrill at this earlier checkpoint verified artifact
fidelity and row counts only (superseded by the integration above). Do not claim the live
recovery safeguard is enforced yet. No live host profile was changed.

Dashboard downstream-evidence checkpoint, 30 September 2026: each claimed
disposal decision now exposes copy/backup history and an Owner form for a named
scope. Plan-compatible outcomes, evidence, observation time, required follow-up
and explicit review are shown. Later observations append a new revision with
fixed area/scope; older entries are marked historical. History is paged and
refreshable, forbidden responses clear its contents, and failed refresh after a
successful write is reported without pretending the save failed.

The isolated Chromium journey passes: record approved retention for a synthetic
backup scope, append a needs-review correction, retain both revisions across a
reload, and prove the primary job remains PENDING with no absence receipt.
Runner exit 0 and the rendered history screenshot confirm this local checkpoint.
Full web/E2E typechecks, edited UI lint, API build and 16 focused purge tests pass.
The first browser runs found an observation timestamp rounded before the claim;
the fixture now uses the actual database UTC clock with millisecond precision.
The UI accepts that precision and timestamp refusals now explain the permitted
interval. Database chronology guards were not weakened.

Real external-copy inventories/disposal, backup restore reconciliation, other
record classes, deployment/live verification and policy/DPO acceptance remain
open. Reviewer-entered observations never assert complete erasure or perform
provider actions. This checkpoint is local and has not been deployed.

Downstream disposition evidence checkpoint, 30 September 2026: the new
DocumentPurgeDispositionEvent ledger and restricted API retain append-only,
revisioned observations for a named scope in versions, Confluence, exports,
audit records or backups. Owner writes require a claimed authorization, an
explicit evidence review, controlled references and observation time. Unresolved
and approved-retention outcomes require a future follow-up date. Primary-file
absence cannot be entered here; it remains derived from the cleanup receipt.
Outcomes cannot contradict the immutable plan. A later discovery reopens review
by appending a revision; concurrent stale revisions are rejected.

The API exposes paged same-charity history to Owner/Admin web sessions and
writes only to the active Owner's privileged web session. It reports scoped
reviewer evidence without an aggregate erased status or provider action.
The dashboard editor, actual provider observations, complete copy inventories,
backup restore reconciliation, other record classes and deployment/live
acceptance remain outstanding. This ledger does not independently verify the
reviewer's evidence or the completeness of the referenced scope.

Verification: populated disposable PostgreSQL migration and real concurrent
correction test pass, including unchanged pending primary-job data. Schema
validation, API build, 24 focused service/route tests and all 51 model-map/reset
safety tests pass. The isolated database was removed successfully. These are
local proofs; no deployment or external-provider erasure is claimed.

Local primary-purge worker checkpoint, 30 September 2026: the guarded runner
now executes a real worker proof inside its exact attested API container, with
two identity-verified PostgreSQL connections and local tmpfs files. The proof
passes: retained removal/claim preserve bytes; only one competing worker
dispatches; completion observes actual filesystem absence; repeated processing
is inert; injected timeout preserves bytes and records a retry; early retry is
refused; normal retry after the real database deadline removes the intended file.
An unrelated control file remains byte-identical. Recovery expiry alone uses
synthetic dates in the disposable fixture; the retry clock/deadline is real.
Both reviewed-purge and exact-byte recovery browser journeys then pass after
their database reset. Runner exit 0 confirms the managed run and cleanup;
52 runner/attestation tests and E2E TypeScript also pass.

The initial proof incorrectly counted successful dispatches in the failed-attempt
counter, then tried to advance the application clock past a database-clock gate.
Both test assumptions were corrected without weakening production controls.
Ordinary browser probes now use origin-fenced browser fetch, and policy selection
uses its evidence reference rather than a hard-coded revision number.

This proves local primary-file disposal only. Supabase/version mutation, retained
per-store disposition evidence, Confluence/export/backup handling, backup restore
reconciliation, other record classes, deployment and live/DPO acceptance remain
open. No live policy was activated and no deployment occurred in this checkpoint.

R3 dashboard review and persisted browser handoff pass. The six-store form has
explicit Owner confirmation; cancellation and permanent primary disposal are
separate reviews, and history remains browsable after purge. Real disposable
Chromium proves upload/removal, authorization, early refusal, cancellation,
synthetic expiry/new approval, one pending cleanup job, idempotent retry and
history after reload. Runner exits 0 and history screenshot was inspected.
The stack has no cleanup worker; physical bytes are NOT yet proven removed.
Next verified isolated worker integration, retry/timeout/two-worker and external
copy/backup evidence. Final API build/79 tests, full web/E2E typechecks and UI lint
pass. Fixed selector naming and actual Prisma P0001 error translation. An earlier
generic navigation error had no captured cause and did not recur; preserve that
observation without claiming its root cause resolved. No deployment occurred.

R3 application service/API now exposes private bounded purge authorization
history and browser Owner-only authorize/withdraw/claim actions. Explicit plan
and execution confirmations, current Owner locks, tenant/revision binding and
pinned-byte hash checks precede new authority/claims; retries return one existing
receipt. Paths/fingerprints/transaction IDs are excluded from review responses.
API build and focused service/route tests pass. These tests use a DB double;
separate PostgreSQL proof is not yet a combined HTTP/provider journey. Next
dashboard review controls and real isolated end-to-end authorization, refusal,
cancellation, expiry/claim/worker-byte proof. Provider mutation after the hash
read and downstream version/Confluence/export/backup handling remain open.

R3 atomic database claim/outbox now checks Owner, unwithdrawn exact authorization,
revision/object, current policy, recovery/retention expiry, holds and links before
creating one pinned primary cleanup job, retained audit and Document removal in
one transaction. Claim commit prevents cancellation/restore and path redirection.
No API/UI consumer or deployment exists yet. Real PostgreSQL proof covers
rollback, duplicate claims and claim races against hold/cancellation/restoration;
expiry fixtures are explicitly aged in the disposable database, not production.
Next API/UI authorization and claim workflow, actual provider-byte/retry/timeout
proof, retained downstream-copy dispositions and R4/R5. A pending primary job
is not proof of erasure or DPO acceptance.

R3 withdrawal persistence is added: separate immutable Owner cancellation of a
purge authorization, same-charity/active-role checks, evidence and database time.
Two real PostgreSQL sessions prove duplicate withdrawal serialization; invalid
actors and rewritten history are rejected and no cleanup job is created. No
route or worker consumer exists. Next the atomic claim/outbox must lock the same
authorization, reject withdrawn authority, recheck document/policy/actor/holds
and both expiry boundaries, and reject withdrawal after irreversible claim.
The unpublished authorization migration was aligned to generated Prisma index
names and foreign-key update actions; no live migration was edited or deployed.

R3 authorization persistence now binds an immutable Owner decision to the exact
retained document revision/object, current policy and six-store disposition plan.
Database upgrade/negative proof and teardown pass; schema validation and all 51
model-map/reset-safety tests pass. A plan is not evidence of absence. No route or
worker consumes it; hard deletion remains blocked and restoration remains
available. Next implement authorization withdrawal and the atomic claim/outbox,
rechecking current actor/policy, revision, holds, retention and recovery deadlines
before releasing a pinned primary-storage job. Preserve separate downstream
dispositions and test restore/hold/purge races. R3-R5 remain undeployed and open.

The previously recorded full-web typecheck gate is resolved. Test environment
setup now respects Next's readonly NODE_ENV declaration; client logging tests
also restore the actual pre-test environment. Full `tsc -p apps/web/tsconfig.json
--noEmit --incremental false` passes without excluding tests. Test compilation
and all 30 affected proxy, download-URL and client-logging tests pass. Production
behavior is unchanged. Recovery retirement/race checkpoint is saved in
`6a332ce1`; R3 purge authorization/outbox and R4/R5 remain open and undeployed.

Obsolete DocumentService.remove and its private immediate-delete Confluence
retirement subtree are removed. Their obsolete test helpers/assertions were
retired; live cleanup-worker and publication-worker coverage remains and 191
focused tests pass with the API build. Both older DPO browser scenarios now
exercise retained removal: case association survives and Governance Audit shows
RECORD_REMOVE without a storage cleanup receipt. Both passed on the managed
disposable stack, with runner exit 0. Storage-job linkage after an actual purge
still needs its R3 journey; the old hard-delete journey is no substitute.
The PostgreSQL migration proof now uses competing sessions and observes actual
lock waits: a committed hold or policy withdrawal causes the waiting removal to
fail, preserving the active row and zero cleanup jobs. Test and teardown pass.
Next build R3 explicit purge authority/claim/outbox and the restore/hold/purge
races, retain downstream disposition accounting, and complete R4/R5.

Draft-policy administration is now implemented locally: browser Admin/Owner can
record immutable proposals; only the active Owner can approve or withdraw with
controlled evidence. Approval allocates a new revision and atomically withdraws
older approvals of VAULT_DRAFT. Existing removed-item deadlines are untouched.
The UI previews exact terms and requires the Owner's authority acknowledgement.
No live policy was activated. The expanded disposable browser journey passed
proposal, approval, replacement, unchanged recovery deadline, restored exact bytes
and explicit withdrawal. The new viewport screenshot was inspected successfully.
After that run, withdrawal adopted the same organisation/actor lock ordering as
approval; API build and all 74 policy/recovery/route tests pass on final source.
Real-database concurrent approval/withdrawal/removal still needs explicit proof.
Next retire unused hard-delete code/tests, adapt old DPO browser journeys, add
persisted negative/race proof, then implement R3 purge and R4 downstream/other
record classes before deployment and live acceptance.

Deleted Items/restore UI now exists and the real disposable Chromium journey
`tests/document-recovery.spec.ts` passes through upload, policy-bound removal,
retained PostgreSQL record/hash, zero cleanup jobs, Owner ordinary detail/download
404, Deleted Items listing, restoration, identical downloaded bytes, restricted
visibility and both audit events. Runner exit 0 followed the successful test.
The initial run exposed an API-client response-unwrapping mismatch in the new
panel; fixed and rerun successfully. The isolated production build/typecheck also
passed. This is synthetic local-stack evidence, not live charity acceptance.
Next: policy administration, retire the old unused hard-delete service and adapt
the two older DPO browser journeys that still expect hard deletion; broaden
persisted proof to missing/changed bytes, role/tenant denial and races; then purge,
other stores, approved activation, deployment and live review.

Ordinary Vault DELETE now calls DocumentRecoveryService.remove, requires an Admin
web session, current revision, approved policy and removal evidence reference,
and returns the retained removal result without a cleanup job. The dialog loads
approved unwithdrawn draft policies and requires explicit selection; none are
seeded or activated. The old DocumentService.remove implementation remains
uncalled by production routes and should be removed with its obsolete direct
tests before release. Next: policy administration and Deleted Items/restore UI,
browser verification and real persisted HTTP/race tests, then controlled purge.
API build and 69 recovery/route tests pass; 178 frontend wiring tests and the
274-file application typecheck pass. Full frontend typecheck fails in unchanged
tests that assign readonly NODE_ENV; record/fix this gate before release. No
browser proof or deployment was performed for this checkpoint.

Latest recovery checkpoint: a new DocumentRecoveryService implements policy-bound
retained removal and fingerprint-checked restoration with audit. Deleted Items
and restore endpoints require an Admin/Owner web session. Migration
`20260930030000_document_recovery_fingerprint` adds immutable removed-file hashes
and removal/restore audit kinds. IMPORTANT: ordinary DELETE still calls the old
immediate-delete implementation; the new removal service is not connected yet.
Next replace that route and dashboard action, add policy administration and
Deleted Items UI, then run persisted journeys and concurrency checks. Current
proof combines actual local storage with a database double, plus a separate
real-PostgreSQL migration test; no end-to-end or deployment claim follows.

Recovery continuation: removal-state migration and ordinary read exclusions are
now implemented locally. The PostgreSQL upgrade proof checks retained metadata,
no cleanup job, restricted restoration, policy withdrawal and rejection of new
citations/replacement links to trash. The mirror endpoint filters removed rows
before publication lookup. Build and 73 document-route tests pass after that
fix; the preceding broader focused run passed 804 tests. No physical-byte restore,
concurrency, removal/restore API/UI or live deployment is proven. R2-R5 remain
open; see the recovery contract for the next work and exact evidence limits.

Recovery R1 policy persistence is now implemented locally in migration
`20260930010000_retention_policy_revisions`: immutable proposals/approvals and
separate withdrawal facts, same-charity active actor checks, complete approval
evidence and bounded explicit periods. No tenant policy is seeded or activated.
The new `test:retention-policy` command upgrades disposable PostgreSQL 16
through the previous history and tests this migration with preserved document
and upload-intent rows; it passes with teardown. Schema validation, API build
and 51 model-map/reset-safety checks pass. Removal state, policy API/UI, true
trash/restore, purge and deployment remain open. See the recovery contract;
this does not close DPO-05 or authorize disposal.

The revised Nikita goal is active: finish, deploy and verify technical
remediation, prepare policy decisions and provide an evidence/acceptance pack.
The private `nikita-review-pack-2026-09-30.md` now contains nine proposed
decisions, a candidate schedule crosswalk and the four requested review
locations. No proposal is approved or sent. The remaining engineering
contract is [Document recovery and purge](architecture/document-recovery-and-purge.md).
The current ordinary draft deletion still removes the row and starts byte
cleanup; true trash/restore and full purge remain unimplemented. Work through
R1-R5 in that contract, including all ordinary read surfaces, concurrency,
downstream copies and backup reconciliation. Approval gates live policy
activation, not synthetic implementation. Do not equate cleanup retries with
restoration or a policy ledger with completed DPO-05 remediation.

2026-09-30 resumed live evidence: two 28 September replay alerts correlate in
the retained former API logs with logout, a rejected session check and a
rejected refresh milliseconds later. That sequence fits the former web
proxy's post-logout refresh path, which the deployed release removed; the old
logs lack a session-family link and the other five events remain unattributed.
Separately, NEXUS commit `33d8b492515293315051cbc219eff3c91b3440ae`
removed registrant names and email addresses from admin signup notices on
2 May. Two delivered notices to Jasper dated 8 August and 12 September omit
those fields. The live C1 risk was edited to record this bounded verification
and its date while preserving the open risk and unknowns about other
recipients, communities, locales, historical exposure and DPO acceptance.
The ordinary notice still carries an authenticated profile URL with a numeric
user ID. The original separate closure receipt was not found. Restricted
evidence and precise limits are in the gitignored private roadmap and replay
note; this is neither a universal control verification nor a breach finding.

2026-09-30 authorised private-host release: blue/green switched hOUR Timebank
CLG to `321a0c8434eb3b3bd5abbe1e4209dd950dd01bff` at 06:58 UTC after
57 migrations with zero blocked by the gate, its automatic pre-migration
backup, candidate smoke and public smoke. API and web are healthy, the
scheduler is running, the front-door health check is HTTP 200 and the prior
green version remains rollbackable. A clean Linux install and 1,096
production-check tests passed; the production dependency audit is clear. The
exact pre-deploy backup was copied off-host with matching hashes. A signed-in
Owner visit found the new Governance Audit, Security & Data and Data Requests
pages, all 63 Vault records restricted and unreviewed (including the statutory
directors/secretary register), the 22-act Minute Book and unchanged seven
historical replay events. At this initial post-release visit, the C1 risk
still carried stale wording; the later bounded correction is recorded above.
Its original verification receipt has not been found. See the gitignored
private roadmap and acceptance audit for restricted findings and limits.
This is a private-host release and bounded read-only acceptance, not formal
DPO approval or public-production launch evidence. Member classification,
external-report audience, retention/hold/recovery/purge rules, historical
replay attribution and Nikita's first-pass review remain open.

2026-09-30 pre-release discovery and preparation snapshot: the current tenant,
deployed commit and historical replay/C1 records were inspected under an
authorised read-only session. Restricted details and evidence limits are in
the gitignored private roadmap and incident note. The original C1 closure
receipt is still missing; the historical replay events lack request IDs, so
their cause cannot yet be certified. A point-in-time private-host backup
passed a restore drill and was copied off host with matching hashes. All 57
pending migrations then applied to a loopback-only disposable restore of that
backup; Prisma reported 115/115 current and the disposable database was
removed. The offline blue/green gate found zero blocked migrations and warned
about index builds and constraint validation. Local build, lint and 180
production-check assertions pass; the broad Windows tooling suite still has
two host-specific Bash/ACL failures, to be checked on the Linux release host.
Jasper authorised deployment; the source was unreleased at that checkpoint.
The rehearsal does not prove concurrent live writes, external-provider state
or DPO acceptance.

The pre-release Nikita acceptance recheck found local implementations for the
named source controls and four dashboard locations. The private-host Owner
visit above supplies bounded live confirmation of those locations and records;
Nikita's own account walkthrough is still pending. The March retention
schedule is not an approved CharityPilot class-to-disposal mapping. The
private roadmap gives the six-point evidence ledger. Do not infer a provider
purge or DPO sign-off from the local suite or private-host visit.

2026-09-30 DPO connector exclusion audit: browser action-approval list/grant
and Confluence authorization/space setup now require web sessions at the API.
The terminal connector approval path remains intact. API build, 97 focused
approval/integration tests and 22 connector approval regression tests pass.
The private `connector-exclusion-boundary.md` maps the dashboard-only routes
against direct API controls and distinguishes scoped session info, gated file
tools and terminal approvals. The later mutation pass below covers the listed
browser-only Confluence, Vault retry, Team and billing routes;
actual Nikita-tenant grants and historical exposure remain unverified.

2026-09-30 DPO-01/03/05 Vault and Confluence review-channel guard: direct
Admin connector reads of replacement candidates, mirror/control/deletion
histories and failed cleanup, plus external-copy and citation inventories,
now require a web session. Connector tool exclusion alone had not enforced
that API boundary. The separate authorised full-data document-download tool
is unchanged. API build and 165 document/integration route tests pass locally;
no actual external audience, provider purge or Nikita tenant was verified.

2026-09-30 DPO-02/06 history and replay channel guard: organisation,
deadline, Minute Book and compliance detailed histories, plus replay
diagnostics, now refuse direct connector sessions before their sensitive
reads. The allowed Team Security Audit connector tool remains accessible.
The API build and 107 focused route tests pass. Vault/Confluence excluded
reads were checked in the later 2026-09-30 pass; Nikita's historical replay
cause, C1 evidence and deployed tenant are not established.

2026-09-30 DPO-06 audit/control connector boundary: risk and register change
history, control verification/attention reads and verification writes, and
Governance Audit feeds now require an Owner/Admin web session at the API.
The connector catalogue's exclusion alone did not prevent direct requests.
The API build and 135 focused document, data-request, register and audit
tests pass. Other excluded dashboard reads need direct-API review; no C1
closure fact, historical event or live tenant was verified.

2026-09-30 DPO-01/05 connector channel hardening: document deletion-hold and
written-provider verification now require a web session before record access;
the entire controlled data-request route group also requires a web session
in addition to Owner/Admin. The connector's tool exclusions previously did
not stop a direct API call. API build and 90 focused document/data-request
route tests pass, including connector denial before case or document reads.
No actual hold authority, case evidence, provider state or Nikita deployment
has been verified.

2026-09-30 DPO-01 connector decision boundary: direct MCP connector calls to
the document PATCH route can no longer set visibility, content suitability,
lifecycle or external-publication approval. The connector's metadata edit
still works. The API checks client kind before file I/O or mutation; its build
and 68 focused document route tests pass. This closes a gap between the
connector tool schema and the underlying API, but does not prove human review
or the state of Nikita's deployed tenant.

2026-09-30 DPO-01 current-checkout Member browser retest: the guarded
disposable PostgreSQL/API/production-web/Chromium authorization journey passes
1/1 with runner exit 0. It checks restricted Vault detail and download return
404, expressly released bytes download, and Board, Compliance and Registers
remain read-only to a Member. This is local synthetic evidence, not review of
real file contents, Nikita's tenant, earlier exposure or DPO acceptance.

2026-09-30 DPO accumulated-checkout gate: the compiled non-migration API suite
passes 2,357/2,357 with the local Docker pipe available; four separate real
PostgreSQL migration suites pass 4/4. The compiled web suite passes 542/542
with the private test-only Windows account-lookup preload. Two web source
assertions were refreshed for the current Member release and draft-deletion
wording, and a compiled recovery CLI test avoids loading the TypeScript runner
for a JavaScript entry point. The earlier broad-suite host failures recorded
below are historical checkpoints. This is local proof only; Nikita's tenant,
real records, provider state, policy decisions and DPO acceptance remain open.

2026-09-30 DPO-01 Vault pagination: the dashboard now loads older Documents
pages beyond the former first 50 files and labels evidence counts as partial
while more remain. A disposable Owner browser journey reached the oldest of
52 synthetic files after the next page; web build, lint and E2E TypeScript
pass. This is local navigation proof, not actual-file classification or
Nikita-tenant verification. The API now pages from the last file's tenant-bound
cursor, and the screen asks for a refresh if the final loaded count changed
during review. This is still not a fixed database snapshot.

2026-09-30 DPO-01 reviewer-download receipt: migrations 50-51 attach an
optional SHA-256 and document revision to an Owner/Admin's existing append-only
download-preparation audit, with a separate concurrent lookup index. A new
Member-suitable assessment requires a prior matching preparation by the same
charity user and still hashes current server bytes before saving. The populated
64-baseline/51-DPO PostgreSQL rehearsal, 101 focused document API tests,
production web build, E2E TypeScript and two rendered Owner/Member journeys
pass locally. The second journey verifies refusal before download and release
after it. A failed disposable migration attempt showed the index must be in
its own migration; the corrected full rehearsal and gated cleanup exit 0.
This proves only server preparation, not human inspection, actual tenant
contents, Nikita's deployment or DPO acceptance.

The DPO-01 reviewed-byte control has since passed a disposable rendered
Owner/Member Chromium journey (1/1): newly uploaded test file, reasoned
lifecycle and Member release, authenticated Member download and a second
restricted file hidden. The initial runner stopped before testing because
`DeadlineReminderAudit` was missing from its strict reset inventory. Adding
that prior model restored exact coverage; 50 database-safety tests and the
guarded E2E rerun pass with cleanup exit 0. This remains local synthetic
evidence, not Nikita's deployment or actual file review.

DPO-01 reviewed-byte release, 2026-09-29: migration 49 adds a nullable
`memberReviewedSha256` and a `NOT VALID` gate on new/updated Member-visible
rows. Owner/Admin suitability review fingerprints current server-read bytes;
Member queries hide older approvals without a digest and the download route
checks current size and SHA-256 before delivery. The Vault identifies and
allows reasoned re-review of legacy suitable rows. Shared/API and production
web builds, 116 focused document/search tests, edited web lint, 71 migration
gate tests, SQL lint and the populated 64-baseline/49-DPO PostgreSQL rehearsal
pass locally with gated cleanup. This does not prove what bytes a human saw,
classify the real files or verify Nikita's deployment. No live migration ran.

DPO-01 written-provider release gate, 2026-09-29: migration 48 adds a
`NOT VALID` check requiring a known written provider for new or updated
Member-visible documents. The API refuses a `MEMBER_SUITABLE` assessment
until custody is verified and withholds legacy unknown-provider rows from
Member list, detail, search, activity, Board-submission and download paths.
Download rechecks custody after storage I/O. A populated disposable
PostgreSQL upgrade applied 64 baseline and 48 DPO migrations, rejected an
unverified release and allowed the same fixture after the existing custody
review path. API build and 162 focused tests pass; SQL lint has no finding.
The `NOT VALID` constraint preserves legacy rows for review, and the synthetic
custody fixture is not proof of actual provider contents or Nikita's tenant.

DPO-01 reviewed-file identity guard, 2026-09-29: migration 47 expands the
database trigger so a `MEMBER_SUITABLE` assessment cannot be retained when a
direct writer changes the document's storage path, provider, size, MIME type
or version, as well as the previously guarded card metadata. A populated
disposable PostgreSQL upgrade applied 64 baseline and 47 DPO migrations,
rejected each forged byte-identity edit and preserved Member access to the
unchanged fixture. The blue-green SQL gate has no findings and its 71 tests
pass. This does not detect a provider-side same-path byte overwrite, classify
real files or prove the reviewed tenant's deployed state.

DPO-06 connector change outcomes, 2026-09-29: Governance Audit now pages
existing append-only `ClientActivityEvent` rows for Owner/Admin. It shows
actor, method, matched route, record ID when present, HTTP status, request ID
and time, including refused connector writes. The overview omits the session
ID and supplied reason and replaces a literal unmatched path with a safe
marker. Member denial, tenant-bound paging and output minimisation pass in 17
focused archive tests; API and production web builds plus edited-page lint
pass. The activity hook records after response, so a failed audit write still
requires operational alert review; HTTP success is not domain-state proof.
This is source/local evidence, not Nikita's hosted audit trail.

DPO-02 connector process coordination, 2026-09-29: refresh now takes an
OS-owned `127.0.0.1` listener lock keyed to local user, API origin and realm
before reading the shared keyring token, and releases it after the replacement
is persisted. An occupied lock times out after ten seconds before token use;
the server's replay quarantine is unchanged. Four coordination tests include
real cross-process exclusion, and the full connector suite passes 406/410
with four platform skips. This needs every concurrently running connector
process upgraded; old processes do not participate. Nikita's historical event
cause, reviewed tenant and deployed client versions remain unknown.

DPO-02 connector refresh fail-closed guard, 2026-09-29: a successful connector
refresh must now return both tokens, and the new refresh token is stored before
the access token becomes usable. A missing/unreadable response or keyring write
failure clears the still-current spent credential. A rejected call preserves a
different successor written by another client. The focused Session tests pass
29/29 and full connector suite passes 401 with four platform skips. Connector
field-policy drift also now explicitly withholds the new Vault content class.
Cross-process coordination is now locally tested; Nikita's historical event
attribution and deployed verification remain open.

DPO-06 reminder audit, 2026-09-29: migration 46 adds a database-triggered,
append-only record of future reminder creation, status and reconciliation
transitions. Governance Audit pages the metadata for Owner/Admin without
recipient addresses, titles, provider IDs or errors. A populated disposable
PostgreSQL upgrade applied 64 baseline plus 46 DPO migrations and verified
the trigger and immutable history after an operational log was removed. API/web
builds and 16 focused archive tests pass. Earlier states cannot be
reconstructed; recorded status does not prove email receipt or Nikita's live
tenant state.

DPO-01 assessment freshness, 2026-09-29: a later Vault metadata edit now
withdraws a `MEMBER_SUITABLE` assessment and any Member visibility atomically,
with retained control and visibility events. Migration 45 rejects a direct SQL
metadata edit that keeps the prior assessment. A populated PostgreSQL upgrade
accepted the authenticated Admin edit, confirmed both audit rows and denied a
subsequent Member read; 98 focused document tests pass. Actual file reviews,
deployed tenant proof and DPO acceptance remain open.


DPO-01 Vault content assessment, 2026-09-29: Owner/Admin now record a reasoned
`UNASSESSED`, `MEMBER_SUITABLE` or `RESTRICTED_SENSITIVE` full-file access
assessment separately from lifecycle and visibility. Member Vault list, detail,
search, activity, Board-submission lookup and download require an expressly
Member-suitable file; download rechecks after storage I/O. Migration 45 defaults
all existing rows to unassessed and preserves old Member-visible rows for
controller review with a `NOT VALID` check while the API hides them. A populated
64-baseline/45-DPO PostgreSQL upgrade, 160 focused API tests, 71 migration-gate
tests and two disposable Owner/Member browser journeys pass, including a
sensitive-to-reviewed-to-restricted sequence. The exact tenant, prior exposure,
content classifications, Confluence audience and DPO acceptance remain open.


DPO-03/05 linked-evidence deletion guard, 2026-09-29: ordinary Vault draft
deletion now refuses a current standard link or cited charity-managed
Confluence page before creating a storage cleanup job. The conditional delete
checks again, and migration `20260929420000_document_linked_evidence_delete_guard`
blocks direct row deletion while either link exists. The populated PostgreSQL
16 rehearsal applied 64 baseline plus 44 DPO migrations, rejected direct
deletion with each link, preserved the links, and exited with gated cleanup.
API build, 131 focused tests and 71 migration-gate tests pass. This protects
link evidence. A focused disposable Owner browser journey also confirms an
unlinked draft still deletes and retains its reason in history. Review,
retention, restore, provider purge, tenant proof and
DPO acceptance remain open.

DPO-05/06 reasoned draft deletion, 2026-09-29: ordinary Vault DELETE now
requires a bounded administrator reason, validated before document access and
retained in the append-only `RECORD_DELETE` event in the same transaction as
row removal and the provider-pinned cleanup job. The Owner/Admin Documents
history remains readable after removal; Governance Audit shows metadata only.
The dashboard and connector require the reason. API/web builds, E2E TypeScript,
129 focused API tests, 397 connector passes with four skips and two disposable
Owner browser journeys pass with gated teardown. This is accountability for
draft deletion, not a deleted-item bin, restore, approved retention period,
provider/backup purge, reviewed-tenant proof or DPO acceptance.

DPO-05/06 source-area audit continuation, 2026-09-29: Governance Audit now pages the new data-request coverage events with charity-bound cursors and Owner/Admin access. It exposes request, area, disposition, actor and time; case reasons and controlled-archive evidence references remain in the individual case history. The connector explicitly excludes the case reads and human assessment write. API/web builds, E2E TypeScript, 15 focused audit tests, a focused disposable Owner browser journey and the full connector suite (397 passed, four skipped) pass. This is local proof, not reviewed-tenant, retention-policy, deleted-item recovery, provider-purge or DPO acceptance.

DPO-02 no-Web-Locks replay guard, 2026-09-29: a browser without cross-tab Web
Locks no longer presents an expired session's single-use refresh token. A
reactive probe accepts a cookie already renewed by another tab; otherwise the
browser directs to login with a clear fresh-sign-in explanation. Proactive
timeout extension and protected-page renewal take the same safe path. The API
still quarantines genuine spent-token reuse. The production web build, 56
focused compiled web tests, E2E TypeScript and complete five-case disposable
Chromium replay suite pass with gated teardown. Nikita's historical events,
deployed browser topology and logs remain unresolved.

DPO-05 data-source coverage review, 2026-09-29: Data Requests now lists eight
source areas per case as unreviewed until an Admin records a reasoned,
append-only assessment. The possible outcomes are in scope, needs follow-up
and not applicable, with an optional opaque controlled-archive reference.
Migration 43 enforces the tenant/case relationship and event immutability.
API/web builds, 20 focused API tests and a representative 64-baseline/43-DPO
populated PostgreSQL upgrade and focused disposable Owner browser journey pass.
These entries do not select retention periods, identify
all subject records, authorise erasure, restore deleted items, prove provider
purge or close a case. P0-08 remains open.

DPO-02 web-worker replay prevention, 2026-09-29: the Next proxy no longer
rotates refresh tokens after a protected-page `/auth/me` 401. It redirects
to a public no-store `/session-renew` page when a refresh cookie exists, and
the browser uses the existing shared lock and current-session probe before
rotation. The proxy still denies protected rendering on 401, keeps other
failures at no-store 503, and lets the Confluence callback handle its own
one-use code. The API's spent-token quarantine is unchanged. Production web
build, 51 relevant compiled web tests and the four-case disposable replay
suite pass locally. The broader generated web reliability command is not
verified on this Windows host: its `tsx` preload fails at `os.userInfo()` with
`uv_os_get_passwd ENOMEM`. This removes the source-level
race between separate web workers; Nikita's historical replay cause, her
deployed topology/logs and browsers without Web Locks remain unverified.

DPO-05 actual-response evidence, 2026-09-29: the Admin Data Requests case
screen records, corrects and withdraws actual response sent time separately
from a target, requiring an opaque controlled-archive evidence reference when
set. The case history is append-only and paged; Governance Audit pages only
change metadata. API/web builds, 33 focused case/audit tests, a focused Owner
browser journey and the full 19-case disposable DPO browser suite pass. A
representative populated upgrade applies 64 baseline plus 42 DPO migrations,
preserves an old case's unknown response as null, and refuses a pre-receipt
response date. This is local proof, not independent delivery proof, retention
expiry, deletion authority, Nikita-tenant verification or DPO acceptance.
P0-08 remains open; the CharityPilot schedule mapping and recovery/purge
design still need controller decisions and live evidence.

DPO-06 register action history, 2026-09-29: the Owner/Admin detailed register
change API and Registers page now page retained conflict, complaint,
fundraising and risk record actions past the former 100-row cap. The view
shows metadata and changed field names across years without earlier values.
API and production web builds, 26 focused register tests, edited lint and E2E
TypeScript pass. A disposable Owner journey viewed 52 tied-time changes, and
all 19 DPO browser cases passed together with gated teardown exit 0. This is
local proof, not historical backfill, Nikita's tenant or DPO acceptance. No
migration or personal-server profile was changed.

DPO-06 compliance detail history, 2026-09-29: the Owner/Admin compliance
audit now pages detailed retained decisions by charity and reporting year,
including tied-time events, rather than stopping at 100. The Compliance page
offers collapsed before/after records and older-page navigation. API and
production web builds, 22 focused compliance tests, edited lint and E2E
TypeScript pass. A disposable Owner browser journey viewed 52 synthetic
decisions and a retained state; gated teardown exited 0. This is local proof,
not Nikita tenant or C1 closure evidence. No migration or personal-server
profile was changed.

DPO browser suite, 2026-09-29: after risk-detail, register-action-detail, Minute Book-detail and
compliance-detail cases were added, all 19 Owner/Member cases passed together on the disposable
PostgreSQL/API/web/Chromium stack with gated teardown exit 0. This replaces
the older 14-case combined checkpoint for current local behavior; it is not
hosted or DPO acceptance evidence.

DPO-06 Minute Book detail history, 2026-09-29: the restricted governing-act
audit now pages retained detailed changes with a tenant-bound occurrence-time/ID
cursor instead of stopping at 100. The Minute Book page offers collapsed
before/after records and older-page navigation. API build and 37 focused
governing-act tests pass, as do the production web build, edited lint and E2E
TypeScript. A disposable Owner browser journey viewed 52 tied-time changes;
gated teardown exited 0. Earlier unrecorded history is not backfilled, and
Nikita's tenant is unverified. No migration or personal-server change.

DPO-06 risk detail history, 2026-09-29: `GET /governance-registers/risks/audit`
now pages detailed risk changes past the previous 100-row cap using a
tenant-bound, stable occurrence-time/ID cursor. The Registers panel loads
older pages and correctly reads the already-unwrapped API response for its
control-review attention and selected-risk verification history. API build,
25 focused register tests, production web build, edited lint and E2E
TypeScript pass. A disposable Owner browser journey displayed a synthetic
stale C1 claim, traversed 52 detailed changes and opened the selected risk's
retained claim; gated teardown exited 0. This is local proof, not C1 closure,
legacy audit backfill, Nikita tenant verification or DPO acceptance. No
migration or personal-server profile was changed.

DPO-05 deletion-hold database guard, 2026-09-29: migration
`20260929390000_document_deletion_hold_delete_guard` makes PostgreSQL refuse a
direct deletion of a Vault document while its administrative hold is set.
The existing Owner/Admin API still requires a reason and records hold changes;
ordinary Vault DELETE already refuses held rows. The blue-green SQL gate has
no block or warning. A populated 64-baseline/41-DPO migration rehearsal
rejected direct held-row DELETE and removed its exact disposable container.
A separate disposable Owner Chromium journey placed a reasoned hold, observed
the database refusal and retained document, and passed with gated teardown;
E2E TypeScript passes. This is defense for the existing mechanical hold, not
an approved legal-hold rule, retention period, deleted-item recovery, final
purge or proof on Nikita's tenant.

DPO dashboard server boundary, 2026-09-29: the new Governance Audit,
Security & Data and Data Requests pages were missing from the Next proxy's
protected-route list. The client layout still gated rendering and their APIs
enforced roles, but those page requests skipped server session validation,
login redirect and protected no-store headers. The prefixes are now covered,
and a structural test checks every dashboard route group. Focused compiled
route/proxy tests pass 32/32, as do test TypeScript, edited lint and the
production web build. Two disposable PostgreSQL/Chromium Owner/Member
navigation journeys pass with gated teardown. This is local verification;
Nikita's deployed revision and account remain unverified.

DPO reviewer navigation, 2026-09-29: all 14 synthetic Owner/Member cases in
`dpo-review-navigation.spec.ts` pass together in disposable PostgreSQL and
Chromium, including Minute Book, Governance Audit, document controls, data
requests, integration copies/citations, failed cleanup and Member boundaries.
E2E TypeScript and gated teardown pass. The first combined run passed 13/14;
its final audit assertion had matched a second absence receipt from an earlier
shared-fixture case. It now scopes the row by the deletion ID created in that
case; the whole rerun passed. This verifies local rendered behavior, not
Nikita's account, actual governance content or the reviewed deployment.

DPO-02 replay suite correction, 2026-09-29: the current isolated
PostgreSQL/Chromium run passed both spent-token and two-tab cases after the
second test stopped assuming an empty charity-wide replay history. Its
worker-scoped Owner charity retains the deliberate replay event from the
first case, so the two-tab test now asserts no increase from its own baseline.
The isolated runner and gated teardown exited 0; E2E TypeScript passes. This
is a test-isolation correction, not a determination of Nikita's historical
events or proof against multi-process races.

DPO-05 provider diagnostic boundary, 2026-09-29: the Admin failed-cleanup
listing now applies the existing diagnostic scrubber on read to legacy saved
`lastError` values, as well as on new writes. A focused route test confirms
redaction of an embedded object path, email and bearer value; API build and
13 recovery-route tests pass. The rendered Documents panel does not display
the field. This does not rewrite old rows or prove every possible historical
provider message is free of personal content; access remains Owner/Admin-only.

DPO-05 failed cleanup administration, 2026-09-29: the Owner/Admin failed
storage-deletion API now pages retained dead letters by a tenant-bound,
oldest-first cursor instead of stopping at 100. The Documents page lists
provider, terminal reason, attempts and dates in 50-row pages without showing
raw provider errors or object paths. Eligible jobs have a reasoned,
typed-confirmation retry using the existing `REQUEUE_UNCHANGED` route; a
permanently rejected storage path is directed to platform review. API/web
builds, 13 route tests with 203 jobs, edited UI lint and E2E TypeScript pass.
A disposable PostgreSQL/Chromium Owner journey reviewed 52 jobs, submitted
one retry and verified its retained recovery decision; the runner and gated
teardown exited 0. Retrying can later delete the target; it does not restore
a document or prove provider, version or backup purge. No Nikita tenant was
inspected and no migration was added.

DPO-03/06 document history, 2026-09-29: the Owner/Admin Documents
change-history feed now pages retained control and visibility events 50 at a
time instead of stopping at 100. The API uses a tenant-bound cursor and a
stable cross-table order, including timestamp ties; the Documents page can
load older entries while retaining prior pages. API and production web builds,
35 focused API tests with a 202-event tied-time fixture, edited UI lint and
E2E TypeScript pass. A disposable PostgreSQL/Chromium Owner journey loaded all
five pages of 202 same-time synthetic events in the rendered Documents page;
the isolated runner and gated teardown exited 0. The initial sandbox run
failed with `spawn EPERM` before starting the browser; the approved rerun
passed. No migration, historical backfill or deployed-tenant verification is
claimed. The audit still begins when its underlying events were introduced.

DPO-05 deletion-job history, 2026-09-29: the Admin document storage-deletion
history API now pages retained jobs 50 at a time with a tenant-bound cursor
instead of silently stopping at 100. Its existing metadata projection excludes
storage paths and provider errors; invalid and foreign cursors fail. API build
and all 57 document-route tests pass locally, including a 202-job fixture and
Member denial. The Governance Audit screen has a separate paged summary. This
does not restore deleted documents, establish an approved retention period or
prove provider-version, replica or backup purge. Nikita's tenant is unverified.

DPO-03 citation inventory, 2026-09-29: Admin Integrations now pages current
charity-managed Confluence page citations separately from CharityPilot's own
published copies. It shows recorded site/page, cited version/time and linked
Vault lifecycle/visibility, with no erasure action. The route excludes actor
and URL, scopes rows and cursors to the charity and denies Members. API/web/
MCP builds, 103 focused API tests, E2E TypeScript, edited web lint and three
disposable Chromium/PostgreSQL Integrations journeys pass. The later linked-
evidence guard requires unciting before document deletion; unciting removes
the current citation row, so this is not a historical inventory;
the retained control audit has only the citation ID, not a full target
snapshot. A historical-retention rule needs controller review. No actual
Confluence page, audience or Nikita tenant was checked.

DPO-03 recorded-target review, 2026-09-29: both Admin Integrations copy
lists now show the saved Confluence site, space and page IDs. The non-retired
inventory compares document approval's saved destination with that page and
shows match, mismatch or unknown. A retired row without a site/page ID has
no UI erasure action; server validation still decides eligibility. The
connector's closed personal-data projection withholds these new identifiers.
API/web/MCP builds, 102 focused API tests, connector tests (397 passed, four
skipped), edited web lint, E2E TypeScript and both disposable browser
journeys pass. These recorded IDs do not verify live provider audience or
page existence, and no reviewed tenant was inspected. A later disposable
PostgreSQL/Chromium journey also confirmed that a CURRENT document approved
for a new space displays a mismatch against its recorded old-space page.

DPO-03 recorded-copy inventory, 2026-09-29: Admin Integrations now lists
non-retired publication rows with a recorded Confluence page, in 50-row
tenant-bound pages, beside the separate retired-copy erasure queue. It joins
the current same-charity Vault lifecycle/approval and flags missing,
non-CURRENT or unapproved documents for audience/disposition review. No
erasure action is offered for these rows. API/web builds, 93 focused API
tests, edited web lint, E2E TypeScript, the MCP coverage suite and a
disposable PostgreSQL/Chromium journey pass. The first browser fixture was
rejected by a processing-timestamp CHECK; the corrected run passed with
clean teardown. Unrecorded pages, actual provider permissions and Nikita's
tenant remain unverified; no migration was added.

DPO-03/05 MCP follow-up, 2026-09-29: the retired Confluence reference tool now
passes the API's 50-row cursor and filters the actual `{ data }` wrapper under
its closed personal-data gate. Its wording no longer implies that a retained
reference proves a live provider page or purge. New response-target routes
are explicitly excluded from connector tools for human case review; document
publication site/space IDs are withheld. MCP build and tests pass (397 passed,
4 skipped).
No reviewed tenant or Atlassian provider state was checked.

DPO-03/05 retired-copy administration, 2026-09-29: the Owner/Admin
Integrations page now lists this charity's retained `RETIRED` Confluence
publication references in 50-row pages and offers the existing separately
confirmed erasure request for an eligible copy. The API cursor is tenant
bound and removes its previous silent 200-row limit. A successful request
shows its technical deletion job ID; it is not a purge receipt. API/web
builds, 91 focused integration tests, edited web lint, E2E TypeScript and a
disposable PostgreSQL/Chromium request journey pass with gated teardown.
The test used a synthetic connection/page and did not contact Atlassian.
Non-retired copies, real site permissions, provider outcomes, the reviewed
tenant and retention policy still need review. No migration was added.

DPO-05 response-target continuation, 2026-09-29: Owner/Admin can set or
withdraw a reasoned case-specific response target, see past entered targets
outside the received-date queue, and inspect append-only target history. The
cross-domain Governance Audit exposes target-change metadata only. Migration
40 leaves old cases without an inferred target. API/web builds, Prisma
validation, 30 focused API tests, the schema map, E2E TypeScript and a
disposable PostgreSQL/Chromium set-withdraw-audit journey pass with gated
teardown. A separate populated 64-baseline/40-DPO upgrade retained a null
legacy target and rejected a date before receipt. This is local tracking,
not a statutory deadline, erasure approval, deleted-item recovery, purge,
live-tenant verification or DPO sign-off.

DPO-03 concurrent approval check, 2026-09-29: document approval now locks
the tenant's selected Confluence integration row through its database
transaction. A disposable Chromium/PostgreSQL journey held a concurrent
space change open, observed the approval query waiting on the row lock,
committed the change, and received a 409 with no approval saved. Reopening
the review after restoring the selection succeeded with the exact target.
API build, 111 focused document/target tests, E2E TypeScript and the runner's
gated teardown pass. This covers a real local transaction interleaving;
Nikita's deployed tenant, the provider page and its audience remain unverified.


DPO-03 isolated browser verification, 2026-09-29: all three Confluence
connector Chromium journeys pass in the disposable PostgreSQL/API/web stack
with fake Atlassian. The extended journey verifies that a selected space
change after the Admin reviews a document destination returns 409 without a
stored approval, then a fresh review can approve and persist the exact
reviewed site/space. The runner now supplies a distinct generated integration
encryption key, which the connector needed; 40 runner contract tests, static
Compose validation and E2E TypeScript pass. The stack tears down through its
runner gate. This is local synthetic proof only; the actual space audience,
existing remote pages, reviewed tenant and DPO acceptance remain unverified.


DPO-03 reviewed-destination handoff, 2026-09-29: an Admin opening the Vault
publication control now receives a fresh selected Confluence site/space and
sees its site URL or ID and space name/key. Granting or renewing approval sends
the exact reviewed IDs; validation requires them and the document service
compares them with the connected selection inside the decision transaction.
An absent or changed target refuses approval without changing the document.
The mirror also compares a recorded page's stored site and space with the
selected target, so the dialog blocks an approval it knows the API must reject
while that older copy awaits review.
The later worker gate still refuses a target that changes after approval.
There is no new migration beyond 39. Shared 57, focused API 106, broad API
2,321 (two host-dependent checks excluded), and focused web 50 tests pass;
API/web builds, web test TypeScript and edited web lint pass. No actual tenant,
Confluence audience or provider page was reviewed.


DPO-wide local verification follow-up, 2026-09-29: the Confluence erasure
forwarding test fixture was updated from an obsolete target-reference shape
to the already-enforced canonical one. The broader API run then passed 2,320
tests while excluding the real-PostgreSQL publication-table check and a
Windows child-process CLI check by name; the new migration has separate
disposable PostgreSQL upgrade evidence. This is not a clean unrestricted
full API gate or deployed tenant proof.


DPO-03 destination-bound publication approval, 2026-09-29: migration
`20260929370000_document_publication_approval_destination` records the
approved Confluence site/space on each document and withdraws all legacy true
booleans with a system-attributed audit event because their destinations are
unknown. New approvals and destination changes require an actor, reason and
selected destination. An existing recorded page on another site or space
blocks reapproval and publication pending separate copy review. The enqueue,
retry and worker paths check the binding; the Vault warns on a stale approval
and only offers direct reapproval where no page is recorded. It also warns
when approval is withdrawn but a recorded external page remains. The disposable
PostgreSQL upgrade (64 baseline + 39 DPO migrations), 192 focused API tests,
50 focused web tests, API/web builds, web test TypeScript and edited-file lint
pass. The static migration gate reports no block and a validating-CHECK lock
warning. Coordinate deployment because the reset/CHECK can reject a legacy
old-colour approval write during blue/green overlap. Existing provider pages
are not removed; neither the reviewed tenant nor Confluence audience was
verified. The preceding DPO-03 note records the state before this change.


DPO-03 previous-site and disconnected-copy display, 2026-09-29: the mirror
API now returns nullable site-match and connection-available flags for a
recorded Confluence page. Disconnect retains non-secret site facts, but those
facts no longer yield an active page link. The Vault warns if the current
connection points to another site, is inactive, or lacks a comparable page
site ID; it does not present a cached
visible result as a current healthy copy, and suppresses the failed-job retry
button pending review. The Admin retry route also refuses an inactive publish
destination or a recorded page on another site before queueing. Older API
responses remain unknown; the worker keeps its independent different-site
guard for later changes. API/web builds, 70 focused API tests, 48 focused web tests, web test
TypeScript and edited web-file lint pass; the web tests used the existing
gitignored Windows `tsx` fallback. No provider or live tenant was inspected.
At that checkpoint the publication-approval boolean was not bound to its
reviewed Confluence site/space. The destination-binding change described
above addresses that source-level gap; its migration and live review remain
separate release work.

DPO-03 recorded-page response correction, 2026-09-29: a missing Confluence
site address can suppress `pageUrl` even when the publication row has a page
ID. The Admin mirror response now sends a page-recorded boolean without a
separate raw page-ID field (a valid page URL includes the ID). The browser treats an older response with neither flag nor URL as unknown
and uses that distinction in pending/failed/historical copy wording. A link
is built only if the recorded publication site ID matches the current
connection's site ID, avoiding an old page ID on a newly connected site's
address. The route test covers matching/reconnected sites and Member denial.
API and production web builds, 68 focused API mirror/route tests (14 service
tests), 47 focused web tests, web test TypeScript and edited web-file lint pass.
The API workspace has no ESLint config; its build and focused tests pass.
The ordinary web test runner hit this
Windows host's pre-assertion `tsx`/`uv_os_get_passwd` ENOMEM; the focused web
tests pass using the existing gitignored test-only fallback. This supersedes
the prior URL-based copy claim below. It does not verify remote existence,
Nikita's tenant or deployment.

DPO-03 partial Confluence copy display, 2026-09-29: a failed publish can have
already recorded a page reference. The mirror display now says so instead of
"Not published", distinguishes pending work with a recorded page, and keeps
the separate-review/no-retry wording when the source is no longer CURRENT.
This reflects local recorded state, not remote existence or purge. The 32
focused mirror-copy tests, test TypeScript and edited-file lint pass. Existing
worker mapping already dead-letters withdrawn approval permanently, so no
queue or provider behavior changed. Nikita's page/tenant remains unverified.

DPO-01 Vault download source recheck, 2026-09-29: after storage I/O, the
authenticated route now compares the current tenant document's path and
written provider with those used for the read. A change returns 409 without
bytes or a download-preparation audit event. This complements the existing
visibility, lifecycle and live-session rechecks. The API builds and 34 focused
document-reliability tests pass, including path/provider changes. No live
provider or reviewed tenant was tested; a post-check change remains a bounded
race, and null-provider legacy custody still needs review.

The source-based answer to Nikita's four interface-location questions is
`docs/dpo-reviewer-navigation.md`. It distinguishes Minute Book from AI action
approvals, Governance Audit from Security & Ownership Audit, document
visibility from content classification, and the present authentication/data
controls from retention, recovery and purge gaps. Confirm its routes and role
on Nikita's exact deployed tenant before using it as a live reviewer reply.
No external message has been sent.

DPO reviewed-host follow-up, 2026-09-29: Nikita's 19 September access email
says she signed in to the private Tailscale CharityPilot host to review the
then-deployed demo. A fresh Chrome visit reached its public landing page, but
there was no authenticated CharityPilot browser session. An earlier unsigned
health response also exposed no tenant or build identity. The historical 2
September VM report's single-organisation count cannot identify her 28
September tenant. Jasper does not know the reviewed tenant/environment or
where the separate C1 closure evidence is kept. Do not infer live C1 status,
replay cause, account role or deployment target from this host lead; preserve
the existing source controls and await an authenticated approved evidence path
or the original control record. No live tenant record was accessed.

DPO-04/06 evidence follow-up, 2026-09-29: the minimised approved-snapshot
renderer still outputs only the fields in the private disclosure matrix; its
existing regression test omits internal narratives and approver particulars.
No audience decision or export change was made. A read-only connected work
mailbox search for CharityPilot/C1/admin-email terms found the 28 September
DPO thread and unrelated messages, but no dated C1 closure. Atlassian Rovo
and Linear searches returned policy/general or onboarding results, not the
closure artifact. These bounded searches do not prove absence. The current
tenant, C1 revision and original verification evidence are still needed
before changing the risk or claiming a reviewed external report.

DPO-02 proxy/browser refresh handoff, 2026-09-29: a protected Next.js proxy
request can rotate the shared cookies without changing the browser's local
refresh stamp. If a reactive retry sees no newer stamp, the browser now
probes `/auth/me` while holding its Web Lock, including when the unchanged
stamp is non-null. If the
cookies are current, it does not present the spent refresh token. This also
covers a failed stamp write after a successful browser refresh. The 23
focused coordinator/API tests, test TypeScript, edited-file lint and
production web build pass locally. Simultaneous proxy/browser refreshes,
proactive renewals without shared storage, multi-process proxy races and
Nikita's historical event cause remain open; server replay quarantine was
not weakened and no reviewed-tenant check was made.

DPO-05 queued deletion identity, 2026-09-29: migration 38 makes a storage
deletion job's ID, provider, JSON target, reason and requesting actor
immutable on update. A disposable populated PostgreSQL 16 upgrade through
all 38 DPO migrations rejected direct edits of each protected field,
exercised audited corrected-path dead-letter recovery, then
confirmed that changing the linked retired publication's page ID makes the
worker retry without fake-provider I/O; restoring it permitted processing.
The runner removed its loopback-only container, and the 71 migration-gate
tests pass. This supersedes the 37-migration maximum below. Atlassian
deletion, versions/backups, policy-approved withdrawal, deployment and the
reviewed tenant remain unverified.

DPO-05 queued-target integrity, 2026-09-29: before Confluence provider I/O,
the cleanup worker now compares the queued cloud, page and attachment IDs
with its uniquely linked, same-charity `RETIRED` publication. A changed target
records a retry without a provider call. API build and 246 related tests pass
with the one Windows `uv_os_get_passwd` ENOMEM subprocess test excluded. A
disposable PostgreSQL 16 populated upgrade through all 37 DPO migrations
confirmed a changed queued page ID yielded a retry and zero fake-provider
calls; restoring it yielded a processed job and one fake-provider call. The
Admin audit reflected the attempts; the loopback-only container was removed
and an independent engine listing found none left. This supersedes older
no-PostgreSQL-worker notes. Atlassian deletion, provider versions/backups,
controller-approved withdrawal, deployment and Nikita's tenant remain open.

DPO-05 Confluence source-ID correction, 2026-09-29: migration 26's original
source-document trigger rejected a Confluence erasure job after its Vault
document had been deleted. Migration 37 keeps the live-document/path rule for
ordinary storage jobs and permits a Confluence source ID only when a
same-charity retired publication already carries the exact queued job ID and
retired path. The request reserves a UUID, stamps the publication, inserts
the job and writes the actor audit in one transaction. API build, 185 focused
tests and migration lint pass. A disposable PostgreSQL 16 populated upgrade
through all 37 DPO migrations passed live-document request refusal, linked
job insertion, forged-job refusal, worker refusal when the local document
reappeared, and provider-call eligibility after its removal. Both worker
outcomes appeared in the Admin audit; the container was removed. This
supersedes the prior fake-datastore-only source-ID claim. Atlassian,
backup/version purge, policy-approved withdrawal and Nikita's tenant remain
unverified.

DPO-01/03 migration-36 rehearsal, 2026-09-29: a loopback-only disposable
PostgreSQL 16 upgrade applied 64 baseline and all 36 DPO migrations over two
legacy documents and a deliberately visible working draft. The `NOT VALID`
constraint preserved that existing violation for review, then refused a new
violation and an update of the existing row. The rest of the populated
two-charity source/route rehearsal passed, Prisma reported up to date, and
an independent local-engine check found zero remaining rehearsal containers.
This supersedes the older migration-36-unrun statement below. It does not
classify real files, validate the constraint over Nikita's data, or prove a
production-scale upgrade or deployment.

DPO-05 queued Confluence erasure, 2026-09-29: new explicit deletion jobs carry
the original document ID. The cleanup worker verifies that each job still
links to exactly one of its charity's `RETIRED` publications, checks a populated source ID for
agreement, and refuses provider I/O if the local document exists. Legacy jobs
without a source ID need the same unique publication link. The API builds and 245
related tests pass with one unrelated Windows `tsx` subprocess test excluded;
the unexcluded run fails before that test body on `uv_os_get_passwd` ENOMEM.
The source-ID path has since passed disposable PostgreSQL; Atlassian and Nikita's tenant remain unverified. This guard does
not supply a controller-approved withdrawal path or prove remote/backup purge.

DPO-05 Confluence erasure fence, 2026-09-29: the explicit request now checks
that its charity's document is actually absent even when the publication row
says `RETIRED`. A live document returns 409 without a queued provider deletion,
publication stamp or request audit. API build and 99 focused service/route tests
pass with fake datastores; the request path has since passed disposable PostgreSQL, while Atlassian and the reviewed tenant remain
unverified. This does not create a withdrawal path for formerly published live
files: one publication row per document/provider becomes terminal at `RETIRED`.
The controller-approved removal, hold and retention decision remains open.

C1 closure evidence remains unresolved after a 2026-09-29 read-only search of
local all-ref commit messages and the canonical GitHub repository's issue/PR
titles. The two email-related PR titles found did not identify C1; the merged
general hardening PR body also gave no dated C1 verification. This is a
bounded search, not proof the original fix or separate closure record does
not exist. Do not change the live claim without its evidence and tenant/risk
revision; the private roadmap records the exact search boundary.

DPO-01/03 draft visibility, 2026-09-29: the API, Member list/detail/download,
search, dashboard activity and post-storage download check now exclude working
`DRAFT` files from Member access, including legacy rows incorrectly marked
`MEMBER_VISIBLE`. The Admin Vault disables release of a draft; migration 36
adds a `NOT VALID` database CHECK for new and updated rows. The API and
production web builds, 112 focused API tests, edited UI lint and migration
gate pass. Migration 36 has since passed a disposable PostgreSQL 16 rehearsal, but its application to Nikita's tenant is unverified;
existing violations and file contents still need controller review. Explicit
visibility decisions for other classified lifecycle states remain available.

DPO-05/06 Confluence erasure request, 2026-09-29: the deletion job,
publication stamp and actor-bound request audit event now share one database
transaction. An audit-write failure rolls back the queued job rather than
returning 500 after a destructive request has already committed. The API build
and 97 focused service/route tests pass with rollback-aware fakes. This has not
been exercised against PostgreSQL, Atlassian or Nikita's tenant. The request
still requires a `RETIRED` publication following CharityPilot document
deletion, whereas ordinary Vault DELETE is DRAFT-only. A controller-approved
removal/withdrawal route for formerly published live documents, including
holds and provider-copy disposition, remains open in the private roadmap.

DPO web-suite verification, 2026-09-29: the normal Windows test runner still
stops before assertions on this sandbox's `uv_os_get_passwd` ENOMEM in `tsx`.
A gitignored test-only preload in the private roadmap folder substitutes a
synthetic cache username solely for that exact failure. Five old wiring
assertions were updated to reflect the current Member-only organisation view,
restricted register summaries, minimised compliance wording and accurate
Vault deletion warning. Test TypeScript compiles and all 539 compiled web
tests pass with the preload. This does not certify the normal runner, a hosted
browser journey, or Nikita's reviewed tenant.

DPO-01/05 connector field check, 2026-09-29: the full connector suite found
`Document.storageProvider` unclassified in its closed-personal-data policy.
The generic projection now withholds this internal custody field, and a
regression assertion covers it. The full connector suite passes 395 tests
with four platform skips. This is local filtering evidence, not reviewed
tenant content classification or deployed proof.

DPO accumulated-work verification, 2026-09-29: the root shared/API/web
production build passes. The broad API run exposed a missing shared type for
the new `INTEGRATION_ENVIRONMENT_DECLARED` audit event and two stale report
test fixtures lacking the required preparation-audit writer; these were fixed
without changing the fail-closed route. Focused tests pass 9/9, and the
second API run passes 2,300 of 2,302 tests. Its remaining failures are a
Docker fixture denied by this sandbox and a `tsx` child-process startup that
hit host `uv_os_get_passwd` ENOMEM; excluding those two named cases yields
2,300/2,300. The root production-check run also has two host-dependent
failures (Windows ACL enforcement and Docker on PATH), with 1,090 passes and
two skips. No hosted control is certified by these local checks.

DPO-05 approval-evidence correction, 2026-09-29: the complete 21 March
governance-suite email thread includes Sridevi's express approval of all 31
documents. Jasper's earlier 30 August statement that her assent was missing
was superseded later that day by his version 3 verification, which explains
the five-of-eight-message preview error. The original March Document Retention
Schedule attachment has now been read. See the evidence IDs and category
crosswalk in `.charitypilot-private/ROADMAP.md` and
`.charitypilot-private/data-lifecycle-inventory.md`. This corrects the
historical approval record; CharityPilot still needs current-policy class
mapping and disposal controls before automatic retention or purge.

DPO-02/06 bounded follow-up, 2026-09-29: the no-Web-Locks refresh fallback
still permits a simultaneous two-tab race after both tabs observe an expired
session; no weak browser lease or server replay exception was introduced.
A targeted connected-mailbox C1/admin-email search found only the quoted DPO
feedback and unrelated results, not the dated closure evidence or affected C1
revision. The known 19 September private-host access correspondence does not
identify Nikita's 28 September tenant/revision. The C1 claim was not changed.
The ordinary Vault draft-delete confirmation now states that there is no
deleted-item restore, matching current behavior pending an approved recovery
and retention design.

DPO-05 legacy Vault custody review, 2026-09-29: Owner/Admin can verify an
unproven document's provider from the exact tenant key in both supported active
stores, provided both are available, exactly one contains the key and its byte
size matches the Vault row. A revision-checked provider update and actor-bound
document-control event commit together. A failed or ambiguous check leaves
ordinary deletion blocked. Migration 35 extends the audit kind; API/web builds,
167 focused API tests, 11 connector route-coverage tests and a disposable
PostgreSQL 16 upgrade through 64 baseline plus 35 DPO migrations pass locally.
An isolated Chromium journey also confirms that an unverified legacy file
shows a disabled Delete control and a failed provider check leaves its field
null; the disposable stack tore down cleanly.
The review proves a matching active object at one time, not historical origin,
byte identity, versions/backups, restoration, final purge or a real tenant.
Without access to both providers, including Supabase on local-only hosts, this
automated review cannot establish custody. The operator must not infer the
missing provider from current preference.

DPO-05 Vault provider custody, 2026-09-29: new uploads persist the storage
provider that received their bytes, with an exact match to the attached upload
reservation. Migration 34 backfills only exact attached intent matches and
leaves unknown legacy custody null. Database triggers make a known document
provider immutable and reject a conflicting intent. Download and ordinary
draft deletion use the pinned provider; deletion of an unverified legacy file
returns 409 before queuing or touching storage. The API build, Prisma
validation, 163 focused route/storage/cleanup tests and 71 migration-gate
tests pass. The first sandboxed rehearsal stopped at the Docker pipe with
`EPERM`; an authorised local-pipe retry passed all 34 DPO migrations against
disposable PostgreSQL 16 and proved exact backfill, unmatched-null preservation,
immutable-provider and mismatched-intent refusal. Provider review for null legacy files,
deleted-item restoration, policy-approved purge and deployed-tenant proof
remain open; no production host was changed.

DPO-02 no-Web-Locks reactive fallback, 2026-09-29: a 401-triggered browser
refresh now checks `/auth/me` before using the refresh token when Web Locks are
unavailable. It skips a sequential duplicate after another tab rotates the
cookies and refuses to refresh when the check fails. Proactive renewal still
refreshes. Eight focused tests, test TypeScript, edited-file lint and the
production web build pass locally. Simultaneous tabs without Web Locks can
still race, and this does not explain Nikita's historical events or prove her
deployed tenant. A source/commit search found no C1 closure evidence in this
turn, so do not mark the live control verified.

DPO-06 Confluence publish-target integrity, 2026-09-29: the charity's choice
of a Confluence publish space is now validated against the provider before a
database transaction saves it alongside its actor-bound security event. The
write requires the integration to remain connected to the same site during
the validation interval; a site switch or failed audit refuses/rolls back the
choice. The API build and 109 focused publish-target/integration tests pass,
including stale-site and synthetic audit-failure cases. This has no new
migration, does not reconstruct older choices and has not been exercised
against Nikita's tenant or a real PostgreSQL transaction in this turn.

DPO-06 Confluence citation history, 2026-09-29: adding or removing a cited
Confluence page now writes an actor-bound `CONFLUENCE_REFERENCE` event in the
same database transaction as the reference change. It records the document
and opaque reference IDs but no page title, URL or content. The existing
Owner/Admin document-control history and Governance Audit feed can show it.
Migration 33 extends the constrained event-kind set (33 DPO migrations in this
checkout). API/web builds and 23 focused reference/archive tests pass. The
blue-green migration lint has no block and flags the validating CHECK window. The local
Docker pipe still blocks PostgreSQL rehearsal, so transactional behavior and
the constraint must be proved on a database before release; old changes are
not backfilled. This does not change any Confluence page.

DPO-02 browser fallback, 2026-09-29: a reactive 401 refresh now checks
`/auth/me` under the shared Web Lock when the nonsecret cross-tab rotation
stamp is unavailable. It skips a duplicate refresh after another tab has
rotated cookies and fails closed if the check itself fails. Proactive renewal
still rotates. Six focused tests, test TypeScript, production web build and
edited-file lint pass. Browser paths without Web Locks, Nikita's historical
replay cause and her deployed tenant remain unverified. The optional `tsx`
test preload failed with this host's ENOMEM; direct Node execution of the
compiled tests passed.

DPO-06 Confluence declaration audit, 2026-09-29: changing or clearing the
charity's declared Confluence plan/residency now writes an actor-bound
`INTEGRATION_ENVIRONMENT_DECLARED` security event in the same database
transaction as the setting. Its action is `RECORDED` or `CLEARED`; it also
records the actor, time, request ID and fixed labels, but no declared values. Owner/Admin
Governance Audit includes the metadata event, and the page points to it.
This added migrations 31-32 (32 DPO migrations at that checkpoint). API and production web
builds plus 101 focused integration, audit-feed and subject-constraint tests
pass. The migration lint reports one expected validating-check window warning;
The disposable PostgreSQL rehearsal could not start because access to the
local Docker Desktop Linux named pipe returned `EPERM`; actual PostgreSQL
application and Nikita's deployed tenant remain unverified.
Earlier declaration changes are not reconstructed. This is not C1 closure or
a formal DPO review.

DPO-05/06 Data Requests overview, 2026-09-29: the recent global
`/data-lifecycle/audit` feed no longer selects case evidence references. Its
response now carries event/case IDs, actor, state change and time; the
Owner/Admin individual case history retains the reason and evidence reference.
API build and 14 focused intake tests pass. No stored case evidence or live
tenant was changed. A source recheck found no extra dynamic field in the
minimised approved Compliance Record beyond the private disclosure matrix;
recipient-specific field approval remains open.

DPO-01/06 overview projection, 2026-09-29: every direct Governance Audit
feed now requires an explicit database field selection. Organisation, deadline,
register and report preparation feeds no longer fetch whole rows for the
expandable JSON overview; the merged case-link feed already selects and maps
named fields. The route test checks all 17 direct feeds use a projection, and
the API build plus 12 focused archive tests pass. This prevents future schema
columns appearing by default; detailed histories remain restricted and live
tenant behaviour is unverified.

DPO-01/06 overview minimisation, 2026-09-29: Governance Audit now omits
free-text compliance reasons and data-request evidence references from its
cross-domain event JSON. The controlled compliance audit and individual case
histories retain those fields. API build and 12 focused archive tests pass.
This is source-level minimisation, not a live DPO review. A read-only browser
attempt to open the historically mentioned private Tailscale host was rejected
by automatic approval review because Nikita's actual reviewed environment and
tenant remain unconfirmed; the local Tailscale status pipe also denied access.
Do not bypass that rejection or infer a live target from older correspondence.

DPO-05 schema coverage, 2026-09-29: `docs/architecture/data-lifecycle-model-map.md`
enumerates all 70 current Prisma models in eight groups. Its exact-set test is
part of `test:production-check`, so new schema models require an inventory
update. This is source coverage only. The private
`.charitypilot-private/data-lifecycle-inventory.md` records the off-schema
stores and policy gaps. Ordinary Vault draft deletion still hard-removes the
row and cannot restore it; cleanup-job recovery only retries or acknowledges
byte cleanup. Do not claim approved retention, recoverable deleted items,
provider/backup purge or live DPO proof from this inventory.
The map test and 15 launch-status tests pass. A full production-check run on
this shell has 1,090 passes, two skips and two host-dependent failures: Windows
owner-only ACL publication and a live PATH test with Docker unavailable.
Re-run that full gate on a capable host before treating it as green.

DPO public-production evidence gate, 2026-09-29: machine-readable launch
evidence now requires a separate disposition of Nikita's 2026-09-28 feedback
for the reviewed tenant and exact promoted release SHA. It names all six review
areas, four requested interface locations, first-pass DPO review and remaining
actions. The launch ledger now has 90 checks; older 89-check progress figures
below are dated historical checkpoints. The validator rejects a missing check
or wrong release SHA, while cited live evidence and human judgement remain
necessary. The public checklist now requires every DPO migration in the
promoted release (33 in this checkout), not its obsolete first seven. The
80-test launch-evidence suite, 21 launch-status tests and 180 production
preflight tests pass locally. This gate does not apply to personal-server mode,
record a DPO sign-off, deploy migrations or establish Nikita's tenant.

DPO-05/06 storage-audit minimisation, 2026-09-29: the cross-domain Governance
Audit deletion feed no longer retrieves free-text Confluence erasure reasons;
it retains technical status, actor ID and dates. API build and 12 archive tests
pass. The private lifecycle inventory also identifies the existing seven-day
cleanup for eligible authentication-email delivery-evidence rows. That narrow
operational cutoff does not establish an approved application-wide schedule or
purge related audit, mail-provider, log or backup copies. No live tenant was
changed.

DPO-06 Confluence audit navigation, 2026-09-29: the Owner/Admin Governance Audit
now pages metadata from eight named integration events retained in the Team
security audit. Its charity-bound feed and cursor exclude labels, reasons,
site URLs, document names and arbitrary context; use the restricted Team log
for detail. API and production web builds, 12 archive tests, edited-page lint,
E2E TypeScript and a synthetic PostgreSQL/Chromium Owner journey pass with
gated teardown. Some original writes are best effort after an action, older
events are not backfilled, and an erasure request is not purge proof. The live
tenant remains unknown. See the private roadmap for the exact event scope.

DPO-05/06 case-evidence audit feed, 2026-09-29: Governance Audit now pages
metadata for data-request links to live Vault documents and storage-deletion
jobs, including separate withdrawals. It is Owner/Admin-only, tenant-bound and
omits case reasons, storage paths and provider errors; open the individual
request for controlled reasoned history. API build, 11 archive tests, E2E
TypeScript, edited-page lint and an isolated PostgreSQL/Chromium Owner journey
pass with gated teardown. This uses existing migrations 25/30. It does not
prove case identity, erasure, recovery, backup expiry or Nikita's live tenant.
See the gitignored roadmap for the exact DPO limits.

DPO-05 case-to-live-Vault lineage, 2026-09-29: Owner/Admin Data Requests can
now record an exact live Vault document ID with an actor and reason, then retain
that opaque ID after eligible draft removal. Migration 30 verifies the live
same-charity row at insertion, makes links append-only and permits a separate
append-only withdrawal. The case UI pages these links; MCP excludes the routes.
API/web/MCP builds, 14 focused intake tests, 11 connector coverage tests,
115 isolated-runner safety checks, a two-charity populated 30-migration
PostgreSQL rehearsal and two disposable Chromium Owner journeys pass. The
blue-green gate warns about an index on the newly created empty table. A link
does not establish the requester, authorise erasure, restore the document or
prove external and backup copies are gone. No live tenant was changed.

DPO-04 disclosure review, 2026-09-29: the gitignored
`.charitypilot-private/report-disclosure-matrix.md` records the exact dynamic
field allowlist in the minimised approved-snapshot review draft, the excluded
snapshot/internal-report details, current access and preparation-audit guards,
and decisions required for a recipient-specific release. A fresh API build
and 26 focused export tests pass; no additional renderer field leak was found
in this source review. Aggregate inference, field and recipient approval,
downloaded-copy handling and Nikita's deployed tenant remain unresolved.

DPO-05 source-job discovery, 2026-09-29: Owner/Admin Data Requests now has a
tenant-bound, cursor-paged lookup by exact source Vault document ID. It returns
job status metadata without storage paths or provider errors; selecting a job
only fills the existing reasoned case-link form. Migration 29 adds a concurrent
partial index for non-null source IDs. API/MCP builds, 12 focused case tests,
five connector route-coverage tests, edited web lint, E2E TypeScript and the
blue-green gate pass. An isolated PostgreSQL/Chromium Owner journey found and
linked a synthetic job and checked the browser response excludes storage path
and provider error fields; gated teardown passed. The populated two-document
rehearsal passed 64 baseline and all 29 DPO migrations. Legacy null-source jobs,
subject matching, full erasure and Nikita's live tenant remain open.

DPO-02 replay-timing evidence, 2026-09-29: future replay audit events record
when the presented session was previously revoked. The restricted Owner/Admin
diagnostics validates and displays that time beside the existing request ID,
fingerprint, previous reason and quarantine count. Older events show no value;
no token or new person identifier is stored. Shared/API builds, 50 focused
auth/team tests, edited web lint and E2E TypeScript pass. An isolated
PostgreSQL/Chromium journey compared a synthetic replay event with its source
session row and displayed the timestamp in a separate Owner session; gated
teardown exited 0. The field supports a timing
comparison with restricted logs but does not explain Nikita's historical
events, distinguish a racing client from theft, or prove deployed behavior.

DPO-05 source-document lineage, 2026-09-29: migration 28 adds nullable
`DocumentStorageDeletion.sourceDocumentId`. New ordinary Vault draft removals
write the source document ID into the deletion job in the same transaction as
record removal. A database trigger checks that a non-null source matches a
live document in the same charity at the same storage path when inserted and
prevents later changes. Existing, orphan-cleanup and Confluence jobs remain
unlabelled; no guessed backfill is made. The Owner/Admin Data Request case view
shows the ID for linked jobs without exposing a storage path. This identifies
source lineage, not the data subject, recipient copies, provider versions or
completed erasure. API build, 59 focused API tests, edited web lint, E2E
TypeScript and the static blue-green migration gate pass. One isolated
PostgreSQL/Chromium deletion-and-case journey passed with gated teardown,
including database rejection of a forged source and later ID edit. A separate
representative populated-data upgrade passed 64 baseline and all 28 DPO
migrations with two legacy documents; it is not a full production-data
rehearsal. No live tenant, approved retention period or deleted-item recovery
was verified.

The final disposable recovery-code browser rerun also verified 401 and an intact factor when a different session family tried blank-code removal, followed by successful removal in the recovery-authenticated family. The gated runner exited 0.

DPO-02 proxy validation follow-on, 2026-09-29: concurrent protected-page requests now share only an in-flight `/auth/me` validation for the same hashed API URL, request origin and cookie header in one Next.js process. A completed success is removed so later requests still check revocation; the refresh single-flight and API replay quarantine remain authoritative. The 24-test proxy suite, edited lint and production web build pass. All five isolated PostgreSQL/Chromium DPO review journeys pass together with gated teardown. Two earlier combined browser runs hit a 503 in a longer navigation test before it was split; this passing suite is not evidence of that 503's cause or Nikita's replay cause. Separate processes and the live reviewed tenant remain unverified.

DPO authentication recovery, 2026-09-29: a disposable PostgreSQL/Chromium Owner journey now proves authenticator enrolment, final recovery-code browser sign-in, a recovery-use audit event bound to that active session family, and password-proved MFA removal with the code left blank. The journey exposed a UI request that sent an invalid empty recovery-code string and a database CHECK that rejected the family-bearing audit event. The UI omits an empty code; DPO migration 26 widens only `SECOND_FACTOR_RECOVERY_USED` to permit an optional family ID. The corrected journey and all migrations pass with gated teardown; local E2E TypeScript and edited-page lint pass. The blue-green gate warns that the replacement CHECK validates existing audit rows. This does not prove the reviewed live tenant, role-wide MFA enforcement or recovery after both authenticator and codes are lost.

DPO-05 case linkage, 2026-09-29: Owner/Admin reviewers can associate an unresolved Data Request with an existing same-charity storage-deletion job and record an auditable reason. A wrong association can be withdrawn with a separate immutable reason while the original remains visible. The case view shows current technical job status and primary-object absence evidence without storage paths or provider errors. Migration 25 uses composite tenant foreign keys and append-only triggers. Local API/web/MCP builds, Prisma validation, focused API/connector/reset-safety tests and all four DPO review journeys pass together against disposable PostgreSQL 16/Chromium; the gated runner exited 0. The blue-green gate has no block but warns of a non-concurrent index on existing `DocumentStorageDeletion`; review the deployment lock window. No case disposition, full erasure, policy period, live tenant check or DPO sign-off follows from this link.

Last updated: 2026-09-29 (DPO follow-up; older checkpoints retain their stated dates)

This document exists so a new Codex, Claude, or other coding agent can continue the same CharityPilot production-completion goal without relying on chat memory or a pasted prompt.

## 2026-09-28 DPO demo feedback intake

Data Requests now lets an Owner/Admin find a case by its exact opaque archive reference. The API validates the reference and restricts the query to the current charity; Member access remains denied. Eight focused intake tests, API/production web builds, E2E TypeScript, edited-page lint and a disposable PostgreSQL/Chromium Owner journey pass locally. The browser opened a case outside page one by reference, then paged older cases after a new intake. Lookup does not change review status or prove erasure; see the private lifecycle inventory.

The Admin Data Requests queue now uses tenant-bound cursor paging rather than offsets, so a newly recorded case cannot shift an older case out of the next page. The web deduplicates appended rows and ignores a stale page after refresh. API and production web builds, seven focused intake tests, edited-page lint and E2E TypeScript pass locally. An isolated Chromium Owner journey with 52 seeded cases and a newly inserted 53rd reached the two oldest cases through the real API/UI; its runner exited successfully. A backdated new case still needs a fresh reload; no erasure or retention outcome is implied. The private lifecycle inventory records the boundary.

The Admin Governance Audit overview now selects event metadata instead of full before/after snapshots and narrative reasons for its Minute Book, document, risk, control and compliance feeds. Detailed histories remain on the corresponding controlled record pages. API build and 10 archive tests pass locally. This is response minimisation, not historical erasure, C1 verification or proof on Nikita's dashboard; the private roadmap has the exact field boundaries.

A bounded connected-Drive metadata search on 2026-09-29 found the March retention schedule and pre-3-September board drafts, but no later minutes/resolution filename. That search did not cover the complete 21 March email thread. The thread and later version 3 verification establish approval evidence for the March governance suite, as documented below. Its category periods still need a current-policy reconciliation and CharityPilot-specific controller mapping before app deadlines or disposal.

After an Admin records or withdraws risk-control evidence, or the parent risk register reloads after a revision change, the Registers panel now reloads its control-review attention list. Older in-flight responses cannot replace that newer result. Edited-page lint and a production web build pass. This corrects a locally stale panel, but C1 still needs its actual closure evidence and deployed-tenant reconciliation.

The connector's six governance/deadline removal tool descriptions and missing-reason error now agree with the server's corrected approval prompt: active-record removal, with audit and backup copies possibly retained. The README example is updated. MCP build and 61 focused tool/session tests pass. This is description accuracy only, not erasure or retention enforcement.

The complete isolated Chromium DPO review navigation spec now passes all three Owner/Member journeys together, including the uploaded-draft deletion outcome in Governance Audit; the runner's gated teardown exits successfully. The earlier full-run authentication-unavailable page did not recur. This is disposable local-stack evidence, not a replay-event diagnosis or proof on Nikita's reviewed host.

The connector's destructive-action prompts for six governance/deadline record types now say removal from active records and warn that audit or backup copies may remain; the generic DELETE fallback no longer claims permanent erasure. API build and 46 focused approval/connector tests pass. This is wording accuracy, not a change to record disposal or backup expiry. The blue-green engine's 14-day best-effort local backup pruning is an operational setting, not the missing controller-approved per-class retention schedule. See the private roadmap and data-lifecycle inventory for the remaining DPO-05 decisions and deployment checks.

The Minute Book UI now says a removed act's full snapshot, actor email and reason remain in restricted audit history without automatic expiry. The Confluence connection disclosure calls remote delete/purge an attempt and limits its 404 evidence to the current page endpoint; versions and backups are outside that proof. API build, 87 integration-route tests and edited Minute Book lint pass. Neither change adds erasure or an approved expiry period.

The new storage-deletion attempt feed has a rendered local Owner journey: upload a synthetic draft, remove it through the Vault, then inspect its `PROCESSED` outcome and active-primary-object absence receipt in Governance Audit. The test correlates the document ID to the separate deletion-job ID through the retained upload intent. E2E TypeScript, the focused isolated Chromium test and gated teardown pass. One earlier assertion used the wrong ID despite the captured page showing the event; a later full navigation run encountered a transient authentication-service page before reaching this step, while its Member restriction test passed. The focused journey does not establish deployed behavior, other providers, versions or backup purge.

Migration 24 adds an append-only storage-deletion attempt event captured by a PostgreSQL trigger when a pending deletion schedules a retry, dead-letters, or completes. Its Admin-only Governance Audit feed exposes tenant-scoped outcome metadata, not path or provider errors; the primary-object absence receipt is shown when present. A populated disposable PostgreSQL 16 upgrade through all 24 DPO migrations exercised the trigger, rejection of direct insert/update/delete, Admin and Member reads, and cleanup of its local fixture. API and production web builds, nine focused audit tests, Prisma validation, 50 E2E reset-safety tests and edited-page lint pass. The general PostgreSQL backup fingerprint covers every present table; the static critical-table list remains restricted to tables already present before a blue-green migration. The blue-green gate has no block and warns about index and foreign key creation on a newly created empty table. Earlier attempts are not backfilled, and provider versions, backups, deployment and Nikita's tenant remain unverified.

The existing append-only storage-deletion recovery decisions now have a separate Owner/Admin-only Governance Audit feed. It pages by tenant and decision timestamp, exposing disposition, deletion reference, actor type/user and prior attempt summary while omitting paths, free-text reasons, operator identity and recovery nonce. The deletion queue feed has been labelled as current status because its row is updated through retries; the newer attempt feed covers outcomes from migration 24 onward. This local change does not perform recovery, prove provider purge or establish an approved retention period. Verification is recorded in the private roadmap.

The stale-upload reconciliation queue now stamps each attempt and orders unattempted or less recently attempted `RESERVED` rows first. This prevents a repeatedly failing oldest batch from hiding later orphaned bytes. Migration 23 preserves the database trigger's immutable tenant/path/provider and guarded state transitions. API build, Prisma validation, 40 focused tests and a populated disposable PostgreSQL 16 upgrade through all 23 DPO migrations pass; the real service queued a stale orphan after upgrade. The blue-green gate warns about a normal index build on an existing table. Scheduler deployment, real provider deletion, object versions/backups and Nikita's tenant remain unverified.

The scheduled local Confluence orphan sweep now runs before remote tenant/page reconciliation. A remote listing failure no longer prevents retirement of a missing-document publication; a local-sweep failure raises an operator alert but still lets the remote pass proceed. API build and 120 focused tests pass. No deployed scheduler or provider outcome was checked.

The Confluence orphan-publication retirement sweep now selects missing-document publications before applying its 100-row bound and includes dead-lettered rows with a recorded page. Previously 100 older live rows could indefinitely hide a later orphan after best-effort retirement failed. API build and 118 focused tests pass; a disposable no-network PostgreSQL 16 query returned the late orphan behind 125 live rows and its container was removed. This restores discoverability for an explicit erasure request after the scheduler runs, without performing erasure or proving the deployed provider.

The local Member Vault browser journey now probes the restricted file by its real Owner-uploaded ID. Authenticated Member requests for its detail and download both return 404, while the released file remains downloadable. The targeted isolated Chromium run and gated teardown pass. This is synthetic local proof, not classification of actual files or verification of Nikita's deployed tenant.

A new local-only Chromium journey exercised ordinary two-tab browser refresh on one synthetic Owner session: after the shared access cookie was invalidated, both tabs reached the replay-diagnostics API successfully, one refresh call was made and no `SESSION_REPLAY_DETECTED` row appeared in the disposable tenant. The isolated runner's 115 safety checks and gated teardown passed. This tests one actual browser timing on the local revision; it does not determine the cause of Nikita's historical events, cover every concurrency interleaving or verify her host. The exact deployed event/log correlation remains open.

The rendered Member browser journey now includes two synthetic Vault files: one expressly released for Members and one left at the conservative `RESTRICTED` default. The signed-in Member sees and downloads only the released file; the restricted file is absent from the Vault list. The targeted isolated Chromium test and runner teardown pass. The web API interceptor now unwraps only a single-field `{ data }` wrapper, so unfamiliar paging metadata is also retained; its focused suite passes 13/13 and the production web compiled in the isolated run. This is local synthetic access evidence, not content classification or proof on Nikita's dashboard.

The isolated Chromium journeys now pass for the existing Member governance read boundary, live Admin demotion and document upload/download (three tests), plus a new Owner/Member navigation check for Minute Book, Governance Audit, Data Requests and document access/lifecycle/deletion-hold controls (two tests). The new check exposed an Owner Security & Data crash: the shared web API interceptor unwrapped paginated `{ data, nextCursor }` responses, so the replay-diagnostics panel received an array and tried to read `undefined.length`. The interceptor now preserves cursor pages and its focused regression suite passes 12/12. The five browser tests passed separately against runner-owned synthetic stacks and the runner's gated teardown returned successfully. To run locally on this Windows host, the isolated E2E port contract was moved from excluded port 55434 to free loopback port 3354, its gateway health check was corrected, and the container collector was brought into line with the existing five-service Compose/runtime contract. The 108 E2E safety/attestation tests, static validation and production web build inside the stack passed. This verifies local rendered routes and role restrictions only; Nikita's reviewed host/tenant and its deployed revision remain unknown.

Full Compliance Record exports now require `FULL` personal-data scope as well as Owner/Admin role. The connector hides and refuses its full-report file tool when that session scope is withheld; direct API calls are denied before report reads. A read-only connector is also denied by the API for both report variants, matching the file tool's write-level rule. Both full and minimised report paths now recheck the current tenant-bound, verified Owner/Admin session and connector level after assembly and before the metadata-only preparation audit or HTML delivery. Local API/connector builds and 26 export plus 31 connector file/list tests pass (one Windows symlink skip); the full connector suite passes 394 tests with four platform skips. This narrows an in-flight role/session change window, but the minimised draft's audience and fields still need controller/DPO approval and the exact deployed journey remains unverified.

The connector's `document_download` tool now also requires a `FULL` personal-data session and at least WRITE access. The API enforces both before document/storage access and rechecks them after provider I/O, alongside its existing role, visibility and session checks. API/connector builds, 31 focused document tests and five connector server-list tests pass locally. This does not classify legacy file contents or verify Nikita's deployed tenant.

The 21 March 2026 governance-suite email (`19d10accabf16738`) attached `hOUR Timebank Document Retention Schedule Mar26.docx`. The complete eight-message thread includes Sridevi's explicit approval of all 31 documents at 14:49 (`19d10df42a72ffd9`) and Jasper's confirmation that the resolutions passed at 14:52 (`19d10e1b462de915`). Jasper's 30 August 11:41 email said that assent was missing, but his later [version 3 approval verification](https://docs.google.com/document/d/1v6nyLUsa-Rf1q2HUkeJsK6KwXQD_Z2cG6ja4_0Ejnvw/edit) identifies the truncated Gmail preview and supersedes that conclusion. The attachment sets category periods, including seven years after leaving for former-member records; the subsequent Data Protection Policy V2 discussion calls for category-specific justification, and the 21 September six-policy request does not include a revised schedule. The local statutory-member service stopped deriving its conflicting one-year `retentionDeleteAt` and returns null for legacy dates; stored dates await reconciliation. API build and five focused tests passed. The controller must map current policy versions to CharityPilot data, exceptions and purge evidence before any app expiry rule is enabled.

Vault downloads now append a tenant-scoped, metadata-only preparation event
after post-storage document-existence/current-visibility and live-session/role
checks. The current visibility is used for the role test, closing an Admin
demotion plus file-restriction window during provider I/O.
The Admin Governance Audit pages the events; an audit-write failure withholds
bytes. The twenty-second DPO migration is append-only. API and production web
builds, 82 focused document/archive tests, 50 reset-safety tests, edited-page
lint and a populated disposable PostgreSQL 16 upgrade through all 22 DPO
migrations pass locally; the fixture was removed. The blue-green migration gate
has no block and one new-empty-table index warning. This records preparation,
not client receipt, and does not reconstruct older downloads or settle audit
retention, recipient copies or Nikita's live deployment.

A read-only search of Jasper's connected work correspondence found a 31 August
private-host invitation for hOUR Timebank CLG, giving a lead for the dashboard
Nikita later reviewed. Her 28 September message does not confirm the current
host, tenant or deployed revision. The private roadmap records the lead without
invitation links; no live host was accessed or C1/replay record changed.

A read-only connected Confluence search found a policy page that says hOUR
Timebank should maintain a documented retention schedule and a separate
retention-policy page with no retrievable body. It did not locate a C1
admin-email verification or approved CharityPilot schedule. This is a bounded
search, not evidence of absence across other stores or an approved period.

Security & Data now links every charity role to its own session-family inventory
and revocation control on Team & Permissions, beside personal MFA and password
change. Charity-wide security, audit and data controls remain Owner/Admin-only.
This improves the location Nikita asked for but has not been checked on her
unknown dashboard.

A populated, disposable PostgreSQL 16 upgrade through all 21 DPO migrations
now exercises signed-in Member password change through the real Fastify route.
The first run caught an invalid session-subject field on the audit insert;
removing it fixed the database constraint failure. The repeat passed cookie
clearing, old-session denial, changed password hash, outstanding recovery-link
termination, both active sessions revoked and `PASSWORD_CHANGED` projection.
The loopback-only fixture container was removed. This is local proof; a
rendered browser, deployed tenant and Nikita's environment remain unchecked.

Signed-in charity users can now change their own password on Security & Data.
The route requires their current password and an enrolled second factor,
rechecks the credential under the organisation/user locks, and atomically
invalidates outstanding recovery links and all sessions. A metadata-only
security event is projected as `PASSWORD_CHANGED`; the connector route
inventory explicitly excludes this human credential action. Shared/API/web
and connector builds plus focused password recovery and route-inventory tests
pass locally. This has not been exercised on Nikita's tenant or in a live
browser. The earlier password-recovery navigation note below is superseded for
signed-in change functionality.

Rendering a working Compliance Record, approved snapshot or minimised review draft now writes a metadata-only row to a separate report-preparation audit before returning HTML. It records tenant, actor, year, version, audience and approved snapshot ID when applicable; no report body or evidence goes into the row. A failed audit write withholds the report. The Governance Audit screen labels report events. The twenty-first DPO migration creates the constrained table and append-only trigger, leaving the older compliance enum unchanged to avoid a new-value decode risk during blue-green overlap. API and production web builds, 28 focused export/archive tests, 11 Team UI tests, 50 reset-safety tests and a populated disposable PostgreSQL 16 upgrade through all 21 DPO migrations pass locally. The event proves server preparation, not receipt, client storage or external disclosure; older downloads are not reconstructed and Nikita's tenant remains unverified.

Team role guidance and the security reference now describe Member reads as limited to permitted status/trustee views and explicitly Member-visible documents. Sensitive registers, complaints, conflicts and full reports remain Owner/Admin-only in source. This is a copy correction; real content classification and deployed-role verification remain open.

Future replay events now include a one-way fingerprint of the presented session row and the number of active sessions quarantined by that observation. The Admin diagnostic view shows both, with nulls for older rows and a warning that repeated fingerprints establish only repeated presentation of one spent row. No refresh token, token hash or raw session ID is added to the audit response. Shared/API/web builds, edited-page lint and 50 focused auth/Team tests pass, including a same-row repeat. Nikita's past events cannot gain these fields retroactively; the cause still needs exact deployed-event and restricted-log correlation.

Every charity role can now find its own password-recovery route on Security & Data beside personal authenticator settings. The page follows the existing provider/manual-link recovery workflow and explains that a completed reset signs out existing sessions. This changes navigation only; no new password-change endpoint or live account journey has been verified.

The Team Security & Ownership Audit now pages through retained events in groups of 50 instead of stopping at the newest 20. Each cursor is bound to the tenant and stable event-time/ID order; the service checks the current Owner/Admin role before resolving it. The browser can load older rows, keeps them visible if a later request fails and ignores stale responses after a refresh or role change. The connector also accepts the cursor and filters personal prose inside the paged response when its personal-data gate is closed. Client rows still omit raw context and internal event IDs apart from the opaque next-page cursor. Shared/API/web/connector builds, edited-page lint, 41 focused team tests, 393 passing connector tests (four platform-skipped) and the populated disposable PostgreSQL 16 upgrade through all 20 DPO migrations pass locally. The reviewed tenant is unknown, no live browser check was made, and this does not determine the cause of Nikita's replay events.

The nineteenth and twentieth DPO migrations add `ACTION_APPROVAL_REFUSED` to the security-event enum and its subject constraint. Both browser and connector grant routes now append a self-subject security event after an authenticated Owner/Admin refusal, while returning the same opaque 401. The event records tenant, account, client channel and time, but no offered approval ID, password, summary or inferred failure reason. Focused route/enum/constraint tests pass; the populated disposable PostgreSQL 16 upgrade through all 20 DPO migrations stored a real event and removed its fixture. This begins only after deployment; earlier refusal attempts cannot be reconstructed. It does not diagnose Nikita's replay events or prove her tenant's security log.

The local Admin Governance Audit now lists append-only human connector action-approval events for requests, pending renewals, grants and uses. A database trigger captures transitions from the mutable capability row, and the eighteenth DPO migration backfills retained request/grant/use timestamps without inventing historical renewals or refusals. Reconstructed events are labelled and their original expiry is null because a pending request may have been renewed. A use event means the request passed the approval gate, not that the action succeeded; action outcome remains in its domain/activity history. The Admin-only, tenant-scoped 50-event page selects actor ID, approval/record IDs, route pattern, method, kind, known expiry, provenance and event time; summaries, request digests and session-family IDs are excluded. A disposable PostgreSQL 16 upgrade from the 64 pre-DPO migrations to all 18 DPO migrations passed with a pre-existing approval, live transition capture, provenance checks, append-only and state-rewrite rejection, and Admin/Member API checks. The local Docker container was removed. Earlier events absent from retained approval rows cannot be reconstructed; no deployed evidence from Nikita's dashboard exists.

The isolated E2E database reset inventory now names all 14 DPO-created tables and the missing ConfluenceReference table. Its exact-model and guarded-reset contract suite passes 50/50. This is reset-safety source proof, not a full isolated browser journey.

For the eighteenth migration, the blue-green gate has no blocking finding and warns about the new audit table's index and foreign key. The migration locks approval writes during the backfill so a concurrent grant cannot fall between the historical read and trigger installation. The disposable PostgreSQL rehearsal passed, but production-like approval volume and migration latency remain unmeasured; no live deployment was made.

The private disposable PostgreSQL 16 harness now exercises DPO-01 through real Fastify routes, Prisma and signed browser/MCP-connector session rows after the migrations. Synthetic Admin/Member requests confirmed Member 403 for statutory membership, complaints, conflicts and full export; 404 for restricted document detail/download; list omission until explicit `MEMBER_VISIBLE`; Admin access to seeded restricted records; and loss of restricted read after database role demotion despite an old Admin token. The container was removed. This is local API/database evidence only; it does not inspect actual content, exercise a rendered browser or full connector CLI, identify Nikita's tenant or prove deployed access.

The DPO-06 source follow-on adds a daily production-scheduler scan for latest active risk-control verification claims whose captured risk revision is unknown or differs from the current tenant risk. The scheduler logs only the global count; the tenant-scoped Admin Registers page already identifies each record for review. A failed scan uses the existing sanitized job-failure alert and fails run-once. `RISK_CONTROL_REVIEW_INTERVAL_MS` defaults to 24 hours and is bounded to one hour through seven days in scheduler and production preflight. API build, 27 focused scheduler/observability tests, all 180 production-preflight tests and a disposable PostgreSQL run of the real query pass. This does not establish C1 closure, inspect Nikita's tenant or prove a deployed scheduler.

A source review of DPO-03's remote-copy boundary found that leaving `CURRENT` revokes local external-publication approval and stops new worker publication, but an already processed Confluence page may remain. The existing owner ruling preserves published pages on ordinary deletion, and Confluence erasure is a separate reviewed action. Lifecycle status must not be described as withdrawing or purging an existing remote copy; disposition requires the exact tenant/page and controller review.

On 2026-09-29 an approved local Docker Desktop named-pipe run started a uniquely named, loopback-only disposable PostgreSQL 16 container. `prisma migrate deploy` applied all 81 repository migrations, including all 17 DPO migrations, to an empty database; `prisma migrate status` reported the schema up to date. The container was removed and an independent listing found no remainder. This supersedes older statements below that these migrations had never run on PostgreSQL. This empty-database run alone does not prove an upgrade with populated data or trigger behavior; neither run proves a live provider or deployment to Nikita's unknown tenant. No production database was touched.

A second disposable PostgreSQL 16 run deployed the 64 pre-DPO migrations, seeded a synthetic organisation/Owner and two legacy documents, and then applied all 17 DPO migrations. It verified restricted/unreviewed/unapproved/unheld defaults on those files, rejected publication before CURRENT status, rejected forged upload-intent transitions and accepted a matching live-document attachment. Prisma reported the schema up to date and container removal was verified. The repeatable local harness is private at `.charitypilot-private/dpo-upgrade-rehearsal.cjs`. This representative upgrade narrows the migration gap; it does not cover all legacy row shapes, concurrency, production scale, storage/Confluence providers or the unknown reviewed tenant.

The new optional upload timeout is documented in local/production env examples and architecture notes, and production preflight validates a canonical 100-1800000 ms range when set. The preflight suite passes 179/179 locally after stale source-shape assertions were updated to match current Member-specific query projections and forbidden fake-Atlassian variables were excluded from its required-input derivation. No deployment or live provider was exercised.

Local and Supabase document provider writes now have an abortable operation bound, defaulting to five minutes and capped at 30 minutes if configured. This remains below the one-hour orphan-reservation cleanup threshold. The API build and 30 focused storage/upload-intent tests pass, including a stalled Supabase response that closes its underlying request. This is source proof only; the upload-intent migration, real provider and live cleanup behavior remain unverified.

The connector's document-delete description and the human approval summary now describe removal of an eligible unheld draft, separately tracked primary-file cleanup and separate Confluence copy review. The Confluence erasure approval summary says it requests erasure and may need administrator purge review; fallback summaries do not claim completed purge. API/MCP builds, focused action-summary tests and the connector suite pass locally. This corrects approval wording; it does not change provider behavior or prove permanent erasure.

Data Requests now pages through retained per-case review events in groups of 50, using a cursor bound to the same tenant and case and a stable timestamp/event-ID order. The web screen loads older history and ignores a late response after the reviewer switches cases. API and production web builds and six focused lifecycle tests pass locally. This is access to intake/triage history, not a retention or erasure workflow completion; no live tenant check has run.

The minimised Compliance Record review draft now excludes the internal snapshot ID and hash, while retaining server-side integrity verification of the approved snapshot. Full and minimised HTML responses set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. API build and seven snapshot-export tests pass locally. The field/audience decision, live browser behavior and disclosure approval remain open; the private roadmap records the remaining questions.

Recovery-code sign-in records the resulting session family in the security audit. An active browser session that signed in with a recovery code within 15 minutes may remove MFA with its account password even if that was the last unused code; an unrelated session cannot use this path. This is source and focused-test evidence, not a PostgreSQL or live-host recovery proof.

An opt-in authenticator is now implemented locally for charity accounts. Each user can begin setup from `/security-data` after entering their password, confirm a six-digit code, and save ten single-use recovery codes. Browser and MCP connector sign-in both require the factor for an enrolled account before a new session is issued; TOTP reuse is blocked by a stored counter, recovery codes are consumed transactionally, and activation/removal revoke the account's existing sessions. Invalid code attempts use a shared five-attempt, 15-minute account budget after the password succeeds. The page is now reachable by Members for their own setting; its charity-wide controls stay Owner/Admin-only. Three security audit event types record activation, removal and recovery use without the codes. Two new migrations create the factor tables and admit the audit events; neither has run against PostgreSQL. Prisma validation, API/MCP and production web builds, focused tests, 2,246 broad API tests (Docker-backed and one local child-process check excluded) and 391 connector tests (four platform skips) pass locally. No role-wide MFA policy, lost-all-codes recovery authority, live browser evidence or DPO sign-off is claimed. A `JWT_SECRET` rotation makes enrolled TOTP secrets unreadable; saved recovery codes remain usable, so rotation requires a recovery and re-enrolment procedure.

The DPO-01 read-surface review found that old action-approval summaries could remain readable to an account after demotion to Member. Browser pending-approval and grant routes, plus connector preview and grant routes, now require the database-derived current Owner/Admin role. A regression test changes the role behind an Admin token and confirms all four routes deny before reading or granting an approval; API build, 34 focused tests, 2,236 broad API tests and 389 connector tests (four platform skips) pass locally. This has not been checked on Nikita's deployed tenant.

Failed-upload cleanup now starts with a provider-pinned `DocumentUploadIntent` saved before bytes are written. Document creation and attachment of that reservation share a transaction. The recurring and standalone cleanup jobs reconcile reservations older than one hour: they preserve a path referenced by a live same-tenant document and otherwise atomically queue provider-pinned deletion. Queue failures leave the reservation for retry and produce a count-only alert; the deletion worker checks again for a live document before erasure. API build, Prisma validation, 101 focused tests and 2,235 broad API tests pass locally, with Docker-backed PostgreSQL proofs and one resource-failing child-process check skipped. The new upload-intent migration and trigger have not run against PostgreSQL, and no live provider or tenant journey was tested. This is not a recovery window, backup purge or retention-policy approval.

Member login, `/auth/me` and invite acceptance now omit registered address, contact email/phone and conditional obligation profile from Member database selections, while Owner/Admin reads retain them. The login credential/lifecycle read fetches only organisation lifecycle before a role-matched public-user read; session issuance verifies the password and rejects a changed role under its principal lock. API build and 48 focused auth/team tests pass locally. This closes the wider internal auth/user read noted in the older checkpoint below at source level only; Nikita's tenant, records and deployed Member journey remain unverified.

A private DPO-01 route-family inventory is now at `.charitypilot-private/member-read-surface-inventory.md`. It maps current Member projections, Owner/Admin-only reads, connector and external-copy boundaries, and the remaining controller decisions. Source inspection found no new confirmed Member data leak in the reviewed route groups; it is not a live access certification. The profile-triggered evidence prompt now checks `CURRENT` lifecycle status itself before counting linked evidence, reinforcing the existing caller filter so historical links cannot satisfy a prompt if a future caller passes mixed records. The production web build and edited-file lint pass locally.

The Admin Registers page now checks the latest claim for each control across the tenant when the page opens and exposes a paged list of active verifications whose captured risk revision is missing or differs from the current risk. Its API joins only the same tenant's risk and claims, binds a pagination cursor to that tenant, and excludes withdrawn controls. The connector excludes this review route and withholds the new risk revision and document deletion-hold fields. The 50 focused register tests, 389 connector tests (four platform skips), API/MCP and production web builds, Prisma validation and edited web lint pass locally. This is a live-on-page review list, not a scheduled background scan or an assessment that the underlying evidence failed. The fourteenth DPO migration is still unapplied, and the reviewed tenant/C1 closure artifact are still unknown.

The DPO-06 control history now captures an integer risk revision with each new verification or withdrawal. A risk edit advances the revision, and the per-risk Admin history prompts evidence review when the latest active verification for a control predates the current risk. Withdrawn and superseded claims remain visible as history without an active review cue; older active claims have no invented revision and are explicitly marked for review. The fourteenth DPO migration supplies revision constraints and a database check on new claims; it has only passed schema validation, not PostgreSQL execution. The API build, 49 focused register tests, production web build, three compiled cue tests and edited web lint pass locally. This is a review cue, not C1 reconciliation, a verdict on control effectiveness or a scheduled stale-control check. Nikita's tenant and original admin-email closure evidence remain unknown.

Ordinary Vault deletion now accepts only unheld `DRAFT` documents. The service rejects all five other lifecycle states before creating a storage-deletion job, and the database delete condition rechecks draft status and hold state so a concurrent classification or hold cannot slip through. The Admin Vault disables Delete for retained or unreviewed evidence and explains the review boundary. This is an interim preservation control, not an approved retention period or a route for authorised permanent erasure. The 103 focused document route/storage/reliability tests, API and production web builds, and edited web lint pass locally. The lifecycle and hold migrations remain unapplied and no PostgreSQL or live tenant behavior has been verified.

New local/Supabase primary-storage deletion attempts now verify that the active path is absent before the storage service reports success. A Supabase remove acknowledgment alone is insufficient: only a subsequent authenticated HEAD 404 passes, while 200/400/error/timeout enters the existing retry/dead-letter path. The worker also rejects an apparent primary eraser success without a valid observation. A new nullable `activeObjectAbsentAt` receipt is written with `PROCESSED` only for new primary-storage observations; old processed rows and Confluence rows retain null. The thirteenth DPO migration adds the guarded receipt and remains unapplied. The 102 focused document/storage tests, 31 erasure/scheduler tests, five archive tests, 13 adjacent reliability tests, Prisma validation and API build pass locally. This is not historical proof, deleted-item recovery, provider-version/backup purge or a live deployment check. The current DELETE still removes bytes immediately; a trash/recovery period requires the controller's retention decision.

The Admin Registers screen now offers paged control-claim history for one risk, optionally filtered by exact control reference. The route binds cursors to the same tenant, risk and filter, while the charity-wide recent list is marked as a 100-entry view. The 23-test register route suite, API/MCP and production web builds, edited web lint and connector route coverage pass locally. The C1 risk and original admin-email closure evidence have not been identified; this path does not assert the control passed, backfill old claims or verify Nikita's deployment. The control-audit migration remains unapplied.

Governance Audit now uses an Owner/Admin-only `/governance-audit/:feed` archive route to page through retained history for eleven existing feeds, 50 rows at a time. A cursor must belong to the same tenant and feed; equal timestamps are ordered by event ID, and control claims use the database sequence. Document visibility and other document-control events have separate feeds. Storage-deletion paths/provider errors and data-request free-text reasons remain out of the overview. Five focused route tests, API/MCP and production web builds, edited web lint and connector route-coverage tests pass locally. This does not backfill older actions, cover every mutation domain, apply the pending DPO migrations, or prove Nikita's deployed interface.

Future replay events now include the presented session row's prior revocation reason in the restricted, allowlisted diagnostic. This separates a previously rotated, logged-out or already-quarantined token at the evidence level; it is not an incident verdict and cannot repair older events. The rotation and diagnostic tests plus shared/API builds pass locally. Nikita's actual events and deployed revision remain unexamined.

The restricted replay diagnostics now include the immutable security-audit event ID and page through older retained events 50 at a time using a tenant-bound timestamp/ID cursor. This lets an authorised reviewer retrieve and correlate an exact event once the reviewed tenant is identified; raw session-family IDs, user IDs, tokens and event context remain excluded. Focused service tests cover Admin access, Member denial and stable paging; shared/API/production web builds pass. It does not diagnose Nikita's observed reuse or restore events already expired from the audit store.

A 2026-09-29 DPO-05 source slice adds a per-document administrative deletion hold, default off, with an Owner/Admin place/release action that requires a reason and current revision. The action writes an actor-bound event in the document control history; ordinary Vault DELETE rejects a held record and conditionally deletes only if it remains unheld at the database write. The Vault shows the hold to Owner/Admin and disables Delete while held. The twelfth DPO migration has not run against PostgreSQL. Focused route tests, Prisma validation and API/MCP/production web builds pass locally. This is not a controller-approved legal hold or retention period, does not stop separate Confluence erasure or independent storage cleanup, and does not add deleted-item recovery or application-wide purge. No live Nikita-tenant check has run; Jasper does not know that tenant or the approved schedule location.

Nikita Serkevich confirmed continuing dashboard access and gave positive first-pass observations, but explicitly **did not provide production sign-off**. Her review raises Member access to sensitive records, repeated session-replay events, document lifecycle, report minimisation, application retention/erasure, and stale C1 verification evidence. She also asked to locate the minute book, application audit trail, document visibility controls, and tenant security/retention administration. The full email, source-level findings, unanswered questions and work order are in the local gitignored `.charitypilot-private/ROADMAP.md`. If that file is absent on another checkout, obtain the controlled private handoff from the owner; do not infer closure from this summary. Carry these points into the full-platform remediation and launch gates, and preserve the separation between source proof, live-instance proof and professional review.

The local first implementation slice restricts full report and conflict/complaint reads to Owner/Admin and adds document visibility, defaulting old and new records to `RESTRICTED`. An Admin may expose one document to Members with a reason; an append-only visibility audit records that decision. Member document list/detail/download and activity filter restricted document metadata; board submissions are now Admin-only and current-document-only. A later interim rule also restricts current Minute Book acts and resolutions to Owner/Admin, excludes them from Member search and navigation, and leaves their final audience/classification decision open. Edit and void histories are Admin-only. This is source and focused-test evidence only: the database migration, managed browser journey, hosted access, existing Confluence copies, remaining personal-data routes, replay-event cause, and DPO review are open. The private roadmap records the exact pending work.

A second local slice adds a conservative document lifecycle (`UNREVIEWED` for existing files, `DRAFT` for uploads), reasoned transitions and document-control history. A separate per-document Confluence publication approval now gates queueing, retry and worker execution; leaving `CURRENT` revokes that approval. Existing published Confluence copies still require inventory and separate withdrawal/erasure decisions. The Compliance Record has a separately labelled minimised **draft** derived only from a verified retained approved snapshot, with a strict field allowlist. Its audience and disclosure fields still require Nikita/Jasper's decision. Focused source tests passed; neither database migration has been applied, and the browser/live journeys have not been verified. Application-wide retention/purge, live replay diagnosis, C1 evidence correction and a unified governance audit remain open. These additions do not change the personal-server operating instructions or constitute DPO or production sign-off.

A follow-on access check found Member BoardMember API responses still selected detailed personal particulars. Member list/detail now project only ordinary trustee evidence, and Search enforces the Member field scope plus conflict/complaint exclusion and document visibility filtering. Focused board/search tests pass locally; the broader data inventory and live Member journey remain open.

The separate statutory membership register `/api/v1/members` was then found to expose postal addresses and former-member entries to signed-in Members. Its GET now requires Owner/Admin; a focused route test confirms Member denial before a database read. This conservative boundary awaits a reviewed register classification.

A further source check found unrestricted Member free text in risk/fundraising records, annual readiness, financial controls and compliance records/sign-off. Their API reads now use explicit Member projections that retain statuses, scores, flags and dates while omitting titles, narratives, names, minute references and editor/approver particulars. The corresponding screens explain the limited view. Owner/Admin reads are unchanged. API build and 41 focused route tests passed; edited web lint passed. This remains an interim coarse boundary pending classification and live verification. The existing web typecheck errors in unrelated test files that assign to readonly `NODE_ENV` remain.

The Minute Book removed-record feed exposed historic titles, deletion reasons and remover emails to Members. Its API and screen now restrict that feed to Owner/Admin. The 29-test governing-acts suite passed. Current acts and resolutions remain Member-readable pending classification.

The Board-submissions API is now Owner/Admin-only because it can carry resolution text and approval particulars even when the linked document is Member-visible. Its document query selects only `CURRENT` lifecycle files, so old or unreviewed files cannot be presented as current board evidence. The 33-test governing-acts suite covers the Member denial and current-only query. Current Minute Book act/resolution reads still need the controller's audience decision.

Minute Book act/resolution create and update now write actor-bound before/after snapshots atomically with each edit to an append-only table. Its Owner/Admin-only, tenant-scoped recent feed appears in Governance Audit and is excluded from the MCP connector. Document board-approval link/assertion changes now also write an actor-bound event in the existing document-control audit transaction. The 32-test governing-acts suite, API build, Prisma validation and connector tests pass. The fourth migration has not been applied to a database; no older edits are backfilled, and other domains still need audit coverage.

Document metadata PATCH now appends an actor-bound event in that same document-control history, recording edited field names and before/after revision times without duplicating names or descriptions. Uploads record the actor and restricted draft state atomically with database creation; an audit failure fails the upload and enters the existing storage cleanup path. Document DELETE now appends an actor-bound `RECORD_DELETE` event before provider cleanup, explicitly describing database removal rather than completed erasure. Governance-standard link and unlink mutations append actor-bound events with the standard ID; a repeated no-op unlink adds no false history. The metadata write is revision-guarded, and the 32-test document route and 32-test storage-cleanup suites cover the events and relevant failure paths. The still-unapplied lifecycle migration was extended with `METADATA`, `UPLOAD`, `RECORD_DELETE`, `STANDARD_LINK` and `STANDARD_UNLINK` event kinds. Legacy changes and other domain mutations remain outside a complete application audit.

DPO-05 now has a private source inventory at `.charitypilot-private/data-lifecycle-inventory.md` and a local Admin-only `/data-lifecycle` intake/triage screen. It records opaque external case references for erasure or retention review, received time, data area and append-only actor/reason/evidence events. OPEN, ASSESSING and DECISION_REQUIRED are deliberately unresolved states; the queue cannot claim deletion, recovery or purge. The fifth migration protects immutable intake facts and ties events to the same tenant at the database boundary. Four focused route tests, API build, Prisma validation, edited web lint and connector tests pass. No policy period, legal hold, deadline, actual deletion/recovery/purge or live/browser proof was added. The five DPO migrations remain unapplied.

Future web and connector replay audit events now carry the server request ID for restricted correlation with API logs, without storing a token. The 27-test auth-isolation suite passed. Existing replay events still require live investigation and cannot acquire this context retroactively.

The MCP connector consumes those same API guards. Its descriptions now state the Member omissions and statutory-register role boundary; its route coverage deliberately excludes the new Admin audit/operational endpoints, and its document field policy classifies the new control flags. The connector contract suite passed locally (388 passed, four platform-skipped).

The next local slice coordinates browser refresh across tabs using Web Locks and a noncredential completion stamp, but the cause of Nikita's live replay events remains unknown. Risk create/edit/delete now records append-only before/after history, while dated control verification has a separate append-only evidence record and Registers UI. C1 has not been marked verified without its original evidence. An Admin-only `/governance-audit` page gathers the newest document, risk, control, compliance, Minute Book edit and storage-deletion records and links to the separate Team security log. This page is a bounded recent view, not a complete historical audit. Storage-deletion history is metadata only; application-wide retention, recovery, legal holds and purge remain open. Five migrations are unapplied; no browser or live-host check has occurred. Focused API suites, API build, Prisma validation and the compiled cross-tab helper tests passed. Web typecheck has only the existing readonly `NODE_ENV` test-file errors. The private roadmap carries the exact remaining evidence and policy inputs.

The subsequent server-proxy slice coalesces only concurrent refresh calls in one Next process for the same credential header and origin, using a digest map key. It does not cache a completed rotation: later reuse still reaches the API replay control. The compiled proxy suite passed 23/23. The cause of Nikita's observed events is still unknown, and multi-replica or trailing-request races remain. Current Minute Book act and resolution reads are Owner/Admin-only pending classification; Member search cannot expose them. The focused governing-act/search suites passed 50/50, and the API build and edited web lint passed. These are local source checks. All five DPO migrations remain unapplied; the available workstation lacked Docker/psql clients and a local PostgreSQL listener for a disposable migration run.

The next DPO-03 source slice adds a sixth migration for tenant-bound `Document.supersededByDocumentId` lineage. Newly classifying a document as `SUPERSEDED` now requires a different `CURRENT` replacement in the same tenant and category; the decision writes a `REPLACEMENT` control event atomically. The Admin Vault offers a paged candidate search and shows recorded successors. Member responses and connector projections withhold the successor ID, which could otherwise disclose a restricted file. The foreign key blocks deleting a referenced replacement. Existing superseded files retain a null link pending individual review. Focused document API suites passed 92/92; the broad API suite passed 2166 tests when Docker-backed and sandbox-failing child-process proofs were excluded, and the connector suite passed 388 with four platform skips. Prisma validation, shared/API/MCP builds and edited web lint passed. At that checkpoint six DPO migrations remained unapplied and no browser or hosted verification had occurred. The later evidence correction at the top of this handoff located the March schedule's approval thread; the CharityPilot-specific mapping, C1 closure evidence and Nikita's exact dashboard tenant/environment remain unknown.

The replacement category is now protected after selection as well: the API refuses category changes on either side of a recorded replacement link, and the sixth migration includes a row-locking database trigger to preserve category agreement under concurrent edits. A constraint refusal maps to a reviewable API conflict. Thirty-nine focused document-route tests, API build and Prisma validation pass locally. The trigger and migration have not run against PostgreSQL, so database concurrency and live behavior are not yet proven.

The next DPO-01 read pass found custom and legacy calculated deadline titles could reach Members through the calendar, direct IDs, Search, dashboard and recent activity. Member queries now allow only current-rule generated records; custom and `LEGACY_UNVERIFIED` records stay Owner/Admin-only pending classification. Member generated-deadline responses also omit descriptions and saved profile/source snapshots, generated keys and replacement IDs. The Member calendar explains the narrower view and connector descriptions match it. Focused deadline/search/dashboard suites passed 35/35, the broad API suite passed 2168 tests with Docker-backed and sandbox-failing child-process proofs excluded, and the connector suite passed 388 with four platform skips. This has not been checked against Nikita's tenant or in a managed browser. The six DPO migrations remain unapplied, and the source-wide Member read inventory is still in progress.

The next DPO-01 check found Member organisation and authenticated-user responses still carried registered address, contact details and conditional obligation facts; for a small charity the address may be a trustee home address. The profile and shared auth/invitation user DTO now return null for those fields to Members, while Owners/Admins retain them. The Member profile route excludes those fields in its database selection; auth/user loading still selects the wider profile internally before response projection. The Member organisation page gives a basic profile without false missing-field prompts. Focused organisation/auth tests passed 34/34; the broad API suite passed 2170 with Docker-backed and sandbox-failing child-process proofs excluded, and the connector suite passed 388 with four platform skips. Edited web lint passed. Live Member behavior and remaining surfaces need review.

For Nikita's fourth interface question, `/security-data` now includes a personal opt-in authenticator setting for every charity user and maps tenant roles, sessions, security events, password recovery, governance audit, data-request intake, document/storage deletion and Confluence copy management for Owners/Admins. It still labels approved application-wide retention enforcement, legal holds, deleted-item recovery and permanent-purge administration as unavailable. Role-wide MFA enforcement is not configured. This is local source/build evidence, not proof that Nikita can see the page on her live dashboard.

A further DPO-01 source check found that the Member compliance sign-off response still carried approved-snapshot IDs and evidence/snapshot hashes, while `/compliance/approval-readiness` exposed standard-level evidence gaps and profile-review flags to Members. The Member sign-off projection now omits the snapshot metadata; approval-readiness is Owner/Admin-only, and Member web screens skip its request. The compiled compliance route suite passed 20/20, the API and production web builds passed, and edited web lint passed. The six DPO migrations remain unapplied; no live role journey, replay investigation or DPO approval was obtained. The workstation has no available Docker or PostgreSQL client for a disposable migration run; CI's migration-deploy step is source-wired but has not run for this checkout.

The next DPO-02 source slice exposes a bounded Owner/Admin replay-diagnostics view in Security & Data. Its API checks the live actor and tenant before selecting the latest 50 `SESSION_REPLAY_DETECTED` events, then returns only time, a short one-way family fingerprint, client/access category and a validated server request ID when available. It withholds raw family IDs, user IDs, tokens and arbitrary audit context; the MCP connector excludes the route. The focused team-lifecycle suite passed 21/21, connector route coverage passed 5/5, and shared/API/MCP and production web builds passed. No historical replay cause can be inferred from the source, older events may have no request ID, and the approved live environment remains unidentified.

A DPO-06 register-history slice adds a seventh migration and a metadata-only, actor-bound action trail for trustee, conflict, complaint and fundraising create/update/delete, plus annual-report and financial-control create/update. Each audit write shares the mutation transaction; deletion leaves the audit row without duplicating personal details or narrative. The Owner/Admin-only `/governance-registers/change-audit` feed appears in Governance Audit and is excluded from the connector. Prisma validation, API/MCP and production web builds passed locally; focused tests now cover all six register classes. No migration was run against PostgreSQL on this workstation; all seven DPO migrations and live/browser review remain open. Earlier actions are not backfilled, and this is not a complete application audit.

A further DPO-01 search pass found that Member search could quote risk titles and fundraising names although the Member register API withheld those fields. Member search now skips those two record classes entirely; the focused search suite passes 16/16, including a Member with a FULL session data-scope flag. This is source-only and leaves the register-by-register audience decision and live role journey open.

The Member dashboard activity feed also exposed compliance editors and document uploaders through actor IDs/names. Member activity now omits those actor fields and avoids fetching the relations; Owner/Admin activity retains them. The combined dashboard/search suite passes 26/26 locally. Document field classification and live Member review remain open.

A further DPO-01 document-card pass found that a Member-visible file still exposed unreviewed description, owner, board-minute reference and uploader ID in list/detail, while search could match the minute reference. Member document queries now select only the shared-card fields and return null for those four metadata fields; closed-scope search and the MCP field policy withhold the minute reference. The authenticated download remains available and Admin detail retains its full metadata. Focused document/search tests pass 41/41, connector field-policy tests 37/37, and the production web build passes. The file itself and other metadata still require a controller classification and live role review.

The dashboard board-alert and compliance-summary database reads now select only the fields their aggregates use, rather than loading full trustee particulars and compliance narratives. The connector's withheld Document scope also excludes the Board-resolution identifier, which could join to the restricted Minute Book. The API build and focused dashboard/compliance suites pass 30/30 locally; live access and controller classification remain open.

A further DPO-06 slice adds metadata-only, actor-bound organisation profile edit history in the same transaction as each successful PATCH. Its eighth DPO migration creates an append-only table; `/organisation/audit` and Governance Audit expose the newest 100 tenant-scoped entries to Owner/Admin, while the connector excludes the route. It records submitted field names and revision times without copying address, contact or obligation values. Forty focused organisation tests, five connector route-coverage tests, Prisma schema validation and API/MCP/production web builds pass locally. The eighth migration has not been applied to PostgreSQL, legacy edits are not backfilled, and the application audit remains incomplete.

Member generated-deadline list/detail/history and dashboard reads now exclude saved generation snapshots, keys, description, profile-review key and successor ID in the database selection. The response still returns null placeholders for these fields through an explicit allowlist. Focused deadline/dashboard suites pass 20/20 locally; the live role journey and controller classification remain open.

Statutory Members register create/edit actions now append actor-bound, metadata-only records in the mutation transaction, visible through the existing Admin register-action feed. A ninth DPO migration permits `MEMBER` events; four focused member audit/privacy tests and the API build pass locally. It has not been applied to PostgreSQL and older actions are not backfilled. The register's pre-existing one-year `retentionDeleteAt` rule remains subject to comparison with the approved retention schedule; no broader retention policy was inferred.

Interactive deadline creation, edits, completion and archival now append metadata-only, actor-bound history in the same transaction. The tenth DPO migration creates the append-only trail and an Owner/Admin `/deadlines/audit` feed in Governance Audit; the connector excludes it. Prisma schema validation, API/MCP/production web builds, focused deadline tests and the broad API run (2,188 passing, with the two environment-dependent checks excluded) pass locally. At that checkpoint automatic calendar reconciliation and reminder delivery were not included; older actions are not backfilled, and the tenth migration has not been run against PostgreSQL.

Organisation-profile edits that regenerate deadlines now append actor-bound `GENERATE` and `SUPERSEDE` entries for changed occurrences in the same serializable transaction. The metadata-only events record state changes, edited field names and revision times without copying titles or profile inputs. The still-unapplied tenth migration allows those action/state pairs. The focused deadline, organisation and governance tests pass 53/53; API build and Prisma schema validation pass locally. Reminder delivery remains in its separate operational history, not this governance feed. No live migration or Nikita-tenant check has run.

The statutory membership edit now validates the resulting entry/cessation date pair inside the transaction even if the user changes only one date. Five focused tests pass locally. Its former one-year `retentionDeleteAt` formula was removed from local source and is not a valid policy mapping; stored historical values await reconciliation. The document dead-letter recovery path is a storage-cleanup retry or acknowledgement, not deleted-item restoration; the private lifecycle inventory distinguishes these states.

The Vault deletion dialog and success message now distinguish immediate record/standard-link removal from separately tracked file cleanup and Confluence copy erasure. This corrects a misleading claim that the file itself was removed when cleanup may have failed and entered retry. Edited web lint passes; no purge or deleted-item recovery claim follows from the UI copy.

The Admin risk-control panel now flags active risks when their recorded review date is due or past due, and counts active risks without a review date. This is a review prompt, not evidence that a control failed or passed; periodic automation is still open. A bounded search of repository docs/source and all-ref commit messages did not find the separate admin-email/C1 closure artifact. A 2026-09-30 local Timebank folder follow-up extracted text from 288 Word files and 241 PDFs; it found the generic March C1 risk row but no later closure receipt, with seven PDFs unreadable by the extractor. The live C1 record, its revision, the relevant tenant and original verification evidence remain unknown, so no C1 status was changed. The date-selection test, production web build and edited-file lint pass locally. The private roadmap records the search and outstanding reconciliation.

Risk-control verification and withdrawal now lock the tenant-scoped risk row before checking the latest claim, and the append-only table has a database-assigned sequence for deterministic event order when timestamps tie. The second withdrawal is rejected after the first. Prisma generation/schema validation, API build and 47 focused register tests pass locally. The third DPO migration is still unapplied; no PostgreSQL concurrency test or C1 correction is claimed.

A later document lifecycle guard prevents new governance-standard links from being created after a document leaves `CURRENT`, even if a status change races the API's earlier check. A database trigger serialises the link insertion with the document row, while existing links remain as historical evidence. The API returns a conflict on the trigger refusal. The API build and 40 focused document-route tests pass locally; the eleventh DPO migration has not run against PostgreSQL. A read-only browser inventory found no open CharityPilot dashboard session on 2026-09-29, so it did not identify Nikita's tenant or verify live replay/C1 records.

The Vault now marks a recorded Confluence copy attached to a non-current document for separate review instead of showing a green published badge. It also avoids a failed-publication retry that the API would reject after lifecycle withdrawal. The copy remains in the guarded status module; 31 focused copy tests, edited-file lint and the production web build pass locally. Existing external pages are not automatically withdrawn or erased, and the live reviewed tenant remains unidentified.

Board approval PATCH no longer creates an audit event for a repeated identical value, and rejects an empty patch before a document read. It still checks a newly supplied resolution against approved Minute Book evidence. Shared/API builds and 36 focused governing-act tests pass locally. This improves audit truth for future changes; it does not repair older history or prove the deployed workflow.

The Data Requests queue's append-only intake and triage events now have a tenant-scoped, Owner/Admin-only recent feed in Governance Audit. Its overview omits free-text reasons; an individual controlled case still shows them. The MCP connector excludes the new endpoint. Five focused intake tests, 11 connector route-coverage tests, API/MCP and production web builds, and edited-page lint pass locally. The feed starts with the unapplied intake migration and does not implement retention periods, legal holds, deletion, recovery or purge.

A further DPO-01 Team read pass found that Members could receive other account holders' email addresses, verification flags and suspended/removed membership rows. The Member Team query now selects active accounts only and omits those contact/verification columns; the UI and connector description reflect the narrower response. Owner/Admin management reads remain complete. Shared/API/MCP and production web builds, 16 focused Team API tests, 20 compiled Team UI/permission tests, 52 connector tests and edited web lint pass locally. This does not complete the Member data inventory or verify the deployed tenant and Nikita's role.

Member risk and fundraising list/detail routes now use database selections containing only their existing Member response fields. Annual-readiness and financial-control Member reads also select only their visible status, flag and date fields, with null placeholders for unclassified narratives, reviewer details and minute references. Owner/Admin reads remain complete. The 22-test register route suite checks these selections, withheld response text and tenant scoping; the 25-test service suite and API build pass. No live role journey or controller-approved classification follows from this source change.

Search now fetches only ID and the columns it is permitted to match or display under the current role/session scope. Previously a Member query could load a whole matched trustee, document or deadline row while returning a safe hit. The 16-test search route suite applies the database selection in its fake delegate and checks every Member query's allowed fields; the API build passes. Sensitive register and Minute Book classes remain excluded from Member search. This is a query boundary, not live-host or DPO verification.

Member compliance record list/detail queries now avoid loading evidence narratives and editor relations, selecting only the fields used by the existing limited response. Member sign-off reads select visible metadata plus only the current snapshot's evidence hash; they do not read the latest historical snapshot or approver details. An approved sign-off still recomputes the current evidence hash internally so `approvalCurrent` remains accurate. Admin reads retain full evidence. The 21-test compliance route suite and seven export-snapshot tests pass with the API build. This is source-only and does not settle the Member audience classification or prove deployed behavior.

The next DPO-01/03 guard closes a new-release gap for legacy documents. The Admin Vault now explains and disables Member release while a file's lifecycle is `UNREVIEWED`; the API returns a conflict for that transition. Migration `20260929250000_unreviewed_member_visibility_guard` adds a `NOT VALID` CHECK that also rejects direct database writes into the unreviewed/Member-visible combination. It enforces new and updated rows without certifying old rows; an existing violating row must be classified or restricted before another update. The focused document route suite passed 48/48, the API build, edited UI lint, E2E TypeScript and static migration gate passed. The focused isolated PostgreSQL/Chromium Owner journey passed with a disabled release button and database CHECK denial; the gated runner exited 0. The earlier combined navigation suite had a repeated authentication-service 503 on reload, so it is not a clean suite result for this edit. Nikita's reviewed tenant, actual contents, controller audience and live migration remain unknown.

A follow-on closes the legacy-read side of that boundary. Member Vault list, detail and download, Search and dashboard activity now exclude `UNREVIEWED` documents even if an old row says `MEMBER_VISIBLE`. Download rechecks lifecycle after storage I/O, and its current-session role check treats that file as restricted. The focused document, search and dashboard suites pass 106/106 with the API build. This protects local source reads but does not classify existing rows, reverse earlier exposure, or constrain external Confluence copies. There is no live-tenant read or deployment proof.

A read-only host check found the historical CharityPilot Tailscale peer online and its unauthenticated HTTPS health and login endpoints responding. Subsequent work-mailbox correspondence confirms Nikita reached that same private host and signed in on 19 September for a light deployed-version review; her 28 September feedback says she still had dashboard access. The exact tenant, role and revision on 28 September remain unverified. The private roadmap records the correspondence IDs and host lead without invitation credentials. The public endpoints expose no tenant or signed-in build identity. Do not use this host as a deployment target or close replay/C1 findings until the tenant and revision are established.

The 2026-09-30 connector mutation follow-up added web-session checks to the Confluence OAuth callback, publish destination, citations, declared environment, erasure request and disconnect, plus Vault publication retry and failed storage-deletion requeue. Their connector tool exclusions alone were not an API boundary. The existing Confluence erasure connector test now expects refusal before approval creation. API build and 181 focused integration/document/recovery route tests pass locally. A further pass added web-session checks to one-time invitation-link retrieval, charity ownership transfer and billing checkout/portal (including aliases); Team/billing tests pass 38/38 and connector route contracts 15/15. Do not treat this as live provider deletion, deployed tenant evidence or DPO acceptance; the private connector boundary map names the intentional exceptions.

## 2026-07-12 private Linux host profile

A separate `private-linux-server` host profile now preserves the option to run
the compiled single-charity appliance on an inexpensive x86-64 Linux VM. It
adds `scripts/Install-CharityPilot.sh`, a Linux preflight, a local Unix-socket
Docker boundary, Linux permission enforcement, release metadata and the
authoritative `docs/personal-server-deployment-linux.md` runbook. It reuses the
existing Caddy/Next.js/Fastify/PostgreSQL topology and encrypted recovery engine;
the Windows and strict public-production profiles remain intact.

Repository contracts are implemented, but Linux has no live certification yet.
Do not claim it ready for irreplaceable records until a clean VM install,
reboot/login, Tailscale director access, off-host recovery, different-VM restore,
failed-resume/replacement wrappers, version-bound update/rollback and exact-SHA
Linux release acceptance pass. The Windows readiness score does not transfer.

## Active Full-Platform Remediation Audit

Before selecting production-completion work, read:

- `docs/platform-remediation-audit-2026-07-10.md`

That document is the authoritative human-maintained remediation ledger for the
2026-07-10 full-platform audit. It records the 669/1000 baseline, every confirmed
repository issue, the strict launch-evidence split, safety constraints, external
blockers, acceptance criteria, and the continuous inspect/fix/verify/commit/push
loop. Do not narrow the goal to the generated platform audit or stop because
local gates are green.

## 2026-07-10 Remediation Checkpoint

The detailed issue contract remains in
`docs/platform-remediation-audit-2026-07-10.md`. The current P0 checkpoint is:

- **P0-01 annual-reporting claim containment - `CI_VERIFIED`.** Commit
  `97f64b0285eb2d19489c062cda52134fda8f9a53` passed CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29073803773`.
  Local evidence was web `244 / 244`, shared `19 / 19`, web lint/build,
  generated-audit currency, and production tooling `396 / 396`. Named
  accountant/Irish-solicitor approval remains external.
- **P0-02 Resend acceptance/retry semantics - `CI_VERIFIED`.** Commit
  `fbd5ce4` passed CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29074651622`.
  Local evidence was focused email/degradation/reminder/auth/team/scheduler/
  idempotency tests `73 / 73`, full API `438 / 438`, API build, and production
  tooling `396 / 396`. A real accepted Resend send and verified production
  domain remain external launch evidence.
- **P0-03 duplicate Stripe subscription path - `CI_VERIFIED`.** Implementation
  commit `ce9a5ed9701776bb2a957da647b3620288be173b` plus the launch-counter and
  readiness-test repairs through `7ffc8f862d863f559365668c19550be00d0bb382`
  passed CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29077589143`.
  The repository now has a one-per-organisation
  `BillingCheckoutAttempt` lease/migration, attempt-bound Stripe idempotency and
  metadata, remote customer/subscription reconciliation, strict terminal-state
  restart rules, expired-session reconciliation, stale/superseded webhook
  protection, authoritative subscription re-retrieval, exact one-item/
  quantity-one price+interval validation, raw Stripe status/cancel scheduling,
  server-owned web capabilities, and a pinned Billing Portal configuration.
  Existing Stripe-managed subscriptions are portal-only; public copy no longer
  promises unverified proration or offers Checkout as a plan-change route.
  Focused API billing/idempotency verification is `50 / 50`; provider-checker
  verification is `13 / 13`; shared is `19 / 19`; web is `248 / 248`; web lint
  and production build pass; and the final full API suite is `454 / 454` after
  all P0-03 tests were integrated. Production tooling is `488 / 488`, the
  reliability report is green with `365 / 365` covered links, and the platform
  audit is current.
- **P0-04 compliance concurrency and immutable board approval -
  `CI_VERIFIED`.** Commit `e03b80a44150c384485b5e47e524b9ee60475f70`
  passed CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29082113651`.
  Compliance record/sign-off writes now use explicit
  revisions, serializable organisation locking, compare-and-swap updates,
  idempotent replay handling, and append-only full before/after history. Board
  approval is bound to a canonical immutable evidence snapshot and hash;
  approved-record changes invalidate the current pointer while retaining prior
  snapshots for tenant/year-scoped historical export and deliberate reapproval.
  Legacy approvals are truthfully invalidated rather than reconstructed from
  mutable deployment-time data. Current/approved exports verify freshness,
  tenant scope, row metadata and hashes and preserve CSP when opened through the
  authenticated browser client. The frontend serializes autosave, preserves
  newer drafts across old responses and failures, provides safe conflict
  reconciliation, guards dirty navigation, sequences principle loads, and
  never presents stale approval as current. Local evidence is API `477 / 477`,
  web `272 / 272`, shared `23 / 23`, production tooling `488 / 488`, local-Docker
  tooling `43 / 43`, reliability `374 / 374`, lint, production builds, Prisma
  generation/validation, security scans, zero-vulnerability dependency audits,
  refreshed generated audits, and a clean 14-migration deployment plus
  rollback-only trigger/constraint probes on a dedicated throwaway
  `charitypilot_ci` PostgreSQL container.
- **P0-05 destructive E2E isolation - `CI_VERIFIED`.** The repository now
  supplies a managed, UUID-bound disposable E2E stack and fail-closed database
  identity/reset contract. Database, API, and web stay internal-only while a dedicated
  secretless, read-only fixed-route TCP gateway alone publishes the runner's
  loopback ports; its absolute `.invalid.` routes map only to unique internal
  aliases. API builds the shared app image once and web reuses it. The runner
  executes one private validated Compose snapshot and attests immutable built
  image IDs plus exact live container isolation before Playwright. The complete
  gate passed `113 / 113` isolation contracts and `96 / 96` live Playwright
  tests in `9.6m` (`25.0m` for the full fresh-build/test/verified-teardown
  command) against the real disposable PostgreSQL instance and baked production
  web runtime. Exact-project teardown left no Docker/private-state residue and
  preserved the personal web/API/database container IDs. Remote worker seams
  now prove suite-lease presence, reset proves same-session ownership, and the
  outer janitor runs only after exact POSIX group absence; native-Windows remote
  destructive mode is explicitly rejected. The run also exposed and repaired a
  production-relevant shared-proxy-IP `/auth/me` throttle: credential limiting
  is layered with a coarse IP ceiling, authentication/limiting/origin checks use
  one Bearer parser, and the bounded web proxy accepts exact `200`, refreshes or
  redirects only on explicit `401`, and strictly validates both rotation or
  deletion cookies. Wider evidence is API `488 / 488`, web `295 / 295`, shared
  `23 / 23`, production tooling `512 / 512`, local-Docker tooling `44 / 44`,
  reliability `374 / 374`, root lint/build, security scans across `497` files, and zero
  dependency vulnerabilities. The complete slice is published as commit
  `e9f63038a5e8fe0c0680dcc015566dff2525a56b`; CI run `29116192805` and E2E run
  `29116192729` both completed successfully for that exact SHA, with the latter
  passing `96 / 96` Playwright tests in `3.2m`. Release-promotion and deployed
  browser proof remain separate P0-09/launch gates.
- **P0-06 deadline calendar and recurrence integrity - `CI_VERIFIED`.**
  Strict civil-date helpers replace JavaScript month overflow and cover every
  month-end class, leap years, Europe/Dublin DST boundaries, Irish public
  holidays, and Companies Act working-day adjustment. Generated deadlines now
  carry source/input fingerprints, stable rule identity, versions, provenance,
  supersession links, and immutable history; changed inputs create a new
  incomplete successor and revoked confirmations remove the current occurrence
  without deleting history. Company/CRO rules require explicit confirmed facts,
  while contradictions, impossible chronology, future actual events, and unsafe
  date ranges fail closed. Manual due-date/reopen changes advance reminder
  schedule identity, generated occurrences allow only one-way atomic completion,
  and reminder history stores immutable occurrence snapshots. Generated
  completion now requires an explicit irreversible confirmation, current lists
  traverse every API page, and organisation/manual-deadline writes reject stale
  `updatedAt` versions rather than overwriting newer governance facts. The scheduler
  pages all current eligible rows, sends separately to every verified owner,
  revalidates recipient/subscription/occurrence under a proven lock order,
  expires stale pre-I/O reservations atomically, marks `SENDING` before provider
  I/O, and quarantines every crash, timeout, 409, 5xx, malformed, boolean, or
  unknown provider outcome as `UNCERTAIN`. Acceptance-confirmed and
  unknown-acknowledged reconciliation remain dedupe suppressors; only immutable
  proof that the provider never accepted/created the original message permits a
  fresh token/key. The scheduler awaits active work during bounded shutdown, and
  deploy releases residual reservations, quarantines residual provider I/O, and
  blocks startup on unresolved ambiguity. The migration conservatively
  quarantines all legacy reminder states without fabricating provider/timing
  evidence, preserves exact annual-report id/completion/log identity, and fails
  closed on range, tenant, generated-row, AGM-evidence, duplicate, and id-collision
  ambiguity. A real PostgreSQL historical-upgrade fixture exercises eleven
  fail-closed scenarios in CI and release-image publication. Full API/web/shared
  suites are green (`545 / 545`, `313 / 313`, `35 / 35`), Prisma validates, and a
  disposable PostgreSQL 16 proof passed fresh/upgrade migrations, constraint and
  concurrency probes. A non-UTC (`America/Los_Angeles`) live application-path
  probe also proves the fixed civil-date claim binds and snapshots
  `2030-01-15` unchanged. Root lint/build, production tooling `544 / 544`,
  local-Docker contracts `44 / 44`, E2E safety contracts `113 / 113`, security
  scans across `545` staged files, zero-vulnerability dependency audits, generated-audit currency, and
  reliability linkage `396 / 396` is green. A focused managed browser run
  passed the Organisation contrast and migrated-profile save regressions, then
  the complete managed gate passed `113 / 113` isolation contracts and `97 / 97`
  Playwright tests with verified teardown. The complete implementation landed in
  `8474ab1d8b44e016f4782bf5c99302509cbd692f`; final verification SHA
  `096619cf3ee84ae7d3f62826b3510af388defd85` passed GitHub CI run
  `29136095002` and managed E2E run `29136095004`, with the latter reporting
  `97 / 97` ordinary passes in `3.2m` and no flaky tests. Professional rule
  review remains external launch evidence.
- **P0-07 team lifecycle, session families, billing-authority interlocks, and
  authenticated document delivery - `CI_VERIFIED`.** Team members now
  have explicit lifecycle state, optimistic versions, suspend/remove/reactivate
  operations, bounded session-family inventory and revocation, immutable audit
  subject snapshots, exact-one-owner database protection, serializable ownership
  transfer, and a restricted dry-run-first recovery job. Invitation acceptance
  transactionally rechecks lifecycle and subscription access. Refresh/replay/
  logout use ordered family locks so a successor cannot survive a logout race
  and unrelated device families are not over-revoked. Durable Checkout/Portal
  authority grants prevent ownership changes while provider capability is
  unresolved, and provider-start ambiguity cannot be request-locally released.
  Documents are delivered as authenticated API-proxied bytes with post-storage
  session revalidation, bounded I/O, exact storage-path enforcement, and no
  provider URL or object key in the browser. Local evidence is API `658 / 658`,
  web `335 / 335`, shared `40 / 40`, production tooling `545 / 545`, local-Docker
  tooling `44 / 44`, reliability `395 / 395` covered links across `415`
  guarantees, web lint, Prisma validation, and security scans across `576`
  files. The live PostgreSQL upgrade fixture passed lifecycle, owner,
  session-family, tenant, immutable-audit, and fail-closed rollback probes.
  Managed proof passed `113 / 113` isolation contracts, all `18`
  migrations, the real logout-vs-refresh race, the Team/Billing scenarios, and
  a fresh production-build document upload/download journey, with exact
  zero-residue teardown. Implementation commit
  `6fb1bdd29bb862dd43558d4fc09bc7c03f5d68a8` plus CI-repair commit
  `1970995d00d8981f0a0d352ac535f092b4e3b51e` passed exact-SHA CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29146063800`
  and managed E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29146063808`;
  E2E passed `113 / 113` isolation contracts and `103 / 103` Playwright
  scenarios in `3.4m`.
- **P0-08 role authorization and current processing/cookie truth - overall
  `IN_PROGRESS`; completed repository sub-slices `CI_VERIFIED`.** Members now
  have truthful read-only governance affordances across Team, Board, Documents,
  Compliance, Dashboard, Registers, Deadlines, Organisation, and Export while
  retaining legitimate reads, navigation, authenticated document download, and
  export access. Exact stale-role `403`/`FORBIDDEN` responses fail closed without
  redirecting and restore persisted or canonical state where needed. The privacy
  draft now matches PostgreSQL/Prisma, custom authentication, private Supabase
  object storage, stored Stripe state, and implemented Resend messages; the cookie
  UI is a necessary-cookie information notice backed only by local
  acknowledgement. Local proof passed web `351 / 351`, API `662 / 662`, shared
  `40 / 40`, production tooling `546 / 546`, local-Docker tooling `44 / 44`,
  production web build, lint, E2E typecheck, `113 / 113` isolation contracts, and
  `3 / 3` focused plus `105 / 105` complete managed browser scenarios with
  verified teardown and no flaky retry. Implementation commit
  `44ff57b596b0ac6b527a3f338bddc71a095ca2cc` plus final verification/repair SHA
  `42888a41e86bd7235891e82a18623208b921d773` passed exact-SHA CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29150323690`
  and E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29150323669`;
  E2E passed `113 / 113` contracts and `105 / 105` scenarios in `3.5m`. P0-08
  remains open for trial/plan behavior, deletion and retention workflows, VAT
  treatment, controller/legal-basis/rights/provider/contact decisions,
  operational mailboxes, and professional legal, privacy, and accounting approval.
- **P0-09 executed browser assurance and release protections - overall
  `IN_PROGRESS`; repository-only gate/truth sub-slice `CI_VERIFIED`.** The
  Release Images workflow now calls the reusable managed E2E workflow and makes
  publication depend on its success. The called browser job is read-only;
  package and OIDC write authority is scoped only to the dependent publish job.
  The reliability report and generated ledger now distinguish static E2E-title
  linkage from execution, print `EXECUTED E2E: NOT VERIFIED BY THIS COMMAND`, and
  use `LINKAGE CHECK: COMPLETE` instead of an overall browser `GREEN`. Local
  proof passed production tooling `548 / 548`, API reliability `660 / 660`, web
  reliability `351 / 351`, and `395 / 395` covered-guarantee linkage. Exact-SHA
  CI run `29151170819` and E2E run `29151170810` passed implementation commit
  `62170e55ac3bafe6f7cdd105eace11faaeba5d2c`; E2E passed `113 / 113` contracts
  and `105 / 105` scenarios in `3.5m`. Live branch/ruleset and
  Production-environment protections plus a controlled release run remain
  repository-owner/external work; no GitHub setting was changed and no release
  was triggered merely to test the workflow.
- **P0-10 metadata plus document-byte recovery - overall `IN_PROGRESS`;
  repository proof tooling `CI_VERIFIED`.** The repository now captures a
  source-bound PostgreSQL identity and proves an unchanged dump in an isolated,
  source-environment-matched restore target. A separate owner-only manifest
  generator/verifier reconciles complete document metadata, deletion/recovery
  history, and object bytes by exact key, size, and SHA-256, with bounded
  inventories and no sampling. Launch evidence requires the database and object
  proofs to share the recovery set and dump digest without equating their
  different identity domains. Local proof passed the root gate, API `706 / 706`
  plus isolated live migration `1 / 1`, web `351 / 351`, production tooling
  `746` passed / `0` failed / `2` Windows skips (`748` total), local-Docker
  `44 / 44`, and secret/SAST scans across `597` files. Final SHA
  `0c5b795ec2cbc906a119f7ffd52bd552519d232c` passed exact-SHA CI run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29163982047`
  and managed E2E run
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29163982033`.
  Real production database/object backups, RPO/RTO, retention, monitoring,
  operator evidence, and a non-production joint provider restore remain genuine
  external launch gates.
- **P1-04 document-deletion retry lifecycle - `CI_VERIFIED`.** The bounded
  retry/dead-letter/operator-recovery implementation through
  `8c573e3d0ea3729293201b32e14bafc7d4365ae0` is now reverified by final SHA
  `0c5b795ec2cbc906a119f7ffd52bd552519d232c`. The expanded scheduled-cleanup
  smoke assertion and isolated live-migration test phase passed CI run
  `29163982047`; managed E2E run `29163982033` also passed.
- **P1-09 domain invariants and referential safety - `CI_VERIFIED`.**
  Shared/API/web complete-state validation now prevents reversed
  board terms, contradictory trustee evidence, reversed closed fundraising
  periods, and filed reports without filing dates. Organisation-first locks,
  tenant-scoped composite conflict pointers, transactional history-preserving
  board deletion, five database checks, and narrow Prisma race mapping make the
  same invariants durable. The atomic migration never rewrites governance data
  and ships with a historical failure/remediation/recovery verifier. At this
  checkpoint, production recovery required the P1-09 compatibility line, an
  exact env/image-bound attestation, all 20 checksums captured inside the
  selected digest-pinned image, exact failed history/catalog/data state,
  terminal read-only SQL whose errors cannot be masked, exact resolution, and
  immediate full redeploy. Local proof
  is shared `54 / 54`, API `749 / 749` plus live concurrency `2 / 2`, web
  `369 / 369`, production tooling `791` pass / `0` fail / `2` platform skips,
  personal-server `21 / 21`, local-Docker `44 / 44`,
  lint/build/Prisma/security gates, and a real built-image
  tamper-negative/pristine-positive recovery with an identical before/after
  database fingerprint and zero residue. Implementation commit
  `c71481791b6716a06818c341d130fe25d7f32b7b`, the adjacent Windows fixture
  repair `3aba948962cbacf075d018564385acf972cb7dc5`, and the evidence refresh form
  exact verification SHA `812b9ff83e0407146e50a2dd0e87fea05561addb`.
  GitHub CI run `29168177797` and managed E2E run `29168177757` passed for that
  SHA; E2E passed `113 / 113` runner contracts and `105 / 105` browser scenarios
  in `3.6m`.
- **P1-07A password-recovery integrity - `CI_VERIFIED`.** Password recovery now uses a bounded
  durable request ledger, database-backed keyed identifier/network budgets,
  concurrent-link-safe delivery, a durable versioned Resend worker, atomic
  password/request/session/audit/outbox completion, and a registered-address
  post-reset notice. The recovery root secret is protected by a database
  generation fence, append-only retired-fingerprint history, and a quiesced
  invalidate-before-replace rotation workflow. Migration
  `20260712013000_add_password_recovery_integrity` preserves valid active legacy
  slots exactly once, clears inactive legacy slots without inventing recovery
  evidence, fails closed on active account emails that exceed the durable
  recipient bound, and retires both legacy `User` fields. Current ordinary deploys use
  `CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1`; P1-09 is now
  a restore-only rollback boundary requiring an exact pre-P1-07A backup and the
  checksum-bound, read-only restored-history/P1-07A-absence probe before backup
  or migration. Final local evidence is shared `55 / 55`, API `810 / 810` plus four
  isolated real-PostgreSQL proofs `4 / 4`, web `371 / 371`, production tooling
  `827` passed / `0` failed / `2` expected Windows symbolic-link privilege skips
  (`829` total), personal-server `24 / 24`, local-Docker `45 / 45`, and the final
  local managed disposable E2E gate: runner contracts `113 / 113` plus browser
  scenarios `105 / 105` in `7.6m`, followed by clean isolated teardown. Lint,
  E2E typecheck, Prisma,
  optimized builds, security/dependency, reliability `395 / 395`, historical
  migration, built-image recovery, rollback, and launch-evidence gates also
  passed. Implementation commit
  `1e639c89b49ce5ed27a8ea3b887ef140c7f142b5` first reached CI run
  `29184769464`, which failed only at the fresh scheduled-job image smoke's
  recovery binding; companion managed E2E run `29184769502` passed. The
  follow-up repaired CI/release setup, and a local built-image replay passed
  `migrate -> bind -> scheduler` with zero residue. Exact final verification SHA
  `b2138acfe0b7b7a9127a14667f10a771982a0e3b` then passed CI run
  `29185333589` in `8m24s`, including the repaired scheduled-job image smoke,
  and managed E2E run `29185333588` in `6m41s` with `105 / 105` browser
  scenarios. This is repository publication evidence, not deployment,
  production-provider, legal, or human-policy evidence.
  Parent item P1-07 remains open for MFA, breached-password policy, and the
  remaining reviewed account/ownership-recovery policy.

The retained 2026-07-11 stashed working snapshot predated these later P0-10,
P1-04, P1-09, and P1-07A checkpoints. Its historical production-tooling count
corrections remain in the verification chronology below; this newer security
and recovery evidence remains authoritative for the 2026-07-12 handoff.

P0-03 is not live-provider proof. Before production enablement, the billing
owner must inventory and reconcile Stripe customer/subscription history,
confirm at most one non-terminal subscription per organisation/customer,
expire every legacy open subscription-mode Checkout session created before the
attempt-bound release, prove the exact pinned portal/price/product/cancellation
policy, and exercise purchase, duplicate-click, portal change, cancellation,
terminal restart, and webhook retry/order against the promoted release. Keep
that redacted evidence outside Git.

## Project

- Workspace: `C:\platforms\htdocs\CharityPilot`
- Canonical GitHub repository: `https://github.com/jasperfordesq-ai/charity-governance`
- Default branch: `master`
- Branch policy from the user: work on `master`; do not create feature branches unless explicitly told otherwise.
- Commit policy: commit and push completed work to `origin/master` in small verified increments.

## Current Launch State

Run this first in a fresh session:

```powershell
git status --short --branch
npm run launch:status -- --json
npm run audit:platform:check
node scripts/platform-completion-audit.mjs --json
```

Local personal-use safety before heavy work:

- `npm run personal:ready` is the non-destructive local confidence gate for one-person use on this computer without Stripe, payments, public hosting, or production providers.
- It checks local Docker boot/login/document storage, PostgreSQL backup and restore verification, local document-storage backup, and a personal browser smoke with billing safely disabled when Stripe is absent.
- `npm run test:e2e` owns a separate disposable stack and refuses ambient or
  personal database targets. Do not bypass that runner with direct Playwright or
  weaken its identity checks; the suite intentionally resets only its proven
  disposable tenant/app tables.
- This local safety gate does not replace production provider, deployed HTTPS, legal, pentest, backup/restore, or final signoff evidence.

### Compiled one-charity personal server profiles

The user's immediate operating goal is explicitly separate from the public SaaS
launch: run CharityPilot for one charity on a trusted Windows host or a
supervised x86-64 Linux VM, with optional private access for named directors,
while retaining the existing multi-organisation/provider/public-production work
for a later commercial deployment.

The implemented front door is **Caddy**. Windows uses Docker Desktop/WSL 2;
Linux uses the local native Docker Unix socket. Both run Caddy, the compiled
Next.js server, the compiled Fastify API, PostgreSQL and the document volume.
Caddy alone publishes
`127.0.0.1:8080`, routes `/api/v1/*` to Fastify and all other paths to Next.js.
There is no IIS dependency, no API/database host port, no source bind mount and
no development watcher in this profile. Tailscale Serve may terminate private
HTTPS and proxy to that loopback Caddy port; Funnel and router forwarding are
out of scope/prohibited.

Source-of-truth files:

- `docs/personal-server-deployment.md` - complete Windows/Tailscale/accounts/
  lifecycle/backup/recovery/security/VM-migration runbook;
- `docs/personal-server-deployment-linux.md` - supervised Linux installation,
  security, operation and outstanding live-acceptance contract;
- `compose.personal-server.yml` and `caddy/Caddyfile.personal-server` - isolated
  compiled runtime;
- `.env.personal-server.example` - non-secret field contract; the generated
  `.env.personal-server` is Git-ignored;
- `scripts/Install-CharityPilot.ps1` and `scripts/Install-CharityPilot.sh` -
  host-specific first-install entry points within their documented support
  boundaries;
- `scripts/personal-server.mjs` - internal/shared lifecycle for start, status,
  stop, backup, recovery, account reset and guarded maintenance operations;
- API `personal-server` env/initializer/account utilities - fail-closed private
  startup, empty-database one-charity initialization, manual invitation and
  hash-only one-hour reset links; and
- `AGENTS.md`, `README.md`, and the architecture map - permanent discovery
  pointers and the answer to which web server is used.

Safety invariants:

- routine `start` never builds, migrates or seeds;
- initialization creates one blank organisation, one verified Owner, an active
  Complete entitlement and governance reference data, and refuses nonempty
  Organisation/User state;
- the Owner password and plaintext invitation/reset capabilities are transient
  and are never persisted to `.env.personal-server`; the independent
  `AUTH_RECOVERY_SECRET` root is deliberately persisted only in that ignored,
  operator-protected env file and must be rotated through the documented
  invalidate-before-replace workflow;
- registration and provider-backed email recovery fail closed; directors use
  Owner/Admin-created fragment invitation links and host-issued fragment reset
  links;
- billing UI/public signup are hidden or redirected and provider jobs remain
  disabled, while the strict public-production validator is unchanged;
- the fixed Docker gateway/Caddy addresses form a narrow trusted-proxy chain;
  personal HTTPS refreshes, redirects and CSP use the validated configured
  origin rather than the plaintext internal hop;
- web and Caddy health checks probe the non-redirecting internal `/login` route,
  so they never attempt to follow `/` out to a Tailscale hostname;
- backups quiesce writers, restore-verify PostgreSQL, archive the matching
  document volume, hash both artifacts and restore the prior service state; and
- normal stop/update commands never delete the personal database or document
  volumes.

Original personal-server implementation checkpoint evidence from 2026-07-11:

- API `726 / 726` passed;
- web `363 / 363` passed;
- personal wrapper/Compose contracts `21 / 21` passed;
- default, `personal-init`, and `maintenance` Compose renders passed;
- lint passed; and
- wrapper secret/SAST scans passed across 597 files; and
- the full production-tooling gate passed `746`, failed `0`, with `2`
  Windows-only symbolic-link privilege skips (`748` total).

The first exact push, `0587f637d3b8511127f16e9a0184f05c7291b39b`, reached
CI run `29165538508`. Security, schema, legacy upgrades, migrations,
backup/restore and lint passed, then the API test process exposed that two new
test files had relied on an ambient local `JWT_SECRET` at module import time.
No application assertion failed. The tests were changed to set a test-only
secret before dynamically importing the JWT-dependent modules, matching the
existing route-reliability pattern. A full API rerun with `JWT_SECRET`
deliberately removed then passed `725 / 725` ordinary tests plus the isolated
real-PostgreSQL migration test (`726 / 726` total). The follow-up push/CI result
must be treated as the exact-commit publication proof.

Both public and personal-server native optimized web builds passed. Docker
exported the personal migration and API runner images. A separate web-only
Docker build returned no compile error but did not export its image within a
15-minute bound on the already heavily loaded Docker Desktop daemon. Its
orphaned compose client was stopped, Docker's long-lived service was preserved,
and read-only inspection confirmed no personal containers, volumes or network.
The installer was then changed to build `migrate`, `api` and `web` sequentially;
its 21 safety contracts remained green. Do not describe the personal profile as
live-certified until the web image and real initialization complete.
An attempted `caddy:2-alpine` pull for binary Caddyfile validation failed at the
registry blob download with `EOF`; no Caddy container remained. Static
Caddy/trusted-proxy contracts and all Compose renders passed, but real binary
validation therefore remains part of first initialization.

No real `.env.personal-server`, Owner account, personal data, private Tailscale
route or live personal-server container was created during this implementation.
Before entering real records, initialize from a reviewed clean checkout, run a
real second-device access check, create an encrypted off-host recovery set and
complete the acceptance checklist in the runbook. A private-profile success is
not public-production launch evidence and closes none of the external/provider,
legal, pentest, recovery or final-signoff gates below.

The updater creates a verified pre-update database/document set, but its v1
manifest does not retain old application images or automate destructive schema
rollback. A migration/start failure may intentionally leave writers stopped.
Record the compatible commit/image identity and rehearse the runbook's deliberate
restore procedure before treating updates as production-grade.

Known launch state refreshed on 2026-07-12 from the checked workstation,
current GitHub metadata, and the expanded 89-check evidence schema:

- Phase: `ENV_INCOMPLETE`
- `.env.production` exists but still has 18 counted values needing real
  production data. It also predates P1-07A and lacks the separately required
  `AUTH_RECOVERY_SECRET` and
  `CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1`.
- Production values complete: `9 / 27`.
- Launch evidence ledger exists at `.charitypilot-launch-evidence/production-launch-evidence.json`.
- Machine-readable launch evidence completion: `9 / 89`.
- Strict counted launch gates: `18 / 121` complete (`14.9%`), counting only production values, launch evidence checks, and final signoff roles.
- `approvedForLaunch`: `false`
- Final signoffs approved: `0 / 5`
- Real charity data remains blocked.
- Full-platform audit baseline captured on 2026-07-10 at
  `8809bac3a897afe6078df82142097c3fcc924e8f`; the remediation score was
  `669 / 1000`, while the strict launch-gate score remained `18 / 117`.
- GitHub CI for that audit baseline passed:
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29068890047`.
- Earlier verified release-gate hardening checkpoint preserved by this handoff:
  `cb78eb85bb0127150ad448037b5d03b8060869bf`.
- GitHub CI for that commit passed:
  `https://github.com/jasperfordesq-ai/charity-governance/actions/runs/29021018683`.
- The final P1-07A local production-tooling gate captured by this handoff passed
  on 2026-07-12 with `827` checks passed, `0` failed, and `2` expected Windows
  symbolic-link privilege skips (`829` total). The final local managed
  disposable E2E gate also passed `113 / 113` runner contracts and `105 / 105`
  browser scenarios in `7.6m` with clean isolated teardown. Exact-pushed-SHA
  publication is now complete: implementation commit
  `1e639c89b49ce5ed27a8ea3b887ef140c7f142b5` and final verification SHA
  `b2138acfe0b7b7a9127a14667f10a771982a0e3b`; CI run `29185333589` passed in
  `8m24s` and managed E2E run `29185333588` passed in `6m41s` with `105 / 105`
  browser scenarios. This closes P1-07A repository publication only.
- The preceding local production-tooling checkpoint retained from the stashed
  working snapshot was:
  `npm run test:production-check` passed on 2026-07-11 with `746` checks
  passed, `0` failed, and `2` Windows-only symbolic-link privilege skips (`748`
  total). Older `823`, `791`,
  `746`, `745`, `548 / 548`, `546 / 546`, `545 / 545`, `544 / 544`, `494 / 494`, `488 / 488`, `396 / 396`, `352 / 352`,
  `338 / 338`, and `339 / 339` entries in the verification chronology below are historical
  counts from earlier commits, not the current gate size.
- This handoff may be committed by a later docs-only refresh commit. Treat
  `npm run launch:status -- --json` and its `repositoryState.headSha` as the
  live source of truth for the current checkout before collecting evidence.
- The generated platform audit intentionally keeps repository clean/synced state
  live-only; run `npm run launch:status -- --json` and inspect
  `repositoryState` from the release checkout before collecting launch evidence.
- Fresh public DNS/HTTPS spot check on 2026-07-12 found both canonical
  production hosts unresolved from this workstation:
  `app.charitypilot.ie` and `api.charitypilot.ie`.
- GitHub `production` environment variables currently include
  `NEXT_PUBLIC_API_URL=https://api.charitypilot.ie`. That is the only public
  provider origin required by the web image; Supabase remains API/server-only.
  The non-secret `DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST` variable is
  now also required by the GitHub environment preflight and remains missing until
  the real managed PostgreSQL hostname is selected.
- `npm run check:production:github-env -- --environment=production` now verifies
  the release-image GitHub environment without reading secret values. Rerun it
  before promotion; the obsolete public Supabase variable is no longer a gate.
- `npm run check:production:github-secrets -- --environment=production` now
  verifies required GitHub `production` secret names without reading secret
  values when GitHub is the approved deployment secret store.
- GitHub `production` environment secrets currently include only the generated
  non-provider entries `JWT_SECRET` and `READINESS_API_KEY`. The live metadata
  refresh on 2026-07-12 therefore lacks seven required names:
  `AUTH_RECOVERY_SECRET`, `DATABASE_URL`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and
  `ERROR_ALERT_WEBHOOK_URL`.
- `master` remains unprotected. The GitHub `production` environment permits
  administrator bypass and has no protection rules or deployment branch policy.
  The active immutable personal-release tag ruleset is separate and does not
  satisfy the public-production branch/environment gate.

The 18 missing production values are:

- `TRUSTED_PROXY_ADDRESSES`
- `DATABASE_URL`
- `DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_ESSENTIALS_MONTHLY_PRICE_ID`
- `STRIPE_ESSENTIALS_YEARLY_PRICE_ID`
- `STRIPE_COMPLETE_MONTHLY_PRICE_ID`
- `STRIPE_COMPLETE_YEARLY_PRICE_ID`
- `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`
- `RESEND_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ERROR_ALERT_WEBHOOK_URL`
- `CHARITYPILOT_API_IMAGE`
- `CHARITYPILOT_WEB_IMAGE`
- `CHARITYPILOT_MIGRATION_IMAGE`

For release image promotion, `npm run launch:status` now also exposes the
GitHub `production` environment variables required before `gh workflow run
release-images.yml --ref master` can produce the `release-image-digests.env`
artifact:

- `NEXT_PUBLIC_API_URL=https://api.charitypilot.ie`
- `DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST=<managed-postgres-hostname>`

Validate those non-secret GitHub `production` environment variables before
running the image workflow:

```powershell
npm run check:production:github-env -- --environment=production
```

## Non-Negotiable Product Posture

Do not claim CharityPilot is legally guaranteed, "100% legally bombproof", or a substitute for legal advice.

Correct posture:

- review-ready;
- source-cited;
- evidence-led;
- difficult to misuse;
- clear that solicitor, governance, privacy, accounting, safeguarding, employment, and other professional review may be required.

## What Has Been Achieved

### UI/UX and Product Surface

- Full UI/UX revamp has been carried across the main P0 flows:
  - marketing;
  - auth;
  - dashboard;
  - compliance overview;
  - compliance principle detail;
  - documents;
  - deadlines;
  - board;
  - registers;
  - regulator;
  - organisation;
  - team;
  - billing;
  - export;
  - loading, error, empty, disabled, and not-found states.
- Light and dark mode support is present across the app.
- Route files have been decomposed: no route page remains over 450 lines according to the platform audit.
- P0 dashboard routes now use extracted panels, workflow hooks, and shared primitives rather than large monolithic route files.
- Shared UI primitives are in place for:
  - loading states;
  - empty states;
  - error states;
  - locked-feature states;
  - review warnings;
  - inline status;
  - save status;
  - source references;
  - file upload;
  - form alerts;
  - action buttons.
- HeroUI controls are now used for key binary/choice/input surfaces:
  - switches;
  - checkboxes;
  - radio groups;
  - buttons;
  - inputs;
  - file upload.
- Lucide icons have replaced route-local inline SVGs across the main route chrome and key actions.
- Pricing page metadata is ASCII-safe and pricing feature/comparison icons use `lucide-react` directly.
- Marketing blog search uses the shared empty-state primitive for no-result filters; marketing landing signal tiles use shared status panel styling; dashboard annual regulator summary, summary cards, progress cards, deadline lists, and board-alert cards use shared status panel styling; compliance overview summary, principle cards, and detail standard editor cards use shared status panel styling; compliance standard autosave, organisation profile saving, governance register saving, document vault mutations, export board sign-off, and board/deadline/team mutations use the shared save-status primitive; export controls and board-approval panels use shared status panel styling; billing checkout and portal handoffs use shared visible status; billing current-plan summary and plan prices use shared/flat panel treatment instead of nested route-local cards; team permission-denied messages use shared permission hints instead of route-local hidden or bespoke status markup.
- Dashboard mobile navigation has explicit ARIA controls, Escape handling, focus recovery, and focus trapping.
- Breadcrumbs and principle labels are source-backed and meaningful.

### Compliance and Legal-Readiness Model

- Irish compliance source metadata was refreshed against official sources on 2026-07-09.
- The matrix includes source metadata, last-checked dates, professional-review flags, and commencement status.
- The product includes explicit not-yet-commenced monitoring rows for relevant Charities (Amendment) Act 2024 provisions.
- Conditional obligation profile facts were added for:
  - staff/workers;
  - volunteers;
  - public fundraising;
  - child-facing services/safeguarding;
  - personal-data processing/GDPR;
  - premises/events;
  - public-sector context;
  - processors.
- Conditional obligation prompts now surface through documents, deadlines, registers, regulator, export, and organisation workflows.
- Export readiness is broader than missing explanations:
  - missing standard records;
  - missing actions;
  - missing evidence;
  - missing explanations;
  - missing conditional-profile facts;
  - profile-triggered professional-review prompts.
- API-rendered exports include:
  - source/professional-review appendix;
  - not-legal-advice/non-certificate disclaimer;
  - source counts;
  - professional-review flags;
  - not-yet-commenced monitoring metadata.

### Backend, Security, and Reliability

- Tenant isolation, auth/session guards, role guards, plan gates, validation, redaction, document privacy, and billing degradation are covered by tests and tooling.
- Browser auth moved away from localStorage and into HTTP-only cookies.
- Refresh sessions are hashed, revocable, and rotating.
- Password reset and verification tokens are hashed before storage.
- Logout and server-side refresh revocation exist.
- Identifier-aware throttles exist for:
  - email;
  - reset/verify token;
  - refresh token;
  - bearer/access-cookie credentials.
- Stripe customer reconciliation was added:
  - organisation-scoped idempotency key;
  - metadata verification before checkout/portal reuse;
  - stale or wrong-organisation IDs repaired through metadata reconciliation.
- Duplicate-subscription prevention now adds a serializable
  `BillingCheckoutAttempt` lease, customer-wide provider subscription checks,
  attempt-bound webhook validation, authoritative Stripe re-retrieval, exact
  price/interval/quantity enforcement, and a pinned safe portal policy. Checkout
  is restricted to first purchase or provider-confirmed terminal restart;
  Stripe-managed changes are portal-only.
- Document storage paths include UUIDs to avoid same-millisecond filename collisions.
- Document file privacy is preserved through private storage and authenticated API-proxy downloads with post-read session revalidation; storage capabilities never reach the browser.
- Document metadata responses do not expose internal storage object keys.
- Production error handling redacts sensitive values.
- Alert webhook and production checker transcript redaction is in place.
- Backup/restore helper transcript redaction is in place.

### Production and Launch Tooling

- Canonical production origins are aligned:
  - web: `https://app.charitypilot.ie`
  - API: `https://api.charitypilot.ie`
- Production deploy defaults include `compose.production.yml` plus `compose.production-tls.yml`.
- A `--no-tls-proxy` escape hatch exists for managed platform TLS.
- Caddy/TLS runbook, environment template, smoke checks, evidence validators, and release workflow all align around the canonical hostnames.
- Release workflow builds and publishes digest-pinned runtime/migration images.
- Deploy preflight validates digest-pinned images and web build-origin metadata.
- Production deploy and rollback scripts run preflight and public HTTPS smoke checks.
- Launch status output groups missing production values by source:
  - hosting/proxy;
  - PostgreSQL;
  - Stripe;
  - Resend;
  - Supabase;
  - observability;
  - release image promotion.
- Launch status has JSON output for operator dashboards and handoffs.
- Launch status exposes both read-only launch-evidence progress commands and strict launch-evidence validation commands, including JSON variants.
- Launch status exposes the deployed browser QA command set for responsive, accessibility, cross-browser, and iOS Safari evidence collection.
- Launch status exposes the full production check, provider, deploy, rollback, release-run evidence, and final evidence validation command sequence.
- Launch status exposes the final signoff role list, solicitor/governance/privacy review, external pentest, release binding, and review-ready legal posture.
- Launch status keeps the full source-grouped production value checklist visible after `.env.production` exists, while separately listing the currently missing values.
- Strict launch-evidence JSON validation includes the next incomplete checklist items and evidence hints so failing launch-gate output can drive operator work queues.
- Production launch evidence initializes outside the repo root in `.charitypilot-launch-evidence/`.
- Launch evidence status has read-only progress output and strict final validation.
- The platform audit generator records launch evidence state and falls back to direct `.git` metadata reads if shelling out to git is unavailable.
- Release E2E timeout handling is limited to the exact spawned child process
  tree, escalates a stuck POSIX child after a bounded grace period, and keeps
  signal handlers active while the runner tears down and verifies its exact
  pinned-daemon Compose project. It never scans for or stops unrelated Node/npm
  processes on a shared workstation; failed cleanup makes the gate red and
  retains the private recovery inputs.
- Release readiness child gates resolve `npm` and `npx` through explicit Node
  CLI entrypoints on Windows instead of shell execution, keeping launch
  evidence transcripts free of shell-argument deprecation warnings.
- Responsive/accessibility route QA now fails fast when protected-route
  navigation hits a 500, a Next.js/runtime overlay, a login redirect, or a
  browser JavaScript page error while resolving the compliance principle detail
  route. This keeps deployed/browser-QA evidence actionable instead of ending in
  a vague missing-selector timeout.

### Launch Evidence Hardening

The launch evidence model has been tightened substantially:

- Evidence references must use HTTPS URLs on approved hosts.
- Approved references are limited to `*.charitypilot.ie` or the canonical GitHub repository.
- GitHub evidence must point to `github.com/jasperfordesq-ai/charity-governance`.
- Signed URLs and token-bearing query strings are rejected.
- Evidence descriptions and references reject raw secret-looking values.
- Evidence file path errors are redacted.
- Pentest evidence must bind to the promoted `release.commitSha`.
- Deployed browser QA evidence must bind to the promoted `release.commitSha`.
- Final signoff evidence must bind to the promoted `release.commitSha`.
- Final signoff requires five roles:
  - engineering;
  - operations;
  - security;
  - legal/compliance;
  - business.
- Legal/compliance evidence must include solicitor/governance/privacy review.
- Browser QA evidence requires:
  - deployed responsive coverage;
  - deployed accessibility coverage;
  - cross-browser coverage;
  - real iOS Safari or cloud-device proof;
  - full route inventory across desktop/mobile and light/dark.
- Supabase evidence requires a private bucket, service-role upload/download and anonymous-denial proof, backup/PITR evidence, restore-test owner/date/recovery notes, an isolated restore target that is explicitly a non-production restore target, and confirmation that the production project was not overwritten.
- Billing/email evidence requires Stripe webhook event proof, webhook-secret secret-store proof, Resend accepted-send proof, and production email-link origin proof.
- Evidence chronology now allows the package to be prepared before evidence is collected, while requiring every checklist evidence entry to be captured no later than `finalSignoff.approvedAt`.
- Deploy-smoke evidence hints now match the strict validator:

```powershell
npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/secure/charitypilot/cutovers
node scripts/smoke-production-deploy.mjs --production-env-file .env.production
Production deploy smoke passed
https://app.charitypilot.ie
https://api.charitypilot.ie
```

## Recent Verification Evidence

Recently successful checks in this workstream:

- P0-09 exact-SHA release-gate and reliability-truth verification
  - Release promotion structurally requires the reusable read-only managed E2E
    job before the write-enabled publishing job can start.
  - Production tooling passed `548 / 548`. The reliability command executed API
    `660 / 660` and web `351 / 351`, found `31` linked Playwright titles, and
    reported `395 / 395` linkage complete while explicitly declining to certify
    E2E execution.
  - Implementation SHA `62170e55ac3bafe6f7cdd105eace11faaeba5d2c` passed CI
    run `29151170819` and E2E run `29151170810`. CI passed root web `351 / 351`,
    API `662 / 662`, shared `40 / 40`, production tooling `548 / 548`, and
    local-Docker tooling `44 / 44`; E2E passed `113 / 113` contracts and
    `105 / 105` scenarios in `3.5m`.
  - A controlled release run and live repository protections remain
    repository-owner/external work.
- P0-08 role/privacy exact-SHA verification
  - Web `351 / 351`, API `662 / 662`, shared `40 / 40`, production tooling
    `546 / 546`, local-Docker tooling `44 / 44`, web lint/build, E2E typecheck,
    and security checks passed.
  - The focused managed run passed `113 / 113` isolation contracts and `3 / 3`
    Playwright scenarios in `54.5s`: real-member route traversal and authenticated
    document-byte download, live Admin-to-Member demotion with an exact API
    denial, and rendered privacy/cookie truth. Teardown left no managed E2E
    container residue.
  - The complete local managed gate passed `113 / 113` contracts and `105 / 105`
    browser scenarios without a flaky retry. Implementation SHA
    `44ff57b596b0ac6b527a3f338bddc71a095ca2cc` plus final repair/verification SHA
    `42888a41e86bd7235891e82a18623208b921d773` passed exact-SHA CI run
    `29150323690` and E2E run `29150323669`; the latter passed `113 / 113`
    contracts and `105 / 105` scenarios in `3.5m`.
  - Deterministic discovery/evidence SHA
    `2734dc167777765ceec297917940615f05770590` passed exact-SHA CI run
    `29150668596` and E2E run `29150668600`. The main CI `Test` step ran all web
    `351 / 351`, API `662 / 662`, and shared `40 / 40`; E2E passed `105 / 105`
    scenarios in `3.7m`.
- P0-07 exact-SHA verification
  - Full suites passed on 2026-07-11: API `658 / 658`, web `335 / 335`, and
    shared `40 / 40`.
  - Production tooling passed `545 / 545`; local-Docker tooling passed
    `44 / 44`; Prisma validation, web lint, and secret/SAST scans across `576`
    files passed.
  - The live P0-07 PostgreSQL upgrade fixture passed lifecycle, owner,
    session-family, tenant, immutable-audit, and atomic rollback probes.
  - The regenerated reliability ledger has `415` guarantees, `395 / 395`
    complete links, and `20` explicit not-applicable rows; exact-SHA E2E is the
    separate browser-execution evidence.
  - Focused managed proof passed the concurrent logout-vs-refresh invariant;
    a fresh current-tree document run passed `113 / 113` isolation contracts,
    the production build, all `18` migrations, and upload/download `1 / 1` in
    Playwright. Both runs proved exact zero-residue teardown.
  - Implementation commit `6fb1bdd29bb862dd43558d4fc09bc7c03f5d68a8`
    plus verification/fix commit `1970995d00d8981f0a0d352ac535f092b4e3b51e`
    passed exact-SHA CI run `29146063800` and E2E run `29146063808`; the
    latter passed `103 / 103` Playwright scenarios in `3.4m`.
- `npm run test:e2e`
  - Passed locally on 2026-07-10 for P0-06 with `113 / 113` isolation contracts
    and `97 / 97` live Playwright tests in `7.0m`; the cached production-image,
    attestation, readiness, test, and verified-teardown command took `11.6m`
    against the UUID-marked disposable PostgreSQL instance. A preceding focused
    managed run also passed the Organisation contrast, migrated-profile save,
    generated-completion, and repeated compliance-select regressions. Exact
    teardown left no runner Docker/private-state residue or personal-stack
    drift. Final SHA `096619cf3ee84ae7d3f62826b3510af388defd85`
    passed CI run `29136095002` and E2E run `29136095004`; the latter reported
    `97 / 97` ordinary passes in `3.2m` with no flaky tests.
- `npm test`
  - Passed on 2026-07-11 with API `545 / 545`, web `313 / 313`, shared
    `35 / 35`, production tooling `544 / 544`, and local-Docker tooling
    `44 / 44`.
- `npm run reliability:report -- --write`
  - Passed on 2026-07-11 with `396 / 396` covered guarantees linked to passing
    test titles. Static linkage alone is not browser execution; E2E runs
    `29116192729` and `29136095004` supply exact-SHA execution for P0-05 and
    P0-06 respectively. P0-09 remains open for
    release-promotion, deployed-browser, and live repository-protection proof.
- `npm run build`, `npm run security:scan`, and both dependency audits
  - Passed on 2026-07-10; all workspaces built, `545` staged files passed secret/SAST
    scans, and both audits reported zero vulnerabilities.
- `node --test apps/api/dist/tests/billing-subscription-integrity.test.js apps/api/dist/tests/billing-reliability.test.js apps/api/dist/tests/billing-reminders-hardening.test.js apps/api/dist/tests/idempotency-reliability.test.js`
  - Passed on 2026-07-10 with `50 / 50` focused P0-03 billing tests.
- `node --test scripts/check-production-providers.test.mjs`
  - Passed on 2026-07-10 with `13 / 13` provider-contract tests covering exact
    prices/product grouping, pinned portal policy, webhook events, and Resend
    domain verification.
- `npm test -w @charitypilot/web`
  - Passed on 2026-07-10 with `248 / 248` tests for the P0-03 checkpoint.
- `npm test -w @charitypilot/shared`
  - Passed on 2026-07-10 with `19 / 19` tests for the P0-03 checkpoint.
- `npm run lint -w @charitypilot/web` and `npm run build -w @charitypilot/web`
  - Passed on 2026-07-10 for the capability-driven billing UI and truthful copy.
- `npm test -w @charitypilot/api`
  - Passed on 2026-07-10 with `454 / 454` tests after all final P0-03 focused
    regressions were integrated.
- `npm run test:production-check`
  - Passed on 2026-07-10 with `488 / 488` production-tooling tests.
- `npm run reliability:report -- --write`
  - Passed on 2026-07-10 with API `454 / 454`, web `248 / 248`, and `365 / 365`
    covered-guarantee links resolved.
- `npm run audit:platform:check`
  - Passed on 2026-07-10; `docs/platform-completion-audit.md` is current.
- `gh run watch 29077589143 --exit-status`
  - Passed on 2026-07-10 for the complete P0-03 implementation and CI-repair
    chain through `7ffc8f862d863f559365668c19550be00d0bb382`.
- `gh run watch 29074651622 --exit-status`
  - Passed on 2026-07-10 for P0-02 commit `fbd5ce4`.
- `gh run watch 29073803773 --exit-status`
  - Passed on 2026-07-10 for P0-01 commit
    `97f64b0285eb2d19489c062cda52134fda8f9a53`.

- Historical direct responsive Playwright proof passed on 2026-07-09 after the
  compliance-detail resolver was hardened. Its old boolean reset command is
  intentionally omitted and retired; repeat only through `npm run test:e2e` or
  the managed focused responsive scripts.
- `node --test scripts/check-local-docker.test.mjs`
  - Passed on 2026-07-09 with 38/38 local Docker and browser-QA wiring checks.
- `npm run test:production-check`
  - Passed on 2026-07-09 with 352/352 production-tooling checks during the
    latest handoff refresh.
  - Historical count; the 2026-07-11 local production-tooling gate passed 746
    checks with 0 failures and 2 Windows-only symbolic-link privilege skips
    (748 total).
- `npm run audit:platform:check`
  - Passed on 2026-07-09 after the same browser-QA diagnostic hardening.
- `node scripts/platform-completion-audit.mjs --json`
  - Read-only machine-readable audit output for route, backend, launch,
    compliance, and next-action handoff automation; it must not rewrite
    `docs/platform-completion-audit.md`.
- `gh run watch 29021018683 --exit-status`
  - Passed on 2026-07-09 for commit `cb78eb8`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, scheduled-job smoke, and
    dependency audit after no-shell release gate execution hardening.
- `gh run watch 29020485769 --exit-status`
  - Passed on 2026-07-09 for commit `11b0f5b`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, scheduled-job smoke, and
    dependency audit after repo-scoped failed E2E cleanup hardening.
- `gh run watch 29012705817 --exit-status`
  - Passed on 2026-07-09 for commit `0d29887`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, scheduled-job smoke, and
    dependency audit after release-ready stack reachability timeout hardening.
- `gh run watch 29010531551 --exit-status`
  - Passed on 2026-07-09 for commit `7c182f3`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, scheduled-job smoke, and
    dependency audit after the live-only platform-audit repository-state
    hardening.
- `gh run watch 29001831333 --exit-status`
  - Passed on 2026-07-09 for commit `786d7ff`.
  - Covered CI security scan, Prisma validation/migration, PostgreSQL
    backup/restore, lint, tests, reliability ledger, local Docker smoke,
    workspace builds, Docker image builds/smokes, and dependency audit.
- `npm run test -w @charitypilot/web`
  - Passed on 2026-07-09 with 232 web tests after compliance navigation
    confirmation copy/timer-guard hardening.
- Historical direct compliance Playwright proof passed on 2026-07-09 with both
  journeys green. Its direct reset invocation is retired; repeat with
  `npm run test:e2e -- tests/compliance.spec.ts` through the isolated runner.
- `npm run lint -w @charitypilot/web`
  - Passed on 2026-07-09 after the same changes.
- `npm run build -w @charitypilot/web`
  - Passed on 2026-07-09 after the same changes.
- `npm run audit:platform:check`
  - Passed on 2026-07-09 after the same changes.
- `npm run test:production-check`
  - Passed on 2026-07-09 with 338/338 production-tooling checks passing after
    the same changes and the GitHub production environment evidence gate.
    Historical count; the 2026-07-11 local production-tooling gate passed 746
    checks with 0 failures and 2 Windows-only symbolic-link privilege skips
    (748 total).

- `npm test -w @charitypilot/web`
  - 220 web tests passed after public attribution, shared auth status icons, and shared auth loading-state polish.
- `npm run lint -w @charitypilot/web`
  - Passed after the same auth/public trust-surface work.
- `npm run release:ready`
  - Passed on 2026-07-09 at commit `cf683f1` in the latest full local release-gate run recorded by this handoff.
  - Security scan, lint, build, workspace tests, dependency audit, reliability ledger, and 95 Playwright E2E tests passed.
  - Final summary included `OVERALL: GREEN - repository release gates passed`.
- `npm run test:production-check`
  - Passed on 2026-07-09 with 338/338 production-tooling checks passing.
  - Covers production validators, launch evidence validation, provider checker contracts, deployment tooling, backup/restore tooling, and CI/release workflow guards.
  - Historical count; the 2026-07-11 local production-tooling gate passed 746
    checks with 0 failures and 2 Windows-only symbolic-link privilege skips
    (748 total).
- `npm run lint -w @charitypilot/web`
  - Passed after the shared blog empty-state and compliance save-status primitive cleanup.
- `npm run build -w @charitypilot/web`
  - Passed after the same shared-state cleanup.
- `npm run test:production-check`
  - Passed again with 338/338 production-tooling checks after launch-evidence, release-ready, continuation-doc, and GitHub secret-store checker hardening.
  - Historical count; the 2026-07-11 local production-tooling gate passed 746
    checks with 0 failures and 2 Windows-only symbolic-link privilege skips
    (748 total).
- Focused launch-evidence tests
  - Passed after the evidence hardening updates.
- Web wiring tests
  - Passed after the pricing/icon polish.
- `npm run audit:platform`
  - Passed.
- `npm run launch:status -- --json`
  - Passed and still reports the real blockers.

Important limitation:

Local/repo checks do not prove production launch readiness. They must be rerun against the final production config and live HTTPS deployment.

## What Is Left To Do

### External Launch Blockers

These require human/operator/provider access and must not be faked:

1. Fill real production secrets/provider values in `.env.production` or an approved secret store.
2. Configure production hosting, DNS, TLS, reverse proxy, and public HTTPS smoke evidence.
3. Prove PostgreSQL production backup and restore before real charity data.
4. Prove Supabase production private bucket, authenticated service-role read/anonymous-denial behavior, backup, and restore.
5. Configure Stripe live products/prices/webhook.
6. Configure Resend sender domain and live email evidence.
7. Configure observability:
   - logs;
   - uptime checks;
   - readiness checks;
   - alert routing;
   - incident owner;
   - backup owner;
   - escalation path;
   - test alert.
8. Complete solicitor/governance/privacy review.
9. Complete external penetration test.
10. Remediate or formally accept pentest findings.
11. Complete deployed browser QA and accessibility checks.
12. Complete all 89 machine-readable launch evidence checks.
13. Complete final engineering, operations, security, legal/compliance, and business signoffs.

### Launch Evidence Still Open

The evidence ledger is currently `9 / 89`. Those completed checks are local/CI
release-gate basics only; they do not replace real production env validation,
digest-pinned deployment, public HTTPS smoke, rollback, provider, backup/restore,
deployed browser QA, legal, pentest, or final signoff evidence.

The first incomplete evidence checks currently reported by
`npm run launch:status -- --json` are:

- `releaseGate.check-production`
- `releaseGate.github-environment`
- `releaseGate.github-secret-store`
- `releaseGate.deploy-preflight`
- `releaseGate.deploy-production`
- `releaseGate.deploy-smoke`

Do not fill these with local or fake evidence. They need final real production
configuration, GitHub production environment, digest-pinned deployment, and
public HTTPS smoke evidence tied to the promoted release. Re-run launch status
before acting; this ordered list changes as evidence is completed.

### Deployed Browser QA Still Open

Local browser/accessibility checks have been run previously, but deployed production QA remains open.

Required deployed QA must cover:

- public/auth routes;
- dashboard routes;
- desktop;
- mobile;
- light mode;
- dark mode;
- auth flow;
- dashboard flow;
- billing flow;
- document upload;
- authenticated API download without a provider URL or object path;
- logout;
- error states;
- accessibility;
- cross-browser;
- real iOS Safari or cloud-device iOS Safari.

### Legal/Compliance Still Open

The product is review-ready but not legally signed off.

Still required:

- production privacy policy approval;
- terms/service agreement approval;
- retention policy approval;
- support/data deletion contact publication;
- named solicitor review;
- named governance review;
- named privacy review;
- review dates and evidence references outside git.

## Recommended Next Agent Workflow

1. Confirm the baseline:

```powershell
git status --short --branch
git log --oneline -5
npm run launch:status -- --json
```

2. If no real production/provider access is available, continue repo-side closure only:

- search for stale command drift;
- tighten validators;
- improve launch evidence clarity;
- strengthen runbooks;
- run focused tests;
- commit and push.

3. If production/provider access is available, work through this order:

```powershell
npm run check:production -- --production-env-file=.env.production
npm run check:production:github-env -- --environment=production
npm run check:production:github-secrets -- --environment=production
npm run check:production:hosting -- --production-env-file=.env.production
npm run check:production:database -- --production-env-file=.env.production --capture-source-identity --json --expected-release-commit-sha=PROMOTED_RELEASE_COMMIT_SHA
npm run check:production:database -- --production-env-file=.env.production --recovery-set-id=RECOVERY_SET_ID --expected-source-database-identity-sha256=EXTERNAL_SHA256 --expected-release-commit-sha=PROMOTED_RELEASE_COMMIT_SHA --backup-output-dir=/mnt/encrypted/charitypilot/recovery/RECOVERY_SET_ID --keep-backup --json
npm run check:production:supabase -- --production-env-file=.env.production
npm run check:production:providers -- --production-env-file=.env.production
npm run check:production:observability -- --production-env-file=.env.production
npm run deploy:preflight -- --production-env-file=.env.production
npm run deploy:production -- --production-env-file=.env.production --backup-output-dir=/secure/charitypilot/cutovers
npm run deploy:rollback -- --production-env-file=.env.production --rollback-digest-file=release-image-digests.previous.env --schema-compatibility-attestation-file=/secure/schema-compatibility-attestation.json --backup-output-dir=/secure/charitypilot/rollback-cutovers
npm run check:production:evidence -- --evidence-file=.charitypilot-launch-evidence/production-launch-evidence.json
```

4. For deployed browser QA, use the commands and evidence slots in:

- `docs/production-browser-qa.md`
- `docs/production-launch-checklist.md`
- `.charitypilot-launch-evidence/production-launch-evidence.json`

5. Commit only repo changes. Do not commit:

- `.env.production`;
- real secrets;
- production launch evidence JSON;
- screenshots with sensitive data;
- pentest reports;
- legal review reports;
- provider credentials;
- backup dumps.

## Percentage Remaining

Strict launch evidence metric:

- `80 / 89` machine-readable launch checks remain.
- Strict counted launch gates are `18 / 121` complete, so `103 / 121`
  counted gates remain. This is an operator progress metric only, not a legal,
  security, operations, or business readiness certification.
- Strict launch evidence is still mostly incomplete because the remaining checks
  include the real production environment, deploy, rollback, provider,
  backup/restore, deployed QA, legal, pentest, and final signoff gates.
- Final signoffs remain `0 / 5`.
- Production values remain `9 / 27` complete, with 18 real provider/hosting/image-promotion values still missing.

Whole-goal estimate:

- Repo-side engineering and UI polish are substantially advanced.
- Actual production launch readiness is still dominated by external provider setup, deployed evidence, legal/privacy/governance review, external security review, backup/restore proof, and final signoffs.
- Evidence-based estimate: about 65-70% of the overall production-completion goal remains, even though the codebase itself is much further along.

Repo-side-only estimate:

- About 10-15% remains, mostly defects that may be discovered by live QA, security review, or production provider checks.

## Final Rule For Future Agents

Do not redefine success around passing local tests. CharityPilot is not launch-ready until the real production environment, live providers, deployed QA, legal/compliance review, external security review, backup/restore evidence, all 89 launch evidence checks, and all five final signoffs are complete and recorded.

### Latest source verification: recovery append optimization

The opt-in prefix optimization passed 2,469 API tests and four real PostgreSQL
migration tests locally. Its rollback regression refuses shortened known history
before a replacement write. It remains inactive and requires independent immutable
entry custody before use. Hosted CI 36744603266 and E2E 36744603344 passed for
preceding f94b03ffc5d66f910fefc4a7ad9f7fe600da355b only; do not attribute those runs
to the later optimization. The live release remains the documented d31ac597.

### Complaint recovery preparation format under development

An inactive candidate serializer now enumerates complaint disposal preparation
facts, including distinct original-removal and later-disposal policy/resolution
dependencies. It refuses unknown fields, foreign/mismatched dependencies and
conflicting facts under one identity. Six focused tests and the API build pass.
It neither persists nor encrypts data, proves freshness, reserves a writer epoch,
nor authorizes a claim. Reason/actor retention still needs the prepared policy
decision before live export. Durable preparation, reservation, database guards,
full decision history and reconciliation integration remain required. This is
not a deployed recovery feature or independent authority acceptance.

The complaint preparation format now also passes source-driven checks against
actual records created by the isolated PostgreSQL migration fixture: timed
retention and later-policy disposal with a released hold. The fixture imports the
TypeScript source in a separate process and explicitly excludes complaint subject
fields. Seven focused tests and the API build pass. A regression corrects handling
of withdrawn resolution evidence under REVIEW_REQUIRED; it remains ineligible as
an AFTER_ANCHOR starting date. These are synthetic local checks, not live policy,
provider, persistence, fencing or full-recovery acceptance.

### Durable complaint preparation storage under verification

A new inactive ComplaintRecoveryPreparation table and internal store preserve
validated candidate facts under a unique charity/operation identity. The table
checks bound identity/digest and active Owner/unclaimed review, rejects update or
delete, and dispatches no work. The store checks active Owner even on exact retries
and refuses changed bytes. Preparations are now included in restore comparisons
and disposable-test reset inventory. The isolated PostgreSQL fixture proves
current-backup preservation and missing-history refusal for an older backup,
plus insert/digest/role/immutability guards. Eight focused tests, six restore
comparison tests and API compilation pass. The broader API suite is still running.
These local database facts are plaintext like their source rows, not external
replay envelopes. No route, claim or worker calls this store. Capture freshness,
external encryption/custody, durable reservation, execution guards and approved
field retention are still required before live use. No migration was deployed.

The durable preparation storage verification has now completed: 2,477 API tests,
four real PostgreSQL migration tests and 88 inventory/reset/backup tests passed.
The lifecycle model map now explicitly includes the preparation and its unresolved
retention boundary. Earlier running-suite notes are superseded by these local
results. Fresh capture, external encryption/reservation and claim guards remain
unfinished; no production migration or activation has occurred.

### Fresh complaint preparation capture implemented locally

The internal preparation store now captures explicitly selected complaint decision
rows and persists them in one ReadCommitted transaction with charity/Owner and primary-record locks.
It refuses withdrawn/claimed reviews and changed or ambiguous current policies.
Retries validate the existing exact binding/digest and return original preparation;
they do not silently recapture newer facts. The public raw-facts persistence method
was removed. Nine focused tests and API compilation pass. These new capture tests
use a transaction double; prior real PostgreSQL proofs cover the format/storage
migration, not the newly added Prisma capture path or its concurrency schedules.
Actual Prisma/PostgreSQL capture and race acceptance remain required. No route,
claim or worker uses this store; external epoch reservation/encryption and live
field-purpose approval remain open.

Real Prisma/PostgreSQL verification reproduced a stale-snapshot race in the prior
Serializable capture: a holder committed preservation while capture waited, yet
capture could retain its earlier snapshot. This was local, inactive code. Capture
now takes the shared charity lock before reading under ReadCommitted, and locks
the primary complaint row explicitly. The integration fixture verifies actual lock
contention, not timing alone. The fixture database has a dynamically allocated
loopback-only port so the real Prisma client can connect; endpoint and binding are
checked and all records are synthetic. This does not alter personal-server ports.
The prior mocked-only capture statement is historical; the corrected PostgreSQL
run is being verified separately. External fencing and live activation remain open.

The corrected full PostgreSQL fixture completed successfully in 72.8 seconds,
including real Prisma capture/reconnect and the preservation race. The race
assertion failed before the isolation/locking correction and now passes. API build
and nine focused tests also passed. This supersedes the running-proof note above;
it does not establish independent host fencing or authorize deployment/erasure.

### Candidate encrypted preparation envelope, inactive

A bounded seal/open module now binds complaint preparation bytes to installation,
charity, operation, epoch, source and wrapping-key identity using the existing
AES-256-GCM primitive in a separate recovery domain. A trusted data-key provider
interface is supplied; no live KMS adapter/key or credentials exist. Build and 38
focused preparation/envelope/crypto tests pass. Caller-owned returned key buffers
are cleared best-effort; runtime/native copies are not claimed erased. Original
envelope persistence and exact retry reconciliation remain required because fresh
encryption changes bytes. No journal publication or production caller uses this
module. Provider deadlines/custody, field-retention approval, execution fencing and
recovery acceptance remain open.

### Immutable candidate-envelope retry path, under verification

Envelope preservation now rereads the winning create-only object and returns its
actual digest; existing envelopes must decrypt to the exact original candidate
facts. Lost acknowledgement retries do not reseal. A separately enabled S3 replay
namespace has a 64KiB budget and distinct same-account replay key identity. Intent
and head limits remain4KiB. Nine focused envelope/storage tests pass, including
mock SDK round-trip; the complete API suite is still running. No live provider,
policy approval, journal publication or execution fence is supplied by this slice.

Envelope preservation passed the full local API run (2,487 tests and four real
PostgreSQL migration tests). Subsequent review added canonical envelope JSON
validation and refusal of late missing-object/precondition responses after S3
operation expiry. The latter has a reproduced red regression. These final guards
have separate focused verification; do not attribute them to the preceding full
suite. No external key provider, live storage policy or execution fencing exists.

Final envelope build and 57 focused preparation/crypto/S3 tests passed, including
both later review guards. This is local evidence only. The original ciphertext
preservation helper and replay namespace remain inactive and non-authorizing.

### Bounded KMS data-key adapter implemented locally

Source now includes an explicit-credential Ireland KMS adapter for fresh AES-256
data keys and exact-key/context unwrap. It bounds calls, rejects wrong identity,
algorithm or size, hides provider error details, and clears transferred plaintext
buffers best-effort, including late responses after timeout. API compilation and
15 focused KMS/envelope tests pass; SDK request signing/serialization uses an
isolated handler. No actual AWS request, key creation or production wiring occurred.
Live permissions/custody and full recovery execution fencing remain unverified.

Combined KMS/S3 adapter recreation now has executable synthetic proof: after lost
write acknowledgement, newly constructed adapters recover the original ciphertext
and digest without generating another key; unavailable key access refuses and
leaves the object unchanged. Build and16 combined/provider/envelope tests pass.
Backing provider state is synthetic, so this does not prove live AWS custody or
VM-loss recovery. Hosted CI36749194751/E2E36749194762 passed for cb6b31b7's earlier
capture repair; they do not verify the newer KMS/envelope changes. No deployment.

## Verified preparation publication integration — local, 30 September 2026

Added publish-verified-complaint-preparation.ts. It validates exact reservation and envelope context, reads existing immutable candidate bytes without a creation fallback, authenticates/decrypts them, compares the canonical facts SHA-256 with the reservation, rechecks the entire control and revision after decryption, then invokes reserved journal publication with the ciphertext digest. Exact retries retain the original journal binding; missing published bytes are not regenerated. It returns no execution authority.

API TypeScript build and four focused publication tests passed, including real encryption/decryption, missing and corrupt bytes, different reserved facts, control changes during decryption, retry retention and the existing lost-publication-acknowledgement case. This addition is local only; live release remains 6afddb4f. No production caller/provider is activated. Remaining: immutable outcome/release protocol, database guards covering all writers, independent provider/custody activation and full host-loss acceptance. See source tests publish-verified-complaint-preparation.test.ts and reserved-recovery-publication.test.ts.

## Transaction-bound complaint outcome — local implementation

Added additive ComplaintRecoveryOutcome migration/schema. An outcome references one unique original preparation and one unique primary claim. The database checks charity, authority, actor and complaint identity, requires the claim transactionId to equal the current transaction, and refuses an outcome while the primary complaint still exists. Transaction/time fields are assigned by the database; UPDATE/DELETE are refused. No ABORTED state or release API is introduced, and the current live claim path is unchanged. This is incomplete inactive integration, not a required execution fence yet.

Prisma generation/build and the focused real PostgreSQL migration test passed. Negative tests cover foreign charity, authority, actor, record, old transactions, surviving primary data, rollback and append-only protection. Restore reconciliation now includes outcome rows, and all six reconciliation tests pass. Full production-migration complaint proof is running in session 91794, log complaint-outcome-migration-proof.log; it now places outcome insertion inside both rollback and competing real claim transactions. No live database or provider was touched.

Earlier commit 64c3295973dfb007b16a6a44655816c4e76bd231 has hosted CI 36759817976 and E2E 36759818106 in progress. Live remains 6afddb4f. Remaining: durable publication receipt and execution state/guards, outcome envelope/publication and exact reservation release, complete writer coverage, independent custody/activation, and server-loss acceptance.

Outcome verification completed: session 69465 exited 0. Full main API suite 2511/2511 and all five separate PostgreSQL checks passed without failures or skips. Production-migration complaint proof and six restore reconciliation tests also passed. Review confirms append-only unique outcome/preparation/claim binding, database-set time/transaction, same-transaction claim enforcement, primary absence, transaction rollback, and explicit restore/reset inventory coverage. The outcome table alone does not require claims to use recovery authority; activation remains forbidden until every execution and dependency writer is guarded.

## Committed outcome evidence reader — verified locally

readCommittedComplaintOutcome now reads a committed outcome through the ordinary Prisma client, validates the original canonical preparation and SHA-256, cross-checks claim/charity/actor/authority/transaction identity, bounds output identifiers, and serializes the bigint transaction identifier without precision loss. Output includes preparationSourceRevision explicitly; it does not claim the preparation release was the claim's execution release. No reason text or disposition plan is emitted. The reader is internal, inactive and returns actionAuthorized=false.

API build and 14 related tests passed; the final field-name assertion also passed from TypeScript source. The full production-migration complaint proof passed in 84 seconds, including the actual Prisma reader, reconnect stability and foreign-charity refusal. Evidence: complaint-outcome-reader-proof.log; session93253 exited0. This is not independently trusted recovery history, outcome publication, execution fencing, reservation release or permission to reopen. Hosted checks and deployment remain separate.

## Encrypted complaint outcome candidate — local implementation

Added strict canonical COMPLAINT_PRIMARY_PURGE_COMMITTED facts and a distinct COMPLAINT_RECOVERY_OUTCOME encrypted envelope. The outcome uses its own authenticated encryption context and outcomes/<installation>/<charity>/<operation>.json namespace; it cannot replace or be read as a preparation. The S3 adapter preserves expected account/key/version checks, bounded reads and create-if-absent writes. Retry opens the original stored bytes and rejects changed facts. A separate verified reader requires a digest from independently verified history and never recreates missing published bytes. Keys are cleared after use; no reason/subject fields are accepted in the typed outcome.

Initial build and 14 related tests passed. Full main API phase2515/2515 passed with zero failures/skips. Final separate PostgreSQL phase remains running in session15726; evidence outcome-envelope-api-suite.log. SDK transport tests are synthetic, not actual AWS custody/acceptance. No live resources or caller are activated; outcome journal publication, reservation release and database execution guards remain incomplete.

Hosted CI36760462585 at38e31416 failed its source inventory check because ComplaintRecoveryOutcome was omitted from docs/architecture/data-lifecycle-model-map.md. Corrected with purpose/retention/recovery qualifications in d2da0fbb and pushed; the exact inventory test passes locally. This does not retroactively turn the failed hosted run green. Follow-up exact hosted checks remain required. Live remains6afddb4f.

Encrypted outcome verification completed: session15726 exited0. Main API2515/2515 and all five separate PostgreSQL checks passed without failures/skips. Review confirmed distinct storage namespace/authenticated kind, canonical typed facts, bound account/key/context, conditional creation, original-byte retry, missing-byte refusal and key clearing. No independent provider, outcome journal publication or execution permission is activated.

## Reserved outcome publication — local integration

Encrypted outcome storage committed/pushed cab759d7 after main API2515/2515 and PostgreSQL5/5 passed. New local journal kind COMPLAINT_OUTCOME_V1 permits exactly one outcome immediately following its same-operation COMPLAINT_PREPARATION_V1 entry; all other duplicate operation uses remain invalid. Older readers reject the new kind. Orphan/out-of-order outcomes are rejected before immutable writes. The reserved method verifies the exact published preparation generation, entry digest and envelope digest, retaining the same writer/epoch/operation/facts reservation through every read/CAS.

publishVerifiedComplaintOutcome authenticates both stored envelopes, verifies the preparation facts digest and matching complaint/authority/actor, checks unchanged control across decryption, and invokes exact reserved publication. No creation fallback, release or execution permission. Both immutable-entry and control-head acknowledgement losses resume the original operation and bytes. Build and38 focused journal/publication tests passed. Full API suite runs in session available from the current tool receipt; log reserved-outcome-publication-api-suite.log. No live activation/deployment of this work.

Remaining: outcome read/recovery integration, durable local execution state and guards, exact release tied to terminal execution, complete writer coverage, independent custody/provider acceptance, old-host isolation and VM-loss acceptance. Original role/file/report/policy/replay/C1/DPO acceptance scope remains open.

## Published outcome evidence reader and final verification

readPublishedComplaintOutcome verifies both journal entries against full current history, requires their adjacent predecessor relationship and same observed head revision, opens both ciphertexts at the independently published digests, checks the exact preparation facts/complaint/authority/actor relationship, and rechecks the head after decryption. Missing bytes and changed head refuse. The returned evidence still has actionAuthorized=false; it does not apply recovery, authorize execution or release the reservation.

Full publication regression suite completed in session51976 with no failures/skips, including all five PostgreSQL checks (reserved-outcome-publication-api-suite.log). The reader was added after that full-suite compile: final build and all38 combined journal/publication/reader tests passed in session64135 (published-outcome-final-tests.log), including lost entry/head acknowledgements, original ciphertext retention, wrong complaint, missing preparation and head-change refusal. No local verification handles remain active for this slice. Hosted gates/deployment remain pending.

The earlier58bf89d0 hosted CI failure was confirmed as the same lifecycle-map omission already corrected by d2da0fbb; it is not a different unexplained failure. Independent outcome publication remains inactive without a real provider. Next required integration is exact reservation release tied to terminal execution, local database guards for every dependent writer, activation/rollback, separate custody and old-host isolation/VM-loss acceptance. Original Nikita acceptance requirements remain intact.

## Committed complaint reservation release — local inactive integration

releaseCommittedComplaintOperation reads the actual committed outcome with an ordinary Prisma client and requires byte-for-byte equality with independently verified published evidence. The current writer/epoch, exact operation/preparation digest, latest outcome head and control revision must remain bound. Only then does the explicit provider release clear the slot. A null-slot retry still verifies the exact latest outcome and local result; absence alone never means success. Another active operation, stale writer, changed head or mismatched local result refuses. Lost acknowledgement remains unknown until exact retry verification.

The S3 release adapter validates the exact latest COMPLAINT_OUTCOME_V1 entry's structure/hash and binding, then conditionally clears only the active operation on the same head.json using its original ETag. Generic compareAndSwapControl still refuses clearing. Source-level provider checks are not full-chain/decryption/commit proof; the service supplies those additional gates. No timeout, abandoned-operation cancellation, force-unlock or writer takeover exists. Existing primary-claim uniqueness and append-only guards supply the terminal primary claim; other action classes and all-writer execution fencing remain unfinished.

Initial build and integrated release tests passed, as did a focused synthetic S3 release test. Additional mismatch/new-operation and concurrent-writer races were added for the full run, active session22342, log committed-release-api-suite.log. Do not start another run while live. No production caller, real provider or deployment is activated. Current live remains6afddb4f; exact634e4240 hosted CI36762012579 and E2E36762012425 were still running at latest check.

Committed-release verification finished: main API2519/2519 and separate PostgreSQL5/5 passed with zero failures/skips (committed-release-api-suite.log). Final focused checks also passed for differing local claim evidence, retry after a later operation acquires the slot, and an S3 writer change between outcome read and conditional clear. Review confirms release preserves writer/epoch/journal generation/digest, requires full independent pair/payload verification plus exact local commit, and returns no execution/reopen permission. This is inactive complaint-primary release support, not all-writer fencing or full recovery readiness.

Hosted E2E36759818106 at64c32959 and E2E36760462540 at38e31416 completed successfully; their exact receipts are retained privately. The latter commit's separate CI remains failed for the lifecycle map omission fixed later. Latest634e4240 hosted checks remain pending. No new live release.
