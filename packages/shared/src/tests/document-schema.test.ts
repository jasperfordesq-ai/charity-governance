import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadDocumentSchema } from '../schemas/document.js';

const baseDocument = {
  name: 'Safeguarding policy',
  category: 'POLICY',
};

test('uploadDocumentSchema rejects arbitrary date strings', () => {
  const result = uploadDocumentSchema.safeParse({
    ...baseDocument,
    approvedDate: 'board approved soon',
  });

  assert.equal(result.success, false);
  if (result.success) assert.fail('Document date validation should have failed');
  assert.equal(result.error.issues[0]?.path.join('.'), 'approvedDate');
});

test('uploadDocumentSchema accepts ISO dates and datetimes', () => {
  assert.equal(uploadDocumentSchema.safeParse({ ...baseDocument, approvedDate: '2026-06-06' }).success, true);
  assert.equal(
    uploadDocumentSchema.safeParse({ ...baseDocument, nextReviewDate: '2026-06-06T12:00:00.000Z' }).success,
    true,
  );
});

test('uploadDocumentSchema trims a document name, like its owner and reference siblings', () => {
  const result = uploadDocumentSchema.safeParse({ ...baseDocument, name: '  Safeguarding policy  ' });

  assert.equal(result.success, true);
  if (!result.success) assert.fail('a padded document name should parse');
  assert.equal(result.data.name, 'Safeguarding policy');
});

test('uploadDocumentSchema refuses a document name that is nothing but whitespace', () => {
  const result = uploadDocumentSchema.safeParse({ ...baseDocument, name: '   ' });

  assert.equal(result.success, false);
  if (result.success) assert.fail('a whitespace-only document name should not parse');
  assert.equal(result.error.issues[0]?.path.join('.'), 'name');
});
