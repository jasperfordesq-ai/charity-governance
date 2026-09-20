# Confluence connector Tier 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Confluence connector obey the owner's deletion ruling and survive first contact with a real Atlassian site.

**Architecture:** An ordinary document deletion stops destroying the Confluence copy; the publication row is kept in a new `RETIRED` state so the page stays addressable, and a separate, explicitly authorised route enqueues the erasure that used to happen silently. That route is gated on OAuth scopes the app does not currently request, so granted scopes become a recorded, checkable fact. Two smaller fixes remove a silent wrong-site binding and a deployment profile that withholds credentials from its own workers.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, zod, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-20-confluence-connector-audit.md` (findings A1-A6, C4; recommendations T1.1-T1.5)

## Global Constraints

- **Branch:** commit directly to `master`. No worktrees, no feature branches.
- **The checkout is shared and moves under you.** Re-read `git status` and `git log -1` immediately before every commit. Treat any file you did not edit yourself as another session's in-flight work; never `git add -A`, always stage named paths.
- **Tests are `node:test` + `node:assert/strict`.** There is no Vitest. No `describe`, `it`, `expect` or `it.each` — use `test('...', async () => {})` and loop for table-driven cases.
- **`apps/api` tests run from `dist/`:** `npm test` is `tsc && node --test dist/tests/*.test.js`. An edited test re-run without a rebuild runs its previous version.
- **`apps/api`'s `npm test` runs two passes.** Pass one runs everything *except* tests whose name contains `real PostgreSQL 16 migration`; pass two re-runs that phrase against one named file only. Never put that phrase in a new file.
- **Confirm tests by name in TAP output.** Never infer success from a total.
- **Database:** never run `prisma migrate reset`, `migrate dev` or `db push`. Hand-write every migration; apply with `npm run db:migrate:deploy` after exporting `DATABASE_URL` from `apps/api/.env`.
- **Adding an enum value:** if the value is only *declared*, use `ADD VALUE IF NOT EXISTS` in a migration of its own. If it is *used* in the same migration, the enum must be rebuilt instead. This plan declares in one migration and uses in the next, deliberately.
- **Do not edit an applied migration.**
- **Closed files — modify only with a stated reason in the commit message:** `integration-crypto.ts`, `integration-credential.service.ts`, `atlassian-oauth.ts`, `confluence-connection.service.ts`. Tasks 3 and 5 touch the last one; both carry their reason.
- **Do not weaken the `/confluence/status` output guard** — a keys allow-list plus a substring check forbidding `token`, `fingerprint`, `sealed`, `ciphertext`, `secret` and `refresh`. Extend the allow-list; never relax the substring test.
- **No route in `routes/integrations/` may accept an `integrationId`** from a body, query or path. Every lookup goes through `findOwnConfluenceIntegration`, keyed on the authenticated organisation.
- **Do not write backslash-u escape literals into source content** through a shell heredoc; the writing path decodes them into raw bytes. Use an editor tool for any file containing a backslash.
- **Confluence stays alpha.** Nothing here promotes it, and the provider registry still lists only `supabase` and `local`.
- **Verify by mutation, then canary.** Follow every green mutation with a branch-body `throw` canary and say which form you used. Mutate each ANDed sub-condition and each call site separately. Mutate a scratchpad copy, never the working tree.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `apps/api/prisma/migrations/20260920060000_add_retired_publication_state/migration.sql` | Declares the `RETIRED` enum value, alone. |
| `apps/api/prisma/migrations/20260920070000_retire_publication_columns/migration.sql` | Retirement columns, the fourth `state_consistent` arm, the erasure-request constraint. |
| `apps/api/prisma/migrations/20260920080000_add_integration_granted_scopes/migration.sql` | `grantedScopes` on `OrganisationIntegration`. |
| `apps/api/src/services/confluence-erasure-request.service.ts` | Turns an administrator's explicit request into the `confluence` erasure row that Phase 5's pipeline already knows how to drive. The only place that writes one. |
| `apps/api/src/tests/confluence-erasure-request.service.test.ts` | Its tests. |
| `docs/superpowers/plans/2026-09-20-confluence-tier-1.md` | This plan. |

**Modified**

| Path | Change |
|---|---|
| `apps/api/prisma/schema.prisma` | `RETIRED`; four retirement columns; `grantedScopes`. |
| `apps/api/src/services/document.service.ts` | `remove()` stops enqueuing erasure; `cancelConfluencePublication` becomes `retireConfluencePublication`; `createConfluenceErasureRow` and `enqueueConfluenceErasure` are deleted. |
| `apps/api/src/routes/integrations/index.ts` | Delete scopes; disclosure copy; `reauthorisationRequired` on status; the listing and erasure routes. |
| `apps/api/src/services/confluence-connection.service.ts` | Records `tokens.scopes`; refuses to guess among several sites. |
| `apps/api/src/utils/logger.ts` | Redacts `env.INTEGRATION_ENCRYPTION_KEY`. |
| `compose.production.yml`, `apps/api/package.json`, the three `.env*.example`, `scripts/check-production.mjs` | Deployment wiring. |
| `docs/production-runbook.md`, `docs/ARCHITECTURE.md`, `docs/CONTINUATION-PROMPT-confluence-integration.md` | Say what the code now does. |

---

## Task 1: The `RETIRED` publication state

**Files:**
- Create: `apps/api/prisma/migrations/20260920060000_add_retired_publication_state/migration.sql`
- Create: `apps/api/prisma/migrations/20260920070000_retire_publication_columns/migration.sql`
- Modify: `apps/api/prisma/schema.prisma` (enum at ~L137; `DocumentPublication` at ~L1096)
- Test: `apps/api/src/tests/document-publication.test.ts` (enum pin at ~L141)

**Interfaces:**
- Produces: `DocumentPublicationState.RETIRED`; columns `retiredAt: DateTime?`, `retiredStoragePath: String?`, `erasureRequestedAt: DateTime?`, `erasureDeletionId: String?` on `DocumentPublication`. Task 2 writes the first two; Task 4 writes the last two.

- [ ] **Step 1: Write the failing enum-shape test**

In `apps/api/src/tests/document-publication.test.ts`, find the existing test that pins the `DocumentPublicationState` enum (around line 141) and extend it. It reads the schema file as text, so the assertion is a regex over source:

```ts
test('the publication state machine carries a retired state for a deleted document', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const block = schema.match(/enum DocumentPublicationState \{([^}]*)\}/)?.[1] ?? '';
  const values = block.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

  assert.deepEqual(values, ['PENDING', 'DEAD_LETTER', 'PROCESSED', 'RETIRED']);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npm run build && node --test dist/tests/document-publication.test.js
```

Expected: FAIL — the enum has three values, not four. Confirm a `# tests` line appears; a compile error reports zero failures and looks identical to a pass.

- [ ] **Step 3: Add the value to the schema and declare it in its own migration**

In `apps/api/prisma/schema.prisma`:

```prisma
enum DocumentPublicationState {
  PENDING
  DEAD_LETTER
  PROCESSED
  // A published document whose CharityPilot record has been deleted. The page
  // is still in the charity's Confluence site and is deliberately left there:
  // an ordinary deletion removes our record and our reference, and destroying
  // the source is a separate, explicitly authorised action. The identifiers
  // are kept because they are the only thing that can still address the page.
  RETIRED
}
```

Create `apps/api/prisma/migrations/20260920060000_add_retired_publication_state/migration.sql`:

```sql
-- An ordinary CharityPilot deletion removes our record and its reference only;
-- destroying the Confluence source requires an explicit erasure workflow
-- (owner's ruling, 2026-09-19). A publication whose document has been deleted
-- therefore has to keep naming its page rather than being erased or discarded,
-- and no existing state says that: PENDING means "still trying", DEAD_LETTER
-- means "the publish failed", PROCESSED means "published and current".
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PostgreSQL 12+
-- provided the new value is not used in the same transaction; this migration
-- only declares it, and 20260920070000 is where it is first used. IF NOT EXISTS
-- keeps a re-run against an already-migrated database from failing.
ALTER TYPE "DocumentPublicationState"
    ADD VALUE IF NOT EXISTS 'RETIRED';
```

- [ ] **Step 4: Add the columns and the fourth constraint arm**

Create `apps/api/prisma/migrations/20260920070000_retire_publication_columns/migration.sql`. Copy the three existing arms verbatim from `20260919140000_add_document_publication/migration.sql` and add `AND "retiredAt" IS NULL` to each, so that only a `RETIRED` row can carry a retirement stamp:

```sql
BEGIN;

-- Where the deleted document's bytes were, copied at retirement. The Confluence
-- eraser addresses the page through `targetRef` and must never fall back to
-- this; it exists because DocumentStorageDeletion.storagePath is NOT NULL and
-- the Document row is gone by the time an erasure can be requested, so there
-- would otherwise be nothing to tell an operator which document a row is for.
ALTER TABLE "DocumentPublication"
    ADD COLUMN "retiredAt" TIMESTAMP(3),
    ADD COLUMN "retiredStoragePath" TEXT,
    ADD COLUMN "erasureRequestedAt" TIMESTAMP(3),
    ADD COLUMN "erasureDeletionId" TEXT;

ALTER TABLE "DocumentPublication"
    DROP CONSTRAINT "DocumentPublication_state_consistent";

ALTER TABLE "DocumentPublication"
    ADD CONSTRAINT "DocumentPublication_state_consistent"
        CHECK (
            (
                "state" = 'PENDING'
                AND "processedAt" IS NULL
                AND "publishedAt" IS NULL
                AND "deadLetteredAt" IS NULL
                AND "terminalReason" IS NULL
                AND "nextAttemptAt" IS NOT NULL
                AND "alertClaimToken" IS NULL
                AND "alertClaimedAt" IS NULL
                AND "alertedAt" IS NULL
                AND "retiredAt" IS NULL
            ) OR (
                "state" = 'DEAD_LETTER'
                AND "processedAt" IS NULL
                AND "deadLetteredAt" IS NOT NULL
                AND "terminalReason" IS NOT NULL
                AND "nextAttemptAt" IS NULL
                AND "claimedAt" IS NULL
                AND "attempts" >= 1
                AND "retiredAt" IS NULL
            ) OR (
                "state" = 'PROCESSED'
                AND "processedAt" IS NOT NULL
                AND "publishedAt" IS NOT NULL
                AND "deadLetteredAt" IS NULL
                AND "terminalReason" IS NULL
                AND "nextAttemptAt" IS NULL
                AND "claimedAt" IS NULL
                AND "lastError" IS NULL
                AND "alertClaimToken" IS NULL
                AND "alertClaimedAt" IS NULL
                AND "alertedAt" IS NULL
                AND "retiredAt" IS NULL
            ) OR (
                -- Retirement deliberately constrains only what it owns. A row
                -- can be retired out of any of the three states above, so its
                -- history fields — publishedAt, processedAt, deadLetteredAt,
                -- terminalReason, alertedAt — are whatever that state left and
                -- are not re-stated here. What retirement DOES assert: the page
                -- is still named, nothing will retry it, and no worker holds it.
                "state" = 'RETIRED'
                AND "retiredAt" IS NOT NULL
                AND "pageId" IS NOT NULL
                AND "nextAttemptAt" IS NULL
                AND "claimedAt" IS NULL
                AND "alertClaimToken" IS NULL
                AND "alertClaimedAt" IS NULL
            )
        );

-- An erasure request is a stamped pair or neither half, and it can only be made
-- against a retired row: the two-step workflow is delete the document first,
-- then erase the Confluence copy. Allowing a request against a PROCESSED row
-- would let an administrator destroy the page a live document still points at.
ALTER TABLE "DocumentPublication"
    ADD CONSTRAINT "DocumentPublication_erasure_request_consistent"
        CHECK (
            ("erasureRequestedAt" IS NULL) = ("erasureDeletionId" IS NULL)
            AND ("erasureRequestedAt" IS NULL OR "state" = 'RETIRED')
            AND ("erasureDeletionId" IS NULL
                 OR ("erasureDeletionId" = btrim("erasureDeletionId")
                     AND char_length("erasureDeletionId") BETWEEN 1 AND 200))
            AND ("retiredStoragePath" IS NULL OR char_length("retiredStoragePath") <= 500)
        );

COMMIT;
```

Add the columns to `schema.prisma` inside `model DocumentPublication`, immediately after `processedAt`:

```prisma
  // Set when the document was deleted in CharityPilot. See the RETIRED state.
  retiredAt          DateTime?
  retiredStoragePath String?
  // Stamped by the explicit erasure workflow, never by an ordinary deletion.
  erasureRequestedAt DateTime?
  erasureDeletionId  String?
```

- [ ] **Step 5: Run the enum test and the migration-shape suite**

```bash
cd apps/api && npm test 2>&1 | tail -30
```

Expected: PASS, and the total test count is one higher than before.

- [ ] **Step 6: Apply the migrations to the development database**

```bash
cd apps/api && export DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')" && npm run db:migrate:deploy
```

Expected: both migrations report as applied. If the second fails on the CHECK, an existing row violates an arm — read the error, do not weaken the constraint.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260920060000_add_retired_publication_state apps/api/prisma/migrations/20260920070000_retire_publication_columns apps/api/src/tests/document-publication.test.ts
git commit -m "feat(publish): a publication can be retired without erasing its page"
```

---

## Task 2: An ordinary deletion stops destroying the Confluence copy

**Files:**
- Modify: `apps/api/src/services/document.service.ts` (`remove()` ~L803-883; `createConfluenceErasureRow` ~L952; `enqueueConfluenceErasure` ~L1013; `cancelConfluencePublication` ~L1086-1168; constants ~L309-320)
- Modify: `apps/api/src/routes/integrations/index.ts` (`CONFLUENCE_CONNECT_DISCLOSURE.erasure` ~L150-170)
- Test: `apps/api/src/tests/document-storage-cleanup.test.ts` (L446-964)
- Test: `apps/api/src/tests/integrations-route.test.ts` (disclosure pins ~L1602-1630)

**Interfaces:**
- Consumes: `DocumentPublicationState.RETIRED` and the retirement columns from Task 1.
- Produces: `DocumentService.remove()` returns `{ storagePath, storageDeletionId }` unchanged. `enqueueConfluenceErasure`, `createConfluenceErasureRow` and `cancelConfluencePublication` no longer exist. Task 4 owns erasure-row creation from here on.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/tests/document-storage-cleanup.test.ts`, replace the body of `'a publication that already has a pageId keeps its identifiers and stops being retried'` (~L472) with the retirement expectation, and rename it:

```ts
test('a publication that already has a pageId is retired, not erased, when its document is deleted', async () => {
  // claimedAt is set deliberately: a worker that recorded its page id and is
  // still mid-attempt is the case where retirement has to take the row away
  // from it, and a fixture that left claimedAt null would assert the clearing
  // trivially — it was already null.
  const mock = buildPublicationCancelPrisma({
    id: 'publication-1',
    pageId: 'page-99',
    attempts: 1,
    state: 'PENDING',
    claimedAt: new Date('2026-09-20T11:59:00.000Z'),
  });
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  const row = mock.row();
  assert.notEqual(row, null, 'a publication that named a Confluence page must never be deleted');
  assert.equal(row!.pageId, 'page-99', 'the page id is the only thing that can still address the page');
  assert.equal(row!.cloudId, 'cloud-1', 'a page id without its site names nothing');
  assert.equal(mock.deletes.length, 0);
  assert.equal(row!.state, 'RETIRED');
  assert.ok(row!.retiredAt instanceof Date);
  assert.equal(row!.retiredStoragePath, 'org-1/policy.pdf');
  assert.equal(row!.nextAttemptAt, null, 'nothing retries a retired row');
  assert.equal(row!.claimedAt, null, 'the in-flight attempt loses the row and reports it, rather than finishing silently');
});
```

Then invert the dual-erasure test at ~L618. Rename it and assert the absence:

```ts
test('deleting a mirrored document erases the Irish copy and leaves the Confluence page alone', async () => {
  const mock = buildErasureEnqueuePrisma({
    id: 'publication-1',
    cloudId: 'cloud-1',
    pageId: 'page-1',
    attachmentId: 'att-1',
    attempts: 0,
    state: 'PROCESSED',
  });
  const service = new DocumentService(mock.prisma as never, () => NOW);

  await service.remove('org-1', 'doc-1');

  const created = mock.createdDeletions();
  assert.equal(created.length, 1, 'exactly one erasure row: the Supabase copy');
  assert.equal(created[0].provider, 'supabase');
  assert.equal(
    created.some((row) => row.provider === 'confluence'),
    false,
    'an ordinary deletion must never enqueue a Confluence erasure',
  );
});
```

Apply the same inversion to the table-driven block at ~L697 (`a publication ${situation} still has its Confluence copy erased`) — rename it to `...has its Confluence copy left alone` and assert no `confluence` row is created — and to the block at ~L832 (`a page recorded ${moment} is still enqueued for erasure` → `...is retired rather than erased`). Delete the test at ~L929 (`a malformed Confluence erasure target fails the deletion while the document still exists`): nothing builds a target on this path any more, and Task 4 re-pins that behaviour where it now lives.

Invert the test at ~L949 (`a failed read of the publication row fails the deletion rather than orphaning the page`):

```ts
test('a failed read of the publication row no longer fails the document deletion', async () => {
  const mock = buildPublicationCancelPrisma({ id: 'publication-1', pageId: 'page-1', attempts: 0, state: 'PENDING' });
  mock.prisma.documentPublication.findFirst = async () => {
    throw new Error('publication read failed');
  };
  const service = new DocumentService(mock.prisma as never, () => NOW);

  // The document deletion is the user's action and must always work. Retirement
  // is bookkeeping about a page that is being left in place either way, so its
  // failure is logged and swallowed — unlike the old erasure enqueue, which
  // held the deletion hostage because a missed row meant an unerasable orphan.
  await service.remove('org-1', 'doc-1');
});
```

In `apps/api/src/tests/integrations-route.test.ts`, update the disclosure pin so it requires the new sentence:

```ts
test('the disclosure says an ordinary deletion leaves the Confluence page in place', () => {
  const erasure = CONFLUENCE_CONNECT_DISCLOSURE.erasure.join(' ');

  assert.match(erasure, /deleting a document in CharityPilot does not delete/i);
  assert.match(erasure, /separate|explicit/i);
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npm run build && node --test dist/tests/document-storage-cleanup.test.js 2>&1 | tail -40
```

Expected: FAIL on the retirement assertions and on the `confluence` rows still being created.

- [ ] **Step 3: Rewrite the delete path**

In `apps/api/src/services/document.service.ts`, replace the constant at ~L315 and add the retirement message:

```ts
const RETIRED_PUBLICATION_MESSAGE =
  'The document was deleted in CharityPilot. The Confluence page was deliberately left in place; ' +
  'destroying it is a separate, explicitly authorised erasure.';
```

Replace `remove()` (~L803-883) with:

```ts
  async remove(organisationId: string, id: string): Promise<{ storagePath: string; storageDeletionId: string }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const doc = await tx.document.findFirst({ where: { id, organisationId } });

      if (!doc) {
        throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }

      const provider = await resolveProviderForOrganisation(
        organisationId,
        createPrismaOrganisationStorageResolver(tx),
        undefined,
        { operation: 'delete' },
      );

      const deletion = await deletionDelegate(tx).create({
        data: { organisationId, storagePath: doc.fileUrl, provider },
      });

      await tx.document.delete({ where: { id } });

      return { storagePath: doc.fileUrl, storageDeletionId: deletion.id };
    });

    // Deliberately outside the transaction, and deliberately best-effort — both
    // for the same reason. Under the owner's ruling of 2026-09-19 an ordinary
    // deletion removes our record and our reference and leaves the Confluence
    // page standing, so nothing about the page is at risk if this fails: the
    // page is being kept either way. What is left here is bookkeeping, and
    // bookkeeping must never fail a user's deletion. (Before that ruling this
    // call had to run *inside* the transaction, because a missed row meant a
    // page nobody could find and nobody could erase.)
    await this.retireConfluencePublication(organisationId, id, result.storagePath);

    return result;
  }
```

Retain the long comment block above `resolveProviderForOrganisation` explaining the delete-time provider resolution — it is unrelated to this change.

- [ ] **Step 4: Replace the cancel compensator with retirement**

Delete `createConfluenceErasureRow` (~L952) and `enqueueConfluenceErasure` (~L1013) outright. Replace `cancelConfluencePublication` (~L1086-1168) with:

```ts
  /**
   * Settles a Confluence publication whose document has just been deleted.
   *
   * Two jobs, and only the first changed with the owner's ruling:
   *
   * - **Stop the retry loop.** Left alone, a worker keeps trying to publish a
   *   document `readDocument` can no longer find, burning all five attempts and
   *   dead-lettering as MAX_ATTEMPTS_EXHAUSTED — noise that trains an operator
   *   to ignore alerts, for an entirely ordinary user action.
   * - **Keep the page addressable.** A row naming a page is retired, never
   *   deleted and never erased. Its identifiers are the only thing that can
   *   still address that page, and an explicit erasure will need them.
   *
   * The three cases, and why each is safe:
   *
   * - **no page id, nothing in flight** — nothing exists in the charity's site
   *   and nothing is about to, because the lock is what a would-be claimer
   *   skips. The row is deleted outright; it records nothing.
   * - **no page id, an attempt in flight** — that attempt may be between
   *   `createPage` and `recordPage` right now, with its write blocked on this
   *   very lock. Deleting the row would make that write match nothing and leave
   *   a real page with no record of it anywhere. The row is parked instead and
   *   the caller takes one more locked look, by which time the blocked write
   *   has landed.
   * - **a page id is recorded** — retire it.
   *
   * **Residual, deliberately accepted.** Retiring clears `claimedAt`, so an
   * attempt that had recorded its page but not yet its attachment loses its
   * claim and reports it (`claimLost`) rather than finishing. The attachment it
   * uploaded is then in Confluence without this row naming it, and a later
   * erasure will not look for it. That is the incompleteness the connect
   * disclosure already states — "an attachment CharityPilot did not record is
   * never looked for" — and under the ruling it is no longer dangerous: nothing
   * is being destroyed, so an unrecorded attachment is an incomplete proof
   * rather than an unerasable orphan.
   */
  private async retireConfluencePublication(
    organisationId: string,
    documentId: string,
    storagePath: string,
  ): Promise<void> {
    /** Returns whether an attempt was still in flight — the one case a single pass cannot decide. */
    const settle = async (tx: unknown): Promise<boolean> => {
      const publication = await this.lockConfluencePublication(tx, documentId, {
        id: true,
        cloudId: true,
        pageId: true,
        attachmentId: true,
        attempts: true,
        state: true,
        claimedAt: true,
      });
      if (publication === null) return false;

      if (publication.pageId === null) {
        if (publication.claimedAt === null) {
          await publicationDelegate(tx).deleteMany({
            where: { id: publication.id, pageId: null },
          });
          return false;
        }

        if (publication.state === 'PENDING') {
          await publicationDelegate(tx).updateMany({
            where: { id: publication.id, state: 'PENDING' },
            data: {
              attempts: Math.max(publication.attempts, DOCUMENT_PUBLICATION_MAX_ATTEMPTS),
              nextAttemptAt: CANCELLED_PUBLICATION_NEXT_ATTEMPT_AT,
              lastError: RETIRED_PUBLICATION_MESSAGE,
            },
          });
        }
        return true;
      }

      // No `state` guard on the where clause: the row is held under FOR UPDATE,
      // so the value just read is still true at this write. Retiring a row that
      // is already RETIRED is a no-op in practice (the document can only be
      // deleted once) and harmless if it happens.
      await publicationDelegate(tx).updateMany({
        where: { id: publication.id },
        data: {
          state: 'RETIRED',
          retiredAt: this.now(),
          retiredStoragePath: storagePath,
          nextAttemptAt: null,
          claimedAt: null,
          alertClaimToken: null,
          alertClaimedAt: null,
          lastError: RETIRED_PUBLICATION_MESSAGE,
        },
      });

      return false;
    };

    try {
      const client = this.prisma as unknown as DocumentPublicationCreateClient;
      const pass = async (): Promise<boolean> =>
        client.$transaction ? client.$transaction(settle) : settle(this.prisma);

      // At most two passes, never a loop. A write blocked on the first pass's
      // lock lands the instant that pass commits, so the second pass sees the
      // page id it recorded and retires it.
      if (await pass()) await pass();
    } catch (error) {
      console.error(
        `[document-publication] Could not retire the Confluence publication for deleted document ${documentId}.`,
        error,
      );
    }
  }
```

Remove the now-unused `publicationErasureTarget` import from this file if nothing else uses it; leave `DOCUMENT_PUBLICATION_MAX_ATTEMPTS` and `CANCELLED_PUBLICATION_NEXT_ATTEMPT_AT` in place, which the park branch still needs.

- [ ] **Step 5: Correct the connect disclosure**

In `apps/api/src/routes/integrations/index.ts`, replace the second entry of `CONFLUENCE_CONNECT_DISCLOSURE.erasure` and insert a new first entry:

```ts
  erasure: Object.freeze([
    'Deleting a document in CharityPilot does not delete anything from your Confluence site. It ' +
      'removes CharityPilot’s record and its reference; the page and its attachments stay where ' +
      'they are, and your own administrators keep control of them.',
    'Erasure from your Confluence site is a separate action an administrator has to ask for ' +
      'explicitly, and it is best-effort: it is bounded by permissions you control, not ' +
      'permissions CharityPilot holds.',
    'When an erasure is requested, CharityPilot deletes and then permanently purges the page and ' +
      'the attachments it recorded, and proves the erasure by reading the page back and requiring ' +
      'a 404.',
    // ...the four existing entries from 'Purging needs a higher permission' onward, unchanged.
  ] as const),
```

- [ ] **Step 6: Run the full API suite**

```bash
cd apps/api && npm test 2>&1 | tail -40
```

Expected: PASS. Confirm the `# tests` line is present and the count has not dropped by more than the one deleted test.

- [ ] **Step 7: Mutation-check the two guards that matter**

Copy `apps/api/src` to the scratchpad, junction the repository root's `node_modules`, and run `node --import tsx --test src/tests/document-storage-cleanup.test.ts`. Mutate each separately, never together:

1. `publication.pageId === null` → `publication.pageId !== null` (proves the retire/delete split is covered)
2. `publication.claimedAt === null` → `true` (proves the in-flight park is covered)
3. In the retire `data`, drop `nextAttemptAt: null` (proves the retry loop is pinned)

Then canary each green mutation with a **branch-body** `throw`, and state that form in the commit message.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/document.service.ts apps/api/src/routes/integrations/index.ts apps/api/src/tests/document-storage-cleanup.test.ts apps/api/src/tests/integrations-route.test.ts
git commit -m "fix(documents): deleting a document no longer destroys its Confluence page"
```

---

## Task 3: Record the scopes Atlassian granted, and ask for the two that erasure needs

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`OrganisationIntegration` ~L448)
- Create: `apps/api/prisma/migrations/20260920080000_add_integration_granted_scopes/migration.sql`
- Modify: `apps/api/src/services/confluence-connection.service.ts` (`connectingState` ~L726) — **closed file; reason: the erasure gate must know which scopes this tenant consented to, and `tokens.scopes` is visible only inside `connectConfluence`**
- Modify: `apps/api/src/routes/integrations/index.ts` (`CONFLUENCE_OAUTH_SCOPES` ~L98; status route ~L742)
- Test: `apps/api/src/tests/integrations-route.test.ts`; `apps/api/src/tests/confluence-connection.service.test.ts`

**Interfaces:**
- Produces: `OrganisationIntegration.grantedScopes: string[]` (default `[]`); `CONFLUENCE_REQUIRED_ERASURE_SCOPES: readonly string[]`; `missingConfluenceScopes(granted: string[]): string[]`, exported from `routes/integrations/index.ts`. Task 4 consumes both.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/tests/integrations-route.test.ts`:

```ts
test('the authorize scopes include the two Atlassian requires to erase', () => {
  assert.ok(CONFLUENCE_OAUTH_SCOPES.includes('delete:page:confluence'));
  assert.ok(CONFLUENCE_OAUTH_SCOPES.includes('delete:attachment:confluence'));
  assert.ok(CONFLUENCE_OAUTH_SCOPES.includes('offline_access'), 'still the one that cannot be dropped');
});

test('a connection that predates the delete scopes reports what it is missing', () => {
  assert.deepEqual(
    missingConfluenceScopes([]).sort(),
    ['delete:attachment:confluence', 'delete:page:confluence'],
  );
  assert.deepEqual(missingConfluenceScopes([...CONFLUENCE_REQUIRED_ERASURE_SCOPES]), []);
});
```

And extend the status keys allow-list test (~L927) to expect the two new keys, keeping the forbidden-substring loop (~L944) exactly as it is:

```ts
  assert.deepEqual(Object.keys(data).sort(), [
    'connectedAt',
    'lastError',
    'provider',
    'publishSpace',
    'publishing',
    'reauthorisationRequired',
    'siteCount',
    'siteName',
    'siteUrl',
    'status',
    'unavailableActions',
  ]);
```

In `apps/api/src/tests/confluence-connection.service.test.ts`. This file has no generic connect harness — use its own helpers: `fakePrisma(options)`, `tokens(overrides)`, `clock`, `withKey(run)`, `fake.row()`, and the module constants `ORG_ID` and `INTEGRATION_ID`.

```ts
test('connectConfluence records the scopes Atlassian actually granted', async () => {
  const fake = fakePrisma({ integration: { status: 'DISCONNECTED' }, storedRefreshToken: null });

  await withKey(() =>
    connectConfluence(
      fake.client,
      { organisationId: ORG_ID, userId: 'user-9', code: 'auth-code', redirectUri: 'https://api.example/cb' },
      {
        now: clock,
        // Deliberately NOT the set CharityPilot asks for: a consent screen can
        // show one set and grant another, and the erasure gate reads what was
        // granted, never what was requested.
        exchangeAuthorizationCode: async () =>
          tokens({ scopes: ['read:page:confluence', 'delete:page:confluence', 'offline_access'] }),
        listAccessibleResources: async () => [
          { id: 'site-9', url: 'https://charity.atlassian.net', name: 'Charity Wiki' },
        ],
      },
    ),
  );

  assert.deepEqual(fake.row().grantedScopes, [
    'read:page:confluence',
    'delete:page:confluence',
    'offline_access',
  ]);
});
```

The fake's `IntegrationRow` type and its default row will need `grantedScopes: string[]`. Add it there; `applyIntegrationData` already copies whatever `data` carries, so nothing else in the fake changes.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npm run build && node --test dist/tests/integrations-route.test.js dist/tests/confluence-connection.service.test.js 2>&1 | tail -30
```

Expected: FAIL — the scopes are absent and `missingConfluenceScopes` is not defined.

- [ ] **Step 3: Add the column and its migration**

In `schema.prisma`, inside `model OrganisationIntegration`, after `lastRefreshedAt`:

```prisma
  // The scopes Atlassian said it granted, from the token response. Recorded
  // because a tenant that authorised before a scope was added has a working
  // connection that cannot do the new thing, and the only honest way to tell
  // that apart from a broken connection is to have written down what was
  // granted. Empty for every connection made before this column existed —
  // which reads, correctly, as "we do not know, so assume not granted".
  grantedScopes       String[]            @default([])
```

Create `apps/api/prisma/migrations/20260920080000_add_integration_granted_scopes/migration.sql`:

```sql
-- Atlassian's v2 delete endpoints require delete:page:confluence and
-- delete:attachment:confluence, which CharityPilot never requested. Adding them
-- to the authorize URL is not enough on its own: a tenant that authorised
-- before the change keeps a perfectly good connection that will 403 on an
-- erasure, and a 403 from Confluence is reported as CONFLUENCE_RECONNECT_REQUIRED
-- — which sends an operator to fix the wrong thing. Recording what was granted
-- is what lets the erasure workflow refuse up front, naming the real remedy.
--
-- An existing row gets the empty array, which reads as "unknown, so not
-- granted": those tenants must reconnect before they can erase. Nobody is
-- forced to reconnect for anything else.
ALTER TABLE "OrganisationIntegration"
    ADD COLUMN "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
```

- [ ] **Step 4: Request the scopes and record what came back**

In `apps/api/src/routes/integrations/index.ts`, extend the scope list and add the helper beside it:

```ts
export const CONFLUENCE_OAUTH_SCOPES = [
  'read:page:confluence',
  'write:page:confluence',
  // Atlassian's v2 DELETE /pages/{id} requires this, and the purge that follows
  // it requires it too. Without it an erasure 403s, and confluence-client maps
  // a 403 to CONFLUENCE_RECONNECT_REQUIRED — a wrong diagnosis that would be
  // retried to dead-letter.
  'delete:page:confluence',
  'read:attachment:confluence',
  'write:attachment:confluence',
  'delete:attachment:confluence',
  'read:space:confluence',
  'read:content-details:confluence',
  'offline_access',
] as const;

/**
 * The scopes the explicit erasure workflow cannot proceed without.
 *
 * Deliberately narrower than `CONFLUENCE_OAUTH_SCOPES`: this is the set a
 * *request* is gated on, not the set we ask for. `search:confluence` is not
 * requested at all, even though the audit's later CQL work will want it —
 * the DPO's standing ask is narrowest scopes, and a scope we do not yet use
 * is one we should not yet hold.
 */
export const CONFLUENCE_REQUIRED_ERASURE_SCOPES = [
  'delete:page:confluence',
  'delete:attachment:confluence',
] as const;

export function missingConfluenceScopes(granted: readonly string[]): string[] {
  const held = new Set(granted);
  return CONFLUENCE_REQUIRED_ERASURE_SCOPES.filter((scope) => !held.has(scope));
}
```

In `apps/api/src/services/confluence-connection.service.ts`, add one field to `connectingState` (~L726):

```ts
  const connectingState = {
    config,
    connectedAt: at,
    connectedById: userId,
    // What Atlassian said it granted, not what we asked for. A user can be
    // shown a consent screen for one set and grant another, and the erasure
    // gate has to know which it got.
    grantedScopes: tokens.scopes,
    refreshFailureCount: 0,
    lastRefreshedAt: at,
    refreshClaimToken: null,
    refreshClaimedAt: null,
  } as const;
```

- [ ] **Step 5: Report it on status**

In the `/confluence/status` handler, extend both the not-connected and connected responses. The not-connected branch gets `reauthorisationRequired: false` and `unavailableActions: []`; the connected branch:

```ts
      const missingScopes = missingConfluenceScopes(integration.grantedScopes);
      return sendSuccess(reply, {
        // ...existing fields unchanged...
        // Named for what the administrator must DO, not for what is absent, and
        // deliberately not carrying the scope strings: this response is guarded
        // by a substring test that forbids "token" and "secret" anywhere in it,
        // and a list of Atlassian scope names is the kind of field that invites
        // someone to widen that guard later.
        reauthorisationRequired: missingScopes.length > 0,
        unavailableActions: missingScopes.length > 0 ? ['ERASE_CONFLUENCE_COPY'] : [],
      });
```

`findOwnConfluenceIntegration` (~L427) uses a deliberately narrow `select`, and its return type `OwnIntegration` (~L400) lists the fields by hand. Add to both:

```ts
  // What Atlassian granted. Not credential material — a scope name says what
  // the connection may do, never how to do it — and the erasure gate needs it.
  grantedScopes: true,
```

```ts
  grantedScopes: string[];
```

Keep the existing comment above the `select` explaining why the claim and failure-count columns stay out; it is still true.

- [ ] **Step 6: Run the suite and apply the migration**

```bash
cd apps/api && npm test 2>&1 | tail -30 && export DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')" && npm run db:migrate:deploy
```

Expected: PASS, migration applied.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260920080000_add_integration_granted_scopes apps/api/src/routes/integrations/index.ts apps/api/src/services/confluence-connection.service.ts apps/api/src/tests/integrations-route.test.ts apps/api/src/tests/confluence-connection.service.test.ts
git commit -m "feat(integrations): ask for the delete scopes, and record what was granted

confluence-connection.service.ts is a closed file. The reason for touching it:
the erasure gate must know which scopes a tenant consented to, and tokens.scopes
is visible only inside connectConfluence."
```

---

## Task 4: The explicit erasure workflow

**Files:**
- Create: `apps/api/src/services/confluence-erasure-request.service.ts`
- Create: `apps/api/src/tests/confluence-erasure-request.service.test.ts`
- Modify: `apps/api/src/routes/integrations/index.ts` (imports; two new routes after the publish-space route ~L880)
- Test: `apps/api/src/tests/integrations-route.test.ts`

**Interfaces:**
- Consumes: `RETIRED` and the retirement columns (Task 1); `missingConfluenceScopes` and `CONFLUENCE_REQUIRED_ERASURE_SCOPES` (Task 3); `publicationErasureTarget` from `document-publication.service.ts`.
- Produces: `listRetiredConfluencePublications(prisma, organisationId)` and `requestConfluenceErasure(prisma, input)` where `input` is `{ organisationId, publicationId, reason, requestedById, now? }`, returning `{ deletionId: string }`.

- [ ] **Step 1: Write the failing service tests**

Create `apps/api/src/tests/confluence-erasure-request.service.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestConfluenceErasure } from '../services/confluence-erasure-request.service.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');

function buildPrisma(publication: Record<string, unknown> | null) {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  let row = publication;

  const client = {
    documentPublication: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        if (row === null) return null;
        for (const [key, value] of Object.entries(args.where)) {
          if (row[key] !== value) return null;
        }
        return row;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updated.push(args);
        if (row === null || args.where.id !== row.id) return { count: 0 };
        if (Object.hasOwn(args.where, 'erasureDeletionId') && row.erasureDeletionId !== null) return { count: 0 };
        row = { ...row, ...args.data };
        return { count: 1 };
      },
    },
    documentStorageDeletion: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'deletion-9' };
      },
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(client),
  };

  return { prisma: client, created, updated, row: () => row };
}

const RETIRED_ROW = {
  id: 'publication-1',
  organisationId: 'org-1',
  provider: 'confluence',
  state: 'RETIRED',
  cloudId: 'cloud-1',
  pageId: 'page-1',
  attachmentId: 'att-1',
  retiredStoragePath: 'org-1/policy.pdf',
  erasureRequestedAt: null,
  erasureDeletionId: null,
};

test('an erasure request enqueues exactly the row the old delete path used to', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW });

  const result = await requestConfluenceErasure(mock.prisma as never, {
    organisationId: 'org-1',
    publicationId: 'publication-1',
    reason: 'Data subject erasure request 2026-41',
    requestedById: 'user-1',
    now: () => NOW,
  });

  assert.equal(result.deletionId, 'deletion-9');
  assert.equal(mock.created.length, 1);
  assert.equal(mock.created[0].provider, 'confluence');
  assert.equal(mock.created[0].storagePath, 'org-1/policy.pdf');
  assert.deepEqual(mock.created[0].targetRef, {
    kind: 'confluence',
    cloudId: 'cloud-1',
    pageId: 'page-1',
    attachmentIds: ['att-1'],
  });
});

test('the request is stamped on the publication so it cannot be made twice', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW });

  await requestConfluenceErasure(mock.prisma as never, {
    organisationId: 'org-1',
    publicationId: 'publication-1',
    reason: 'Data subject erasure request 2026-41',
    requestedById: 'user-1',
    now: () => NOW,
  });

  assert.equal(mock.row()!.erasureDeletionId, 'deletion-9');
  assert.deepEqual(mock.row()!.erasureRequestedAt, NOW);
});

test('a publication belonging to another charity is not found', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW, organisationId: 'org-2' });

  await assert.rejects(
    requestConfluenceErasure(mock.prisma as never, {
      organisationId: 'org-1',
      publicationId: 'publication-1',
      reason: 'Data subject erasure request 2026-41',
      requestedById: 'user-1',
      now: () => NOW,
    }),
    (error: { statusCode?: number; code?: string }) => error.code === 'CONFLUENCE_PUBLICATION_NOT_FOUND',
  );
  assert.equal(mock.created.length, 0);
});

test('a publication that is not retired cannot be erased', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW, state: 'PROCESSED' });

  await assert.rejects(
    requestConfluenceErasure(mock.prisma as never, {
      organisationId: 'org-1',
      publicationId: 'publication-1',
      reason: 'Data subject erasure request 2026-41',
      requestedById: 'user-1',
      now: () => NOW,
    }),
    (error: { code?: string }) => error.code === 'CONFLUENCE_PUBLICATION_NOT_FOUND',
  );
  assert.equal(mock.created.length, 0, 'a live document must never have its page destroyed under it');
});

test('a malformed target is refused before any erasure row is written', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW, pageId: '  page-1  ' });

  await assert.rejects(
    requestConfluenceErasure(mock.prisma as never, {
      organisationId: 'org-1',
      publicationId: 'publication-1',
      reason: 'Data subject erasure request 2026-41',
      requestedById: 'user-1',
      now: () => NOW,
    }),
    (error: { code?: string }) => error.code === 'ERASURE_TARGET_MALFORMED',
  );
  assert.equal(mock.created.length, 0);
});

test('a second request while the first is still queued is refused', async () => {
  const mock = buildPrisma({ ...RETIRED_ROW, erasureRequestedAt: NOW, erasureDeletionId: 'deletion-1' });

  await assert.rejects(
    requestConfluenceErasure(mock.prisma as never, {
      organisationId: 'org-1',
      publicationId: 'publication-1',
      reason: 'Data subject erasure request 2026-41',
      requestedById: 'user-1',
      now: () => NOW,
    }),
    (error: { code?: string }) => error.code === 'CONFLUENCE_ERASURE_ALREADY_REQUESTED',
  );
  assert.equal(mock.created.length, 0);
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npm run build 2>&1 | tail -5
```

Expected: FAIL — `confluence-erasure-request.service.js` does not exist.

- [ ] **Step 3: Write the service**

Create `apps/api/src/services/confluence-erasure-request.service.ts`:

```ts
/**
 * The explicit erasure workflow.
 *
 * Until 2026-09-20 an ordinary document deletion enqueued a `confluence`
 * erasure row itself, and the page and its attachments were deleted and purged
 * without anyone asking for it. The owner ruled that an ordinary deletion
 * removes CharityPilot's record and its reference only, and that destroying the
 * Confluence source requires an explicit erasure workflow. This is that
 * workflow, and it is now the ONLY place a `confluence` erasure row is written.
 *
 * Everything downstream is unchanged: Phase 5's dispatcher, its permanence
 * mapping, its dead-lettering and its operator recovery drive the row exactly as
 * before. The change is who asks for it, and when.
 *
 * **Only a RETIRED publication can be erased**, which makes this a two-step
 * workflow: delete the document in CharityPilot, then erase the Confluence copy.
 * Allowing a request against a PROCESSED row would let an administrator destroy
 * the page that a live document still points at.
 */
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { publicationErasureTarget } from './document-publication.service.js';

export type ConfluenceErasureRequest = {
  organisationId: string;
  publicationId: string;
  reason: string;
  requestedById: string;
  now?: () => Date;
};

export type RetiredConfluencePublication = {
  id: string;
  documentId: string;
  pageTitle: string | null;
  pageId: string | null;
  retiredAt: Date | null;
  erasureRequestedAt: Date | null;
};

const PUBLICATION_SELECT = {
  id: true,
  documentId: true,
  pageTitle: true,
  pageId: true,
  retiredAt: true,
  erasureRequestedAt: true,
} as const;

/**
 * The retired publications this charity could still ask to erase.
 *
 * Without this the erase route is unreachable: the document is gone, so its id
 * is no longer in any list a charity can see, and nothing else names the
 * publication. `pageTitle` is what an administrator recognises — it carries the
 * document's name — and it is the only human-readable thing left once the
 * document row has been deleted.
 */
export async function listRetiredConfluencePublications(
  prisma: PrismaClient,
  organisationId: string,
): Promise<RetiredConfluencePublication[]> {
  return prisma.documentPublication.findMany({
    where: { organisationId, provider: 'confluence', state: 'RETIRED' },
    select: PUBLICATION_SELECT,
    orderBy: { retiredAt: 'desc' },
    take: 200,
  }) as Promise<RetiredConfluencePublication[]>;
}

export async function requestConfluenceErasure(
  prisma: PrismaClient,
  input: ConfluenceErasureRequest,
): Promise<{ deletionId: string }> {
  const now = input.now ?? (() => new Date());

  return prisma.$transaction(async (tx) => {
    const client = tx as unknown as PrismaClient;

    const publication = await client.documentPublication.findFirst({
      where: {
        id: input.publicationId,
        organisationId: input.organisationId,
        provider: 'confluence',
        state: 'RETIRED',
      },
    });

    if (!publication) {
      // One code for "not yours", "not there" and "not retired" deliberately:
      // telling a caller which of the three it was would confirm the existence
      // of another charity's publication id.
      throw new AppError(
        404,
        'CONFLUENCE_PUBLICATION_NOT_FOUND',
        'No retired Confluence publication with that id belongs to this charity. A page can only ' +
          'be erased after its document has been deleted in CharityPilot.',
      );
    }

    if (publication.erasureDeletionId !== null) {
      throw new AppError(
        409,
        'CONFLUENCE_ERASURE_ALREADY_REQUESTED',
        'An erasure has already been requested for this page. Check the document storage deletion ' +
          'queue for its progress rather than requesting a second one.',
      );
    }

    // Built through parseConfluenceErasureTarget, the arbiter that refuses an
    // empty or untrimmed id PERMANENTLY. Running it here means a malformed
    // target aborts this request while an operator is present to see it, rather
    // than dead-lettering hours later.
    const targetRef = publicationErasureTarget(publication);

    const deletion = await client.documentStorageDeletion.create({
      data: {
        organisationId: input.organisationId,
        // NOT how the row is addressed — the eraser reads targetRef. The column
        // is NOT NULL and this is what tells an operator which document a
        // dead-lettered row belongs to, now that the Document row is gone.
        storagePath: publication.retiredStoragePath ?? `publication:${publication.id}`,
        provider: 'confluence',
        targetRef,
      },
    });

    const stamped = await client.documentPublication.updateMany({
      // `erasureDeletionId: null` is the fence: two administrators clicking at
      // once produce one erasure, and the loser is told so rather than silently
      // queueing a second destruction of the same page.
      where: { id: publication.id, erasureDeletionId: null },
      data: { erasureRequestedAt: now(), erasureDeletionId: deletion.id },
    });

    if (stamped.count !== 1) {
      throw new AppError(
        409,
        'CONFLUENCE_ERASURE_ALREADY_REQUESTED',
        'An erasure was requested for this page at the same moment. Only one was queued.',
      );
    }

    return { deletionId: deletion.id };
  });
}
```

Confirm `publicationErasureTarget` is exported from `document-publication.service.ts`; if it is not, export it and leave its implementation untouched.

- [ ] **Step 4: Run the service tests**

```bash
cd apps/api && npm run build && node --test dist/tests/confluence-erasure-request.service.test.js
```

Expected: PASS, six tests.

- [ ] **Step 5: Write the failing route tests**

In `apps/api/src/tests/integrations-route.test.ts`. Use that file's own idiom: `buildApp({ rows, actor })` returning `{ app, store, actor }`, the actor constants `ORG_A_ADMIN` and `ORG_A_MEMBER`, and `bearer(actor)` for the header. **The plugin is registered without its mount prefix in these tests**, so the URL is `/confluence/...`, not `/api/v1/integrations/confluence/...`. `IntegrationRow` (~L52) will need `grantedScopes: string[]` adding.

```ts
const CONNECTED_WITHOUT_DELETE_SCOPES: IntegrationRow = {
  ...CONNECTED_ROW,
  grantedScopes: ['read:page:confluence', 'offline_access'],
};

test('a member cannot request a Confluence erasure', async () => {
  const { app } = await buildApp({ rows: [CONNECTED_WITHOUT_DELETE_SCOPES], actor: ORG_A_MEMBER });

  const response = await app.inject({
    method: 'POST',
    url: '/confluence/publications/publication-1/erase',
    headers: { authorization: bearer(ORG_A_MEMBER) },
    payload: { reason: 'Data subject erasure request 2026-41', confirmation: 'ERASE CONFLUENCE COPY' },
  });

  assert.equal(response.statusCode, 403, response.body);
});

test('an erasure is refused when the connection never granted the delete scopes', async () => {
  const { app } = await buildApp({ rows: [CONNECTED_WITHOUT_DELETE_SCOPES] });

  const response = await app.inject({
    method: 'POST',
    url: '/confluence/publications/publication-1/erase',
    headers: { authorization: bearer(ORG_A_ADMIN) },
    payload: { reason: 'Data subject erasure request 2026-41', confirmation: 'ERASE CONFLUENCE COPY' },
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, 'CONFLUENCE_ERASURE_SCOPE_MISSING');
  assert.equal(
    response.body.includes('delete:page:confluence'),
    true,
    'naming the missing scope is what makes the remedy obvious',
  );
});

test('an erasure needs the typed confirmation, not just a reason', async () => {
  const { app } = await buildApp({
    rows: [{ ...CONNECTED_ROW, grantedScopes: [...CONFLUENCE_REQUIRED_ERASURE_SCOPES] }],
  });

  const response = await app.inject({
    method: 'POST',
    url: '/confluence/publications/publication-1/erase',
    headers: { authorization: bearer(ORG_A_ADMIN) },
    payload: { reason: 'Data subject erasure request 2026-41', confirmation: 'yes' },
  });

  assert.equal(response.statusCode, 400, response.body);
});
```

Reuse whatever connected-row fixture already exists in that file for `CONNECTED_ROW`; if there is none, build one from `IntegrationRow` with `status: 'CONNECTED'` and a `config` carrying `siteId`.

Note that the `requireSessionLevel('ADMIN')` and `requireActionApproval()` preHandlers will reject these injected requests unless the file's `authModels` fake already satisfies them. If they do not, mirror whatever `apps/api/src/tests/documents-route.test.ts` does for `DELETE /documents/:id`, which carries the identical stack — do not drop the preHandlers to make a test pass.

- [ ] **Step 6: Add the routes**

In `apps/api/src/routes/integrations/index.ts`, add the imports:

```ts
import { z } from 'zod';
import { requireSessionLevel } from '../../middleware/session-level.js';
import { requireActionApproval } from '../../middleware/action-approval.js';
import {
  listRetiredConfluencePublications,
  requestConfluenceErasure,
} from '../../services/confluence-erasure-request.service.js';
```

and, after the publish-space route:

```ts
const confluenceErasureSchema = z
  .object({
    reason: z
      .string()
      .transform((value) => value.replace(/\r\n?/g, '\n').trim())
      .pipe(
        z
          .string()
          .min(10, 'Give an erasure reason of at least 10 characters')
          .max(500, 'Erasure reason must be at most 500 characters'),
      ),
    confirmation: z.literal('ERASE CONFLUENCE COPY'),
  })
  .strict();

const publicationIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/**
 * The pages this charity could still ask to erase — publications whose document
 * has been deleted in CharityPilot while the Confluence page was left standing.
 *
 * Note what this route does NOT accept: an `integrationId`. The publication is
 * found by its own id scoped to the authenticated organisation, the same rule
 * every other route in this file follows.
 */
app.get('/confluence/publications', async (request, reply) => {
  try {
    const rows = await listRetiredConfluencePublications(app.prisma, request.user.organisationId);
    return sendSuccess(reply, {
      publications: rows.map((row) => ({
        id: row.id,
        documentId: row.documentId,
        pageTitle: row.pageTitle,
        retiredAt: row.retiredAt ? new Date(row.retiredAt).toISOString() : null,
        erasureRequested: row.erasureRequestedAt !== null,
      })),
    });
  } catch (error) {
    handleError(reply, error);
  }
});

/**
 * Destroy the Confluence page a deleted document left behind.
 *
 * The same preHandler stack as `DELETE /documents/:id`, because it is the same
 * weight of action: a recent-authentication check and an explicit approval, on
 * top of the admin guard this whole plugin already applies.
 */
app.post<{ Params: { publicationId: string } }>(
  '/confluence/publications/:publicationId/erase',
  { preHandler: [requireSessionLevel('ADMIN'), requireActionApproval()] },
  async (request, reply) => {
    try {
      const body = confluenceErasureSchema.parse(request.body);
      const publicationId = publicationIdSchema.parse(request.params.publicationId);

      const integration = await findOwnConfluenceIntegration(app.prisma, request.user.organisationId);
      if (!integration || integration.status !== 'CONNECTED') {
        throw new AppError(
          404,
          'CONFLUENCE_NOT_CONNECTED',
          'This charity has no live Confluence connection, so nothing can be erased from it.',
        );
      }

      // Refused here rather than at Atlassian, and that is the whole point: the
      // call would 403, confluence-client reports a 403 as
      // CONFLUENCE_RECONNECT_REQUIRED, and an operator would be sent to fix a
      // connection that is not broken. Naming the missing scopes up front makes
      // the remedy — reconnect, which re-consents to the new scopes — obvious.
      const missing = missingConfluenceScopes(integration.grantedScopes);
      if (missing.length > 0) {
        throw new AppError(
          409,
          'CONFLUENCE_ERASURE_SCOPE_MISSING',
          'This Confluence connection was authorised before CharityPilot asked for permission to ' +
            'delete pages, so it cannot erase anything. Disconnect and reconnect Confluence to ' +
            'grant it, then request the erasure again.',
          { missingScopes: missing },
        );
      }

      const { deletionId } = await requestConfluenceErasure(app.prisma, {
        organisationId: request.user.organisationId,
        publicationId,
        reason: body.reason,
        requestedById: request.user.userId,
      });

      return sendSuccess(reply, { storageDeletionId: deletionId });
    } catch (error) {
      handleError(reply, error);
    }
  },
);
```

- [ ] **Step 7: Run the full suite**

```bash
cd apps/api && npm test 2>&1 | tail -30
```

Expected: PASS. Confirm the new test names appear in the TAP output by name, not just in the total.

- [ ] **Step 8: Mutation-check the gate**

In a scratchpad copy, mutate each independently:
1. `missing.length > 0` → `false` (proves the scope gate is covered)
2. `state: 'RETIRED'` in the service's `where` → remove it (proves the PROCESSED refusal is covered)
3. `erasureDeletionId: null` in the stamping `where` → remove it (proves the double-request fence is covered)

Canary each green mutation with a branch-body `throw`.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/confluence-erasure-request.service.ts apps/api/src/tests/confluence-erasure-request.service.test.ts apps/api/src/routes/integrations/index.ts apps/api/src/tests/integrations-route.test.ts
git commit -m "feat(integrations): erasing a Confluence page is now something you ask for"
```

---

## Task 5: Refuse to guess which Atlassian site a charity meant

**Files:**
- Modify: `apps/api/src/services/confluence-connection.service.ts` (~L676-696) — **closed file; reason: binding a charity to the wrong Atlassian site is a data-integrity fault and this is the only place the site is chosen**
- Test: `apps/api/src/tests/confluence-connection.service.test.ts`

**Interfaces:**
- Produces: `AppError` code `CONFLUENCE_MULTIPLE_SITES` (HTTP 400) from `connectConfluence`.

- [ ] **Step 1: Rewrite the existing two-site test, then add the refusal**

**An existing test asserts the behaviour being removed.** In `apps/api/src/tests/confluence-connection.service.test.ts`, `'connectConfluence records the site, stores both tokens, and clears any stale claim'` (~L1174) passes two accessible resources, comments that "the first is chosen", and asserts `config.siteCount: 2`. Change that test to pass **one** site and assert `siteCount: 1`; everything else it checks — the credential write order, the status flip being last, the authorization code never reaching a write — is unrelated and must keep passing unchanged.

Then add:

```ts
test('connectConfluence refuses to pick a site when the grant covers several', async () => {
  const fake = fakePrisma({ integration: { status: 'DISCONNECTED' }, storedRefreshToken: null });

  await assert.rejects(
    withKey(() =>
      connectConfluence(
        fake.client,
        { organisationId: ORG_ID, userId: 'user-9', code: 'auth-code', redirectUri: 'https://api.example/cb' },
        {
          now: clock,
          exchangeAuthorizationCode: async () => tokens(),
          listAccessibleResources: async () => [
            { id: 'site-9', url: 'https://charity.atlassian.net', name: 'Charity Wiki' },
            { id: 'site-10', url: 'https://other.atlassian.net', name: 'Someone Else' },
          ],
        },
      ),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'CONFLUENCE_MULTIPLE_SITES',
  );

  assert.equal(fake.credentialWrites.length, 0, 'no credential is stored when the site is ambiguous');
  assert.notEqual(fake.row().status, 'CONNECTED');
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npm run build && node --test dist/tests/confluence-connection.service.test.js 2>&1 | tail -20
```

Expected: FAIL — the new test connects successfully and binds `site-9` instead of rejecting.

- [ ] **Step 3: Refuse**

Replace the site-selection block (~L676-696):

```ts
  const sites = await listSites(tokens.accessToken, bounded);
  const site = sites[0];
  if (!site) {
    throw new AppError(
      400,
      'CONFLUENCE_NO_ACCESSIBLE_SITE',
      'The Atlassian account that authorised CharityPilot can reach no Confluence site.',
    );
  }

  // Taking sites[0] was wrong, and quietly so: Atlassian documents the order of
  // accessible-resources as meaningless, so an administrator who belongs to two
  // sites had a one-in-two chance of publishing their charity's governance
  // documents into the wrong company's Confluence — with nothing on any screen
  // saying which had been chosen.
  //
  // Refusing is the right shape rather than a stopgap, because the fix is a
  // property of the app itself: an OAuth app created with a RESOURCE-LEVEL
  // grant issues tokens scoped to the single site the user picks at consent, so
  // this list has exactly one entry and this branch never runs. That is how
  // CharityPilot's app is registered (see docs/production-runbook.md). If this
  // branch ever DOES run it means the app was registered with an account-level
  // grant, and a loud configuration error is exactly what should happen.
  //
  // The cost, stated plainly: an administrator of several Atlassian sites
  // cannot connect until CharityPilot offers a picker. Confluence is alpha and
  // opt-in, and a charity that cannot connect is a far smaller harm than a
  // charity connected to somebody else's site.
  if (sites.length > 1) {
    throw new AppError(
      400,
      'CONFLUENCE_MULTIPLE_SITES',
      'The Atlassian account that authorised CharityPilot can reach more than one Confluence ' +
        'site, and CharityPilot will not guess which one this charity meant. Authorise from an ' +
        'account with access to a single site, or ask CharityPilot support to check how the ' +
        'Atlassian app is registered.',
      { siteCount: sites.length },
    );
  }

  const config = {
    siteId: site.id,
    siteUrl: site.url,
    siteName: site.name,
    siteCount: sites.length,
  } satisfies Prisma.InputJsonObject;
```

- [ ] **Step 4: Run the suite**

```bash
cd apps/api && npm test 2>&1 | tail -30
```

Expected: PASS. Any existing test that fed several sites and expected a connection must be updated to expect the refusal — do not weaken the guard to keep an old expectation green.

- [ ] **Step 5: Mutation-check**

Mutate `sites.length > 1` → `sites.length > 2`. Expect red. Canary with a branch-body `throw`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/confluence-connection.service.ts apps/api/src/tests/confluence-connection.service.test.ts
git commit -m "fix(integrations): never guess which Atlassian site a charity meant

confluence-connection.service.ts is a closed file. The reason for touching it:
binding a charity to the wrong Atlassian site is a data-integrity fault, and
this is the only place the site is chosen."
```

---

## Task 6: Give the workers the credentials they need, and stop logging the key

**Files:**
- Modify: `compose.production.yml` (`production-scheduler` ~L104-125; `document-storage-cleanup` ~L165-173)
- Modify: `apps/api/package.json` (scripts)
- Modify: `apps/api/src/utils/logger.ts` (~L41-51)
- Modify: `.env.example`, `.env.production.example`, `.env.bluegreen.private-vm.example`
- Test: `scripts/check-bluegreen-compose.test.mjs`; `apps/api/src/tests/observability-reliability.test.ts` (or wherever the redaction list is pinned)

**Interfaces:**
- Produces: nothing importable. The deliverable is that `node dist/jobs/production-scheduler.js` under `compose.production.yml` can refresh an Atlassian token and open a sealed credential.

- [ ] **Step 1: Write the failing tests**

In `scripts/check-bluegreen-compose.test.mjs`, add a test over `compose.production.yml`:

```js
test('the production scheduler is given what the Confluence worker needs', () => {
  const compose = readFileSync(new URL('../compose.production.yml', import.meta.url), 'utf8');
  const scheduler = serviceBlock(compose, 'production-scheduler');

  for (const key of ['ATLASSIAN_CLIENT_ID', 'ATLASSIAN_CLIENT_SECRET', 'INTEGRATION_ENCRYPTION_KEY']) {
    assert.ok(
      scheduler.includes(key),
      `production-scheduler cannot publish or erase without ${key}; it uses an environment allowlist, not env_file`,
    );
  }
});

test('the document storage cleanup job can open a sealed credential', () => {
  const compose = readFileSync(new URL('../compose.production.yml', import.meta.url), 'utf8');
  const cleanup = serviceBlock(compose, 'document-storage-cleanup');

  for (const key of ['ATLASSIAN_CLIENT_ID', 'ATLASSIAN_CLIENT_SECRET', 'INTEGRATION_ENCRYPTION_KEY']) {
    assert.ok(cleanup.includes(key), `the Confluence eraser needs ${key}`);
  }
});
```

Write `serviceBlock(compose, name)` as a small helper in that file if one does not exist: take the lines from `  <name>:` up to the next line matching `^  \S`.

For the redaction list, the exported constant is `API_LOG_REDACT_PATHS` in `apps/api/src/utils/logger.ts`. Add to whichever suite already asserts over it (search for `env.ATLASSIAN_CLIENT_SECRET` under `apps/api/src/tests/`; if no suite asserts the list directly, put this in `observability-reliability.test.ts`):

```ts
test('the key that unseals every charity credential is redacted like its peers', () => {
  assert.ok(
    API_LOG_REDACT_PATHS.includes('env.INTEGRATION_ENCRYPTION_KEY'),
    'INTEGRATION_ENCRYPTION_KEY decrypts every stored Atlassian credential; it must never reach a log',
  );

  // Pinned as a set, so the next secret added to env is noticed here rather
  // than being the one that is forgotten.
  for (const secret of ['env.JWT_SECRET', 'env.AUTH_RECOVERY_SECRET', 'env.ATLASSIAN_CLIENT_SECRET']) {
    assert.ok(API_LOG_REDACT_PATHS.includes(secret), `${secret} must stay redacted`);
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /c/platforms/htdocs/charity-governence && node --test scripts/check-bluegreen-compose.test.mjs 2>&1 | tail -20
```

Expected: FAIL on all three keys for both services.

- [ ] **Step 3: Wire the compose services**

Add to the `production-scheduler` `environment:` block, after `DOCUMENT_STORAGE_CLEANUP_INTERVAL_MS`:

```yaml
      # The Confluence publisher refreshes an Atlassian token and the eraser
      # opens a sealed credential; both fail without these. This service uses an
      # explicit allowlist rather than env_file, so a value not named here is
      # simply absent — silently, at 3am, in a worker nobody is watching.
      ATLASSIAN_CLIENT_ID: ${ATLASSIAN_CLIENT_ID:-}
      ATLASSIAN_CLIENT_SECRET: ${ATLASSIAN_CLIENT_SECRET:-}
      INTEGRATION_ENCRYPTION_KEY: ${INTEGRATION_ENCRYPTION_KEY:-}
      DOCUMENT_PUBLICATION_INTERVAL_MS: ${DOCUMENT_PUBLICATION_INTERVAL_MS:-300000}
      DOCUMENT_PUBLICATION_LIMIT: ${DOCUMENT_PUBLICATION_LIMIT:-25}
```

Add the same three Atlassian/key lines to `document-storage-cleanup`. Use `:-` defaults, not `:?`: Confluence is optional and a deployment that has never configured it must still start.

- [ ] **Step 4: Wire the missing job entry point**

In `apps/api/package.json`, beside the existing `jobs:document-storage-cleanup` script:

```json
    "jobs:publish-document-mirrors": "node dist/jobs/publish-document-mirrors.js",
```

And add the matching `jobs`-profile service to `compose.production.yml`, copying `document-storage-cleanup` exactly and changing the command to `["node", "dist/jobs/publish-document-mirrors.js"]`, the service name to `document-publication`, and adding `DOCUMENT_PUBLICATION_LIMIT`.

- [ ] **Step 5: Redact the key and document the variables**

In `apps/api/src/utils/logger.ts`, add to the redaction list after `'env.ATLASSIAN_CLIENT_SECRET'`:

```ts
  'env.INTEGRATION_ENCRYPTION_KEY',
```

In all three `.env*.example` files, beside the existing publication settings, add:

```
# How often the in-process scheduler runs the Confluence publish outbox, and how
# many rows it claims per run. Defaults are 5 minutes and 25.
# DOCUMENT_PUBLICATION_INTERVAL_MS=300000
# DOCUMENT_PUBLICATION_LIMIT=25
```

- [ ] **Step 6: Run both suites**

```bash
cd /c/platforms/htdocs/charity-governence && node --test scripts/check-bluegreen-compose.test.mjs 2>&1 | tail -10 && cd apps/api && npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add compose.production.yml apps/api/package.json apps/api/src/utils/logger.ts .env.example .env.production.example .env.bluegreen.private-vm.example scripts/check-bluegreen-compose.test.mjs
git commit -m "fix(deploy): the production workers were never given their Atlassian credentials"
```

---

## Task 7: Say what the code now does

**Files:**
- Modify: `docs/production-runbook.md`
- Modify: `docs/ARCHITECTURE.md` ("What document erasure can and cannot prove", ~L415-573)
- Modify: `docs/CONTINUATION-PROMPT-confluence-integration.md` (§2a, §5)
- Modify: `docs/superpowers/specs/2026-09-20-confluence-connector-audit.md` (status line)

- [ ] **Step 1: Write the real-site verification checklist**

In `docs/production-runbook.md`, beside the existing Atlassian section, add a checklist to be run against the owner's own site before any tenant connects. Each line names what is being tested and what a failure means:

1. Register the app **with a resource-level grant** — chosen at creation and not convertible afterwards. Confirm `accessible-resources` returns exactly one site for a test authorisation; a second entry means the grant is account-level and `CONFLUENCE_MULTIPLE_SITES` will refuse every connection.
2. Confirm the consent screen lists the two delete scopes. If it does not, the erasure workflow will refuse with `CONFLUENCE_ERASURE_SCOPE_MISSING`.
3. Publish a document. Confirm the page is created in the chosen space with the expected title, and that the title Confluence stores is byte-identical to the one CharityPilot computed — adoption depends on it.
4. Read the page back with `GET /wiki/api/v2/pages/{id}`. Trash it in the UI and read again: confirm 404. Then confirm `GET /wiki/rest/api/content/{id}?status=trashed` returns 200, which is the only way to tell restorable from gone.
5. Confirm `space-id` sent as a single value filters as expected — create a same-titled page in another space and confirm `findPageByTitle` does not see it. If it does, title matching has silently widened to the whole site.
6. Round-trip a content property of just under 32 KB.
7. Delete the document in CharityPilot. Confirm the page is **still there** and the publication row reads `RETIRED`.
8. Request an explicit erasure. Confirm the page is deleted and purged, and that the read-back 404 is reached.

- [ ] **Step 2: Correct the architecture record**

In `docs/ARCHITECTURE.md`, rewrite the opening of "What document erasure can and cannot prove" to lead with the ruling: an ordinary deletion erases the Supabase copy and leaves the Confluence page; erasure from Confluence happens only on an explicit request against a retired publication; everything after that about purge permissions, the trash window and the attachment bound is unchanged and still true. Add the `RETIRED` state to the publication state machine wherever it is described.

- [ ] **Step 3: Update the handover**

In `docs/CONTINUATION-PROMPT-confluence-integration.md` §2a, replace "as of 2026-09-20 it still does" with what landed, naming the commits. In §5, mark items 5 (delete scopes), 6 (`sites[0]`), 7 (compose) and 8 (redaction) as fixed and leave 9 (refresh keepalive) open, since that is Tier 2.

- [ ] **Step 4: Update the audit's status line**

Change the audit's status paragraph to record that Tier 1 was approved and implemented on 2026-09-20, and that Tiers 2 and 3 remain proposals.

- [ ] **Step 5: Commit**

```bash
git add docs/production-runbook.md docs/ARCHITECTURE.md docs/CONTINUATION-PROMPT-confluence-integration.md docs/superpowers/specs/2026-09-20-confluence-connector-audit.md
git commit -m "docs(confluence): an ordinary deletion leaves the page, and erasure is asked for"
```

---

## Final verification

- [ ] `cd apps/api && npm test` — green, and the total is higher than at the start of the plan.
- [ ] `cd apps/web && npm test` — green and unchanged; no web file was touched.
- [ ] `npm run test:production-check` — the two pre-existing environmental failures are the only failures.
- [ ] `node --test scripts/check-bluegreen-compose.test.mjs` and `npm run check:production` — green.
- [ ] `git log --oneline -8` shows the seven task commits on `master`, and `git status` shows no file staged that this plan did not name.
- [ ] Confirm by name in TAP output that the new tests ran: the retirement tests, the erasure-request tests, the scope tests and the multi-site refusal.

## Deliberate deviations from the audit

These were decided while writing the plan and are recorded so a reviewer can object rather than discover them:

1. **`search:confluence` is not requested.** The audit's T1.2 included it for the later CQL adoption fallback. The DPO's standing ask is narrowest scopes, and a scope we do not yet use is one we should not yet hold. The cost is a second re-consent when Tier 2 builds CQL, which is cheap while the tenant count is zero or one.
2. **The site picker is not built.** The audit's T1.3 proposed a `SITE_SELECTION_REQUIRED` status and a `PUT /confluence/site` route. Task 5 refuses instead, because the resource-level grant makes the multi-site case unreachable for a correctly registered app, and the picker's blast radius (a new status value, a nullable `config.siteId`, and every reader of it) is Tier 2 work for a case that should never arise. The limitation is stated in the error message and the runbook.
3. **Erasure is restricted to `RETIRED` publications.** The audit did not say either way. Restricting it makes the workflow two-step and prevents an administrator destroying the page a live document still points at.
4. **A listing route was added** (`GET /confluence/publications`). The audit's T1.1 specified only the erase route, which would have been unreachable: the document is gone, so nothing else names the publication.
