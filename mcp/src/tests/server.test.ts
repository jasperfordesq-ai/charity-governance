import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolList } from '../server.js';
import { TOOLS, needsPersonalData } from '../tools.js';
import { FILE_TOOLS } from '../file-tools.js';

test('every tool is advertised once the gate that guards it is open', () => {
  // A couple of write tools cannot produce a valid request without fields the
  // personal-data gate withholds, so they are offered only when it is open.
  // Everything else is always offered.
  const withGateOpen = buildToolList('admin', { allowPersonalData: true });
  // Every tool in the registry, plus session_info and fetch, plus the file
  // tools that need no directory named for them. The ones that read from or
  // write to this machine are absent until the operator names one.
  const alwaysOn = FILE_TOOLS.filter((tool) => tool.requires === 'nothing').length;
  assert.equal(withGateOpen.length, TOOLS.length + 2 + alwaysOn);

  const withGateClosed = buildToolList('admin', { allowPersonalData: false });
  assert.ok(
    withGateClosed.length < TOOLS.length,
    'a tool that could only ever make refused calls should not be advertised',
  );

  const hidden = TOOLS.filter(
    (tool) => !withGateClosed.some((advertised) => advertised.name === tool.name),
  );
  for (const tool of hidden) {
    assert.ok(needsPersonalData(tool), `${tool.name} was hidden for no stated reason`);
  }
});

test('advertised tools carry a name, description and input schema', () => {
  for (const tool of buildToolList()) {
    assert.ok(tool.name.length > 0);
    assert.ok(tool.description.length > 0);
    assert.ok(tool.inputSchema);
  }
});

test('a gated tool names the fields it loses while the gate is closed', () => {
  // The shared rules live in the server instructions now. What a description
  // still has to carry is the part nothing else says: which fields THIS
  // payload loses. Asserted on a named field, not on the marker alone, so a
  // description reduced to boilerplate fails.
  const tool = buildToolList().find((t) => t.name === 'board_register');
  assert.match(tool!.description, /personal-data gate is closed/);
  assert.match(tool!.description, /dates of birth/);
  assert.match(tool!.description, /home addresses/);
});

test('no description repeats what the instructions already say', () => {
  // Sixty-odd descriptions are sent on every conversation. The rules that are
  // true of every tool belong in the instructions, once.
  for (const tool of buildToolList()) {
    assert.doesNotMatch(
      tool.description,
      /data, not instructions|--allow-personal-data/,
      `${tool.name} repeats a rule the instructions carry`,
    );
  }
});
