# Provider-Aware Erasure (Phase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make document erasure provider-aware, so that deleting a CharityPilot document also erases whatever it published into a charity's own Confluence site — and so that the platform reports honestly when it cannot.

**Architecture:** The existing deletion pipeline is already a provable-erasure state machine with a claim/backoff/dead-letter engine and a recovery audit trail, and its worker already injects the deleter as a callback. Phase 5 widens the *payload* and the *dispatch*, and leaves the engine alone. A deletion row gains a `provider` and an optional `targetRef`; the worker dispatches to a per-provider eraser; Confluence gets a two-stage delete-then-purge eraser that treats absence as success and permission refusal as terminal.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, Vitest, Confluence Cloud REST API v2.

**Spec:** `docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md`

## Why this phase gates alpha

Confluence cannot be promoted out of alpha until this ships. Until then, a charity that connects
Confluence can create governance documents in a system that CharityPilot cannot erase from —
which is precisely the situation the deletion pipeline exists to prevent.

## Global Constraints

- **Supabase `eu-west-1` (Ireland) remains authoritative.** Confluence is a published mirror. No
  task may make Confluence the system of record.
- **Portal upload must always work.** No integration may become the only way to get a document in.
- **Confluence stays alpha** through this entire phase. It is promoted only after Task 7.
- **Commit directly to `master`.** No worktrees, no feature branches.
- **Never** run `prisma migrate reset`, `migrate dev`, `db push`, `DROP`, or `TRUNCATE`. The
  development database holds real records. Hand-write migrations; apply with
  `npm run db:migrate:deploy`. Export first:
  `export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"`
- **Closed files** — do not modify without a stated reason: `integration-crypto.ts`,
  `integration-credential.service.ts`, `atlassian-oauth.ts`, `confluence-connection.service.ts`.
  Task 6 is explicitly authorised to open the last one, and only for the change named there.
- Any new Prisma model must be added to `DISPOSABLE_DATABASE_RESET_TABLES` in
  `e2e/helpers/db.ts`. This phase adds no new models, but Task 1 adds columns — check the guard
  anyway, because `npm run test:production-check` enforces it and the default `npm test` does not.

## Facts verified against Atlassian (do not re-derive; do not assume)

| Operation | Endpoint | Effect |
|---|---|---|
| Delete page | `DELETE /wiki/api/v2/pages/{id}` | Moves to **trash**, restorable by the tenant |
| Purge page | `DELETE /wiki/api/v2/pages/{id}?purge=true` | Permanent. **Only works on an already-trashed page.** Requires space *manage/content* permission |
| Delete attachment | `DELETE /wiki/api/v2/attachments/{id}` | Moves to **trash** |
| Purge attachment | `DELETE /wiki/api/v2/attachments/{id}?purge=true` | Permanent. Requires **administer space** permission |

Three consequences the design must respect:

1. **Purge needs a higher permission than delete**, and attachment purge needs the highest of all.
   A grant that can delete may be unable to purge. This is an ordinary outcome, not an edge case.
2. **Erasure is idempotent because absence is the goal.** `404` is **success** at every step. This
   is the exact inverse of Phase 3's create hazard, where a retried call duplicates a board
   resolution. It means the Confluence sequence needs no persisted sub-state and is safely
   restartable from step one after any crash.
3. **Do not rely on page deletion cascading to attachments.** Erase the attachment first, then the
   page. If cascade does happen, the attachment call 404s, which is already success.

## What erasure can and cannot prove (this is the honest part)

CharityPilot **can** prove: it issued delete and purge, and a subsequent read returned 404.

CharityPilot **cannot** prevent: a tenant's own Confluence administrators restoring the content
from trash in the window before purge, or refusing the permission that purge requires. The
charity's Confluence site is the charity's, not the platform's.

This is a real limit on a data subject's erasure request and it must be stated plainly to the
administrator connecting Confluence — not buried. Task 7 does that.

---

### Task 1: Erasure targets on the deletion row

Widen `DocumentStorageDeletion` so a row can name something other than a Supabase object, without
disturbing the Supabase rows already in the database.

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model `DocumentStorageDeletion`, ~line 898)
- Create: `apps/api/prisma/migrations/<timestamp>_document_storage_deletion_provider/migration.sql`
- Modify: `apps/api/src/services/document.service.ts` (the `DocumentStorageDeletionRecord` type
  ~line 20, and the `remove()` enqueue ~line 602)
- Test: `apps/api/src/tests/document-storage-cleanup.test.ts`

**Interfaces:**
- Produces: `DocumentStorageDeletionRecord` gains `provider: string` and
  `targetRef: unknown | null`. Task 2 dispatches on `provider`; Task 5 reads `targetRef`.

**Design notes — read before writing code:**

`storagePath` keeps its exact current meaning. Do **not** repurpose it. It appears in raw SQL in
three places in `document.service.ts` and carries the recovery route's `correctedStoragePath`
semantics; repointing it would put a live operator-facing recovery path at risk for no gain.
Confluence rows set `storagePath` to the Supabase path they mirror (they always have one, because
Supabase is authoritative) and carry the Confluence identifiers in `targetRef`.

`provider` is a **String**, not a Prisma enum, validated against the Phase 0 registry in
`document-storage-provider.ts`. `Organisation.documentStorageProvider` is already a String for
exactly this reason — adding a provider must not require a migration. An enum here would make the
schema inconsistent with itself.

- [ ] **Step 1: Write the failing test**

In `document-storage-cleanup.test.ts`:

```ts
it('defaults an enqueued deletion to the supabase provider with no target reference', async () => {
  const { service, prisma } = makeService();
  const { storageDeletionId } = await service.remove('org-1', 'doc-1');
  const row = await prisma.documentStorageDeletion.findUniqueOrThrow({
    where: { id: storageDeletionId },
  });
  expect(row.provider).toBe('supabase');
  expect(row.targetRef).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/tests/document-storage-cleanup.test.ts`
Expected: FAIL — `provider` does not exist on the row.

- [ ] **Step 3: Add the columns to the schema**

In `model DocumentStorageDeletion`, after `storagePath`:

```prisma
  provider                String                                      @default("supabase")
  targetRef               Json?
```

And add an index, because Task 2's dispatcher will want to find a provider's backlog:

```prisma
  @@index([provider, state, nextAttemptAt])
```

- [ ] **Step 4: Hand-write the migration**

Create the migration directory with a timestamp matching the house format used by the existing
migrations under `apps/api/prisma/migrations/`. The SQL is purely additive — every existing row
takes the default, so there is no backfill and no lock beyond the column add:

```sql
ALTER TABLE "DocumentStorageDeletion"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'supabase',
  ADD COLUMN "targetRef" JSONB;

CREATE INDEX "DocumentStorageDeletion_provider_state_nextAttemptAt_idx"
  ON "DocumentStorageDeletion"("provider", "state", "nextAttemptAt");
```

Note the index name is the one Prisma generates for `@@index([provider, state, nextAttemptAt])`.
If Prisma would truncate it, use the truncated form — the existing migrations show this repo has
hit index-name truncation before, and a mismatch shows up as permanent drift.

- [ ] **Step 5: Apply it**

```bash
cd apps/api && export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)" && npm run db:migrate:deploy && npx prisma generate
```

- [ ] **Step 6: Widen the record type and the claim select**

Add `provider: string;` and `targetRef: unknown | null;` to `DocumentStorageDeletionRecord`, and
add both to the `select` in `claimPendingStorageDeletions` so the worker actually receives them.
**Check every `select` that builds a `DocumentStorageDeletionRecord`** — a field absent from the
select arrives as `undefined` and TypeScript will not catch it through a Prisma delegate.

- [ ] **Step 7: Run the tests and the migration suite**

```bash
cd apps/api && npx vitest run && npm run test:migrations
```
Expected: PASS, with the new test green and no regression.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma apps/api/src && git commit -m "feat(erasure): a deletion row can name a provider and a target"
```

---

### Task 2: The erasure dispatcher

Replace the worker's single `deleteFile` callback with a provider-keyed dispatcher, without
changing Supabase behaviour at all.

**Files:**
- Create: `apps/api/src/services/document-erasure.ts`
- Create: `apps/api/src/tests/document-erasure.test.ts`
- Modify: `apps/api/src/services/document.service.ts` (`retryPendingStorageDeletions`,
  `runBoundedStorageDeletion`, and `isPermanentStorageDeletionFailure`)
- Modify: `apps/api/src/jobs/cleanup-document-storage.ts`

**Interfaces:**
- Consumes: `DocumentStorageDeletionRecord` from Task 1.
- Produces:
  ```ts
  export type ErasureTarget = {
    organisationId: string;
    storagePath: string;
    targetRef: unknown | null;
  };
  export type Eraser = (target: ErasureTarget, signal?: AbortSignal) => Promise<void>;
  export type ErasureDispatcher = (provider: string) => Eraser | undefined;
  ```
  Task 5 registers the Confluence eraser against this exact type.

**Design notes:**

An **unknown provider must not retry forever.** A row whose provider has no registered eraser is
unerasable by this deployment, and burning five attempts before dead-lettering just delays the
alert by hours while telling the operator nothing useful. It dead-letters immediately with a new
terminal reason, `PROVIDER_NOT_ERASABLE`.

`runBoundedStorageDeletion` keeps its abort/timeout wrapper exactly as it is. Only the thing it
calls changes.

- [ ] **Step 1: Write the failing tests**

```ts
it('routes a supabase row to the supabase eraser with its storage path', async () => {
  const seen: ErasureTarget[] = [];
  const dispatch: ErasureDispatcher = (p) =>
    p === 'supabase' ? async (t) => { seen.push(t); } : undefined;
  const { service } = makeServiceWithPending({ provider: 'supabase', storagePath: 'org-1/a.pdf' });
  const result = await service.retryPendingStorageDeletions(dispatch, 10);
  expect(result.processed).toBe(1);
  expect(seen).toEqual([{ organisationId: 'org-1', storagePath: 'org-1/a.pdf', targetRef: null }]);
});

it('dead-letters a row whose provider has no eraser, without burning attempts', async () => {
  const dispatch: ErasureDispatcher = () => undefined;
  const { service, prisma } = makeServiceWithPending({ provider: 'nonesuch' });
  const result = await service.retryPendingStorageDeletions(dispatch, 10);
  expect(result.newlyDeadLettered).toBe(1);
  const row = await prisma.documentStorageDeletion.findFirstOrThrow({});
  expect(row.state).toBe('DEAD_LETTER');
  expect(row.terminalReason).toBe('PROVIDER_NOT_ERASABLE');
  expect(row.attempts).toBe(1);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/tests/document-erasure.test.ts`
Expected: FAIL — `retryPendingStorageDeletions` still takes a `deleteFile`.

- [ ] **Step 3: Add the terminal reason**

Add `PROVIDER_NOT_ERASABLE` to the `DocumentStorageDeletionTerminalReason` enum in
`schema.prisma` and to the matching TypeScript union at the top of `document.service.ts`. A Prisma
enum change needs a migration:

```sql
ALTER TYPE "DocumentStorageDeletionTerminalReason" ADD VALUE 'PROVIDER_NOT_ERASABLE';
```

Apply as in Task 1, Step 5.

- [ ] **Step 4: Write the dispatcher module**

`document-erasure.ts` holds the types above plus:

```ts
export function createSupabaseEraser(
  deleteFile: (organisationId: string, storagePath: string, signal?: AbortSignal) => Promise<void>,
): Eraser {
  return (target, signal) => deleteFile(target.organisationId, target.storagePath, signal);
}

export function createErasureDispatcher(erasers: Record<string, Eraser>): ErasureDispatcher {
  return (provider) => Object.prototype.hasOwnProperty.call(erasers, provider)
    ? erasers[provider]
    : undefined;
}
```

The `hasOwnProperty` guard is not decoration — a bare `erasers[provider]` lookup returns
`Object.prototype`'s members for a provider string like `constructor` or `toString`, and would
hand the worker a function that is not an eraser. **Pin this with a test.**

- [ ] **Step 5: Change the signature and dispatch**

`retryPendingStorageDeletions(dispatch: ErasureDispatcher, limit = 25)`. Inside the loop, resolve
the eraser before the bounded call; if it is `undefined`, record a permanent failure carrying
`PROVIDER_NOT_ERASABLE` and `continue`. Extend `isPermanentStorageDeletionFailure` — or the
terminal-reason selection beside it — so the new reason survives to the row.

- [ ] **Step 6: Rewire the job**

In `cleanup-document-storage.ts`:

```ts
const dispatch = createErasureDispatcher({
  supabase: createSupabaseEraser((orgId, path, signal) =>
    storageService.deleteFile(orgId, path, signal)),
});
const result = await documentService.retryPendingStorageDeletions(dispatch, cleanupLimit());
```

- [ ] **Step 7: Run the whole suite**

Run: `cd apps/api && npx vitest run`
Expected: PASS. The Supabase path must be behaviourally unchanged — if any existing cleanup test
needed editing beyond the callback's shape, stop and say so in your report, because that means
behaviour moved when it should not have.

- [ ] **Step 8: Commit**

```bash
git add apps/api && git commit -m "feat(erasure): dispatch deletion by provider, refuse the unknown"
```

---

### Task 3: Confluence erasure primitives

Add delete and purge to the Phase 3 client. These files are **not** in the closed list.

**Files:**
- Modify: `apps/api/src/services/confluence-pages.ts`
- Modify: `apps/api/src/services/confluence-attachments.ts`
- Test: `apps/api/src/tests/confluence-pages.test.ts`,
  `apps/api/src/tests/confluence-attachments.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function deletePage(ctx: ConfluenceContext, pageId: string): Promise<void>;
  export async function purgePage(ctx: ConfluenceContext, pageId: string): Promise<void>;
  export async function deleteAttachment(ctx: ConfluenceContext, attachmentId: string): Promise<void>;
  export async function purgeAttachment(ctx: ConfluenceContext, attachmentId: string): Promise<void>;
  ```
  Match `ConfluenceContext` to whatever Phase 3's existing exported functions already take — read
  `createPage`'s signature and follow it exactly rather than inventing a parameter shape.

**Design notes:**

- **`404` resolves successfully.** Absence is the goal. Do not translate it to an error.
- **`403` on a purge is terminal**, not transient. Raise
  `AppError(403, 'CONFLUENCE_PURGE_FORBIDDEN', …)` with a message naming the permission required
  (space *manage/content* for pages, *administer space* for attachments) and stating that the
  content remains in the site's trash. This message reaches an operator; write it for them.
- **These operations are retryable**, unlike `createPage`. Use the retry policy Phase 3 applies to
  idempotent operations. If you find yourself copying the create path's policy, you have the wrong
  one — check `confluence-client.ts`'s asymmetric policy and pick the idempotent branch.
- Reuse Phase 3's `assertPageId` and the attachment module's id validation. Do not write new
  validators.

- [ ] **Step 1: Write the failing tests**

```ts
it('treats a 404 from delete as an accomplished erasure', async () => {
  const fetch = fakeFetch({ status: 404 });
  await expect(deletePage(ctx(fetch), '123')).resolves.toBeUndefined();
});

it('sends purge=true only on the purge call', async () => {
  const fetch = recordingFetch({ status: 204 });
  await deletePage(ctx(fetch), '123');
  await purgePage(ctx(fetch), '123');
  expect(fetch.calls[0].url).not.toContain('purge');
  expect(fetch.calls[1].url).toContain('purge=true');
});

it('raises a terminal, actionable error when purge is forbidden', async () => {
  const fetch = fakeFetch({ status: 403 });
  await expect(purgePage(ctx(fetch), '123')).rejects.toMatchObject({
    code: 'CONFLUENCE_PURGE_FORBIDDEN',
  });
});

it('does not retry a forbidden purge', async () => {
  const fetch = recordingFetch({ status: 403 });
  await purgePage(ctx(fetch), '123').catch(() => {});
  expect(fetch.calls).toHaveLength(1);
});
```

The last test is the one that matters most — it pins that a permission refusal does not consume
the retry budget. **Verify it by mutation:** make the purge path retryable and confirm this test,
and only this test, goes red.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/tests/confluence-pages.test.ts`
Expected: FAIL — the functions do not exist.

- [ ] **Step 3: Implement the four functions**

Follow the existing module's structure: validate the id, build the path, call the shared HTTP
core with the idempotent retry policy, map the status. Both purge variants append `?purge=true`.

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/tests/confluence-pages.test.ts src/tests/confluence-attachments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src && git commit -m "feat(confluence): delete and purge, where absence is success"
```

---

### Task 4: The target reference contract

Define the shape Phase 4's publish pipeline must write, and validate it at the boundary.

**Files:**
- Create: `apps/api/src/services/confluence-erasure-target.ts`
- Create: `apps/api/src/tests/confluence-erasure-target.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ConfluenceErasureTarget = {
    kind: 'confluence';
    cloudId: string;
    pageId: string;
    attachmentIds: string[];
  };
  export function parseConfluenceErasureTarget(value: unknown): ConfluenceErasureTarget;
  ```

**Design notes — this is the load-bearing decision of the phase:**

Phase 4 is blocked on the Atlassian app install, so it cannot tell us what it will write. Rather
than wait, **erasure dictates the shape to publish.** Phase 4 must populate a `targetRef` matching
this type. That direction is deliberate: letting the publish pipeline define the record and making
erasure chase it afterwards is exactly how unerasable data gets created.

`cloudId` is stored on the row rather than re-resolved from the organisation's live connection,
because a charity may disconnect, reconnect to a *different* site, and still be owed erasure from
the first. The row must remember where the bytes went.

`parseConfluenceErasureTarget` throws `AppError(500, 'ERASURE_TARGET_MALFORMED', …)` on anything
that does not match. A malformed target is permanent — it will not improve on retry — so Task 5
maps it to an immediate dead-letter.

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts a well-formed target', () => {
  expect(parseConfluenceErasureTarget({
    kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: ['a1'],
  })).toEqual({ kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: ['a1'] });
});

it('accepts a page with no attachments', () => {
  expect(parseConfluenceErasureTarget({
    kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: [],
  }).attachmentIds).toEqual([]);
});

it.each([
  ['null', null],
  ['a missing cloudId', { kind: 'confluence', pageId: 'p1', attachmentIds: [] }],
  ['a non-array attachmentIds', { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: 'a1' }],
  ['a non-string attachment id', { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: [1] }],
  ['the wrong kind', { kind: 'supabase', cloudId: 'c1', pageId: 'p1', attachmentIds: [] }],
])('refuses %s', (_label, value) => {
  expect(() => parseConfluenceErasureTarget(value)).toThrow(
    expect.objectContaining({ code: 'ERASURE_TARGET_MALFORMED' }),
  );
});
```

- [ ] **Step 2: Run and watch fail; Step 3: implement; Step 4: run and watch pass**

Run: `cd apps/api && npx vitest run src/tests/confluence-erasure-target.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src && git commit -m "feat(erasure): the shape publish must write so erasure can find it"
```

---

### Task 5: The Confluence eraser

Sequence the primitives into an eraser the dispatcher can register.

**Files:**
- Create: `apps/api/src/services/confluence-erasure.ts`
- Create: `apps/api/src/tests/confluence-erasure.test.ts`
- Modify: `apps/api/src/jobs/cleanup-document-storage.ts` (register it)
- Modify: `apps/api/src/services/document.service.ts` (permanent-failure predicate)

**Interfaces:**
- Consumes: `Eraser`/`ErasureTarget` (Task 2), the four primitives (Task 3),
  `parseConfluenceErasureTarget` (Task 4), and `currentAccessTokenForOrganisation` from
  `confluence-connection.service.ts` (read-only — do not modify that file in this task).
- Produces: `export function createConfluenceEraser(deps: …): Eraser;`

**The sequence, in order, and why:**

1. For each attachment id: `deleteAttachment`, then `purgeAttachment`.
2. Then `deletePage`, then `purgePage`.
3. Then `getPage` — a `404` is the proof of erasure. Anything else fails the attempt.

Attachments before the page, because page deletion may or may not cascade and an orphaned
attachment is a charity's document still sitting in their Confluence after an erasure request.
Delete before purge on each object, because purge only works on already-trashed content.

**Failure mapping:**

| Condition | Outcome |
|---|---|
| Any `404` | success, continue |
| `CONFLUENCE_PURGE_FORBIDDEN` | **permanent** — dead-letter, operator message names the permission and says the content sits in the site's trash |
| `ERASURE_TARGET_MALFORMED` | **permanent** — dead-letter |
| Organisation has no live Confluence connection | **permanent** — dead-letter. Retrying cannot reconnect it, and the honest statement is that the platform can no longer reach the site where the bytes are |
| Transport/5xx/timeout | transient — normal backoff |

- [ ] **Step 1: Write the failing tests**

```ts
it('erases attachments before the page, and trashes before purging each', async () => {
  const calls: string[] = [];
  const eraser = createConfluenceEraser(spyDeps(calls));
  await eraser(targetWith(['a1', 'a2']));
  expect(calls).toEqual([
    'deleteAttachment:a1', 'purgeAttachment:a1',
    'deleteAttachment:a2', 'purgeAttachment:a2',
    'deletePage:p1', 'purgePage:p1',
    'getPage:p1',
  ]);
});

it('treats a 404 verification read as proof of erasure', async () => {
  const eraser = createConfluenceEraser(depsWhereGetPageIs404());
  await expect(eraser(target())).resolves.toBeUndefined();
});

it('fails the attempt when the page still reads back after purge', async () => {
  const eraser = createConfluenceEraser(depsWhereGetPageStillReturnsThePage());
  await expect(eraser(target())).rejects.toMatchObject({ code: 'CONFLUENCE_ERASURE_UNVERIFIED' });
});

it('is permanent when purge is forbidden, and says which permission is missing', async () => {
  const eraser = createConfluenceEraser(depsWherePurgeIs403());
  const error = await eraser(target()).catch((e) => e);
  expect(isPermanentStorageDeletionFailure(error)).toBe(true);
  expect(String(error.message)).toMatch(/administer space|manage.content/i);
});

it('is permanent when the organisation has no live connection', async () => {
  const eraser = createConfluenceEraser(depsWithNoConnection());
  const error = await eraser(target()).catch((e) => e);
  expect(isPermanentStorageDeletionFailure(error)).toBe(true);
});

it('restarts cleanly after a crash midway, because every step is idempotent', async () => {
  const deps = depsWhereEverythingIsAlready404();
  const eraser = createConfluenceEraser(deps);
  await expect(eraser(targetWith(['a1']))).resolves.toBeUndefined();
});
```

The last test is the one that justifies having no persisted sub-state. **Verify it by mutation:**
make any single step treat `404` as a failure and confirm it goes red.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement the eraser**

Honour the `AbortSignal` the bounded runner passes — thread it into every call. An erasure that
ignores the abort keeps running after the attempt has been recorded as timed out, and can purge
content while the row says the attempt failed.

- [ ] **Step 4: Extend the permanent-failure predicate**

`isPermanentStorageDeletionFailure` must return `true` for `CONFLUENCE_PURGE_FORBIDDEN`,
`ERASURE_TARGET_MALFORMED`, and the no-connection code. Add a test that each is permanent **and**
that `CONFLUENCE_ERASURE_UNVERIFIED` and a 503 are **not** — a predicate that returns `true` for
everything would pass a one-sided test.

- [ ] **Step 5: Register it in the job**

```ts
const dispatch = createErasureDispatcher({
  supabase: createSupabaseEraser(...),
  confluence: createConfluenceEraser({ prisma, ... }),
});
```

- [ ] **Step 6: Run the whole suite**

Run: `cd apps/api && npx vitest run`

- [ ] **Step 7: Commit**

```bash
git add apps/api && git commit -m "feat(erasure): erase the Confluence mirror, and prove it by reading back"
```

---

### Task 6: Revoke the grant at Atlassian on disconnect

Close the gap recorded in the spec's Phase 5 note: `disconnectConfluence` deletes the local
credentials but never tells Atlassian, so the refresh token stays live at the identity provider
until it expires on its own.

**This task is explicitly authorised to modify `confluence-connection.service.ts`**, which is
otherwise closed. Change nothing in that file beyond what this task names, and say in your report
exactly what you touched.

**Files:**
- Modify: `apps/api/src/services/confluence-connection.service.ts` (`disconnectConfluence` only)
- Modify: `apps/api/src/tests/confluence-connection.service.test.ts`

**Design notes:**

The local deletion must **not** become conditional on the remote revocation succeeding. If
Atlassian is unreachable, the charity has still asked to disconnect, and refusing to forget their
credentials because a third party is down is the wrong failure. Revoke first on a **best-effort,
bounded** basis; delete locally regardless; record the revocation outcome.

Bound the revoke call with the same `CONNECT_REQUEST_TIMEOUT_MS` the connect path uses — a person
is waiting on a browser tab here too.

- [ ] **Step 1: Write the failing tests**

```ts
it('revokes the grant at Atlassian before forgetting it locally', async () => {
  const { revokes, prisma } = await disconnectWith({ revokeSucceeds: true });
  expect(revokes).toHaveLength(1);
  expect(await prisma.integrationCredential.count()).toBe(0);
});

it('still forgets the credentials locally when revocation fails', async () => {
  const { prisma, result } = await disconnectWith({ revokeSucceeds: false });
  expect(await prisma.integrationCredential.count()).toBe(0);
  expect(result.revoked).toBe(false);
});

it('does not let a hanging revoke hold the disconnect open', async () => {
  const result = await disconnectWith({ revokeHangs: true });
  expect(result.revoked).toBe(false);
});
```

- [ ] **Step 2: Run and watch fail; Step 3: implement; Step 4: run and watch pass**

- [ ] **Step 5: Verify by mutation**

Make the local delete conditional on revocation success and confirm the second test goes red.
Remove the timeout bound and confirm the third hangs. Report both.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src && git commit -m "fix(confluence): disconnecting now tells Atlassian, but never depends on it"
```

---

### Task 7: State plainly what erasure can and cannot prove

Documentation and the alpha warning. This is the task that lets Confluence leave alpha, so it is
not optional polish.

**Files:**
- Modify: `docs/ARCHITECTURE.md` (new section, after the integration-credentials section)
- Modify: `docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md` (resolve the
  Phase 5 note about `disconnectConfluence`)
- Modify: the connect route's response or the provider registry's alpha copy, so an administrator
  enabling Confluence sees the limit **before** connecting, not in a footnote

**Content the documentation must carry — do not soften it:**

- Erasure from Confluence is delete-then-purge, verified by a read-back that must 404.
- Between delete and purge, and after a purge that was refused, the content is in the **tenant's
  own trash**, restorable by **their** administrators. CharityPilot cannot prevent that.
- Purge requires a higher permission than delete (space *manage/content* for pages, *administer
  space* for attachments). A connected site may be unable to purge at all, and the platform will
  report that as a dead-lettered erasure requiring a human with those rights.
- Supabase `eu-west-1` remains authoritative. A Confluence mirror is a copy, and the erasure
  guarantee for the **record** is the Supabase one; the Confluence guarantee is best-effort and
  bounded by permissions the charity controls.
- For a data subject erasure request under GDPR, this distinction is the material one: state it in
  terms a DPO can act on.

- [ ] **Step 1: Write the ARCHITECTURE.md section**
- [ ] **Step 2: Resolve the spec's Phase 5 note**, pointing at Task 6's commit
- [ ] **Step 3: Surface the limit at the connect boundary**
- [ ] **Step 4: Run `npm run test:production-check`** — it checks documentation invariants
- [ ] **Step 5: Commit**

```bash
git add docs apps/api && git commit -m "docs(erasure): what the platform can prove, and what it cannot"
```

---

## Exit criteria for the phase

Confluence may be promoted from alpha to GA when, and only when:

1. Every task above is complete and the whole-branch review is clean.
2. An erasure of a published document removes the attachment and the page, and a read-back 404s.
3. A purge refused for permissions dead-letters with a message an operator can act on, rather than
   silently leaving content in trash.
4. Disconnecting revokes the grant at Atlassian.
5. The limits in Task 7 are documented and shown to the administrator before they connect.

Item 2 cannot be verified against a real site until the Atlassian app install unblocks Phase 4.
Until then this phase is verified against fakes, and **that fact must be stated in the report** —
a fake cannot tell you Atlassian changed a status code.
