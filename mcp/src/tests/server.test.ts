import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolList } from '../server.js';
import { TOOLS, needsPersonalData } from '../tools.js';

test('every tool is advertised once the gate that guards it is open', () => {
  // A couple of write tools cannot produce a valid request without fields the
  // personal-data gate withholds, so they are offered only when it is open.
  // Everything else is always offered.
  const withGateOpen = buildToolList('admin', { allowPersonalData: true });
  assert.equal(withGateOpen.length, TOOLS.length);

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

test('the board register description warns that personal data is withheld', () => {
  const tool = buildToolList().find((t) => t.name === 'board_register');
  assert.match(tool!.description, /--allow-personal-data/);
});
