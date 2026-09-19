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

// `asPlainObject`'s array exclusion is redundant with the `kind` check for
// every OTHER case in this file: an array's numeric indices never satisfy
// `target.kind !== 'confluence'`, so a bare `['confluence', 'c1', 'p1']`
// would still be refused even with the array exclusion deleted, and would
// falsely look like coverage for it. This is the one input built to defeat
// that: a real array (`Array.isArray` is true) carrying every field as an
// own, enumerable, correctly-typed property, so every check downstream of
// the object guard would pass it. Only the array exclusion itself refuses
// it.
test('an array carrying well-formed confluence-shaped properties is still refused for not being a plain object', () => {
  const target: unknown = Object.assign(['not a plain object'], {
    kind: 'confluence',
    cloudId: 'c1',
    pageId: 'p1',
    attachmentIds: [] as string[],
  });

  assert.throws(() => parseConfluenceErasureTarget(target), isMalformed);
});

// The same masking problem, one condition over: `typeof value === 'object'`
// is what actually excludes non-object values, but every non-object case
// tested elsewhere ('null', a bare string, a bare array) is refused by
// something else that runs regardless — 'null' throws its own TypeError on
// property access, and a string or array's numeric/absent 'kind' fails the
// `kind` check downstream. None of those would notice this condition being
// deleted. A function is `typeof 'function'`, not `'object'`, yet — unlike a
// string or a number — can carry arbitrary own properties, so it is the one
// value that reaches every downstream check successfully and still must be
// refused here.
test('a function carrying well-formed confluence-shaped properties is still refused for not being a plain object', () => {
  const target: unknown = Object.assign(() => {}, {
    kind: 'confluence',
    cloudId: 'c1',
    pageId: 'p1',
    attachmentIds: [] as string[],
  });

  assert.throws(() => parseConfluenceErasureTarget(target), isMalformed);
});

for (const [label, value] of [
  // Verbatim from the task brief.
  ['null', null],
  ['a missing cloudId', { kind: 'confluence', pageId: 'p1', attachmentIds: [] }],
  ['a string attachmentIds', { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: 'a1' }],
  ['a non-string attachment id', { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: [1] }],
  ['an empty attachment id', { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: [''] }],
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
  // A whitespace-only value parses under a bare length check yet names
  // nothing — the eraser would delete against a path built from whitespace
  // and report success. Pinned at each of the three positions.
  ['a whitespace-only cloudId', { kind: 'confluence', cloudId: '   ', pageId: 'p1', attachmentIds: [] }],
  ['a whitespace-only pageId', { kind: 'confluence', cloudId: 'c1', pageId: '   ', attachmentIds: [] }],
  [
    'a whitespace-only attachment id',
    { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: ['   '] },
  ],
  // The deliberate choice to refuse surrounding whitespace rather than
  // silently trim it — see the doc comment on `isNonEmptyString`. Also
  // pinned at each of the three positions, so a change to "trim instead of
  // refuse" is caught here rather than passing quietly.
  ['a cloudId with leading whitespace', { kind: 'confluence', cloudId: ' c1', pageId: 'p1', attachmentIds: [] }],
  ['a pageId with trailing whitespace', { kind: 'confluence', cloudId: 'c1', pageId: 'p1 ', attachmentIds: [] }],
  [
    'an attachment id with surrounding whitespace',
    { kind: 'confluence', cloudId: 'c1', pageId: 'p1', attachmentIds: [' a1 '] },
  ],
] as const) {
  test(`${label} is refused`, () => {
    assert.throws(() => parseConfluenceErasureTarget(value), isMalformed);
  });
}
