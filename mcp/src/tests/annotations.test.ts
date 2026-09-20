import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, annotationsFor, titleFor } from '../tools.js';
import { FILE_TOOLS } from '../file-tools.js';
import { buildToolList } from '../server.js';

test('a tool that only reads says so, and nothing claims to reach the open world', () => {
  for (const tool of TOOLS) {
    const a = annotationsFor(tool);
    assert.equal(a.readOnlyHint, tool.method === undefined, tool.name);
    assert.equal(a.openWorldHint, false, tool.name);
    assert.ok(a.title.length > 0, tool.name);
  }
});

test('destructive means what the approval gate means: a removal or a void', () => {
  for (const tool of TOOLS) {
    assert.equal(annotationsFor(tool).destructiveHint, tool.destructive === true, tool.name);
  }
  assert.equal(annotationsFor(TOOLS.find((t) => t.name === 'board_member_delete')!).destructiveHint, true);
  assert.equal(annotationsFor(TOOLS.find((t) => t.name === 'board_member_update')!).destructiveHint, false);
});

test('a PUT and a read are idempotent, a create is not', () => {
  assert.equal(annotationsFor(TOOLS.find((t) => t.name === 'financial_controls_set')!).idempotentHint, true);
  assert.equal(annotationsFor(TOOLS.find((t) => t.name === 'board_register')!).idempotentHint, true);
  assert.equal(annotationsFor(TOOLS.find((t) => t.name === 'risk_create')!).idempotentHint, false);
});

test('titles are words, not identifiers', () => {
  assert.equal(titleFor('board_register'), 'Board register');
  assert.equal(titleFor('governing_act_void'), 'Governing act void');
});

test('every advertised tool, file tools included, carries annotations', () => {
  const listed = buildToolList('admin', { allowPersonalData: true, uploadRoot: '/tmp/x', downloadDir: '/tmp/y' });
  // Every ordinary tool and both file tools.
  assert.equal(listed.length, TOOLS.length + FILE_TOOLS.length);
  for (const tool of listed) {
    const a = (tool as { annotations?: { readOnlyHint?: unknown } }).annotations;
    assert.equal(typeof a?.readOnlyHint, 'boolean', tool.name);
  }
});
