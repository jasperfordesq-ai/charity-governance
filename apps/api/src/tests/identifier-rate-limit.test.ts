import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyRequest } from "fastify";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from "../utils/auth-cookie-names.js";
import { getAccessTokenFromRequest } from "../utils/auth-request-credential.js";
import {
  AUTH_ME_COARSE_IP_MAX_PER_MINUTE,
  authCredentialRateLimit,
  authMeCoarseIpRateLimit,
  bodyIdentifierRateLimit,
  refreshTokenRateLimit,
} from "../utils/identifier-rate-limit.js";

function requestStub(overrides: Partial<FastifyRequest>): FastifyRequest {
  return {
    ip: "203.0.113.20",
    body: {},
    cookies: {},
    headers: {},
    ...overrides,
  } as FastifyRequest;
}

test("body identifier rate limits normalize email buckets without exposing the email", () => {
  const limiter = bodyIdentifierRateLimit(["email"]);
  const first = limiter.keyGenerator(
    requestStub({ body: { email: " OWNER@Example.ORG " } }),
  );
  const second = limiter.keyGenerator(
    requestStub({ body: { email: "owner@example.org" } }),
  );

  assert.equal(first, second);
  assert.match(first, /^203\.0\.113\.20:[a-f0-9]{32}$/);
  assert.equal(first.includes("owner@example.org"), false);
});

test("body identifier rate limits fall through configured fields and hide reset tokens", () => {
  const limiter = bodyIdentifierRateLimit(["email", "token"]);
  const key = limiter.keyGenerator(
    requestStub({ body: { token: "raw-reset-token" } }),
  );

  assert.match(key, /^203\.0\.113\.20:[a-f0-9]{32}$/);
  assert.equal(key.includes("raw-reset-token"), false);
});

test("refresh token rate limits bucket body and cookie credentials without leaking the token", () => {
  const limiter = refreshTokenRateLimit();
  const fromBody = limiter.keyGenerator(
    requestStub({ body: { refreshToken: "raw-refresh-token" } }),
  );
  const fromCookie = limiter.keyGenerator(
    requestStub({ cookies: { [REFRESH_TOKEN_COOKIE]: "raw-refresh-token" } }),
  );

  assert.equal(fromBody, fromCookie);
  assert.match(fromBody, /^203\.0\.113\.20:[a-f0-9]{32}$/);
  assert.equal(fromBody.includes("raw-refresh-token"), false);
});

test("auth credential rate limits bucket bearer and access-cookie credentials without leaking them", () => {
  const limiter = authCredentialRateLimit();
  const fromBearer = limiter.keyGenerator(
    requestStub({ headers: { authorization: "bearer raw-access-token" } }),
  );
  const fromCookie = limiter.keyGenerator(
    requestStub({ cookies: { [ACCESS_TOKEN_COOKIE]: "raw-access-token" } }),
  );

  assert.equal(fromBearer, fromCookie);
  assert.match(fromBearer, /^203\.0\.113\.20:[a-f0-9]{32}$/);
  assert.equal(fromBearer.includes("raw-access-token"), false);
});

test("a present malformed authorization header cannot fall back to a valid access cookie", () => {
  const request = requestStub({
    headers: { authorization: "Basic attacker-controlled" },
    cookies: { [ACCESS_TOKEN_COOKIE]: "valid-cookie-token" },
  });
  const missingCredential = requestStub({});
  const limiter = authCredentialRateLimit();

  assert.equal(getAccessTokenFromRequest(request), undefined);
  assert.equal(
    limiter.keyGenerator(request),
    limiter.keyGenerator(missingCredential),
  );
});

test("auth/me coarse limiting has an independent documented IP-only bucket", () => {
  const limiter = authMeCoarseIpRateLimit();
  const first = limiter.keyGenerator(
    requestStub({
      headers: { authorization: "Bearer credential-a" },
    }),
  );
  const second = limiter.keyGenerator(
    requestStub({
      headers: { authorization: "Bearer credential-b" },
    }),
  );

  assert.equal(limiter.max, AUTH_ME_COARSE_IP_MAX_PER_MINUTE);
  assert.equal(limiter.timeWindow, "1 minute");
  assert.equal(first, "auth-me-ip:203.0.113.20");
  assert.equal(second, first);
});
