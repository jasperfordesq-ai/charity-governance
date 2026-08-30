import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORIGIN_MISSING_MESSAGE,
  ORIGIN_REJECTED_MESSAGE,
  ORIGIN_UNREACHABLE_MESSAGE,
  UNREACHABLE_MESSAGE,
  authFailureNotice,
  classifyAuthFailure,
} from './auth-error-message';

// Concern: truthful failure reporting on the auth screens. The API refuses an
// unsafe request whose Origin is not allow-listed BEFORE the credential check
// runs, so an origin rejection reported as "Invalid email or password" sends an
// operator to reset passwords over a wrong-address problem.

const CREDENTIALS_FALLBACK = 'Invalid email or password. Please try again.';

const PERSONAL_SERVER_MISMATCH = {
  pageOrigin: 'http://localhost:8080',
  apiOrigin: 'https://charity.tailnet-name.ts.net',
  isPersonalServer: true,
};
const PERSONAL_SERVER_MATCH = {
  pageOrigin: 'https://charity.tailnet-name.ts.net',
  apiOrigin: 'https://charity.tailnet-name.ts.net',
  isPersonalServer: true,
};
// A hosted deployment is legitimately cross-origin (web host + api host), so a
// differing origin there is NOT evidence of a misconfigured address.
const HOSTED = {
  pageOrigin: 'https://app.charitypilot.ie',
  apiOrigin: 'https://api.charitypilot.ie',
  isPersonalServer: false,
};

function axiosError(response?: unknown) {
  return { isAxiosError: true, response };
}

test('a readable 403 INVALID_ORIGIN is never reported as a credentials failure', () => {
  const error = axiosError({
    status: 403,
    data: { error: 'Invalid request origin', code: 'INVALID_ORIGIN' },
  });

  assert.equal(classifyAuthFailure(error, PERSONAL_SERVER_MATCH), 'origin-rejected');
  const notice = authFailureNotice(error, CREDENTIALS_FALLBACK, PERSONAL_SERVER_MATCH);
  assert.equal(notice.message, ORIGIN_REJECTED_MESSAGE);
  assert.equal(notice.title, 'Wrong address for this server');
});

test('a readable 403 MISSING_ORIGIN gets its own stripped-header explanation', () => {
  const error = axiosError({
    status: 403,
    data: { error: 'Missing request origin', code: 'MISSING_ORIGIN' },
  });

  assert.equal(classifyAuthFailure(error, PERSONAL_SERVER_MATCH), 'origin-missing');
  assert.equal(
    authFailureNotice(error, CREDENTIALS_FALLBACK, PERSONAL_SERVER_MATCH).message,
    ORIGIN_MISSING_MESSAGE,
  );
});

test('origin messages never disclose the configured origin to an unauthenticated caller', () => {
  const configured = PERSONAL_SERVER_MISMATCH.apiOrigin;
  for (const message of [
    ORIGIN_REJECTED_MESSAGE,
    ORIGIN_MISSING_MESSAGE,
    ORIGIN_UNREACHABLE_MESSAGE,
    UNREACHABLE_MESSAGE,
  ]) {
    assert.ok(!message.includes(configured), 'must not print the configured origin');
    assert.ok(!message.includes('ts.net'), 'must not print any part of the configured host');
  }
});

test('a 401 INVALID_CREDENTIALS still reports the credential failure', () => {
  const error = axiosError({
    status: 401,
    data: { error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' },
  });

  assert.equal(classifyAuthFailure(error, PERSONAL_SERVER_MATCH), 'answered');
  assert.deepEqual(authFailureNotice(error, CREDENTIALS_FALLBACK, PERSONAL_SERVER_MATCH), {
    message: 'Invalid email or password',
  });
});

test('other answered 4xx codes keep the server’s own message, not the credentials fallback', () => {
  const cases: Array<[unknown, string]> = [
    [{ status: 429, data: { error: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' } }, 'Too many requests. Please slow down.'],
    [{ status: 400, data: { error: 'Validation failed', code: 'VALIDATION_ERROR' } }, 'Validation failed'],
    [{ status: 404, data: { error: 'Not found', code: 'NOT_FOUND' } }, 'Not found'],
    [{ status: 403, data: { error: 'Forbidden', code: 'FORBIDDEN' } }, 'Forbidden'],
  ];

  for (const [response, expected] of cases) {
    const notice = authFailureNotice(axiosError(response), CREDENTIALS_FALLBACK, PERSONAL_SERVER_MATCH);
    assert.equal(notice.message, expected);
    assert.equal(notice.title, undefined, 'answered errors keep the default alert heading');
  }
});

test('a CORS-blocked login on a personal server reads as a wrong-address failure', () => {
  // @fastify/cors omits Access-Control-Allow-Origin for a disallowed origin, so
  // the browser blocks the 403 and axios reports a request with no response.
  const error = axiosError(undefined);

  assert.equal(classifyAuthFailure(error, PERSONAL_SERVER_MISMATCH), 'origin-unreachable');
  const notice = authFailureNotice(error, CREDENTIALS_FALLBACK, PERSONAL_SERVER_MISMATCH);
  assert.equal(notice.message, ORIGIN_UNREACHABLE_MESSAGE);
  assert.notEqual(notice.message, CREDENTIALS_FALLBACK);
});

test('an unanswered request never claims the credentials were wrong', () => {
  for (const origins of [PERSONAL_SERVER_MATCH, HOSTED]) {
    const notice = authFailureNotice(axiosError(undefined), CREDENTIALS_FALLBACK, origins);
    assert.equal(notice.message, UNREACHABLE_MESSAGE, 'a dead or unreachable server is not a bad password');
  }
});

test('a differing origin is only evidence of misconfiguration on a personal server', () => {
  assert.equal(classifyAuthFailure(axiosError(undefined), HOSTED), 'unreachable');
  assert.equal(classifyAuthFailure(axiosError(undefined), PERSONAL_SERVER_MISMATCH), 'origin-unreachable');
});

test('an unknown or unparseable origin is not treated as a mismatch', () => {
  for (const origins of [
    { pageOrigin: undefined, apiOrigin: 'https://charity.tailnet-name.ts.net', isPersonalServer: true },
    { pageOrigin: 'http://localhost:8080', apiOrigin: undefined, isPersonalServer: true },
    { pageOrigin: 'not a url', apiOrigin: 'https://charity.tailnet-name.ts.net', isPersonalServer: true },
  ]) {
    assert.equal(classifyAuthFailure(axiosError(undefined), origins), 'unreachable');
  }
});

test('origins are compared by origin only, ignoring path and trailing slash noise', () => {
  assert.equal(
    classifyAuthFailure(axiosError(undefined), {
      pageOrigin: 'https://charity.tailnet-name.ts.net',
      apiOrigin: 'https://charity.tailnet-name.ts.net/',
      isPersonalServer: true,
    }),
    'unreachable',
  );
});

test('a non-axios failure keeps the existing fallback behaviour and never throws', () => {
  for (const odd of [null, undefined, 'a string', 42, new Error('boom'), { response: null }, {}]) {
    const notice = authFailureNotice(odd, CREDENTIALS_FALLBACK, PERSONAL_SERVER_MISMATCH);
    assert.equal(typeof notice.message, 'string');
    // A bug thrown inside the submit handler must not be reported as a dead server.
    assert.equal(notice.message, CREDENTIALS_FALLBACK);
  }
});

test('a suspended organisation gets a lifecycle title and the server message', () => {
  const error = axiosError({
    status: 403,
    data: { error: 'This organisation is suspended. Contact support to restore access.', code: 'ORGANISATION_SUSPENDED' },
  });
  const notice = authFailureNotice(error, CREDENTIALS_FALLBACK, PERSONAL_SERVER_MATCH);
  assert.equal(notice.title, 'This organisation is suspended');
  assert.match(notice.message, /suspended/);
});

test('a closed organisation gets a lifecycle title and the server message', () => {
  const error = axiosError({
    status: 403,
    data: { error: 'This organisation is closed. Please contact us.', code: 'ORGANISATION_CLOSED' },
  });
  const notice = authFailureNotice(error, CREDENTIALS_FALLBACK, PERSONAL_SERVER_MATCH);
  assert.equal(notice.title, 'This organisation is closed');
  assert.match(notice.message, /closed/);
});

test('an account suspension gets a lifecycle title and the server message', () => {
  const error = axiosError({
    status: 403,
    data: { error: 'This account is no longer active.', code: 'ACCOUNT_SUSPENDED' },
  });
  const notice = authFailureNotice(error, CREDENTIALS_FALLBACK, PERSONAL_SERVER_MATCH);
  assert.equal(notice.title, 'This account is no longer active');
  assert.match(notice.message, /no longer active/);
});

test('origin rejection still wins over the lifecycle codes', () => {
  const error = axiosError({
    status: 403,
    data: { error: 'Invalid request origin', code: 'INVALID_ORIGIN' },
  });
  const notice = authFailureNotice(error, CREDENTIALS_FALLBACK, PERSONAL_SERVER_MATCH);
  // Should get the origin title, not a lifecycle title
  assert.equal(notice.title, 'Wrong address for this server');
  assert.notEqual(notice.title, 'This organisation is suspended');
});
