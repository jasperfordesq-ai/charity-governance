import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FETCH_TOOL, REFERENCE_TARGETS, resolveReference } from '../references.js';
import { TOOLS } from '../tools.js';
import { buildToolList } from '../server.js';
import { ConnectorError } from '../errors.js';

test('a reference resolves to the tool that reads that kind of record', () => {
  assert.deepEqual(resolveReference('charitypilot://governing-act/act-1'), {
    tool: 'governing_act_get',
    args: { id: 'act-1' },
  });
  assert.deepEqual(resolveReference('charitypilot://document/doc-1'), {
    tool: 'document',
    args: { id: 'doc-1' },
  });
});

test('a standard resolves to the charity’s own position against it', () => {
  // The Code's text is the same for everyone; what a charity wants to know is
  // where it stands, and that tool takes the standard's identifier by another
  // name.
  assert.deepEqual(resolveReference('charitypilot://standard/std-1'), {
    tool: 'compliance_record',
    args: { standardId: 'std-1' },
  });
});

test('surrounding whitespace is forgiven, because a model will copy it', () => {
  assert.deepEqual(resolveReference('  charitypilot://deadline/d-1\n'), {
    tool: 'deadline_get',
    args: { id: 'd-1' },
  });
});

test('a reference the connector cannot place is refused, never guessed at', () => {
  for (const bad of [
    'charitypilot://payroll/p-1',
    'charitypilot://board-member',
    'https://example.test/board-member/bm-1',
    'bm-1',
    '',
    '   ',
    undefined,
    42,
  ]) {
    assert.throws(
      () => resolveReference(bad),
      (err: unknown) => {
        assert.ok(err instanceof ConnectorError);
        assert.equal(err.code, 'REFERENCE_INVALID');
        return true;
      },
      `${String(bad)} must be refused`,
    );
  }
});

test('the refusal for an unknown kind says which kinds there are', () => {
  assert.throws(
    () => resolveReference('charitypilot://payroll/p-1'),
    /board-member/,
  );
});

// The identifier is interpolated into a URL path downstream, so the character
// set is the guard rather than escaping applied afterwards.
test('an identifier that could open another path is refused', () => {
  for (const id of ['../../auth/me', 'a/b', 'a?b=1', 'a#b', 'a.b', '']) {
    assert.throws(
      () => resolveReference(`charitypilot://document/${id}`),
      (err: unknown) => {
        assert.ok(err instanceof ConnectorError);
        return true;
      },
      `"${id}" must be refused`,
    );
  }
});

test('every kind names a tool that exists', () => {
  for (const [kind, target] of Object.entries(REFERENCE_TARGETS)) {
    const tool = TOOLS.find((candidate) => candidate.name === target.tool);
    assert.ok(tool, `${kind} names ${target.tool}, which is not a tool`);
    assert.equal(tool.method, undefined, `${target.tool} must be a read`);
    const params = (tool.params ?? []).filter((param) => param.kind === 'id');
    assert.ok(
      params.some((param) => param.name === target.arg),
      `${target.tool} takes no identifier called ${target.arg}`,
    );
  }
});

test('fetch is offered whatever toolsets were asked for', () => {
  // A reference is useless without the tool that reads it, and search — which
  // is where references come from — is offered the same way.
  const narrow = buildToolList('read', { toolsets: ['minute-book'], allowPersonalData: false });
  const names = narrow.map((tool) => tool.name);

  assert.ok(names.includes(FETCH_TOOL.name));
  assert.ok(names.includes('search'));
  assert.ok(!names.includes('documents_list'), 'the narrowing must otherwise hold');
});

// The API hands out the references; this file reads them. The two lists are
// maintained apart, so a kind added there and forgotten here would give an
// agent a reference it could not follow.
test('every kind the API can hand out is one this can read', async () => {
  const built = new URL(
    '../../../apps/api/dist/services/search.service.js',
    import.meta.url,
  ).href;

  let SEARCHABLE: Record<string, { refPath: string }>;
  try {
    ({ SEARCHABLE } = (await import(built)) as {
      SEARCHABLE: Record<string, { refPath: string }>;
    });
  } catch {
    assert.fail(
      'The API is not built, so this could not be checked. Run `npm run build` in apps/api/.',
    );
  }

  for (const [type, spec] of Object.entries(SEARCHABLE)) {
    assert.ok(
      REFERENCE_TARGETS[spec.refPath],
      `search can return charitypilot://${spec.refPath}/... for ${type}, and nothing reads it`,
    );
  }
});
