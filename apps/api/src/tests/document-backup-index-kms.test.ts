import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { KMSClient } from '@aws-sdk/client-kms';
import { KmsDocumentBackupIndexMac } from '../services/document-backup-index-kms.js';

const keyArn =
  'arn:aws:kms:eu-west-1:123456789012:key/33333333-3333-4333-8333-333333333333';
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const message = Buffer.from(
  'CHARITYPILOT_DOCUMENT_BACKUP_INDEX_V1\n' + 'a'.repeat(64),
);
type Request = {
  hostname: string;
  protocol: string;
  headers: Record<string, string>;
  body?: unknown;
};
function client(
  handler: (
    body: Record<string, string>,
    operation: string,
  ) => object | Promise<object>,
) {
  return new KMSClient({
    region: 'eu-west-1',
    endpoint: 'https://kms.eu-west-1.amazonaws.com',
    credentials,
    maxAttempts: 1,
    requestHandler: {
      async handle(request: Request) {
        assert.equal(request.hostname, 'kms.eu-west-1.amazonaws.com');
        assert.equal(request.protocol, 'https:');
        assert.match(request.headers.authorization, /AWS4-HMAC-SHA256/);
        const body = JSON.parse(
          typeof request.body === 'string'
            ? request.body
            : new TextDecoder().decode(request.body as Uint8Array),
        );
        assert.equal(body.KeyId, keyArn);
        assert.equal(body.MacAlgorithm, 'HMAC_SHA_256');
        const response = await handler(body, request.headers['x-amz-target']);
        return {
          response: {
            statusCode: 200,
            headers: { 'content-type': 'application/x-amz-json-1.1' },
            body: Readable.from([JSON.stringify(response)]),
          },
        };
      },
    },
  });
}
test('real SDK signing generates and verifies the domain-separated index MAC using fresh clients', async () => {
  const key = randomBytes(32),
    seen: string[] = [];
  const handler = (body: Record<string, string>, operation: string) => {
    seen.push(operation);
    assert.deepEqual(Buffer.from(body.Message, 'base64'), message);
    const mac = createHmac('sha256', key)
      .update(Buffer.from(body.Message, 'base64'))
      .digest('base64');
    return operation.endsWith('.GenerateMac')
      ? { KeyId: keyArn, MacAlgorithm: 'HMAC_SHA_256', Mac: mac }
      : {
          KeyId: keyArn,
          MacAlgorithm: 'HMAC_SHA_256',
          MacValid: mac === body.Mac,
        };
  };
  const transport = client(handler),
    nextTransport = client(handler);
  const original = new KmsDocumentBackupIndexMac(
    keyArn,
    credentials,
    transport,
  );
  const tag = await original.generate(keyArn, message);
  const fresh = new KmsDocumentBackupIndexMac(
    keyArn,
    credentials,
    nextTransport,
  );
  assert.deepEqual(await fresh.verify(keyArn, message, tag.mac), {
    keyArn,
    valid: true,
  });
  assert.equal(seen.length, 2);
  await assert.rejects(fresh.verify(keyArn, message, Buffer.alloc(32)));
  assert.equal(seen.length, 3); // No retry after a failed MAC verification.
  transport.destroy();
  nextTransport.destroy();
  key.fill(0);
});
test('wrong keys, algorithms, short MACs, malformed inputs and false verification are refused', async () => {
  for (const response of [
    {
      KeyId: keyArn + '0',
      MacAlgorithm: 'HMAC_SHA_256',
      Mac: Buffer.alloc(32).toString('base64'),
    },
    {
      KeyId: keyArn,
      MacAlgorithm: 'HMAC_SHA_512',
      Mac: Buffer.alloc(32).toString('base64'),
    },
    {
      KeyId: keyArn,
      MacAlgorithm: 'HMAC_SHA_256',
      Mac: Buffer.alloc(31).toString('base64'),
    },
  ]) {
    const provider = new KmsDocumentBackupIndexMac(
      keyArn,
      credentials,
      client(() => response),
    );
    await assert.rejects(provider.generate(keyArn, message));
  }
  for (const response of [
    { KeyId: keyArn, MacAlgorithm: 'HMAC_SHA_256', MacValid: false },
    { KeyId: keyArn + '0', MacAlgorithm: 'HMAC_SHA_256', MacValid: true },
    { KeyId: keyArn, MacAlgorithm: 'HMAC_SHA_512', MacValid: true },
  ]) {
    const provider = new KmsDocumentBackupIndexMac(
      keyArn,
      credentials,
      client(() => response),
    );
    await assert.rejects(provider.verify(keyArn, message, Buffer.alloc(32)));
  }
  let calls = 0;
  const provider = new KmsDocumentBackupIndexMac(
    keyArn,
    credentials,
    client(() => {
      calls++;
      return {};
    }),
  );
  await assert.rejects(provider.generate(keyArn + '0', message));
  await assert.rejects(provider.generate(keyArn, Buffer.from('wrong-purpose')));
  await assert.rejects(provider.verify(keyArn, message, Buffer.alloc(31)));
  assert.equal(calls, 0);
});
test('provider calls have an outer deadline without retry even if the transport ignores abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const transport = new KMSClient({ region: 'eu-west-1', credentials });
  const original = transport.send.bind(transport);
  transport.send = (() => {
    calls++;
    return new Promise(() => {});
  }) as typeof original;
  const provider = new KmsDocumentBackupIndexMac(
    keyArn,
    credentials,
    transport,
  );
  const pending = provider.generate(keyArn, message),
    rejected = assert.rejects(pending, /authentication unavailable/);
  t.mock.timers.tick(15000);
  await rejected;
  assert.equal(calls, 1);
});
