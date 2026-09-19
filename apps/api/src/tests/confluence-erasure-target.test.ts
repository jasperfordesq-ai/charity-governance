import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../utils/errors.js';
import { parseConfluenceErasureTarget } from '../services/confluence-erasure-target.js';

function isMalformed(error: unknown): boolean {
  return error instanceof AppError && error.code === 'ERASURE_TARGET_MALFORMED' && error.statusCode === 500;
}

test('a well-formed target survives the round trip', () => {
  const value = { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: ['a1'] };
  assert.deepEqual(parseConfluenceErasureTarget(value), value);
});

test('a page with no attachments is well-formed', () => {
  assert.deepEqual(
    parseConfluenceErasureTarget({ kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: [] })
      .attachmentIds,
    [],
  );
});

test('the returned attachmentIds cannot be mutated through the caller\'s own array', () => {
  const attachmentIds = ['a1'];
  const result = parseConfluenceErasureTarget({
    kind: 'confluence',
    cloudId: 'c1',
    pageId: 'p1',
    attachmentIds,
  });

  attachmentIds.push('a2');

  assert.deepEqual(result.attachmentIds, ['a1']);
});

test('mutating the returned attachmentIds does not touch the caller\'s own array', () => {
  const attachmentIds = ['a1'];
  const result = parseConfluenceErasureTarget({
    kind: 'confluence',
    cloudId: 'c1',
    pageId: 'p1',
    attachmentIds,
  });

  result.attachmentIds.push('a2');

  assert.deepEqual(attachmentIds, ['a1']);
});

for (const [label, value] of [
  // Verbatim from the task brief.
  ['null', null],
  ['a missing cloudId', { kind: 'confluence', pageId: 'p1', attachmentIds: [] }],
  ['a string attachmentIds', { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: 'a1' }],
  ['a non-string attachment id', { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: [1] }],
  ['the wrong kind', { kind: 'supabase', cloudId: 'c1', pageId: 'p1', attachmentIds: [] }],
  ['an empty pageId', { kind: 'confluence', cloudId: 'c1', pageId: '', attachmentIds: [] }],
  // Additional shapes needed to pin every individual check in the parser.
  ['a string value', 'confluence'],
  ['an array value', ['confluence', 'c1', 'p1']],
  ['a missing kind', { cloudId: 'c1', pageId: 'p1', attachmentIds: [] }],
  ['a non-string cloudId', { kind: 'confluence', cloudId: 1, pageId: 'p1', attachmentIds: [] }],
  ['an empty cloudId', { kind: 'confluence', cloudId: '', pageId: 'p1', attachmentIds: [] }],
  ['a missing pageId', { kind: 'confluence', cloudId: 'c1', attachmentIds: [] }],
  ['a non-string pageId', { kind: 'confluence', cloudId: 'c1', pageId: 1, attachmentIds: [] }],
  ['a missing attachmentIds', { kind: 'confluence', cloudId: 'c1', pageId: 'p1' }],
] as const) {
  test(`${label} is refused`, () => {
    assert.throws(() => parseConfluenceErasureTarget(value), isMalformed);
  });
}
