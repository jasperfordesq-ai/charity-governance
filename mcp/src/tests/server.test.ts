import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolList } from '../server.js';
import { TOOLS } from '../tools.js';

test('every defined tool is advertised', () => {
  assert.equal(buildToolList().length, TOOLS.length);
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
