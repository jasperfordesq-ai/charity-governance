import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, TOOL_GROUPS, groupOf } from '../tools.js';
import { buildToolList } from '../server.js';

test('every tool belongs to exactly one group, derived from its route', () => {
  for (const tool of TOOLS) {
    assert.ok((TOOL_GROUPS as readonly string[]).includes(groupOf(tool)), tool.name);
  }
  assert.equal(groupOf({ path: '/api/v1/governing-acts/:id/void' }), 'minute-book');
  assert.equal(groupOf({ path: '/api/v1/members' }), 'registers');
  assert.equal(groupOf({ path: '/api/v1/dashboard' }), 'organisation');
  assert.throws(() => groupOf({ path: '/api/v1/nowhere' }), /belongs to no tool group/);
});

test('a toolset narrows the list but never removes session_info', () => {
  const listed = buildToolList('admin', { allowPersonalData: true, toolsets: ['compliance'] });
  const names = listed.map((tool) => tool.name);
  assert.ok(names.includes('session_info'));
  assert.ok(names.includes('compliance_summary'));
  assert.ok(!names.includes('board_register'));
  assert.ok(!names.includes('document_upload'));
});

test('file tools follow the documents group', () => {
  const listed = buildToolList('admin', { allowPersonalData: true, toolsets: ['documents'], uploadRoot: '/tmp/x' });
  assert.ok(listed.some((tool) => tool.name === 'document_upload'));
});
