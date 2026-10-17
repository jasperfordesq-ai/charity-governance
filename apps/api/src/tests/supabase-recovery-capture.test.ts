import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { SupabaseRecoveryCapture } from '../services/supabase-recovery-capture.js';

const config = {
  installationId: 'synthetic',
  projectRef: 'abcdefghijklmnopqrst',
  bucket: 'documents',
};
const key = 'sb_secret_' + 'a'.repeat(40);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const file = (name: string, size = 3) => ({
  name,
  id: '11111111-1111-4111-8111-111111111111',
  created_at: '2026-10-17T00:00:00.000Z',
  updated_at: '2026-10-17T00:00:00.000Z',
  metadata: { size, mimetype: 'application/pdf' },
});
function fixture() {
  let downloads = 0,
    lists = 0,
    failStatus = 0,
    publicBucket = false;
  let list = (_prefix: string, _offset: number): unknown[] => [
    _prefix === ''
      ? {
          name: 'tenant',
          id: null,
          created_at: null,
          updated_at: null,
          metadata: null,
        }
      : file('record.pdf'),
  ];
  const requests: { path: string; method: string }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://abcdefghijklmnopqrst.supabase.co');
    assert.equal(init?.redirect, 'error');
    assert.equal(
      new Headers(init?.headers).get('cache-control'),
      'no-cache, no-store',
    );
    assert.equal(new Headers(init?.headers).get('apikey'), key);
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    requests.push({ path: url.pathname, method: String(init?.method) });
    if (failStatus)
      return new Response('private provider error ' + key, {
        status: failStatus,
      });
    if (url.pathname.includes('/bucket/'))
      return Response.json({ id: 'documents', public: publicBucket });
    if (url.pathname.includes('/object/list/')) {
      lists++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.limit, 100);
      assert.deepEqual(body.sortBy, { column: 'name', order: 'asc' });
      return Response.json(list(body.prefix, body.offset));
    }
    assert.equal(init?.method, 'GET');
    downloads++;
    assert.ok(url.pathname.startsWith('/storage/v1/object/documents/'));
    assert.equal(url.search, '');
    return new Response(Buffer.from('pdf'), {
      headers: { 'content-type': 'application/pdf', 'content-length': '3' },
    });
  };
  return {
    transport,
    requests,
    get downloads() {
      return downloads;
    },
    get lists() {
      return lists;
    },
    set list(value: typeof list) {
      list = value;
    },
    set failStatus(value: number) {
      failStatus = value;
    },
    set publicBucket(value: boolean) {
      publicBucket = value;
    },
  };
}

test('full recursive credential-view capture reads files twice, clears callback bytes and reports quarantine limits', async () => {
  const f = fixture(),
    capture = new SupabaseRecoveryCapture(config, key, f.transport);
  let held: Buffer | undefined;
  const result = await capture.capture(async (entry, bytes, digest) => {
    assert.equal(entry.fileUrl, 'tenant/record.pdf');
    assert.equal(digest, sha(Buffer.from('pdf')));
    held = bytes;
    assert.equal(bytes.toString(), 'pdf');
  });
  assert.equal(
    held?.every((value) => value === 0),
    true,
  );
  assert.equal(f.downloads, 2);
  assert.equal(result.objects.length, 1);
  assert.equal(result.restoreMode, 'QUARANTINE_ONLY');
  assert.equal(result.captureConsistency, 'EXTERNAL_VERIFICATION_REQUIRED');
  assert.equal(result.visibility, 'SUPPLIED_CREDENTIAL_VIEW_ONLY');
  assert.equal(result.objects[0].sha256, sha(Buffer.from('pdf')));
  assert.ok(
    f.requests.every(
      (r) =>
        r.method === 'GET' ||
        (r.method === 'POST' && r.path.includes('/object/list/')),
    ),
  );
});

test('auth errors, public buckets, malformed entries, repeated pages and changing inventory never become complete empty capture', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const f = fixture();
    f.failStatus = status;
    await assert.rejects(
      new SupabaseRecoveryCapture(config, key, f.transport).capture(
        async () => {},
      ),
      (error) => {
        assert.equal(
          (error as Error).message,
          'Supabase recovery capture is unresolved',
        );
        return true;
      },
    );
    assert.equal(f.requests.length, 1);
  }
  for (const invalid of [
    '..',
    'a/b',
    'percent%2fkey',
    'back\\slash',
    'newline\n',
  ]) {
    const f = fixture();
    f.list = () => [file(invalid)];
    await assert.rejects(
      new SupabaseRecoveryCapture(config, key, f.transport).capture(
        async () => {},
      ),
    );
    assert.equal(f.downloads, 0);
  }
  const exposed = fixture();
  exposed.publicBucket = true;
  await assert.rejects(
    new SupabaseRecoveryCapture(config, key, exposed.transport).capture(
      async () => {},
    ),
  );
  const repeated = fixture();
  repeated.list = () =>
    Array.from({ length: 100 }, (_, i) => ({
      ...file('file-' + i),
      id: '11111111-1111-4111-8111-' + String(i).padStart(12, '0'),
    }));
  await assert.rejects(
    new SupabaseRecoveryCapture(config, key, repeated.transport).capture(
      async () => {},
    ),
  );
  const changed = fixture();
  let calls = 0;
  changed.list = () => [file(++calls === 1 ? 'original' : 'changed')];
  await assert.rejects(
    new SupabaseRecoveryCapture(config, key, changed.transport).capture(
      async () => {},
    ),
  );
});

test('explicit empty inventory is distinct from failure and cancellation prevents requests', async () => {
  const f = fixture();
  f.list = () => [];
  const service = new SupabaseRecoveryCapture(config, key, f.transport);
  assert.equal(
    (
      await service.capture(async () => {
        assert.fail('no objects');
      })
    ).objects.length,
    0,
  );
  const before = f.requests.length,
    controller = new AbortController();
  controller.abort();
  await assert.rejects(service.capture(async () => {}, controller.signal));
  assert.equal(f.requests.length, before);
  assert.throws(
    () =>
      new SupabaseRecoveryCapture(
        { ...config, projectRef: config.projectRef + '.evil.test' },
        key,
      ),
  );
  assert.throws(
    () => new SupabaseRecoveryCapture(config, 'public-or-unknown-key'),
  );
});

test('exactly full pages require a following empty page and all100 files are checked twice', async () => {
  const f = fixture();
  f.list = (_prefix, offset) =>
    offset
      ? []
      : Array.from({ length: 100 }, (_, i) => ({
          ...file('file-' + String(i).padStart(3, '0')),
          id: '11111111-1111-4111-8111-' + String(i).padStart(12, '0'),
        }));
  const result = await new SupabaseRecoveryCapture(
    config,
    key,
    f.transport,
  ).capture(async () => {});
  assert.equal(result.objects.length, 100);
  assert.equal(f.downloads, 200);
  assert.equal(f.lists, 6);
});

test('same-metadata byte changes fail and callback cancellation clears plaintext even if the callback ignores it', async () => {
  const f = fixture();
  const changed: typeof fetch = async (input, init) => {
    const response = await f.transport(input, init);
    if (f.downloads === 2 && init?.method === 'GET') {
      await response.body?.cancel();
      return new Response(Buffer.from('bad'), {
        headers: { 'content-type': 'application/pdf', 'content-length': '3' },
      });
    }
    return response;
  };
  await assert.rejects(
    new SupabaseRecoveryCapture(config, key, changed).capture(async () => {}),
  );
  const controller = new AbortController(),
    g = fixture();
  let held: Buffer | undefined;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new SupabaseRecoveryCapture(config, key, g.transport).capture(
    async (_file, bytes) => {
      held = bytes;
      enter();
      return new Promise<void>(() => {});
    },
    controller.signal,
  );
  await entered;
  controller.abort();
  await assert.rejects(pending);
  assert.equal(
    held?.every((value) => value === 0),
    true,
  );
});

test('a stalled provider is bounded and a late response body is cancelled without leaking its error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reply!: (value: Response) => void,
    cancelled = false;
  const transport: typeof fetch = () =>
    new Promise<Response>((resolve) => {
      reply = resolve;
    });
  const pending = new SupabaseRecoveryCapture(config, key, transport).capture(
    async () => {},
  );
  t.mock.timers.tick(15001);
  await assert.rejects(pending);
  reply(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
          throw new Error('private cancellation failure');
        },
      }),
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cancelled, true);
});

test('zero-byte records are retained and declared size mismatch cannot reach the visitor', async () => {
  const f = fixture();
  f.list = () => [file('empty.pdf', 0)];
  const transport: typeof fetch = async (input, init) => {
    const response = await f.transport(input, init);
    if (
      init?.method === 'GET' &&
      new URL(String(input)).pathname.startsWith(
        '/storage/v1/object/documents/',
      )
    ) {
      await response.body?.cancel();
      return new Response(null, {
        headers: { 'content-type': 'application/pdf', 'content-length': '0' },
      });
    }
    return response;
  };
  const result = await new SupabaseRecoveryCapture(
    config,
    key,
    transport,
  ).capture(async (_file, bytes) => {
    assert.equal(bytes.length, 0);
  });
  assert.equal(result.objects[0].sha256, sha(Buffer.alloc(0)));
  const bad = fixture();
  bad.list = () => [file('wrong-size.pdf', 2)];
  await assert.rejects(
    new SupabaseRecoveryCapture(config, key, bad.transport).capture(
      async () => {
        assert.fail('size mismatch must precede callback');
      },
    ),
  );
});
