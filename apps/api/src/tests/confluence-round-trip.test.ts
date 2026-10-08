import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeAtlassian } from './fake-atlassian.js';
import { createConfluenceClient } from '../services/confluence-client.js';
import { createPage, getPage, getTrashedPage, deletePage, purgePage } from '../services/confluence-pages.js';
import { listSpaces } from '../services/confluence-spaces.js';
import { createConfluenceEraser } from '../services/confluence-erasure.js';
import { AppError } from '../utils/errors.js';

function clientFor(site: ReturnType<typeof createFakeAtlassian>) {
  return createConfluenceClient(
    { cloudId: site.cloudId, getAccessToken: async () => 'access-1' },
    { fetch: site.fetch },
  );
}

test('the real client publishes, reads back and then erases a page on the fake', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  // 250 more, for 251 total: one more than a single v2 page (limit=250), so
  // listSpaces' internal cursor walk actually has to follow `_links.next`
  // instead of returning after the first request.
  const extraKeys: string[] = [];
  for (let i = 0; i < 250; i += 1) {
    const key = `SP${i}`;
    extraKeys.push(key);
    site.addSpace({ id: `space-extra-${i}`, key, name: `Extra ${i}` });
  }
  const client = clientFor(site);

  const spaces = await listSpaces(client);
  const spaceCalls = site.calls.filter((call) => call.url.includes('/wiki/api/v2/spaces'));
  assert.equal(spaceCalls.length, 2, 'a 251st space must force a second /spaces request');
  assert.ok(spaceCalls[1].url.includes('cursor=250'), 'the second request must resume where the first left off');
  assert.equal(spaces.spaces.length, 251, 'every space across both pages must come back');
  assert.deepEqual(
    new Set(spaces.spaces.map((space) => space.key)),
    new Set(['GOV', ...extraKeys]),
  );
  assert.equal(spaces.nextCursor, undefined, 'the walk must exhaust the fake, not stop mid-way');

  const page = await createPage(client, {
    spaceId: 'space-1',
    title: 'Safeguarding Policy',
    bodyStorage: '<p>Managed by CharityPilot.</p>',
  });
  assert.ok(page.id);
  assert.equal(page.spaceId, 'space-1');
  assert.equal(page.version, 1);
  // Real Confluence Cloud bases web links at `…/wiki` and shapes the webui
  // path as `/spaces/{spaceKey}/pages/{pageId}/{Title+With+Pluses}`, not the
  // bare site URL plus `/pages/{id}` the fake used to answer with.
  assert.equal(
    page.webUrl,
    `https://example.atlassian.net/wiki/spaces/GOV/pages/${page.id}/Safeguarding+Policy`,
  );

  const readBack = await getPage(client, page.id);
  assert.equal(readBack?.title, 'Safeguarding Policy');
  assert.equal(readBack?.spaceId, 'space-1');
  assert.equal(readBack?.version, 1);
  assert.equal(
    readBack?.webUrl,
    `https://example.atlassian.net/wiki/spaces/GOV/pages/${page.id}/Safeguarding+Policy`,
  );

  await deletePage(client, page.id);
  assert.equal(await getPage(client, page.id), null, 'a trashed page reads as absent through v2');

  await purgePage(client, page.id);
  assert.equal(site.getPage(page.id)?.status, 'purged');
});

test('v2 status-filtered read separates a restorable page from one that is gone', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const client = clientFor(site);

  const page = await createPage(client, {
    spaceId: 'space-1',
    title: 'Conflict of Interest Policy',
    bodyStorage: '<p>Managed by CharityPilot.</p>',
  });

  // A live page is invisible to the trash-filtered endpoint. The reconciler
  // first checks the normal read before interpreting null here as gone.
  assert.equal(
    await getTrashedPage(client, page.id),
    null,
    'a current page must not be reported as trashed',
  );
  assert.notEqual(await getPage(client, page.id), null, 'and it is plainly still there through v2');

  await deletePage(client, page.id);

  // The normal v2 read can return 200 with status=trashed; getPage excludes it.
  assert.equal(await getPage(client, page.id), null, 'a trashed page is not current');
  const trashed = await getTrashedPage(client, page.id);
  assert.equal(trashed?.id, page.id, 'v2 finds it in the trash — restorable, not gone');
  assert.equal(trashed?.title, 'Conflict of Interest Policy');
  assert.equal(trashed?.version, 1, 'the version survives the trip to the trash');
  assert.equal(trashed?.spaceId, 'space-1');

  await purgePage(client, page.id);

  assert.equal(await getPage(client, page.id), null, 'purged page is absent');
  assert.equal(
    await getTrashedPage(client, page.id),
    null,
    'the trash-filtered v2 read now agrees it is gone',
  );
});

test('eraser cannot complete when the fake provider leaves a page in trash', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const client = clientFor(site);
  const page = await createPage(client, {
    spaceId: 'space-1', title: 'Disposable policy', bodyStorage: '<p>test</p>',
  });
  const eraser = createConfluenceEraser({
    connect: async () => client,
    operations: { purgePage: async () => undefined },
  });
  await assert.rejects(() => eraser({
    organisationId: 'org-1', storagePath: 'org-1/test',
    targetRef: { kind: 'confluence', cloudId: site.cloudId, pageId: page.id, attachmentIds: [] },
  }), (error: unknown) => (error as AppError).code === 'CONFLUENCE_ERASURE_UNVERIFIED');
  assert.equal(site.getPage(page.id)?.status, 'trashed');
});

test('eraser refuses an already trashed page before any destructive request', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const client = clientFor(site);
  const page = await createPage(client, {
    spaceId: 'space-1', title: 'Synthetic formerly published page', bodyStorage: '<p>test</p>',
  });
  await deletePage(client, page.id);
  const before = site.calls.length;
  const eraser = createConfluenceEraser({ connect: async () => client });
  await assert.rejects(() => eraser({
    organisationId: 'org-1', storagePath: 'org-1/test',
    targetRef: { kind: 'confluence', cloudId: site.cloudId, pageId: page.id, attachmentIds: [] },
  }), (error: unknown) => (error as AppError).code === 'CONFLUENCE_ERASURE_TRASH_INVENTORY_UNAVAILABLE');
  assert.equal(site.calls.slice(before).some((call) => call.method === 'DELETE'), false);
  assert.equal(site.getPage(page.id)?.status, 'trashed');
});
