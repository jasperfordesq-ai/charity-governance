# Confluence connector audit — 2026-09-20

**Status:** Tier 1 was approved and **implemented on 2026-09-20** — the deletion/erasure rework, the
delete scopes and granted-scope recording, the multi-site refusal, and the production worker
credentials all landed the same day as this audit. Tiers 2 and 3 below remain proposals for the owner
and the DPO to sequence, not work in progress.

**Method.** Three sweeps of the repository (backend services and Prisma model; design documents and
recorded decisions; web UI, jobs, owner console, tests and deployment), followed by hand
re-verification of the four load-bearing findings (A1, A2, A4, C4) and a check of Atlassian's
developer documentation on the day. Every `file:line` reference was produced by reading the file.

---

## 1. Verdict in one paragraph

The connector is well built where it was built: the credential vault, the serialised token refresh,
the asymmetric retry policy and the create-or-adopt publisher are careful and heavily tested. But it
has never spoken to a real Atlassian site, and the audit found four things that would go wrong the
first time it does: the ordinary document delete still destroys the Confluence copy in defiance of
the owner's written ruling (A1); the OAuth app does not request the scopes the erasure path needs, so
erasure would fail with a misleading "reconnect required" (A2); the connect flow binds a tenant to
whichever site Atlassian happens to list first (A3); and the documented production compose profile
never hands the worker containers the credentials they need (A4). **Tier 1, implemented the same day
as this audit, has since closed all four — A1, A2, A3 and A4; see the status line above.** Beyond
those, the integration is one-directional and one-shot — nothing ever re-reads a page, nothing keeps
an idle tenant's refresh token alive, nothing republishes an edit, and nothing is audited — so "tight"
is still not the word: that gap is Tier 2 and Tier 3 work, and both remain proposals.

---

## 2. Rulings that bind every recommendation

- **Deletion (owner, 2026-09-19, in writing to the DPO).** An ordinary CharityPilot deletion removes
  our record and its reference only. Destroying the Confluence source requires an explicit erasure
  workflow. This is option (a) of the fork recorded in the handover; the fork is closed.
- **DPO-agreed architecture (2026-09-18).** Confluence is authoritative only for the documents
  deliberately managed there. CharityPilot stays authoritative for approvals, deadlines, audit
  history and permissions, and *references* pages and versions rather than mirroring them. Content
  properties are integration metadata and indexing only. Confluence is optional per tenant and never
  a dependency of CharityPilot.
- **Residency (owner, 2026-09-19).** Record each tenant's *declared* Atlassian configuration and say
  plainly that CharityPilot does not control a connected site's residency.
- **OAuth app.** Owned by CharityPilot (not hOUR Timebank), narrowest scopes plus `offline_access`,
  ownership and recovery organisational.
- **Order of work.** Correct the deletion behaviour → the owner-console integration health view (the
  unbuilt third of "the admin panel") → the DPO's review → **agree the publishing model together**
  before building more of it.
- **Test method.** `node:test` from `dist/`; no Vitest; every guard needs a canary.

---

## 3. What Atlassian's platform allows today (checked 2026-09-20)

| Area | Finding |
|---|---|
| v1 deprecation | Deprecated v1 endpoints were removed on **31 March 2025**. Search/CQL, content restrictions, content states and attachment *create* remain v1 and are not deprecated. The v1 convert-body endpoint was extended to 5 August 2026. |
| v2 gaps | v2 has no search, no attachment upload, no restrictions write, no `status=trashed` filter and no version restore. |
| Page update | `PUT /pages/{id}` requires `version.number` = current + 1 and answers 409 on a mismatch. Body representations are `storage` and `atlas_doc_format`. |
| Delete and purge | `DELETE /pages/{id}` moves to trash; `?purge=true` works only on an already-trashed page and needs the space *manage* permission. **Scopes: `delete:page:confluence` and `delete:attachment:confluence`.** |
| Trashed versus gone | v2 `GET /pages/{id}` returns **404 for both** a trashed and a purged page. Only v1 `GET content/{id}?status=trashed` (or CQL) tells them apart. Restore is v1 `PUT content/{id}` with `status: current` and a version bump. |
| Versions | `GET /pages/{id}/versions` and `/versions/{n}`. Since 1 June 2026 the list caps at 50 when `body-format` is set; follow `_links.next`. |
| Content properties | Values are JSON of at most 32 KB; the list endpoint filters by `key`; each property has its own version counter. |
| Content states | v1 `PUT content/{id}/state` sets a page status and **publishes a new page version** without changing the body. |
| Classification levels | `GET /classification-levels` and `PUT /pages/{id}/classification-level` (organisation-defined levels). |
| Webhooks | **None for OAuth 2.0 (3LO) apps.** Only Connect (end of life) and Forge triggers (`avi:confluence:trashed:page`, `deleted:page`, `restored:page`, `updated:page`, `permissions_updated:page` and others). For a 3LO app, polling is the only way to notice a change made in Confluence. |
| Rate limits | Points-based and applied to 3LO apps. **One 65 000-point hourly pool is shared across every tenant of the app.** A 429 carries `Retry-After`, `X-RateLimit-*`, `X-RateLimit-NearLimit` (true under 20 % remaining) and beta `Beta-RateLimit*` headers. Atlassian asks for exponential backoff with jitter, at most four retries, retrying only idempotent calls that carry `Retry-After`. Burst limits are evaluated over seconds. |
| OAuth 2.0 (3LO) | Rotating refresh tokens: each use invalidates the previous one, with a 10-minute reuse window and a **90-day inactivity expiry**. No documented revocation endpoint. The order of `accessible-resources` is **undefined**. |
| Resource-level grant (18 June 2026) | Chosen **when the app is created**: tokens are scoped to the single site the user picks at consent, and `accessible-resources` returns only that site. No documented way to convert an existing app. |
| Multi-admin and ownership transfer (19 March 2026) | The developer console now supports several admins and ownership transfer for OAuth apps. |
| Distribution | Apps are private by default; "Enable sharing" is needed for other sites; users of an unreviewed app see a warning at consent. |
| Data residency | Standard, Premium and Enterprise plans only. The EU location is Frankfurt plus **Dublin**. Page content, attachments, comments and the search index are in scope; permission configuration and user accounts are not. The location is not exposed to a 3LO app through the API. |
| App access rule | Any plan can block all third-party apps organisation-wide; Guard Standard adds per-space rules. Blocked content is **silently omitted** from listings; apps are told to inspect `/spaces` to learn which spaces are affected. |
| Live Docs | New sites default to Live Docs (`subtype: "live"`, snapshot versioning). A publisher should create classic pages explicitly and any reconcile logic should tolerate live-doc version semantics. |
| Scopes | The granular set includes `delete:page`, `delete:attachment`, `read/write:content.property`, `read/write:label`, `read/write:content.restriction` and `search:confluence` (CQL). Atlassian recommends fewer than 50 scopes in total. |

---

## 4. Findings

### A. Contradicts a ruling or fails on a real site — fix before any tenant connects

| # | Finding | Evidence |
|---|---|---|
| A1 | **The ordinary delete still erases the Confluence page and attachment.** `remove()` calls `enqueueConfluenceErasure` inside the delete transaction, and the race compensator does the same. The eraser then deletes and purges. This contradicts the owner's written ruling. | `apps/api/src/services/document.service.ts:854`, `:1130`; `apps/api/src/services/confluence-erasure.ts:237-277` |
| A2 | **The delete scopes are not requested.** `CONFLUENCE_OAUTH_SCOPES` holds read/write page, read/write attachment, read space, read content-details and `offline_access`, but not `delete:page:confluence` or `delete:attachment:confluence`. Against a real site every erasure would 403. `deletePage` maps a 403 to `CONFLUENCE_RECONNECT_REQUIRED` (a wrong diagnosis, retried until dead-letter); `purgePage` maps it to `CONFLUENCE_PURGE_FORBIDDEN`. Granted scopes are not recorded per tenant, so a later scope change cannot be detected either. | `apps/api/src/routes/integrations/index.ts:98-106`; `apps/api/src/services/confluence-pages.ts:563-608`; `apps/api/src/services/confluence-client.ts:399-433` |
| A3 | **Wrong-site risk.** `connectConfluence` binds the tenant to `sites[0]` from `accessible-resources`, whose order Atlassian documents as meaningless. The code calls this choice "deliberate and temporary" and records `siteCount` so the decision stays visible, but nothing acts on it and no UI offers the choice, so a user who belongs to two sites can still bind the wrong one. | `apps/api/src/services/confluence-connection.service.ts:677-696` |
| A4 | **The production compose profile starves the workers.** `production-scheduler` and `document-storage-cleanup` use explicit `environment:` allowlists that omit `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET` and `INTEGRATION_ENCRYPTION_KEY`. On that profile the publisher cannot refresh a token and the eraser cannot open a sealed credential. The blue-green profile passes the whole env file and is unaffected. | `compose.production.yml:104-125`, `:165-173` |
| A5 | **A dead entry point.** `jobs/publish-document-mirrors.ts` has no npm script and no compose service; `DOCUMENT_PUBLICATION_INTERVAL_MS` and `DOCUMENT_PUBLICATION_LIMIT` appear in no `.env*.example`. | `apps/api/package.json`; `compose.production.yml` |
| A6 | **Four assumptions have never met a real site.** A trashed page reads as 404 (now confirmed by the docs — which also means "restorable" is invisible to v2); page titles are unique within a space; `space-id` sent as a single value is honoured (the docs say `array<integer>`, of which a single value is a valid one-element case); how Confluence normalises a stored title. | `docs/CONTINUATION-PROMPT-confluence-integration.md` §5 |

### B. Lifecycle and reliability gaps that will bite after go-live

| # | Finding | Evidence |
|---|---|---|
| B1 | **No refresh keepalive.** Refresh happens lazily, on use. A tenant that publishes nothing for 90 days loses its rotating refresh token and discovers it at the next publish. | `apps/api/src/services/confluence-connection.service.ts:783-865`; no such job in `apps/api/src/jobs/production-scheduler.ts` |
| B2 | **Nothing detects a change or deletion made in Confluence.** There is no reconcile job and no webhook (impossible for a 3LO app). `getPage` has exactly one production caller, the erasure read-back. The ruling's "a note that it is no longer visible there" has no source of truth. | `apps/api/src/jobs/`; `apps/api/src/services/confluence-pages.ts:311` |
| B3 | **Edits never republish.** Publication is enqueued only on document create; `updatePage` has no production caller. The content property (approved date, next review date, minute reference, document version) is stale from the first edit in CharityPilot. | `apps/api/src/services/document.service.ts:762`, `:780-801`; `apps/api/src/services/document-publication.service.ts:801-844` |
| B4 | **Rate-limit handling is reactive only.** A 429 is honoured, but `Retry-After` is clamped to 60 s (which burns attempts when Atlassian asks for longer), `X-RateLimit-NearLimit` is ignored, job intervals carry no jitter, and nothing accounts for the hourly pool shared by every tenant. | `apps/api/src/services/confluence-client.ts:487-494`, `:641-655`; `apps/api/src/jobs/production-scheduler.ts:590-631` |
| B5 | `findPageByTitle` and `getContentPropertyRecord` take `results[0]` and never follow `_links.next`. Adoption is title-only; the fallback recorded in the handover (CQL on the content property) is unbuilt. | `apps/api/src/services/confluence-pages.ts:441-451`, `:700-770` |
| B6 | Pages are created at the space root with no `parentId` and no labels; the `conventionalDocumentName` hook for the DPO's `POL -` / `NOS -` convention returns the name unchanged. This is a publishing-model question (Tier 3). | `apps/api/src/services/document-publication.service.ts:827-831`; `apps/api/src/services/confluence-document-mapping.ts:107-109` |

### C. Observability, audit and the admin surface

| # | Finding | Evidence |
|---|---|---|
| C1 | **No audit trail.** Connect, disconnect, publish-space change, publication, dead-letter and erasure write no `SecurityAuditEvent`. The only trace of who connected is the mutable `connectedById`, which disconnect erases. Separately, the shared `SecurityAuditEventType` union has drifted from the Prisma enum: it lacks `SESSION_REPLAY_DETECTED`, `ORGANISATION_CONFIGURATION_CHANGED` and `INVITE_LINK_REISSUED`, and carries a phantom `PASSWORD_RESET_COMPLETED`. | `apps/api/prisma/schema.prisma:243-260`; `packages/shared/src/types/api.ts:135-148` |
| C2 | **No per-document publication surface.** The documents API and UI show no publication state, no page link, no failure and no retry. A dead-lettered publication is invisible to the charity; the only signal is the aggregate `lastError` on `/integrations`. | `apps/web/src/app/(dashboard)/documents/**`; `apps/api/src/routes/documents/index.ts` |
| C3 | **The owner-console integration health view is not built** — the third piece of "the admin panel" the DPO asked for. The tenant panel shows a status chip, the space key and `lastError`, read-only. | `apps/web/src/app/(owner)/owner/tenants/[id]/tenant-configuration-panel.tsx:157-177`; handover §2b |
| C4 | `env.INTEGRATION_ENCRYPTION_KEY` is missing from the pino redaction list while every peer secret is present. | `apps/api/src/utils/logger.ts:41-51` |
| C5 | No declared-residency record: the owner's ruling (record the tenant's declared plan and location, disclaim control) has no column and no UI. | `apps/api/prisma/schema.prisma:448-503` |
| C6 | No Confluence types or zod schemas in `packages/shared`; the web app hand-mirrors the `/confluence/status` shape. No Playwright coverage of the flow and no Atlassian test double anywhere in the repository. | `apps/web/src/lib/integration-status.ts:46-188`; `e2e/tests/` |

### D. Security and hygiene

| # | Finding |
|---|---|
| D1 | App-access-rule blocking is undetectable today: a blocked space simply vanishes from listings. The connector should distinguish "space no longer listed" from "connection broken". |
| D2 | `confluence-attachments.ts` imports `DOCUMENT_UPLOAD_MAX_FILE_SIZE` from the route layer (a known deferred item). |
| D3 | Key rotation for `INTEGRATION_ENCRYPTION_KEY` is documented but not implemented (the DPO's Item 6; a production-readiness gap outside this audit's proposals). |
| D4 | Development logs still hold leaked OAuth authorization codes (handover action item; operational, not code). |
| D5 | The Atlassian app should use the March 2026 multi-admin and ownership-transfer features and the June 2026 resource-level grant. Both are developer-console actions for the owner. |

### What is good, and must not be touched without a stated reason

The sealed-envelope vault with AAD tenant binding; the fenced, serialised refresh with the three-way
`RefreshTokenOutcome`; the retry policy gated on caller-declared idempotency rather than HTTP method;
the create-or-adopt publisher that never creates-and-retries; the delete-before-purge eraser with
read-back proof; the callback-as-web-page that renews the session before spending the single-use
code; the disclosure gate before the authorize link; and the build check that fails if an OAuth code
can reach a log.

---

## 5. Recommendations

### Tier 1 — correctness against the rulings and a real site (do first, in this order)

**T1.1 Deletion rework (the owner's ruling).** Keep the publication row; never delete it, because
`cloudId`, `pageId` and `attachmentId` are the only record of where the copy is.

- Schema: `DocumentPublicationState` gains `RETIRED` in its own migration (`ALTER TYPE … ADD VALUE`
  must not share a file with a use of the value — the house rule from `20260919130000`). A second
  migration adds `retiredAt`, `retiredStoragePath` (copied from `doc.fileUrl` at retire time, since
  the erasure row's `storagePath` is NOT NULL and the document is gone by then), `erasureRequestedAt`
  and `erasureDeletionId`, and rewrites `DocumentPublication_state_consistent` with a fourth arm
  (`RETIRED` ⇒ `retiredAt` and `pageId` set; `nextAttemptAt`, `claimedAt` and the alert claims null).
  `publication_target_consistent` is unchanged.
- `document.service.ts`: `remove()` drops the `enqueueConfluenceErasure` call (L848-859) and the
  `confluenceErasureEnqueued` return field; `enqueueConfluenceErasure` is deleted;
  `createConfluenceErasureRow` becomes the public `enqueueConfluenceErasureForPublication`.
  `cancelConfluencePublication` becomes `retireConfluencePublication`: the same two locked passes,
  but a row with a `pageId` becomes `RETIRED`; a row with no `pageId` and no claim is deleted; a row
  still mid-flight (`pageId === null && claimedAt !== null`) is parked exactly as today so that
  `attachPublicationPage` can still land the id (marking it `RETIRED` would lose the id). The residual
  is closed by the reconcile job's orphan sweep (T2.2). The `CANCELLED_PUBLICATION_MESSAGE` wording
  that promises erasure is removed.
- The explicit erasure workflow: `POST /api/v1/integrations/confluence/publications/:publicationId/erase`
  with `preHandler: [requireSessionLevel('ADMIN'), requireActionApproval()]` (the same stack as
  `DELETE /documents/:id`) and body `{ reason (10–500 chars), confirmation: 'ERASE CONFLUENCE COPY' }`.
  It answers 404 unless the integration is `CONNECTED`; **409 `CONFLUENCE_ERASURE_SCOPE_MISSING`**
  unless the tenant's granted scopes include both delete scopes (T1.2); 409
  `CONFLUENCE_ERASURE_ALREADY_REQUESTED` if `erasureDeletionId` names a live row; otherwise one
  transaction enqueues the `confluence` `DocumentStorageDeletion` row through the existing helper and
  stamps `erasureRequestedAt` and `erasureDeletionId`. The eraser and its scheduler registration are
  untouched.
- Tests. The delete-path tests live in `apps/api/src/tests/document-storage-cleanup.test.ts`
  L446-964, not in the documents-route tests: L472 asserts `RETIRED`, `retiredAt` set, `pageId` kept
  and zero deletes; the dual-erasure block at L618-711 inverts to exactly one `supabase` row; the
  lock/race cases at L832-867 assert `RETIRED` or parked-`PENDING`; L949 inverts so a failed
  publication read no longer fails `remove()`. New test: "explicit erasure enqueues exactly the row
  the old delete path did" (reuse the `targetRef` deep-equal). `document-publication.test.ts` L141's
  enum regex gains `RETIRED`. `integrations-route.test.ts` gains member 403, foreign-org 404, scope
  gate 409 with `grantedScopes: []`, and the success path; the disclosure pins gain the new sentence.
  Canary: re-add the erasure call in `remove()` and the suite must go red.
- Docs: handover §2a rewritten to the email ruling with the fork closed; `docs/ARCHITECTURE.md`
  "What document erasure can and cannot prove" and `CONFLUENCE_CONNECT_DISCLOSURE.erasure` say that
  ordinary deletion leaves the page and that erasure is a separate, explicitly authorised action.

**T1.2 Scopes, and recording what was granted.**

- Add `delete:page:confluence`, `delete:attachment:confluence` (for the erasure workflow) and
  `search:confluence` (CQL adoption and reconcile fallback) to `CONFLUENCE_OAUTH_SCOPES`, and extend
  the disclosure copy to justify each.
- Persist the granted scopes as `grantedScopes String[] @default([])` on `OrganisationIntegration`,
  written by a **one-line addition to the closed `confluence-connection.service.ts`**
  (`grantedScopes: tokens.scopes` in `connectingState`, L726-736; `atlassian-oauth.ts` L323 already
  parses `scope`). Reason for touching a closed file, to be recorded in the handover: the erasure gate
  must know whether this tenant consented to the deletion scopes, and that value is visible only
  inside `connectConfluence`. Existing rows read `[]`, so the erasure gate refuses until the tenant
  reconnects; nobody is forced to re-consent. `GET /confluence/status` returns
  `reauthorisationRequired` when the required set is not a subset of the granted set, and
  `/integrations` shows "Re-authorise" beside "Connected".

**T1.3 Site binding.**

- Owner action in the Atlassian developer console: create the app **as CharityPilot with a
  resource-level grant** (only possible at creation; no tenant has connected, so nothing is lost),
  add the scopes, enable sharing (privacy policy and terms), add a second admin, and register
  `{FRONTEND_URL}/integrations/confluence/callback`.
- Code guard regardless: when `sites.length !== 1`, store the credentials with status
  `SITE_SELECTION_REQUIRED` and expose `PUT /confluence/site { siteId }` validated against the stored
  list; the callback page renders a picker. Never bind `sites[0]` silently.

**T1.4 Deployment wiring.**

- `compose.production.yml`: add `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`,
  `INTEGRATION_ENCRYPTION_KEY`, `DOCUMENT_PUBLICATION_INTERVAL_MS` and `DOCUMENT_PUBLICATION_LIMIT`
  to `production-scheduler`, and the first three to `document-storage-cleanup`. Add a
  `jobs:publish-document-mirrors` npm script and a `jobs`-profile service mirroring the cleanup job.
  Document both publication variables in all three `.env*.example` files. Extend
  `scripts/check-production.mjs` and `scripts/check-bluegreen-compose.test.mjs` to assert the
  scheduler receives the three secrets.
- `apps/api/src/utils/logger.ts`: add `env.INTEGRATION_ENCRYPTION_KEY` to the redaction paths, with
  a test.

**T1.5 Real-site verification runbook** (manual, against the owner's own site, before any tenant):
the four assumptions in A6, plus: the delete scopes are accepted; the `space-id` filter is honoured;
a content property round-trips; the Live Docs default does not affect `storage`-format creates.
Recorded in `docs/production-runbook.md`.

### Tier 2 — tightness that does not pre-empt the publishing-model conversation

**T2.1 + T2.2 A reconcile job that is also the keepalive** (one job; the merge is deliberate).

- Columns on `DocumentPublication`: enum `DocumentPublicationRemoteState { VISIBLE ARCHIVED TRASHED
  GONE UNKNOWN }`, `remoteState?`, `remoteVersion?`, `remoteTitle?` (≤ 500), `remoteStateChangedAt`,
  `lastReconciledAt` (last determinate answer), `reconcileAttemptedAt` (stamp and ordering),
  `reconcileError?` (a code, never text); index `(provider, reconcileAttemptedAt)`. On
  `OrganisationIntegration`, written through a narrow `updateMany` as `confluence-publish-target.service.ts`
  does: `lastReconcileAt` and `lastReconcileOutcome` (`OK | RECONNECT_REQUIRED | FORBIDDEN |
  SITE_NOT_ACCESSIBLE | RATE_LIMITED`).
- New `apps/api/src/services/confluence-reconcile.service.ts` with `createConfluenceReconciler(deps)`
  mirroring `createConfluencePublisher` (injectable `connect`, `operations`,
  `listAccessibleResources`). Per tenant: obtain a token through `currentAccessTokenForOrganisation`
  (on a six-hour interval the one-hour access token is always expired, so every visit rotates the
  refresh token — **that is the keepalive**, with no forced refresh and no further edit to the closed
  module); probe `accessible-resources` once, and if the bound `siteId` is absent record
  `SITE_NOT_ACCESSIBLE` and touch no pages. Per page: `getPage` gives `VISIBLE` or `ARCHIVED` from
  `status` plus version and title; `null` triggers a new `getTrashedPage` in `confluence-pages.ts`
  (`GET v1 content/{id}?status=trashed&expand=version`, idempotent) — 200 means `TRASHED`, 404 means
  `GONE`. `remoteStateChangedAt` flips only when the state changes.
- Errors: a 401 aborts the tenant as `RECONNECT_REQUIRED`; a 403 marks the row `UNKNOWN`, and a 403
  on a tenant's first page aborts the tenant as `FORBIDDEN`; `CONFLUENCE_RATE_LIMITED` **aborts the
  whole run** (the pool is shared) and leaves rows unstamped; the job never sleeps. A new optional
  `observeRateLimit` hook on `ConfluenceClientDeps` (`confluence-client.ts` L112-130, not a closed
  file) is fed from `X-RateLimit-NearLimit` and `Retry-After` in the request loop; when it fires the
  job stops claiming after the current page.
- `DocumentPublicationService` additions: `claimPublicationsForReconcile(orgId, limit, minAge)` as a
  **stamp-claim** on `reconcileAttemptedAt` (`FOR UPDATE SKIP LOCKED`, `NULLS FIRST`) rather than the
  outbox lease, because reads are idempotent and `claimedAt` belongs to the publish state machine;
  `recordRemoteState(id, result)`; and `retireOrphanedPublications()` (a `pageId` with no claim and
  no `Document` row becomes `RETIRED`; a null-`pageId` orphan is deleted), which closes T1.1's
  mid-flight residual.
- Scheduling: `runDocumentReconcile` in `production-scheduler.ts` lists `CONNECTED` integrations by
  `lastReconcileAt NULLS FIRST` with `DOCUMENT_RECONCILE_TENANTS_PER_RUN` (default 10) and
  `DOCUMENT_RECONCILE_PAGES_PER_RUN` (default 50) and a per-page minimum age of 24 h; registered in
  `main()`, `runProductionSchedulerOnce` and the shutdown list, with a sibling entry point
  `jobs/reconcile-document-mirrors.ts`. `startRecurringJob` gains `jitterFraction?` (default 0 keeps
  existing tests green; 0.2 on a six-hour interval). Alert when a `CONNECTED` tenant's
  `lastRefreshedAt` is older than 60 days.
- Tests: new `confluence-reconcile.service.test.ts` — 200 gives `VISIBLE` with version and title;
  404 then 200 gives `TRASHED`; 404 then 404 gives `GONE`; 403 gives `UNKNOWN` and the tenant
  `FORBIDDEN`; a rate limit aborts the run leaving rows unstamped; NearLimit stops claiming; a missing
  site makes no page calls; the orphan sweep retires only unclaimed rows; a tenant with zero pages
  still obtains a token (keepalive). `production-scheduler.test.ts` gains the `document-reconcile:*`
  events and env keys, plus source-pin tests for both entry points.

**T2.3 Republish on change — flagged: this extends the publish layer the DPO asked to pause.**
`enqueueConfluencePublication` would also fire on a metadata update (`reason: METADATA` →
`setContentProperty` PUT with version + 1 and an `updatePage` body refresh) and on file replacement
(`reason: FILE` → v1 attachment upload; the same filename creates a new attachment version), reusing
the `(documentId, provider)` row by resetting it to `PENDING` with `attempts = 0` and a recorded
`reason`, and wiring `updatePage` and its version-conflict path (re-read, retry once). For: the
page's content property is wrong from the first edit. Against: the owner told the DPO the publishing
model would be agreed together before more of it is built. **Default: defer to after that meeting
unless the owner says otherwise.**

**T2.4 Audit events.** New `SecurityAuditEventType` values `INTEGRATION_CONNECTED`,
`INTEGRATION_SITE_SELECTED`, `INTEGRATION_DISCONNECTED`, `INTEGRATION_PUBLISH_TARGET_CHANGED`,
`INTEGRATION_REAUTHORISATION_REQUIRED`, `DOCUMENT_PUBLICATION_DEAD_LETTERED` and
`CONFLUENCE_ERASURE_REQUESTED`, written at the route and service sites. Fix the shared union drift
(add the three missing values, remove the phantom) with a test that pins shared ⊇ Prisma enum.

**T2.5 Per-document publication surface.** `publicDocument` (`document.service.ts` L363) gains
`confluence: { publication: NOT_PUBLISHED | PENDING | PUBLISHED | FAILED | RETIRED, pageUrl, remote: {
state, title, version, lastReconciledAt, reconcileError } | null }` through a second
`documentPublication` read (there is no relation, by design), plus `POST /documents/:id/publication/retry`
(ADMIN; resets a `DEAD_LETTER` row). A shared zod schema and type in `packages/shared` replaces the
web app's hand-mirrored Confluence types. UI copy in `integration-status.ts`
(`describeConfluenceMirror`): `VISIBLE` "Published to Confluence, checked …"; `TRASHED` "No longer
visible in Confluence — in the site's trash and restorable there"; `GONE` "No longer visible in
Confluence — the page could not be found"; `UNKNOWN` "Could not check Confluence (…)"; null "Not
checked yet". A test pins by regex that the word "deleted" never appears in this copy. Badge, page
link, failure notice and retry button on the document list and detail views.

**T2.6 Owner-console integration health** (the missing third of the admin panel): a read-only panel
on `(owner)/owner/tenants/[id]` showing status, site, space, granted versus required scopes, last
refresh, last health check, publication counts by state, dead-letter count, reconcile summary and
declared residency. Extend `owner-tenant-configuration.service.ts`; no operator write actions.

**T2.7 Declared residency.** Columns `declaredPlan`, `declaredResidency`, `declaredAt` and
`declaredById` on `OrganisationIntegration` (not in `config`, which reconnect overwrites), captured on
the `/integrations` page after connect with the disclaimer that CharityPilot does not control it, and
shown in T2.6. This unblocks the `docs/ARCHITECTURE.md` "Residency — BLOCKED" section under the
owner's ruling.

**T2.8 Client hardening.** Follow `_links.next` in `findPageByTitle` and `getContentPropertyRecord`;
add the CQL-by-content-property adoption fallback; return `Retry-After` to outbox callers instead of
clamping it at 60 s; add interval jitter to `startRecurringJob`; move the upload-size constant out
of the route layer (D2).

**T2.9 Tests.** An in-process fake Atlassian (token endpoint, `accessible-resources`, and the v1/v2
routes the client uses) under `e2e/helpers/`, and a Playwright spec for `/integrations` (disclosure →
callback outcomes → space choice → status) following the MCP harness pattern.

### Tier 3 — for the owner/DPO publishing-model meeting (not proposed for build)

- The reference model: link an existing Confluence page and version as evidence for a governance
  item (the model the DPO signed off).
- The shape of the space: a CharityPilot root page per space, `parentId`, labels (`charitypilot`,
  category) and the `POL -` / `NOS -` naming hook.
- Content states ("Approved", "Under review") mirrored through the v1 content-state API. Each change
  publishes a new page version, so this is Confluence content changed on CharityPilot's behalf.
- Classification levels on pages (Premium data classification).
- Full-body rendering (minutes and resolutions as page content) instead of a stub page plus
  attachment — the mirror question itself.
- Forge Remote for real-time events, only if polling proves insufficient (the DPO's own condition).

---

## 6. Sequencing

Tier 1 as one implementation plan (T1.1–T1.5). Tier 2 as two plans: lifecycle (T2.1/2.2, T2.8) then
surfaces (T2.4–T2.7, T2.9), with T2.3 only if the owner opts in. Each follows the architectural
path: spec in `docs/superpowers/specs/`, then `superpowers:writing-plans`, then subagent-driven
execution with the canary rule in every review brief.

Risks to carry into implementation: `ALTER TYPE ADD VALUE` in its own migration; the CHECK rewrite
tested against the disposable database as `20260919160000` was; the mid-flight parked-`PENDING`
window exists until the first orphan sweep (bounded, and loud through `claimLost`); a tenant with
`grantedScopes: []` cannot erase until it reconnects (intended, and surfaced in status); the one-line
closed-file edit is recorded with its reason.

## 7. How the built work would be verified

- `cd apps/api && npm test` (tsc, then `node --test` from `dist/`) green, and the `# tests` count
  rises.
- Every new guard mutation-tested on a scratchpad copy with a branch-body canary.
- `cd apps/web && npm test`, with any new web test file added to `tsconfig.test.json`.
- `npm run check:production` and the compose tests assert the scheduler environment carries the
  secrets.
- Playwright `e2e/tests/integrations-confluence.spec.ts` against the fake Atlassian.
- Manually: the T1.5 runbook against the owner's site, then one tenant end to end — connect → choose
  space → upload → page appears → edit metadata → property updates → trash the page in Confluence →
  reconcile marks `TRASHED` → restore → `VISIBLE` → delete in CharityPilot → page remains, row
  `RETIRED`.
