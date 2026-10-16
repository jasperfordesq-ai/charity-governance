import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { KmsRecoveryDataKeyRing, KmsRecoveryDataKeys } from '../services/recovery-data-keys-kms.js';
const currentKey = 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111';
const oldKey = 'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-4222-8222-222222222222';
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const current = { installationId: 'install', organisationId: 'charity', operationId: 'current-op',
 writerEpoch: 2, sourceRevision: 'b'.repeat(40), keyId: currentKey };
const historical = { ...current, operationId: 'original-op', writerEpoch: 1, sourceRevision: 'a'.repeat(40), keyId: oldKey };

test('key ring generates only with current key and unwraps both original contexts with their exact configured keys', async t => {
 const calls: { key: string; context: unknown; generation: boolean }[] = [], sdkBuffers: Uint8Array[] = [];
 const client = new KMSClient({ region: 'eu-west-1', credentials });
 t.mock.method(client,'send',async (command: unknown) => {
  assert.ok(command instanceof GenerateDataKeyCommand || command instanceof DecryptCommand);
  calls.push({ key: command.input.KeyId!,context: command.input.EncryptionContext,generation: command instanceof GenerateDataKeyCommand });
  const Plaintext = new Uint8Array(32).fill(7); sdkBuffers.push(Plaintext);
  return { KeyId: command.input.KeyId, Plaintext, ...(command instanceof GenerateDataKeyCommand
   ? { CiphertextBlob: Uint8Array.from([1,2,3]) } : { EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' }) };
 });
 try {
  const ring = new KmsRecoveryDataKeyRing(currentKey,[oldKey],credentials,client);
  const generated = await ring.generate(current), recent = await ring.unwrap('AQID',current), old = await ring.unwrap('AQID',historical);
  assert.equal(generated.keyId,currentKey); assert.equal(recent.keyId,currentKey); assert.equal(old.keyId,oldKey);
  assert.deepEqual(calls.map(call => [call.key,call.generation]),[[currentKey,true],[currentKey,false],[oldKey,false]]);
  assert.deepEqual(calls[2]!.context,{ purpose: 'charitypilot-complaint-recovery-v1', installationId: historical.installationId,
   organisationId: historical.organisationId,operationId: historical.operationId,writerEpoch: '1',sourceRevision: historical.sourceRevision });
  assert.ok(sdkBuffers.every(bytes => bytes.every(byte => byte === 0)));
  for (const key of [generated.key,recent.key,old.key]) { assert.deepEqual(key,Buffer.alloc(32,7)); key.fill(0); }
  await assert.rejects(new KmsRecoveryDataKeys(currentKey,credentials,client).unwrap('AQID',historical));
  assert.equal(calls.length,3);
 } finally { client.destroy(); }
});
test('key ring refuses old-key generation, unknown keys and malformed context before transport; configuration is copied', async t => {
 let calls = 0; const client = new KMSClient({ region: 'eu-west-1',credentials });
 t.mock.method(client,'send',async () => { calls++; throw new Error('PRIVATE-TRANSPORT'); });
 try {
  const configured = [oldKey], ring = new KmsRecoveryDataKeyRing(currentKey,configured,credentials,client);
  const unknownKey = oldKey.replace('22222222-','33333333-'); configured.push(unknownKey);
  await assert.rejects(ring.generate(historical));
  await assert.rejects(ring.unwrap('AQID',{ ...historical,keyId: unknownKey }));
  await assert.rejects(ring.unwrap('AQID',{ ...historical,operationId: '../escape' }));
  await assert.rejects(ring.unwrap('AQID\n',historical));
  assert.equal(calls,0);
  await assert.rejects(ring.unwrap('AQID',historical),error => { assert.equal(String(error).includes('PRIVATE-TRANSPORT'),false); return true; });
  assert.equal(calls,1);
 } finally { client.destroy(); }
});
test('key ring rejects duplicate, oversized, non-Ireland and missing-credential configuration', () => {
 for (const keys of [[oldKey,oldKey],[currentKey],Array.from({length:32},() => oldKey),[oldKey.replace('eu-west-1','eu-west-2')]]) {
  assert.throws(() => new KmsRecoveryDataKeyRing(currentKey,keys,credentials));
 }
 assert.throws(() => new KmsRecoveryDataKeyRing(currentKey,[],undefined as never));
 assert.throws(() => new KmsRecoveryDataKeyRing('alias/current',[],credentials));
});
test('historical key failure does not fall back to another key and clears rejected provider plaintext', async t => {
 const client = new KMSClient({ region: 'eu-west-1',credentials }); let calls = 0;
 const Plaintext = new Uint8Array(32).fill(8);
 t.mock.method(client,'send',async (command: unknown) => { calls++; assert.ok(command instanceof DecryptCommand);
  assert.equal(command.input.KeyId,oldKey); return { KeyId: currentKey,Plaintext,EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' }; });
 try {
  const ring = new KmsRecoveryDataKeyRing(currentKey,[oldKey],credentials,client);
  await assert.rejects(ring.unwrap('AQID',historical)); assert.equal(calls,1); assert.ok(Plaintext.every(byte => byte === 0));
 } finally { client.destroy(); }
});

test('historical unwrap retains deadline cancellation and clears a late provider response', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const client = new KMSClient({ region: 'eu-west-1',credentials });
 let resolve!: (value: unknown) => void; let signal: AbortSignal | undefined; let calls = 0;
 t.mock.method(client,'send',(_command: unknown, options?: { abortSignal?: AbortSignal }) => {
  calls++; signal = options?.abortSignal; return new Promise(done => { resolve = done; });
 });
 try {
  const ring = new KmsRecoveryDataKeyRing(currentKey,[oldKey],credentials,client);
  const refusal = assert.rejects(ring.unwrap('AQID',historical));
  t.mock.timers.tick(15001); await refusal; assert.equal(signal?.aborted,true); assert.equal(calls,1);
  const Plaintext = new Uint8Array(32).fill(9);
  resolve({ KeyId: oldKey,Plaintext,EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' });
  await Promise.resolve(); await Promise.resolve(); assert.ok(Plaintext.every(byte => byte === 0));
 } finally { client.destroy(); }
});
