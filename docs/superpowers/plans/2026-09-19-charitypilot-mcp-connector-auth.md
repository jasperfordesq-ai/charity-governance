# CharityPilot — connector sign-in (Phase 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the connector sign in as itself, at a level the owner chooses when they type their password, so the posture columns landed in 2a stop being inert and a write slice becomes possible.

**Architecture:** Four routes under `/api/v1/auth/connector` that return tokens in the JSON body and set no cookies. They are reachable only by a non-browser client, proved by a custom header that forces a CORS preflight no browser can satisfy, plus a fail-closed check for browser evidence. `clientKind` is derived from the route and never from the request; `accessLevel` comes from the body, which is safe because the password gates it. The connector then signs in through these routes instead of the browser ones, which also removes the origin problem that blocks split-host deployments.

**Tech Stack:** Fastify 5, Prisma 6, Node's built-in test runner, the existing MCP connector package.

**Spec:** `docs/superpowers/specs/2026-09-19-charitypilot-mcp-full-access-design.md`, Phase 2. Follows `docs/superpowers/plans/2026-09-19-charitypilot-mcp-session-posture.md` (2a, done).

## Why this is the gate to full authority

The owner asked for full authority from the connector. That is the destination, and this phase is what makes it safe to approach. Until a session can say what it is and how much it may do, every connector session is indistinguishable from a browser session holding the account's full rights. 2a gave sessions a posture the database enforces. 2b is the only way to create one.

It also dissolves an open problem. The connector currently derives an origin header from its own base URL, which the API accepts only because the VM serves the application and the API from one host. On a split host it would be rejected. Connector routes send no origin at all, so the hosting move stops being blocked by this.

## Global Constraints

- **`mcp/` stays outside the npm workspace globs**, and no task may change the root `package-lock.json`. Another session is active in this tree: commit with an explicit pathspec and check `git status` before and after.
- **No new runtime dependency in `mcp/`.**
- **TLS verification must never be disabled**, and do not write either string the `tls-verification-disabled` SAST rule matches, in code or in prose. The scanner reads documentation too.
- **The connector routes must never emit a set-cookie header.** A response that sets no cookie cannot be the target of login cross-site request forgery, which is the entire justification for waiving the origin requirement on them. A test pins this.
- **The custom client header must never be added to the CORS allowed-headers list.** It is not safelisted, so a browser must preflight it, and the preflight fails. That is what makes the route unreachable from a page. A test pins this too.
- **`clientKind` is derived from the route**, never read from the request. A browser must not be able to mint a connector session, and the connector must not be able to mint a web one.
- **Migrations, if any, are additive and hand-written.** This phase should need none.

## The threat this design answers

A connector that signs in like a browser is a browser as far as the API is concerned. The risk is not theoretical: a page on any origin could post credentials to the sign-in route if the origin rules were simply relaxed. So the waiver is narrow and fails closed in three independent ways.

1. The route requires the client header, which is not CORS-safelisted, so any browser must preflight it. The preflight is refused because the header is not in the allowed list, and it must stay out.
2. The route rejects the request outright if it carries any evidence of a browser: an origin, a referer, any `Sec-Fetch-*` header, or a CharityPilot auth cookie. Node's fetch sends none of these; browsers attach them and page script cannot remove them.
3. The route returns tokens in the body and sets no cookie, so even a successful call establishes nothing in a browser.

---

### Task 1: The non-browser guard

**Files:**
- Create: `apps/api/src/utils/non-browser-client.ts`
- Test: `apps/api/src/tests/non-browser-client.test.ts`

**Interfaces:**
- Produces: `CONNECTOR_CLIENT_HEADER`, and `assertNonBrowserClient(request)` returning `{ ok: true }` or `{ ok: false, statusCode: 403, payload: { error, code } }`.

- [ ] **Step 1: Write the failing tests.** A request carrying the client header and nothing else passes. A request is refused when it carries any of: no client header, a malformed client header, an origin, a referer, any of the three `Sec-Fetch-*` headers, or a `charitypilot_access` or `charitypilot_refresh` cookie. The refusal code is `BROWSER_CLIENT_REJECTED` and says nothing about credentials.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** The header value must match `mcp-connector/<semver>`, so a bare truthy string is not enough.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 2: Invert the origin rule for connector paths

**Files:**
- Modify: `apps/api/src/utils/request-origin.ts`
- Test: `apps/api/src/tests/request-origin.test.ts`

Today a path ending `/auth/login` demands an allow-listed origin. A connector path must demand the opposite: no origin at all. Without this, a browser on the application's own origin could still reach the route, and only the header check would stand between it and a token in a readable response body.

- [ ] **Step 1: Write the failing tests.** A POST to a path containing `/auth/connector/` carrying any origin is refused 403 `INVALID_ORIGIN`, including an allow-listed one. The same POST with no origin passes. Existing behaviour for `/auth/login`, `/auth/refresh`, `/auth/logout` and `/team/accept-invite` is unchanged, and so is the cookie-without-bearer rule.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** a connector-path check ahead of the existing branches.
- [ ] **Step 4: Run the whole API suite**, because this file guards every unsafe request in the system.
- [ ] **Step 5: Commit** (pathspec).

---

### Task 3: The connector auth routes

**Files:**
- Create: `apps/api/src/routes/auth/connector.ts`
- Modify: `apps/api/src/routes/auth/index.ts`
- Test: `apps/api/src/tests/auth-connector-routes.test.ts`

**Interfaces:**
- `POST /api/v1/auth/connector/login` takes `{ email, password, accessLevel, deviceLabel? }` and returns `{ user, accessToken, refreshToken, session }`.
- `POST /api/v1/auth/connector/refresh` takes `{ refreshToken }` and returns the same token pair.
- `POST /api/v1/auth/connector/logout` takes `{ refreshToken }`.
- `GET /api/v1/auth/connector/session` behind `authGuard`, returning the posture and the role.

- [ ] **Step 1: Write the failing tests.**
  - Login returns tokens in the body and no set-cookie header at all.
  - Login without the client header is refused 403.
  - Login carrying an origin is refused 403.
  - An access level of read produces a session recorded as connector and read.
  - A body field claiming a web client kind is ignored; the route decides.
  - Refresh rejects a token belonging to a web session, because the expected client kind is passed.
  - The rate limits match the browser routes: per-email on login, per-token on refresh and logout.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement**, reusing the login service with the posture parameter added in 2a, and the existing rate-limit helpers.
- [ ] **Step 4: Run the tests and the full API suite.**
- [ ] **Step 5: Pin the two properties the design rests on** with tests that fail if someone relaxes them later: the CORS allowed-headers list does not contain the client header, and no connector route response carries a set-cookie header.
- [ ] **Step 6: Commit** (pathspec).

---

### Task 4: The connector signs in as itself

**Files:**
- Modify: `mcp/src/session.ts`, `mcp/src/config.ts`, `mcp/src/cli.ts`
- Test: `mcp/src/tests/session.test.ts`, `mcp/src/tests/config.test.ts`

- [ ] **Step 1: Write the failing tests.** The connector posts to the connector login route, sends the client header, sends no origin, and reads tokens from the response body rather than from cookies. An access-level flag parses and defaults to write off the local profile and admin on it. Connect prints the access level beside the target host, before the password prompt.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Remove the origin derivation. Keep the 403 message honest: it now means the browser-evidence guard refused, not an origin mismatch.
- [ ] **Step 4: Run the connector suite.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 5: Bind a stored credential to the host that issued it

**Files:**
- Modify: `mcp/src/credentials.ts`, `mcp/src/session.ts`
- Test: `mcp/src/tests/credentials.test.ts`

Today the stored refresh token is presented to whatever base URL is configured. Anything that can edit an AI client configuration, including an agent, could point the connector at another host, and the owner's live credential would be sent there on the first refresh. The stored value becomes a small record carrying the origin that issued it, and is refused to any other.

- [ ] **Step 1: Write the failing tests.** A credential issued at one origin is not returned for another. An older plain-string entry still reads, so an existing connection is not broken. Status reports the access level.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement**, keeping one keychain entry per profile.
- [ ] **Step 4: Run the connector suite.**
- [ ] **Step 5: Commit** (pathspec).

---

### Task 6: Prove it live

**Files:**
- Modify: `e2e/helpers/mcp-connector.ts`, `e2e/tests/mcp/connector-live.spec.ts`, `scripts/mcp-live-canary.mjs`

- [ ] **Step 1: Extend the harness** so connect can request an access level.
- [ ] **Step 2: Add assertions.** A read-level connector reads every tool and is refused an unsafe method with a read-only code, proved by posting directly with that session's token so the refusal is the API's rather than the connector's. A write-level session is allowed the same request. A stored credential is refused to a different origin. A browser-shaped request to a connector route is refused.
- [ ] **Step 3: Run the live suite.**
- [ ] **Step 4: Add a canary** that removes the browser-evidence check and confirms the suite goes red.
- [ ] **Step 5: Commit** (pathspec).

---

### Task 7: Deploy to the VM, then verify there

The VM serves a build that predates all of this, so the connector routes do not exist on it and the connector cannot use them until the API is deployed.

- [ ] **Step 1: Confirm the deploy is the owner's decision** and that they want it now. Nothing here deploys without that.
- [ ] **Step 2: Deploy** with the blue-green procedure, which carries the pending migrations.
- [ ] **Step 3: Reconnect** at write level and confirm status reports it.
- [ ] **Step 4: Confirm a read-level session is refused a write** against the live API.
- [ ] **Step 5: Record the outcome** in `mcp/HANDOVER.md`.

## What 2b does not do

No write tools yet: that is the slice after this, and it is small once a session can be write-level. No activity log and no administrator gating on destructive routes; both are 2c, and both should land before any destructive tool exists.
