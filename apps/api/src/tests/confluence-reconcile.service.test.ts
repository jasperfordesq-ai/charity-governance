import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  createConfluenceReconciler,
  type ConfluenceReconcileOperations,
  type ReconcilablePublication,
} from '../services/confluence-reconcile.service.js';
import type { ConfluenceClient } from '../services/confluence-client.js';
import type { ConfluencePage } from '../services/confluence-pages.js';
import { AppError } from '../utils/app-error.js';

const SITE_ID = 'site-1';
const CLIENT = {} as ConfluenceClient;

function page(overrides: Partial<ConfluencePage> = {}): ConfluencePage {
  return {
    id: 'page-1',
    title: 'Safeguarding Policy',
    spaceId: 'space-1',
    version: 4,
    webUrl: 'https://example.atlassian.net/wiki/pages/page-1',
    ...overrides,
  };
}

function rows(...pageIds: Array<string | null>): ReconcilablePublication[] {
  return pageIds.map((pageId, index) => ({
    id: `pub-${index + 1}`,
    organisationId: 'org-1',
    pageId,
    remoteState: null,
  }));
}

/** 401 and 403 reach the reconciler as the SAME code, separated only by `details.status`. */
function upstream(status: number): AppError {
  return new AppError(409, 'CONFLUENCE_RECONNECT_REQUIRED', `status ${status}`, { status });
}

function rateLimited(): AppError {
  return new AppError(429, 'CONFLUENCE_RATE_LIMITED', 'slow down', { status: 429 });
}

type Harness = {
  tokenCalls: number;
  pageReads: string[];
  trashedReads: string[];
  reconcile: ReturnType<typeof createConfluenceReconciler>;
};

function harness(operations: Partial<ConfluenceReconcileOperations> = {}, sites = [SITE_ID]): Harness {
  const state = { tokenCalls: 0, pageReads: [] as string[], trashedReads: [] as string[] };

  // The recording wraps the behaviour rather than being part of a default that
  // an override replaces. Spreading `{ ...base, ...overrides }` looked
  // equivalent and was not: an override of `getPage` silently took the counter
  // with it, so four tests asserted call counts that nothing was incrementing
  // and read a genuine `0` as a passing `0`.
  const getPageImpl = operations.getPage ?? (async (_client, pageId) => page({ id: pageId }));
  const getTrashedImpl = operations.getTrashedPage ?? (async () => null);
  const listSitesImpl =
    operations.listAccessibleResources ??
    (async () => sites.map((id) => ({ id, url: `https://${id}.atlassian.net`, name: id })));

  const wrapped: ConfluenceReconcileOperations = {
    async getPage(client, pageId) {
      // Recorded BEFORE the call, so a throwing implementation still counts as
      // an attempt — which is exactly what the abort tests are asserting about.
      state.pageReads.push(pageId);
      return getPageImpl(client, pageId);
    },
    async getTrashedPage(client, pageId) {
      state.trashedReads.push(pageId);
      return getTrashedImpl(client, pageId);
    },
    listAccessibleResources: listSitesImpl,
  };

  const reconcile = createConfluenceReconciler({
    // The token seam. Counting calls here is the whole point of the dormancy
    // canary: the reconciler must not reach this for a tenant with no work.
    connect: async () => {
      state.tokenCalls += 1;
      return { client: CLIENT, accessToken: 'access-1' };
    },
    operations: wrapped,
  });

  return {
    get tokenCalls() {
      return state.tokenCalls;
    },
    get pageReads() {
      return state.pageReads;
    },
    get trashedReads() {
      return state.trashedReads;
    },
    reconcile,
  };
}

const TENANT = { organisationId: 'org-1', integrationId: 'int-1', siteId: SITE_ID };

// ---------------------------------------------------------------------------
// The two canaries for the DPO's 2026-09-20 ruling.
//
// The design this replaced merged the keepalive into this job: every six-hourly
// visit rotated every connected tenant's refresh token, including tenants with
// nothing to reconcile, and its test list pinned exactly that ("a tenant with
// zero pages still obtains a token"). The ruling refused it. These two tests
// are what stop it coming back.
// ---------------------------------------------------------------------------

test('a tenant with nothing to reconcile has NO token taken for it', async () => {
  const h = harness();

  const result = await h.reconcile({ tenant: TENANT, publications: [] });

  // The load-bearing assertion. A test that only checked `pageReads` would pass
  // while the token was still being rotated on every visit — which IS the
  // keepalive, and is the thing that was ruled against.
  assert.equal(h.tokenCalls, 0, 'a dormant tenant must not have its authorisation refreshed');
  assert.deepEqual(h.pageReads, []);
  assert.equal(result.outcome, 'OK');
  assert.deepEqual(result.readings, []);
  assert.equal(result.abortRun, false);
});

test('a tenant whose only rows have no page id still has no token taken for it', async () => {
  const h = harness();

  // The claim excludes null-`pageId` rows, but the reconciler must not depend
  // on that: if the claim ever loosened, this shape would otherwise start
  // minting a token to read nothing.
  const result = await h.reconcile({ tenant: TENANT, publications: rows(null, null) });

  assert.deepEqual(h.pageReads, [], 'there is nothing to read');
  assert.equal(result.outcome, 'OK');
  assert.deepEqual(result.readings, [], 'and nothing to record');
});

test('a tenant with real work DOES have a token taken, exactly once', async () => {
  const h = harness();

  await h.reconcile({ tenant: TENANT, publications: rows('page-1', 'page-2', 'page-3') });

  // The by-product the ruling permits: one token, for a visit that did work.
  assert.equal(h.tokenCalls, 1, 'one token per visiting tenant, not one per page');
  assert.deepEqual(h.pageReads, ['page-1', 'page-2', 'page-3']);
});

// ---------------------------------------------------------------------------
// Remote states
// ---------------------------------------------------------------------------

test('a readable page is VISIBLE, with its version and title', async () => {
  const h = harness({
    async getPage() {
      return page({ id: 'page-1', title: 'Conflict of Interest Policy', version: 7 });
    },
  });

  const result = await h.reconcile({ tenant: TENANT, publications: rows('page-1') });

  assert.equal(result.outcome, 'OK');
  assert.deepEqual(result.readings, [
    {
      publicationId: 'pub-1',
      reading: {
        state: 'VISIBLE',
        determinate: true,
        version: 7,
        title: 'Conflict of Interest Policy',
        errorCode: null,
      },
    },
  ]);
});

test('current-page miss then found in v2 trash is TRASHED, not deleted', async () => {
  const h = harness({
    async getPage() {
      return null;
    },
    async getTrashedPage() {
      return page({ id: 'page-1', title: 'Retired Policy', version: 2 });
    },
  });

  const result = await h.reconcile({ tenant: TENANT, publications: rows('page-1') });

  assert.equal(result.readings[0].reading.state, 'TRASHED');
  assert.equal(result.readings[0].reading.determinate, true);
  assert.equal(result.readings[0].reading.version, 2, 'the version survives the trip to the trash');
});

test('current-page miss and v2 trash miss is GONE', async () => {
  const h = harness({
    async getPage() {
      return null;
    },
    async getTrashedPage() {
      return null;
    },
  });

  const result = await h.reconcile({ tenant: TENANT, publications: rows('page-1') });

  assert.equal(result.readings[0].reading.state, 'GONE');
  assert.deepEqual(h.trashedReads, ['page-1'], 'the second read is what makes GONE distinguishable');
});

test('the trashed read is only made when v2 says the page is absent', async () => {
  const h = harness();

  await h.reconcile({ tenant: TENANT, publications: rows('page-1') });

  // Spending a second request on a page that plainly exists would double this
  // job's cost against a shared rate-limit pool for no information.
  assert.deepEqual(h.trashedReads, []);
});

test('a v2 archived page is ARCHIVED rather than VISIBLE', async () => {
  const h = harness({ async getPage() { return page({ id: 'page-1', status: 'archived' }); } });
  const result = await h.reconcile({ tenant: TENANT, publications: rows('page-1') });
  assert.equal(result.readings[0].reading.state, 'ARCHIVED');
  assert.deepEqual(h.trashedReads, []);
});

test('an unexpected v2 page status is UNKNOWN rather than VISIBLE', async () => {
  const h = harness({ async getPage() { return page({ id: 'page-1', status: 'draft' }); } });
  const result = await h.reconcile({ tenant: TENANT, publications: rows('page-1') });
  assert.equal(result.readings[0].reading.state, 'UNKNOWN');
  assert.equal(result.readings[0].reading.determinate, false);
});

// ---------------------------------------------------------------------------
// Failures. 401 and 403 arrive as the same error code and must not be conflated.
// ---------------------------------------------------------------------------

test('403 on a later page marks that row UNKNOWN and keeps going', async () => {
  const h = harness({
    async getPage(_client, pageId) {
      if (pageId === 'page-2') throw upstream(403);
      return page({ id: pageId });
    },
  });

  const result = await h.reconcile({ tenant: TENANT, publications: rows('page-1', 'page-2', 'page-3') });

  assert.equal(result.outcome, 'OK', 'one unreadable page is not a broken tenant');
  assert.deepEqual(
    result.readings.map((entry) => [entry.publicationId, entry.reading.state]),
    [
      ['pub-1', 'VISIBLE'],
      ['pub-2', 'UNKNOWN'],
      ['pub-3', 'VISIBLE'],
    ],
  );
  assert.equal(result.readings[1].reading.determinate, false, 'UNKNOWN must not move the determinate clock');
  assert.equal(result.readings[1].reading.errorCode, 'CONFLUENCE_PAGE_FORBIDDEN');
});

test('403 on the FIRST page abandons the tenant as FORBIDDEN', async () => {
  const h = harness({
    async getPage() {
      throw upstream(403);
    },
  });

  const result = await h.reconcile({ tenant: TENANT, publications: rows('page-1', 'page-2', 'page-3') });

  assert.equal(result.outcome, 'FORBIDDEN');
  // The grant reaches the site but not its content, which will be true of every
  // page. Reading the rest spends the shared pool to learn the same thing N
  // times.
  assert.equal(h.pageReads.length, 1, 'the remaining pages must not be attempted');
  assert.deepEqual(result.readings, []);
  assert.equal(result.abortRun, false, 'one tenant being locked out is not the whole estate');
});

test('401 abandons the tenant as RECONNECT_REQUIRED, not FORBIDDEN', async () => {
  const h = harness({
    async getPage(_client, pageId) {
      if (pageId === 'page-2') throw upstream(401);
      return page({ id: pageId });
    },
  });

  const result = await h.reconcile({ tenant: TENANT, publications: rows('page-1', 'page-2', 'page-3') });

  // Both arrive as CONFLUENCE_RECONNECT_REQUIRED; only `details.status` tells
  // them apart, and they mean opposite things — a dead grant versus one page's
  // permissions.
  assert.equal(result.outcome, 'RECONNECT_REQUIRED');
  assert.equal(h.pageReads.length, 2, 'nothing after the dead grant is attempted');
  assert.equal(result.readings.length, 1, 'the page read before it is still recorded');
});

test('a rate limit aborts the whole run and keeps the readings taken so far', async () => {
  const h = harness({
    async getPage(_client, pageId) {
      if (pageId === 'page-3') throw rateLimited();
      return page({ id: pageId });
    },
  });

  const result = await h.reconcile({
    tenant: TENANT,
    publications: rows('page-1', 'page-2', 'page-3', 'page-4'),
  });

  assert.equal(result.outcome, 'RATE_LIMITED');
  // The points pool is shared across every tenant of the app, so moving to the
  // next charity spends the same exhausted budget.
  assert.equal(result.abortRun, true);
  assert.equal(result.readings.length, 2, 'work already done is not thrown away');
  assert.equal(h.pageReads.length, 3, 'and nothing past the limit is attempted');
});

test('a site the grant no longer reaches reads no pages at all', async () => {
  const h = harness({}, ['some-other-site']);

  const result = await h.reconcile({ tenant: TENANT, publications: rows('page-1', 'page-2') });

  assert.equal(result.outcome, 'SITE_NOT_ACCESSIBLE');
  // Every page would 404, which is indistinguishable from every page having
  // been purged — and that difference is this job's entire output.
  assert.deepEqual(h.pageReads, [], 'a 404 must never be recorded as GONE on an unreachable site');
  assert.deepEqual(result.readings, []);
});

test('a tenant bound to no site is not visited', async () => {
  const h = harness();

  const result = await h.reconcile({
    tenant: { ...TENANT, siteId: null },
    publications: rows('page-1'),
  });

  assert.equal(result.outcome, 'SITE_NOT_ACCESSIBLE');
  assert.equal(h.tokenCalls, 0, 'there is nowhere to connect to');
});

test('a rate limit while probing the site aborts the run', async () => {
  const h = harness({
    async listAccessibleResources() {
      throw rateLimited();
    },
  });

  const result = await h.reconcile({ tenant: TENANT, publications: rows('page-1') });

  assert.equal(result.outcome, 'RATE_LIMITED');
  assert.equal(result.abortRun, true);
});

test('an unrecognised failure propagates rather than being recorded as a state', async () => {
  const h = harness({
    async getPage() {
      throw new AppError(502, 'CONFLUENCE_REQUEST_FAILED', 'Atlassian is down', { status: 502 });
    },
  });

  // Swallowing this would write GONE or UNKNOWN against a page nobody actually
  // failed to find, which is worse than the run failing visibly.
  await assert.rejects(
    () => h.reconcile({ tenant: TENANT, publications: rows('page-1') }),
    /Atlassian is down/,
  );
});

// ---------------------------------------------------------------------------
// Both entry points must register the reconciler.
//
// Pinned separately, for the reason the publisher's pins give: a single test
// covering both goes red either way without saying which deployment is dead.
// Read from source — importing either file would open a Prisma connection and
// run the job.
// ---------------------------------------------------------------------------

function jobSource(file: string): string {
  return readFileSync(join(process.cwd(), 'src', 'jobs', file), 'utf8');
}

test('production-scheduler.ts builds and schedules the reconciler', () => {
  const source = jobSource('production-scheduler.ts');
  assert.match(
    source,
    /createConfluenceReconciler\(\{\s*prisma\s*\}\)/,
    'the in-process scheduler is the entry point that runs in production; without this ' +
      'registration no mirror is ever re-read there',
  );
  assert.match(
    source,
    /startRecurringJob\(\{[\s\S]*?name: 'Document reconcile'/,
    'building a reconciler and never scheduling it reconciles nothing',
  );
});

test('reconcile-document-mirrors.ts builds and runs the reconciler', () => {
  const source = jobSource('reconcile-document-mirrors.ts');
  assert.match(source, /createConfluenceReconciler\(\{\s*prisma\s*\}\)/);
  assert.match(
    source,
    /runDocumentReconcile\(\{/,
    'the standalone job exists for cron deployments; building a reconciler it never runs ' +
      'leaves those deployments silently unreconciled',
  );
});

test('the reconcile job is in the shutdown list', () => {
  // A recurring job missing from the shutdown list keeps running through a
  // graceful stop and can be mid-request when the process is killed.
  assert.match(jobSource('production-scheduler.ts'), /documentReconcileJob,/);
});
