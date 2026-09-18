# Continuation prompt — finish the Confluence integration

Paste everything below the line into a fresh session. It is written to stand alone.

---

## The goal

Finish the Confluence integration for CharityPilot, so that an Irish charity can connect its own Confluence site and have its governance documents published there — with Confluence remaining an **optional, per-tenant** backend that never becomes the only way to get a document into the platform.

Work until every phase below is complete and reviewed, or until you hit something only the owner can unblock. Do not stop to ask whether to continue.

## Where to start

Read these three files first, in this order. They carry the design, the reasoning, and every decision already made:

1. `docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md` — the spec. Why this exists, the three architectural options considered, and which was chosen.
2. `docs/superpowers/plans/2026-09-18-confluence-oauth-phase-2.md` — the phase in flight.
3. `docs/ARCHITECTURE.md`, section "Integration credentials: the envelope, the boundary, and rotation" — the security model, the error taxonomy, and a documented trap in the not-yet-written rotation job.

Then read `.superpowers/sdd/2026-09-18-confluence-oauth-phase-2/progress.md` — the execution ledger for the current phase, including every ruling made and why.

## What is already done

| Phase | What it is | Status |
|---|---|---|
| 0 | Per-tenant document storage | **Complete, migration applied** |
| 1 | Credential vault (envelope crypto, key validation, tables, store/load) | **Complete** |
| 2 | OAuth connection lifecycle | Tasks 1–3 complete; 4 and 5 remain |

Suite at last check: `apps/api` **1151 pass / 0 fail**, real-PostgreSQL migration suite **4 pass / 0 fail**. Always report against the current figure.

## What remains

**Phase 2** — finish Tasks 4 and 5 from its plan, then a whole-branch review.

**Phase 3 — the Confluence API client.** Not yet planned. Buildable without access to any real site, because the REST API is public and documented. One known trap: **Confluence's v2 API cannot upload attachments** — the endpoints are read-only — so uploads must use v1 `POST /wiki/rest/api/content/{pageId}/child/attachment` with an `X-Atlassian-Token: nocheck` header. The client is therefore a hybrid of both versions.

**Phase 4 — the publish pipeline.** **Do not design this blind.** It needs sight of the owner's real Governance Hub to decide how a governance document maps onto a page, and whether the `POL -` / `NOS -` page-name prefixes their DPO uses are a convention to key off. See Blockers.

**Phase 5 — provider-aware erasure.** Deletion currently assumes CharityPilot owns the bytes. Confluence deletes go to trash first and need a separate purge, and a tenant's own admins can restore content. The existing deletion pipeline exists because erasure has to be *provable*, so this is not a small extension. **Confluence cannot leave alpha until this ships.**

**Phase 6 — admin UI and per-tenant integration health.**

**The key rotation job** — deliberately deferred while there is nothing to rotate. Before writing it, read the "rotation trap" section in `docs/ARCHITECTURE.md`: flipping the active key generation makes every un-re-sealed credential fail as "unreadable", which looks identical to mass corruption and invites an operator response that destroys the recoverable data.

## How to work

**Use `superpowers:subagent-driven-development`.** Write a plan with `superpowers:writing-plans` before implementing any phase that does not have one. This process has caught real defects on every single task; do not shortcut it.

Non-negotiable, learned the hard way in this project:

- **Never run two implementer subagents at once.** They collide in the working tree and produce test runs that look like failures but are interference. Reviewers may run in parallel with an implementer on disjoint files.
- **Every fix round ends with a scoped re-review.** No exceptions.
- **Instruct reviewers to verify by mutation, not by reading.** Remove the behaviour, run the suite, confirm the test fails. Reviewers that did this found defects that reading the diff could not. Several also found real problems by going one step past the instruction — reading a sibling model's *migration* rather than just its schema, or probing a compiled module against a local stalling server.
- **Watch for correct-but-unpinned code.** It has appeared **six** times in this project: work that is right, but where deleting the protection leaves every test green. Ask of every task: what would still pass if this were removed?

## Standing constraints

**Branch:** commit directly to `master`. The owner has instructed that all work happens on the default branch — no worktrees, no feature branches, unless they ask in the moment. Treat that as the consent the superpowers skills require.

**Database:** `apps/api/.env` points at a real local development database with records in it.
- **Never** run `prisma migrate reset`, `prisma migrate dev`, `db push`, `DROP` or `TRUNCATE`.
- `prisma migrate dev` **will** fail — the database carries pre-existing drift unrelated to this work (column defaults, index-name truncation, a foreign-key change on `Resolution.governingActId`) and Prisma's only remedy is a destructive reset. There is also no shadow database configured.
- **Hand-write every migration** and apply with `npm run db:migrate:deploy`, which does not run drift detection. Recent migrations under `apps/api/prisma/migrations/` show the house format.
- `prisma.config.ts` disables Prisma's `.env` loading, so export first:
  `export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"`

**Closed files — do not modify without a stated reason:**
`apps/api/src/services/integration-crypto.ts`, `integration-credential.service.ts`, `atlassian-oauth.ts`, `confluence-connection.service.ts`. All are reviewed and carry security properties established by mutation testing.

**Product constraints from the owner:**
- Portal upload must always work. No integration may become the only way to get a document in.
- File storage must be Irish, or at minimum EU. Supabase's `eu-west-1` satisfies this; **Confluence does not**, because a site's region is chosen by the tenant's own admins and is not configurable at all on Atlassian's Free plan.
- Confluence ships as **alpha** — opt-in per charity, never a default, and it cannot be promoted until provider-aware erasure exists.

## Blockers only the owner can clear

State these plainly if they are in the way; do not work around them.

1. **Install the Atlassian MCP app** on `hour-timebank.atlassian.net`. The connector authenticates but every content call returns `403 "The app is not installed on this instance"`. This blocks **Phase 4** and makes Phase 3 unverifiable against a real space.
2. **Create an Atlassian OAuth 2.0 (3LO) app** at developer.atlassian.com/console/myapps, supplying `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET`. The scope that is easy to forget is **`offline_access`** — without it no refresh token is ever issued and every charity disconnects within the hour.
3. **Add `INTEGRATION_ENCRYPTION_KEY` to `.bluegreen/private-vm.env`** before the next deploy (`openssl rand -hex 32`, distinct from every other secret there). The deploy fails safely at the readiness gate without it, but it fails. **Back it up with the root secrets — losing it makes every stored charity credential permanently unreadable.**

## Deferred items to triage at the Phase 2 whole-branch review

Carried in the ledger, all Minor:

- The production refresh deadline default is not pinned — hardcoding a 10-minute value passes all tests, because the deadline test always injects its own.
- `connectConfluence`'s `exchangeAuthorizationCode` and `listAccessibleResources` are unbounded; a stall holds an OAuth authorization code hostage.
- The claim lease dominates only the HTTP phase; two unbounded database round trips sit inside it.
- One test's "not a revoked grant" assertion is weaker than it reads — it throws a plain error, which the predicate rejects regardless.
- A 5ms deadline test could flake on a loaded CI box.
- `scripts/check-production.mjs` keeps its own required-variable list, separate from the one the API enforces — two lists that can drift.

## What to tell the owner at the end

They are not an expert in this code and have said so. Report in plain terms: what now works that did not, what decisions you made on their behalf and what each costs if wrong, what is still blocked on them, and what you would do next. Do not bury a real problem in detail, and do not claim something is verified when it is only written.
