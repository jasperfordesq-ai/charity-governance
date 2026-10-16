import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSyntheticScopeArgs, readSyntheticScopeInput } from '../jobs/register-confluence-synthetic-scope.js';

test('scope command defaults to preview and refuses ambiguous or malformed arguments', () => {
  const file = join(tmpdir(), 'synthetic-scope.json');
  assert.deepEqual(parseSyntheticScopeArgs(['--input', file]), { inputFile: file, confirmation: undefined });
  assert.equal(parseSyntheticScopeArgs(['--input', file, '--confirm', 'a'.repeat(64)]).confirmation, 'a'.repeat(64));
  for (const argv of [[], ['--input'], ['--input', 'relative.json'], ['--input', file, '--input', file],
    ['--input', file, '--execute'], ['--input', file, '--confirm', 'yes'], ['--confirm', 'a'.repeat(64)]]) {
    assert.throws(() => parseSyntheticScopeArgs(argv));
  }
});

test('scope input reader accepts bounded JSON and refuses empty, oversized, malformed or non-file inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'charitypilot-scope-input-'));
  try {
    const file = join(dir, 'input.json');
    await writeFile(file, '{"synthetic":true}');
    assert.deepEqual(await readSyntheticScopeInput(file), { synthetic: true });
    for (const content of ['', '{broken', ' '.repeat(16385)]) {
      await writeFile(file, content); await assert.rejects(readSyntheticScopeInput(file));
    }
    await assert.rejects(readSyntheticScopeInput(dir));
  } finally { await rm(dir, { recursive: true }); }
});

test('the command refuses a missing maintenance credential without falling back to or printing the runtime URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'charitypilot-scope-command-'));
  try {
    const file = join(dir, 'input.json'); await writeFile(file, '{}');
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: 'postgresql://synthetic:private-runtime-marker@127.0.0.1:1/not-a-database' };
    delete env.DATABASE_MAINTENANCE_URL;
    const suffix = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const job = fileURLToPath(new URL(`../jobs/register-confluence-synthetic-scope.${suffix}`, import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', job, '--input', file], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /No provider action was attempted/);
    assert.doesNotMatch(result.stderr, /private-runtime-marker|postgresql:\/\//);
  } finally { await rm(dir, { recursive: true }); }
});
