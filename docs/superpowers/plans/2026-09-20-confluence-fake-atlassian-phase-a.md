# Fake Atlassian (Confluence connector completion, Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an in-process fake Atlassian that the Confluence connector's own code can be driven against, so every remaining Tier 2 item can be built and proven without an Atlassian OAuth application, without credentials, and without touching a real site.

**Architecture:** A `fetch`-shaped function plus a mutable in-memory site. `ConfluenceClientDeps.fetch` and `AtlassianOAuthDeps.fetch` are already injectable, so the fake needs no production code change and no network. It models the four platform behaviours that actually bite — a v2 404 hiding both trash and purge, `purge=true` only on an already-trashed page, `PUT` requiring `version.number = current + 1`, and refresh-token rotation — because those are what the remaining work has to get right.

**Tech Stack:** TypeScript, `node:test` from `dist/`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-20-confluence-connector-audit.md` (item T2.9, plus the §3 platform-facts table which this fake must obey).

## Global Constraints

- Tests are `node:test`, compiled first: `npm test --workspace apps/api` runs `tsc -p tsconfig.json` then `node --test dist/tests/*.test.js`. **There is no Vitest.** A thrown test is not a failed assertion — assert explicitly.
- **Every guard needs a canary.** When a test pins behaviour, break the implementation in a scratchpad copy and confirm the test fails. Never mutate the working tree.
- **Never write a file containing a backslash via a bash heredoc** — escape literals decode to raw control bytes, tests stay green, and `git` calling the file binary is the only signal. Use Write/Edit.
- Work on `master`. No worktrees, no feature branches.
- No production source file may import from the fake. It is test-only.
- The fake must never be reachable over the network: it is a function, not a server.

## Deviation from the spec, recorded deliberately

The audit places this under `e2e/helpers/`. **This plan puts it at `apps/api/src/tests/fake-atlassian.ts` instead.**

Reason: the fake's purpose is to unblock the reconcile job, the publisher, the eraser and the client hardening — all of which are API-level `node:test` suites, not Playwright. `e2e/` is a separate package that `apps/api`'s tests cannot import, so placing it there would leave the enabler unusable by the code that most needs it. `dist/tests/fake-atlassian.js` is not matched by the `dist/tests/*.test.js` glob, so it will not be collected as a test. A Playwright-side adapter can re-export it later if the browser specs need one; that is not this plan.

## File Structure

- `apps/api/src/tests/fake-atlassian.ts` — **new.** The whole fake: state, router, `fetch`. One file, because the routing and the state it mutates change together and a reviewer needs to hold both at once.
- `apps/api/src/tests/fake-atlassian.test.ts` — **new.** The fake's own tests. A test double that lies is worse than none, so its fidelity to the four platform behaviours is pinned here.
- `apps/api/src/tests/confluence-round-trip.test.ts` — **new.** Drives the real `confluence-client`, `confluence-pages` and `confluence-spaces` against the fake. This is the file that proves the fake is usable by production code.

---

### Task 1: The site state and the `fetch` entry point

**Files:**
- Create: `apps/api/src/tests/fake-atlassian.ts`
- Test: `apps/api/src/tests/fake-atlassian.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createFakeAtlassian(options?: FakeAtlassianOptions): FakeAtlassian`, where

```ts
export type FakeAtlassianOptions = {
  cloudId?: string;
  siteUrl?: string;
  siteName?: string;
  clientId?: string;
  clientSecret?: string;
};

export type FakeCall = { method: string; url: string };

export type FakeAtlassian = {
  fetch: typeof globalThis.fetch;
  cloudId: string;
  calls: FakeCall[];
  addSpace(space: { id: string; key: string; name: string }): void;
  getPage(pageId: string): FakePage | undefined;
  allPages(): FakePage[];
};

export type FakePage = {
  id: string;
  spaceId: string;
  title: string;
  version: number;
  status: 'current' | 'trashed' | 'purged';
  properties: Map<string, { id: string; key: string; value: unknown; version: number }>;
};
```

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeAtlassian } from './fake-atlassian.js';

test('an unrouted path is a 404, and every call is recorded', async () => {
  const site = createFakeAtlassian();

  const response = await site.fetch(
    `https://api.atlassian.com/ex/confluence/${site.cloudId}/wiki/api/v2/nonsense`,
  );

  assert.equal(response.status, 404);
  assert.equal(site.calls.length, 1);
  assert.equal(site.calls[0]?.method, 'GET');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/api`
Expected: FAIL — `Cannot find module './fake-atlassian.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/tests/fake-atlassian.ts` with the types from **Interfaces** above, a `Map<string, FakePage>` of pages, an array of spaces, a `calls` array, and a `fetch` that records `{ method, url }` then returns `new Response(JSON.stringify({ errors: [{ title: 'Not Found' }] }), { status: 404, headers: { 'Content-Type': 'application/json' } })` for anything it does not route. Default `cloudId` to `'11111111-2222-3333-4444-555555555555'`, `siteUrl` to `'https://example.atlassian.net'`, `siteName` to `'Example'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tests/fake-atlassian.ts apps/api/src/tests/fake-atlassian.test.ts
git commit -m "test(confluence): a fake Atlassian site, starting with its front door

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The OAuth surface, with refresh-token rotation

**Files:**
- Modify: `apps/api/src/tests/fake-atlassian.ts`
- Test: `apps/api/src/tests/fake-atlassian.test.ts`

**Interfaces:**
- Consumes: `createFakeAtlassian` from Task 1.
- Produces: routing for `POST https://auth.atlassian.com/oauth/token` and `GET https://api.atlassian.com/oauth/token/accessible-resources`. Adds `site.issuedRefreshTokens: string[]` so a test can assert rotation.

Endpoint constants are pinned in `apps/api/src/services/atlassian-oauth.ts:9-10`; the fake must match them exactly.

- [ ] **Step 1: Write the failing test**

```ts
test('a refresh rotates the refresh token, and the old one is then rejected', async () => {
  const site = createFakeAtlassian();

  const first = await site.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: 'test-client',
      client_secret: 'test-secret',
      code: 'the-code',
      redirect_uri: 'https://app.example/integrations/confluence/callback',
    }),
  });
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as { refresh_token: string };

  const second = await site.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: 'test-client',
      client_secret: 'test-secret',
      refresh_token: firstBody.refresh_token,
    }),
  });
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as { refresh_token: string };
  assert.notEqual(secondBody.refresh_token, firstBody.refresh_token);

  const replay = await site.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: 'test-client',
      client_secret: 'test-secret',
      refresh_token: firstBody.refresh_token,
    }),
  });
  assert.equal(replay.status, 403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/api`
Expected: FAIL — the token endpoint is unrouted, so status is 404 not 200.

- [ ] **Step 3: Write minimal implementation**

Route `POST https://auth.atlassian.com/oauth/token`. Parse the JSON body. On `grant_type: 'authorization_code'` mint `{ access_token, refresh_token, expires_in: 3600, scope, token_type: 'Bearer' }`. On `grant_type: 'refresh_token'`, reject with 403 and `{ error: 'invalid_grant' }` unless the presented token is the current one; otherwise mint a new pair and retire the old. Keep a counter so tokens are distinguishable (`access-1`, `refresh-1`, …) and push each refresh token onto `issuedRefreshTokens`. Route `GET https://api.atlassian.com/oauth/token/accessible-resources` to return `[{ id: cloudId, url: siteUrl, name: siteName, scopes: [] }]` for a valid bearer token, 401 otherwise.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/api`
Expected: PASS.

- [ ] **Step 5: Canary the rotation**

In the scratchpad, copy the fake and make the refresh branch return the same refresh token instead of a new one. Re-run. Expected: the `assert.notEqual` fails. Restore. **Do not mutate the working tree** — copy to `%TEMP%` first.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/tests/fake-atlassian.ts apps/api/src/tests/fake-atlassian.test.ts
git commit -m "test(confluence): the fake rotates refresh tokens, and rejects a replay

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Pages, and the 404 that hides both trash and purge

This is the task that matters most. Getting it wrong makes every erasure and reconcile test a lie.

**Files:**
- Modify: `apps/api/src/tests/fake-atlassian.ts`
- Test: `apps/api/src/tests/fake-atlassian.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2.
- Produces: v2 routes `POST pages`, `GET pages/{id}`, `PUT pages/{id}`, `DELETE pages/{id}` (with `?purge=true`), and the v1 route `GET content/{id}?status=trashed`.

Behaviours, taken from the audit §3 and non-negotiable:

| Behaviour | Rule |
|---|---|
| Trash | `DELETE pages/{id}` sets `status: 'trashed'`, returns 204 |
| Purge | `DELETE pages/{id}?purge=true` returns **400** unless already trashed; then sets `status: 'purged'`, returns 204 |
| v2 read | `GET pages/{id}` returns 404 for **both** trashed and purged |
| v1 trashed read | `GET content/{id}?status=trashed` returns 200 for trashed, **404 for purged** |
| Update | `PUT pages/{id}` requires `version.number === current + 1`, else **409** |

- [ ] **Step 1: Write the failing test**

```ts
test('v2 cannot tell a trashed page from a purged one, but v1 can', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1', 'Content-Type': 'application/json' };

  const created = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Safeguarding Policy', status: 'current' }),
  });
  const page = (await created.json()) as { id: string };

  await site.fetch(`${base}/wiki/api/v2/pages/${page.id}`, { method: 'DELETE', headers: auth });

  assert.equal((await site.fetch(`${base}/wiki/api/v2/pages/${page.id}`, { headers: auth })).status, 404);
  assert.equal(
    (await site.fetch(`${base}/wiki/rest/api/content/${page.id}?status=trashed`, { headers: auth })).status,
    200,
  );

  await site.fetch(`${base}/wiki/api/v2/pages/${page.id}?purge=true`, { method: 'DELETE', headers: auth });

  assert.equal((await site.fetch(`${base}/wiki/api/v2/pages/${page.id}`, { headers: auth })).status, 404);
  assert.equal(
    (await site.fetch(`${base}/wiki/rest/api/content/${page.id}?status=trashed`, { headers: auth })).status,
    404,
  );
});

test('a purge of a page that is not yet trashed is refused', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1', 'Content-Type': 'application/json' };

  const created = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Conflicts Policy', status: 'current' }),
  });
  const page = (await created.json()) as { id: string };

  const purge = await site.fetch(`${base}/wiki/api/v2/pages/${page.id}?purge=true`, {
    method: 'DELETE',
    headers: auth,
  });

  assert.equal(purge.status, 400);
  assert.equal(site.getPage(page.id)?.status, 'current');
});

test('an update at the wrong version is a 409 and changes nothing', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1', 'Content-Type': 'application/json' };

  const created = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Original', status: 'current' }),
  });
  const page = (await created.json()) as { id: string };

  const stale = await site.fetch(`${base}/wiki/api/v2/pages/${page.id}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ id: page.id, title: 'Renamed', status: 'current', version: { number: 1 } }),
  });

  assert.equal(stale.status, 409);
  assert.equal(site.getPage(page.id)?.title, 'Original');

  const fresh = await site.fetch(`${base}/wiki/api/v2/pages/${page.id}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ id: page.id, title: 'Renamed', status: 'current', version: { number: 2 } }),
  });

  assert.equal(fresh.status, 200);
  assert.equal(site.getPage(page.id)?.title, 'Renamed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/api`
Expected: FAIL — `POST pages` is unrouted, so the create returns 404 and `page.id` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

Add the five routes. Created pages get `version: 1`, `status: 'current'`, an incrementing id (`'100001'`, `'100002'`, …) and an empty `properties` map. The create response body must carry `id`, `status`, `title`, `spaceId`, `version: { number }` and `_links: { base: siteUrl, webui: '/pages/<id>' }`, because `parsePage` in `confluence-pages.ts` reads all of those. Match the table above exactly — especially that v2 `GET` returns 404 for `trashed` as well as `purged`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/api`
Expected: PASS.

- [ ] **Step 5: Canary the 404 rule**

Copy to the scratchpad and make v2 `GET` return 200 for a trashed page. Re-run. Expected: the first test fails on the `404` assertion. This is the canary that matters most — if it does not fail, the test is asserting nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/tests/fake-atlassian.ts apps/api/src/tests/fake-atlassian.test.ts
git commit -m "test(confluence): the fake hides trash behind a 404, exactly as v2 does

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Spaces and content properties, both paginated

Pagination is modelled deliberately: T2.8 has to fix `findPageByTitle` and `getContentPropertyRecord` taking `results[0]` and never following `_links.next`, and it cannot be proven against a fake that only ever returns one page of results.

**Files:**
- Modify: `apps/api/src/tests/fake-atlassian.ts`
- Test: `apps/api/src/tests/fake-atlassian.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: v2 routes `GET spaces`, `GET pages?title=&spaceId=`, `GET pages/{id}/properties`, `GET pages/{id}/properties/{key}`, `POST pages/{id}/properties`, `PUT pages/{id}/properties/{propertyId}`. All list routes honour a `limit` query parameter (default 25) and emit `_links.next` as a relative URL with a `cursor` when more remain.

- [ ] **Step 1: Write the failing test**

```ts
test('a space listing longer than the limit carries a next link', async () => {
  const site = createFakeAtlassian();
  for (let i = 1; i <= 3; i += 1) {
    site.addSpace({ id: `space-${i}`, key: `KEY${i}`, name: `Space ${i}` });
  }
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1' };

  const first = await site.fetch(`${base}/wiki/api/v2/spaces?limit=2`, { headers: auth });
  const firstBody = (await first.json()) as { results: unknown[]; _links: { next?: string } };
  assert.equal(firstBody.results.length, 2);
  assert.ok(firstBody._links.next, 'a truncated listing must offer a next link');

  const second = await site.fetch(`${base}${firstBody._links.next}`, { headers: auth });
  const secondBody = (await second.json()) as { results: unknown[]; _links: { next?: string } };
  assert.equal(secondBody.results.length, 1);
  assert.equal(secondBody._links.next, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/api`
Expected: FAIL — `GET spaces` is unrouted; `first.json()` has no `results`.

- [ ] **Step 3: Write minimal implementation**

Add the routes. A cursor is the index of the next item, encoded as a plain decimal string. The `next` link must be relative and prefixed `/wiki/api/v2/...` so the test's `${base}${next}` concatenation resolves, which is also how Atlassian returns it. Space entries carry `id`, `key`, `name`, `type: 'global'`, `status: 'current'`. Content-property routes read and write the page's `properties` map and enforce the same `version.number = current + 1` rule as pages.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tests/fake-atlassian.ts apps/api/src/tests/fake-atlassian.test.ts
git commit -m "test(confluence): spaces and properties, paginated so the next link can be proven

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Rate limiting a test can switch on

The audit's B4 and the shared 65 000-point hourly pool mean the reconcile job has to abort a whole run on a 429 and stop claiming on `X-RateLimit-NearLimit`. Neither is testable without a fake that can produce them on demand.

**Files:**
- Modify: `apps/api/src/tests/fake-atlassian.ts`
- Test: `apps/api/src/tests/fake-atlassian.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: `site.rateLimit(spec: { after?: number; retryAfterSeconds?: number; nearLimit?: boolean }): void`. With `after: n`, the next `n` requests succeed and every one after that returns 429 with a `Retry-After` header. With `nearLimit: true`, successful responses carry `X-RateLimit-NearLimit: true`.

- [ ] **Step 1: Write the failing test**

```ts
test('rate limiting starts after the configured number of requests', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1' };

  site.rateLimit({ after: 1, retryAfterSeconds: 90 });

  assert.equal((await site.fetch(`${base}/wiki/api/v2/spaces`, { headers: auth })).status, 200);

  const limited = await site.fetch(`${base}/wiki/api/v2/spaces`, { headers: auth });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '90');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/api`
Expected: FAIL — `site.rateLimit is not a function`.

- [ ] **Step 3: Write minimal implementation**

Hold the spec on the fake. Count requests from the moment `rateLimit` is called. Once the budget is spent, short-circuit before routing and return 429 with `Retry-After` (default `60`). When `nearLimit` is set, add `X-RateLimit-NearLimit: true` to successful responses.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tests/fake-atlassian.ts apps/api/src/tests/fake-atlassian.test.ts
git commit -m "test(confluence): the fake can run out of rate-limit budget on cue

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Drive the real client against the fake

Until this task the fake is only tested against itself. This is the task that proves production code can use it, and it is the acceptance test for the whole plan.

**Files:**
- Create: `apps/api/src/tests/confluence-round-trip.test.ts`

**Interfaces:**
- Consumes: `createFakeAtlassian` (Tasks 1-5); `createConfluenceClient` from `../services/confluence-client.js`; `createPage`, `getPage`, `deletePage`, `purgePage`, `setContentProperty`, `getContentProperty` from `../services/confluence-pages.js`; `listSpaces` from `../services/confluence-spaces.js`.
- Produces: nothing; it is a leaf test.

Read `apps/api/src/tests/confluence-client.test.ts:40-60` for the existing harness shape before writing this — the client is constructed with `{ fetch }` in `ConfluenceClientDeps` and a token getter.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeAtlassian } from './fake-atlassian.js';
import { createConfluenceClient } from '../services/confluence-client.js';
import { createPage, getPage, deletePage, purgePage } from '../services/confluence-pages.js';
import { listSpaces } from '../services/confluence-spaces.js';

function clientFor(site: ReturnType<typeof createFakeAtlassian>) {
  return createConfluenceClient(
    { cloudId: site.cloudId, getAccessToken: async () => 'access-1' },
    { fetch: site.fetch },
  );
}

test('the real client publishes, reads back and then erases a page on the fake', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const client = clientFor(site);

  const spaces = await listSpaces(client);
  assert.deepEqual(
    spaces.spaces.map((space) => space.key),
    ['GOV'],
  );

  const page = await createPage(client, {
    spaceId: 'space-1',
    title: 'Safeguarding Policy',
    bodyStorage: '<p>Managed by CharityPilot.</p>',
  });
  assert.ok(page.id);

  const readBack = await getPage(client, page.id);
  assert.equal(readBack?.title, 'Safeguarding Policy');

  await deletePage(client, page.id);
  assert.equal(await getPage(client, page.id), null, 'a trashed page reads as absent through v2');

  await purgePage(client, page.id);
  assert.equal(site.getPage(page.id)?.status, 'purged');
});
```

The signatures, already read, so you do not have to guess:

```ts
createConfluenceClient(
  opts: { cloudId: string; getAccessToken: () => Promise<string> },
  deps: ConfluenceClientDeps = {},
): ConfluenceClient                                   // confluence-client.ts:571

createPage(client, input: CreatePageInput): Promise<ConfluencePage>   // confluence-pages.ts:276
//   CreatePageInput = { spaceId, title, bodyStorage, parentId? }
//   NOTE: the field is `bodyStorage`, not `body`. The client wraps it as
//   { body: { representation: 'storage', value: bodyStorage } }.
getPage(client, pageId): Promise<ConfluencePage | null>               // :311
deletePage(client, pageId): Promise<void>                             // :563
purgePage(client, pageId): Promise<void>                              // :592
listSpaces(client, cursor?): Promise<ListSpacesResult>                // confluence-spaces.ts:151
//   ListSpacesResult = { spaces: ConfluenceSpace[]; nextCursor?: string }
```

**`listSpaces` already walks `_links.next` itself**, bounded by `MAX_LIST_PAGES`, sending `limit=250`. So this test exercises the fake's pagination whether or not the list is long. The audit's T2.8 "never follows `_links.next`" finding applies to `findPageByTitle` and `getContentPropertyRecord`, **not** to `listSpaces` — do not "fix" `listSpaces`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/api`
Expected: FAIL — the fake's response bodies will not satisfy the real parsers on the first attempt.

- [ ] **Step 3: Fix the fake until the real parsers accept it**

Every mismatch found here is a fidelity bug in **the fake**, not in the test, and not in production code. `parsePage` (`confluence-pages.ts:251`) reads `id`, `status`, `title`, `spaceId`, `version.number` and `_links`; `readWebUrl` joins `_links.webui` onto `_links.base`. If a parser rejects a response, make the fake's response look like Atlassian's.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/api`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test --workspace apps/api`
Expected: PASS, with no pre-existing test broken. If anything else fails, it was already failing — confirm with `git stash` before blaming this plan.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/tests/confluence-round-trip.test.ts apps/api/src/tests/fake-atlassian.ts
git commit -m "test(confluence): drive the real client through publish, read-back and erasure

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Correct the stale audit rows

The audit is the authority for the remaining work, so a stale row in it becomes a wasted task later.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-20-confluence-connector-audit.md`

- [ ] **Step 1: Correct C4**

C4 claims `env.INTEGRATION_ENCRYPTION_KEY` is missing from the pino redaction list. **It is present** (`apps/api/src/utils/logger.ts`), added in commit `0890f07` on 2026-09-20 and pinned by `observability-reliability.test.ts:406`. Mark C4 closed, naming the commit and the test.

- [ ] **Step 2: Correct the T1.3 site-binding claim**

§T1.3 states the owner action — creating the Atlassian app with a resource-level grant — "was taken". **It was not.** No `ATLASSIAN_CLIENT_ID` exists in `apps/api/.env`, `.env`, any `compose*.yml`, or `D:\CharityPilot-VM\secrets\`. Correct it, and add a line recording the consequence: the shipped `CONFLUENCE_MULTIPLE_SITES` refusal assumes a resource-level grant, so if the app is later created account-level, that refusal blocks a real multi-site administrator with no picker to fall back on.

- [ ] **Step 3: Record T2.9's new location**

Note that the fake Atlassian lives at `apps/api/src/tests/fake-atlassian.ts`, not `e2e/helpers/`, and why.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-20-confluence-connector-audit.md
git commit -m "docs(confluence): two audit rows had gone stale, and the fake moved

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## What Phase A deliberately does not do

- **No Playwright spec.** The audit's T2.9 also asks for a browser spec for `/integrations`. It needs a running stack and belongs with T2.5's UI work, not with the test double. Carry it into the phase that builds the surface it would exercise.
- **No production code change**, other than none at all. If a task appears to need one, stop: it means the fake is wrong, or a real defect has been found that deserves its own commit and its own reasoning.
