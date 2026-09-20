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
