# Phase 2c: accountability before authority

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before the connector can write anything, the API must record what a non-browser client did, refuse the destructive routes to anything below administrator level, and stop an agent loop from locking the owner out of their own web session.

**Architecture:** One append-only table and one `onResponse` hook record every unsafe request made by a connector session. A level guard is applied to the destructive route list. A per-session limiter gives connector sessions their own write budget instead of sharing the owner's address bucket. The Team page shows which sessions are connectors so the owner can see and revoke them.

**Tech Stack:** Fastify 5, Prisma 6.19.3, PostgreSQL 16, Node 22 test runner (from `dist/`), Playwright for the live suite.

**Spec:** `docs/superpowers/specs/2026-09-19-charitypilot-mcp-full-access-design.md`

## Global Constraints

- Migrations are hand-written, additive, and must pass `scripts/bluegreen/migration-gate.mjs`. No `SET NOT NULL`.
- Never run `prisma migrate reset`, `migrate dev`, or `db push`: the development database holds real records.
- Do not edit `apps/api/prisma/migrations/20260711030000_add_team_lifecycle_security/migration.sql`. A test reads it byte for byte.
- A new table must be added to `DISPOSABLE_DATABASE_RESET_TABLES` in `e2e/helpers/database-safety.cjs` or every isolated e2e run fails closed.
- Every new test gets a mutation canary before it counts as evidence.
- Another session may be working in this tree. Commit with an explicit pathspec, and check `git status` before and after.
- Work on `master`. No worktrees, no feature branches.

---

### Task 1: The table that records what a client did

**Files:**
- Create: `apps/api/prisma/migrations/20260919230000_add_client_activity_event/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`, `e2e/helpers/database-safety.cjs`
- Test: `apps/api/src/tests/client-activity-schema.test.ts`

Audit rows today record the human actor but never the channel. Roughly forty of the fifty-five mutating routes write no row at all. A connector that can write without this is a connector whose writes cannot be reviewed afterwards.

- [ ] **Step 1: Write the failing test.** The migration creates an append-only table: an `UPDATE` and a `DELETE` against it both raise. The table appears in the disposable reset list.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Write the migration.** Columns: `id`, `organisationId`, `userId`, `sessionId`, `clientKind`, `method`, `routePattern`, `resourceId`, `statusCode`, `requestId`, `reason`, `occurredAt`. Append-only trigger modelled on `SecurityAuditEvent_append_only`. Index on `(organisationId, occurredAt DESC)`.
- [ ] **Step 4: Mirror it in `schema.prisma`** and regenerate the client.
- [ ] **Step 5: Add the table to `DISPOSABLE_DATABASE_RESET_TABLES`.**
- [ ] **Step 6: Run the migration gate and the API suite.**
- [ ] **Step 7: Commit** (pathspec).

---

### Task 2: The hook that writes a row for every connector write

**Files:**
- Create: `apps/api/src/plugins/client-activity-log.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/tests/client-activity-log.test.ts`

- [ ] **Step 1: Write the failing tests.** An unsafe request from a connector session writes exactly one row carrying the method, the matched route pattern rather than the raw path, the status code and the session id. A safe method writes nothing. A web session writes nothing. A failed request still writes a row, because an attempt is the thing worth seeing. A logging failure never fails the request.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement the `onResponse` hook.** Read the reason from `X-CharityPilot-Reason`, truncated to 500 characters. Use `request.routeOptions.url` for the pattern so identifiers do not land in the column.
- [ ] **Step 4: Register it in `server.ts`.**
- [ ] **Step 5: Run the API suite.**
- [ ] **Step 6: Commit** (pathspec).

---

### Task 3: Destructive routes require administrator level

**Files:**
- Modify: the destructive route list named in the spec
- Test: `apps/api/src/tests/session-level-routes.test.ts`

A web session is always `ADMIN`, so no browser behaviour changes. What changes is that a connector session at write level cannot delete.

- [ ] **Step 1: Write the failing test.** Every route in the destructive list carries `requireSessionLevel('ADMIN')`, read from the registered route table rather than asserted by hand, so a route added later without the guard is caught.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Apply the guard** to each route in the list.
- [ ] **Step 4: Run the API suite** and confirm no web-facing test changes behaviour.
- [ ] **Step 5: Commit** (pathspec).

---

### Task 4: A connector session gets its own write budget

**Files:**
- Modify: `apps/api/src/utils/identifier-rate-limit.ts`
- Test: `apps/api/src/tests/connector-write-limit.test.ts`

An agent loop writing flat out would exhaust the shared hundred-per-minute address bucket and lock the owner out of the web interface from the same machine. The connector's writes are counted against its own session instead.

- [ ] **Step 1: Write the failing test.** Unsafe requests from a connector session are limited per session id. A second connector session has its own budget. A web session is untouched.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement** a `connectorWriteRateLimit()` keyed by session id.
- [ ] **Step 4: Run the API suite.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 5: The owner can see and revoke connector sessions

**Files:**
- Modify: `apps/api/src/services/team-lifecycle.service.ts`, the sessions modal in the web app
- Test: the existing team-lifecycle tests, plus a row asserting the field is returned

- [ ] **Step 1: Write the failing test.** `listSessions` returns `clientKind` and `accessLevel` for each session.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Select the fields** and render a badge naming the client and its level.
- [ ] **Step 4: Run the API suite and the web build.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 6: Prove it live, and canary it

**Files:**
- Modify: `e2e/tests/mcp/connector-live.spec.ts`, `scripts/mcp-live-canary.mjs`

- [ ] **Step 1: Add assertions.** A write from a connector session leaves one activity row naming the route pattern. A write-level session is refused a destructive route with the level code. The row is not written for a read.
- [ ] **Step 2: Run the live suite.**
- [ ] **Step 3: Add a canary** that drops the activity hook and confirm the suite goes red.
- [ ] **Step 4: Commit** (pathspec).

## What 2c does not do

No write tools. The connector still offers reads only; this phase is the accountability that has to exist before authority is handed over. Per-action approval is Phase 3.
