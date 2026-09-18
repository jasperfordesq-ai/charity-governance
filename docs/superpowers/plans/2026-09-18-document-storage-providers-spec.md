# Document Storage Providers & Confluence Integration — Spec

Status: **accepted direction, not yet built.**
Date: 2026-09-18.
Author: drafted with Claude Opus 5 from a code audit plus research into the Atlassian platform.
Implementation plan for the first phase: `docs/superpowers/plans/2026-09-18-per-tenant-document-storage-phase-0.md`.

---

## Plain-English summary (read this first)

The DPO (Nikita Serkevich) asked whether CharityPilot can use Confluence as the
place where governance documents live, and whether documents can be uploaded to
Confluence from inside CharityPilot.

**The answer is yes, with one important change to the shape of the idea.**

CharityPilot is heading towards being a hosted service that many Irish charities
sign up to. Those charities' files must be stored in Ireland (or at minimum the
EU). We can guarantee that with Supabase, because we choose its region. We
**cannot** guarantee it with Confluence, because a Confluence site's region is
chosen by whoever owns that Atlassian site — the tenant, not us — and is not
configurable at all on Atlassian's Free plan.

So the design is:

- **Supabase (Ireland) stays the authoritative store.** Uploading through the
  CharityPilot portal always works, for every charity, with or without
  Atlassian. This never changes.
- **Confluence becomes an optional extra per charity** — a place we *also*
  publish documents to, carrying the approval metadata with them.
- **Confluence support ships as ALPHA** and stays alpha until it is fully built
  out. Alpha means a charity has to deliberately opt in, and it is never the
  default for anybody.

Nothing in this spec removes or weakens anything that works today.

---

## Non-negotiable constraints

These come from the owner and override design preference.

1. **Portal upload is guaranteed.** No integration may become the only way to
   get a document into CharityPilot. A charity with no Atlassian account must be
   completely unaffected.
2. **File storage must be Irish, or at minimum EU.** Tenants are Irish
   charities.
3. **Options must not collide.** Adding a provider must not change the
   behaviour of any existing provider, deployment, or tenant. Every change is
   additive.
4. **Confluence is ALPHA until fully built out.** It must be impossible to end
   up on it by accident.

---

## What the code looks like today

The audit found the codebase is already well shaped for this, with three gaps.

**The seam already exists.** `apps/api/src/services/storage.service.ts` exposes
a small surface — `uploadFile`, `downloadFile`, `deleteFile`, plus
`isConfigured` / `verifyBucket` for health checks. The upload route
(`apps/api/src/routes/documents/index.ts:175`) performs all validation — MIME
type, extension, magic-byte signature, the 10 MB cap, multipart limits — and
then makes a single provider-agnostic call:

```ts
const { storagePath } = await storageService.uploadFile(orgId, filename, buffer, mimetype);
```

There are already two storage drivers behind that call (`local` and Supabase),
selected by `DOCUMENT_STORAGE_DRIVER`.

**Gap 1 — the driver is global, not per-tenant.** `storage.service.ts:22` reads
`process.env.DOCUMENT_STORAGE_DRIVER` *inside each method*. One running process
therefore uses one storage backend for every organisation. Per-tenant choice is
impossible today. **This is the whole of Phase 0.**

**Gap 2 — there is no integration subsystem at all.** A repo-wide search found
no Confluence, no Atlassian, no OAuth credential model, no connector concept.
`Organisation` (`apps/api/prisma/schema.prisma:328`) has no integration config.
Critically, **there is no symmetric encryption anywhere in the codebase** — no
`createCipheriv`, no AES helper. Holding tenants' Atlassian refresh tokens
requires envelope encryption with key rotation, built from scratch. This is the
security-critical part of the work and must not be rushed.

**Gap 3 — deletion assumes we own the bytes.** The `DocumentStorageDeletion`
pipeline (retry, dead-letter, alerting, plus a `DocumentStorageDeletionRecovery`
ledger) exists because erasure has to be provable. Confluence changes those
semantics: deletes go to trash first and need a separate purge, and the tenant's
own admins can restore content we "deleted".

**One invariant that must never break.** Every storage path is
`{organisationId}/{timestamp}-{uuid}-{filename}`, and
`assertOrganisationStoragePath` (`storage.service.ts:107`) enforces the
organisation prefix on every read and delete. That is the tenant isolation
boundary. Any new provider must carry an equivalent guard.

---

## Research findings that shaped this

| Finding | Source |
|---|---|
| Supabase project region includes `eu-west-1` (Ireland); Storage objects live in the project's primary region | [Supabase regions](https://supabase.com/docs/guides/platform/regions) |
| Atlassian data residency is per-site, admin-configured, **Standard plan and above only**; EU covers Frankfurt and Dublin | [Atlassian data residency](https://support.atlassian.com/security-and-access-policies/docs/understand-data-residency/) |
| Confluence Free: 10 users, 2 GB, permissions not customisable, no audit log | [Atlassian support](https://support.atlassian.com/confluence-cloud/docs/learn-about-confluence-cloud-plans/) |
| Confluence Standard: 250 GB; Premium: unlimited | Atlassian plan documentation |
| Confluence REST **v2 cannot upload attachments** — the attachment endpoints are GET/DELETE only. Uploads require v1 `POST /rest/api/content/{id}/child/attachment` with `X-Atlassian-Token: nocheck` | [v2 attachment API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-attachment/) |
| Confluence content properties store up to 32 KB of app-owned JSON per page — ideal for approval metadata | [Confluence entity properties](https://developer.atlassian.com/cloud/confluence/confluence-entity-properties/) |
| Required OAuth granular scopes: `write:page:confluence`, `write:attachment:confluence` | [Confluence scopes](https://developer.atlassian.com/cloud/confluence/scopes-for-oauth-2-3LO-and-forge-apps/) |
| Forge SQL caps at 1 GiB per install, 200 tables, 5s read timeout, MySQL-compatible | [Forge SQL limits](https://developer.atlassian.com/platform/forge/limits-sql/) |
| Forge scheduled triggers support only `fiveMinute`/`hour`/`day`/`week` and may run twice | [Forge scheduled trigger](https://developer.atlassian.com/platform/forge/manifest-reference/modules/scheduled-trigger/) |

**Conclusion on hosting CharityPilot inside Atlassian:** rejected. CharityPilot
is 37 Prisma models over ~200 backend source files with append-only audit
history and 13 scheduled jobs, several built around not double-firing. A Forge
port is a rewrite of the data and scheduling layers onto a platform with a
storage ceiling. Forge Remote (a Forge UI calling our existing backend) remains
technically available later, but it does **not** remove hosting, so it does not
solve the concern that motivated the suggestion.

---

## The three modes, and which we build

| Mode | Where bytes live | Who controls residency | Decision |
|---|---|---|---|
| **A** — Confluence as a storage driver | Confluence only | The tenant | **Not built.** Breaks the residency guarantee. |
| **B** — Reference only; CharityPilot links to pages | Confluence only | The tenant | **Not built alone.** Same problem. |
| **C** — Supabase authoritative, Confluence mirror | Supabase (Ireland), plus a published copy | **We do, for the record copy** | **Build this.** |

**Mode C in one paragraph.** A document is uploaded through the portal and
stored in Supabase in Ireland — exactly as today. If, and only if, the charity
has opted into the alpha Confluence integration, a background job then publishes
a copy to their Confluence space as a page with the file attached, and stamps
the governance metadata (approving resolution, approval date, next review date,
linked standard) onto that page as a content property.

Nikita gets real Confluence pages with real version numbers carrying approval
evidence. We keep the authoritative copy, the provable erasure path, and the
Irish residency claim. A charity with no Atlassian is untouched.

**Modes A and B are not deleted from the design — they are deferred.** The
provider registry introduced in Phase 0 is what keeps them on the table: if we
later decide a particular tenant genuinely wants Confluence as their primary
store, that is a new registry entry, not a re-architecture.

---

## What ALPHA means, concretely

This is a mechanism, not a label in a README.

A storage provider or integration declares a **stage**: `ga` or `alpha`.

- A `ga` provider may be selected by any organisation.
- An `alpha` provider may be selected **only** by an organisation whose
  `documentStorageAlphaOptIn` flag is explicitly `true`.
- An `alpha` provider may **never** be the environment default. If
  `DOCUMENT_STORAGE_DRIVER` names an alpha provider, resolution fails loudly
  rather than silently promoting it.
- The stage is returned by the API so the web UI can badge it, and so support
  can tell at a glance what a tenant is running.

Confluence enters the registry as `alpha` and is promoted to `ga` only when
Phases 1–6 are complete, including provider-aware erasure.

---

## Phases

Phase 0 is the only phase with an implementation plan so far. It is deliberately
decoupled: it delivers value on its own and commits us to nothing about
Confluence.

**Phase 0 — per-tenant storage resolution.** *(planned — see the Phase 0 plan)*
Turn the global storage driver into a per-organisation choice, behind a provider
registry with the alpha gate. No Confluence code. No behaviour change for any
existing deployment. Also unblocks the long-standing multi-tenancy requirement
recorded in the deployment-mode notes.

**Phase 1 — integrations subsystem.** New `OrganisationIntegration` and
`IntegrationCredential` models. AES-256-GCM envelope encryption for OAuth tokens
with rotation, modelled on the existing `AuthRecoveryRetiredSecret` rotation
machinery. OAuth 2.0 3LO connect/callback routes and a token-refresh job.
*Security-critical; the slowest phase.*

**Phase 2 — Confluence client.** Hybrid v1/v2 client (v2 for pages, spaces,
versions and properties; v1 multipart for attachment upload). Reuse
`provider-errors.ts` and the `withOperationTimeout` pattern for rate limits and
retries.

**Phase 3 — document model.** Add `confluenceSpaceKey`, `confluencePageId`,
`confluenceVersion`, `confluenceAttachmentId` to `Document`. Decide explicitly
how the app-owned `version Int` reconciles with Confluence page versions so the
two cannot drift.

- **Stamp the storage provider on each `Document`.** Phase 0 records the
  provider on the *organisation*, so changing it strands every document already
  written: downloads and deletes would target the new provider while the bytes
  sit in the old one — silent 404s, and deletions reporting success against a
  store that never held the object, which breaks the provable-erasure guarantee
  the `DocumentStorageDeletion` pipeline exists to uphold. Each document must
  carry the provider it was actually written to, and read/delete must use that
  stamp rather than the organisation's current preference. Until this ships,
  changing `Organisation.documentStorageProvider` on an organisation that holds
  documents is not a supported operation.

**Phase 4 — publish pipeline.** A mirror job following the existing outbox
idiom. Copy the `DocumentStorageDeletion` dead-letter and recovery shape rather
than inventing a new reliability pattern.

**Phase 5 — provider-aware erasure.** Extend the deletion lifecycle to purge
from both stores, handling Confluence trash-then-purge. **Confluence cannot
leave alpha before this ships.**

**Phase 6 — admin UI and health.** Connect/disconnect screens in `apps/web`, and
per-tenant integration health that does not leak tenant data into the global
health endpoint.

---

## Open questions for the owner

1. **Does Nikita accept that Confluence is a published mirror, not the system of
   record?** If they expect Confluence to be authoritative, that is a real
   disagreement and it should be settled before Phase 1, not after. The
   residency argument is the reason to settle it in favour of Mode C.
2. **Do we require tenants to be on Confluence Standard or above** before we let
   them enable the integration, given Free has no residency control and no audit
   log? Recommendation: yes, and state it as a precondition.
3. **Which Supabase region is the production project pinned to today?** The
   Irish residency claim depends on it being `eu-west-1`, and it should be
   verified rather than assumed.
