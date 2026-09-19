# Integration Admin UI & Health (Phase 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a charity's administrator a way to connect and disconnect Confluence that actually works — including on the ordinary path where their session expires mid-flow — and show them the limits of the integration *before* they connect rather than in a document they will never read.

**Architecture:** The API already exposes `authorize`, `callback`, `status` and `DELETE`. This phase moves the OAuth callback from a bare API redirect to a **page in the web app** that refreshes the session before spending the authorization code, adds the connect/disconnect screen that renders the disclosure, and surfaces per-tenant integration health without leaking tenant data into the global health endpoint.

**Tech Stack:** Next.js App Router (`apps/web`), Fastify (`apps/api`), `node:test` in both.

**Spec:** `docs/superpowers/plans/2026-09-18-document-storage-providers-spec.md`

## Global Constraints

- **Confluence stays alpha.** Nothing in this phase promotes it. Exit criterion 2 of Phase 5 — that an erasure really removes the page from a live site — is unverifiable until the Atlassian app install.
- **Portal upload must always work.** Nothing here may make an integration load-bearing.
- **Commit directly to `master`.** No worktrees, no feature branches.
- **Closed files** — do not modify: `integration-crypto.ts`, `integration-credential.service.ts`, `atlassian-oauth.ts`, `confluence-connection.service.ts`.
- **Never** run `prisma migrate reset`, `migrate dev`, `db push`, `DROP` or `TRUNCATE`. This phase should need no migration; if you think it does, stop and say so.
- **Do not weaken the `status` route's output guard.** It is a keys allow-list plus a substring check forbidding `refresh`/`token`/`secret`. Phase 5 Task 7 tried to add copy there, hit the guard, and **reverted rather than loosening it**. Do the same.

## Testing conventions — both apps, same runner

**There is no Vitest anywhere in this repository.** Both apps use `node:test` with
`node:assert/strict`: no `describe`, no `it`, no `expect`, no `it.each` (loop for table-driven
cases).

- `apps/api`: `npm test` = `tsc && node --test dist/tests/*.test.js`.
- `apps/web`: `npm test` compiles to `.test-dist/` and runs `node --import tsx --test`.

Both run from compiled output, so **an edited test re-run without a rebuild runs its previous
version.**

**For mutation testing, skip the build**: copy the source into a scratchpad, junction the
**repository root's** `node_modules` (hoisted monorepo — the inner ones lack `tsx`/`typescript`),
and run `node --import tsx --test`. **Build every baseline from a pristine source**
(`git archive HEAD` into a new directory); a reused scratchpad has already produced a wrong
failure count in this project.

**Mutate each ANDed sub-condition independently, and each call site separately** — a compound
mutation can go red *for the wrong reason*, which is indistinguishable from coverage. Follow any
green mutation with a canary (`throw` in the branch body) and say which form you used.

---

## The decision this phase makes, and why it was deferred to here

`docs/ARCHITECTURE.md`, "The callback is cookie-authenticated, and the session can expire mid-flow",
argues the case in full. In short:

- The access-token cookie lives **15 minutes**, counted from login or the last refresh — **not**
  from the moment the administrator clicks Connect. Arriving at a settings page after a few
  minutes' work, the remaining budget is routinely **under a minute**.
- The administrator then spends unbounded time on Atlassian's consent screen, possibly logging in
  to Atlassian first.
- They return to a callback whose cookie has expired. `authGuard` answers a raw JSON **401** in a
  browser tab, to a person who has just granted access — and **the authorization code in that URL
  is single-use and now spent.** Retrying hits the same wall.

This is the ordinary path, not an edge case. **The decision: register the callback against a page
in the web app**, which refreshes the session and only then hands `code` and `state` to the API.
Only the page-mediated form gets a chance to renew the session *before* the code is spent.

> ### ⚠️ This changes what the owner registers with Atlassian
> Blocker 3 of `docs/CONTINUATION-PROMPT-confluence-integration.md` currently says the callback URL
> must be registered as exactly `{NEXT_PUBLIC_API_URL}/api/v1/integrations/confluence/callback`.
> **After this phase it is a web-app URL instead.** Atlassian matches `redirect_uri` exactly, so
> the registered value and what the API sends must stay byte-identical — a change of shape is a
> change to both. Task 5 updates every place that states it.

---

### Task 1: Point the callback at the web app, and accept the code by POST

**Files:**
- Modify: `apps/api/src/routes/integrations/index.ts` (`confluenceRedirectUri()` ~line 259-284; the callback route ~line 409)
- Modify: `apps/api/src/utils/env.ts` if a web-origin variable does not already exist — check first, do not add a duplicate
- Test: `apps/api/src/tests/integrations-route.test.ts`

**Interfaces:**
- Produces: `POST {prefix}/confluence/callback` taking `{ code, state }` as a JSON body and returning the same success/failure shape the GET returned. `confluenceRedirectUri()` returns the **web** callback URL.

**Design notes:**

The web origin is already known to the API — find how (`NEXT_PUBLIC_API_URL`'s sibling, a
`WEB_ORIGIN`/`APP_ORIGIN`, or the CORS allow-list). **Reuse it. Do not introduce a second source of
truth for the same origin**; two variables that must agree are two variables that will drift.

**Keep the `GET` route, and make it fail loudly and usefully.** A charity whose Atlassian app is
still registered against the old API URL will land on it. A 404 tells them nothing; a response that
names the change and the URL to register does. Pin that message.

Take `code` and `state` from the **body**, not the query string. They are secrets: the query string
reaches access logs, `Referer` headers and browser history. Phase 2 found Caddy's *error* logger
leaking live authorization codes on a 502 — this removes that surface rather than re-filtering it.

- [ ] **Step 1: Write the failing tests**

```ts
test('the redirect_uri points at the web app, not the API', () => {
  assert.ok(confluenceRedirectUri().startsWith(webOrigin()));
  assert.ok(!confluenceRedirectUri().includes('/api/v1/'));
});

test('the callback accepts code and state in the body, never the query string', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `${INTEGRATION_ROUTES_PREFIX}/confluence/callback`,
    cookies: signedInCookies,
    payload: { code: 'c', state: signedState },
  });
  assert.equal(response.statusCode, 200);
});

test('the retired GET callback explains what to re-register rather than 404ing', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `${INTEGRATION_ROUTES_PREFIX}/confluence/callback?code=c&state=s`,
  });
  assert.notEqual(response.statusCode, 404);
  assert.match(response.body, /re-?register|callback URL/i);
});
```

- [ ] **Step 2: Run and watch fail**

`cd apps/api && npm run build && node --test dist/tests/integrations-route.test.js`

- [ ] **Step 3: Implement** — repoint `confluenceRedirectUri()`, add the POST, retire the GET with an explanatory response.
- [ ] **Step 4: Run and watch pass.**
- [ ] **Step 5: Verify by mutation** — point `confluenceRedirectUri()` back at the API origin and confirm the first test fails alone; move `code` back to the query string and confirm the second fails.
- [ ] **Step 6: Commit**

```bash
git add apps/api && git commit -m "feat(confluence): the callback is a web page now, and the code arrives in a body"
```

---

### Task 2: The callback page — refresh the session, then spend the code

**Files:**
- Create: `apps/web/src/app/(dashboard)/integrations/confluence/callback/page.tsx`
- Create: `apps/web/src/lib/confluence-callback.ts` (the logic, so it is testable without rendering)
- Test: `apps/web/src/lib/confluence-callback.test.ts`

**Interfaces:**
- Consumes: `POST {api}/integrations/confluence/callback` from Task 1.
- Produces: `completeConfluenceCallback({ code, state }): Promise<CallbackOutcome>` where
  `CallbackOutcome` distinguishes `connected`, `session-expired`, `state-invalid`,
  `code-spent`, and `failed`.

**Design notes — this page exists to solve one problem, so do not lose it:**

**Refresh the session *before* posting the code.** That ordering is the entire point. `lib/api.ts`
already has single-flight token refresh on 401 — but relying on it here means the *first* attempt
carries a dead cookie and the code is spent by the time the refresh lands. Renew first, then spend.

**Put the code and state in the POST body, and get them out of the URL.** Next's `searchParams`
gives you them; do not log them, do not put them in an error message, and do not leave them in the
URL after a successful exchange — replace the history entry.

**Distinguish the outcomes, because they need different words.** "Your session expired while you
were on Atlassian's screen, please connect again" is actionable. "Something went wrong" is not, and
a spent code means the administrator *must* restart rather than retry.

- [ ] **Step 1: Write the failing tests**

```ts
test('the session is refreshed before the code is posted', async () => {
  const order: string[] = [];
  await completeConfluenceCallback(
    { code: 'c', state: 's' },
    { refresh: async () => { order.push('refresh'); }, post: async () => { order.push('post'); return ok(); } },
  );
  assert.deepEqual(order, ['refresh', 'post']);
});

test('a failed refresh still reports a session problem rather than a generic failure', async () => {
  const outcome = await completeConfluenceCallback(
    { code: 'c', state: 's' },
    { refresh: async () => { throw unauthorised(); }, post: async () => ok() },
  );
  assert.equal(outcome.kind, 'session-expired');
});

test('neither the code nor the state appears in any outcome message', async () => {
  const outcome = await completeConfluenceCallback(
    { code: 'SECRET-CODE', state: 'SECRET-STATE' },
    { refresh: async () => {}, post: async () => { throw serverError(); } },
  );
  const rendered = JSON.stringify(outcome);
  assert.ok(!rendered.includes('SECRET-CODE'));
  assert.ok(!rendered.includes('SECRET-STATE'));
});
```

The third is the one to guard hardest — **verify it by mutation**: interpolate the code into the
failure message and confirm it fails alone.

- [ ] **Step 2: Run and watch fail; Step 3: implement; Step 4: run and watch pass**

`cd apps/web && npm test`

- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "feat(web): renew the session before spending the authorization code"
```

---

### Task 3: The connect and disconnect screen

**Files:**
- Create: `apps/web/src/app/(dashboard)/integrations/page.tsx`
- Create: `apps/web/src/lib/integration-status.ts` + its test
- Modify: the dashboard navigation, wherever `(dashboard)/layout.tsx` lists sections

**Design notes:**

**Render the `disclosure` the API returns.** `GET /confluence/authorize` returns it beside
`authorizationUrl` precisely so no client can obtain the URL without the limits. **This task is
what makes Phase 5's exit criterion 5 true** — until now the text existed and nothing displayed it.
Show it *before* the administrator leaves for Atlassian, not after they return.

**Say what disconnecting does and does not do.** Our copy of the credentials is deleted, and that is
provable. We *attempt* withdrawal at an endpoint Atlassian does not document. **Never render "we
revoked your access."** Offer the two remedies that work: the grant lapses after 90 days without
use, or the administrator removes CharityPilot in their own Atlassian connected-apps settings —
attributed to Atlassian, not promised by us.

**Mark it alpha in the interface**, not only in documentation.

- [ ] **Step 1: Write the failing tests** — pin the disclosure is rendered, pin that the copy never
  claims revocation, pin the alpha marking.

```ts
test('the connect screen cannot show the authorize link without the disclosure', () => {
  const view = buildConnectView({ authorizationUrl: 'https://…', disclosure: DISCLOSURE });
  assert.ok(view.disclosure.length > 0);
  assert.throws(() => buildConnectView({ authorizationUrl: 'https://…', disclosure: '' }));
});

test('the disconnect copy never claims we revoked access at Atlassian', () => {
  assert.doesNotMatch(DISCONNECT_COPY, /we (have )?revoked|access (has been )?revoked/i);
  assert.match(DISCONNECT_COPY, /90 days/);
  assert.match(DISCONNECT_COPY, /connected[- ]apps/i);
});
```

- [ ] **Step 2: Run and watch fail; Step 3: implement; Step 4: run and watch pass**
- [ ] **Step 5: Verify by mutation** — rewrite the copy to claim revocation and confirm the second
  test fails alone; drop the disclosure from the view and confirm the first does.
- [ ] **Step 6: Commit**

```bash
git add apps/web && git commit -m "feat(web): show a charity the limits before it connects, not after"
```

---

### Task 4: Per-tenant health, and telling a Confluence dead-letter from a Supabase one

**Files:**
- Modify: `apps/api/src/services/document.service.ts` (`listDeadLetterStorageDeletions`)
- Modify: `apps/api/src/jobs/recover-document-storage-deletion.ts` (the dry-run `findFirst` ~line 427-434)
- Test: the existing dead-letter and platform-recovery test files

**Design notes:**

Phase 5 left two recorded gaps of the same class, both fixed here:

1. `listDeadLetterStorageDeletions` does not expose `provider`, so an administrator cannot tell a
   Confluence dead-letter from a Supabase one.
2. The operator recovery **dry-run** selects `id, attempts, terminalReason, deadLetteredAt,
   alertedAt` and no `provider`. So a corrected-path dry-run against a Confluence dead-letter
   returns a clean preview and mints an execution confirmation — and the refusal only arrives at
   `execute`, after the operator has reviewed and confirmed. It fails closed, but it wastes the
   operator's trust in the preview.

**Nothing tenant-specific may reach the global health endpoint.** Per-tenant integration state is
already served by `GET /confluence/status`, which is authenticated and scoped. Check the global
health route does not gain a Confluence field, and **pin that** — a test that the global health
payload contains no integration or tenant identifiers.

- [ ] **Step 1: Write the failing tests**

```ts
test('a dead-letter listing says which provider each row belongs to', async () => { /* … */ });

test('the operator dry-run refuses a corrected path for a Confluence row at preview, not at execute', async () => { /* … */ });

test('the global health payload carries no tenant or integration identifiers', async () => {
  const body = JSON.parse((await app.inject({ method: 'GET', url: '/health' })).body);
  const rendered = JSON.stringify(body).toLowerCase();
  for (const forbidden of ['organisation', 'confluence', 'integration', 'cloudid', 'tenant']) {
    assert.ok(!rendered.includes(forbidden), `global health leaked ${forbidden}`);
  }
});
```

- [ ] **Step 2: Run and watch fail; Step 3: implement; Step 4: run and watch pass**
- [ ] **Step 5: Verify by mutation** — add a Confluence field to the global health payload and
  confirm the third test fails alone.
- [ ] **Step 6: Commit**

```bash
git add apps/api && git commit -m "feat(erasure): say which provider a dead-letter belongs to, at preview not at execute"
```

---

### Task 5: Tell the owner what changed, and close exit criterion 5

**Files:**
- Modify: `docs/CONTINUATION-PROMPT-confluence-integration.md` (Blocker 3 — **the registered callback URL changes**)
- Modify: `docs/ARCHITECTURE.md` (the callback-session subsection is now a decision, not an open question)
- Modify: `docs/superpowers/plans/2026-09-18-provider-aware-erasure-phase-5.md` (exit criterion 5)

**Content:**

- **Blocker 3's registered URL is now the web-app callback.** State the new value, state that
  Atlassian matches it exactly, and state that a deployment whose Atlassian app still points at the
  old API URL gets the explanatory response Task 1 added rather than a silent failure.
- The ARCHITECTURE subsection should record **what was decided and why** — page-mediated so the
  session can be renewed before the code is spent — rather than continuing to present it as open.
- **Exit criterion 5 of Phase 5 ("the limits are documented and shown to the administrator before
  they connect") is now met**, by Task 3. Say so, and say what still is not: criterion 2 remains
  unverifiable until the Atlassian app install, so **Confluence remains alpha**.

- [ ] **Step 1: Write the three edits**
- [ ] **Step 2: Run `npm run test:production-check`** — it checks documentation invariants
- [ ] **Step 3: Commit**

```bash
git add docs && git commit -m "docs: the callback moved, so the URL you register with Atlassian moved too"
```

---

## Exit criteria

1. An administrator can connect Confluence, and **a session that expires while they are on
   Atlassian's consent screen no longer costs them the authorization code.**
2. The disclosure is shown before they leave for Atlassian, and no client can get the authorize URL
   without it.
3. Disconnect copy never claims we revoked access, and names the two remedies that work.
4. A dead-lettered erasure says which provider it belongs to, in the listing and in the operator
   preview.
5. The global health endpoint carries no tenant or integration identifiers.
6. **Confluence is still alpha.** Nothing here promotes it.
