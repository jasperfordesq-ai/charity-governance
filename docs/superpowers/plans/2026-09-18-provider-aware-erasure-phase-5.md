# Provider-Aware Erasure (Phase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make document erasure provider-aware, so that deleting a CharityPilot document also erases whatever it published into a charity's own Confluence site — and so that the platform reports honestly when it cannot.

**Architecture:** The existing deletion pipeline is already a provable-erasure state machine with a claim/backoff/dead-letter engine and a recovery audit trail, and its worker already injects the deleter as a callback. Phase 5 widens the *payload* and the *dispatch*, and leaves the engine alone. A deletion row gains a `provider` and an optional `targetRef`; the worker dispatches to a per-provider eraser; Confluence gets a two-stage delete-then-purge eraser that treats absence as success and permission refusal as terminal.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, `node:test`, Confluence Cloud REST API v2.

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

## Testing conventions in this repository — read before writing a single test

**There is no Vitest here.** It is not a dependency and `npx vitest` will not run. All 111 test
files use the Node built-in runner:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

test('a sentence describing the behaviour, not the function name', async () => {
  assert.equal(actual, expected);
  assert.ok(condition, 'message shown when it fails');
  await assert.rejects(() => thing(), (e: unknown) => (e as AppError).code === 'SOME_CODE');
});
```

There is no `describe`, no `it`, no `expect`, and no `it.each`. For table-driven cases, loop over
an array and call `test()` inside the loop, or use `t.test()` subtests.

**Tests run from `dist/`, not from source.** `npm test` compiles with `tsc` first and then runs
`node --test dist/tests/*.test.js`. A single file is therefore:

```bash
cd apps/api && npm run build && node --test dist/tests/<name>.test.js
```

If you edit a test and re-run without rebuilding, you are running the previous version. This has
bitten this project before.

**For mutation testing, skip the build entirely.** The Phase 3 whole-branch reviewer worked this
out and it is now the house method: copy `apps/api/src` into your scratchpad, junction
`node_modules` rather than copying it, and run

> Junction the **repository root's** `node_modules`, not `apps/api/node_modules`. This is a hoisted
> monorepo and the inner one has neither `tsx` nor `typescript`.

```bash
node --import tsx --test src/tests/*.test.ts
```

Mutations take effect immediately, so no result can rest on a `tsc` run that silently ignored your
edit, and the working tree is never touched.

**Always re-check a green mutation with a canary.** Replace the same line with an unconditional
`throw` and run again. If that is *also* green, the line is never executed by any test — the guard
is not weakly tested, it has zero coverage. A green mutation on its own cannot tell those apart.
This distinction found the two most serious findings in Phase 3, one of which was a security guard
protecting the single endpoint that carries a charity's signed policy file.

**The unit suites use hand-built fake Prisma delegates, not a database.**
`document-storage-cleanup.test.ts` builds one with `pendingRecord()` and `buildFallbackPrisma()`.
Extend those helpers rather than reaching for a live client — and when you add a field to
`DocumentStorageDeletionRecord`, add it to `pendingRecord()` too, or every existing test in that
file silently exercises a row shape the production code no longer sees.

**When you widen a row type, audit everything that *fabricates* that shape — not just every
`select`.** These are not the same instruction, and the difference has already cost this phase a
defect. Task 1 correctly audited every Prisma `select` and its review confirmed the audit complete;
both missed a hand-written `$queryRaw` fake row in `idempotency-reliability.test.ts`, which would
have dispatched on `undefined`. Search for raw-query fakes, fixture factories, and any literal that
is cast to the record type — a cast is a promise the compiler will not check for you.

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
Confluence rows carry the Confluence identifiers in `targetRef`.

> **Unresolved above this plan — do not design around either answer.**
> The spec assumes Mode C: Supabase authoritative, Confluence a published *mirror*, so every
> Confluence row has a Supabase twin and `storagePath` is always meaningful. The spec itself lists
> "does Nikita accept that Confluence is a published mirror, not the system of record?" as an open
> question. It has since been answered, and **not** in Mode C's favour: the DPO signed off on
> 2026-09-18 on Confluence being authoritative for the documents deliberately managed there, with
> CharityPilot holding *references, explicitly not duplicate copies*.
>
> Those two cannot both be true, and the difference is not cosmetic — it decides whether a
> charity's policy document is guaranteed to sit in Ireland.
>
> **What this task must therefore do:** treat `storagePath` as meaningful *only* for rows whose
> provider actually uses it. Do not add code, tests, or comments anywhere in this phase that assume
> a Confluence row has a usable Supabase path. The Confluence eraser in Task 5 reads `targetRef`
> and nothing else, which keeps this phase correct under either answer. Flag any place you are
> tempted to reach for `storagePath` on a Confluence row — that temptation is the bug.

`provider` is a **String**, not a Prisma enum, validated against the Phase 0 registry in
`document-storage-provider.ts`. `Organisation.documentStorageProvider` is already a String for
exactly this reason — adding a provider must not require a migration. An enum here would make the
schema inconsistent with itself.

- [ ] **Step 1: Write the failing test**

In `document-storage-cleanup.test.ts`:

```ts
test('an enqueued deletion is stamped with the organisation resolved provider', async () => {
  for (const provider of ['supabase', 'local'] as const) {
    const created: Array<Record<string, unknown>> = [];
    const prisma = buildEnqueueCapturingPrisma(created, { documentStorageProvider: provider });
    const service = new DocumentService(prisma as never, () => NOW);

    await service.remove('org-1', 'doc-1');

    assert.equal(created.length, 1);
    assert.equal(created[0].provider, provider);
    assert.equal(created[0].targetRef ?? null, null);
  }
});

test('an organisation with no explicit provider falls back to the deployment default', async () => {
  const previous = process.env.DOCUMENT_STORAGE_DRIVER;
  try {
    for (const [driver, expected] of [['local', 'local'], [undefined, 'supabase']] as const) {
      if (driver === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
      else process.env.DOCUMENT_STORAGE_DRIVER = driver;

      const created: Array<Record<string, unknown>> = [];
      const prisma = buildEnqueueCapturingPrisma(created, { documentStorageProvider: null });
      await new DocumentService(prisma as never, () => NOW).remove('org-1', 'doc-1');

      assert.equal(created[0].provider, expected);
    }
  } finally {
    if (previous === undefined) delete process.env.DOCUMENT_STORAGE_DRIVER;
    else process.env.DOCUMENT_STORAGE_DRIVER = previous;
  }
});
```

Pin `DOCUMENT_STORAGE_DRIVER` on both halves and restore it in a `finally` rather than asserting
against whatever the ambient environment happens to hold — an assertion that reads the same
variable the code reads passes no matter what either of them says. Note `envDefaultProviderId`
takes an optional **registry**, not an env object, and reads `process.env` itself.

`buildEnqueueCapturingPrisma` does not exist yet — write it beside `buildFallbackPrisma`, capturing
the `data` passed to `documentStorageDeletion.create`. Keep it in the same style as the existing
fakes in that file rather than introducing a mocking library.

**Do not hardcode `'supabase'` here.** `local` is also a GA provider in
`document-storage-provider.ts`, so a hardcoded literal silently mislabels every deletion on a
local-storage deployment — harmless while both share one deleter, and a real defect the moment
Task 2's dispatcher starts taking `provider` at its word. Stamp what the organisation actually
resolves to, reusing the existing resolution in `document-storage-resolution.ts` rather than
reimplementing it. Prefer not to change `DocumentService`'s constructor signature if the
organisation's setting can be read inside the transaction `remove()` already opens; if a
constructor change is genuinely the only clean route, say so in your report rather than working
around it.

The spec's Phase 0 note says a document should carry *the provider it was actually written to*.
`Document` has no such column yet, and the spec states the standing mitigation: changing an
organisation's provider while it holds documents is not a supported operation. Resolving at delete
time is therefore the best available answer and is correct under that precondition — but say so in
a comment, so the next reader does not mistake it for the stamp the spec asks for.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npm run build && node --test dist/tests/document-storage-cleanup.test.js`
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
cd apps/api && npm test
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
- Modify: `apps/api/src/jobs/production-scheduler.ts` — **the other caller of
  `retryPendingStorageDeletions`, and the one that actually runs in production.** It needs the same
  wiring. It will not compile without it, so this is self-correcting, but do not assume the
  standalone cleanup job is the only entry point.
- Modify: `apps/api/src/jobs/recover-document-storage-deletion.ts` — it holds a **closed**
  `TerminalReason` union and a `TERMINAL_REASONS` validation set. Add the new value to both. Without
  it `tsc` fails, and — the part that matters — the operator recovery CLI refuses
  `--expected-terminal-reason PROVIDER_NOT_ERASABLE`, leaving such a row unrecoverable by the only
  tool permitted to touch it. A dead-letter nobody can clear is worse than no dead-letter state.

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
unerasable by this deployment, and burning the full attempt budget before dead-lettering just
delays the alert by hours while telling the operator nothing useful. It dead-letters on the
**first** attempt with a new terminal reason, `PROVIDER_NOT_ERASABLE`. The attempt counter still
moves to 1 — an attempt was genuinely made and the audit trail should say so; what changes is that
it does not wait for five.

`runBoundedStorageDeletion` keeps its abort/timeout wrapper exactly as it is. Only the thing it
calls changes.

**There is now a second source of the same failure, added by Task 1.** `StorageService.deleteFile`
and `downloadFile` refuse a provider they have no backend for, with
`STORAGE_DELETE_PROVIDER_UNSUPPORTED` and `STORAGE_DOWNLOAD_PROVIDER_UNSUPPORTED`. Task 1 added
those because the dispatch there was a `provider === 'local' ? local : supabase` else-fallthrough:
once erasure stopped refusing unknown providers, a `confluence` row would have reached the
**Supabase** branch, deleted nothing, reported success, and marked the row `PROCESSED` — a false
proof of erasure, which is the worst outcome this pipeline can produce.

Until this task lands, those refusals burn the full attempt budget and dead-letter as
`MAX_ATTEMPTS_EXHAUSTED`. **Map them to `PROVIDER_NOT_ERASABLE` too**, alongside the dispatcher's
own unknown-provider case. They are the same condition — this deployment has no way to erase these
bytes — reported one layer down, and retrying cannot acquire a backend any more than it can
acquire a permission. Pin it: a test that each code dead-letters on the first attempt with that
reason.

- [ ] **Step 1: Write the failing tests**

```ts
test('a supabase row is routed to the supabase eraser with its storage path', async () => {
  const seen: ErasureTarget[] = [];
  const dispatch: ErasureDispatcher = (provider) =>
    provider === 'supabase' ? async (target) => { seen.push(target); } : undefined;
  const prisma = buildFallbackPrisma(
    pendingRecord({ provider: 'supabase', storagePath: 'org-1/a.pdf', targetRef: null }),
  );
  const service = new DocumentService(prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(dispatch, 10);

  assert.equal(result.processed, 1);
  assert.deepEqual(seen, [
    { organisationId: 'org-1', storagePath: 'org-1/a.pdf', targetRef: null },
  ]);
});

test('a row whose provider has no eraser dead-letters on the first attempt', async () => {
  const dispatch: ErasureDispatcher = () => undefined;
  const prisma = buildFallbackPrisma(pendingRecord({ provider: 'nonesuch' }));
  const service = new DocumentService(prisma as never, () => NOW);

  const result = await service.retryPendingStorageDeletions(dispatch, 10);

  assert.equal(result.newlyDeadLettered, 1);
  assert.equal(prisma.row().state, 'DEAD_LETTER');
  assert.equal(prisma.row().terminalReason, 'PROVIDER_NOT_ERASABLE');
  assert.equal(prisma.row().attempts, 1);
});

test('the dispatcher does not mistake an inherited property for an eraser', () => {
  const dispatch = createErasureDispatcher({});
  assert.equal(dispatch('constructor'), undefined);
  assert.equal(dispatch('toString'), undefined);
  assert.equal(dispatch('__proto__'), undefined);
});
```

`buildFallbackPrisma` already exists in `document-storage-cleanup.test.ts`; expose the current row
from it (or read it however that file already does) rather than inventing a new fake. Add
`provider` and `targetRef` to `pendingRecord()`'s defaults in the same commit.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npm run build && node --test dist/tests/document-erasure.test.js`
Expected: FAIL — `retryPendingStorageDeletions` still takes a `deleteFile`.

- [ ] **Step 3: Add the terminal reason**

Add `PROVIDER_NOT_ERASABLE` to the `DocumentStorageDeletionTerminalReason` enum in
`schema.prisma` and to the matching TypeScript union at the top of `document.service.ts`. A Prisma
enum change needs a migration:

```sql
ALTER TYPE "DocumentStorageDeletionTerminalReason"
    ADD VALUE IF NOT EXISTS 'PROVIDER_NOT_ERASABLE';
```

**`IF NOT EXISTS` is not optional here, and the pattern choice is not free.** This repository has
already been bitten by the underlying PostgreSQL rule, and
`prisma/migrations/20260710190000_add_deadline_calendar_lifecycle/migration.sql` records it
verbatim: PostgreSQL rejects *use* of a newly-added enum value before commit when a multi-statement
migration runs as one simple query. So the house has two patterns, and they are not interchangeable:

| Situation | Pattern |
|---|---|
| The new value is **used** later in the same migration (a backfill, a `WHERE`, a default) | Rebuild the enum: `ALTER TYPE … RENAME TO …_legacy`, `CREATE TYPE` with the full value list, repoint the columns, `DROP TYPE …_legacy`. See the deadline-calendar migration. |
| The new value is **only declared**, and first used later by application code | `ADD VALUE IF NOT EXISTS`. See `20260831000000_add_owner_provisioned_recovery_source`. |

This task is the second case — nothing in the migration itself writes the new value — so
`ADD VALUE IF NOT EXISTS` is correct. Do not reach for the rebuild. Without `IF NOT EXISTS`, a
re-run against an already-migrated database fails.

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

Run: `cd apps/api && npm test`
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
  validators — but **do give an attachment id its own error code**. Reusing `assertPageId`
  wholesale makes a malformed *attachment* id surface as `CONFLUENCE_PAGE_ID_INVALID`: the right
  shape check wearing the wrong label, read later by an operator diagnosing a failed erasure of a
  charity's document. A thin wrapper around the same check is not a new validator.
- Both purge variants carry `purge=true` in the request spec's **`query`**, not in its `path`.
  `assertValidPath` forbids `?` outright, so a query string in the path cannot work; `query` is the
  mechanism `listAttachments` already uses.

- [ ] **Step 1: Write the failing tests**

Follow the existing structure of `confluence-pages.test.ts`, which drives a fake `ConfluenceClient`
and inspects the captured `ConfluenceRequestSpec`:

```ts
test('a 404 from delete is an accomplished erasure, not a failure', async () => {
  const client = clientReturning({ status: 404 });
  await deletePage(client, '123');   // resolves; the absence is the point
});

test('purge=true is sent on the purge call and on no other', async () => {
  const specs: ConfluenceRequestSpec[] = [];
  const client = capturingClient(specs, { status: 204 });
  await deletePage(client, '123');
  await purgePage(client, '123');
  assert.equal(specs.length, 2);
  assert.equal(specs[0].query?.purge, undefined, 'delete must not purge');
  assert.equal(specs[1].query?.purge, 'true', 'purge must ask for it explicitly');
});

test('a forbidden purge names the permission the grant is missing', async () => {
  const client = clientReturning({ status: 403 });
  await assert.rejects(
    () => purgePage(client, '123'),
    (error: unknown) => (error as AppError).code === 'CONFLUENCE_PURGE_FORBIDDEN',
  );
});

test('delete and purge are issued as idempotent, unlike createPage', async () => {
  const specs: ConfluenceRequestSpec[] = [];
  const client = capturingClient(specs, { status: 204 });
  await deletePage(client, '123');
  await purgePage(client, '123');
  assert.equal(specs[0].idempotent, true);
  assert.equal(specs[1].idempotent, true);
});
```

Phase 3 expresses its asymmetric retry policy through `spec.idempotent` — see
`createPage is issued as non-idempotent so a 429 or a dropped connection cannot duplicate a page`
in the existing test file. The last test above is the mirror of that one and is the one that
matters most here: erasure is safe to retry precisely because absence is idempotent.
**Verify it by mutation:** set `idempotent: false` on the delete path and confirm that test, and
only that test, goes red.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npm run build && node --test dist/tests/confluence-pages.test.js`
Expected: FAIL — the functions do not exist.

- [ ] **Step 3: Implement the four functions**

Follow the existing module's structure: validate the id, build the path, call the shared HTTP
core with the idempotent retry policy, map the status. Both purge variants append `?purge=true`.

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npm run build && node --test dist/tests/confluence-pages.test.js dist/tests/confluence-attachments.test.js`
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
test('a well-formed target survives the round trip', () => {
  const value = { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: ['a1'] };
  assert.deepEqual(parseConfluenceErasureTarget(value), value);
});

test('a page with no attachments is well-formed', () => {
  assert.deepEqual(
    parseConfluenceErasureTarget(
      { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: [] },
    ).attachmentIds,
    [],
  );
});

for (const [label, value] of [
  ['null', null],
  ['a missing cloudId', { kind: 'confluence', pageId: 'p1', attachmentIds: [] }],
  ['a string attachmentIds', { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: 'a1' }],
  ['a non-string attachment id', { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: [1] }],
  ['the wrong kind', { kind: 'supabase', cloudId: 'c1', pageId: 'p1', attachmentIds: [] }],
  ['an empty pageId', { kind: 'confluence', cloudId: 'c1', pageId: '', attachmentIds: [] }],
] as const) {
  test(`${label} is refused`, () => {
    assert.throws(
      () => parseConfluenceErasureTarget(value),
      (error: unknown) => (error as AppError).code === 'ERASURE_TARGET_MALFORMED',
    );
  });
}
```

Note the loop rather than `it.each` — see the testing conventions above. The empty-`pageId` case is
there because a `targetRef` that parses but names nothing would make the eraser call
`DELETE /pages/` and report success against whatever that resolves to.

- [ ] **Step 2: Run and watch fail; Step 3: implement; Step 4: run and watch pass**

Run: `cd apps/api && npm run build && node --test dist/tests/confluence-erasure-target.test.js`

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
test('attachments are erased before the page, and each is trashed before it is purged', async () => {
  const calls: string[] = [];
  const eraser = createConfluenceEraser(spyDeps(calls));

  await eraser(targetWith(['a1', 'a2']));

  assert.deepEqual(calls, [
    'deleteAttachment:a1', 'purgeAttachment:a1',
    'deleteAttachment:a2', 'purgeAttachment:a2',
    'deletePage:p1', 'purgePage:p1',
    'getPage:p1',
  ]);
});

test('a 404 on the verification read is the proof of erasure', async () => {
  const eraser = createConfluenceEraser(depsWhereGetPageIs404());
  await eraser(target());
});

test('an attempt fails when the page still reads back after the purge', async () => {
  const eraser = createConfluenceEraser(depsWhereGetPageStillReturnsThePage());
  await assert.rejects(
    () => eraser(target()),
    (error: unknown) => (error as AppError).code === 'CONFLUENCE_ERASURE_UNVERIFIED',
  );
});

test('a forbidden purge names the permission the grant is missing', async () => {
  const eraser = createConfluenceEraser(depsWherePurgeIs403());
  await assert.rejects(
    () => eraser(target()),
    (error: unknown) => {
      const e = error as AppError;
      assert.equal(e.code, 'CONFLUENCE_PURGE_FORBIDDEN');
      assert.match(e.message, /administer space|manage.content/i);
      return true;
    },
  );
});

test('the sequence restarts cleanly after a crash, because every step is idempotent', async () => {
  const eraser = createConfluenceEraser(depsWhereEverythingIsAlready404());
  await eraser(targetWith(['a1']));
});

test('an aborted attempt stops issuing calls', async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const eraser = createConfluenceEraser(spyDepsAbortingAfter(calls, controller, 1));
  await assert.rejects(() => eraser(targetWith(['a1', 'a2']), controller.signal));
  assert.ok(calls.length < 7, `expected the abort to stop the sequence, got ${calls.join(', ')}`);
});
```

The last test is the one that justifies having no persisted sub-state. **Verify it by mutation:**
make any single step treat `404` as a failure and confirm it goes red.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement the eraser**

Honour the `AbortSignal` the bounded runner passes — thread it into every call. An erasure that
ignores the abort keeps running after the attempt has been recorded as timed out, and can purge
content while the row says the attempt failed.

- [ ] **Step 4: Extend the permanent-failure predicate, and test it through the real path**

`isPermanentStorageDeletionFailure` (in `document.service.ts`, ~line 233) must return `true` for
`CONFLUENCE_PURGE_FORBIDDEN`, `ERASURE_TARGET_MALFORMED`, and the no-connection code.

**It is module-private, and it must stay that way.** Do not export it to make it testable —
widening a sensitive module's surface for test convenience is how that surface stops meaning
anything. Test the behaviour through `retryPendingStorageDeletions` with a stub eraser that throws
each error kind, and assert the row's observable outcome. This is also how Task 2 already tests the
same engine, so the two sets of tests read alike:

```ts
for (const [label, thrown, expectedState] of [
  ['a forbidden purge', new AppError(403, 'CONFLUENCE_PURGE_FORBIDDEN', 'x'), 'DEAD_LETTER'],
  ['a malformed target', new AppError(500, 'ERASURE_TARGET_MALFORMED', 'x'), 'DEAD_LETTER'],
  ['no live connection', new AppError(409, 'CONFLUENCE_NOT_CONNECTED', 'x'), 'DEAD_LETTER'],
  ['an unverified erasure', new AppError(502, 'CONFLUENCE_ERASURE_UNVERIFIED', 'x'), 'PENDING'],
  ['an upstream outage', new AppError(503, 'CONFLUENCE_UPSTREAM', 'x'), 'PENDING'],
] as const) {
  test(`${label} leaves the row ${expectedState}`, async () => {
    const prisma = buildFallbackPrisma(pendingRecord({ provider: 'confluence' }));
    const service = new DocumentService(prisma as never, () => NOW);

    await service.retryPendingStorageDeletions(() => async () => { throw thrown; }, 10);

    assert.equal(prisma.row().state, expectedState);
    assert.equal(prisma.row().attempts, 1);
  });
}
```

The last two rows are the ones that give the first three their meaning. A predicate that returned
`true` for everything would satisfy a one-sided test and would silently stop retrying a transient
Atlassian outage — turning a five-minute blip into a permanent dead-letter that a human has to
clear by hand.

- [ ] **Step 5: Refuse a non-Supabase row at the operator recovery route**

`recoverDeadLetterStorageDeletion` is a **Supabase-only** operator route: its whole vocabulary is
`correctedStoragePath`, and it has no notion of a Confluence page. Until this task, no non-Supabase
row could reach `DEAD_LETTER`, so the route was safe by absence. This task is what breaks that —
`CONFLUENCE_PURGE_FORBIDDEN` dead-letters a Confluence row by design.

Refuse it explicitly rather than letting an operator "correct the storage path" of a Confluence
erasure and requeue something meaningless. A clear refusal naming the provider is the right
outcome; the recovery flow for a Confluence row is a human with space-admin rights emptying the
trash, which the existing `COMPLETE_EXTERNALLY_REMEDIATED` disposition already expresses.

Pin it with a test that a `provider: 'confluence'` dead-letter is refused by the route, and one
that a `supabase` row is still accepted — the second is what stops the guard being written too
broadly.

- [ ] **Step 6: Register it in the job**

```ts
const dispatch = createErasureDispatcher({
  supabase: createSupabaseEraser(...),
  confluence: createConfluenceEraser({ prisma, ... }),
});
```

- [ ] **Step 7: Run the whole suite**

Run: `cd apps/api && npm test`

- [ ] **Step 8: Commit**

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
test('the grant is revoked at Atlassian before the credentials are forgotten locally', async () => {
  const { revokes, credentialsRemaining } = await disconnectWith({ revokeSucceeds: true });
  assert.equal(revokes.length, 1);
  assert.equal(credentialsRemaining, 0);
});

test('the credentials are forgotten locally even when revocation fails', async () => {
  const { credentialsRemaining, result } = await disconnectWith({ revokeSucceeds: false });
  assert.equal(credentialsRemaining, 0);
  assert.equal(result.revoked, false);
});

test('a hanging revoke does not hold the disconnect open', async () => {
  const { credentialsRemaining, result } = await disconnectWith({ revokeHangs: true });
  assert.equal(credentialsRemaining, 0);
  assert.equal(result.revoked, false);
});
```

Build these on the existing fakes in `confluence-connection.service.test.ts` — that file already
has a credential store fake with an ordered `writeLog`, added when Task 5 of Phase 3 pinned the
connect-ordering precondition. Reuse it; do not build a second one.

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
- Where a document has an authoritative Supabase copy in `eu-west-1`, the erasure guarantee for
  the **record** is the Supabase one, and the Confluence guarantee is best-effort and bounded by
  permissions the charity controls.
- **Where a document is authoritative in Confluence, there is no Irish copy to fall back on**, and
  the erasure guarantee for that document is only ever the best-effort one. Say so explicitly
  rather than letting the reader carry the Supabase guarantee across.
- For a data subject erasure request under GDPR, this distinction is the material one: state it in
  terms a DPO can act on.

**Do not write this section until the authority question in Task 1 is settled.** It is the one
place in the phase where the answer changes what is true rather than only what is convenient —
writing it now would mean publishing a residency claim that may be wrong. If the question is still
open when you reach this task, write everything else, leave this subsection marked as blocked, and
say so in your report.

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
