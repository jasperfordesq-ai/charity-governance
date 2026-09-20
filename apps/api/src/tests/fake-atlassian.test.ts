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
