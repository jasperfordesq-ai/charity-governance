# MCP connector, Phase C: the surface the web application has and the connector does not

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Everything a person can do on the Team, Billing, Export and Deadlines pages that does not involve a browser redirect or a payment can be done from the connector, and a person without a terminal can approve a removal.

**Architecture:** Almost all of it is connector-side: the routes already exist and the API already gates every destructive team route behind `requireSessionLevel('ADMIN')` and `requireActionApproval()`. Three of the four new reads return hand-built projections rather than model rows, so they take shape filters and the gated-model list is untouched. The one real API addition is a route listing the caller's own pending approvals, which the web page needs.

**Tech Stack:** TypeScript, the connector's hand-written validators, `node:test` from `dist/`, Fastify 5, Next.js 15 with HeroUI, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-20-charitypilot-mcp-connector-audit-and-improvement-plan.md`, Part 1.3 and Part 2 Phase C.

**Plan depth:** shorter than the Phase A/B plan on purpose. That one was written to hand to a fresh implementer; this one is executed by its author in the same session, so it records task boundaries, decisions and the tests that must exist, not every keystroke. The global constraints below still bind.

## Global Constraints

- `mcp/` stays outside the npm workspace: `cd mcp && npm install`, never `--prefix mcp` from the root.
- No new runtime dependency in `mcp/`.
- `exactOptionalPropertyTypes`: an optional property is `field?: T | undefined`.
- Tests are `node:test` + `node:assert/strict`, run from `dist/`. No Vitest.
- Every new guard gets a mutation canary on a scratchpad copy, with the canary form stated.
- Sources are CRLF; canary anchors use `\r?\n`.
- Work on `master`, stage named paths, never `git add -A`. The checkout is shared: re-read `git status` before every commit.
- **Another session owns the Confluence integration.** Do not touch `routes/integrations/`, `document.service.ts`, `confluence-*.ts` or `compose.production.yml`.
- A credential must never reach the model: an invite link is a credential.

## Decisions taken here

These are Part 3 questions the owner has not answered; the goal instruction was to work through every phase, and the full-access spec delegates design authority. Each is reversible and recorded.

| # | Decision | Why |
|---|---|---|
| 1 | **Team management: yes, at ADMIN level.** | The API already requires an administrator-level session and a per-action approval for every destructive one. Excluding them protected nothing the API was not already protecting, and left the owner unable to suspend a compromised account from the tool they were already using. |
| 2 | **Ownership transfer stays excluded.** | It signs the caller out as it happens and needs a typed confirmation string. Not a thing to do through an intermediary. |
| 3 | **Invite creation is offered; the link is never returned.** | On a deployment that emails invites the API returns a message only. On a manual-link deployment it returns `manualInviteUrl`, which is a credential to join the charity: the connector drops it and says to reissue from the Team page. Reissue itself stays excluded. |
| 4 | **Billing status: yes, read only.** | Plan, status and dates, no personal data. Checkout and portal stay out: they end in somebody entering card details. |
| 5 | **Confluence setup stays deferred.** | The DPO asked to agree the publishing model before more of it is built, and another session is actively rebuilding that integration. Choosing a publish space is part of the model being agreed. |
| 6 | **Approval from the web application: yes.** | A trustee with Claude Desktop and no terminal cannot approve anything today. The same row, the same digest, the same single use; only the terminal is replaced, by a dedicated page that re-asks for the password. |

---

## Task C1: the four reads the web application has

**Files:** `mcp/src/field-policy.ts` (three shapes), `mcp/src/tools.ts`, `mcp/src/route-coverage.ts`, tests in `mcp/src/tests/field-policy.test.ts` and `mcp/src/tests/tools.test.ts`.

Tools: `billing_status` (no records), `team_sessions_list` (shape `teamSessions`), `security_audit` (shape `securityAudit`), `deadlines_reminder_history` (shape `reminderHistory`). Each leaves `route-coverage.ts`.

What each shape withholds while the gate is closed:

| Shape | Kept | Withheld |
|---|---|---|
| `teamSessions` | familyId, displaySuffix, the four timestamps, clientKind, accessLevel, active, current | `deviceLabel` (a colleague's own device name), `revocationReason` (free text) |
| `securityAudit` | type, occurredAt | `actorLabel`, `subjectLabel`, `reason` — all free text naming people |
| `reminderHistory` | everything about the deadline, the status, the timings | `email` (the recipient), `error` (provider text that can embed the address) |

- [ ] Failing tests first: each shape drops its withheld keys and keeps its kept keys; each passes the value through untouched when the gate is open; a payload that is not the expected shape is returned unchanged rather than throwing.
- [ ] Implement, run, canary one shape (branch body), commit.

## Task C2: the team write tools

**Files:** `mcp/src/tool-body.ts` (a `min` on string fields), `mcp/src/write-tools.ts`, `mcp/src/mutating-route-coverage.ts`, `mcp/src/tests/write-tools.test.ts`.

Eight tools, all `level: 'admin'` except `team_invite_create` and `team_member_reactivate`, which are `write`:

| Tool | Route | Body |
|---|---|---|
| `team_invite_create` | POST /team/invites | email, role |
| `team_invite_revoke` | DELETE /team/invites/:id | reason |
| `team_role_set` | PATCH /team/members/:id/role | role, expectedMembershipVersion, reason |
| `team_member_suspend` | POST /team/members/:id/suspend | expectedMembershipVersion, reason |
| `team_member_reactivate` | POST /team/members/:id/reactivate | expectedMembershipVersion, reason |
| `team_member_remove` | POST /team/members/:id/remove | expectedMembershipVersion, reason |
| `team_session_revoke` | POST /team/members/:id/sessions/:familyId/revoke | expectedMembershipVersion, reason |
| `team_sessions_revoke_all` | POST /team/members/:id/sessions/revoke-all | expectedMembershipVersion, reason |

Three things these need that no existing tool does:

1. **`reason` in the body, ten characters minimum.** `teamGovernanceReasonSchema` demands 10 to 500. The connector's string field has a `max` but no `min`, so a short reason would be refused by the API with a validation error the agent could have avoided. Add `min` to the string spec and the generated schema.
2. **`expectedMembershipVersion`**, a control integer, read from `team_list`.
3. **A second path parameter** on the session revoke (`:id` and `:familyId`). The path builder already supports several.

`reason` is already peeled off as the activity-log header and copied back into the body for the one tool that declares it (`governing_act_void`); these follow that path.

- [ ] Failing tests: every new tool names a real mutating route with that method; a nine-character reason is refused by the connector before anything is sent; `expectedMembershipVersion` is a control field, so it does not count as personal data; the advertised schema requires what the API requires.
- [ ] Implement, run, canary the `min` check, commit.

## Task C3: the export and the text upload

**Files:** `mcp/src/file-tools.ts`, `mcp/src/files.ts`, `mcp/src/route-coverage.ts`, `mcp/src/tests/files.test.ts`.

- `report_export` (file tool, needs `--download-dir`): GET `/api/v1/export/compliance-report?year=`, HTML, written to the directory and the path returned. Never the bytes: it is the widest payload in the API, the whole profile and every register.
- `document_upload_text` (ordinary write tool, `level: 'write'`): content in the argument, `text/plain` or `text/csv` only, 64 KB ceiling, so a client with no file system can still file a note. Same activity row as any upload, and the same category argument.

- [ ] Failing tests: the export refuses without a directory and never returns bytes; the text upload refuses an unsupported type, refuses over 64 KB, and sends multipart with the right filename extension.
- [ ] Implement, run, commit.

## Task C4: approving from the web application

**Files:** `apps/api/src/routes/auth/connector.ts` (a list route), `apps/web/src/app/(dashboard)/approvals/page.tsx` and its client, `apps/web/tsconfig.test.json` if a test file is added, `e2e/tests/` for the Playwright pass.

- `GET /api/v1/auth/connector/approvals` lists the caller's own pending approvals. It is read under `authGuard` and, unlike the single-approval read, is reachable from a browser, because that is the point. It returns only rows belonging to the caller, unapproved, unconsumed and unexpired.
- The page lists them, shows each summary, and grants one after the person re-enters their password. Granting posts to the existing `/auth/connector/approve`, which currently sits behind the non-browser guard.

**The obstacle, and the decision.** `/auth/connector/approve` refuses any request carrying browser evidence, by design. A page cannot call it. Rather than weaken that guard, the page posts to a **new** `POST /api/v1/auth/approvals/:id/grant` in the browser realm: same conditional update, same password check, same opaque refusal, but under the ordinary origin protection instead of the non-browser guard. The two routes share one service function so the rule cannot drift. Weakening `assertNonBrowserClient` for one route would undo the property that lets the connector routes return tokens in the body.

- [ ] Failing tests: the list returns only the caller's pending rows; a granted or expired row is absent; the browser grant route refuses a wrong password identically to the connector one; the connector route still refuses a browser.
- [ ] Implement, run the API suite, canary the ownership filter, commit.
- [ ] A Playwright test: sign in, provoke an approval, grant it on the page, see it disappear.

## Verification

- `cd mcp && npm test`, `cd apps/api && npm test`, `npm run typecheck --prefix e2e`, `npm run test:e2e:mcp`.
- The live suite's hardcoded tool list grows by eleven names; adding each is the moment to ask whether it should exist.
- A live assertion per new gated tool, in both gate states.
