import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Readable } from 'node:stream';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { KmsRecoveryDataKeys } from '../services/recovery-data-keys-kms.js';

const keyId = 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111';
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const context = { installationId: 'install', organisationId: 'charity', operationId: 'operation',
  writerEpoch: 1, sourceRevision: 'a'.repeat(40), keyId };
function provider(handler: (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>) {
  const client = new KMSClient({ region: 'eu-west-1', credentials });
  mock.method(client, 'send', handler);
  return new KmsRecoveryDataKeys(keyId, credentials, client);
}

test('KMS generation and unwrap pin the exact key and matching recovery context', async () => {
  const sdkBuffers: Uint8Array[] = []; const contexts: unknown[] = [];
  const keys = provider(async command => {
    assert.ok(command instanceof GenerateDataKeyCommand || command instanceof DecryptCommand);
    assert.equal(command.input.KeyId, keyId); contexts.push(command.input.EncryptionContext);
    const Plaintext = new Uint8Array(32).fill(7); sdkBuffers.push(Plaintext);
    if (command instanceof GenerateDataKeyCommand) {
      assert.equal(command.input.KeySpec, 'AES_256'); assert.equal(command.input.NumberOfBytes, undefined);
      return { KeyId: keyId, Plaintext, CiphertextBlob: Uint8Array.from([1, 2, 3]) };
    }
    assert.equal(command.input.EncryptionAlgorithm, 'SYMMETRIC_DEFAULT');
    assert.deepEqual([...command.input.CiphertextBlob!], [1, 2, 3]);
    return { KeyId: keyId, Plaintext, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' };
  });
  const generated = await keys.generate(context);
  assert.deepEqual(generated.key, Buffer.alloc(32, 7));
  const opened = await keys.unwrap(generated.wrappedKey, context);
  assert.deepEqual(opened.key, Buffer.alloc(32, 7)); assert.equal(generated.keyId, keyId);
  assert.deepEqual(contexts[0], contexts[1]);
  assert.deepEqual(contexts[0], { purpose: 'charitypilot-complaint-recovery-v1', installationId: 'install',
    organisationId: 'charity', operationId: 'operation', writerEpoch: '1', sourceRevision: 'a'.repeat(40) });
  assert.ok(sdkBuffers.every(buffer => buffer.every(byte => byte === 0)));
  generated.key.fill(0); opened.key.fill(0);
});

test('the KMS SDK signs and serializes the pinned key and context without network access', async () => {
  let requests = 0;
  const client = new KMSClient({ region: 'eu-west-1', credentials, maxAttempts: 1,
    endpoint: 'https://kms.eu-west-1.amazonaws.com', requestHandler: {
      async handle(request: { protocol: string; hostname: string; headers: Record<string, string>; body?: unknown }) {
        requests++;
        assert.equal(request.protocol, 'https:'); assert.equal(request.hostname, 'kms.eu-west-1.amazonaws.com');
        assert.ok(request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 '));
        assert.ok(typeof request.body === 'string' || request.body instanceof Uint8Array);
        const body = JSON.parse(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
        assert.equal(body.KeyId, keyId);
        assert.equal(body.EncryptionContext.purpose, 'charitypilot-complaint-recovery-v1');
        assert.equal(body.EncryptionContext.operationId, context.operationId);
        const generation = request.headers['x-amz-target'].endsWith('.GenerateDataKey');
        if (generation) assert.equal(body.KeySpec, 'AES_256');
        else { assert.equal(body.CiphertextBlob, 'AQID'); assert.equal(body.EncryptionAlgorithm, 'SYMMETRIC_DEFAULT'); }
        return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' },
          body: Readable.from([Buffer.from(JSON.stringify({ KeyId: keyId, Plaintext: Buffer.alloc(32, 4).toString('base64'),
            ...(generation ? { CiphertextBlob: 'AQID' } : { EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' }) }))]) } };
      },
    } });
  try {
    const keys = new KmsRecoveryDataKeys(keyId, credentials, client);
    const generated = await keys.generate(context);
    const opened = await keys.unwrap(generated.wrappedKey, context);
    assert.deepEqual(opened.key, generated.key); assert.equal(requests, 2);
    generated.key.fill(0); opened.key.fill(0);
  } finally { client.destroy(); }
});

test('KMS refuses foreign contexts and noncanonical wrapped blobs before transport', async () => {
  let calls = 0; const keys = provider(async () => { calls++; return {}; });
  await assert.rejects(() => keys.generate({ ...context, keyId: keyId.replace('123456789012', '123456789013') }));
  await assert.rejects(() => keys.generate({ ...context, operationId: '../escape' }));
  for (const blob of ['', 'AQID\n', 'x'.repeat(8193)]) await assert.rejects(() => keys.unwrap(blob, context));
  assert.equal(calls, 0);
});

test('KMS invalid response keys are cleared and provider details never escape', async () => {
  for (const change of [{ KeyId: 'wrong' }, { CiphertextBlob: new Uint8Array() },
    { CiphertextBlob: new Uint8Array(6145) }, { Plaintext: new Uint8Array(31).fill(9) }]) {
    const response = { KeyId: keyId, Plaintext: new Uint8Array(32).fill(9), CiphertextBlob: new Uint8Array([1]), ...change };
    const keys = provider(async () => response);
    await assert.rejects(() => keys.generate(context), { message: 'Recovery data key could not be generated' });
    assert.ok(response.Plaintext.every(byte => byte === 0));
  }
  const plaintext = new Uint8Array(32).fill(9);
  const wrongAlgorithm = provider(async () => ({ KeyId: keyId, Plaintext: plaintext, EncryptionAlgorithm: 'RSAES_OAEP_SHA_256' }));
  await assert.rejects(() => wrongAlgorithm.unwrap('AQID', context));
  assert.ok(plaintext.every(byte => byte === 0));
  const unavailable = provider(async () => { throw new Error('sensitive provider response'); });
  await assert.rejects(() => unavailable.generate(context), error => {
    assert.equal((error as Error).message, 'Recovery data key could not be generated');
    assert.equal((error as Error).cause, undefined); return true;
  });
});

test('KMS bounds ignored cancellation and clears a late plaintext response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve!: (value: unknown) => void; let signal: AbortSignal | undefined;
  const keys = provider((_command, options) => {
    signal = options?.abortSignal; return new Promise(done => { resolve = done; });
  });
  const refusal = assert.rejects(() => keys.generate(context), /could not be generated/);
  t.mock.timers.tick(15001); await refusal;
  assert.equal(signal?.aborted, true);
  const Plaintext = new Uint8Array(32).fill(8);
  resolve({ KeyId: keyId, Plaintext, CiphertextBlob: new Uint8Array([1]) });
  await Promise.resolve(); await Promise.resolve();
  assert.ok(Plaintext.every(byte => byte === 0));
});
