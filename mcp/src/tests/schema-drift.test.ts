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

/**
 * Hardcoded on purpose. Iterating Object.keys(SAFE_FIELDS) would source the list of
 * models to audit from the very artifact being audited: drop a model from ModelName,
 * SAFE_FIELDS and WITHHELD_FIELDS together and TypeScript still compiles, every test
 * still passes, and that model's columns are never checked again. Adding a fifth gated
 * model means adding it here too — and the test below says so if you forget.
 */
const MUST_BE_GATED = ['BoardMember', 'Member', 'ConflictRecord', 'ComplaintRecord'] as const;

test('no gated model has been quietly dropped from the policy', () => {
  for (const model of MUST_BE_GATED) {
    assert.ok(model in SAFE_FIELDS, `${model} is no longer in SAFE_FIELDS — the gate stopped covering it`);
    assert.ok(model in WITHHELD_FIELDS, `${model} is no longer in WITHHELD_FIELDS — the gate stopped covering it`);
  }
  assert.deepEqual(
    Object.keys(SAFE_FIELDS).sort(),
    [...MUST_BE_GATED].sort(),
    'SAFE_FIELDS covers a different set of models than MUST_BE_GATED expects',
  );
});

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

  for (const model of MUST_BE_GATED as readonly ModelName[]) {
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
