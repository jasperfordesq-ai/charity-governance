# Confluence documents without a Vault upload

Status: compatibility release deployed and verified, 19 October 2026.
Registration activation has passed focused local verification and is not yet
deployed. Do not report this requirement as complete.

## Required release sequence

The earlier reader expected every citation's Document ID to be non-null.
Registration therefore follows the verified compatibility release, preserving
a previous colour that can read the new source records and audit types.

1. Deploy the additive audit types, nullable/exclusive citation anchor, source
   identity and recovery guards, compatible readers/report parser and restricted
   inventory display. The source registration service is tested internally but
   has no HTTP creation route or registration form in this release. Verify that
   all existing citation Document IDs remain non-null before/after cutover.
2. After exact compatibility-release CI, browser and deployment proof, expose
   the registration route and form in a subsequent release. Its previous colour
   must be the compatible reader. Repeat the zero-upload browser journey on
   the final source. Never substitute the earlier prototype's browser result.

The compatibility stage is now verified. The activation source adds a separate
registration form with exact connected-site review, stable request identity on
unknown outcomes, version checking and explicitly local reference removal.
Owners can use the existing observation/report workflow for a source with no
uploaded file. A known refusal unlocks the form for review; an uncertain response
retains its original request for reconciliation. No migration, new storage
provider, disclosure grant or Confluence mutation is added by activation.

Focused local verification covers all four connector journeys with retries
disabled, including a committed registration whose response is lost, manual
original-request retry, page-review reset, zero file/upload/publication/deletion
rows, observation/report, local unciting and historical receipt readback.
Responsive bounds, light/dark screenshots and the new form's accessibility scan
are included. The scan caught and corrected dark help-text contrast; visual
review also removed an inapplicable file-lifecycle warning from source rows.
These local results do not replace the new exact-source CI and deployment gates.

Do not bypass a migration or rollback gate to collapse these steps. No new
provider or customer policy decision is needed for this engineering sequence.

## Requirement and audited baseline evidence

Selected documents may remain authoritative in Confluence. CharityPilot must
be able to register and monitor their page/version references without requiring
an uploaded file as the starting point. Existing citations attached to Vault
files remain useful and must continue working.

At the audited `449606fd` baseline, the implementation did not provide that
independent starting point:

- `Document` requires `fileUrl`, `fileSize` and `mimeType`; its supported create
  service attaches a reserved upload intent and records an upload audit.
- `ConfluenceReference.documentId` is required, with a composite foreign key to
  a Document in the same organisation.
- `citeConfluencePage` refuses a missing live Document before reading the page.
- The reference POST requires a Document ID. The web citation panel opens from
  a Vault document row.
- Version checking, page observation and review recording also require the live
  Document anchor. Making the foreign key nullable alone would not fix them.

This is not evidence that each existing citation duplicates its cited page: a
Vault file can legitimately cite different supporting material. It establishes
the narrower missing capability: registering a selected Confluence document
when no uploaded Vault file exists.

## Product decisions

1. Provide a restricted administrative register for selected Confluence
   documents, using the existing opt-in connection. Do not download or persist
   page bodies or attachments to create a register entry.
2. Retain tenant, recorded site, page, observed version, title, actor and time.
   A page version is a historical citation, not a mutable current-version field.
3. Reuse citation observations, staleness and saved review semantics. Do not
   introduce an unrelated provider client or a second erasure executor.
4. Model an explicit non-file anchor rather than a fake storage URL, zero-byte
   upload or an invented storage provider. Preserve the existing file anchor
   and its guards. Enforce exactly one valid same-tenant anchor in PostgreSQL.
5. Keep new entries Owner/Admin only initially. Existing byte-reviewed Member
   file permissions do not authorise external-page disclosure or prove the
   Member has permission in Confluence.
6. Removing a reference changes local governance metadata only. It never
   deletes the provider page, creates a disposal instruction, revokes upstream
   access or asserts permanent erasure. Audit and saved reports survive.
7. Preserve independent-recovery enforcement. A bound organisation must refuse
   new unjournalled mutations, including direct SQL writes. Do not weaken the
   existing freeze merely to make the new register operable.

## Implementation order

1. Extend the anchor model with a forward migration, tenant constraints and
   recovery guards. Preserve all existing rows and historical report digests.
   Include any new durable tables in recovery capture/inventory; an incomplete
   backup is not an acceptable temporary implementation.
2. Add the authenticated creation/list/removal service and routes with bounded
   pagination, expected-site confirmation and commit-time actor/anchor checks.
   Provider reads must complete before recording a successful citation; site
   and connection changes must refuse or return explicit uncertainty.
3. Adapt check/observation/report paths for both valid anchor types, keeping
   existing saved report formats readable. Use meaningful audit identities for
   non-file anchors, not Document IDs invented for audit compatibility.
4. Add the administrative register UI with a clear external-source label,
   exact connected-site review and no file-upload prerequisite.
5. Verify the complete synthetic journey and exact release. Existing sandbox
   page contents need no mutation for registration and observation tests.

## Acceptance evidence

- Start with a synthetic tenant containing zero Document rows. Register an
  accessible page through the UI, observe version changes, save/read a review,
  then remove its local reference. Document, upload-intent, publication and
  deletion-job counts remain zero; no storage write or provider mutation occurs.
- Preserve the cited version while reporting a newer upstream version. Refuse
  unreadable/wrong-site pages; report revoked access as uncertainty, not erasure.
- Other tenants and Members cannot create, list, observe, review or remove the
  restricted source. Direct SQL cannot cross tenants, omit/bind both anchors,
  mutate protected history or bypass recovery enforcement.
- In-flight connection changes, local removal and actor-role changes cannot
  create an accepted stale operation. Lost responses recover the original
  outcome without duplicate metadata or fabricated provider actions.
- Existing Vault citations, download access, recovery/deletion blockers and
  saved review receipts retain their behaviour.
- Capture and restore include the new metadata/audit state and preserve its
  relations. Local component tests alone do not establish host-loss recovery.

Run focused API tests with the repository API build and Node test runner, native
PostgreSQL migration/guard tests through the existing isolated harness, and the
repository's isolated browser runner for the end-to-end journey. Exact test file
and command additions belong with implementation; no passing result is asserted
by this specification.

## Scope boundaries

No new supplier, paid trial, production Confluence activation, hosting migration
or real document reclassification is required. Actual purge remains a separately
authorised action. This feature does not close independent host-loss recovery,
key custody, organisational OAuth continuity or customer retention decisions.
