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

> **Blocked, and do not design it blind.** Two things gate it. It needs the
> Atlassian MCP app installed on the site before anything can be verified
> against a real space, and it needs Open Question 1 above ruled on, because
> that decides whether it is publishing a *mirror* or moving the authoritative
> copy. Those are different pipelines, not the same pipeline with a flag.
>
> **Four things Phases 3 and 5 learned that this phase must not rediscover:**
>
> 1. **A retried page create duplicates a governance document.** Phase 3's retry
>    policy is deliberately asymmetric and `createPage` is marked
>    non-idempotent. Preserve that. A charity's board resolution appearing twice,
>    with nothing saying which is real, is the worst outcome available here.
> 2. **Erasure dictates the target shape, not publish.** Phase 5 defines
>    `ConfluenceErasureTarget` — `{ kind, cloudId, pageId, attachmentIds }` — and
>    this phase must write a `targetRef` matching it. `cloudId` is stored rather
>    than resolved from the live connection, because a charity may disconnect,
>    reconnect to a *different* site, and still be owed erasure from the first.
>    Letting publish define the record and making erasure chase it is how
>    unerasable data gets created.
> 3. **`updatePage` cannot tell a stale version from a duplicate title.** Both
>    surface as 409 and the client deliberately surfaces no response body, so the
>    error names both causes without asserting either. If this pipeline needs to
>    distinguish them — it will, if it ever renames a page — the honest route is
>    a caller-side re-read comparing the title. The other route is a narrow
>    carve-out in the containment rule that stops raw upstream bodies reaching
>    logs, and that rule exists because a proxy once put a live authorization
>    code in an error body. Do not conflate the two: one costs a round trip, the
>    other costs a security guard.
> 4. **Approval metadata stays in CharityPilot.** Per the DPO's sign-off,
>    Confluence content properties are indexing and integration metadata only.
>    The definitive record of what a Board approved does not live in a page
>    property.
> 5. **The erasure proof currently covers the page only — close this here.**
>    Phase 5's eraser deletes and purges exactly the attachments named on the
>    deletion row, then proves erasure by reading the page back and requiring a
>    404. An attachment the row does not name is never enumerated
>    (`listAttachments` is deliberately unused) and the row still records
>    `PROCESSED`. So the proof is only as complete as the list this phase writes.
>
>    Phase 5 left this open on purpose, because closing it means enumerating
>    attachments from Confluence rather than trusting the row — and whether that
>    is right depends on a question only Phase 4 can answer: **is the page
>    exclusively CharityPilot's?** If it is, enumerate and erase everything on it,
>    since purging the page destroys them regardless. If a charity's staff may
>    attach their own files to it, enumerating and purging would destroy data
>    CharityPilot never put there — a different and worse harm than the gap it
>    closes.
>
>    Decide it when the authority question in Open Question 1 is ruled on, and
>    write the answer here.

**Phase 5 — provider-aware erasure.** Extend the deletion lifecycle to purge
from both stores, handling Confluence trash-then-purge. **Confluence cannot
leave alpha before this ships.**

> **RESOLVED 2026-09-19 — Phase 5, Task 6 (`41dc4bd`, `da0ab6f`), disclosed by
> Task 7.** Closed as far as it can be closed, which is not as far as the note
> below assumed. Read the original statement first, then the answer under it,
> then what an administrator is now told.
>
> **A gap already visible, found in Phase 2's whole-branch review.**
> `disconnectConfluence` deletes CharityPilot's sealed envelopes and resets the
> integration row, but **never revokes the grant at Atlassian**. A charity that
> disconnects therefore leaves a live authorization on Atlassian's side which
> CharityPilot can no longer use but has not withdrawn.
>
> The cascade chain (`Organisation` → `OrganisationIntegration` →
> `IntegrationCredential`) is correct for our own data, and there is no
> hard-delete purge routine that was missed. But "provable erasure" is the
> standard this project already holds itself to for document storage, and by
> that standard a silently orphaned grant does not pass. A charity told
> "disconnected" reasonably believes the access is gone.
>
> Design the revocation into this phase rather than discovering it during an
> audit. Note that revocation may fail — the grant may already be gone, or
> Atlassian may be unreachable — so it needs the same honest treatment as the
> rest of the deletion pipeline: retry, a dead-letter, and a record of what was
> attempted, rather than a best-effort call whose failure nobody sees.
>
> **Answered in part, 2026-09-19 (Phase 5, Task 6) — and the answer is not the
> one this note assumed.**
>
> The note above takes for granted that CharityPilot *can* revoke the grant and
> only has to do it reliably. It cannot. **Atlassian documents no programmatic
> revocation for a 3LO app**: their OAuth 2.0 (3LO) documentation describes
> revocation as user-initiated — the user revokes the grant, after which the app
> cannot work anywhere — and documents no revoke endpoint. A developer-community
> thread separately reports that with site-scoped grants an app cannot delete an
> access token to revoke its own access.
>
> What shipped: `disconnectConfluence` deletes the sealed credentials and resets
> the row as before, and on the way makes **one best-effort, bounded attempt** at
> `https://auth.atlassian.com/oauth/revoke` — the conventional OAuth revocation
> path, which Atlassian's identity host may or may not honour — returning
> `{ revoked }`. The local deletion is deliberately **not** conditional on it: a
> charity that presses Disconnect has withdrawn consent whether or not a third
> party is reachable or willing to be told, and it is exactly because the failure
> is designed for that attempting an undocumented endpoint is safe at all. The
> DELETE route logs a warning when `revoked` is false, so an operator can see a
> grant that may still be standing instead of it being a discarded return value.
>
> **No retry, no dead-letter, no persisted record — ruled against on 2026-09-19,
> and for a stronger reason than proportionality.** Building retry machinery for
> a call whose success cannot be verified would be engineering reliability into
> something that may not be a supported operation at all: every retry would be a
> guess repeated, and a dead-letter row would record a failure nobody can act on
> differently. If revocation is later shown to be genuinely supported — a real
> 200 from a real connected site, not a fake — the retry question reopens on that
> evidence. Until then the honest position is one attempt and an honest log.
>
> **What the administrator must be told, for Task 7 to carry into
> `docs/ARCHITECTURE.md` and the connect-boundary disclosure.** State all three,
> plainly, and do not soften them:
>
> 1. CharityPilot has deleted its own copy of the charity's Confluence
>    credentials. That part is complete and verifiable.
> 2. CharityPilot **attempts** to withdraw the authorisation at Atlassian, but
>    Atlassian offers no documented way for an app to do this, so the attempt may
>    silently do nothing. Do not phrase this as "we revoked your access".
> 3. If the authorisation is not withdrawn, it does not last forever: a rotating
>    refresh token **expires after 90 days without use**, and after a disconnect
>    nothing uses it. For certainty sooner, **the administrator should remove
>    CharityPilot in their Atlassian account's connected-apps settings** — the
>    route Atlassian actually documents, and the only one that is guaranteed to
>    work.
>
> For a DPO this is the material distinction: the erasure of CharityPilot's copy
> is provable, the withdrawal of the grant at Atlassian is not, and the charity
> holds the action that makes it so.
>
> The phase's exit criterion 4 ("Disconnecting revokes the grant at Atlassian")
> is therefore not literally satisfiable as written, and should be read as
> "disconnecting attempts revocation, records the outcome, and tells the
> administrator what only they can do." Whoever closes the phase should restate
> it rather than tick it. It was restated in the phase plan on 2026-09-19
> (`8022e99`) rather than ticked.
>
> **Where this is disclosed now, and why that closes the note.** The three
> statements above were the whole of what Task 7 owed. They are carried into
> the "What document erasure can and cannot prove" section of
> `docs/ARCHITECTURE.md`, and into the connect-boundary disclosure returned by
> `GET /api/v1/integrations/confluence/authorize`, so an administrator reads
> them **before** authorising rather than discovering them after disconnecting.
> The residency consequence is the one thing deliberately *not* written there:
> it depends on Open Question 1 below, which is the owner's to rule on, and
> that subsection is marked blocked rather than guessed.

**Phase 6 — admin UI and health.** Connect/disconnect screens in `apps/web`, and
per-tenant integration health that does not leak tenant data into the global
health endpoint.

---

## Open questions for the owner

1. ~~**Does Nikita accept that Confluence is a published mirror, not the system of
   record?**~~ **ANSWERED 2026-09-18 — and answered NO. This needs the owner's decision.**

   This question said it had to be settled before Phase 1. It was settled after
   Phase 3, and against the assumption the rest of this spec is built on.

   Nikita signed off by email on an architecture where **Confluence is
   authoritative for the documents deliberately managed there** — policies,
   notices, guidelines, ordinary evidence — with CharityPilot holding
   **references to real pages and versions, explicitly not duplicate copies**.
   CharityPilot stays authoritative for compliance status, workflows, deadlines,
   audit history, approvals and permissions; anything carrying trustee home
   addresses, dates of birth or sensitive complaints stays in CharityPilot,
   decided category by category. He also raised, himself, that Confluence must
   be an integration option for hOUR Timebank and not a dependency of
   CharityPilot — which matches the multi-tenant direction.

   That is a coherent DPO position. It is **not** Mode C, and the two cannot
   both hold:

   | | Mode C (this spec) | Signed off 2026-09-18 |
   |---|---|---|
   | Authoritative copy | Always Supabase, `eu-west-1` | Confluence, for chosen categories |
   | What CharityPilot stores | The bytes | A reference to a page and version |
   | Residency of a policy document | Guaranteed Ireland | Wherever the tenant's site is |
   | Erasure guarantee | Provable | Best-effort, bounded by permissions the charity holds |

   **The consequence the owner has to rule on.** The standing constraint on this
   project is that file storage is Irish, or at minimum EU. A document that is
   authoritative in Confluence has no Irish copy to fall back on, and a site's
   region is chosen by the tenant's own admins — not configurable at all on
   Atlassian's Free plan. So the signed-off architecture and the residency
   constraint are in tension for exactly the categories Nikita wants in
   Confluence. Neither he nor this spec can settle that; it is the owner's call.

   **What was done about it in the meantime.** Nothing built so far depends on
   the answer. Phases 0–3 are credential and transport plumbing that is correct
   either way, and the Phase 5 plan was written to read its erasure target from
   `targetRef` alone rather than assuming a Supabase twin. The one place the
   answer changes what is *true* rather than what is convenient is the residency
   paragraph in Phase 5's documentation task, which is marked blocked until this
   is ruled on. **Phase 4 should not be designed until it is.**
2. **Do we require tenants to be on Confluence Standard or above** before we let
   them enable the integration, given Free has no residency control and no audit
   log? Recommendation: yes, and state it as a precondition.
3. **Which Supabase region is the production project pinned to today?** The
   Irish residency claim depends on it being `eu-west-1`, and it should be
   verified rather than assumed.
