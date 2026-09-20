import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

// --- Fix round 1 -------------------------------------------------------

test('nearLimit alone never starts refusing requests, and tags successes', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1' };

  site.rateLimit({ nearLimit: true });

  const first = await site.fetch(`${base}/wiki/api/v2/spaces`, { headers: auth });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-RateLimit-NearLimit'), 'true');

  // A second (and third) request must still succeed: nearLimit alone carries
  // no budget, so nothing should ever start refusing.
  const second = await site.fetch(`${base}/wiki/api/v2/spaces`, { headers: auth });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('X-RateLimit-NearLimit'), 'true');
});

test('Ruling B: content routes reject a missing or malformed bearer, accept any other, and honour revocation', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;

  const missing = await site.fetch(`${base}/wiki/api/v2/spaces`);
  assert.equal(missing.status, 401);

  const malformed = await site.fetch(`${base}/wiki/api/v2/spaces`, {
    headers: { Authorization: 'Token not-a-bearer-token' },
  });
  assert.equal(malformed.status, 401);

  const empty = await site.fetch(`${base}/wiki/api/v2/spaces`, { headers: { Authorization: 'Bearer ' } });
  assert.equal(empty.status, 401);

  // An arbitrary token that was never issued by the OAuth endpoints is still
  // accepted here — the production client's token comes from the vault, not
  // from an exchange the test performed (Ruling B).
  const token = 'whatever-the-vault-handed-back';
  const accepted = await site.fetch(`${base}/wiki/api/v2/spaces`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(accepted.status, 200);

  site.revokeAccessToken(token);
  const revoked = await site.fetch(`${base}/wiki/api/v2/spaces`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(revoked.status, 401);
});

test('content properties round-trip: create, list, filter by key, get by id, and update', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1', 'Content-Type': 'application/json' };

  const created = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Policy With Metadata' }),
  });
  const page = (await created.json()) as { id: string };

  const createdProperty = await site.fetch(`${base}/wiki/api/v2/pages/${page.id}/properties`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ key: 'approval-date', value: '2026-01-01' }),
  });
  assert.equal(createdProperty.status, 200);
  const propertyBody = (await createdProperty.json()) as {
    id: string;
    key: string;
    value: unknown;
    version: { number: number };
  };
  assert.equal(propertyBody.key, 'approval-date');
  assert.equal(propertyBody.value, '2026-01-01');
  assert.equal(propertyBody.version.number, 1);

  // A duplicate create is an upstream conflict, not a validation error.
  const duplicate = await site.fetch(`${base}/wiki/api/v2/pages/${page.id}/properties`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ key: 'approval-date', value: 'anything' }),
  });
  assert.equal(duplicate.status, 409);

  const byId = await site.fetch(`${base}/wiki/api/v2/pages/${page.id}/properties/${propertyBody.id}`, {
    headers: auth,
  });
  assert.equal(byId.status, 200);
  const byIdBody = (await byId.json()) as { key: string };
  assert.equal(byIdBody.key, 'approval-date');

  const listed = await site.fetch(`${base}/wiki/api/v2/pages/${page.id}/properties?key=approval-date`, {
    headers: auth,
  });
  const listedBody = (await listed.json()) as { results: { key: string }[] };
  assert.equal(listedBody.results.length, 1);
  assert.equal(listedBody.results[0]?.key, 'approval-date');

  const noMatch = await site.fetch(`${base}/wiki/api/v2/pages/${page.id}/properties?key=nonexistent`, {
    headers: auth,
  });
  const noMatchBody = (await noMatch.json()) as { results: unknown[] };
  assert.equal(noMatchBody.results.length, 0);

  const staleUpdate = await site.fetch(`${base}/wiki/api/v2/pages/${page.id}/properties/${propertyBody.id}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ key: 'approval-date', value: 'stale-write', version: { number: 1 } }),
  });
  assert.equal(staleUpdate.status, 409);

  const freshUpdate = await site.fetch(`${base}/wiki/api/v2/pages/${page.id}/properties/${propertyBody.id}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ key: 'approval-date', value: '2026-02-01', version: { number: 2 } }),
  });
  assert.equal(freshUpdate.status, 200);
  const freshBody = (await freshUpdate.json()) as { value: unknown; version: { number: number } };
  assert.equal(freshBody.value, '2026-02-01');
  assert.equal(freshBody.version.number, 2);
});

test('a findPageByTitle-shaped query resolves via the hyphenated space-id', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  site.addSpace({ id: 'space-2', key: 'OTHER', name: 'Other' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1', 'Content-Type': 'application/json' };

  await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Safeguarding Policy' }),
  });
  await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-2', title: 'Safeguarding Policy' }),
  });

  // Production's findPageByTitle sends the space id under the hyphenated
  // key, never `spaceId` — see confluence-pages.ts:498.
  const query = new URLSearchParams({ title: 'Safeguarding Policy', 'space-id': 'space-1' });
  const found = await site.fetch(`${base}/wiki/api/v2/pages?${query.toString()}`, { headers: auth });
  const foundBody = (await found.json()) as { results: { spaceId: string }[] };

  assert.equal(foundBody.results.length, 1);
  assert.equal(foundBody.results[0]?.spaceId, 'space-1');
});

test('v1 content returns v1\'s own body shape, not v2\'s', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1', 'Content-Type': 'application/json' };

  const created = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Safeguarding Policy' }),
  });
  const page = (await created.json()) as { id: string };

  await site.fetch(`${base}/wiki/api/v2/pages/${page.id}`, { method: 'DELETE', headers: auth });

  const trashed = await site.fetch(`${base}/wiki/rest/api/content/${page.id}?status=trashed`, { headers: auth });
  const trashedBody = (await trashed.json()) as Record<string, unknown>;

  assert.equal(trashedBody.type, 'page');
  assert.equal(trashedBody.status, 'trashed');
  assert.deepEqual(trashedBody.space, { id: 'space-1', key: 'GOV' });
  assert.equal((trashedBody as { spaceId?: unknown }).spaceId, undefined);
});

// --- Final fix wave (whole-phase review) --------------------------------

test('a second create with the same title in the same space is a 409, matching Confluence per-space title uniqueness', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1', 'Content-Type': 'application/json' };

  const first = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Safeguarding Policy' }),
  });
  assert.equal(first.status, 200);

  const second = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Safeguarding Policy' }),
  });
  assert.equal(second.status, 409);

  // A different space is unaffected: uniqueness is per-space, not global.
  site.addSpace({ id: 'space-2', key: 'OTHER', name: 'Other' });
  const elsewhere = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-2', title: 'Safeguarding Policy' }),
  });
  assert.equal(elsewhere.status, 200);
});

test('the create-or-adopt shape works: a 409 on create is resolved by findPageByTitle locating the original', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1', 'Content-Type': 'application/json' };

  const created = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Safeguarding Policy' }),
  });
  const original = (await created.json()) as { id: string };

  const conflict = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Safeguarding Policy' }),
  });
  assert.equal(conflict.status, 409);

  // Production's findPageByTitle sends the space id under the hyphenated
  // key — see confluence-pages.ts:498.
  const query = new URLSearchParams({ title: 'Safeguarding Policy', 'space-id': 'space-1' });
  const found = await site.fetch(`${base}/wiki/api/v2/pages?${query.toString()}`, { headers: auth });
  const foundBody = (await found.json()) as { results: { id: string }[] };
  assert.equal(foundBody.results.length, 1, 'exactly one page must be adoptable, not zero and not many');
  assert.equal(foundBody.results[0]?.id, original.id);
});

test('a title is still occupied by a trashed page, and is only freed by a purge', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1', 'Content-Type': 'application/json' };

  const created = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Retention Policy' }),
  });
  const page = (await created.json()) as { id: string };

  await site.fetch(`${base}/wiki/api/v2/pages/${page.id}`, { method: 'DELETE', headers: auth });

  const whileTrashed = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Retention Policy' }),
  });
  assert.equal(whileTrashed.status, 409, 'a merely trashed page must still occupy its title');

  await site.fetch(`${base}/wiki/api/v2/pages/${page.id}?purge=true`, { method: 'DELETE', headers: auth });

  const afterPurge = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Retention Policy' }),
  });
  assert.equal(afterPurge.status, 200, 'once purged, the title is free again');
});

test('handleToken rejects a mismatched client_id or client_secret with invalid_client, and accepts a match', async () => {
  const site = createFakeAtlassian({ clientId: 'real-client', clientSecret: 'real-secret' });
  const tokenRequest = (overrides: Record<string, unknown>) =>
    site.fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: 'real-client',
        client_secret: 'real-secret',
        code: 'the-code',
        redirect_uri: 'https://app.example/integrations/confluence/callback',
        ...overrides,
      }),
    });

  const wrongSecret = await tokenRequest({ client_secret: 'wrong-secret' });
  assert.equal(wrongSecret.status, 401);
  assert.deepEqual(await wrongSecret.json(), { error: 'invalid_client' });

  const wrongClient = await tokenRequest({ client_id: 'wrong-client' });
  assert.equal(wrongClient.status, 401);
  assert.deepEqual(await wrongClient.json(), { error: 'invalid_client' });

  const correct = await tokenRequest({});
  assert.equal(correct.status, 200);
});

test('a fake without configured client credentials accepts any client_id/client_secret (unchanged default)', async () => {
  const site = createFakeAtlassian();
  const response = await site.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: 'whatever',
      client_secret: 'whatever',
      code: 'the-code',
      redirect_uri: 'https://app.example/callback',
    }),
  });
  assert.equal(response.status, 200);
});

test('handleToken rejects an authorization_code grant missing code or redirect_uri', async () => {
  const site = createFakeAtlassian();
  const tokenRequest = (body: Record<string, unknown>) =>
    site.fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const missingCode = await tokenRequest({
    grant_type: 'authorization_code',
    redirect_uri: 'https://app.example/callback',
  });
  assert.equal(missingCode.status, 400);

  const missingRedirect = await tokenRequest({
    grant_type: 'authorization_code',
    code: 'the-code',
  });
  assert.equal(missingRedirect.status, 400);

  const emptyCode = await tokenRequest({
    grant_type: 'authorization_code',
    code: '',
    redirect_uri: 'https://app.example/callback',
  });
  assert.equal(emptyCode.status, 400);
});

test('the granted-scope string is configurable, so both "scope missing" and "scope present" are expressible', async () => {
  const tokenRequest = (site: ReturnType<typeof createFakeAtlassian>) =>
    site.fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: 'the-code',
        redirect_uri: 'https://app.example/callback',
      }),
    });

  const defaultSite = createFakeAtlassian();
  const defaultBody = (await (await tokenRequest(defaultSite)).json()) as { scope: string };
  assert.ok(
    !defaultBody.scope.includes('delete:page:confluence'),
    'the default granted scope must not include the erasure scope',
  );

  const erasureScope =
    'read:confluence-content.all write:confluence-content delete:page:confluence offline_access';
  const erasureSite = createFakeAtlassian({ grantedScope: erasureScope });
  const erasureBody = (await (await tokenRequest(erasureSite)).json()) as { scope: string };
  assert.equal(erasureBody.scope, erasureScope);
  assert.ok(erasureBody.scope.includes('delete:page:confluence'));
});

test('accessible-resources returns exactly one site by default', async () => {
  const site = createFakeAtlassian();
  const tokenResponse = await site.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://app.example/callback',
    }),
  });
  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token: string };

  const response = await site.fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { id: string; url: string; name: string }[];
  assert.equal(body.length, 1);
  assert.equal(body[0]?.id, site.cloudId);
});

test('addSite makes accessible-resources report more than one site, exercising the CONFLUENCE_MULTIPLE_SITES path', async () => {
  const site = createFakeAtlassian();
  site.addSite({ id: 'other-cloud-id', url: 'https://other.atlassian.net', name: 'Other Co' });

  const tokenResponse = await site.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://app.example/callback',
    }),
  });
  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token: string };

  const response = await site.fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await response.json()) as { id: string; name: string }[];
  assert.equal(body.length, 2, 'a charity administrator belonging to two sites must see both');
  assert.deepEqual(
    body.map((entry) => entry.id),
    [site.cloudId, 'other-cloud-id'],
  );
});

test('FakeCall records the Authorization header actually sent, including its absence', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;

  await site.fetch(`${base}/wiki/api/v2/spaces`, { headers: { Authorization: 'Bearer token-one' } });
  await site.fetch(`${base}/wiki/api/v2/spaces`, { headers: { Authorization: 'Bearer token-two' } });
  await site.fetch(`${base}/wiki/api/v2/spaces`); // no Authorization header at all

  assert.deepEqual(
    site.calls.map((call) => call.authorization),
    ['Bearer token-one', 'Bearer token-two', undefined],
  );
});

test('a page created in a keyed space carries a realistic Confluence webui link', async () => {
  const site = createFakeAtlassian();
  site.addSpace({ id: 'space-1', key: 'GOV', name: 'Governance' });
  const base = `https://api.atlassian.com/ex/confluence/${site.cloudId}`;
  const auth = { Authorization: 'Bearer access-1', 'Content-Type': 'application/json' };

  const created = await site.fetch(`${base}/wiki/api/v2/pages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ spaceId: 'space-1', title: 'Safeguarding Policy' }),
  });
  const body = (await created.json()) as { id: string; _links: { base: string; webui: string } };

  assert.equal(body._links.base, 'https://example.atlassian.net/wiki');
  assert.equal(body._links.webui, `/spaces/GOV/pages/${body.id}/Safeguarding+Policy`);
});

function collectTsFiles(dirUrl: URL): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(new URL(`${entry.name}/`, dirUrl)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(new URL(entry.name, dirUrl));
    }
  }
  return files;
}

test('no production source file under services/ or routes/ imports the test-only fake Atlassian', () => {
  // This module's own docblock says "No production source file may import
  // it." That held in fact but had no canary — this is the canary. It walks
  // TypeScript SOURCE (not the compiled dist/ this test itself runs from:
  // tests execute as dist/tests/fake-atlassian.test.js, so the source tree is
  // two levels up and back down into src/).
  const srcRoot = new URL('../../src/', import.meta.url);
  const offenders: string[] = [];

  for (const dir of ['services/', 'routes/']) {
    for (const file of collectTsFiles(new URL(dir, srcRoot))) {
      if (readFileSync(file, 'utf8').includes('fake-atlassian')) {
        offenders.push(file.pathname);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `production source file(s) import (or mention) the test-only fake: ${offenders.join(', ')}`,
  );
});
