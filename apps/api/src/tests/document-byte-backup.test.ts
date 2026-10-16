import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  sealDocumentByteBackup,
  openDocumentByteBackup,
  type DocumentBackupKeys,
} from '../services/document-byte-backup.js';
import { DOCUMENT_UPLOAD_MAX_FILE_SIZE } from '../services/document-upload-limits.js';

const source = Buffer.from('synthetic private governance document');
const context = {
  installationId: 'fixture',
  setId: '11111111-1111-4111-8111-111111111111',
  organisationId: 'charity',
  documentId: 'document',
  sourceSha: 'a'.repeat(40),
  databaseSha256: 'b'.repeat(64),
  sourceBindingSha256: 'c'.repeat(64),
  bytesSha256: createHash('sha256').update(source).digest('hex'),
  byteLength: source.length,
  keyArn:
    'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-4222-8222-222222222222',
};
function keys() {
  const retained = randomBytes(32),
    issued: Buffer[] = [];
  const provider: DocumentBackupKeys = {
    async generate(c) {
      const key = Buffer.from(retained);
      issued.push(key);
      return {
        key,
        keyArn: c.keyArn,
        wrappedKey: Buffer.from('synthetic-wrapped-key').toString('base64'),
      };
    },
    async unwrap(_wrapped, c) {
      const key = Buffer.from(retained);
      issued.push(key);
      return { key, keyArn: c.keyArn };
    },
  };
  return { provider, issued };
}
test('independent encrypted document bytes recover after the primary copy is gone', async () => {
  const k = keys(),
    primary = Buffer.from(source),
    sealed = await sealDocumentByteBackup(context, primary, k.provider);
  assert.ok(!sealed.body.includes(source.toString()));
  assert.ok(!sealed.body.includes(source.toString('base64')));
  primary.fill(0);
  assert.deepEqual(
    await openDocumentByteBackup(
      context,
      sealed.body,
      sealed.sha256,
      k.provider,
    ),
    source,
  );
  assert.ok(k.issued.every((key) => key.every((byte) => byte === 0)));
});
test('archive scope, exact bytes and independent expected digest cannot be substituted', async () => {
  const k = keys(),
    sealed = await sealDocumentByteBackup(context, source, k.provider);
  for (const patch of [
    { organisationId: 'other' },
    { setId: '33333333-3333-4333-8333-333333333333' },
    { databaseSha256: 'd'.repeat(64) },
    { sourceBindingSha256: 'e'.repeat(64) },
  ])
    await assert.rejects(
      openDocumentByteBackup(
        { ...context, ...patch },
        sealed.body,
        sealed.sha256,
        k.provider,
      ),
    );
  await assert.rejects(
    openDocumentByteBackup(context, sealed.body, '0'.repeat(64), k.provider),
  );
  await assert.rejects(
    sealDocumentByteBackup(
      { ...context, byteLength: source.length + 1 },
      source,
      k.provider,
    ),
  );
  await assert.rejects(
    sealDocumentByteBackup(context, Buffer.from('different'), k.provider),
  );
  const value = JSON.parse(sealed.body);
  value.tag = Buffer.alloc(16).toString('base64');
  const tampered = JSON.stringify(value);
  await assert.rejects(
    openDocumentByteBackup(
      context,
      tampered,
      createHash('sha256').update(tampered).digest('hex'),
      k.provider,
    ),
  );
  assert.ok(k.issued.every((key) => key.every((byte) => byte === 0)));
});
test('the full supported document size and zero-byte legacy objects round trip without truncation', async () => {
  for (const length of [0, DOCUMENT_UPLOAD_MAX_FILE_SIZE]) {
    const bytes = Buffer.alloc(length, 17),
      scope = {
        ...context,
        byteLength: length,
        bytesSha256: createHash('sha256').update(bytes).digest('hex'),
      },
      k = keys();
    const sealed = await sealDocumentByteBackup(scope, bytes, k.provider);
    assert.deepEqual(
      await openDocumentByteBackup(
        scope,
        sealed.body,
        sealed.sha256,
        k.provider,
      ),
      bytes,
    );
  }
});
test('archive parsing rejects extra/plaintext fields and provider failures clear the owned data key', async () => {
  const k = keys(),
    sealed = await sealDocumentByteBackup(context, source, k.provider);
  for (const body of [
    sealed.body + ' ',
    JSON.stringify({
      ...JSON.parse(sealed.body),
      title: 'private synthetic title',
    }),
    sealed.body.replace('"format":1', '"format":1,"format":1'),
  ]) {
    await assert.rejects(
      openDocumentByteBackup(
        context,
        body,
        createHash('sha256').update(body).digest('hex'),
        k.provider,
      ),
    );
  }
  const bad = keys();
  bad.provider.generate = async () => {
    const key = Buffer.alloc(31, 9);
    bad.issued.push(key);
    return { key, keyArn: context.keyArn, wrappedKey: 'AQID' };
  };
  await assert.rejects(sealDocumentByteBackup(context, source, bad.provider));
  assert.ok(bad.issued.every((key) => key.every((byte) => byte === 0)));
});
