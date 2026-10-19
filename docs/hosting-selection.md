# Hosting selection and compatibility gates

19 October 2026. Decision status: investigation order established; no procurement
or provider activation. The detailed cost model, dated unit prices, reserves and
private decisions are retained in the ignored continuation records.

## Decision method

Compare the complete application and independent recovery, using the same four
roles and capacity assumptions. Include primary database and file storage,
registry/builds, network, logs/alerts, email/DNS, independent decision witness,
retained recovery versions, keys, restore overlap and operator time. Show quoted
unit prices separately from planning reserves, tax, currency and initial
engineering work. A contingency is not an enforced spending cap.

Evaluate regional coverage independently for content, structured database,
attachments, credentials, logs, recovery copies and control/support access.
Neither EU compute nor Confluence residency proves the location of all processing.
Customer policy and actual supplier commitments remain separate decisions.

## Candidate order

**Capability verdict, later on 19 October:** DigitalOcean's
[documented administrator restriction](https://docs.digitalocean.com/support/how-do-i-fix-the-pg_dumpall-permission-denied-for-table-pg_authid-error/)
confirms that `doadmin` cannot access `pg_authid`. The current recovery code reads
password-null booleans and requires a privileged catalogue lock interval that
includes that table. The present implementation is therefore not ready for a
DigitalOcean paid trial. Its dump workaround does not solve these requirements.
Investigate a supported equivalent authority/capture strategy or another feasible
candidate before activation. Neither a password-reset endpoint nor a single
failed old-password login establishes the full recovery fence. The existing
fallback's hosted compatibility also remains unproved.

Investigate DigitalOcean App Platform with Managed PostgreSQL and private Spaces
as an alternative; keep the existing Render/Supabase prototype as a fallback.
This prioritises a capability review, not a paid trial. DigitalOcean documents
[private TCP ports and backend-only services](https://docs.digitalocean.com/products/app-platform/how-to/manage-internal-routing/)
and long-running worker components, making it worth checking against the actual
gateway/web/API/scheduler design. It is not an already supported deployment.

Scaleway's managed database is another candidate, but its database starting price
is not a whole-backend price. Check the scheduler and transport against its
[serverless limits](https://www.scaleway.com/en/docs/serverless-containers/reference-content/containers-limitations/)
before modelling that topology as equivalent. A Kubernetes alternative needs its
own operating and recovery model. A self-managed VM is an infrastructure cost
comparison, with OS/database/incident work still assigned to an operator.

## Hard feasibility gates before activation

Production startup and cleanup now refuse an explicit unsupported
`DOCUMENT_STORAGE_DRIVER`, and deployment preflight applies the same refusal.
Use the exact supported identifier: misspellings, case changes and unimplemented
names such as `s3` or `spaces` must not silently select Supabase. Omitted or empty
values retain the existing deployment default. Existing local storage remains
limited to its supported profiles. This guard neither adds an alternative store
nor migrates existing bytes; record-specific read/delete provenance is unchanged.

1. **Database authority.** Prove supported maintenance ownership and catalogue
   visibility, exact role/OID inventory, writer closure, old-session draining and
   credential invalidation. DigitalOcean documents
   [no superuser access](https://docs.digitalocean.com/products/databases/postgresql/details/limits/).
   Our current password-invalidation proof requires non-secret booleans from
   `pg_authid`. Missing access is a concrete compatibility question. Resolve a
   supported equivalent or reject the candidate; do not silently drop the proof
   or elevate application credentials.
2. **Transport and secret custody.** Demonstrate private TCP mutual TLS, fixed
   startup commands, exact identities, image pins and protected secret-file
   delivery. The current shared managed mesh accepts Render identities only.
   Any alternative needs its own validated contract, preserving the same security
   properties; a generic hostname or environment override is insufficient.
3. **File lifecycle.** The strict production storage implementation currently
   expects Supabase. An alternative needs an accepted adapter with per-record
   provenance, tenant isolation, authenticated download, version inventory,
   retention/holds, deletion and recovery proof. Preserve the production guard.
4. **Complete control-plane inventory.** Establish every service, job, deployment,
   administrator and writer, including queued or automatic actions. A component
   pause is not whole-backend quiescence or a provider/account outage drill.
5. **Independent recovery.** Separate administrative and failure domains for
   decision history, original acknowledgements, keys and usable recovery sets.
   Prove post-backup preservation/disposal decisions survive host loss and block
   stale reopening. Same-provider PITR is insufficient. DigitalOcean explicitly
   notes that [destroying a cluster also destroys its backups](https://docs.digitalocean.com/products/databases/postgresql/how-to/restore-from-backups/).
6. **Operational and commercial evidence.** Verify actual region coverage,
   subprocessors, support access, account recovery, current checkout costs,
   capacity and restore targets. Obtain specific required spend/terms/access
   authority only for a concrete feasible activation plan.

Do not widen the public-production or private personal-server profiles to make a
candidate appear compatible. Do not add a second provider executor before its
hard capabilities are established. Provider account access remains irrelevant to
unrelated Confluence acceptance work. No real Governance Hub data is part of a
synthetic compatibility exercise.
