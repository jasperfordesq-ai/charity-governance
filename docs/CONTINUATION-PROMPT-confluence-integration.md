# Continuation prompt — finish the Confluence integration

Paste everything below the line into a fresh session. It is written to stand alone.

*Last updated 2026-09-19, after Phase 4 closed. **Every phase is done.** What remains is verification against a real site, one deferred job, and decisions that are the owner's.*

---

---

## START HERE — do not just carry on building

Every phase in the original plan is built. **That does not mean the next step is more building.**
Two things happened after the code was written, and both change what should happen next.

### 1. The DPO asked us to pause at the publish pipeline, and we built it anyway

Nikita Serkevich (DPO) wrote on **2026-09-19 09:26**:

> *"continue with option (a) as far as completing the Confluence API client, but **pause before
> building the publish pipeline**. After the API client is working, I would put the effort into the
> administration panel and getting the existing application into a state where I can review it
> properly."*
>
> *"I do not want you designing the document mapping around assumptions about our Governance Hub
> before we have looked at the actual spaces, permissions, document lifecycle and approval
> structure together."*

Phase 4 **is** that publish pipeline, and it was built after that email, on the owner's explicit
instruction. The owner is the director and that is their call to make — **do not re-litigate it.**
But know the position you are inheriting:

- The admin panel he asked for next (Phase 6) **is** done.
- The mapping deliberately does **not** guess his `POL -` / `NOS -` convention. There is a single
  documented function, `conventionalDocumentName`, to change once the Hub has been seen.
- Nothing publishes without a connected site **and** a chosen space. Neither exists for him.
- Nothing has ever touched a real Confluence site.

What is *not* mitigated: the title scheme, page body, metadata contents and erasure semantics were
all chosen without seeing the Hub. Those are the decisions he wanted to make together.

### 2. The erasure model is being reworked — do not build on the current one

Nikita: *"An ordinary CharityPilot deletion should not silently destroy the Confluence source."*

Phase 4 Task 8 does exactly that. **It is wrong and it is being changed.** The owner's direction,
agreed 2026-09-19:

> **CharityPilot must not delete anything from Confluence.** If a document exists in Confluence on a
> Confluence-enabled tenant, deleting it in CharityPilot is **refused**, with a message telling the
> user to go to Confluence. If it is deleted in Confluence, CharityPilot shows a note that it is no
> longer visible there.

**An open question blocks the start of this work.** "CharityPilot mirrors everything in Confluence"
admits two readings, and they are materially different jobs:

- **(a)** Keep the flow as built — documents originate in CharityPilot and publish to Confluence —
  but refuse deletion once published. *Small.*
- **(b)** Invert it — Confluence is where documents live; CharityPilot reads and references them.
  *Large: the publish pipeline becomes a read/reconcile pipeline.*

**(a) was recommended**, because Nikita's own steer is *"agree the publishing model before building
it"* — after he has walked the Hub with the owner. Inverting now would make exactly the decision he
asked to make together, and (a) does not foreclose (b). **The owner had not answered when this
session ended. Ask before building.**

Four details that decide whether the refusal is any good:

1. **Do not create undeletable records.** If Confluence is disconnected, or the page is confirmed
   gone, deletion must become possible again.
2. **Do not say "deleted" when you mean "not visible".** A vanished page may be in Confluence's
   trash and restorable — and whether a trashed page reads as missing is still unverified.
3. **Detecting a Confluence-side deletion is new work** — a job re-reading each referenced page.
4. **Refusing deletion must not freeze everything else.** Approval status, review dates and evidence
   links stay authoritative in CharityPilot; they must remain editable on a document that cannot be
   deleted.

**Good news on cost:** the provable-erasure machinery Nikita describes — recording the instruction,
the action taken, the verified final state, and an administrator action where automatic deletion is
impossible — **already exists** from Phase 5. `COMPLETE_EXTERNALLY_REMEDIATED` is literally "a human
did this outside the system", recorded with actor, reason and transaction id. It is wired to the
wrong trigger, not missing.

### 3. What else his 2026-09-19 email changed

- **The Atlassian OAuth app is the owner's to create, not his.** One controlled integration, narrowest
  scopes including `offline_access`, owned organisationally rather than by a personal account.
- **Do not ask him to install anything yet.** He wants the OAuth app and consent flow configured
  first; that may resolve the 403 without anything more invasive.
- **Residency: he would NOT make EU residency a universal prerequisite** for other tenants. Record
  each tenant's *declared* configuration and be explicit that CharityPilot does not control it. This
  conflicts with the owner's standing "Irish or EU" rule — **the owner's to settle, not yours.**
- **Two loose ends not yet done:** development logs holding the leaked OAuth codes must be *cleared
  or allowed to expire*; and he wants least-privilege Tailscale access (CharityPilot only, filing
  bridge separately, no access to the personal machine).
- **He still cannot connect at all.** Device connected, DNS resolving, ping and port 443 both time
  out — points at the access policy, the firewall, or the service not listening on the Tailscale
  interface. **He has been unable to review since 2026-08-31.** This blocks his step 1, which
  everything else in his ordering sits behind.

---

## The goal

Finish the Confluence integration for CharityPilot, so that an Irish charity can connect its own
Confluence site and have its governance documents published there — with Confluence remaining an
**optional, per-tenant** backend that never becomes the only way to get a document into the
platform.

Work until every phase below is complete and reviewed, or until you hit something only the owner
can unblock. Do not stop to ask whether to continue.

## Read these first, in this order

1. `docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md` — the spec. **Read its
   "Open questions for the owner" section before anything else: Question 1 has been answered, and
   answered against the architecture the rest of the spec argues from.** See Blockers below.
2. `docs/superpowers/plans/2026-09-18-provider-aware-erasure-phase-5.md` — the phase just completed; its **Facts verified against Atlassian** table and the **explicit unknown** beneath it both matter.
3. `docs/ARCHITECTURE.md`, section "Integration credentials: the envelope, the boundary, and
   rotation" — the security model, the error taxonomy, and a documented trap in the not-yet-written
   rotation job.

Then read the execution ledger for whichever phase is in flight, at
`.superpowers/sdd/<plan-basename>/progress.md`. It carries every ruling made and why. That
directory is gitignored scratch — if it is missing, recover from `git log`, which is complete.

## What is already done

| Phase | What it is | Status |
|---|---|---|
| 0 | Per-tenant document storage | **Complete, migration applied** |
| 1 | Credential vault (envelope crypto, key validation, tables, store/load) | **Complete** |
| 2 | OAuth connection lifecycle | **Complete**, reviewed, fix round applied |
| 3 | Confluence API client (v1/v2 hybrid) | **Complete.** Five tasks, whole-branch review passed with nothing Critical, fix round applied, scoped re-review clean |
| 4 | Publish pipeline | **Complete.** Eight tasks, whole-phase review, two fix rounds, independent verification. Built on the reversible reading of Open Question 1 — see below |
| 5 | Provider-aware erasure | **Complete.** Seven tasks, whole-phase review, fix round, clean re-review |
| 6 | Admin UI and per-tenant integration health | **Complete.** Five tasks, whole-phase review, three fix rounds, independent verification |

Suite at last measurement: `apps/api` **1646 pass / 0 fail**, `apps/web` **476 pass / 0 fail**,
real-PostgreSQL migration suite **4 pass / 0 fail**, `packages/shared` **57 pass / 0 fail**,
`test:production-check` **1062 pass / 2 pre-existing environmental fails / 2 skipped** (the two
reproduce identically on a pristine baseline and differ by host — do not read them as a regression).
Always report against the current figure, not these.

**Every phase is built.** Phase 4 was completed on the *reversible* reading of Open Question 1 —
**Confluence is a mirror; Supabase in Ireland keeps the authoritative copy.** If the DPO's reading
wins instead, the cost is a spare Irish copy nobody needed. Had it been built the other way and the
mirror reading won, charity documents would sit outside Ireland with no Irish copy, breaking a
standing owner constraint. Only one direction is reversible. **The question is still the owner's and
still unanswered** — see Blocker 1.

**Nothing here has ever touched a real Confluence site.** Four assumptions hold against every fake
written for this work and have never met the real thing; they are listed under "Confirm these
against a real site" in the Phase 4 plan. **Read that list before trusting anything Confluence-side.**

**Everything Confluence-side is proven against fakes.** No call has ever been made to a real site.
A fake cannot tell you Atlassian changed a status code, and every fake in this suite was written to
the behaviour we assumed.

## How to work

**Use `superpowers:subagent-driven-development`.** Write a plan with `superpowers:writing-plans`
before implementing any phase that does not have one. This process has caught real defects on
every single task — including four in a plan before any code was written. Do not shortcut it.

### Testing — get this right before you write anything

**There is no Vitest in this repository.** It is not a dependency and `npx vitest` fails. All test
files use `node:test` with `node:assert/strict`: no `describe`, no `it`, no `expect`, no `it.each`
(loop for table-driven cases). `npm test` in `apps/api` is `tsc && node --test dist/tests/*.test.js`
— **tests run from `dist/`**, so an edited test re-run without a rebuild runs its previous version.

**For mutation testing, skip the build.** Copy `apps/api/src` into a scratchpad, junction
`node_modules`, then `node --import tsx --test src/tests/*.test.ts`. Mutations take effect
immediately and the working tree is never touched.

**Always re-check a green mutation with a canary,** and say which form you used. For `if (C) X;`,
replacing the *whole statement* with a `throw` tells you the line was reached; replacing the
*branch body* tells you `C` was ever true. Branch-body is canonical for a conditional. This
distinction is what proved two Phase 3 guards had zero coverage rather than weak coverage.

### Non-negotiable, learned the hard way here

- **Never run two implementer subagents at once.** They collide in the working tree and produce
  test runs that look like failures but are interference.
- **Reviewers and fixers copy into the scratchpad and mutate there — never the working tree.** One
  in-place mutation cost a concurrent task three phantom failures and a false alarm about a deleted
  security guard.
- **Every fix round ends with a scoped re-review.** No exceptions.
- **Instruct reviewers to verify by mutation, not by reading.** Reviewers that did this found
  defects reading could not.
- **Watch for correct-but-unpinned code.** It has appeared **eight** times in this project: work
  that is right, but where deleting the protection leaves every test green.
- **Mutate each ANDed sub-condition independently, never the enclosing statement.** A compound
  mutation can go red *for the wrong reason*, which is indistinguishable from coverage. Likewise
  mutate each call site separately — removing six guards at once cannot tell "every site guarded"
  from "at least one guarded". Both produced real false-coverage claims in Phase 5.
- **Build every mutation baseline from a pristine source** (`git archive HEAD` into a new
  directory). A reused scratchpad has already produced a wrong failure count.
- **An implementer's self-reported mutation table is a claim, not evidence.** One reported full
  coverage and "no concerns" and was wrong on both counts. Re-run the table.

## Standing constraints

**Branch:** commit directly to `master`. No worktrees, no feature branches unless the owner asks in
the moment. Treat that as the consent the superpowers skills require.

**Database:** `apps/api/.env` points at a real local development database with records in it.
- **Never** run `prisma migrate reset`, `prisma migrate dev`, `db push`, `DROP` or `TRUNCATE`.
- `prisma migrate dev` **will** fail — the database carries pre-existing drift unrelated to this
  work, and Prisma's only remedy is a destructive reset. There is no shadow database.
- **Hand-write every migration** and apply with `npm run db:migrate:deploy`, which skips drift
  detection. Recent migrations under `apps/api/prisma/migrations/` show the house format.
- **Adding an enum value has two house patterns and they are not interchangeable.** If the new
  value is *used* later in the same migration, rebuild the enum (`RENAME TO …_legacy`, `CREATE`,
  repoint, `DROP`); if it is only declared, use `ADD VALUE IF NOT EXISTS`. PostgreSQL rejects *use*
  of a new value before commit when the migration runs as one simple query, and
  `20260710190000_add_deadline_calendar_lifecycle/migration.sql` records this verbatim.
- `prisma.config.ts` disables Prisma's `.env` loading, so export first:
  `export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"`
- Any new Prisma model must be added to `DISPOSABLE_DATABASE_RESET_TABLES` in `e2e/helpers/db.ts`.
  The guard lives in `npm run test:production-check`, **not** in the default `npm test`.

**Closed files — do not modify without a stated reason:**
`apps/api/src/services/integration-crypto.ts`, `integration-credential.service.ts`,
`atlassian-oauth.ts`, `confluence-connection.service.ts`. All carry security properties established
by mutation testing. Phase 5 Task 6 is explicitly authorised to open the last one, and only for
the revocation change named there.

**Product constraints from the owner:**
- Portal upload must always work. No integration may become the only way to get a document in.
- File storage must be Irish, or at minimum EU. **This is now in tension with the DPO's signed-off
  architecture — see Blocker 1.**
- Confluence ships as **alpha** — opt-in per charity, never a default, and it cannot be promoted
  until provider-aware erasure (Phase 5) exists.

## Blockers only the owner can clear

State these plainly if they are in the way; do not work around them.

1. **RULE ON THE AUTHORITY QUESTION. This is the big one and it is new.**
   The spec is built on Mode C: Supabase in Ireland is authoritative, Confluence is a published
   mirror. The spec lists as Open Question 1 whether Nikita accepts that, and says it must be
   settled before Phase 1. It was settled on 2026-09-18, after Phase 3, and he said **no** — he
   signed off on Confluence being authoritative for the documents deliberately managed there
   (policies, notices, guidelines), with CharityPilot holding **references, explicitly not
   duplicate copies**, and sensitive categories staying in CharityPilot.

   That is a coherent DPO position but it is not Mode C, and the difference decides whether a
   charity's policy document is guaranteed to sit in Ireland — a Confluence site's region belongs
   to the tenant's own admins and is not configurable at all on the Free plan.

   **Nothing built so far depends on the answer** (Phases 0–3 are credential and transport
   plumbing; Phase 5 reads its erasure target from `targetRef` rather than assuming a Supabase
   twin). But **Phase 4 must not be designed until this is ruled on**, and the residency paragraph
   in Phase 5's documentation task is deliberately marked blocked rather than guessed.

2. **Install the Atlassian MCP app** on `hour-timebank.atlassian.net`. The connector authenticates
   but every content call returns `403 "The app is not installed on this instance"`. This blocks
   Phase 4 and makes Phase 3 unverifiable against a real space — everything there is proven against
   fakes, and a fake cannot tell you Atlassian changed a status code.

3. **Create an Atlassian OAuth 2.0 (3LO) app** at developer.atlassian.com/console/myapps, supplying
   `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET`. The scope that is easy to forget is
   **`offline_access`** — without it no refresh token is ever issued and every charity disconnects
   within the hour. **The callback URL changed in Phase 6.** Register it as exactly
   `{FRONTEND_URL}/integrations/confluence/callback` — a **web** URL, not an API one. Atlassian
   matches it byte-for-byte. The old API address still answers, deliberately, with a `410` naming
   the change and carrying the exact URL to paste in — so a stale registration fails loudly rather
   than silently. Note `FRONTEND_URL` may hold a comma-separated list; only the **first** origin
   becomes the `redirect_uri`, so a two-origin deployment can complete the connect flow from that
   one only. Neither variable is required to
   boot: a deployment without them starts normally and the connect route refuses with an actionable
   503. Set **both or neither** — exactly one, or a placeholder in either, is refused at boot.

4. **Add `INTEGRATION_ENCRYPTION_KEY` to `.bluegreen/private-vm.env`** before the next deploy
   (`openssl rand -hex 32`, distinct from every other secret there). The deploy fails safely at the
   readiness gate without it, but it fails. **Back it up with the root secrets — losing it makes
   every stored charity credential permanently unreadable.**

## Sequencing the owner should know about

Nikita's agreed order of work puts **moving the backend off the home VM to hosted infra with
off-host backup** *before* building the Confluence integration. That is his headline risk:
production and its backups both live on one machine in the owner's house. The integration code
(credential vault, OAuth, storage providers, client) is portable and is not wasted by being built
early — but it is not what he is waiting on.

## Known deferred items

- **The key rotation job.** Deliberately deferred while there is nothing to rotate. Before writing
  it, read the "rotation trap" section in `docs/ARCHITECTURE.md`: flipping the active key
  generation makes every un-re-sealed credential fail as "unreadable", which looks identical to
  mass corruption and invites an operator response that destroys the recoverable data.
- **The callback session hazard.** Documented in `docs/ARCHITECTURE.md`, subsection "The callback
  is cookie-authenticated, and the session can expire mid-flow", not solved. The 15-minute access
  token runs from login, not from the start of the OAuth flow, so an expired-session 401 on the
  callback — with the authorization code already spent — is the ordinary path. Needs a web-side
  decision.
- **`updatePage` cannot distinguish a stale version from a duplicate title.** Both arrive as 409
  and the client deliberately surfaces no response body. The error message now names both causes
  without asserting either, but a pipeline branches on a *code*, so the capability gap is open.
  Closing it costs either a caller-side re-read comparing the title (a round trip) or a carve-out
  in the containment rule that keeps raw upstream bodies out of logs (a security guard that exists
  because a proxy once leaked a live authorization code that way). **Do not conflate the two.**
- **Invert the `confluence-attachments.ts` → `routes/documents/` import**, with a test that the
  service does not import from `routes/`.
- Several Minor items from the Phase 2 review remain open and are listed in that phase's ledger.

## What to tell the owner at the end

They are not an expert in this code and have said so. Report in plain terms: what now works that
did not, what decisions you made on their behalf and what each costs if wrong, what is still
blocked on them, and what you would do next. Do not bury a real problem in detail, and do not claim
something is verified when it is only written — in particular, say plainly that everything
Confluence-side is proven against fakes until Blocker 2 is cleared.
