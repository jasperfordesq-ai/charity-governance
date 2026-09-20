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
