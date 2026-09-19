import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SAFE_FIELDS, WITHHELD_FIELDS, type ModelName } from '../field-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = resolve(here, '../../../apps/api/prisma/schema.prisma');

function modelNames(schema: string): Set<string> {
  return new Set([...schema.matchAll(/^model (\w+) \{$/gm)].map((m) => m[1]!));
}

/**
 * Field names on a model that carry data: scalars and enums, excluding relations.
 * Relations are excluded by name (the type is another model) and by `@relation`.
 * Do NOT filter on a capitalised type — every Prisma scalar is capitalised
 * (String, DateTime, Boolean, Int), so that filter matches everything and
 * silently empties the list.
 */
function dataFieldsOf(model: string, schema: string): string[] {
  const models = modelNames(schema);
  const match = new RegExp(`^model ${model} \\{$([\\s\\S]*?)^\\}$`, 'm').exec(schema);
  assert.ok(match, `model ${model} not found in schema.prisma`);

  const fields = match[1]!
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !line.startsWith('@@'))
    .filter((line) => !line.includes('@relation'))
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .filter((parts) => !models.has(parts[1]!.replace(/[[\]?]/g, '')))
    .map((parts) => parts[0]!);

  assert.ok(
    fields.length > 0,
    `Parsed zero data fields from model ${model}. The parser is broken, not the schema — ` +
      'a drift guard that extracts nothing passes unconditionally and protects nothing.',
  );
  return fields;
}

test('the parser really does see the fields it is meant to guard', () => {
  const schema = readFileSync(SCHEMA, 'utf8');
  const boardMember = dataFieldsOf('BoardMember', schema);
  assert.ok(boardMember.includes('dateOfBirth'), 'must see the field it exists to catch');
  assert.ok(boardMember.includes('residentialAddress'));
  assert.ok(!boardMember.includes('organisation'), 'relations are not data fields');
  assert.ok(!boardMember.includes('conflictRecords'), 'relation lists are not data fields');
});

test('every data field on the gated models is classified as safe or withheld', () => {
  const schema = readFileSync(SCHEMA, 'utf8');
  const unclassified: string[] = [];

  for (const model of Object.keys(SAFE_FIELDS) as ModelName[]) {
    for (const field of dataFieldsOf(model, schema)) {
      if (!SAFE_FIELDS[model].includes(field) && !WITHHELD_FIELDS[model].includes(field)) {
        unclassified.push(`${model}.${field}`);
      }
    }
  }

  assert.deepEqual(
    unclassified,
    [],
    'New columns must be added to SAFE_FIELDS or WITHHELD_FIELDS in ' +
      'mcp/src/field-policy.ts before they can be exposed. Withheld is the safe default.',
  );
});
