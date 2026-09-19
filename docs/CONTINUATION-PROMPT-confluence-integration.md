# CharityPilot × Confluence — handover

*Last rewritten 2026-09-19, after Phase 4 closed. Paste everything below the line into a fresh
session; it is written to stand alone.*

---

# Where we are, in one paragraph

**Every phase of the Confluence integration is built, reviewed and green — and almost none of it has
been used.** No call has ever reached a real Atlassian site. Four assumptions the design rests on
have only ever met test doubles. The DPO who is meant to review it has been unable to connect since
31 August. One design decision the owner made on 2026-09-19 means part of what was just built has to
be reworked, and that rework is blocked on a question the owner has not yet answered. **The next
step is almost certainly not more building.**

---

# 1. What exists

| Phase | What it delivers | State |
|---|---|---|
| 0 | Per-tenant document storage — each charity resolves to its own backend | Complete |
| 1 | Credential vault — AES-256-GCM envelope encryption, key generations, no token ever logged | Complete |
| 2 | OAuth connection lifecycle — connect, refresh, disconnect. Atlassian's refresh tokens are single-use, so refreshes are serialised per charity | Complete |
| 3 | Confluence API client — v1/v2 hybrid; pages, attachments, content properties, delete and purge | Complete |
| 5 | Provider-aware erasure — dispatch by provider, dead-lettering, operator recovery, read-back proof | Complete. **Its delete-both-copies behaviour is being reworked — see §2** |
| 6 | Integration admin screens — connect/disconnect, the OAuth callback moved to a web page, per-tenant health | Complete. **"Admin panel" is broader than this — see §2** |
| 4 | Publish pipeline — outbox, create-or-adopt, page mapping, dual erasure | Complete. **Built after the DPO asked us to pause — see §4** |

**Suites at handover** — always re-run rather than quoting these:

- `apps/api` **1646 pass / 0 fail**, plus a real-PostgreSQL migration pass **4 / 0**
- `apps/web` **476 / 0**
- `packages/shared` **57 / 0**
- `npm run test:production-check` **1062 pass / 2 fail / 2 skipped** — both failures are
  pre-existing and environmental, reproduce identically on a pristine baseline, and differ by host.
  **Not a regression.**

## Things worth knowing about what was built

**The publish pipeline never simply retries a page creation.** `createPage` is deliberately
non-idempotent, because a retried create produces two pages for one board resolution with nothing
saying which is real — and an outbox retries by nature. The sequence is **create-or-adopt**: look up
the title a previous attempt would have used, and adopt that page rather than making a second. That
safety property depends entirely on the computed title matching what Confluence stores, which broke
three times in review (length, whitespace and control characters, then Unicode forms and invisible
characters) before being closed at the class.

**Three separate routes leaked live OAuth authorization codes**, each found only after the previous
was declared closed. All three are fixed and a build check now fails if a fourth appears. The Caddy
redaction filter is **load-bearing on the normal path** — documentation that once implied it could
be retired has been corrected; do not remove it.

**The OAuth callback is a page in the web app, not an API redirect.** The access-token cookie lives
15 minutes from *login*, so an administrator routinely reaches Atlassian's consent screen with under
a minute left and returns with a dead session and a spent single-use code. The page renews the
session *before* spending the code. **This changed what you register with Atlassian** — see §5.

---

# 2. What is wrong, and being reworked

## 2a. Ordinary deletion must stop destroying the Confluence source

The DPO's position, 2026-09-19: *"An ordinary CharityPilot deletion should not silently destroy the
Confluence source."* Phase 4's final task does exactly that.

**The owner's ruling, 2026-09-19 — this is the design to build:**

> CharityPilot must not delete anything from Confluence. Deleting a Confluence-backed document on a
> Confluence-enabled tenant is **refused**, telling the user to go to Confluence instead. A document
> deleted in Confluence gets a note in CharityPilot that it is no longer visible there.

**An open question blocks starting. The owner had not answered when this session ended.**
"CharityPilot mirrors everything in Confluence" admits two readings, and they are materially
different jobs:

- **(a)** Keep the flow as built — documents originate in CharityPilot and publish to Confluence —
  but refuse deletion once published. **Small.**
- **(b)** Invert — Confluence is where documents live and CharityPilot reads and references them.
  **Large:** the publish pipeline becomes a read/reconcile pipeline.

**(a) was recommended**, because the DPO's own steer is *"agree the publishing model before building
it"*, after he has walked the Governance Hub with the owner. Inverting now pre-empts exactly that
conversation, and (a) does not foreclose (b). **Ask; do not guess.**

**The cost is low, and here is why.** The machinery the DPO describes — recording the instruction,
the action taken, the verified final state, and an administrator action where automatic deletion is
impossible — **already exists** from Phase 5. `COMPLETE_EXTERNALLY_REMEDIATED` is literally "a human
did this outside the system", recorded with actor, reason and database transaction id. It is wired
to the wrong trigger, not missing. Mechanically, one private helper — `createConfluenceErasureRow`
in `document.service.ts` — is called from two places; stopping the destruction means not calling it
from the delete path.

**Four details decide whether the refusal is any good:**

1. **Do not create undeletable records.** A disconnected integration, or a page confirmed gone, must
   re-enable deletion.
2. **Do not say "deleted" when you mean "not visible".** A vanished page may be restorable from
   Confluence's trash — and whether a trashed page even reads as missing is unverified (§5).
3. **Detecting a Confluence-side deletion is new work** — a job re-reading each referenced page.
4. **Refusing deletion must not freeze everything else.** Approval status, review dates and evidence
   links stay authoritative in CharityPilot and must remain editable.

## 2b. "The admin panel" means three things; one of them does not exist

The DPO asked for *"the administration panel and getting the existing application into a state where
I can review it properly."* The owner described it to him as *"configuring tenants and viewing each
charity's integration health."*

| Piece | State |
|---|---|
| Configuring tenants — `apps/web/src/app/(owner)/owner/tenants/…` | **Already existed**, built 2026-09-02 |
| Charity-facing Confluence screens — connect, disconnect, choose a space, disclosure | **Built** (Phase 6 + Phase 4 Task 3) |
| **Viewing each charity's integration health from the owner console** | **NOT BUILT.** The data exists — Phase 6 put `provider` on dead-letter listings and the operator preview — but nothing in `(owner)/owner/tenants/[id]` surfaces it |
| *"A state where I can review it properly"* | **Not planned.** Vague, and arguably the real ask |

Do not read "Phase 6 is done" as "the admin panel is done". The third row matches the owner's own
words to the DPO and is small. The fourth should be made concrete by the owner before anyone builds
to it.

---

# 3. Decisions that are the owner's, not yours

1. **The (a)/(b) fork above.** Blocks the erasure rework.
2. **Residency.** The owner's standing rule is that file storage is Irish, or at minimum EU. The DPO
   said on 2026-09-19 he would **not** make EU residency a universal prerequisite for other tenants
   — record each tenant's *declared* configuration and be explicit that CharityPilot does not
   control it. Those conflict. Phase 4 was built on the **reversible** reading (Confluence is a
   mirror; Supabase in Ireland keeps the authoritative copy) precisely so this could be settled
   later: if the other reading wins the cost is a spare Irish copy, whereas the opposite mistake puts
   charity documents outside Ireland with no Irish copy.
3. **What "a state I can review properly" means.** Ask before building.

---

# 4. What the DPO asked for, and where we diverged

His email of **2026-09-19 09:26** set the order: *complete the API client → **pause** the
publish/mapping layer → build the administration panel → let him review → **then** agree the
publishing model.*

**Phase 4 is that publish pipeline, and it was built after that email, on the director's explicit
instruction.** That is the director's call and **is not to be re-litigated.** Know the position you
inherit:

- The admin panel he asked for next **is** done (with the gap in §2b).
- The mapping deliberately does **not** guess his `POL -` / `NOS -` convention — there is one
  documented function, `conventionalDocumentName`, to change once the Hub has been seen.
- Nothing publishes without a connected site **and** a chosen space. Neither exists for him.
- Nothing has touched a real site.

Not mitigated: the title scheme, page body, metadata contents and erasure semantics were chosen
without seeing the Hub. Those are the decisions he wanted to make together.

**Other things that email changed:**

- **The Atlassian OAuth app is the owner's to create**, not his — one controlled integration,
  narrowest scopes including `offline_access`, owned organisationally not personally.
- **Do not ask him to install the Atlassian app yet.** OAuth app and consent flow first; that may
  clear the 403 without anything more invasive.
- **Two loose ends, not done:** clear or expire the development logs holding the leaked OAuth codes;
  and give him least-privilege Tailscale access (CharityPilot only, filing bridge separately, not
  the personal machine).

**He still cannot connect, and has not reviewed anything since 31 August.** His device is signed
into a **different tailnet** and reaches CharityPilot only through a half-broken device share; the
fix is `tailscale switch`, not reinstalling. See the `nikita-tailscale-access-state` memory. This
blocks step 1 of his own ordering, which everything else sits behind.

---

# 5. Blocked on the real world

**Nothing Confluence-side has ever run against a real Atlassian site.** Four assumptions hold
against every test double written for this work and have never met the real thing. They are listed
under *"Confirm these against a real site the moment the app install lands"* in the Phase 4 plan:

1. **Does a trashed page read back as 404?** If it does, a delete that succeeded but did not purge
   looks like proven erasure. Bears directly on what erasure can claim.
2. **Are page titles unique within a space?** The whole adopt-instead-of-duplicate design rests on
   it. Implied by Atlassian's own duplicate-title 409, never documented.
3. **Does the space filter work sent as a bare string?** Atlassian documents an array of integers;
   the client can only send one value per key. If ignored, title matching widens from the space to
   the whole site — caught loudly by the ambiguity guard, but unverified.
4. **How does Confluence normalise a stored title?** Adoption depends on the computed title matching
   what is stored. Three normalisation classes have already broken it.

**Owner actions outstanding:**

- **Create the Atlassian OAuth 2.0 (3LO) app**, supplying `ATLASSIAN_CLIENT_ID` and
  `ATLASSIAN_CLIENT_SECRET`. The scope that is easy to forget is **`offline_access`** — without it
  no refresh token is issued and every charity disconnects within the hour. Set **both or neither**;
  one alone, or a placeholder, is refused at boot.
- **Register the callback as exactly `{FRONTEND_URL}/integrations/confluence/callback`** — a **web**
  URL, changed in Phase 6. Atlassian matches it byte-for-byte. The old API address answers `410`
  naming the change, so a stale registration fails loudly. Note `FRONTEND_URL` may hold a
  comma-separated list; **only the first origin** becomes the `redirect_uri`.
- **Add `INTEGRATION_ENCRYPTION_KEY` to `.bluegreen/private-vm.env`** (`openssl rand -hex 32`,
  distinct from every other secret). The deploy fails safely at the readiness gate without it.
  **Back it up with the root secrets — losing it makes every stored charity credential permanently
  unreadable.**

---

# 6. How to work in this repository

**Use `superpowers:subagent-driven-development`.** Write a plan with `superpowers:writing-plans`
first. This process found real defects on every task in this session — including four in a plan
before any code was written, and two Criticals that were *reproduced* rather than argued.

## Process rules, learned the hard way

- **Never run two implementer subagents at once.** A reviewer may run alongside an implementer if it
  works only in its scratchpad and does **not** run the repo's own build.
- **Every fix round ends with a scoped re-review.** It overruled a confident "no leak" conclusion
  once and was right.
- **Verify by mutation, not by reading.** Re-run an implementer's own mutation table rather than
  accepting it — one reported full coverage and "no concerns" and was wrong on both.
- **Mutate each ANDed sub-condition independently, and each call site separately.** A compound
  mutation can go red *for the wrong reason*, which is indistinguishable from coverage. This found
  real gaps three times.
- **Follow any green mutation with a canary** (`throw` in the branch body) and say which form. A
  green mutation alone cannot tell an untested guard from a line that never executes.
- **Watch for correct-but-unpinned code.** It appeared **nine** times. It was finally retired at the
  root by making a test double honour `args.select` rather than patching call sites. Expect it
  anyway.

## Testing

**There is no Vitest anywhere.** Both apps use `node:test` + `node:assert/strict` — no `describe`,
`it`, `expect`, `it.each`; loop for table-driven cases.

- `apps/api`: `npm test` = `tsc` then `node --test dist/tests/*.test.js`
- `apps/web`: compiles to `.test-dist/` then `node --import tsx --test`

Both run from compiled output, so **an edited test re-run without a rebuild runs its previous
version.**

**Mutation setup:** copy the source to a scratchpad, junction the **repository root's**
`node_modules` (hoisted monorepo — the inner ones lack `tsx`/`typescript`; `apps/web` also needs its
own for `axios`), and build the baseline from a pristine `git archive HEAD` into a **new** directory.
A reused scratchpad produced a wrong failure count; a scratchpad synced with `git ls-files` omits
untracked files and under-reports.

## Traps that cost real time

**Two ways a test can silently never run.** Both report a smaller total and no error.

- `apps/api`'s `npm test` runs **two passes**: pass one runs everything *except* tests named
  `real PostgreSQL 16 migration`; pass two re-runs that phrase against **one named file only**. A
  test in a *new* file using that phrase is skipped by the first and never reached by the second.
- `apps/web` compiles from an **explicit include list** in `tsconfig.test.json`.

**Always confirm tests by name in TAP output.** Never infer from a total. A test that never runs is
worse than no test, because it reads as coverage.

**Do not write backslash-u escape literals into source content.** The file-writing path decodes them
into raw bytes — including U+0000 — leaving files that read as *binary* to `grep`, `file` and `sed`.
This happened three times, most recently in the script writing this very warning. Use numeric code
points or `String.fromCharCode`; in Python use a raw string. If `grep` reports "binary file matches"
on a plain `.ts` file, that is the signal, not a tool bug.

**Long shell heredocs are fragile here.** Writing this handover, two separate heredocs died with
"unexpected EOF" on content that was correctly quoted. For anything long, write the file with an
editor tool or through a scratchpad file rather than fighting the shell.

**The checkout is shared and moves under you.** Another session committed to `master` throughout
this work (all inside `mcp/`). Re-read `git status` and `git log -1` immediately before committing.

## Standing constraints

**Branch:** commit directly to `master`. No worktrees, no feature branches unless the owner asks in
the moment.

**Database — `apps/api/.env` points at a real development database with records in it:**

- **Never** run `prisma migrate reset`, `migrate dev`, `db push`, `DROP` or `TRUNCATE`.
  `migrate dev` **will** fail — pre-existing drift, no shadow database — and Prisma's only remedy is
  a destructive reset.
- **Hand-write every migration**, apply with `npm run db:migrate:deploy`. Export `DATABASE_URL` from
  `apps/api/.env` first, because `prisma.config.ts` disables Prisma's own `.env` loading.
- **Adding an enum value has two house patterns and they are not interchangeable.** If the new value
  is *used* later in the same migration, rebuild the enum. If it is only *declared*, use
  `ADD VALUE IF NOT EXISTS`. `20260710190000_add_deadline_calendar_lifecycle/migration.sql` records
  why: PostgreSQL rejects use of a new value before commit when the migration runs as one query.
- **Do not edit an applied migration** to chase a cosmetic drift line — it changes the checksum and
  leaves the file disagreeing with the live database, which is worse drift than the line it fixes.
- A new Prisma model must be added to `DISPOSABLE_DATABASE_RESET_TABLES`, which lives in
  **`e2e/helpers/database-safety.cjs` at the repository root** — not in `apps/api/e2e/helpers/db.ts`,
  which merely imports it. That guard runs in `test:production-check`, **not** the default
  `npm test`.

**Closed files — do not modify without a stated reason:** `integration-crypto.ts`,
`integration-credential.service.ts`, `atlassian-oauth.ts`, `confluence-connection.service.ts`.

**Do not weaken the `status` route's output guard** — a keys allow-list plus a substring check
forbidding `refresh`/`token`/`secret`. A task hit it and reverted rather than loosening it.

**Product constraints from the owner:**

- Portal upload must always work. No integration may become the only way to get a document in.
- **Confluence is alpha** — opt-in per charity, never a default, and **not a storage provider**; it
  is a publish target. The provider registry still lists only `supabase` and `local`. Keep it that
  way unless the owner rules otherwise.

---

# 7. Known deferred items

- **The key rotation job is unwritten.** The DPO explicitly wants key management, rotation and
  recovery for production. Before writing it, read the "rotation trap" in `docs/ARCHITECTURE.md`:
  flipping the active key generation makes every un-re-sealed credential fail as *unreadable*, which
  looks identical to mass corruption and invites an operator response that destroys the recoverable
  data.
- **`updatePage` cannot distinguish a stale version from a duplicate title.** Both arrive as 409 and
  the client deliberately surfaces no response body. The message now names both causes without
  asserting either, but a pipeline branches on a *code*. Closing it costs either a caller-side
  re-read comparing the title, or a carve-out in the containment rule that keeps raw upstream bodies
  out of logs — **do not conflate the two**; the second has a security cost.
- **Adoption keys on the page title, which is fragile by nature.** The robust answer is to
  CQL-search the content property that already carries the document id — exact, and immune to title
  handling. It needs CQL search, which Phase 3 did not build, and a real site to verify against.
- **A cron-style deployment has no publish entry point.** The in-process scheduler path is wired and
  pinned, so publication is not dead in production; only a cron deployment lacks one. Reaches
  `apps/api/package.json`, two docs and two CI workflows.
- **Invert the `confluence-attachments.ts` import of `routes/documents/`**, with a test that services
  never import from `routes/`.
- Several Minor items from Phases 2 and 5 remain parked, recorded in those phases' ledgers under
  `.superpowers/sdd/` (gitignored scratch — if missing, `git log` is complete).

---

# 8. What I would do next, in order

1. **Get the DPO connected** (`tailscale switch`) and give him least-privilege access. He has been
   blocked since 31 August and everything in his ordering sits behind his review.
2. **Clear or expire the development logs** holding the leaked OAuth codes. He asked; it is not done.
3. **Get the owner's answer on (a)/(b)**, then do the erasure rework. Small, and the machinery
   exists.
4. **Build the owner-console integration health view** (section 2b). Small; the API already returns
   it.
5. **Create the Atlassian OAuth app**, then let the DPO authorise — which may clear the 403 without
   the manual install he asked us to hold off on.
6. **Then, and only then, verify the four assumptions in section 5 against a real site.** Until that
   happens, every Confluence claim in this codebase is proven against fakes, and a fake cannot tell
   you Atlassian changed a status code.

**Do not promote Confluence out of alpha** until item 6 is done.

## The plans and where they live

- `docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md` — **the binding authority.**
  Read its Open Questions first.
- `docs/superpowers/plans/2026-09-19-confluence-publish-pipeline-phase-4.md` — the last phase built,
  and the one being reworked. Carries the real-site checklist.
- `docs/superpowers/plans/2026-09-18-provider-aware-erasure-phase-5.md` — the erasure engine.
- `docs/superpowers/plans/2026-09-19-integration-admin-ui-phase-6.md` — the integration screens.
- `docs/ARCHITECTURE.md` — the security model, the error taxonomy, the rotation trap, and what
  erasure can and cannot prove.

## What to tell the owner at the end

They are not an expert in this code and have said so. Report in plain terms: what now works that did
not, what decisions you made on their behalf and what each costs if wrong, what is still blocked on
them, and what you would do next. Do not bury a real problem in detail, and do not claim something
is verified when it is only written.
