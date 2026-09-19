# CharityPilot MCP connector: full access design (read, write, upload) with server-enforced limits

Design approved by the owner 2026-09-19 after brainstorming. It supersedes the "writes" and "document downloads" items in the Deliberately excluded section of the read-only connector design (`2026-09-19-charitypilot-mcp-connector-design.md`), and keeps that spec's exclusion of disk response caching and of any generic call-any-endpoint tool. Connector in `mcp/`, API in `apps/api`.

## Context

The read-only connector (10 tools, 78 stubbed tests) is built, pushed, and has never been run against a real API. The owner now wants two things:

1. **A way to test it for real.**
2. **"God powers":** every question answerable, every write and upload possible from Claude clients and coding agents, role-aware (full for the owner, possibly read-only for trustees), across three environments over time (local demo stack now, Hyper-V VM over Tailscale, split-host production later). Security must be "airtight".

**Where the owner is right:** a coding agent that can drive the real application through its own API is a far better development partner than one reading source.

**Where the ask needs correcting, and the plan corrects it:**
- "God powers" must mean *everything the signed-in account may do in the web UI*, never a bypass. The connector is a client. All power and all limits live in the API.
- The API today has **no token scoping**: any session carries the user's full role. Read-only for trustees therefore cannot be a connector setting; it has to be a session property the API enforces.
- Agent writes would be **invisible in the audit trail**: audit rows record the human actor but no channel, no client, no IP. Roughly 40 of ~55 mutating routes write no audit row at all. A full-write connector without a request-level activity log is not enterprise-grade.
- Client-side controls (zod schemas, `reason` fields, hidden tools) protect against *mistakes and misled agents*. They do nothing against an *adversarial* agent, which can read the keychain and call the API with curl. Only server-side controls count for "hacker-proof". The plan says which control is which.

The accepted spec (`docs/superpowers/specs/2026-09-19-charitypilot-mcp-connector-design.md`) explicitly excludes writes, downloads, disk caching and a generic endpoint tool. This plan formally reverses the first two via a new design doc; keeps the last two.

## Decisions taken (owner's answers + chief-engineer calls)

| Decision | Choice | Why |
|---|---|---|
| Users | Owner first (full), trustees later (read-only), coding agents on local stack | Owner's answer |
| Environments | All three, one connector with profiles | Owner's answer |
| Destructive actions | **Per-action approval** with password in the human's own terminal; no time window | Owner chose after hearing the objection: a window elevates the agent too |
| Where limits live | API: `accessLevel READ/WRITE/ADMIN` + `clientKind` on `AuthSession` | No scoping exists; connector-side is not a security boundary |
| Scope model | Three-level ordinal, not a resource bitmask | Mirrors how Azure MCP inherits RBAC + read-only switch; no UI or mental model for 15×3 bits |
| Roles | Reuse OWNER/ADMIN/MEMBER. No new platform roles | `SUPERADMIN` is a rejected value by test; role ceilings still apply on top of accessLevel |
| Generic "call any endpoint" tool | Still excluded | Voids every scope guarantee; instead a test proves every API route has a typed tool or a listed exclusion |
| Test harness location | `e2e/tests/mcp/` riding the isolated stack; `mcp/` stays a pure package | Only supported destructive entry point; seeding helpers exist; root lockfile untouched |
| Confluence | Connector never exposes `DELETE /integrations/confluence` or OAuth callback | Owner ruling "never delete from Confluence"; OAuth needs a browser anyway |

## Architecture in one paragraph

The connector stays a local stdio MCP server each person runs as themselves. It signs in through **new dedicated connector auth routes** (`/api/v1/auth/connector/*`) that return tokens in the JSON body, set no cookies, and fail closed on any browser evidence. At sign-in the human picks an **access level** (READ, WRITE or ADMIN) that is stored on the session row, copied on every rotation, enforced by a DB trigger, and checked by `authGuard` on every request. The connector advertises only the tools the role and level permit, and re-checks at call time. Every connector write lands in a new append-only **ClientActivityEvent** table. Destructive routes require **per-action approval**: the API returns 428 with an approval ID and summary; the human runs `charitypilot-mcp approve <id>` (TTY-only, password); the approval is bound to a digest of the exact request and is single-use. Profiles pin the origin per environment; the keychain entry is bound to the origin it was minted at, so a redirected base URL can never receive a live token.

## Phases

Each phase ships independently, is tested before the next starts, and goes through the repo's normal spec/plan flow (`docs/superpowers/specs`, `docs/superpowers/plans`). Phase 0 and 1 can start today. Phases 2 to 5 need the API changes in Phase 2.

### Phase 0: prove what exists, live (no API changes)

Goal: the existing 10-tool connector runs against a real API with real data, from a harness and from Claude Desktop.

**Connector (`mcp/src`):**
- `config.ts`: add `--profile local`. Refused unless base URL host is exactly `localhost`, `127.0.0.1` or `[::1]`. Only with this profile is `http://` accepted, and only for those hosts. Without the profile the `https://` check at `config.ts:32` stays byte-for-byte. Canary tests: profile + `http://127.0.0.1.evil.example` throws; profile + the VM URL throws; no profile + `http://127.0.0.1:3302` throws.
- `credentials.ts`: `createFileStore(path)`, JSON, mode 0600, selected in `cli.ts` only when `--profile local` and `CHARITYPILOT_CREDENTIAL_FILE` are both set. Otherwise the keyring exactly as today. Without this, a harness would overwrite and rotate the owner's real VM credential.
- `cli.ts`: non-interactive `connect --email <addr> --password-stdin`, accepted only with `--profile local` and only when stdin is not a TTY. No password env var, ever.

**Origin remedy (interim, replaced in Phase 2):** add the API's own origin to `FRONTEND_URL` in `compose.e2e.yml:83` (`http://127.0.0.1:3303,http://127.0.0.1:3302`) and in `apps/api/.env` for local dev (`...,http://localhost:3002`). Update `expectedLocalServiceEnvironments()` in `scripts/run-isolated-e2e.mjs` (~line 820) and its fixture in `scripts/run-isolated-e2e.test.mjs`.

**Harness (`e2e/`):**
- `e2e/package.json`: add `@modelcontextprotocol/sdk` dev dependency (touches `e2e/package-lock.json` only).
- `e2e/helpers/db.ts`: optional `password` on `createVerifiedMember/Admin`.
- `e2e/helpers/mcp-connector.ts`: spawn `mcp/dist/cli.js` via `StdioClientTransport`; `connect`/`status`/`disconnect` as child processes; capture stderr for "no token leaked" assertions. One credential file per role.
- `e2e/helpers/mcp-seed.ts`: org A with OWNER, ADMIN, MEMBER (COMPLETE plan); 3 board members with sentinel PD (`PD-CANARY-*` strings, DOB `1968-03-14`); a governing act with notes + resolution; a document (small generated PDF, bytes kept); a conflict; a deadline. Org B with one board member named `TENANT-B-CANARY`.
- `e2e/tests/mcp/connector-live.spec.ts`, serial. Assertion matrix:
  - Lifecycle: status before connect; connect prints account AND organisation; token never in stdout/stderr; first tool call in a fresh process rotates the refresh token; unknown tool is a clean error; disconnect revokes server-side (raw refresh with old token → 401); tool after disconnect says "Not connected" with no stack trace; accented-character password connects.
  - Gate closed (OWNER): `board_register` has exact envelope keys `{data,total,page,pageSize,hasMore}`, no `dateOfBirth`/`residentialAddress`/`email`/`formerNames`/`otherDirectorships`, no `PD-CANARY-*` substring anywhere. `governing_acts` has no `notes`/`resolutions`. `documents_list` has no `%PDF`.
  - Gate open (`--allow-personal-data`): the same fields ARE present, proving the closed-gate absences were not vacuous.
  - Tenant: no tool result in org A ever contains `TENANT-B-CANARY`; connecting as org B's owner DOES return it. This finally implements the tenant test the spec promised.
  - Roles: ADMIN and MEMBER can read all 10 tools; MEMBER + gate open returns PD (record this as a DPO finding: reads are not role-gated by the API).
- Root `package.json`: `"test:e2e:mcp": "node scripts/run-isolated-e2e.mjs -- tests/mcp/connector-live.spec.ts"`.
- Negative canaries (run at least two before declaring green): add `dateOfBirth` to `SAFE_FIELDS.BoardMember` → gate test fails; force `allowPersonalData=true` in `runTool` → fails; write a token to stderr → fails.
- Optional attach mode `e2e/mcp-live.config.ts` (pattern of `personal-local.config.ts`): read-only rows against `npm run dev` on port 3002, for the fast loop and the 100/min rate-limit test.

**CI:** `.github/workflows/e2e.yml` gains `mcp/**` in paths, a `cd mcp && npm ci && npm run build` step, and `mcp/package-lock.json` in the cache key. `ci.yml` unchanged.

**Owner checklist against the VM** (stock CLI, keyring, no profile): status → connect → status names account and org → in Claude Desktop `compliance_summary`, `board_register` (no DOB/address), `governing_acts` (no notes) → ask Claude for the chair's home address and get a refusal → restart Claude, tool still works (live rotation) → disconnect → tool says not connected. Then update `mcp/HANDOVER.md` and the spec's "no live call" line.

### Phase 1: read everything (connector only)

Goal: any read question about the charity is answerable, subject to the gate.

- Tools for every remaining GET route: `compliance_principle` (by id), `compliance_record` (by standard), `compliance_signoff`, `board_member` (by id), `document` (by id), `deadlines_reminder_history`, `governance_registers_summary`, `conflicts_list`, `risks_list`, `complaints_list`, `fundraising_list`, `annual_report_readiness`, `financial_controls`, `governing_acts_voids`, `board_submissions`, `members_list`, `organisation`, `team_list`, `team_member_sessions`, `security_audit`, `billing_status`, `confluence_status`, `export_compliance_report`, `document_storage_dead_letter` (admin).
- Per-type register tools replace the impossible mixed-payload `governance_registers` tool; the gate dispatches per model.
- Pagination inputs (`page`, `pageSize`) on every list tool; zod input validation (pin `zod` exactly in `mcp/package.json`).
- Extend the PD gate to every personal-data model returned by these routes: `User` (team), `TeamInvite`, `Organisation` contact fields, `SecurityAuditEvent` labels, `RiskRecord.owner`, `FinancialControlReview.reviewedBy`, `GoverningActVoid`. Schema-drift test covers them all.
- Extend `mcp/src/tests/tool-routes.test.ts`: every `/api/v1` GET route has a tool or an entry in an exclusion list with a reason (owner realm, health probes).
- Harness rows for each new tool.

### Phase 2: API foundations for writes (additive, hand-written migration)

Goal: the API knows what a connector session is, what it may do, and records what it did.

**Schema (`apps/api/prisma/schema.prisma`) + migration:**
```sql
CREATE TYPE "AuthSessionClientKind" AS ENUM ('WEB','MCP_CONNECTOR');
CREATE TYPE "AuthSessionAccessLevel" AS ENUM ('READ','WRITE','ADMIN');
ALTER TABLE "AuthSession"
  ADD COLUMN "clientKind"  "AuthSessionClientKind"  NOT NULL DEFAULT 'WEB',
  ADD COLUMN "accessLevel" "AuthSessionAccessLevel" NOT NULL DEFAULT 'ADMIN',
  ADD CONSTRAINT "AuthSession_web_is_admin_check" CHECK ("clientKind" <> 'WEB' OR "accessLevel" = 'ADMIN');
```
- Extend `guard_auth_session_update` (immutable columns) and `guard_auth_session_principal` (family consistency) from `apps/api/prisma/migrations/20260711030000/migration.sql` so a rotation that forgets to copy `clientKind`/`accessLevel` raises rather than widening the session. **This is the trap:** `rotateSessionTokens` (`session-tokens.ts:334-343`) copies only `userId/familyId/familyCreatedAt` today.
- Reuse existing `deviceLabel` (already rendered in `team-sessions-modal.tsx:80`) for the connector label. Do not add `clientLabel`.
- New `ClientActivityEvent` table: `id, organisationId, userId, sessionId, clientKind, method, routePattern, resourceId, statusCode, requestId, reason, occurredAt`; append-only trigger copied from `SecurityAuditEvent_append_only`. **Add to `DISPOSABLE_DATABASE_RESET_TABLES` in `e2e/helpers/database-safety.cjs`** or every e2e run fails closed.
- `SecurityAuditEventType` gains `SESSION_REPLAY_DETECTED` (own migration, `ADD VALUE IF NOT EXISTS`).
- Defaults keep the raw `INSERT INTO "AuthSession"` in `e2e/helpers/db.ts:512` and `scripts/verify-team-lifecycle-upgrade.mjs` working.

**Auth surface:**
- New `apps/api/src/routes/auth/connector.ts` under `/api/v1/auth/connector`: `POST /login {email,password,accessLevel,deviceLabel}` → `{user, accessToken, refreshToken, session}`, **no Set-Cookie**; `POST /refresh`; `POST /logout`; `GET /session` → `{clientKind, accessLevel, deviceLabel, role, expiresAt}`. Reuse `bodyIdentifierRateLimit(['email'])` and `refreshTokenRateLimit`.
- New `apps/api/src/utils/non-browser-client.ts`: guard requiring `X-CharityPilot-Client: mcp-connector/<semver>` and rejecting 403 if `origin`, `referer`, any `sec-fetch-*`, or `charitypilot_*` cookies are present. `clientKind` is derived from the route, never from the body.
- `apps/api/src/utils/request-origin.ts`: paths containing `/auth/connector/` invert the rule: Origin present → 403, absent → ok. This fixes local, VM and split-host in one move and removes the `FRONTEND_URL` interim from Phase 0.
- Tests pin: connector routes never emit `Set-Cookie`; `allowedHeaders` in `browser-origin-protection.ts:27` never includes the client header (custom header forces preflight, preflight fails, so no browser page at any origin can reach these routes); browser-evidence rejection matrix.

**Session service (`apps/api/src/services/session-tokens.ts`):**
- Issuance takes a posture `{clientKind, accessLevel, deviceLabel}`; rotation copies it and takes `expectedClientKind`, rejecting cross-channel use (keychain token useless in a browser, browser cookie useless via connector).
- Replay branch (`:309-321`) writes `SESSION_REPLAY_DETECTED` and enqueues the existing security email outbox. Today replay is detected but silent.
- Connector refresh TTL: 24h at WRITE/ADMIN, 7d at READ.

**Enforcement:**
- `apps/api/src/middleware/auth.ts`: select the posture, decorate `request.authSession` (leave `TokenPayload` frozen; JWT unchanged). `accessLevel === 'READ'` and unsafe method → 403 `SESSION_READ_ONLY`.
- `apps/api/src/middleware/roles.ts`: `requireSessionLevel('ADMIN')` applied to the destructive list: `governing-acts/index.ts:119` (void), `documents/index.ts:94,325`, `team/index.ts:103,124,146,188,209,246,271`, `board-members/index.ts:55`, `governance-registers/index.ts:88,125,162,199`, `deadlines/index.ts:94`, `integrations/index.ts:881`. WEB sessions are ADMIN so no web behaviour changes.
- Per-session write limiter for `MCP_CONNECTOR` sessions (e.g. 30 unsafe req/min keyed by sessionId) in `apps/api/src/utils/identifier-rate-limit.ts`, so an agent loop cannot exhaust the shared 100/min IP bucket and lock the owner out of the web UI.
- `apps/api/src/plugins/client-activity-log.ts`: `onResponse` hook writing `ClientActivityEvent` for every unsafe request from a connector session; `reason` from `X-CharityPilot-Reason` header (cap 500).
- `team-lifecycle.service.ts:612 listSessions` selects `clientKind`; `team-sessions-modal.tsx` shows an "MCP connector" badge. The owner can see and revoke connector sessions from the Team page.

**Connector side of Phase 2:**
- `session.ts`: call `/auth/connector/*`, send `X-CharityPilot-Client`, read tokens from body, drop Origin derivation. Password prompt refuses when stdin is not a TTY (except the Phase 0 local path).
- `config.ts`: `--profile local|e2e|vm|prod` with pinned origins (`http://localhost:3002`, `http://127.0.0.1:3302`, `https://charitypilot.tailae0b07.ts.net`, and the production origin, registered here when the hosting move happens); `--access-level read|write|admin` (default: `admin` on local, `write` elsewhere); `connect` prints target AND access level before the password prompt.
- `credentials.ts`: account `refresh-token:<profile>`; value `{v:1, origin, refreshToken, accessLevel}`; `read()` refuses to present a credential to any origin other than the one it was minted at.
- `status` shows profile, account, organisation, access level, personal-data mode.

### Phase 3: writes and per-action approval

**API:**
- New `AuthActionApproval` table: `id, sessionId, userId, organisationId, requestDigest, summary, expiresAt, approvedAt, consumedAt`. Add to `DISPOSABLE_DATABASE_RESET_TABLES`.
- `requireSessionLevel('ADMIN')` routes additionally, for `MCP_CONNECTOR` sessions, require a valid approval: without `X-CharityPilot-Approval: <id>` → 428 `{approvalId, summary, expiresAt}` (5 minutes); with it → digest of `(sessionId, method, path, canonical body)` must match, single-use, then proceed.
- `POST /auth/connector/approve {approvalId, password}` under the non-browser guard, rate-limited per email.

**Connector:**
- `client.ts`: `post/put/patch/delete`, `X-CharityPilot-Reason` header.
- Typed write tools for every non-destructive write: compliance record/signoff PUT, board member create/update, deadline create/update, register create/update ×4, annual report, financial controls, governing act create/update/resolutions/approval, member create/update, organisation update, team invite create/link, Confluence publish-space. Destructive tools (`*_delete`, `governing_act_void`, `team_member_suspend/reactivate/remove/role`, `team_sessions_revoke`, `ownership_transfer`) require a `reason` and surface the 428 as a clear message: "Approval required. Run: charitypilot-mcp approve <id>".
- `cli.ts approve <id>`: TTY-only, shows the server's summary, prompts for the password, posts. The agent never sees the password and cannot approve.
- Tool registry gains `level` and `roles`; `ListTools` filters by `/auth/connector/session`; `CallTool` re-checks (an MCP client can call a tool it was not shown).
- Input-side PD allowlist: on non-local profiles write tools for gated models accept only `SAFE_FIELDS` unless `--allow-personal-data`.
- `tool-routes.test.ts`: every mutating route has a tool or a listed exclusion; every write tool path is a real mutating route.

**Explicit exclusions (with reason, tested):** `/owner/*` (separate operator realm, impersonation deferral), billing checkout/portal (Stripe redirects), auth register/forgot/reset/verify-email, team accept-invite, Stripe webhook, health probes, storage-deletion requeue (human typed-confirmation flow), `DELETE /integrations/confluence` and Confluence OAuth callback (browser flow; owner ruling).

### Phase 4: documents

- `document_upload {path, name, category, ...}`: path must resolve under `--upload-root` (realpath containment; deny dotfiles, `node_modules`, `.git`, symlinks escaping the root); mirror the API's MIME/extension/size allowlist from `document-upload-validation.ts` with a drift test; multipart via `client.ts`. Upload is an exfiltration channel *into* the tenant (and onward to Confluence), which is why the root matters.
- `document_download {id}`: only when `--download-dir` is set (default on for local, off elsewhere); writes 0600; returns the path, never bytes. The PD gate cannot filter a PDF.
- Harness: upload → list → download round trip, SHA-256 equal; MEMBER cannot upload; READ session cannot upload.

### Phase 5: trustee distribution and docs

- `connect --access-level read` for trustees; README install guide for Claude Desktop and Claude Code per profile; optional `Organisation.connectorPolicy` (connector access for non-owners: none/read/full) if the owner wants an org-wide rule.
- Docs: new spec `docs/superpowers/specs/2026-09-XX-charitypilot-mcp-full-access-design.md` reversing the two exclusions with reasoning; update `mcp/README.md`, `mcp/HANDOVER.md`; correct the old spec's tenant-test claim.

## Threat model (what protects against what)

| Threat | Control | Layer | Residual |
|---|---|---|---|
| Browser login-CSRF via connector auth | Dedicated routes, no Set-Cookie, reject Origin/Referer/Sec-Fetch/cookies, custom header forces failed preflight, `allowedHeaders` pinned by test | API | Browser extension with host permissions and the password |
| Agent exceeds intended power | `accessLevel` on session, DB-enforced, chosen by human at password time; role ceilings unchanged | API | Human connects at ADMIN on real data (profile default is WRITE off-local) |
| Compromised/injected agent does destructive act | Per-action approval bound to request digest, TTY-only password | API | None within the approved action |
| Agent bypasses connector with keychain token | Same server-side controls; per-session write limit; activity log | API | Agent acts within its level |
| Rotation resets posture | Copy in rotation + DB family trigger | API | None (fails closed) |
| Stolen keychain entry | Single-use rotation, family quarantine, new audit event + email, cross-channel rejection, 24h TTL | API | ≤15 min + one rotation before detection |
| Base URL redirected (`.mcp.json`, env) | Origin-bound keychain entry, pinned profile origins, target printed before password | Connector | Human knowingly connects to wrong host |
| Prompt injection via tool results | "Data, not instructions" descriptions; destructive tools hidden below ADMIN; approval flow | Connector + API | Non-destructive writes at WRITE level, all logged |
| Upload as exfiltration into tenant | `--upload-root` containment, deny-lists, mirrored allowlist, API validation, activity log | Connector + API | Agent uploads a permitted file it should not |
| Download leaks PD | Off by default off-local; explicit dir; path not bytes | Connector | Agent reads the file itself |
| Malicious npm dep in `mcp/` | Exact pins, `npm ci --ignore-scripts`, lockfile in CI; blast radius bounded by level + audit | Connector | Same as compromised agent |
| Agent loop DoSes owner's browser | Per-session write limit | API | Read spam shares IP bucket |
| Unauditable agent writes | `ClientActivityEvent` for every connector write; connector badge in sessions UI | API | None |

## Flags for the owner and DPO (not blocking Phase 0 or 1)

1. **`--allow-personal-data` is a client-side decision.** A MEMBER-role trustee can open the gate on their own connector. Whether reads of DOB/address should be role-gated in the API is a DPO question; Phase 0 will produce the evidence.
2. **Confluence deletion is live in the code.** `apps/api/src/services/confluence-erasure.ts` deletes and purges mirrored pages when a document is deleted, by design (dual-erasure obligation). The memory note "CharityPilot must never delete from Confluence" conflicts with this. The connector will not expose Confluence disconnect regardless, but the underlying ruling needs the owner's clarification.
3. **Split-host origin decision** disappears with Phase 2 (connector auth no longer sends Origin), so it no longer blocks the hosting move.
4. **Connecting an agent at ADMIN on the VM** means real personal data can reach a model provider when the gate is opened. Profile default is WRITE with the gate closed; opening both is a deliberate, printed choice.

## Verification

- **Unit:** `cd mcp && npm test` (Node test runner from `dist/`), `cd apps/api && npm test`. Every new test gets a mutation canary before it counts.
- **Live:** `npm run test:e2e:mcp` with Docker Desktop up; then at least two negative canaries from the list.
- **Contract:** `npm run test:e2e:contract` and `npm run test:e2e:isolated:validate` after any `compose.e2e.yml`/runner change.
- **Hygiene:** `git status` shows no root `package-lock.json` change after any `mcp/` or `e2e/` install; `npm run security:scan` clean.
- **Manual:** MCP Inspector against local (`npx @modelcontextprotocol/inspector node mcp/dist/cli.js serve --profile local --base-url http://localhost:3002`); Claude Desktop config with the local profile; owner VM checklist in Phase 0.
- **Definition of done per phase:** harness rows for that phase green, canaries fail when they should, `HANDOVER.md` updated, spec matches reality.

## Critical files

- `mcp/src/config.ts`, `mcp/src/cli.ts`, `mcp/src/credentials.ts`, `mcp/src/session.ts`, `mcp/src/tools.ts`, `mcp/src/field-policy.ts`
- `apps/api/src/services/session-tokens.ts` (rotation at :334), `apps/api/src/utils/request-origin.ts`, `apps/api/src/middleware/auth.ts`, `apps/api/src/middleware/roles.ts`, `apps/api/src/routes/auth/index.ts`, `apps/api/prisma/schema.prisma`
- `e2e/helpers/db.ts`, `e2e/helpers/database-safety.cjs`, `compose.e2e.yml:83`, `scripts/run-isolated-e2e.mjs` (~:820)
