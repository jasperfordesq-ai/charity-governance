# Phase 3: writes, and approval for the ones that cannot be undone

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The connector can change records, and the destructive changes need the owner's password typed in their own terminal, per action, bound to the exact request.

**Architecture:** The API keeps a short-lived approval row carrying a digest of the request it approves. A connector session hitting an administrator-gated route without one gets 428 and a summary. The human runs `charitypilot-mcp approve <id>`, types their password in a terminal the agent cannot read, and the approval is consumed by the one request whose digest matches. The connector gains typed write tools for the non-destructive changes, filtered by the level the session actually holds.

**Tech Stack:** Fastify 5, Prisma 6.19.3, PostgreSQL 16, Node 22 test runner (from `dist/`), Playwright for the live suite.

**Spec:** `docs/superpowers/specs/2026-09-19-charitypilot-mcp-full-access-design.md`

## Global Constraints

- Migrations are hand-written, additive, and must pass `scripts/bluegreen/migration-gate.mjs`. No blocked alterations.
- A new table goes in `DISPOSABLE_DATABASE_RESET_TABLES` in `e2e/helpers/database-safety.cjs`.
- Never run `prisma migrate reset`, `migrate dev`, or `db push`.
- Never enter the owner's password on their behalf. `approve` prompts a human at a terminal, and refuses when standard input is not one.
- Every new test gets a mutation canary, and a canary whose mutation fails to compile is a broken canary, not a pass: check the build produced test output before reading the count.
- The shared response types in `packages/shared/src/types/api.ts` are hand-written and are not inferred from the schemas.
- Work on `master`, commit with explicit pathspecs.

## Why per-action approval and not a time window

The owner first chose a ten-minute elevation window and changed their mind once the objection was put: a window elevates the agent, not the person. For those ten minutes every instruction the agent has been given, including any it read from a document or a web page, carries administrator authority. An approval bound to one request digest cannot be spent on a different action, however the agent is persuaded in between.

---

### Task 1: The approval record

**Files:**
- Create: `apps/api/prisma/migrations/20260920000000_add_auth_action_approval/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`, `e2e/helpers/database-safety.cjs`
- Test: `apps/api/src/tests/auth-action-approval-schema.test.ts`

Columns: `id`, `organisationId`, `userId`, `sessionId`, `requestDigest`, `summary`, `method`, `routePattern`, `createdAt`, `expiresAt`, `approvedAt`, `consumedAt`.

- [ ] **Step 1: Write the failing test.** The digest is unique per unconsumed approval. The table is in the reset list. Nothing in the migration is gate-blocked.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Write the migration** and mirror it in the schema.
- [ ] **Step 4: Run the gate and the API suite.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 2: The digest, and what it covers

**Files:**
- Create: `apps/api/src/utils/action-digest.ts`
- Test: `apps/api/src/tests/action-digest.test.ts`

The digest binds an approval to one action. It covers the session, the method, the path and a canonical form of the body, so that approving a change to one record cannot be spent on another.

- [ ] **Step 1: Write the failing tests.** Key order in the body does not change the digest; a changed value does; a changed path does; a changed session does. An absent body and an empty body agree.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** canonical JSON plus SHA-256.
- [ ] **Step 4: Run the API suite, and canary the ordering case.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 3: The 428 flow

**Files:**
- Create: `apps/api/src/middleware/action-approval.ts`
- Modify: `apps/api/src/middleware/session-level.ts` or the destructive route list
- Test: `apps/api/src/tests/action-approval.test.ts`

- [ ] **Step 1: Write the failing tests.** A connector session at administrator level with no approval header gets 428 carrying an approval id, a human-readable summary and an expiry. With a matching, approved, unconsumed approval it proceeds. An approval is single-use. An approval whose digest does not match the request is refused. An expired approval is refused. An approval belonging to another session is refused. A web session never sees any of this.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Five-minute expiry. The summary is built from the method and route, never from anything the client sent.
- [ ] **Step 4: Run the API suite** and canary the single-use and digest-match cases.
- [ ] **Step 5: Commit** (pathspec).

---

### Task 4: Approving it, with a password, in a terminal

**Files:**
- Modify: `apps/api/src/routes/auth/connector.ts`
- Test: `apps/api/src/tests/auth-connector-routes.test.ts`

`POST /auth/connector/approve {approvalId, password}` under the non-browser guard, rate-limited per email address.

- [ ] **Step 1: Write the failing tests.** A wrong password does not approve and does not say whether the identifier existed. An approval belonging to another user is refused identically. Approving twice is refused. The response carries no token.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the API suite.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 5: The connector can write

**Files:**
- Modify: `mcp/src/client.ts`, `mcp/src/tools.ts`, `mcp/src/tool-input.ts`
- Test: `mcp/src/tests/*`

Typed write tools for the non-destructive changes: compliance record and sign-off, board member create and update, deadline create and update, the four registers, annual report, financial controls, governing act create and update.

- [ ] **Step 1: Write the failing tests.** Every write tool names a real mutating route. A body field the tool does not declare is refused rather than forwarded. The reason header is sent.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** the client verbs and the tool definitions.
- [ ] **Step 4: Run the connector suite and canary the input allowlist.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 6: Tools are offered according to the level actually held

**Files:**
- Modify: `mcp/src/tools.ts`, `mcp/src/server.ts`, `mcp/src/session.ts`

- [ ] **Step 1: Write the failing tests.** The advertised list at read level contains no write tool. Calling a tool that was not advertised is refused at call time as well, because a client may call a tool it was never shown. The level is read from the API rather than from the flag the connector was started with.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** using `GET /auth/connector/session`.
- [ ] **Step 4: Run the connector suite and canary the call-time re-check.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 7: `charitypilot-mcp approve <id>`

**Files:**
- Modify: `mcp/src/cli.ts`, `mcp/src/config.ts`

- [ ] **Step 1: Write the failing tests.** `approve` refuses when standard input is not a terminal, so an agent cannot drive it. It prints the server's summary before prompting. It never echoes the password and never logs it.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the connector suite.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 8: Prove the whole flow live

**Files:**
- Modify: `e2e/tests/mcp/connector-live.spec.ts`, `scripts/mcp-live-canary.mjs`

- [ ] **Step 1: Add assertions.** A write tool changes a record and leaves an activity row. A destructive route returns 428 with a summary. Approving it with the password lets exactly that request through, and a second attempt with the same approval is refused. An approval cannot be spent on a different record.
- [ ] **Step 2: Run the live suite.**
- [ ] **Step 3: Add a canary** that makes an approval reusable, and confirm the suite goes red.
- [ ] **Step 4: Commit** (pathspec).

## What Phase 3 does not do

No uploads or downloads; those are Phase 4. No Confluence disconnection, ever. No generic call-any-endpoint tool, which would void every guarantee above.
