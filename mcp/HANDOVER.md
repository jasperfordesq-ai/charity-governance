# MCP connector — handover

Written 2026-09-19, at the end of the build. If you are picking this up in a fresh
session on this machine, read this before touching anything.

`README.md` beside this file explains what the connector is and how to run it. This
document is the other half: what state it is in, what is deliberately unfinished, and
which decisions were made unilaterally and are yours to reverse.

## Status in one paragraph

**Updated 2026-09-20, after Phases A to H of the audit.** The connector is no
longer read-only. It reads the whole API through 31 tools, changes records
through 42 more, moves documents and reports through 4 file tools, answers
`session_info` always, and offers 5 prompts for the jobs that take more than one
tool. The unit suite is 310, the API suite is 1843, and the web suite is 498.
Typecheck is clean, and the package still lives OUTSIDE the npm workspace globs,
so nothing about it can reach the API's Docker build or the blue-green deploy.

**What the 2026-09-20 audit added, by phase**
(spec `docs/superpowers/specs/2026-09-20-charitypilot-mcp-connector-audit-and-improvement-plan.md`):

- **A — the defects.** `approve` shows what is being approved before asking for
  a password, and the API's summary names the record. Refusals carry the API's
  code, the fields that were wrong and what to do next. `status` reports the
  level the API holds. Downloads survive an expired token.
- **B — legibility.** Server instructions, tool annotations, structured results
  and errors, `session_info`, tool groups (`--toolsets`), `--verbose`. Tool
  descriptions stopped repeating what the instructions say.
- **C — the surface.** Team management at the level the API already required,
  the sessions list, the security audit, reminder history, billing status, the
  compliance report export, a text upload for clients with no file system, and
  an approvals page in the web application so a person with no terminal can
  grant one.
- **D — the personal-data gate is session posture.** `AuthSession.dataScope`,
  immutable and pinned per family. `connect --data-scope full` asks for it, the
  API refuses it below owner or administrator, and editing an AI client's
  configuration file no longer decides what a model may see.
- **E — reach.** One credential per host, and a validated `.mcpb` bundle
  manifest so Claude Desktop can install it in one step.
- **F — workflows.** Prompts, and a `fields` argument to keep a long list short.
  **Search was not built**; see below.
- **G — remote transport.** Designed only, in
  `docs/superpowers/specs/2026-09-20-charitypilot-mcp-remote-transport-design.md`.
  Blocked on the hosting move and on the DPO seeing it.
- **H — API hardening.** Five update routes can now refuse a stale write; the
  connector requires the stamp on all five.

**Still not built, deliberately:** search (an API route plus tools; the design
in the audit is to match only fields the gate would release anyway, so it needs
no scope interaction), MCP resources, idempotency keys on creates, a read budget
for connector sessions, and `GET` routes for one governing act and one board
member. None is blocking; each is listed in the audit.

Everything that limits it lives in the API, not here:

- Sessions carry a posture. `clientKind` says whether a session belongs to a
  browser or the connector; `accessLevel` says how much it may do. Both are
  chosen once, by whoever typed the password, and are pinned per session family
  by database triggers so a rotation cannot silently widen a session.
- The connector signs in through `/api/v1/auth/connector/*`, which return tokens
  in the body, set no cookie, and refuse anything carrying evidence of a browser.
- Every unsafe request from a connector session leaves an append-only
  `ClientActivityEvent` row, refused attempts included.
- Seventeen destructive routes need an administrator-level session AND a
  single-use approval bound to a digest of the exact request, granted by a person
  typing their password at a terminal.
- Connector sessions have their own budget of thirty changes a minute.

**The live suite is the evidence.** `npm run test:e2e:mcp` drives the built
connector over stdio against a disposable stack: sign-in, rotation, revocation,
the personal-data gate open and closed, tenant isolation both ways, every role,
read-only refusal, the write path, the 428 approval flow end to end including a
wrong password approving nothing, and a document round trip that compares bytes.
Eight canaries in `scripts/mcp-live-canary.mjs` have each been run and each turns
the suite red.

**The VM still runs a build that predates all of this.** The connector auth routes
do not exist there, so `connect` against it will report that the API is older than
the connector and name the host. Deploying is the owner's decision, not an
engineering one; see the deploy procedure note in memory. Until then, everything
above is proved against the disposable stack and the API suite, not against the VM.

**The VM was verified on the read-only build, 2026-09-19.** The owner connected
over Tailscale and the connector answered as the owner of hOUR Timebank CLG: 23 of
24 argument-free tools returned real data, pagination reached the API, an
undeclared argument was refused by name, and nothing withheld reached the model.
The one failure was `confluence_status`, a 404 because the deployed build predates
the integrations routes. The OS keychain path and the raw-mode password prompt are
therefore both exercised for real.
## The first thing to do

Run it. In order, on a machine with Tailscale connected:

```bash
cd mcp && npm install && npm run build && cd ..
node mcp/dist/cli.js connect     # needs the owner's password
node mcp/dist/cli.js status      # must name the right account AND organisation
```

Then from an AI client, call `compliance_summary` and `board_register`. `board_register`
must return names and roles and **no** `dateOfBirth` or `residentialAddress`. Also try a
password containing an accented character (e.g. `Siobhán`) — the prompt accumulates bytes
and decodes once precisely so that works. The live harness now proves the decoding against
a real sign-in, but only through a pipe; it has still never been typed at a terminal, which
is the path that uses raw mode.

If `connect` fails with "Sign-in failed. Check the email address and password." on a
password you know is right, read the Origin section below before assuming anything.

## Approving at a real terminal (owner checklist, unverified)

`approve` refuses unless standard input is a terminal, and the password prompt uses raw
mode. Neither has been exercised by a person at a keyboard. Run this once on each terminal
you use, against the local stack, and record the result here:

1. Ask the connector to delete a risk it created; copy the `approve` command it prints.
2. Run it. It must print the summary naming the risk BEFORE asking for the password.
3. Type a password containing an accented character and press Enter. It must be accepted.
4. Run it again with the same identifier. It must say the approval is already approved.

| Terminal | Date | Result |
| --- | --- | --- |
| Windows Terminal (PowerShell) | | |
| PowerShell in VS Code | | |
| Git Bash (mintty) | | |
| macOS Terminal | | |

If mintty fails step 2 with "must be run at a terminal", Node is not seeing a TTY there.
Document Windows Terminal as the supported terminal rather than weakening the check.

## Repository state

All work is committed to `master`. The build's own commits, including the two final fix
waves, were pushed by the owner on 2026-09-19; the live-harness commits that followed may
not be. Check `git log origin/master..HEAD` before assuming either way.

Several agents were committing to this same working tree during the build. If you find
unexpected modified files, check whether another session is mid-flight before reverting.

## What is deliberately not built

- **No response caching and no generic "call any endpoint" tool.** Both stay excluded.
  A generic tool would void every guarantee the declared surface provides, and a cache
  would mean the connector holding charity data on disk, which it deliberately does not.
- **No tools for team membership, ownership transfer, organisation settings or the
  Confluence integration.** All are reachable in the web application. Confluence
  disconnection will not be exposed at all, per the owner's standing ruling.
- Nineteen readable routes are deliberately not exposed, each with its reason in
  `mcp/src/route-coverage.ts`. A test requires every readable route to be either a tool
  or an entry there, so the list cannot quietly fall behind the API.

## Session posture (added 2026-09-19, phase 2a)

Every `AuthSession` row now carries two columns. `clientKind` is `WEB` or
`MCP_CONNECTOR`; `accessLevel` is `READ`, `WRITE` or `ADMIN`. Both default to a
full-authority web session, which is what every session was before, so nothing
about the web application changed.

Three things are worth knowing before touching them:

- **They are immutable.** The update guard refuses any change, so a live
  session can never be promoted. A session is narrowed at sign-in or not at all.
- **They are pinned per session family by the database.** Rotation mints a new
  row on every refresh; if it fails to copy the posture, the insert raises
  23514 and the refresh fails. That guard exists because rotation was already
  losing `deviceLabel` the same way, silently, since the column was added — and
  a lost posture would not blank a label, it would restore full authority.
  Rotation now copies the device label too.
- **A refresh token cannot cross channels.** `rotateSessionTokens` takes an
  optional expected client kind and refuses a mismatch with the same opaque
  error an unknown token gets.

`authGuard` reads the posture per request and refuses every unsafe method on a
`READ` session with 403 `SESSION_READ_ONLY`. `requireSessionLevel` exists for
the destructive routes but is not yet applied to any of them.

**Nothing creates a non-default posture yet.** There is no route that accepts
one, and the connector still signs in through the browser path. That arrives
with the connector auth routes in phase 2b. Until then these columns are inert
for every real user, which is why they were landed on their own.

A replayed refresh token now also writes a `SESSION_REPLAY_DETECTED` audit row
in the same transaction as the quarantine. It used to be silent.

## What the next session should pick up

In order:

1. **Decide whether to deploy the API to the VM.** Everything from session posture
   onwards exists only in the repository and on the disposable test stack. Until the
   VM is deployed, the connector cannot sign in against it at all. This is the owner's
   call: it carries seven migrations from this work, all additive and all past the
   blue-green gate, plus whatever other sessions have left unapplied (the invite-link
   reissue fix, at least). The deploy reports the pending set before applying it;
   read that list rather than trusting this one.
2. **Reconnect and verify against the VM afterwards.** `connect --access-level write`,
   confirm `status` reports the level, then confirm a read-level session is refused a
   change, and that the refusal comes from the API rather than from the connector.
3. **Distribute to trustees at read level**, if the owner wants that. Nothing further
   is needed in the code; it is a matter of giving people the install steps and
   `--access-level read`.

## Open problems, in priority order

### 0. `document_delete` still deletes from Confluence on the API side

The owner ruled to the DPO on 2026-09-19 that an ordinary deletion removes CharityPilot's
record and reference only, and that destroying the Confluence source needs an explicit
erasure workflow. The API has not been changed: `DocumentService.enqueueConfluenceErasure`
still enqueues a `confluence` erasure row from the ordinary delete path. Until it is,
approving `document_delete` for a document that has been published deletes and purges the
Confluence page. The connector cannot refuse the call selectively because the document
metadata carries no publication field. The tool's description no longer claims the
behaviour; the API change is owed and is the fix.

### 1. Split-host deployments cannot authenticate — RESOLVED 2026-09-19

The connector no longer sends an `Origin` at all: its auth routes refuse any request
carrying one, so there is nothing to allow-list and the hosting move is not blocked by
this. What follows is kept because it explains why those routes are shaped that way.

#### The problem as it stood

`apps/api` builds its allowed origins solely from `FRONTEND_URL`, and rejects a request
whose `Origin` is present but unlisted. The connector derives its `Origin` from its own
`baseUrl`.

On the Hyper-V VM that is fine — `FRONTEND_URL`, `NEXT_PUBLIC_API_URL` and the connector's
`DEFAULT_BASE_URL` are all the same Tailscale hostname, so it is accepted. On a split-host
deployment (`app.charitypilot.ie` vs `api.charitypilot.ie`) the connector would send
`Origin: https://api...` and get a 403.

**This must be settled before the connector is pointed anywhere but the VM** — i.e. before
the hosting move that is step 4 of the DPO's agreed order. It needs an allowed-origin
decision on the API side, which is an owner/DPO call.

### 2. The spec claimed a test that did not exist — now resolved

`docs/superpowers/specs/2026-09-19-charitypilot-mcp-connector-design.md`, Tenant isolation →
Tests, promised an assertion about a response belonging to another organisation. No such
test existed, because no response carries an `organisationId` to compare against.

It is now covered for real rather than by stub. The live harness seeds two charities and
asserts the boundary in both directions: the first charity's session never returns the
second's trustee, and the second charity's own session does return it. The second half is
what makes the first meaningful, since an absence proves nothing if the record was never
reachable. The spec has been corrected to describe this.

### 3. Five tools once shipped with no gate at all (found and fixed)

Worth knowing because the mistake is easy to repeat. A tool that named no model was
passed through untouched, and five did: the dashboard, the compliance records, the
document list and both deadline tools. Between them they returned whole deadline rows,
document owners, the staff member who last edited each compliance record, and activity
lines built by interpolating trustee and staff names into a sentence.

The last of those is the instructive part. Free text assembled by interpolation cannot
be protected by a field allowlist, because there is no field to withhold — the name is
inside the string. The dashboard shape therefore drops the whole description rather
than trying to filter it.

Two tests now hold the line: every tool must declare a model, a shape, or a sentence
saying why it carries no records; and the live suite iterates the advertised tool list
rather than a list written by hand, so a tool added later is covered without anyone
remembering. `scripts/mcp-live-canary.mjs dashboard-passthrough` reproduces the
original bug on demand.

### 4. A record carrying a `data` field is misread as an envelope

`applyFieldPolicy` detects the API's pagination envelope by looking for a `data` key. A
top-level record that happened to have its own `data` column would be misread and returned
as `{"data": ...}` rather than the filtered record. It fails **closed**, so it is a
correctness wart rather than a leak, and no gated model has such a column. Worth tidying if
you touch that file.

## The personal-data gate — and the two calls you may want to reverse

Five models are gated: `BoardMember`, `Member`, `ConflictRecord`, `ComplaintRecord`,
`GoverningAct`. It is an **allowlist** — unknown fields are dropped, so a column added next
year is withheld by default rather than leaked by default. `mcp/src/tests/schema-drift.test.ts`
fails the build if any field on those five is classified neither safe nor withheld, and a
second test fails if a model is dropped from the policy entirely.

Two classifications were decided during the build and are the most likely things you will
want to revisit:

- **`ConflictRecord.boardMemberId` is withheld.** Withholding `trusteeName` alone achieved
  nothing, because `boardMemberId` is a foreign key into `BoardMember`, whose `id` and `name`
  are both safe — one join reconstructs who declared a conflict. The accepted cost: with the
  gate closed you cannot ask how many conflicts a *particular* trustee declared, only how
  many exist and their status, dates and minute references.
- **`Member.name` is withheld** while `BoardMember.name` is not. Irish charity trustees are
  on the public Charities Regulator and CRO registers; ordinary members are on no register,
  so the public-record justification does not carry.

Both were reviewed adversarially at the end and judged correct, not overreach. Each is one
line to reverse in `mcp/src/field-policy.ts` if you disagree — but reverse the reasoning
too, in the spec, so the next person knows why.

`GoverningAct.title` is classified safe and is free text, so a minute titled
"Removal of Jane Doe as trustee" passes the closed gate. That is deliberate but worth
knowing.

## Traps that cost real time during this build

- **Never run `npm install --prefix mcp` from the repo root.** npm reads it as "install the
  current directory's package (`charitypilot`) into the `mcp` prefix" and injects
  `"charitypilot": "file:.."` into `mcp/package.json` plus a parent link into its lockfile —
  exactly the workspace coupling this package's location exists to prevent. Use
  `cd mcp && npm install`. `npm ci --prefix mcp` is safe (it takes no package argument),
  which is why CI uses it and why this stayed hidden for two fix rounds.
- **A green suite proves nothing without a canary.** Three tests in this build passed
  whether or not the code was correct: one registered a secret below the length floor, one
  registered secrets in the order that could not trigger the bug, and the schema-drift
  parser filtered out every capitalised type — which is every Prisma scalar — so it audited
  an empty list and passed unconditionally. Mutate the code and confirm the test fails
  before believing it.
- **The drift guard used to audit a list it took from the artifact it audits.** Removing a
  model from the policy self-consistently left every test green. It is hardcoded now
  (`MUST_BE_GATED`); keep it that way.
- **Tests stubbing the wrong response shape hide real bugs.** `board_register` returning
  `{}` survived every per-task review because the stubs returned a bare array, a shape the
  API never produces. When you stub, copy the real envelope.

## Where the evidence is

`.superpowers/sdd/2026-09-19-charitypilot-mcp-connector/` (gitignored, kept deliberately)
holds the per-task briefs, implementer reports, review packages and `progress.md` — a ledger
of all 34 decisions made during the build with the reasoning and the stated cost if each is
wrong. `task-11-report.md` has the owner-verification checklist. If that directory is gone,
this document and the git log are what remain.

Design and plans, all committed:
- `docs/superpowers/specs/2026-09-19-charitypilot-mcp-connector-design.md` — the
  original read-only design. Its exclusions of writes and downloads are superseded.
- `docs/superpowers/specs/2026-09-19-charitypilot-mcp-full-access-design.md` — the
  design this connector actually follows, phase by phase, with what each phase found.
- `docs/superpowers/plans/2026-09-19-charitypilot-mcp-connector.md` (read-only build)
- `docs/superpowers/plans/2026-09-19-charitypilot-mcp-live-harness.md` (phase 0)
- `docs/superpowers/plans/2026-09-19-charitypilot-mcp-read-everything.md` (phase 1)
- `docs/superpowers/plans/2026-09-19-charitypilot-mcp-session-posture.md` (phase 2a)
- `docs/superpowers/plans/2026-09-19-charitypilot-mcp-connector-auth.md` (phase 2b)
- `docs/superpowers/plans/2026-09-19-charitypilot-mcp-connector-accountability.md` (2c)
- `docs/superpowers/plans/2026-09-19-charitypilot-mcp-writes-and-approval.md` (phase 3)

The canaries are the other half of the evidence, and there are now two sets.

`scripts/mcp-live-canary.mjs` breaks a property and requires the live suite,
against a real stack in Docker, to notice. It covers the personal-data gate
in both its forms, the dashboard shape, the browser-evidence guard, the
read-only gate, the activity log, approval reuse, approval being needed at
all, upload containment, the approval summary naming its record, delete
annotations, the scope a session asks for, and the role floor on that scope.
It takes minutes per mutation.

`scripts/api-guard-canary.mjs` does the same for guards a unit test covers,
in seconds rather than minutes, so a guard can be checked as it is written.
It covers the two tenant filters on the by-identifier reads, the stale-write
refusal, the null that clears a date, the refusal of an edit that changes
nothing, the administrator check on a document edit, the three parts of the
read budget, the four parts of idempotency on the API side and the four on
the connector side, the build identifier and its comparison, and the three
search guards plus the two on following a reference. Run it with no argument
for all of them, or with one name.

A canary whose mutation does not compile reports zero failures and looks like
a pass. Both scripts judge the build separately and say so; if one reports
`CANARY BROKEN` while somebody else is mid-edit in the same checkout, that is
their build failing, not your guard.
