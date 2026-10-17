import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { S3DatabaseByteBackups } from '../services/database-byte-backup-s3.js';
import {
  sealDatabaseByteBackup,
  openDatabaseByteBackupToQuarantine,
  type DatabaseBackupKeys,
} from '../services/database-byte-backup.js';

type Request = {
  method: string;
  hostname: string;
  protocol: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
  path: string;
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest();
const arn = (n: string) =>
  `arn:aws:kms:eu-west-1:123456789012:key/${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const config = {
  installationId: 'fixture',
  bucket: 'synthetic-database-archives',
  accountId: '123456789012',
  dataKeyArn: arn('2'),
  storageKeyArn: arn('3'),
};
function sink() {
  const chunks: Buffer[] = [];
  return {
    chunks,
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  };
}
function source(bytes: Buffer) {
  return Readable.from(
    (function* () {
      for (let i = 0; i < bytes.length; i += 65536)
        yield bytes.subarray(i, i + 65536);
    })(),
  );
}
async function fixture(size: number) {
  const bytes = Buffer.alloc(size, 7);
  bytes.write('PGDMP');
  const scope = {
    installationId: 'fixture',
    setId: '11111111-1111-4111-8111-111111111111',
    sourceSha: 'a'.repeat(40),
    databaseIdentitySha256: 'b'.repeat(64),
    sourceCaptureReportSha256: 'c'.repeat(64),
    databaseSha256: hash(bytes).toString('hex'),
    byteLength: bytes.length,
    keyArn: config.dataKeyArn,
  };
  const retained = randomBytes(32);
  const keys: DatabaseBackupKeys = {
    async generate(c) {
      return {
        key: Buffer.from(retained),
        keyArn: c.keyArn,
        wrappedKey: 'YQ==',
      };
    },
    async unwrap(_wrapped, c) {
      return { key: Buffer.from(retained), keyArn: c.keyArn };
    },
  };
  const output = sink(),
    receipt = await sealDatabaseByteBackup(
      scope,
      source(bytes),
      output.stream,
      keys,
    );
  bytes.fill(0);
  return {
    scope,
    keys,
    retained,
    receipt,
    archive: Buffer.concat(output.chunks),
  };
}
type Part = { body: Buffer; checksum: string; etag: string };
function provider() {
  const parts = new Map<number, Part>();
  let object: { parts: Part[]; checksum: string; key: string } | undefined;
  const calls: string[] = [];
  let loseCompletion = false,
    completeError = false,
    badPart = false;
  let onCreate = () => {};
  const metadata: Record<string, string> = {};
  const sdk = () =>
    new S3Client({
      region: 'eu-west-1',
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      credentials,
      maxAttempts: 1,
      requestHandler: {
        async handle(request: Request) {
          assert.match(request.headers.authorization, /AWS4-HMAC-SHA256/);
          assert.equal(request.protocol, 'https:');
          assert.match(request.hostname, /s3\.eu-west-1\.amazonaws\.com$/);
          assert.equal(
            request.headers['x-amz-expected-bucket-owner'],
            config.accountId,
          );
          const reply = (
            xml: string,
            headers: Record<string, string> = {},
          ) => ({
            response: {
              statusCode: 200,
              headers: { 'content-type': 'application/xml', ...headers },
              body: Readable.from([xml]),
            },
          });
          const encryption = {
            'x-amz-server-side-encryption': 'aws:kms',
            'x-amz-server-side-encryption-aws-kms-key-id': config.storageKeyArn,
          };
          if (request.method === 'POST' && 'uploads' in request.query) {
            calls.push('create');
            assert.equal(
              request.headers['x-amz-server-side-encryption-aws-kms-key-id'],
              config.storageKeyArn,
            );
            onCreate();
            parts.clear();
            return reply(
              `<InitiateMultipartUploadResult><Bucket>${config.bucket}</Bucket><Key>${request.path.slice(1)}</Key><UploadId>synthetic-upload</UploadId></InitiateMultipartUploadResult>`,
              encryption,
            );
          }
          if (request.method === 'PUT') {
            calls.push('part');
            assert.equal(request.query.uploadId, 'synthetic-upload');
            const body = Buffer.from(request.body as Uint8Array),
              n = Number(request.query.partNumber),
              checksum = hash(body).toString('base64'),
              etag = `"part-${n}"`;
            assert.equal(request.headers['x-amz-checksum-sha256'], checksum);
            assert.equal(
              Number(request.headers['content-length']),
              body.length,
            );
            if (n > 1)
              assert.equal(parts.get(n - 1)?.body.length, 16 * 1024 * 1024);
            parts.set(n, { body, checksum, etag });
            return reply('', {
              ...encryption,
              etag,
              'x-amz-checksum-sha256': badPart ? 'bad' : checksum,
            });
          }
          if (request.method === 'POST') {
            calls.push('complete');
            assert.equal(request.headers['if-none-match'], '*');
            assert.equal(request.query.uploadId, 'synthetic-upload');
            if (completeError)
              return reply(
                '<Error><Code>InternalError</Code><Message>synthetic embedded failure</Message></Error>',
              );
            if (object)
              return {
                response: {
                  statusCode: 412,
                  headers: {},
                  body: Readable.from([
                    '<Error><Code>PreconditionFailed</Code></Error>',
                  ]),
                },
              };
            const ordered = [...parts.entries()]
              .sort((a, b) => a[0] - b[0])
              .map((x) => x[1]);
            const checksum =
              hash(
                Buffer.concat(
                  ordered.map((p) => Buffer.from(p.checksum, 'base64')),
                ),
              ).toString('base64') +
              '-' +
              ordered.length;
            assert.equal(request.headers['x-amz-checksum-sha256'], checksum);
            assert.equal(
              Number(request.headers['x-amz-mp-object-size']),
              ordered.reduce((n, p) => n + p.body.length, 0),
            );
            const xml =
              typeof request.body === 'string'
                ? request.body
                : new TextDecoder().decode(request.body as Uint8Array);
            assert.deepEqual(
              [...xml.matchAll(/<PartNumber>([0-9]+)<\/PartNumber>/g)].map(
                (m) => Number(m[1]),
              ),
              ordered.map((_p, i) => i + 1),
            );
            object = { parts: ordered, checksum, key: request.path.slice(1) };
            if (loseCompletion)
              throw new Error('synthetic lost completion acknowledgement');
            return reply(
              `<CompleteMultipartUploadResult><Bucket>${config.bucket}</Bucket><Key>${object.key}</Key><ETag>"complete"</ETag><ChecksumSHA256>${checksum}</ChecksumSHA256><ChecksumType>COMPOSITE</ChecksumType></CompleteMultipartUploadResult>`,
              { ...encryption, 'x-amz-version-id': 'exact-version' },
            );
          }
          calls.push('get');
          assert.ok(object);
          assert.equal(request.headers['x-amz-checksum-mode'], 'ENABLED');
          if (request.query.versionId !== undefined)
            assert.equal(request.query.versionId, 'exact-version');
          const body = Readable.from(
            (function* () {
              for (const p of object!.parts)
                for (let i = 0; i < p.body.length; i += 65536)
                  yield p.body.subarray(i, i + 65536);
            })(),
          );
          return {
            response: {
              statusCode: 200,
              headers: {
                ...encryption,
                'x-amz-version-id': 'exact-version',
                'x-amz-checksum-sha256': object.checksum,
                'x-amz-checksum-type': 'COMPOSITE',
                'content-length': String(
                  object.parts.reduce((n, p) => n + p.body.length, 0),
                ),
                ...metadata,
              },
              body,
            },
          };
        },
      },
    });
  return {
    sdk,
    calls,
    metadata,
    parts,
    set created(callback: () => void) {
      onCreate = callback;
    },
    set lost(value: boolean) {
      loseCompletion = value;
    },
    set error(value: boolean) {
      completeError = value;
    },
    set bad(value: boolean) {
      badPart = value;
    },
  };
}
test('multipart candidate gets exact-version full readback; fresh client recovers a lost completion without another write', async () => {
  const f = await fixture(17 * 1024 * 1024),
    p = provider(),
    first = p.sdk(),
    next = p.sdk();
  try {
    p.lost = true;
    await assert.rejects(
      new S3DatabaseByteBackups(config, credentials, first).publish(
        f.scope,
        f.receipt,
        source(f.archive),
      ),
    );
    assert.deepEqual(p.calls, ['create', 'part', 'part', 'complete']);
    const output = sink();
    const receipt = await new S3DatabaseByteBackups(
      config,
      credentials,
      next,
    ).observe(f.scope, f.receipt, output.stream);
    assert.equal(receipt.versionId, 'exact-version');
    assert.equal(receipt.artifact.sha256, f.receipt.sha256);
    assert.equal(receipt.kind, 'EXACT_VERSION_READBACK');
    assert.deepEqual(p.calls, ['create', 'part', 'part', 'complete', 'get']);
    const restored = sink();
    await openDatabaseByteBackupToQuarantine(
      f.scope,
      source(Buffer.concat(output.chunks)),
      restored.stream,
      receipt.artifact.sha256,
      f.keys,
    );
    assert.equal(
      hash(Buffer.concat(restored.chunks)).toString('hex'),
      f.scope.databaseSha256,
    );
  } finally {
    first.destroy();
    next.destroy();
    f.retained.fill(0);
  }
});
test('publish success requires readback and conditional completion never overwrites an existing key', async () => {
  const f = await fixture(256),
    p = provider(),
    sdk = p.sdk();
  try {
    const store = new S3DatabaseByteBackups(config, credentials, sdk);
    const receipt = await store.publish(f.scope, f.receipt, source(f.archive));
    assert.equal(receipt.versionId, 'exact-version');
    assert.deepEqual(p.calls, ['create', 'part', 'complete', 'get']);
    await assert.rejects(store.publish(f.scope, f.receipt, source(f.archive)));
    assert.equal(p.calls.filter((x) => x === 'complete').length, 2);
  } finally {
    sdk.destroy();
    f.retained.fill(0);
  }
});
test('part checksum failures, embedded completion errors and bad source bytes never become success or retries', async () => {
  const f = await fixture(256);
  try {
    for (const kind of ['part', 'complete', 'digest', 'plaintext'] as const) {
      const p = provider(),
        sdk = p.sdk();
      p.bad = kind === 'part';
      p.error = kind === 'complete';
      const artifact =
        kind === 'digest'
          ? { ...f.receipt, sha256: '0'.repeat(64) }
          : f.receipt;
      try {
        await assert.rejects(
          new S3DatabaseByteBackups(config, credentials, sdk).publish(
            f.scope,
            artifact,
            source(
              kind === 'plaintext' ? Buffer.from('PGDMPunwrapped') : f.archive,
            ),
          ),
        );
        assert.ok(p.calls.filter((x) => x === 'complete').length <= 1);
        if (kind !== 'complete') assert.ok(!p.calls.includes('complete'));
        if (kind === 'plaintext') assert.equal(p.calls.length, 0);
      } finally {
        sdk.destroy();
      }
    }
  } finally {
    f.retained.fill(0);
  }
});
test('readback refuses unversioned, deleted, wrong encryption/checksum/length metadata and provider-consistent byte substitution', async () => {
  const f = await fixture(256),
    p = provider(),
    sdk = p.sdk(),
    store = new S3DatabaseByteBackups(config, credentials, sdk);
  try {
    await store.publish(f.scope, f.receipt, source(f.archive));
    for (const change of [
      { 'x-amz-version-id': 'null' },
      { 'x-amz-delete-marker': 'true' },
      { 'x-amz-server-side-encryption-aws-kms-key-id': arn('4') },
      { 'x-amz-checksum-type': 'FULL_OBJECT' },
      { 'content-length': String(f.receipt.byteLength + 1) },
      { 'x-amz-checksum-sha256': 'bad' },
    ]) {
      Object.assign(p.metadata, change);
      const output = sink();
      await assert.rejects(store.observe(f.scope, f.receipt, output.stream));
      assert.ok(output.stream.destroyed);
      for (const key of Object.keys(p.metadata)) delete p.metadata[key];
    }
    const part = p.parts.get(1)!;
    part.body[part.body.length - 20] ^= 1;
    p.metadata['x-amz-checksum-sha256'] =
      hash(hash(part.body)).toString('base64') + '-1';
    await assert.rejects(store.observe(f.scope, f.receipt, sink().stream));
    assert.equal(p.calls.filter((call) => call === 'complete').length, 1);
  } finally {
    sdk.destroy();
    f.retained.fill(0);
  }
});
test('wrong scope and header substitution are refused before the first provider write', async () => {
  const f = await fixture(256),
    p = provider(),
    sdk = p.sdk();
  try {
    const store = new S3DatabaseByteBackups(config, credentials, sdk);
    for (const changed of [
      { ...f.scope, installationId: 'other' },
      { ...f.scope, setId: '99999999-9999-4999-8999-999999999999' },
    ]) {
      await assert.rejects(
        store.publish(changed, f.receipt, source(f.archive)),
      );
    }
    assert.equal(p.calls.length, 0);
  } finally {
    sdk.destroy();
    f.retained.fill(0);
  }
});
test('deadline rejects a stalled GET and destroys a body that arrives after cancellation', async (t) => {
  const f = await fixture(256);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sdk = new S3Client({ region: 'eu-west-1', credentials });
  let calls = 0,
    finish!: (value: { Body: Readable }) => void;
  const delayed = new Promise<{ Body: Readable }>((resolve) => {
    finish = resolve;
  });
  sdk.send = (() => {
    calls++;
    return delayed;
  }) as typeof sdk.send;
  try {
    const output = sink(),
      store = new S3DatabaseByteBackups(config, credentials, sdk);
    const pending = assert.rejects(
      store.observe(f.scope, f.receipt, output.stream),
    );
    t.mock.timers.tick(60000);
    await pending;
    const late = new Readable({
      read() {},
      destroy(_error, callback) {
        callback(new Error('synthetic late body fault'));
      },
    });
    finish({ Body: late });
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(late.destroyed && output.stream.destroyed);
    assert.equal(calls, 1);
  } finally {
    sdk.destroy();
    f.retained.fill(0);
  }
});
test('stalled body and pre-cancelled caller have bounded failure paths', async (t) => {
  const f = await fixture(256),
    p = provider(),
    sdk = p.sdk();
  try {
    const store = new S3DatabaseByteBackups(config, credentials, sdk);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      store.observe(
        f.scope,
        f.receipt,
        sink().stream,
        undefined,
        controller.signal,
      ),
    );
    assert.equal(p.calls.length, 0);
    await store.publish(f.scope, f.receipt, source(f.archive));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const body = new Readable({ read() {} }),
      paused = new S3Client({ region: 'eu-west-1', credentials });
    paused.send = (() =>
      Promise.resolve({
        Body: body,
        VersionId: 'exact-version',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: config.storageKeyArn,
        ContentLength: f.receipt.byteLength,
        ChecksumType: 'COMPOSITE',
        ChecksumSHA256: hash(hash(f.archive)).toString('base64') + '-1',
      })) as typeof paused.send;
    try {
      const output = sink(),
        expected = { ...f.receipt };
      const pending = assert.rejects(
        new S3DatabaseByteBackups(config, credentials, paused).observe(
          f.scope,
          expected,
          output.stream,
        ),
      );
      expected.sha256 = '0'.repeat(64);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      t.mock.timers.tick(60000);
      await pending;
      assert.ok(body.destroyed && output.stream.destroyed);
    } finally {
      paused.destroy();
    }
  } finally {
    sdk.destroy();
    f.retained.fill(0);
  }
});
test('caller mutation during provider IO cannot change the bound archive scope or receipt', async () => {
  const f = await fixture(256),
    p = provider(),
    sdk = p.sdk(),
    expected = { ...f.receipt },
    scope = { ...f.scope };
  p.created = () => {
    expected.sha256 = '0'.repeat(64);
    scope.setId = '99999999-9999-4999-8999-999999999999';
  };
  try {
    const receipt = await new S3DatabaseByteBackups(
      config,
      credentials,
      sdk,
    ).publish(scope, expected, source(f.archive));
    assert.equal(receipt.artifact.sha256, f.receipt.sha256);
    assert.ok(receipt.objectKey.includes(f.scope.setId));
  } finally {
    sdk.destroy();
    f.retained.fill(0);
  }
});
test('completion has a longer fixed deadline and a late acknowledgement cannot cause another write', async (t) => {
  const f = await fixture(256);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sdk = new S3Client({ region: 'eu-west-1', credentials }),
    calls: string[] = [];
  const objectKey = `business-data/${f.scope.installationId}/${f.scope.setId}/database/${f.scope.databaseIdentitySha256}.bin`;
  let entered!: () => void, finish!: (value: object) => void;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    delayed = new Promise<object>((resolve) => {
      finish = resolve;
    });
  const encryption = {
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: config.storageKeyArn,
  };
  sdk.send = ((command: unknown) => {
    if (command instanceof CreateMultipartUploadCommand) {
      calls.push('create');
      return Promise.resolve({
        ...encryption,
        Bucket: config.bucket,
        Key: objectKey,
        UploadId: 'original-upload',
      });
    }
    if (command instanceof UploadPartCommand) {
      calls.push('part');
      return Promise.resolve({
        ...encryption,
        ETag: '"part"',
        ChecksumSHA256: command.input.ChecksumSHA256,
      });
    }
    assert.ok(command instanceof CompleteMultipartUploadCommand);
    calls.push('complete');
    entered();
    return delayed;
  }) as typeof sdk.send;
  try {
    const pending = assert.rejects(
      new S3DatabaseByteBackups(config, credentials, sdk).publish(
        f.scope,
        f.receipt,
        source(f.archive),
      ),
    );
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await ready;
    t.mock.timers.tick(179999);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await pending;
    finish({
      ...encryption,
      Bucket: config.bucket,
      Key: objectKey,
      VersionId: 'late-version',
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls, ['create', 'part', 'complete']);
  } finally {
    sdk.destroy();
    f.retained.fill(0);
  }
});
test('successful observation preserves unread bytes in a finished quarantine bridge', async () => {
  const f = await fixture(256),
    p = provider(),
    sdk = p.sdk();
  const bridge = new PassThrough({ highWaterMark: 65536 });
  try {
    const store = new S3DatabaseByteBackups(config, credentials, sdk);
    const saved = await store.publish(f.scope, f.receipt, source(f.archive));
    await store.observe(f.scope, f.receipt, bridge, saved.versionId);
    assert.equal(bridge.destroyed, false);
    const chunks: Buffer[] = [];
    for await (const bytes of bridge) chunks.push(Buffer.from(bytes));
    assert.equal(hash(Buffer.concat(chunks)).toString('hex'), f.receipt.sha256);
  } finally {
    bridge.destroy();
    sdk.destroy();
    f.retained.fill(0);
  }
});
