# Confluence API Client (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give CharityPilot a client that can read and write pages, attachments and metadata in a charity's own Confluence site — correctly, without duplicating content on a retry, and without a token ever reaching a log.

**Architecture:** A thin, stateless client over Confluence Cloud's REST API. It takes a **token provider** rather than a token, so every request obtains a current one and the refresh machinery built in Phase 2 stays the single place that knows about rotation. Two API versions are unavoidable: v2 for pages, spaces and content properties, v1 for attachment upload, because **v2's attachment endpoints are read-only**.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Node 22, `node:test` + `node:assert/strict`. No new dependencies — `fetch` and `FormData` are built in.

**Spec:** `docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md`
**Depends on:** Phase 2 (`docs/superpowers/plans/2026-09-18-confluence-oauth-phase-2.md`), complete.

---

## What this phase is not

**It is not the publish pipeline.** Deciding how a governance document maps onto a page, what the space structure should be, and whether the `POL -` / `NOS -` title prefixes the owner's DPO uses are a convention to key off — that is Phase 4, and it needs sight of a real Governance Hub. Building it blind would be guesswork.

This phase builds the capability. Phase 4 decides what to do with it.

**It also does not need the Atlassian app installed.** The REST API is public and documented. Every task here is testable with an injected `fetch`. What the install would buy is verification against a real space, which is worth having but is not a blocker.

---

## Global Constraints

- **No behaviour change for any existing deployment.** Nothing imports this client until Phase 4.
- **A token never leaves the credential boundary.** Not in a log, a thrown error's `message`, `cause` or `details`, or a response. The `Authorization` header must never be echoed into an error. This is the constraint every previous phase has been held to and it has been verified by mutation each time.
- **A retry must never duplicate content.** See the hazard below — this is the defining risk of this phase.
- Migrations: none expected. If one becomes necessary, hand-write it — `prisma migrate dev` cannot run against this database (pre-existing drift, no shadow database) and `migrate reset` is forbidden.
- ESM only; every relative import ends in `.js`.
- Tests compile before running. From `apps/api`: `npm run build && node --test dist/tests/<name>.test.js`
- **Do not modify** `atlassian-oauth.ts`, `integration-credential.service.ts`, `confluence-connection.service.ts`, or `apps/api/src/routes/integrations/`. All are closed and carry properties established by mutation testing.
- Baseline at the start of this phase: `apps/api` main **1188 pass / 0 fail**, real-PostgreSQL migration **4 pass / 0 fail**. Report against the current figure.

---

## The hazard this phase exists to handle

Phase 2's hazard was token rotation. This phase's is **retries against a non-idempotent API**.

[Confluence rate-limits on a points model](https://developer.atlassian.com/cloud/confluence/rate-limiting/) and returns **429 with a `Retry-After` header**. Atlassian's own guidance is to retry — at most four times — but *only requests that are safe to repeat*.

Creating a page is not safe to repeat. A 429, a timeout, or a dropped connection after Confluence has already committed the write means a naive retry produces **two identical pages in a charity's governance space**. For a product whose whole purpose is an auditable record, silently duplicated governance documents are worse than a failed publish.

Three rules follow, and they are the heart of this plan:

1. **Retry only idempotent requests automatically.** `GET`, and `PUT` where the caller supplies the version number, are safe. `POST /pages` and attachment upload are not.
2. **For non-idempotent requests, surface the ambiguity rather than resolving it.** A distinct error code meaning "this may or may not have been applied" is honest and lets Phase 4 reconcile by searching for what it tried to create. A retry that guesses is not.
3. **Never retry a 4xx other than 429.** A 400 will fail identically forever; retrying burns rate-limit budget and delays the real error.

A second, quieter hazard: **v2's page update requires the current version number** and rejects a mismatch. That is optimistic concurrency, and it is a feature — two processes editing the same page cannot silently overwrite each other. It must surface as a distinct, recoverable conflict rather than a generic failure.

---

## Two preconditions carried from Phase 2's whole-branch review

Both were raised as things Phase 3 makes reachable. Neither is a defect today. **Settle them before or during Task 1**, not after something depends on them.

### Precondition A — a reconnect concurrent with an in-flight refresh silently swaps the credentials

In `confluence-connection.service.ts`, `connectConfluence`'s `connectingState` (around `:481-513`) clears `refreshClaimToken` and `refreshClaimedAt` **unconditionally**, stealing the claim from a live refresher. The refresher's own *row* writes are fenced and so match nothing — which is correct. But `storeIntegrationCredential` is **not** fenced: it upserts on `integrationId_kind`.

So a refresher that received its rotation *before* the reconnect and persists *after* it will overwrite the freshly connected refresh and access tokens with the **previous grant's**. The row then reads `CONNECTED` with a current `connectedAt` while the tokens behind it belong to an authorization the charity has already replaced.

This is unreachable today because nothing calls `currentAccessToken`. **This phase's client is the first caller**, and a background publish job makes it routine.

Two structural fixes; pick one and say why:
- Fence the credential write on the claim as well, so a superseded refresher's persist matches nothing.
- Have `connectConfluence` refuse while a live claim is held, rather than clearing it.

### Precondition B — `currentAccessToken` takes a bare `integrationId`

`currentAccessToken(prisma, { integrationId })` accepts an id with no organisation. The route layer chose the strong form — no route accepts an `integrationId` from anywhere, and every lookup is keyed on `organisationId_provider` from the authenticated user — but the service's public API did not.

The credential layer beneath it **binds but does not authorize**: an `integrationId` belonging to another charity yields a context derived from *that* charity's row and decrypts successfully. The routes are safe because they never let a caller supply one. This phase introduces the first **non-route** caller, which will be handed an id no route derived.

Either add an organisation-scoped entry point (`currentAccessTokenForOrganisation(prisma, { organisationId })`) and use it exclusively, or state in this plan that every call site must derive the id from `organisationId_provider` first — and then actually do that, everywhere, with a test. The route file already proves the strong form is cheap. The service should not be where the weak form survives.

---

## File Structure

**Create:**
- `apps/api/src/services/confluence-client.ts` — the HTTP core: base URL, auth, retry policy, error taxonomy.
- `apps/api/src/services/confluence-pages.ts` — page and content-property operations (v2).
- `apps/api/src/services/confluence-attachments.ts` — attachment upload (v1) and listing (v2).
- Tests for each.

**Modify:**
- `docs/ARCHITECTURE.md` — the two-API split, the retry policy and why it is asymmetric, the version-conflict model.

---

### Task 1: The HTTP core

**Files:**
- Create: `apps/api/src/services/confluence-client.ts`
- Test: `apps/api/src/tests/confluence-client.test.ts`

**Interfaces:**
- Produces:
  - `type ConfluenceClientDeps = { fetch?: typeof globalThis.fetch; now?: () => number; sleep?: (ms: number) => Promise<void> }`
  - `type ConfluenceClient = { request(spec: RequestSpec): Promise<ConfluenceResponse> }`
  - `type RequestSpec = { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; api: 'v1' | 'v2'; path: string; query?: Record<string, string>; body?: unknown; formData?: FormData; idempotent: boolean }`
  - `createConfluenceClient(opts: { cloudId: string; getAccessToken: () => Promise<string> }, deps?: ConfluenceClientDeps): ConfluenceClient`

**The token provider, not a token.** `getAccessToken` is called per request. Phase 2's `currentAccessToken` refreshes under a fenced claim when needed, so a long publish cannot fail halfway because a token expired mid-operation, and this client never learns what rotation is. **Do not accept a bare token string** — it invites a caller to hold a stale one.

**Base URL:** `https://api.atlassian.com/ex/confluence/{cloudId}/` then `wiki/api/v2/...` for v2 and `wiki/rest/api/...` for v1. Construct it from `cloudId` with the same validation discipline the rest of this codebase applies to interpolated identifiers — a `cloudId` is data, and it must not be able to escape the path.

**The retry policy, which is the point of this task:**
- On **429**: honour `Retry-After` (seconds). Cap total attempts at **5** (one plus four retries), per Atlassian's guidance. Add jitter so many tenants do not resynchronise. If `Retry-After` is absent or unparseable, fall back to bounded exponential backoff.
- On **5xx**: retry **only if `idempotent` is true**.
- On **429 for a non-idempotent request**: do not retry. Throw `CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY`, which says plainly that the request was not attempted again because repeating it could duplicate content.
- On **any other 4xx**: never retry.
- On a **transport failure for a non-idempotent request**: throw `CONFLUENCE_REQUEST_INDETERMINATE` — the request may or may not have been applied, and only the caller can reconcile.
- Bound every request with `AbortSignal.timeout`. Phase 2 learned this the hard way: Node's defaults are ~300s for headers and ~300s for body, which is far longer than any caller expects.

**Secret containment:** the `Authorization` header is constructed at the moment of the call and must never be stored, logged, or reach an error. Confluence's error bodies do not echo the token, but do not surface a raw body — extract only the fields you need.

- [ ] **Step 1: Write the failing tests**

Cover, at minimum: a successful GET returns parsed JSON; a 429 with `Retry-After: 2` on an idempotent request sleeps ~2s and retries; a 429 on a **non-idempotent** request throws `CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY` **without calling fetch again**; a 500 on an idempotent request retries and a 500 on a non-idempotent one does not; a 400 never retries; attempts are capped at 5; a transport failure on a non-idempotent request throws `CONFLUENCE_REQUEST_INDETERMINATE`; the token never appears in any thrown error's `message`, `cause` or `details`; `getAccessToken` is called per request rather than once.

Inject `sleep` so tests do not actually wait. Assert the **fetch call count**, not just the outcome — that is what distinguishes "did not retry" from "retried and happened to fail".

- [ ] **Step 2: Run to verify they fail**

```bash
npm run build && node --test dist/tests/confluence-client.test.js
```

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Run the full suite and commit**

---

### Task 2: Pages and content properties (v2)

**Files:**
- Create: `apps/api/src/services/confluence-pages.ts`
- Test: `apps/api/src/tests/confluence-pages.test.ts`

**Interfaces:**
- Consumes: `ConfluenceClient` from Task 1.
- Produces:
  - `getPage(client, pageId): Promise<ConfluencePage | null>` — `null` on 404, not a throw
  - `createPage(client, { spaceId, title, bodyStorage, parentId? }): Promise<ConfluencePage>`
  - `updatePage(client, { pageId, title, bodyStorage, expectedVersion }): Promise<ConfluencePage>`
  - `getContentProperty(client, pageId, key): Promise<unknown | null>`
  - `setContentProperty(client, pageId, key, value, expectedVersion?): Promise<void>`
  - `type ConfluencePage = { id: string; title: string; spaceId: string; version: number; webUrl: string }`

**Endpoints:** `POST /pages`, `GET /pages/{id}`, `PUT /pages/{id}`, and `/pages/{id}/properties` for content properties. Create requires `spaceId`, `title`, `status`, and `body` with a representation.

> **Correction, made after Task 2 queried it and I verified against Atlassian.** An earlier draft
> of this line said update requires a `version.number` **equal to** the page's current version.
> That is wrong. Confluence v2 requires the **successor** — the current version plus one — and
> rejects anything else with a 409 whose message is literally *"Version must be incremented when
> updating a page. Current Version: [X]. Provided version: [Y]"*.
>
> The safety property is identical either way: the caller must know the current version, so a
> concurrent edit still fails the check rather than silently overwriting. Only the wire format
> differs. Task 2 implemented `expectedVersion + 1`, documented it, and flagged the discrepancy
> rather than quietly following the plan — which is the right instinct and the reason this was
> caught before a live call.
>
> **One operational hazard to carry into Phase 4:** Atlassian's own version counter can lag, so two
> updates issued in quick succession can produce a *spurious* 409 — the second request reads a
> version the server has not finished incrementing. A publish pipeline that retries immediately on
> 409 will loop. Re-read before retrying, and back off.

**Surface the refused update distinctly.** A 409 on update is a *normal* event — a charity's DPO editing a policy while a publish runs — not an error to bury. Throw `CONFLUENCE_PAGE_VERSION_CONFLICT` so Phase 4 can re-read and decide.

> **Correction, made in the Phase 3 fix round.** This line said to carry "the version actually found".
> The implementation deliberately does not, and both `confluence-pages.ts` and `ARCHITECTURE.md` say
> why: the HTTP core surfaces no response body, so the version Confluence holds never reaches the
> operation layer, and naming a number that was never received would have a caller key its recovery
> on a guess. The plan was the stale document.
>
> The same review removed a second claim from that error's text. `updatePage` sends a `title` as well
> as a version, and Confluence answers 409 for a duplicate title too — the very reason `createPage`
> leaves its own 409 untranslated. With no response body there is nothing to tell the two apart, so
> the error now names both causes and asserts neither. It also no longer says the change "was not
> applied by this call": the call is idempotent and retried on a 5xx, so an attempt that committed
> before a gateway failed produces this same 409 on the retry.

**Content properties hold at most 32 KB of JSON.** That is where governance metadata will live — approving resolution, approval date, next review date, linked standard. **Check the serialised size before sending** and throw a clear error rather than letting Confluence reject it, because the caller can do something about it and a 400 from Atlassian will not say which property was too large.

- [ ] **Step 1: Write the failing tests**

Cover: create parses the returned id and version; get returns `null` on 404 and a parsed page otherwise; update sends the expected version and returns the new one; a 409 on update throws `CONFLUENCE_PAGE_VERSION_CONFLICT` (without a found version — see the correction above); an oversized content property throws before any request is made; a property round-trips.

Assert that `createPage` is issued as **non-idempotent** and `getPage` as idempotent — that flag is what Task 1's retry policy keys on, and getting it backwards is how duplicate pages happen.

- [ ] **Steps 2-5:** as Task 1.

---

### Task 3: Attachments — the v1/v2 split

**Files:**
- Create: `apps/api/src/services/confluence-attachments.ts`
- Test: `apps/api/src/tests/confluence-attachments.test.ts`

**Interfaces:**
- Produces:
  - `listAttachments(client, pageId): Promise<ConfluenceAttachment[]>` — v2
  - `uploadAttachment(client, { pageId, filename, contentType, bytes }): Promise<ConfluenceAttachment>` — **v1**
  - `type ConfluenceAttachment = { id: string; title: string; mediaType: string; fileSize: number; downloadUrl: string }`

**This is the trap the spec has carried since the beginning.** Confluence's v2 attachment endpoints are **GET and DELETE only** — there is no v2 upload. Uploads must use v1:

```
POST /wiki/rest/api/content/{pageId}/child/attachment
X-Atlassian-Token: nocheck
Content-Type: multipart/form-data
```

The `X-Atlassian-Token: nocheck` header is **required** — without it Atlassian rejects the request as a suspected CSRF attempt. Use the built-in `FormData` and `Blob`; do not add a dependency.

**Upload is not idempotent**, and must be issued as such. Uploading the same filename twice to one page creates a *new version* of that attachment rather than a duplicate — which is better than duplicate pages, but still not something to do accidentally on a retry.

Enforce the same 10 MB ceiling the portal upload path already applies (`DOCUMENT_UPLOAD_MAX_FILE_SIZE` in `apps/api/src/routes/documents/`), so a document that CharityPilot accepted cannot fail only at the Confluence step for a reason the user was never told.

- [ ] **Step 1: Write the failing tests**

Cover: upload sends `X-Atlassian-Token: nocheck`, multipart, and the v1 path; upload is marked non-idempotent; a file over the ceiling is rejected **before** any request; list uses v2 and parses the fields; a 403 without the token header surfaces a clear error naming the likely cause.

- [ ] **Steps 2-5:** as Task 1.

---

### Task 4: Documentation

**Files:**
- Modify: `docs/ARCHITECTURE.md`

Write a section covering:

- **Why two API versions.** v2 for pages, spaces and properties; v1 for attachment upload because v2 has no upload endpoint. A future reader will otherwise "tidy" the v1 call and break uploads.
- **The asymmetric retry policy**, and why: a retried page create duplicates a governance document, and for an auditable record that is worse than a failed publish. Name the three error codes a caller must handle — `CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY`, `CONFLUENCE_REQUEST_INDETERMINATE`, `CONFLUENCE_PAGE_VERSION_CONFLICT` — and say what a caller should *do* about each, not merely that they exist. Follow the error-taxonomy table already in that document for the integration credentials; it is the house style and it is actionable.
- **The 32 KB content-property ceiling**, since that is where governance metadata will live.
- **That the client takes a token provider, not a token**, and why: rotation stays in one place.

---

### Task 5: Settle the two preconditions

**Added after Task 1 reported it could not settle them** — both live in `confluence-connection.service.ts`, which every other task in this phase is forbidden to touch. That was my scoping error. **This task is explicitly authorised to reopen that file**, and only that file plus its test.

**Files:**
- Modify: `apps/api/src/services/confluence-connection.service.ts`
- Modify: `apps/api/src/tests/confluence-connection.service.test.ts`

Read **"Two preconditions carried from Phase 2's whole-branch review"** at the top of this plan for the full statement of each. In short:

**Precondition A — a reconnect concurrent with an in-flight refresh silently swaps the credentials.** `connectConfluence`'s `connectingState` clears the refresh claim unconditionally, stealing it from a live refresher. The refresher's *row* writes are fenced and match nothing, correctly — but `storeIntegrationCredential` is not fenced; it upserts on `integrationId_kind`. So a refresher that received its rotation before the reconnect and persists after it overwrites the freshly connected tokens with the **previous grant's**, leaving the row reading `CONNECTED` while the credentials behind it belong to an authorization the charity has already replaced.

Pick one and say why:
- Fence the credential write on the claim, so a superseded refresher's persist matches nothing.
- Have `connectConfluence` refuse while a live claim is held, rather than clearing it.

**Precondition B — `currentAccessToken` takes a bare `integrationId`.** The credential layer beneath it binds but does not authorize: an id belonging to another charity yields a context derived from *that* charity's row and decrypts successfully. Every route is safe because none accepts an `integrationId` from a request — but this phase's client is the first **non-route** caller, and it will be handed an id no route derived.

Either add `currentAccessTokenForOrganisation(prisma, { organisationId })` and make it the only entry point a caller outside a route may use, or require every call site to derive the id from `organisationId_provider` — and then enforce that with a test, not a comment.

**Both need a test that fails when the protection is removed.** Precondition A in particular needs an interleaving test: a refresh in flight, a reconnect landing mid-flight, and an assertion that the refresher's persist does **not** overwrite the new credentials.

**Do not change the three refresh failure modes** the file already guarantees — exactly one refresh across concurrent callers, the replacement stored durably before the new access token is used, and a lost race never marked as a revoked grant. All three are pinned by mutation; your changes must leave those tests untouched and passing.

---

## Done when

- A page can be created, read and updated against an injected `fetch`, with the version conflict surfacing distinctly.
- An attachment can be uploaded through the v1 path with the required header, and rejected before the request if oversized.
- A 429 on an idempotent request retries with `Retry-After`; on a non-idempotent one it does not, and says why.
- No test makes a real network call.
- No token appears in any log, error message, `cause` or `details` — verified by a test that plants one and looks for it.
- `npm test` passes in `apps/api` with no pre-existing test modified.

## Explicitly not in this phase

- **The publish pipeline** — Phase 4, blocked on sight of a real Governance Hub.
- **Provider-aware erasure** — Phase 5. Confluence cannot leave alpha until it ships.
- **Any route or job calling this client.** It is a capability; nothing uses it yet.
