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
  assert.equal(page.webUrl, `https://example.atlassian.net/pages/${page.id}`);

  const readBack = await getPage(client, page.id);
  assert.equal(readBack?.title, 'Safeguarding Policy');
  assert.equal(readBack?.spaceId, 'space-1');
  assert.equal(readBack?.version, 1);
  assert.equal(readBack?.webUrl, `https://example.atlassian.net/pages/${page.id}`);

  await deletePage(client, page.id);
  assert.equal(await getPage(client, page.id), null, 'a trashed page reads as absent through v2');

  await purgePage(client, page.id);
  assert.equal(site.getPage(page.id)?.status, 'purged');
});
