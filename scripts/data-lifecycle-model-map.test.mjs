import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = readFileSync(join(root, 'apps/api/prisma/schema.prisma'), 'utf8');
const inventory = readFileSync(join(root, 'docs/architecture/data-lifecycle-model-map.md'), 'utf8');

test('the data lifecycle source map accounts for every Prisma model exactly once', () => {
  const schemaModels = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
  const section = inventory.match(/<!-- MODEL_INVENTORY_START -->([\s\S]*?)<!-- MODEL_INVENTORY_END -->/);
  assert.ok(section, 'model inventory markers must exist');
  const rows = section[1].trim().split(/\r?\n/);
  const inventoryModels = [];
  const groups = new Set();
  for (const row of rows) {
    const parsed = row.match(/^- ([a-z-]+): ((?:`\w+`(?:, )?)+)$/);
    assert.ok(parsed, `invalid model inventory row: ${row}`);
    assert.ok(!groups.has(parsed[1]), `duplicate model group: ${parsed[1]}`);
    groups.add(parsed[1]);
    inventoryModels.push(...[...parsed[2].matchAll(/`(\w+)`/g)].map((match) => match[1]));
  }
  assert.ok(schemaModels.length > 0, 'Prisma schema must contain models');
  assert.equal(new Set(inventoryModels).size, inventoryModels.length, 'a model appears in more than one group');
  assert.deepEqual(inventoryModels.sort(), schemaModels.sort());
});
