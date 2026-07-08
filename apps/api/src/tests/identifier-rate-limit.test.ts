import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '../utils/auth-cookie-names.js';
import {
  authCredentialRateLimit,
  bodyIdentifierRateLimit,
  refreshTokenRateLimit,
} from '../utils/identifier-rate-limit.js';

function requestStub(overrides: Partial<FastifyRequest>): FastifyRequest {
  return {
    ip: '203.0.113.20',
    body: {},
    cookies: {},
    headers: {},
    ...overrides,
  } as FastifyRequest;
}

test('body identifier rate limits normalize email buckets without exposing the email', () => {
  const limiter = bodyIdentifierRateLimit(['email']);
  const first = limiter.keyGenerator(requestStub({ body: { email: ' OWNER@Example.ORG ' } }));
  const second = limiter.keyGenerator(requestStub({ body: { email: 'owner@example.org' } }));

  assert.equal(first, second);
  assert.match(first, /^203\.0\.113\.20:[a-f0-9]{32}$/);
  assert.equal(first.includes('owner@example.org'), false);
});

test('body identifier rate limits fall through configured fields and hide reset tokens', () => {
  const limiter = bodyIdentifierRateLimit(['email', 'token']);
  const key = limiter.keyGenerator(requestStub({ body: { token: 'raw-reset-token' } }));

  assert.match(key, /^203\.0\.113\.20:[a-f0-9]{32}$/);
  assert.equal(key.includes('raw-reset-token'), false);
});

test('refresh token rate limits bucket body and cookie credentials without leaking the token', () => {
  const limiter = refreshTokenRateLimit();
  const fromBody = limiter.keyGenerator(requestStub({ body: { refreshToken: 'raw-refresh-token' } }));
  const fromCookie = limiter.keyGenerator(requestStub({ cookies: { [REFRESH_TOKEN_COOKIE]: 'raw-refresh-token' } }));

  assert.equal(fromBody, fromCookie);
  assert.match(fromBody, /^203\.0\.113\.20:[a-f0-9]{32}$/);
  assert.equal(fromBody.includes('raw-refresh-token'), false);
});

test('auth credential rate limits bucket bearer and access-cookie credentials without leaking them', () => {
  const limiter = authCredentialRateLimit();
  const fromBearer = limiter.keyGenerator(requestStub({ headers: { authorization: 'Bearer raw-access-token' } }));
  const fromCookie = limiter.keyGenerator(requestStub({ cookies: { [ACCESS_TOKEN_COOKIE]: 'raw-access-token' } }));

  assert.equal(fromBearer, fromCookie);
  assert.match(fromBearer, /^203\.0\.113\.20:[a-f0-9]{32}$/);
  assert.equal(fromBearer.includes('raw-access-token'), false);
});
