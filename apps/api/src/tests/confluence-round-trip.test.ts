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

test('only the v1 trashed read separates a restorable page from one that is gone', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const client = clientFor(site);

  const page = await createPage(client, {
    spaceId: 'space-1',
    title: 'Conflict of Interest Policy',
    bodyStorage: '<p>Managed by CharityPilot.</p>',
  });

  // A live page is invisible to this endpoint. It is filtered to trashed
  // content, so `null` here is not an existence answer — the reconciler is
  // only ever entitled to read it as "gone" because v2 has already 404ed.
  assert.equal(
    await getTrashedPage(client, page.id),
    null,
    'a current page must not be reported as trashed',
  );
  assert.notEqual(await getPage(client, page.id), null, 'and it is plainly still there through v2');

  await deletePage(client, page.id);

  // The whole point. Both reads are 404 through v2; only v1 tells them apart.
  assert.equal(await getPage(client, page.id), null, 'v2 cannot see a trashed page');
  const trashed = await getTrashedPage(client, page.id);
  assert.equal(trashed?.id, page.id, 'v1 finds it in the trash — restorable, not gone');
  assert.equal(trashed?.title, 'Conflict of Interest Policy');
  assert.equal(trashed?.version, 1, 'the version survives the trip to the trash');
  assert.equal(trashed?.spaceId, 'space-1', 'v1 nests the space; the parse must still find it');

  await purgePage(client, page.id);

  assert.equal(await getPage(client, page.id), null, 'v2 answers the same 404 as before');
  assert.equal(
    await getTrashedPage(client, page.id),
    null,
    'and now v1 agrees it is gone — this difference is the only signal there is',
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
