# MCP connector — handover

Written 2026-09-19, at the end of the build. If you are picking this up in a fresh
session on this machine, read this before touching anything.

`README.md` beside this file explains what the connector is and how to run it. This
document is the other half: what state it is in, what is deliberately unfinished, and
which decisions were made unilaterally and are yours to reverse.

## Status in one paragraph

Eleven planned tasks are complete. 78 tests pass, typecheck is clean, and the package
lives at `mcp/` — deliberately OUTSIDE the npm workspace globs, so nothing about it can
reach the API's Docker build or the blue-green deploy. **It has never been run against
the real API.** Every test stubs `fetch`. A live `connect` needs the owner's CharityPilot
password, which no agent in the build was permitted to handle, so the end-to-end path is
unverified. That is the single most important thing to know.

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
and decodes once precisely so that works, but it has never been typed for real.

If `connect` fails with "Sign-in failed. Check the email address and password." on a
password you know is right, read the Origin section below before assuming anything.

## Repository state

All work is committed to `master`. At time of writing, **20 of the commits are already on
`origin/master`** (another session pushed them mid-build) and **4 are not**. The unpushed
four are the two fix waves from the final review. This matters: what is on the remote right
now is the version where `connect` cannot succeed and `board_register` returns `{}`. Pushing
was left to the owner and had not happened when this was written — check `git log
origin/master..HEAD -- mcp/` before assuming either way.

Several agents were committing to this same working tree during the build. If you find
unexpected modified files, check whether another session is mid-flight before reverting.

## What is deliberately not built

- **No `governance_registers` tool.** That route returns a mixed payload of several
  register types, and the per-model field filter cannot classify a mixed object. As a
  result **members, conflicts and complaints are unreachable by any tool today** — the gate
  covers them as defence-in-depth for when a tool is added. Adding one means first designing
  a filter that can dispatch per record type. The README says this plainly; keep it honest.
- **No pagination.** Tools take no input, so `board_register` is fixed at page 1, pageSize
  50. `hasMore` reaches the model but there is no way to fetch page 2.
- **No writes, no document downloads, no response caching, no generic "call any endpoint"
  tool.** Each was excluded on purpose; see the spec's "Deliberately excluded".

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

### 2. The spec claims a test that does not exist

`docs/superpowers/specs/2026-09-19-charitypilot-mcp-connector-design.md`, Tenant isolation →
Tests, promises an assertion that a response for organisation B is rejected when the session
belongs to A. There is no such test and no such check. It was deferred during planning
because no response carries an `organisationId` to compare against, and the spec was never
corrected to match. Either implement it or correct the spec — do not leave it claiming
protection that is not there.

### 3. A record carrying a `data` field is misread as an envelope

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
