import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test, mock } from 'node:test';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { S3AuthorityObjectStore } from '../services/recovery-authority-s3.js';
import { sealConfluenceCopyRecoveryFacts } from '../services/confluence-copy-recovery-envelope.js';
import { prepareConfluenceCopyRecoveryFacts } from '../services/confluence-copy-recovery-facts.js';
import { recoveryFactsFixture, recoveryContextFixture as context } from './fixtures/confluence-copy-recovery-facts.js';

const config = { bucket: 'synthetic-recovery-copy-test', accountId: '123456789012',
  kmsKeyArn: 'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-2222-2222-222222222222',
  replayKeyArn: context.keyId, installationId: context.installationId, organisationId: context.organisationId };
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const metadata = { VersionId: 'synthetic-version', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn };
async function envelope() {
  return (await sealConfluenceCopyRecoveryFacts(prepareConfluenceCopyRecoveryFacts(recoveryFactsFixture()).body, context, {
    generate: async () => ({ key: Buffer.alloc(32, 7), wrappedKey: Buffer.from('synthetic-wrap').toString('base64'), keyId: context.keyId }),
    unwrap: async () => ({ key: Buffer.alloc(32, 7), keyId: context.keyId }),
  })).envelope;
}
function fixture(handler: (command: unknown) => Promise<unknown>) {
  const client = new S3Client({ region: 'eu-west-1', credentials }); mock.method(client, 'send', handler);
  return new S3AuthorityObjectStore(config, credentials, client);
}
test('copy-state object uses exact namespace, account, KMS and atomic create-if-absent', async () => {
  const body = await envelope(); let stored: string | undefined;
  const store = fixture(async (command) => {
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.Key, 'confluence-copy-state/install-a/org-a/state-1.json');
      assert.equal(command.input.IfNoneMatch, '*'); assert.equal(command.input.ExpectedBucketOwner, config.accountId);
      assert.equal(command.input.SSEKMSKeyId, config.kmsKeyArn); stored = command.input.Body as string;
      return metadata;
    }
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.ExpectedBucketOwner, config.accountId);
    return { ...metadata, ContentLength: Buffer.byteLength(stored!), Body: Readable.from([Buffer.from(stored!)]) };
  });
  assert.equal(await store.createConfluenceCopyState('state-1', body), true);
  assert.equal(await store.readConfluenceCopyState('state-1'), body);
});
test('another organisation or operation cannot be stored under the configured scope', async () => {
  const body = await envelope(); let requests = 0;
  const store = fixture(async () => { requests++; return metadata; });
  await assert.rejects(store.createConfluenceCopyState('state-2', body));
  const wrong = JSON.parse(body); wrong.context.organisationId = 'other-org';
  await assert.rejects(store.createConfluenceCopyState('state-1', JSON.stringify(wrong)));
  assert.equal(requests, 0);
});
test('a missing object remains missing and is not written by a read', async () => {
  const store = fixture(async (command) => { assert.ok(command instanceof GetObjectCommand);
    throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }; });
  assert.equal(await store.readConfluenceCopyState('state-1'), null);
});
