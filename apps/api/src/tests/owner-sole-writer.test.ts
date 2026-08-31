import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Structural, not behavioural: this exists so the "console is the sole writer of
// tenant lifecycle" property cannot erode as the codebase grows. If a new file
// legitimately needs to write it, add it to ALLOWED and say why in the commit.
const ALLOWED = new Set(['services/owner-tenants.service.ts']);

const SRC = path.join(process.cwd(), 'src');

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) return [];
      return [full];
    }),
  );
  return files.flat();
}

test('only the owner tenants service writes Organisation.lifecycleStatus', async () => {
  const files = await sourceFiles(SRC);
  const offenders: string[] = [];

  for (const file of files) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    if (ALLOWED.has(relative)) continue;

    const source = await readFile(file, 'utf8');
    // update/updateMany/upsert/create: updateMany is the most natural way to bulk-write
    // this field, and upsert/create can set it on write too — all four must be caught,
    // not just the single-row update() this used to check alone.
    const writesViaPrisma = /organisation\.(update|updateMany|upsert|create)\s*\(\s*\{[\s\S]{0,400}?lifecycleStatus/.test(source);
    const writesViaSql = /UPDATE\s+"Organisation"[\s\S]{0,200}?lifecycleStatus/i.test(source);
    if (writesViaPrisma || writesViaSql) offenders.push(relative);
  }

  assert.deepEqual(offenders, [], `unexpected writers of Organisation.lifecycleStatus: ${offenders.join(', ')}`);
});

test('no tenant-facing route imports the owner tenants service', async () => {
  const files = await sourceFiles(path.join(SRC, 'routes'));
  const offenders = [] as string[];

  for (const file of files) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    if (relative.startsWith('routes/owner/')) continue;
    const source = await readFile(file, 'utf8');
    if (source.includes('owner-tenants.service')) offenders.push(relative);
  }

  assert.deepEqual(offenders, [], `tenant routes must not import the owner service: ${offenders.join(', ')}`);
});
