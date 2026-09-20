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
