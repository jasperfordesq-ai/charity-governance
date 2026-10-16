import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test, mock } from 'node:test';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { sealConfluenceExecutionArchiveV2 } from '../services/confluence-execution-archive-v2.js';
import { prepareConfluenceExecutionLedgerV2 } from '../services/confluence-execution-ledger-v2.js';
import { executionLedgerFixture } from './fixtures/confluence-execution-ledger-v2.js';
import { recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';

const config = { bucket: 'synthetic-execution-v2-test', accountId: '123456789012',
 kmsKeyArn: 'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-2222-2222-222222222222',
 replayKeyArn: context.keyId, installationId: context.installationId, organisationId: context.organisationId };
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const metadata = { VersionId: 'synthetic-version', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn };
const expectedKey = `confluence-execution-ledger-v2/${context.installationId}/${context.organisationId}/${context.writerEpoch}/${context.operationId}.json`;
async function envelope() {
 const binding = { context, observedControl: { format: 2, installationId: context.installationId,
  organisationId: context.organisationId, writerId: 'writer-a', writerEpoch: context.writerEpoch,
  generation: 0, digest: null, activeOperation: null, revision: 'synthetic-predecessor' } };
 return (await sealConfluenceExecutionArchiveV2(prepareConfluenceExecutionLedgerV2(executionLedgerFixture(), context).body,
  binding, { generate: async () => ({ key: Buffer.alloc(32, 7), keyId: context.keyId,
   wrappedKey: Buffer.from('synthetic-wrap').toString('base64') }),
   unwrap: async () => ({ key: Buffer.alloc(32, 7), keyId: context.keyId }) })).envelope;
}
function fixture(handler: (command: unknown) => Promise<unknown>) {
 const client = new S3Client({ region: 'eu-west-1', credentials }); mock.method(client, 'send', handler);
 return new S3AuthorityObjectStore(config, credentials, client);
}
function response(body: string, extra = {}) {
 return { ...metadata, ContentLength: Buffer.byteLength(body), Body: Readable.from([Buffer.from(body)]), ...extra };
}
test('V2 transport isolates epoch/version and sends conditional writes with account, checksum and KMS binding', async () => {
 const body = await envelope(); let saved = '';
 const store = fixture(async command => {
  assert.ok(command instanceof PutObjectCommand || command instanceof GetObjectCommand);
  assert.equal(command.input.Key, expectedKey); assert.equal(command.input.ExpectedBucketOwner, config.accountId);
  if (command instanceof PutObjectCommand) {
   assert.equal(command.input.IfNoneMatch, '*'); assert.equal(command.input.SSEKMSKeyId, config.kmsKeyArn);
   assert.equal(command.input.ServerSideEncryption, 'aws:kms'); assert.ok(command.input.ChecksumSHA256);
   saved = command.input.Body as string; return metadata;
  }
  assert.equal(command.input.ChecksumMode, 'ENABLED'); return response(saved);
 });
 assert.equal(await store.createExecutionLedgerV2(context, body), true);
 assert.equal(await store.readExecutionLedgerV2(context), body);
});
test('V2 rejects cross-tenant, operation, source, key, epoch and version substitutions before writes', async () => {
 const body = await envelope(); let calls = 0;
 const store = fixture(async () => { calls++; return metadata; });
 for (const change of [{ organisationId: 'other' }, { installationId: 'other' }, { operationId: 'other' },
  { sourceRevision: 'b'.repeat(40) }, { keyId: config.kmsKeyArn }, { writerEpoch: 2 }, { operationId: '../escape' }]) {
  await assert.rejects(store.createExecutionLedgerV2({ ...context, ...change }, body));
 }
 const wrong = JSON.parse(body); wrong.format = 1;
 await assert.rejects(store.createExecutionLedgerV2(context, JSON.stringify(wrong)));
 await assert.rejects(store.createConfluenceCopyLedger(context.operationId, body));
 await assert.rejects(store.createExecutionLedgerV2(context, body + ' '));
 assert.equal(calls, 0);
});
test('V2 reads never recreate missing objects or accept mismatched headers and storage metadata', async () => {
 const body = await envelope(); let calls = 0;
 const missing = fixture(async command => { calls++; assert.ok(command instanceof GetObjectCommand);
  throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }; });
 assert.equal(await missing.readExecutionLedgerV2(context), null); assert.equal(calls, 1);
 const wrong = JSON.parse(body); wrong.binding.context.sourceRevision = 'b'.repeat(40);
 for (const read of [() => response(JSON.stringify(wrong)), () => response(body, { VersionId: 'null' }),
  () => response(body, { SSEKMSKeyId: config.replayKeyArn }), () => response(body, { ContentLength: Buffer.byteLength(body) + 1 }),
  () => response(body, { DeleteMarker: true })]) {
  const store = fixture(async command => { assert.ok(command instanceof GetObjectCommand); return read(); });
  await assert.rejects(store.readExecutionLedgerV2(context));
 }
});
test('V2 conditional conflicts are not success and unknown writes are not retried', async () => {
 const body = await envelope(); let calls = 0;
 const conflict = fixture(async command => { calls++; assert.ok(command instanceof PutObjectCommand);
  throw { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }; });
 assert.equal(await conflict.createExecutionLedgerV2(context, body), false); assert.equal(calls, 1);
 for (const result of [() => { throw new Error('PRIVATE-TRANSPORT-DETAIL'); }, () => ({ ...metadata, VersionId: 'null' })]) {
  let writes = 0; const store = fixture(async () => { writes++; return result(); });
  await assert.rejects(store.createExecutionLedgerV2(context, body), error => {
   assert.equal(String(error).includes('PRIVATE-TRANSPORT-DETAIL'), false); return true;
  });
  assert.equal(writes, 1);
 }
});

test('V2 reads validate scope before IO and select a different object for a later epoch', async () => {
 let calls = 0;
 const store = fixture(async command => {
  calls++; assert.ok(command instanceof GetObjectCommand);
  assert.equal(command.input.Key, expectedKey.replace('/1/', '/2/'));
  throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
 });
 for (const change of [{ organisationId: 'other' }, { installationId: 'other' }, { keyId: config.kmsKeyArn },
  { operationId: '../escape' }, { writerEpoch: 0 }]) {
  await assert.rejects(store.readExecutionLedgerV2({ ...context, ...change }));
 }
 assert.equal(calls, 0);
 assert.equal(await store.readExecutionLedgerV2({ ...context, writerEpoch: 2 }), null);
 assert.equal(calls, 1);
});

test('historical locator returns only matching scoped headers without guessing source or key authority', async () => {
 const body = await envelope(); let calls = 0;
 const header = JSON.parse(body); header.binding.context.sourceRevision = 'b'.repeat(40);
 const historical = JSON.stringify(header);
 const store = fixture(async command => { calls++; assert.ok(command instanceof GetObjectCommand);
  assert.equal(command.input.Key,expectedKey); return response(historical); });
 const locator = { installationId: context.installationId,organisationId: context.organisationId,
  writerEpoch: context.writerEpoch,operationId: context.operationId };
 assert.equal(await store.readExecutionLedgerV2At(locator),historical);
 await assert.rejects(store.readExecutionLedgerV2(context));
 const before = calls;
 await assert.rejects(store.readExecutionLedgerV2At({ ...locator,organisationId: 'other' })); assert.equal(calls,before);
 await assert.rejects(store.readExecutionLedgerV2At({ ...locator,operationId: 'other' }));
 // Locating a structurally valid header is deliberately not a claim that its
 // ciphertext authenticates; the prefix reader separately opens original AAD.
});
