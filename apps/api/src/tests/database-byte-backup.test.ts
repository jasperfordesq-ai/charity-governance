import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { KMSClient } from '@aws-sdk/client-kms';
import {
  DATABASE_BACKUP_MAX_BYTES,
  databaseBackupContext,
  sealDatabaseByteBackup,
  openDatabaseByteBackupToQuarantine,
  type DatabaseBackupKeys,
} from '../services/database-byte-backup.js';
import { KmsDatabaseBackupKeys } from '../services/database-byte-backup-kms.js';

const dump = Buffer.concat([
  Buffer.from('PGDMP'),
  randomBytes(2 * 1024 * 1024),
]);
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const scope = {
  installationId: 'fixture',
  setId: '11111111-1111-4111-8111-111111111111',
  sourceSha: 'a'.repeat(40),
  databaseIdentitySha256: 'b'.repeat(64),
  sourceCaptureReportSha256: 'c'.repeat(64),
  databaseSha256: sha(dump),
  byteLength: dump.length,
  keyArn:
    'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-4222-8222-222222222222',
};
const input = (body: Buffer) =>
  Readable.from(
    (function* () {
      for (let offset = 0; offset < body.length; offset += 4093)
        yield body.subarray(offset, offset + 4093);
    })(),
  );
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
function keys() {
  const retained = randomBytes(32),
    issued: Buffer[] = [];
  const provider: DatabaseBackupKeys = {
    async generate(context) {
      const key = Buffer.from(retained);
      issued.push(key);
      return {
        key,
        keyArn: context.keyArn,
        wrappedKey: Buffer.from('synthetic-wrapped-db-key').toString('base64'),
      };
    },
    async unwrap(_wrapped, context) {
      const key = Buffer.from(retained);
      issued.push(key);
      return { key, keyArn: context.keyArn };
    },
  };
  return { provider, issued };
}
test('bounded database archive round trips exact custom-format bytes and clears owned keys', async () => {
  const k = keys(),
    output = sink();
  const sealed = await sealDatabaseByteBackup(
    scope,
    input(dump),
    output.stream,
    k.provider,
  );
  const archive = Buffer.concat(output.chunks);
  assert.equal(sha(archive), sealed.sha256);
  assert.equal(archive.length, sealed.byteLength);
  assert.ok(!archive.includes(dump.subarray(32, 96)));
  const restored = sink();
  const receipt = await openDatabaseByteBackupToQuarantine(
    scope,
    Readable.from(output.chunks),
    restored.stream,
    sealed.sha256,
    k.provider,
  );
  assert.deepEqual(Buffer.concat(restored.chunks), dump);
  assert.equal(receipt.databaseSha256, scope.databaseSha256);
  assert.ok(k.issued.every((key) => key.every((byte) => byte === 0)));
});
test('wrong source bytes, non-custom dump and truncated sources never yield a successful sealed artifact', async () => {
  for (const body of [
    dump.subarray(0, dump.length - 1),
    Buffer.concat([dump, Buffer.from('extra')]),
    Buffer.alloc(dump.length),
  ]) {
    const k = keys(),
      output = sink();
    await assert.rejects(
      sealDatabaseByteBackup(scope, input(body), output.stream, k.provider),
    );
    assert.ok(output.stream.destroyed);
    assert.ok(k.issued.every((key) => key.every((byte) => byte === 0)));
  }
});
test('tamper, wrong external digest, appended bytes, truncation and changed scope refuse quarantine admission', async () => {
  const k = keys(),
    output = sink();
  const sealed = await sealDatabaseByteBackup(
    scope,
    input(dump),
    output.stream,
    k.provider,
  );
  const archive = Buffer.concat(output.chunks),
    tampered = Buffer.from(archive);
  tampered[tampered.length - 20] ^= 1;
  for (const body of [
    tampered,
    archive.subarray(0, archive.length - 1),
    Buffer.concat([archive, Buffer.from('extra')]),
  ]) {
    const target = sink();
    await assert.rejects(
      openDatabaseByteBackupToQuarantine(
        scope,
        input(body),
        target.stream,
        sha(body),
        k.provider,
      ),
    );
    assert.ok(target.stream.destroyed);
  }
  for (const changed of [
    { ...scope, installationId: 'other' },
    { ...scope, databaseSha256: 'd'.repeat(64) },
  ]) {
    await assert.rejects(
      openDatabaseByteBackupToQuarantine(
        changed,
        input(archive),
        sink().stream,
        sealed.sha256,
        k.provider,
      ),
    );
  }
  await assert.rejects(
    openDatabaseByteBackupToQuarantine(
      scope,
      input(archive),
      sink().stream,
      '0'.repeat(64),
      k.provider,
    ),
  );
});
test('cancellation, broken output and invalid key material fail closed', async () => {
  const k = keys(),
    controller = new AbortController();
  controller.abort();
  const source = input(dump),
    output = sink();
  await assert.rejects(
    sealDatabaseByteBackup(
      scope,
      source,
      output.stream,
      k.provider,
      controller.signal,
    ),
  );
  assert.ok(source.destroyed && output.stream.destroyed);
  assert.equal(k.issued.length, 0);
  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('synthetic private destination fault'));
    },
  });
  await assert.rejects(
    sealDatabaseByteBackup(scope, input(dump), broken, k.provider),
    /Database byte backup unavailable/,
  );
  const badKey = Buffer.alloc(31, 1);
  await assert.rejects(
    sealDatabaseByteBackup(scope, input(dump), sink().stream, {
      ...k.provider,
      async generate(c) {
        return { key: badKey, keyArn: c.keyArn, wrappedKey: 'YQ==' };
      },
    }),
  );
  assert.ok(badKey.every((byte) => byte === 0));
});
test('stalled source cancellation destroys both streams and releases the data key', async () => {
  const k = keys(),
    controller = new AbortController(),
    source = new Readable({ read() {} }),
    output = sink();
  const pending = sealDatabaseByteBackup(
    scope,
    source,
    output.stream,
    k.provider,
    controller.signal,
  );
  const rejected = assert.rejects(pending);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await rejected;
  assert.ok(source.destroyed && output.stream.destroyed);
  assert.ok(k.issued.length === 1 && k.issued[0].every((byte) => byte === 0));
  const decryptSource = new Readable({ read() {} }),
    decryptOutput = sink(),
    second = new AbortController();
  const opening = assert.rejects(
    openDatabaseByteBackupToQuarantine(
      scope,
      decryptSource,
      decryptOutput.stream,
      'a'.repeat(64),
      k.provider,
      second.signal,
    ),
  );
  second.abort();
  await opening;
  assert.ok(decryptSource.destroyed && decryptOutput.stream.destroyed);
});
test('unbounded chunks and oversized headers are rejected', async () => {
  const k = keys();
  await assert.rejects(
    sealDatabaseByteBackup(
      scope,
      Readable.from([dump]),
      sink().stream,
      k.provider,
    ),
  );
  const output = sink(),
    sealed = await sealDatabaseByteBackup(
      scope,
      input(dump),
      output.stream,
      k.provider,
    );
  const archive = Buffer.concat(output.chunks);
  archive.writeUInt32BE(
    0x7fffffff,
    Buffer.byteLength('CHARITYPILOT_DATABASE_BYTES_V1\n'),
  );
  await assert.rejects(
    openDatabaseByteBackupToQuarantine(
      scope,
      input(archive),
      sink().stream,
      sealed.sha256,
      k.provider,
    ),
  );
});
test('database KMS refuses wrong response keys, sizes and algorithms and clears rejected SDK plaintext', async () => {
  const credentials = {
    accessKeyId: 'synthetic',
    secretAccessKey: 'synthetic',
  };
  for (const response of [
    {
      KeyId: scope.keyArn + '0',
      Plaintext: Buffer.alloc(32, 1),
      CiphertextBlob: Buffer.from('wrapped'),
    },
    {
      KeyId: scope.keyArn,
      Plaintext: Buffer.alloc(31, 1),
      CiphertextBlob: Buffer.from('wrapped'),
    },
    {
      KeyId: scope.keyArn,
      Plaintext: Buffer.alloc(32, 1),
      CiphertextBlob: Buffer.alloc(0),
    },
  ]) {
    const client = new KMSClient({ region: 'eu-west-1', credentials });
    client.send = (() => Promise.resolve(response)) as typeof client.send;
    await assert.rejects(
      new KmsDatabaseBackupKeys(scope.keyArn, credentials, client).generate(
        scope,
      ),
    );
    assert.ok(response.Plaintext.every((byte) => byte === 0));
    client.destroy();
  }
  const response = {
    KeyId: scope.keyArn,
    Plaintext: Buffer.alloc(32, 1),
    EncryptionAlgorithm: 'wrong',
  };
  const client = new KMSClient({ region: 'eu-west-1', credentials });
  client.send = (() => Promise.resolve(response)) as typeof client.send;
  await assert.rejects(
    new KmsDatabaseBackupKeys(scope.keyArn, credentials, client).unwrap(
      'YQ==',
      scope,
    ),
  );
  assert.ok(response.Plaintext.every((byte) => byte === 0));
  client.destroy();
});
test('chunk order and length are authenticated before a frame reaches quarantine', async () => {
  const k = keys(),
    output = sink(),
    sealed = await sealDatabaseByteBackup(
      scope,
      input(dump),
      output.stream,
      k.provider,
    );
  const archive = Buffer.concat(output.chunks),
    magicLength = Buffer.byteLength('CHARITYPILOT_DATABASE_BYTES_V1\n');
  const start = magicLength + 4 + archive.readUInt32BE(magicLength),
    size = 4 + 1024 * 1024 + 16;
  const reordered = Buffer.concat([
    archive.subarray(0, start),
    archive.subarray(start + size, start + 2 * size),
    archive.subarray(start, start + size),
    archive.subarray(start + 2 * size),
  ]);
  const target = sink();
  await assert.rejects(
    openDatabaseByteBackupToQuarantine(
      scope,
      input(reordered),
      target.stream,
      sha(reordered),
      k.provider,
    ),
  );
  assert.equal(target.chunks.length, 0);
  const wrongSize = Buffer.from(archive);
  wrongSize.writeUInt32BE(0xffffffff, start);
  await assert.rejects(
    openDatabaseByteBackupToQuarantine(
      scope,
      input(wrongSize),
      sink().stream,
      sha(wrongSize),
      k.provider,
    ),
  );
  assert.equal(
    databaseBackupContext({ ...scope, byteLength: DATABASE_BACKUP_MAX_BYTES })
      .byteLength,
    DATABASE_BACKUP_MAX_BYTES,
  );
  assert.throws(() =>
    databaseBackupContext({
      ...scope,
      byteLength: DATABASE_BACKUP_MAX_BYTES + 1,
    }),
  );
  assert.ok(sealed.sha256);
});
test('reader snapshots borrowed bytes before awaiting the unwrap provider', async () => {
  const tiny = Buffer.from('PGDMPsynthetic fixture'),
    context = { ...scope, databaseSha256: sha(tiny), byteLength: tiny.length };
  const k = keys(),
    output = sink(),
    sealed = await sealDatabaseByteBackup(
      context,
      input(tiny),
      output.stream,
      k.provider,
    );
  const archive = Buffer.concat(output.chunks),
    target = sink();
  const fragmented = sink();
  await openDatabaseByteBackupToQuarantine(
    context,
    Readable.from(Array.from(archive, (byte) => Buffer.from([byte]))),
    fragmented.stream,
    sealed.sha256,
    k.provider,
  );
  assert.deepEqual(Buffer.concat(fragmented.chunks), tiny);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const opening = openDatabaseByteBackupToQuarantine(
    context,
    Readable.from([archive]),
    target.stream,
    sealed.sha256,
    {
      ...k.provider,
      async unwrap(wrapped, c) {
        entered();
        await gate;
        return k.provider.unwrap(wrapped, c);
      },
    },
  );
  await ready;
  archive.fill(0);
  release();
  await opening;
  assert.deepEqual(Buffer.concat(target.chunks), tiny);
});
test('late database KMS response after timeout clears its returned plaintext without retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new KMSClient({
    region: 'eu-west-1',
    credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
  });
  type Late = { KeyId: string; Plaintext: Buffer; CiphertextBlob: Buffer };
  let finish!: (value: Late) => void,
    calls = 0;
  const response = new Promise<Late>((resolve) => {
    finish = resolve;
  });
  client.send = (() => {
    calls++;
    return response;
  }) as typeof client.send;
  const provider = new KmsDatabaseBackupKeys(
    scope.keyArn,
    { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
    client,
  );
  const pending = assert.rejects(provider.generate(scope));
  t.mock.timers.tick(15000);
  await pending;
  const plaintext = Buffer.alloc(32, 8);
  finish({
    KeyId: scope.keyArn,
    Plaintext: plaintext,
    CiphertextBlob: Buffer.from('wrapped'),
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(plaintext.every((byte) => byte === 0));
  assert.equal(calls, 1);
  client.destroy();
});
