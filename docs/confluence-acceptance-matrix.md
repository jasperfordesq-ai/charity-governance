# Confluence acceptance and data-flow matrix

Current continuation baseline: 19 October 2026. This maps the selected-document
architecture to implementation and the evidence still required. A source path or
a passing fake-provider test does not establish live provider acceptance.
Private dated execution receipts belong in the ignored continuation handoff.

## Ownership and data flows

| Data / operation | Authority and implementation | Acceptance evidence required |
| --- | --- | --- |
| Selected existing pages | Confluence owns document content. `confluence-reference.service.ts` records a checked site/page/version citation; removal only uncites. | Cite an authorised synthetic page, edit it upstream, show staleness without silently replacing the cited version, then uncite and verify the page is unchanged. |
| Structured governance | CharityPilot owns roles, approvals, deadlines, audit history and approved snapshots. Confluence properties are integration metadata. | Application role/tenant denial plus authorised control; immutable historical snapshot despite subsequent upstream edits. |
| Deliberately published copies | Separate from references: `document-publication.service.ts`, `confluence-publish-target.service.ts`, publishing and reconciliation services. Destination review precedes approval. | Exact site/space/source/destination approval; changed destination refuses; original operation identities reconcile unknown responses without duplicate writes. |
| Page and attachment identity | `confluence-retained-copy-source.ts` and `confluence-retained-copy-inventory.ts` recheck local bytes, connection generation, page versions and bounded attachment version bytes. | Exact inventory, repeated-current checks, changed/missing version and incomplete inventory refusal; live attachment readback remains a separate gate. |
| Retained primary / copy disposal | Review, maintenance synthetic scope, Owner permission and execution authority are distinct (`confluence-retained-copy-*.ts`, execution journal/ledger). | Positive browser permission/withdrawal and missing-scope refusal; current holds/source/authority checked again at execution; independently durable outcomes and original acknowledgements. Permission alone never proves disposal. |
| Ordinary removal | Reference removal leaves the source unchanged. Local Vault removal must not imply remote erasure. | Before/after identities and current upstream readback, retained audit and correct UI wording. |
| Trash / permanent erasure | `confluence-erasure.ts` and erasure request service distinguish recoverable Trash from purge. | Authorised exact synthetic target, Trash status, permanent action or explicit administrator action, final verified outcome and provider limitations. A 404 alone is insufficient without authenticated access controls and target evidence. |
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
