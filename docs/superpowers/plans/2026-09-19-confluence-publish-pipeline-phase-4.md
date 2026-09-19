# Confluence Publish Pipeline (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a governance document uploaded through CharityPilot appear in a charity's own Confluence site — as a **published copy**, never as the only copy — and make that copy erasable and provably so.

**Architecture:** An outbox following the `DocumentStorageDeletion` reliability shape. Uploading a document enqueues a publication; a worker claims it, creates or **adopts** a page, attaches the file, writes integration metadata to a content property, and records where it went in the exact `targetRef` shape Phase 5's eraser already reads. Deleting a document enqueues a **second** deletion row for the Confluence copy.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, `node:test`, Confluence Cloud REST API v1/v2.

**Spec:** `docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md`

---

## The decision taken to unblock this phase, and how to undo it

The spec's **Open Question 1** — is Confluence a published mirror, or authoritative for chosen
categories? — is **still unresolved and still the owner's**. This phase was built anyway, on a
deliberately reversible choice:

> **Confluence is a MIRROR. Supabase in Ireland keeps the authoritative copy.**

Why this direction and not the other:

| If we build | and the other model wins | cost |
|---|---|---|
| **mirror** (this plan) | Confluence is authoritative | a spare Irish copy nobody needed — harmless, and deletable |
| authoritative-in-Confluence | mirror wins | charity documents outside Ireland with **no Irish copy** — breaks the owner's standing constraint |

Only one of those is reversible. The spec is also the binding authority and it says Mode C.

**What this means concretely, and no task may contradict it:**

- `Organisation.documentStorageProvider` stays `supabase`. **Confluence is NOT registered as a
  storage provider** — it is a publish target. Registering it would make it selectable as the place
  a charity's bytes live, which is the model we did *not* choose.
- Portal upload is unchanged and unconditional. A charity with no Atlassian account is unaffected.
- **Connecting Confluence is the opt-in.** The connect screen already shows the alpha disclosure and
  requires deliberate action. Publication happens for an organisation with a `CONNECTED` Confluence
  integration and no one else. There is no second flag to forget.

## Global Constraints

- **Confluence stays alpha.** Nothing here promotes it.
- **Portal upload must always work.** No integration may become the only way to get a document in.
- **Commit directly to `master`.** No worktrees, no feature branches.
- **Never** run `prisma migrate reset`, `migrate dev`, `db push`, `DROP` or `TRUNCATE`. The
  development database holds real records. Hand-write migrations, apply with
  `npm run db:migrate:deploy`, exporting first:
  `export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"`
- **Adding an enum value has two house patterns.** Value *used* in the same migration → rebuild the
  enum. Value only *declared* → `ADD VALUE IF NOT EXISTS`. `20260710190000_add_deadline_calendar_lifecycle/migration.sql`
  records why.
- **A new Prisma model must be added to `DISPOSABLE_DATABASE_RESET_TABLES`**, which lives in
  **`e2e/helpers/database-safety.cjs` at the repository root** — *not* in `apps/api/e2e/helpers/db.ts`,
  which merely imports it. That guard lives in `npm run test:production-check`, **not** the default
  `npm test`. Task 1 did this; a later task adding a model must too.
- ⚠️ **`apps/api`'s `npm test` runs in two passes, and a new test file can fall between them.**
  Pass one runs every `dist/tests/*.test.js` while *skipping* anything whose name contains
  `real PostgreSQL 16 migration`; pass two re-runs that phrase against **one named file only**. So a
  test in a *new* file carrying that phrase is skipped in pass one and never reached in pass two —
  it silently never runs. Avoid the phrase, or widen pass two knowing that
  `scripts/check-production.test.mjs` asserts the test script's exact text. This is the second
  silent-skip trap in this repository; the other is `apps/web`'s `tsconfig.test.json` include list.
- **Closed files** — do not modify: `integration-crypto.ts`, `integration-credential.service.ts`,
  `atlassian-oauth.ts`, `confluence-connection.service.ts`.

## Testing conventions

**There is no Vitest anywhere.** `node:test` + `node:assert/strict`; no `describe`, `it`, `expect`,
`it.each` — loop for table-driven cases. `apps/api`'s `npm test` is `tsc && node --test
dist/tests/*.test.js`, so tests run from `dist/` and an edit without a rebuild runs the previous
version.

**For mutation testing, skip the build**: copy `src` to a scratchpad, junction the **repository
root's** `node_modules` (hoisted monorepo — the inner ones lack `tsx`/`typescript`), and build the
baseline from a pristine `git archive HEAD` into a **new** directory. Run `node --import tsx --test`.
**Never mutate the working tree.**

**Mutate each ANDed sub-condition independently and each call site separately.** A compound mutation
can go red *for the wrong reason*, which is indistinguishable from coverage. Follow any green
mutation with a canary and say which form you used.

**When you widen a row type, audit everything that *fabricates* that shape — not just every
`select`.** That class has appeared eight times here and was only retired by making the test double
honour `args.select`. A cast is a promise the compiler will not check for you.

---

## The hazard this phase exists to manage

**`createPage` is deliberately non-idempotent.** Phase 3 marked it so, and pinned it, because a
retried create after a dropped connection or a 429 produces **two pages for one board resolution,
with nothing saying which is real.** That is the worst outcome this pipeline can produce, and the
outbox *will* retry.

So a create is never simply retried. The sequence is **create-or-adopt**:

1. Derive a **deterministic** title from the document — the same document must always produce the
   same title, or adoption cannot work.
2. Attempt `createPage`.
3. On `CONFLUENCE_CONFLICT` (409), **do not retry and do not translate it**. Confluence uses 409 for
   a duplicate title, which is exactly the case where a previous attempt already succeeded. Re-read
   by title, and if a page is found, **adopt it** — record its id and continue.
4. Only if the re-read finds nothing is the 409 a genuine conflict; dead-letter it.

This is the "caller-side re-read comparing the title" the spec's Phase 4 note prescribes, and it is
the reason Task 4 exists. **Do not close the ambiguity by reading the upstream error body** — that
would mean carving a hole in the containment rule which exists because a proxy once put a live
authorization code in an error body.

---

### Task 1: The publication record

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_document_publication/migration.sql`
- Modify: `apps/api/e2e/helpers/db.ts` (`DISPOSABLE_DATABASE_RESET_TABLES`)
- Test: a new `apps/api/src/tests/document-publication.test.ts`

**Interfaces:**
- Produces: `DocumentPublication`, and the `DocumentPublicationState` /
  `DocumentPublicationTerminalReason` enums Task 6 dispatches on. **Task 1 shipped these terminal
  reasons** — Task 6 must map to them and add none without saying why:
  `MAX_ATTEMPTS_EXHAUSTED`, `PERMANENT_CONNECTION_UNAVAILABLE`, `PERMANENT_PERMISSION_DENIED`,
  `PERMANENT_CONFLICT_UNRESOLVED`, `PERMANENT_CONTENT_PROPERTY_REJECTED`,
  `PERMANENT_TARGET_REF_REJECTED`.
- **A database CHECK constraint, `publication_target_consistent`, ties `publishedAt`, `cloudId` and
  `pageId` together and rejects untrimmed ids at write time.** Task 6 must therefore write
  `cloudId`/`pageId` with `publishedAt` still **null** during the create-then-attach window, and set
  `publishedAt` only on completion. That is not a workaround — it is the constraint enforcing the
  very ordering the adopt design depends on.

**Design notes:**

Copy `DocumentStorageDeletion`'s reliability shape — `state`, `attempts`, `lastError`,
`lastAttemptAt`, `nextAttemptAt`, `claimedAt`, `deadLetteredAt`, `terminalReason`, plus the
dead-letter alert claim fields. **Do not invent a second reliability pattern**; the spec says so
explicitly and that engine is now well tested.

Fields specific to publication:

```prisma
model DocumentPublication {
  id             String   @id @default(cuid())
  organisationId String
  documentId     String
  provider       String   @default("confluence")

  cloudId        String?
  spaceId        String?
  pageId         String?
  attachmentId   String?
  pageTitle      String?
  publishedAt    DateTime?

  // … the DocumentStorageDeletion reliability fields, copied …

  @@unique([documentId, provider])
  @@index([state, nextAttemptAt, claimedAt, createdAt])
}
```

`@@unique([documentId, provider])` is load-bearing: it is what stops two workers, or two uploads of
the same document, enqueuing two publications and producing two pages.

`cloudId` is stored on the row rather than resolved later, for the same reason Phase 5 stores it:
a charity may disconnect, reconnect to a **different** site, and still be owed erasure from the
first. The row must remember where the bytes went.

- [ ] **Step 1: Write the failing test** — a publication row can be created, defaults to `PENDING`
      with `attempts: 0`, and a second row for the same `(documentId, provider)` is refused.
- [ ] **Step 2: Run and watch fail**
      `cd apps/api && npm run build && node --test dist/tests/document-publication.test.js`
- [ ] **Step 3: Add the model and enums to `schema.prisma`**
- [ ] **Step 4: Hand-write the migration.** Purely additive — a new table and new enums. Check the
      index name length against the 63-byte limit; this repo has hit truncation before.
- [ ] **Step 5: Apply it** with `npm run db:migrate:deploy`, then `npx prisma generate`
- [ ] **Step 6: Add the model to `DISPOSABLE_DATABASE_RESET_TABLES`** and run
      `npm run test:production-check` — that guard is not in the default suite
- [ ] **Step 7: Run the full suite and the migration suite**
- [ ] **Step 8: Commit** — `feat(publish): a document can carry a record of where it was published`

---

### Task 2: List the spaces a charity can publish into

**Files:**
- Create: `apps/api/src/services/confluence-spaces.ts`
- Create: `apps/api/src/tests/confluence-spaces.test.ts`
- Modify: `apps/api/src/routes/integrations/index.ts`

**Interfaces:**
- Produces: `listSpaces(client, cursor?): Promise<{ spaces: ConfluenceSpace[]; nextCursor?: string }>`
  where `ConfluenceSpace` is `{ id: string; key: string; name: string }`, and
  `GET {prefix}/confluence/spaces` returning that list for the calling organisation.

**Design notes:**

`GET /wiki/api/v2/spaces`, envelope `{ results, _links: { next } }` like every other v2 collection.
Follow `confluence-attachments.ts`'s cursor handling — it already follows `_links.next` and bounds
the walk, and **that bound is not optional**: an unbounded cursor walk against a large site is a way
to hang a request thread. Reuse the bound rather than inventing a second one.

**Return only what the screen needs — id, key, name.** A space object carries far more, including
descriptions and permission hints, and this response crosses the tenant boundary into a browser.
The `status` route's output guard exists for exactly this reason; do not hand back an upstream
object wholesale.

This is a read, so `idempotent: true`.

- [ ] **Step 1: Write the failing tests** — a page of spaces is returned with only the three fields;
      a cursor is followed; the walk is bounded; the request is idempotent; an organisation with no
      live connection gets a clean refusal rather than a 500
- [ ] **Step 2: Run and watch fail; Step 3: implement; Step 4: run and watch pass**
- [ ] **Step 5: Verify by mutation** — remove the field projection and confirm the "only three
      fields" test fails alone; remove the cursor bound and confirm the bound test fails alone
- [ ] **Step 6: Commit** — `feat(confluence): list the spaces a charity could publish into`

---

### Task 3: Choose the space, and store the choice

**Files:**
- Modify: `apps/api/src/routes/integrations/index.ts` (a route to set the chosen space)
- Modify: `apps/api/prisma/schema.prisma` + a hand-written migration (new columns, see below)
- Create: `apps/api/src/services/confluence-publish-target.service.ts` — a small non-closed module
  owning **only** the chosen-space columns
- `confluence-connection.service.ts` stays **CLOSED**. Do not open it.
- Modify: `apps/web/src/app/(dashboard)/integrations/page.tsx` and its logic module
- Tests in both apps

**Design notes:**

**Publication cannot begin until a space is chosen.** An organisation that has connected but not
chosen is connected-but-not-publishing, and the screen must say so plainly — a charity that thinks
it is mirroring and is not is worse than one that knows it has a step left.

**Do NOT store the choice in `config`, and this is not a style preference.** I checked: every write
to `OrganisationIntegration` lives inside the closed connection service, and `connectConfluence`
builds a `connectingState` that **includes `config`** and spreads it into the upsert's `update`. So
a reconnect overwrites `config` wholesale.

Trace what that would mean. An administrator connects, chooses a space, documents publish. Something
goes wrong and they **reconnect — which is the recovery action our own error messages recommend**.
The chosen space is silently wiped, publication stops, and the integration still reads `CONNECTED`
with nothing explaining why. The schema comment on `config` does say "site id, space key", so this
trap is genuinely inviting.

**Use dedicated columns instead**, which `connectingState` does not touch and therefore survive a
reconnect by construction: `publishSpaceId`, `publishSpaceKey`, `publishSpaceName`.

**And record which site the space belongs to.** Space ids are per-site. A charity that reconnects to
a *different* Atlassian site must not keep a space id from the old one — it would aim publication at
a space that does not exist there. Store the site identity alongside (whatever identifies the site
in `config` today) and treat a mismatch as **no space chosen**, so the screen asks again. This is the
same reasoning that puts `cloudId` on the erasure row rather than resolving it live.

**Validate the chosen space against the ones actually listed.** Accepting an arbitrary id from the
browser lets a caller aim publication at a space the charity may not intend, and the id is later
baked into every page this pipeline creates.

**Changing the space later does not move what was already published.** Say so in the interface.
Previously published pages keep their `targetRef` and remain erasable exactly as recorded — which is
precisely why `cloudId` and `pageId` live on the row rather than being recomputed.

- [ ] **Step 1: Write the failing tests** — a valid space is stored; an id not in the listed set is
      refused; publication does not enqueue for an organisation with no chosen space; the screen
      states that connected-without-a-space is not yet publishing; **a reconnect to the same site
      keeps the chosen space**; **a reconnect to a different site reports no space chosen**
- [ ] **Step 2: Run and watch fail; Step 3: implement; Step 4: run and watch pass**
- [ ] **Step 5: Verify by mutation** — accept an unlisted id and confirm the refusal test fails alone
- [ ] **Step 6: Commit** — `feat(publish): a charity chooses where its documents are published`

---

### Task 4: Find a page by title

**Files:**
- Modify: `apps/api/src/services/confluence-pages.ts`
- Test: `apps/api/src/tests/confluence-pages.test.ts`

**Interfaces:**
- Produces: `findPageByTitle(client, spaceId, title): Promise<ConfluencePage | null>`

**Design notes:**

This is what makes adoption possible, and adoption is what makes a non-idempotent create safe to
put behind a retrying outbox.

**Verified against Atlassian's v2 documentation — use these, do not re-derive:**

| Fact | Value |
|---|---|
| Endpoint | `GET /wiki/api/v2/pages` |
| Title filter | `title` (string) |
| Space filter | `space-id` (**array of integer**) — note the hyphen and the array |
| Response envelope | `{ "results": [ … ], "_links": { "next": …, "base": … } }` |

The `space-id` parameter is documented as an array of **integers**, while this codebase carries ids
as strings. Check what the client actually serialises and what the API returns rather than assuming
they agree — and say in your report which form you found.

Follow `confluence-pages.ts`'s existing structure exactly: the same client parameter shape, the same
validation helpers, the same `idempotent: true` retry policy a read deserves. Put `title` and
`space-id` in the request spec's **`query`**, never the path — `assertValidPath` forbids `?`.

Return `null` for "no such page", exactly as `getPage` does for `CONFLUENCE_NOT_FOUND` — a caller
told `null` can adopt nothing and must create.

**More than one match must be an error, not a guess.** Raise a distinct code.

> **A second thing only a real site can settle.** Task 4 sends `space-id` as a **bare string**,
> because `ConfluenceRequestSpec.query` is `Record<string, string>` serialised through
> `URLSearchParams.set` — one value per key, no repeated or bracketed form — and every Confluence id
> in this codebase is already a string. Atlassian documents the parameter as an array of integers.
> If that filter is silently ignored, `findPageByTitle` would match on title across the **whole
> site** rather than within the chosen space. The ambiguity guard catches that case loudly (two
> spaces holding the same title yields two results, which raises), so the failure is safe — but it
> is still unverified. Confirm it when the app install lands.
>
> **An assumption worth naming.** The adopt-on-409 design rests on titles being unique within a
> space. Confluence's own use of 409 for a duplicate title strongly implies it, but **it is not
> stated on the v2 pages documentation and we have not verified it against a real site.** That is
> precisely why more than one match must raise rather than pick: if the assumption is wrong, we find
> out through a loud error instead of by silently attaching a charity's document to an arbitrary
> page. Add it to the phase's list of things to confirm when the Atlassian app install lands.

- [ ] **Step 1: Write the failing tests** — a match returns the page; no match returns `null`; two
      matches raise; the request is marked `idempotent: true`; the title is sent as a query
      parameter, not interpolated into the path (`assertValidPath` forbids `?`)
- [ ] **Step 2: Run and watch fail; Step 3: implement; Step 4: run and watch pass**
- [ ] **Step 5: Verify by mutation** — make two matches return the first and confirm that test fails
      alone
- [ ] **Step 6: Commit** — `feat(confluence): find a page by title, so a create can be adopted`

---

### Task 5: The document-to-page mapping

**Files:**
- Create: `apps/api/src/services/confluence-document-mapping.ts`
- Create: `apps/api/src/tests/confluence-document-mapping.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function publicationTitle(doc: { id: string; name: string }): string;
  export function publicationBody(doc: …): string;               // storage-format XHTML
  export const CHARITYPILOT_PROPERTY_KEY = 'charitypilot.governance';
  export function publicationProperty(doc: …): unknown;           // ≤ 32 KB, JSON
  ```

**Design notes — read all of this before writing the title function:**

**The title must be deterministic and collision-free.** Adoption depends on the same document always
producing the same title, and correctness depends on two *different* documents never producing the
same one. Include the document id. A title built from the name alone collides the moment a charity
has two documents called "Safeguarding Policy".

**Do not guess at the charity's own naming convention.** The DPO's Governance Hub reportedly uses
`POL -` / `NOS -` prefixes, and we have never seen it. Guessing produces pages that look native and
are subtly wrong. Provide the scheme as a single exported function with a documented shape, so
matching a real convention later is one edit in one place — and say so in a comment.

**The content property is indexing and integration metadata only.** Per the DPO's sign-off, the
definitive record of what a Board approved stays in CharityPilot. Put the CharityPilot document id,
the version, and enough to correlate — **not** the approval itself as the record of truth. Phase 3
enforces a 32 KB ceiling (`CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES`); stay well inside it and pin that
a large document's property still fits.

**The body must not become the document.** The attachment is the document. The page body is a
wrapper that displays it and links back to CharityPilot. Escape everything interpolated — a
document name is user input and this is XHTML.

- [ ] **Step 1: Write the failing tests** — determinism (same input, same title, twice); two
      documents with identical names get different titles; a name containing `<`, `&`, quotes and a
      control character is escaped in the body and does not break the property JSON; the property
      stays under the ceiling for a maximal document
- [ ] **Step 2: Run and watch fail; Step 3: implement; Step 4: run and watch pass**
- [ ] **Step 5: Verify by mutation** — drop the document id from the title and confirm the collision
      test fails alone; drop the escaping and confirm the injection test fails alone
- [ ] **Step 6: Commit** — `feat(publish): map a governance document onto a page, deterministically`

---

### Task 6: The publish worker

**Files:**
- Create: `apps/api/src/services/document-publication.service.ts`
- Create: `apps/api/src/jobs/publish-document-mirrors.ts`
- Create: `apps/api/src/tests/document-publication.service.test.ts`
- Modify: `apps/api/src/jobs/production-scheduler.ts` **and** `apps/api/src/jobs/cleanup-document-storage.ts`'s sibling registration pattern

**Interfaces:**
- Consumes: Task 4's `findPageByTitle`, Task 5's mapping, Phase 3's `createPage` / `uploadAttachment`
  / `setContentProperty`, Phase 2's `currentAccessTokenForOrganisation`, and
  `StorageService.downloadFile` to fetch the bytes.
- Produces: `retryPendingPublications(publish, limit)` mirroring
  `retryPendingStorageDeletions`'s shape, and a `targetRef` matching Phase 5's
  `ConfluenceErasureTarget` **exactly**: `{ kind: 'confluence', cloudId, pageId, attachmentIds }`.

**The sequence, and why each step is where it is:**

1. Claim the row (copy the existing claim/lease mechanics).
2. Resolve the access token. No live connection → **permanent**; retrying cannot reconnect.
3. `findPageByTitle`. Found → adopt. Not found → `createPage`; on 409 re-read once and adopt, or
   dead-letter.
4. Download the bytes from Supabase, `uploadAttachment`.
5. `setContentProperty` with the integration metadata.
6. Record `cloudId`, `spaceId`, `pageId`, `attachmentId`, `publishedAt`, mark `PROCESSED`.

**Record the page id the moment it is known — before the attachment upload.** If the process dies
between create and attach, the next attempt must adopt rather than create. A page id learned and
then lost is the one way this pipeline produces a duplicate.

**Validate the `targetRef` at write time with the same parser that reads it.** Phase 5's
`parseConfluenceErasureTarget` is the arbiter, and its `isNonEmptyString` requires
`value === value.trim()` — an id carrying stray whitespace is **refused**, and refused
*permanently*, because a malformed target cannot be repaired by retrying.

Consider where that lands if it is not checked here: the publish succeeds, the row reads
`PROCESSED`, and nothing is wrong until a charity asks for the document to be erased — at which
point the erasure dead-letters on a target this pipeline wrote badly, **after the Supabase copy is
already gone**. The failure would surface at the worst possible moment and blame the wrong phase.

So call `parseConfluenceErasureTarget` on what you are about to store. A publish that cannot produce
a valid target should fail *as a publish*, which is recoverable — the charity simply is not mirrored
yet — rather than silently arming a permanent erasure failure. Trim the ids you record. Pin this
with a test that an id with surrounding whitespace is rejected at publish time.

**Failure mapping** (mirror Phase 5's discipline, and pin both directions):

| Condition | Outcome |
|---|---|
| no live Confluence connection | **permanent** |
| 403 from create/attach (missing scope or space permission) | **permanent**, message naming what is missing |
| 409 on create with no page found on re-read | **permanent** |
| content property over the ceiling | **permanent** |
| transport, 5xx, 429, timeout | transient — normal backoff |

Honour the `AbortSignal` on every call, as Phase 5's eraser does. A publish that ignores the abort
keeps uploading after the row has recorded the attempt as timed out.

- [ ] **Step 1: Write the failing tests** — the happy path in order; an existing page is adopted and
      `createPage` is never called; a 409 followed by a successful re-read adopts and does **not**
      create twice; a 409 with nothing found dead-letters; each permanent condition dead-letters on
      the first attempt; a 503 and a timeout stay `PENDING`; an abort stops the sequence
- [ ] **Step 2: Run and watch fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run and watch pass**
- [ ] **Step 5: Register the job in BOTH entry points** — the standalone job and
      `production-scheduler.ts`. Phase 5 shipped a phase that was dead in production because only
      one was wired. **Pin each registration distinctly**, so removing either fails its own test.
- [ ] **Step 6: Verify by mutation** — remove the adopt path and confirm a duplicate-create test
      fails; move the page-id recording after the upload and confirm the crash-resume test fails
- [ ] **Step 7: Commit** — `feat(publish): publish a document to Confluence, adopting rather than duplicating`

---

### Task 7: Enqueue on upload

**Files:**
- Modify: `apps/api/src/services/document.service.ts` (the create path)
- Test: the existing documents-route and reliability suites

**Design notes:**

Enqueue a publication when, and only when, the organisation has a **`CONNECTED`** Confluence
integration **and a chosen space** (Task 3). Connecting is the opt-in; the space is the
destination, and without one there is nowhere to publish. There is still no separate alpha flag.

**Enqueueing must never fail an upload.** Portal upload is a guaranteed path and this integration is
alpha. If the publication row cannot be written, the document upload still succeeds; log it and move
on. **Pin that**: a test where the publication insert throws and the upload still returns success.

Use the same transaction the document create already opens where possible, but not at the cost of
the rule above — if joining the transaction means a publication failure rolls back the document,
do not join it.

- [ ] **Step 1: Write the failing tests** — a connected org gets a publication row; an org with no
      integration gets none; a `DISCONNECTED` integration gets none; a publication failure does not
      fail the upload
- [ ] **Step 2: Run and watch fail; Step 3: implement; Step 4: run and watch pass**
- [ ] **Step 5: Verify by mutation** — make the enqueue failure propagate and confirm the
      upload-still-succeeds test fails alone
- [ ] **Step 6: Commit** — `feat(publish): a connected charity's uploads queue for publication`

---

### Task 8: Dual erasure — close the gap Phase 5 left open

**Files:**
- Modify: `apps/api/src/services/document.service.ts` (`remove()`)
- Modify: `docs/ARCHITECTURE.md` (the erasure section corrected in Phase 5)
- Test: the deletion and cleanup suites

**Design notes:**

**This is the finding Phase 5's whole-phase review rated Critical.** `ARCHITECTURE.md` once claimed
the Confluence copy was erased alongside the Supabase one; it was not, because `remove()` creates
**one** row with **one** provider. Phase 5 corrected the documentation and recorded the requirement
here, because building it needed the authority decision that this plan has now taken.

Under the mirror model the answer is clear: a mirrored document has **two** places its bytes live,
so deleting it must enqueue **two** erasure rows —

- the existing `supabase` row, unchanged, and
- a `confluence` row carrying `targetRef` built from the publication record, in Phase 5's exact
  `ConfluenceErasureTarget` shape:

```ts
{ kind: 'confluence', cloudId: string, pageId: string, attachmentIds: string[] }
```

**Build it through `parseConfluenceErasureTarget` rather than by hand.** That function is the
arbiter — it refuses an empty or untrimmed id and its refusal is *permanent*. Passing your
constructed object through it here means a bad target fails while the document still exists and the
operator can act, instead of dead-lettering later when the Supabase copy is already gone.

Phase 5's dispatcher, permanence mapping, dead-lettering and operator recovery then handle it with
no further change. That is the payoff for having built the erasure side first.

**Only enqueue the second row if a publication actually succeeded.** A document that was never
published has nothing in Confluence to erase, and a Confluence erasure row for it would dead-letter
on a page that never existed — noise that trains an operator to ignore alerts.

- [ ] **Step 1: Write the failing tests** — a published document produces two rows with the right
      providers and a well-formed `targetRef`; an unpublished one produces only the Supabase row; a
      dead-lettered publication produces only the Supabase row
- [ ] **Step 2: Run and watch fail; Step 3: implement; Step 4: run and watch pass**
- [ ] **Step 5: Correct `docs/ARCHITECTURE.md`** — the erasure section may now say both copies are
      erased, because it is finally true. Say exactly what is true and no more: the Supabase erasure
      is provable, the Confluence one remains best-effort and bounded by permissions the charity
      controls.
- [ ] **Step 6: Verify by mutation** — remove the second enqueue and confirm the two-row test fails
      alone
- [ ] **Step 7: Commit** — `feat(erasure): deleting a mirrored document now erases both copies`

---

## Exit criteria

1. A document uploaded by a charity with Confluence connected appears in their site as a page with
   the file attached, and the publication row records where it went.
2. **A retried publish never produces a second page.** Adoption is pinned by a test that would fail
   if the adopt path were removed.
3. Deleting a mirrored document erases both copies, and Phase 5's proof applies to the Confluence one.
4. An upload never fails because publication failed.
5. **Confluence is still alpha.** Nothing here promotes it.

**None of criteria 1-3 can be verified against a real site until the Atlassian app install lands.**
Everything here is proven against fakes, and a fake cannot tell you Atlassian changed a status code
or that a title collides differently than assumed. **Say so in the final report.** The open question
about whether a trashed page reads back as 404 is still open and still matters to criterion 3.
