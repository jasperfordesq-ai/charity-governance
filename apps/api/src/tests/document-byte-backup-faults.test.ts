import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test, mock } from 'node:test';
import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { KmsDocumentBackupKeys } from '../services/document-byte-backup-kms.js';
import { S3DocumentByteBackups } from '../services/document-byte-backup-s3.js';
import {
  sealDocumentByteBackup,
  type DocumentBackupKeys,
} from '../services/document-byte-backup.js';

const keyArn =
  'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-4222-8222-222222222222';
const storageKeyArn =
  'arn:aws:kms:eu-west-1:123456789012:key/33333333-3333-4333-8333-333333333333';
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
  bytes = Buffer.from('synthetic document');
const context = {
  installationId: 'fixture',
  setId: '11111111-1111-4111-8111-111111111111',
  organisationId: 'charity',
  documentId: 'document',
  sourceSha: 'a'.repeat(40),
  databaseSha256: 'b'.repeat(64),
  sourceBindingSha256: 'c'.repeat(64),
  bytesSha256: createHash('sha256').update(bytes).digest('hex'),
  byteLength: bytes.length,
  keyArn,
};
const config = {
  bucket: 'synthetic-byte-backups',
  accountId: '123456789012',
  storageKeyArn,
  dataKeyArn: keyArn,
  installationId: 'fixture',
};
const fixtureKeys: DocumentBackupKeys = {
  async generate() {
    return { key: Buffer.alloc(32, 7), keyArn, wrappedKey: 'AQID' };
  },
  async unwrap() {
    return { key: Buffer.alloc(32, 7), keyArn };
  },
};

test('KMS refuses wrong scope/identity/key size and clears even rejected SDK plaintext', async () => {
  for (const patch of [
    { KeyId: storageKeyArn },
    { Plaintext: Buffer.alloc(31, 7) },
    { CiphertextBlob: undefined },
  ]) {
    const raw = {
      Plaintext: Buffer.alloc(32, 7),
      CiphertextBlob: Buffer.from([1, 2, 3]),
      KeyId: keyArn,
      ...patch,
    };
    const client = new KMSClient({ region: 'eu-west-1', credentials });
    let calls = 0;
    mock.method(client, 'send', async () => {
      calls++;
      return raw;
    });
    const keys = new KmsDocumentBackupKeys(keyArn, credentials, client);
    try {
      await assert.rejects(keys.generate(context));
      assert.equal(calls, 1);
      assert.ok(raw.Plaintext.every((value) => value === 0));
      await assert.rejects(
        keys.generate({ ...context, keyArn: storageKeyArn }),
      );
      assert.equal(calls, 1);
    } finally {
      client.destroy();
    }
  }
});

test('KMS deadline refuses a hung call and erases a late plaintext response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new KMSClient({ region: 'eu-west-1', credentials });
  let resolve!: (value: unknown) => void;
  const raw = {
    Plaintext: Buffer.alloc(32, 7),
    CiphertextBlob: Buffer.from([1, 2, 3]),
    KeyId: keyArn,
  };
  mock.method(
    client,
    'send',
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  try {
    const pending = new KmsDocumentBackupKeys(
      keyArn,
      credentials,
      client,
    ).generate(context);
    const rejected = assert.rejects(pending);
    t.mock.timers.tick(15001);
    await rejected;
    resolve(raw);
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(raw.Plaintext.every((value) => value === 0));
  } finally {
    client.destroy();
    t.mock.timers.reset();
  }
});

test('storage refuses unversioned, wrong-key/checksum, truncated and substituted objects and destroys bodies', async () => {
  const artifact = await sealDocumentByteBackup(context, bytes, fixtureKeys);
  for (const patch of [
    { VersionId: 'null' },
    { VersionId: undefined },
    { DeleteMarker: true },
    { SSEKMSKeyId: keyArn },
    { ChecksumSHA256: 'wrong' },
    { ContentLength: Buffer.byteLength(artifact.body) + 1 },
    { ChecksumType: 'COMPOSITE' },
  ]) {
    const body = Readable.from([Buffer.from(artifact.body)]),
      client = new S3Client({ region: 'eu-west-1', credentials });
    let calls = 0;
    mock.method(client, 'send', async (command: unknown) => {
      calls++;
      assert.ok(command instanceof GetObjectCommand);
      return {
        Body: body,
        ContentLength: Buffer.byteLength(artifact.body),
        VersionId: 'version1',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: storageKeyArn,
        ChecksumSHA256: Buffer.from(artifact.sha256, 'hex').toString('base64'),
        ...patch,
      };
    });
    try {
      await assert.rejects(
        new S3DocumentByteBackups(config, credentials, client).observe(
          context,
          artifact.sha256,
        ),
      );
      assert.equal(calls, 1);
      assert.equal(body.destroyed, true);
    } finally {
      client.destroy();
    }
  }
  const client = new S3Client({ region: 'eu-west-1', credentials });
  let calls = 0;
  mock.method(client, 'send', async () => {
    calls++;
    throw new Error('must not dispatch');
  });
  try {
    await assert.rejects(
      new S3DocumentByteBackups(config, credentials, client).observe(
        { ...context, installationId: 'other' },
        artifact.sha256,
      ),
    );
    assert.equal(calls, 0);
    assert.throws(
      () =>
        new S3DocumentByteBackups(
          { ...config, storageKeyArn: keyArn },
          credentials,
          client,
        ),
    );
  } finally {
    client.destroy();
  }
});

test('storage cancellation destroys a response that arrives after the caller stopped waiting', async () => {
  const artifact = await sealDocumentByteBackup(context, bytes, fixtureKeys),
    client = new S3Client({ region: 'eu-west-1', credentials }),
    controller = new AbortController();
  let resolve!: (value: unknown) => void;
  mock.method(
    client,
    'send',
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const body = Readable.from([Buffer.from(artifact.body)]);
  try {
    const pending = new S3DocumentByteBackups(
      config,
      credentials,
      client,
    ).observe(context, artifact.sha256, undefined, controller.signal);
    const rejected = assert.rejects(pending);
    controller.abort();
    await rejected;
    resolve({ Body: body });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(body.destroyed, true);
  } finally {
    client.destroy();
  }
});

test('storage read deadline destroys a stalled stream without retrying', async t => {
  const artifact=await sealDocumentByteBackup(context,bytes,fixtureKeys);
  t.mock.timers.enable({apis:['setTimeout']});
  const body=new Readable({read(){}}),client=new S3Client({region:'eu-west-1',credentials});let calls=0;
  mock.method(client,'send',async()=>{calls++;return {Body:body,ContentLength:Buffer.byteLength(artifact.body),VersionId:'version1',ServerSideEncryption:'aws:kms',SSEKMSKeyId:storageKeyArn,ChecksumSHA256:Buffer.from(artifact.sha256,'hex').toString('base64')};});
  try{
    const pending=new S3DocumentByteBackups(config,credentials,client).observe(context,artifact.sha256);
    const rejected=assert.rejects(pending);await Promise.resolve();
    t.mock.timers.tick(15001);await rejected;assert.equal(body.destroyed,true);assert.equal(calls,1);
  }finally{client.destroy();t.mock.timers.reset();}
});

test('KMS decrypt rejects algorithm substitution and clears the response',async()=>{
  const client=new KMSClient({region:'eu-west-1',credentials});
  const response={KeyId:keyArn,Plaintext:Buffer.alloc(32,8),EncryptionAlgorithm:'RSAES_OAEP_SHA_256'};
  mock.method(client,'send',async()=>response);
  try{await assert.rejects(new KmsDocumentBackupKeys(keyArn,credentials,client).unwrap('AQID',context));assert.ok(response.Plaintext.every(byte=>byte===0));}
  finally{client.destroy();}
});
