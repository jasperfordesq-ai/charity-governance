# CharityPilot — session posture (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every authentication session a recorded posture — what kind of client it is, and how much it may do — enforced by the API on every request and by the database on every rotation.

**Architecture:** Two enum columns on `AuthSession`. `clientKind` says whether a session belongs to the web application or to the MCP connector. `accessLevel` says whether it may read, write, or also perform destructive actions. The posture is chosen once, at sign-in, by whoever typed the password; it is immutable thereafter, copied across token rotation, and pinned per session family by a database trigger so a rotation that forgets to copy it fails the insert rather than silently widening the session.

**Tech Stack:** Fastify 5, Prisma 6, PostgreSQL 16, hand-written additive SQL migration, Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-09-19-charitypilot-mcp-full-access-design.md`, Phase 2.

## Why Phase 2 is split

The spec's Phase 2 is one block covering the session columns, four new connector auth routes, a request-level activity log, level enforcement on destructive routes, the sessions UI, and a connector rewrite. That is too much to land in one reviewable change against the most security-sensitive code in the repository. It is delivered in three:

- **2a, this plan.** The posture columns, the migration, the guards, and enforcement. Self-contained and testable on its own: a READ session is refused every unsafe method, proven by tests, even though nothing can yet create one except a test.
- **2b.** The connector auth routes (`/api/v1/auth/connector/*`), the non-browser guard, the inverted origin rule, and the connector-side rewrite. At the end of 2b the connector can create a READ or WRITE session and the live harness can prove the whole path.
- **2c.** The `ClientActivityEvent` log, ADMIN gating on the destructive routes, the per-session write limiter, and the connector badge in the sessions UI.

2a is useless to a user on its own and that is fine; it is the foundation the other two stand on, and landing it separately means the migration can be reviewed for what it is.

## Global Constraints

- **The development database holds real records.** Never `prisma migrate reset`, `migrate dev`, or `db push`. The migration is hand-written and additive. `npm run db:migrate` at the root maps to `migrate dev` — do not run it.
- **Do not edit `20260711030000_add_team_lifecycle_security/migration.sql`.** `apps/api/src/tests/team-lifecycle-migration.test.ts` reads it byte for byte. Extend its functions from a new migration with `CREATE OR REPLACE FUNCTION`, which keeps the existing triggers pointing at the same names.
- **No `SET NOT NULL`.** `scripts/bluegreen/migration-gate.mjs` blocks it. Use the single-statement `ADD COLUMN ... NOT NULL DEFAULT ...` form, which PostgreSQL 11+ performs without a table rewrite.
- **The new columns must carry SQL defaults.** `e2e/helpers/db.ts:514` inserts an explicit five-column list into `AuthSession`, and `scripts/check-local-docker.test.mjs:566` pins that list with a regular expression. Give the columns defaults and neither file needs touching.
- **`COMMIT;` must be the last token** in the migration, and comments may precede `BEGIN;`. Asserted for the house style by `team-lifecycle-migration.test.ts`.
- **Never write `ON TRUNCATE`** in a trigger. The e2e reset truncates, and a statement-level guard would deadlock it; a test forbids it outright.
- **Adding a Prisma model obliges adding it to `DISPOSABLE_DATABASE_RESET_TABLES`** in `e2e/helpers/database-safety.cjs`, because `e2e/helpers/database-safety.test.cjs` asserts that list equals every model except four preserved ones. That check runs offline, with no database. This plan adds no model; 2c does.
- **Posture belongs on the session row, not in the token.** `apps/api/src/utils/jwt.ts` reconstructs the payload from an allowlist of four claims on verify, so anything else signed in is silently dropped. Carrying posture in the JWT would be dead weight and would put it beyond database enforcement.
- **Another session may be active in this working tree.** Commit with an explicit pathspec, and check `git status` before and after. A plain `git commit` takes the whole index.

## The bug this design is shaped around

Token rotation today copies `userId`, `familyId` and `familyCreatedAt` into the successor row and nothing else. `deviceLabel` is already lost on every refresh — the column exists, the sessions modal renders it, and no value survives fifteen minutes. That is precisely the failure mode a posture column would suffer, except that losing a posture does not blank a label, it silently restores the session to full authority.

So the copy is written in application code *and* enforced in the database. `guard_auth_session_principal` already pins a family to one user and one creation instant; extending it to pin the posture means a rotation that forgets to copy raises `23514` and the refresh fails, rather than succeeding with a widened session.

---

### Task 1: The migration

**Files:**
- Create: `apps/api/prisma/migrations/20260919190000_add_auth_session_posture/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`

**Interfaces:**
- Produces: enums `AuthSessionClientKind` (`WEB`, `MCP_CONNECTOR`) and `AuthSessionAccessLevel` (`READ`, `WRITE`, `ADMIN`); `AuthSession.clientKind` and `AuthSession.accessLevel`, both `NOT NULL` with defaults.

- [ ] **Step 1: Write the migration**

The file opens with a prose comment explaining what it preserves, then `BEGIN;`, and ends with `COMMIT;` as the final token. It must:

1. `CREATE TYPE "AuthSessionClientKind" AS ENUM ('WEB', 'MCP_CONNECTOR');`
2. `CREATE TYPE "AuthSessionAccessLevel" AS ENUM ('READ', 'WRITE', 'ADMIN');`
3. Add both columns in one statement, with defaults that preserve today's behaviour exactly — every existing session is a web session with full authority:

```sql
ALTER TABLE "AuthSession"
    ADD COLUMN "clientKind" "AuthSessionClientKind" NOT NULL DEFAULT 'WEB'::"AuthSessionClientKind",
    ADD COLUMN "accessLevel" "AuthSessionAccessLevel" NOT NULL DEFAULT 'ADMIN'::"AuthSessionAccessLevel";
```

4. Add a CHECK that keeps the web contract explicit, so a narrowed web session cannot appear by accident before the web application is ready to ask for one:

```sql
ALTER TABLE "AuthSession"
    ADD CONSTRAINT "AuthSession_web_is_admin_check"
        CHECK ("clientKind" <> 'WEB'::"AuthSessionClientKind"
               OR "accessLevel" = 'ADMIN'::"AuthSessionAccessLevel");
```

5. `CREATE OR REPLACE FUNCTION "guard_auth_session_update"()` — the existing body, unchanged, with `clientKind` and `accessLevel` added to the immutable-column branch. Keep both `RAISE EXCEPTION` messages and both error codes (`23514`, `55000`) exactly as they are; `team-lifecycle-migration.test.ts` matches on the revocation message text.
6. `CREATE OR REPLACE FUNCTION "guard_auth_session_principal"()` — the existing body, unchanged, with the family-consistency read widened. Add `"clientKind"` and `"accessLevel"` to the `DECLARE` block, to the `SELECT ... INTO` from `AuthSession`, and to the `IS DISTINCT FROM` comparison. Keep `ORDER BY "id" LIMIT 1 FOR SHARE` exactly as it is, and keep the organisation and user lifecycle checks and their `FOR SHARE` locks untouched.

No `DROP TRIGGER` and no `CREATE TRIGGER`: both triggers already point at these function names.

- [ ] **Step 2: Mirror it in the Prisma schema**

In `apps/api/prisma/schema.prisma`, add the two enums and two fields on `AuthSession`:

```prisma
  clientKind             AuthSessionClientKind        @default(WEB)
  accessLevel            AuthSessionAccessLevel       @default(ADMIN)
```

- [ ] **Step 3: Check the migration against the deploy gate before applying it**

Run: `node --test scripts/bluegreen/migration-gate.test.mjs` and then the gate itself over the new file if it has a direct entry point; otherwise confirm by inspection that the SQL contains no `SET NOT NULL`, no `DROP`, no `TRUNCATE`, and no `ALTER COLUMN ... TYPE`.
Expected: no BLOCKED rule matches. A `validating-constraint` WARN on the CHECK is expected and does not block.

- [ ] **Step 4: Apply it to the local development database**

```bash
npm run db:migrate:deploy -w @charitypilot/api
```
Expected: one migration applied. Then `npx prisma migrate status --schema apps/api/prisma/schema.prisma` reports no drift, and `npx prisma validate --schema apps/api/prisma/schema.prisma` passes.

If `DATABASE_URL` is not exported, set it from `apps/api/.env` first; the development database is the one with real records, and this migration is additive with defaults, so it is safe, but read the SQL once more before running it.

- [ ] **Step 5: Regenerate the client and confirm the existing suite still passes**

```bash
npm run db:generate -w @charitypilot/api
cd apps/api && npm test
```
Expected: PASS, including `team-lifecycle-migration.test.ts`, which must be unaffected because its file was not touched.

- [ ] **Step 6: Commit** (explicit pathspec; check `git status` first and after)

---

### Task 2: Carry the posture through issuance

**Files:**
- Modify: `apps/api/src/services/session-tokens.ts`, `apps/api/src/services/auth.service.ts`
- Test: `apps/api/src/tests/auth-session-reliability.test.ts` (or a new `session-posture.test.ts`)

**Interfaces:**
- Consumes: the columns from Task 1.
- Produces: `SessionPosture = { clientKind: 'WEB' | 'MCP_CONNECTOR'; accessLevel: 'READ' | 'WRITE' | 'ADMIN' }`, an optional trailing parameter on `issueSessionTokensWithClient`, `issueSessionTokensInTransaction`, `issueSessionTokens` and `issueLoginSessionTokens`, defaulting to `{ clientKind: 'WEB', accessLevel: 'ADMIN' }`.

- [ ] **Step 1: Write the failing tests**

Assert that issuance with no posture writes `WEB`/`ADMIN`, that an explicit posture is written as given, and that the CHECK constraint refuses a narrowed web session. The suite drives a real Fastify instance with a fake `prisma`, so the posture assertions go on the recorded `authSession.create` argument.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement**

Add the type and the parameter, defaulted so every existing caller keeps its behaviour. Thread it into the single `authSession.create` at the issuance site. `auth.service.ts:226` (`login`) gains an optional posture parameter it passes straight through; `team.service.ts:797` (invite acceptance) keeps the default and needs no change.

- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 3: Carry the posture through rotation, and refuse a cross-channel refresh

**Files:**
- Modify: `apps/api/src/services/session-tokens.ts`
- Test: the same posture test file

**Interfaces:**
- Consumes: Task 2.
- Produces: `rotateSessionTokens(prisma, refreshToken, expectedClientKind?)`.

This is the task the whole design exists for.

- [ ] **Step 1: Write the failing tests**

- A rotated session keeps the posture of the row it replaced. Assert on the successor `create` argument, for a `MCP_CONNECTOR`/`READ` family.
- Rotation presented with an `expectedClientKind` that does not match the family's is refused, with the same opaque error as an invalid token, so the channel cannot be probed.
- Rotation with no `expectedClientKind` keeps working, so the web path is unchanged.

- [ ] **Step 2: Run them and watch them fail** — the successor currently gets column defaults.

- [ ] **Step 3: Implement**

Add `"clientKind"` and `"accessLevel"` to the `locked_family` CTE's `SELECT` and to the outer projection in `lockPrincipalAndFamily`, add both to the `LockedFamilyRow` type, and copy both in the successor `create` beside `familyId` and `familyCreatedAt`. Add the optional `expectedClientKind` parameter and reject a mismatch through `invalidRefreshToken()`.

While here, copy `deviceLabel` too. It is the same bug, already shipped, and the fix is one line in the same object.

- [ ] **Step 4: Run the tests.**

- [ ] **Step 5: Prove the database catches what the code might miss**

Delete the `clientKind` copy from the successor `create`, rebuild, and run the migration-backed test that exercises a real PostgreSQL rotation. Expect `23514` from `guard_auth_session_principal` rather than a widened session. Restore the line.

If no existing test rotates against a real database, do this manually against the local development database with a scratch session, and record the result in the commit message. The point is to prove the trigger fires, not to leave the code broken.

- [ ] **Step 6: Commit** (pathspec), recording the trigger proof.

---

### Task 4: Expose the posture on the request, and enforce READ

**Files:**
- Modify: `apps/api/src/middleware/auth.ts`
- Create: `apps/api/src/middleware/session-level.ts`
- Test: `apps/api/src/tests/session-posture.test.ts`

**Interfaces:**
- Produces: `request.authSession: { id: string; clientKind: ...; accessLevel: ... }` via the existing Fastify augmentation; `requireSessionLevel(minimum)` as a preHandler factory.

- [ ] **Step 1: Write the failing tests**

- A `READ` session is refused `POST`, `PUT`, `PATCH` and `DELETE` with 403 `SESSION_READ_ONLY`, and is allowed `GET` and `HEAD`.
- An `ADMIN` web session is unaffected on every method, so nothing about the web application changes.
- `requireSessionLevel('ADMIN')` passes an `ADMIN` session and refuses a `WRITE` one with 403.
- The refusal names the level, and does not leak a stack trace.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement**

Widen the `authSession.findFirst` select from `{ id: true }` to include both columns, decorate `request.authSession` alongside `request.user`, and add the read-only check for unsafe methods. Leave `TokenPayload` untouched.

Note that `/auth/refresh` and `/auth/logout` do not run `authGuard`, so a READ session can still refresh and sign out. That is correct: ending a session is not a write to the charity's records.

- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 5: The replay that nobody hears

**Files:**
- Modify: `apps/api/src/services/session-tokens.ts`, `apps/api/prisma/schema.prisma`, and a second migration for the enum value
- Test: the posture test file

Presenting a revoked refresh token quarantines the whole family today, and says nothing: no audit row, no email. A stolen credential being replayed is exactly the event the owner should hear about.

- [ ] **Step 1: Check the constraint trap first**

`apps/api/src/tests/security-audit-subject-check-coverage.test.ts` walks every migration, finds the most recent one defining `CONSTRAINT "SecurityAuditEvent_subject_check" CHECK (`, and asserts every value of `SecurityAuditEventType` in the schema is admitted by it. Adding an enum value therefore obliges re-issuing that constraint in the same migration. Read the current constraint before writing anything.

- [ ] **Step 2: Write the failing test** — a replayed refresh token writes one `SecurityAuditEvent` of the new type, inside the same transaction as the quarantine, naming the subject session and the client kind in `context`.

- [ ] **Step 3: Run it and watch it fail.**

- [ ] **Step 4: Implement** the enum value, the re-issued subject check, and the audit write on the replay branch.

- [ ] **Step 5: Run the API suite**, including `security-audit-subject-check-coverage.test.ts`.
- [ ] **Step 6: Commit** (pathspec).

---

### Task 6: Verification and documentation

- [ ] **Step 1: Run the full gate**

```bash
cd apps/api && npm test
cd ../mcp && npm test
cd ../e2e && npm run typecheck
npm run test:e2e:contract
npm run security:scan
npm run test:e2e:mcp
git status --porcelain
```

- [ ] **Step 2: Confirm the migration applies to an empty database**, which is what CI and the release image both do:

```bash
npm run test:e2e:mcp
```
The disposable stack runs `migrate deploy` from scratch on every run, so a green live suite is that proof.

- [ ] **Step 3: Record the posture in `mcp/HANDOVER.md`** — what the two columns mean, that they are immutable and family-pinned, and that nothing creates a non-default posture until 2b lands.

- [ ] **Step 4: Mark 2a complete in the spec**, and note that 2b and 2c remain.

- [ ] **Step 5: Commit** (pathspec).

---

## What 2a does not do

Nothing can create a session with a non-default posture yet: there is no route that accepts one, and the connector still signs in through the browser path. That arrives in 2b along with the connector auth routes. Destructive routes are not yet gated on `ADMIN`, and no activity log exists; both are 2c. Until then the columns are inert for every real user, which is the point of landing them separately.
