import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readAttachmentVersionBytes } from '../services/confluence-attachment-readback.js';
import { AppError } from '../utils/errors.js';

const token = 'test-access-token-private';
const bytes = new TextEncoder().encode('exact version one');
const signedUrl = 'https://api.media.atlassian.com/file/signed?token=not-a-bearer';

function input(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return {
    cloudId: 'cloud-123', pageId: 'page123', attachmentId: 'att456',
    versionNumber: 2, siteHostname: 'charity.atlassian.net',
    getAccessToken: async () => token, fetch: fetchImpl,
    ...extra,
  };
}

function scriptedFetch(responses: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const response = responses[calls.length - 1];
    if (response === undefined) throw new Error('unexpected network request');
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function redirect(location = signedUrl): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

async function failure(action: () => Promise<unknown>): Promise<AppError> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.message.includes(token), false);
    return error;
  }
  return assert.fail('expected readback failure');
}

test('reads one explicit version as bounded bytes and never sends bearer to download host', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    redirect(),
    new Response(bytes, { status: 200, headers: { 'Content-Length': String(bytes.length) } }),
  ]);
  const result = await readAttachmentVersionBytes(input(fetchImpl));
  assert.deepEqual(result, {
    attachmentId: 'att456', versionNumber: 2, byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url,
    'https://api.atlassian.com/ex/confluence/cloud-123/wiki/rest/api/content/page123/child/attachment/att456/download?version=2');
  assert.equal(new Headers(calls[0]?.init?.headers).get('Authorization'), `Bearer ${token}`);
  assert.equal(calls[0]?.init?.redirect, 'manual');
  assert.equal(calls[1]?.url, signedUrl);
  assert.equal(new Headers(calls[1]?.init?.headers).get('Authorization'), null);
  assert.equal(calls[1]?.init?.redirect, 'manual');
});

test('rejects an unapproved redirect before a second network call', async () => {
  for (const location of [
    'http://api.media.atlassian.com/file',
    'https://evil.example/file',
    'https://api.media.atlassian.com.evil.example/file',
    'https://user:pass@api.media.atlassian.com/file',
    'https://api.media.atlassian.com:8443/file',
    '/relative/file',
  ]) {
    const { fetchImpl, calls } = scriptedFetch([redirect(location)]);
    const error = await failure(() => readAttachmentVersionBytes(input(fetchImpl)));
    assert.equal(error.code, 'CONFLUENCE_READBACK_RESPONSE_INVALID');
    assert.equal(calls.length, 1);
  }
});

test('rejects a second redirect, excess streamed bytes and a false declared length', async () => {
  const secondRedirect = scriptedFetch([redirect(), redirect('https://api.media.atlassian.com/again')]);
  assert.equal((await failure(() => readAttachmentVersionBytes(input(secondRedirect.fetchImpl)))).code,
    'CONFLUENCE_READBACK_RESPONSE_INVALID');
  assert.equal(secondRedirect.calls.length, 2);

  const tooLarge = scriptedFetch([redirect(), new Response(bytes, { status: 200 })]);
  assert.equal((await failure(() => readAttachmentVersionBytes(input(tooLarge.fetchImpl, { maxBytes: 3 })))).code,
    'CONFLUENCE_READBACK_TOO_LARGE');

  const wrongLength = scriptedFetch([
    redirect(), new Response(bytes, { status: 200, headers: { 'Content-Length': '1' } }),
  ]);
  assert.equal((await failure(() => readAttachmentVersionBytes(input(wrongLength.fetchImpl)))).code,
    'CONFLUENCE_READBACK_RESPONSE_INVALID');
});

test('invalid identifiers and tenant host fail before token or network use', async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    throw new Error('must not fetch');
  }) as typeof fetch;
  const error = await failure(() => readAttachmentVersionBytes({
    ...input(fetchImpl, { pageId: '../wrong', siteHostname: 'localhost' }),
    getAccessToken: async () => { tokenCalls += 1; return token; },
  }));
  assert.equal(error.code, 'CONFLUENCE_READBACK_INPUT_INVALID');
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});
