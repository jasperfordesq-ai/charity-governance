# MCP connector — handover

Written 2026-09-19, at the end of the build. If you are picking this up in a fresh
session on this machine, read this before touching anything.

`README.md` beside this file explains what the connector is and how to run it. This
document is the other half: what state it is in, what is deliberately unfinished, and
which decisions were made unilaterally and are yours to reverse.

## Status in one paragraph

The connector reads the whole API. Twenty-seven tools cover every readable route; the
unit suite is 127 tests (126 passing, one skipped because it asserts a POSIX file mode)
and the live suite is 26. Typecheck is clean and the package
lives at `mcp/` — deliberately OUTSIDE the npm workspace globs, so nothing about it can
reach the API's Docker build or the blue-green deploy.

**It now runs against a real API, but not yet against the VM.** As of 2026-09-19 a live
harness drives the built connector over stdio against the runner-owned disposable stack:
`npm run test:e2e:mcp`, source in `e2e/tests/mcp/connector-live.spec.ts`. Eighteen
assertions cover sign-in, refresh rotation, server-side revocation on disconnect, the
personal-data gate open and closed, tenant isolation in both directions, and the three
roles. Two canaries in `scripts/mcp-live-canary.mjs` have been run and confirmed the
suite goes red when the gate is broken.

What remains unverified is the VM itself: nobody has yet run `connect` against
`charitypilot.tailae0b07.ts.net` with the owner's own password over Tailscale, so the
keychain path and the tailnet path are still unproven. The checklist for that is below.

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

## Repository state

All work is committed to `master`. The build's own commits, including the two final fix
waves, were pushed by the owner on 2026-09-19; the live-harness commits that followed may
not be. Check `git log origin/master..HEAD` before assuming either way.

Several agents were committing to this same working tree during the build. If you find
unexpected modified files, check whether another session is mid-flight before reverting.

## What is deliberately not built

- **No write tools, no document downloads, no response caching, no generic "call any
  endpoint" tool.** Each was excluded on purpose. Writes and downloads are planned for
  later phases; the other two stay excluded.
- Nineteen readable routes are deliberately not exposed, each with its reason in
  `mcp/src/route-coverage.ts`. A test requires every readable route to be either a tool
  or an entry there, so the list cannot quietly fall behind the API.

## Open problems, in priority order

### 1. Split-host deployments cannot authenticate (unfixed, needs a decision)

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

Design and plan, both committed:
- `docs/superpowers/specs/2026-09-19-charitypilot-mcp-connector-design.md`
- `docs/superpowers/plans/2026-09-19-charitypilot-mcp-connector.md`
