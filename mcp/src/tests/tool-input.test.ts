import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPath, inputSchemaFor, type ParamSpec } from '../tool-input.js';

const PAGED: readonly ParamSpec[] = [{ kind: 'page' }, { kind: 'pageSize' }];

test('a tool with no params ignores nothing — an argument it did not declare is refused', () => {
  assert.equal(buildPath('/api/v1/dashboard', [], {}), '/api/v1/dashboard');
  assert.throws(() => buildPath('/api/v1/dashboard', [], { page: 3 }), /unknown/i);
});

test('pagination is appended only when supplied', () => {
  assert.equal(buildPath('/api/v1/documents', PAGED, {}), '/api/v1/documents');
  assert.equal(buildPath('/api/v1/documents', PAGED, { page: 2 }), '/api/v1/documents?page=2');
  assert.equal(
    buildPath('/api/v1/documents', PAGED, { page: 2, pageSize: 10 }),
    '/api/v1/documents?page=2&pageSize=10',
  );
});

test('pagination bounds are enforced', () => {
  for (const bad of [0, -1, 1.5, '2', null, Number.NaN]) {
    assert.throws(() => buildPath('/api/v1/documents', PAGED, { page: bad }), /page/i, String(bad));
  }
  assert.throws(() => buildPath('/api/v1/documents', PAGED, { pageSize: 101 }), /pageSize/i);
  assert.throws(() => buildPath('/api/v1/documents', PAGED, { pageSize: 0 }), /pageSize/i);
});

test('an unknown argument is refused rather than ignored', () => {
  assert.throws(() => buildPath('/api/v1/documents', PAGED, { organisationId: 'x' }), /unknown/i);
});

test('a path parameter is substituted', () => {
  const params: readonly ParamSpec[] = [{ kind: 'id', name: 'standardId' }];
  assert.equal(
    buildPath('/api/v1/compliance/records/:standardId', params, { standardId: 'abc-123' }),
    '/api/v1/compliance/records/abc-123',
  );
});

test('a path parameter is required and constrained', () => {
  const params: readonly ParamSpec[] = [{ kind: 'id', name: 'standardId' }];
  assert.throws(() => buildPath('/api/v1/compliance/records/:standardId', params, {}), /standardId/);
  for (const bad of ['../../etc', 'a/b', 'a?b', '', 'x'.repeat(161)]) {
    assert.throws(
      () => buildPath('/api/v1/compliance/records/:standardId', params, { standardId: bad }),
      /standardId/,
      JSON.stringify(bad),
    );
  }
});

test('a path parameter can never open a second path segment or a query', () => {
  const params: readonly ParamSpec[] = [{ kind: 'id', name: 'id' }];
  // The character set refuses these outright, which is the point: the guard
  // does not depend on escaping applied after the fact.
  for (const bad of ['1/../../owner/tenants', '1?x=y', '1#frag']) {
    assert.throws(() => buildPath('/api/v1/documents/:id', params, { id: bad }), /id/, bad);
  }
});

test('an enum accepts only its own values', () => {
  const params: readonly ParamSpec[] = [
    { kind: 'enum', name: 'kind', values: ['BOARD_MEETING', 'ANNUAL_GENERAL_MEETING'] },
  ];
  assert.equal(
    buildPath('/api/v1/governing-acts', params, { kind: 'BOARD_MEETING' }),
    '/api/v1/governing-acts?kind=BOARD_MEETING',
  );
  assert.throws(() => buildPath('/api/v1/governing-acts', params, { kind: 'OTHER' }), /kind/);
});

test('a year is bounded', () => {
  const params: readonly ParamSpec[] = [{ kind: 'year' }];
  assert.equal(buildPath('/api/v1/x', params, { year: 2026 }), '/api/v1/x?year=2026');
  assert.throws(() => buildPath('/api/v1/x', params, { year: 1999 }), /year/);
  assert.throws(() => buildPath('/api/v1/x', params, { year: 2201 }), /year/);
});

test('a flag is serialised as the literal the API checks for, and omitted when false', () => {
  const params: readonly ParamSpec[] = [{ kind: 'flag', name: 'includeFormer' }];
  assert.equal(
    buildPath('/api/v1/members', params, { includeFormer: true }),
    '/api/v1/members?includeFormer=true',
  );
  assert.equal(buildPath('/api/v1/members', params, { includeFormer: false }), '/api/v1/members');
  assert.throws(() => buildPath('/api/v1/members', params, { includeFormer: 'yes' }), /includeFormer/);
});

test('the advertised schema is generated from the same params the validator uses', () => {
  const schema = inputSchemaFor(PAGED) as {
    type: string;
    properties: Record<string, unknown>;
    additionalProperties: boolean;
    required?: string[];
  };
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['page', 'pageSize']);
  assert.equal(schema.required, undefined, 'pagination is optional');

  const withId = inputSchemaFor([{ kind: 'id', name: 'standardId' }]) as { required?: string[] };
  assert.deepEqual(withId.required, ['standardId'], 'a path parameter is required');
});

test('a tool with no params advertises an empty closed object', () => {
  assert.deepEqual(inputSchemaFor([]), {
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
});

// ── the kinds the search tool needs ────────────────────────────────────────

const SEARCH_PARAMS = [
  { kind: 'text' as const, name: 'q', max: 200, describe: 'What to look for.' },
  {
    kind: 'enumList' as const,
    name: 'types',
    values: ['BoardMember', 'Document'] as const,
    describe: 'Which kinds.',
  },
  { kind: 'count' as const, name: 'limit', min: 1, max: 50, describe: 'Most hits.' },
];

test('free text is required, bounded, and escaped into the query string', () => {
  const schema = inputSchemaFor(SEARCH_PARAMS) as {
    required: string[];
    properties: { q: { maxLength: number; minLength: number } };
  };
  assert.deepEqual(schema.required, ['q']);
  assert.equal(schema.properties.q.maxLength, 200);
  assert.equal(schema.properties.q.minLength, 1);

  assert.equal(
    buildPath('/api/v1/search', SEARCH_PARAMS, { q: 'roof & gutters' }),
    '/api/v1/search?q=roof%20%26%20gutters',
  );
});

test('empty text is refused rather than sent as a search for everything', () => {
  for (const q of ['', '   ', 42, undefined]) {
    assert.throws(() => buildPath('/api/v1/search', SEARCH_PARAMS, { q }), /q must be/);
  }
});

test('text longer than the tool declared is refused here, not at the server', () => {
  assert.throws(
    () => buildPath('/api/v1/search', SEARCH_PARAMS, { q: 'x'.repeat(201) }),
    /at most 200 characters/,
  );
});

test('a list of kinds is sent as one comma-separated value', () => {
  assert.equal(
    buildPath('/api/v1/search', SEARCH_PARAMS, { q: 'roof', types: ['BoardMember', 'Document'] }),
    '/api/v1/search?q=roof&types=BoardMember,Document',
  );
});

test('an empty list means the same as not asking, and is not sent', () => {
  // An empty `types=` would read at the server as a filter matching nothing,
  // which is the opposite of what an empty list means.
  assert.equal(
    buildPath('/api/v1/search', SEARCH_PARAMS, { q: 'roof', types: [] }),
    '/api/v1/search?q=roof',
  );
});

test('a kind the tool never offered is refused, and the refusal names the real ones', () => {
  assert.throws(
    () => buildPath('/api/v1/search', SEARCH_PARAMS, { q: 'roof', types: ['Payroll'] }),
    /may only contain: BoardMember, Document/,
  );
  assert.throws(
    () => buildPath('/api/v1/search', SEARCH_PARAMS, { q: 'roof', types: 'BoardMember' }),
    /must be a list/,
  );
});

test('a count outside the declared range is refused', () => {
  assert.equal(
    buildPath('/api/v1/search', SEARCH_PARAMS, { q: 'roof', limit: 50 }),
    '/api/v1/search?q=roof&limit=50',
  );
  for (const limit of [0, 51, 1.5, '20']) {
    assert.throws(() => buildPath('/api/v1/search', SEARCH_PARAMS, { q: 'roof', limit }), /limit/);
  }
});

test('an argument the search tool never declared is still refused', () => {
  assert.throws(
    () => buildPath('/api/v1/search', SEARCH_PARAMS, { q: 'roof', dataScope: 'full' }),
    /Unknown argument "dataScope"/,
  );
});
