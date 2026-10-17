import { readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const apiRequire = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const webRequire = createRequire(
  new URL('../apps/web/package.json', import.meta.url),
);
const prettyRequire = createRequire(apiRequire.resolve('pino-pretty'));
const { copy, copyStrict, MaxDepthExceededError } = prettyRequire('fast-copy');

test('the copier actually resolved by the development logger bounds hostile depth and preserves ordinary copies', () => {
  const value = {
    label: 'synthetic-copy',
    bytes: Buffer.from('fixture'),
    date: new Date('2026-01-01T00:00:00Z'),
    nested: { active: true },
  };
  value.self = value;
  const cloned = copy(value);
  assert.notEqual(cloned, value);
  assert.equal(cloned.self, cloned);
  assert.deepEqual(cloned.bytes, value.bytes);
  assert.notEqual(cloned.bytes, value.bytes);
  assert.deepEqual(cloned.date, value.date);
  assert.notEqual(cloned.nested, value.nested);
  let deep = {};
  for (let i = 0; i < 4000; i++) deep = { next: deep };
  for (const clone of [copy, copyStrict])
    assert.throws(
      () => clone(deep),
      (error) =>
        error instanceof MaxDepthExceededError &&
        error.name === 'MaxDepthExceededError',
    );
});

test('actual pino-pretty output remains useful and redacts configured fields without mutating input', () => {
  const { prettyFactory } = apiRequire('pino-pretty'),
    pretty = prettyFactory({
      colorize: false,
      singleLine: true,
      ignore: 'hostname,syntheticPrivate',
    });
  const log = {
    level: 30,
    time: Date.parse('2026-01-01T00:00:00Z'),
    msg: 'synthetic logger compatibility',
    nested: { label: 'synthetic-item' },
    syntheticPrivate: 'omit-this-fixture',
  };
  const text = pretty(log);
  assert.match(text, /synthetic logger compatibility/);
  assert.match(text, /synthetic-item/);
  assert.ok(!text.includes('omit-this-fixture'));
  assert.equal(log.syntheticPrivate, 'omit-this-fixture');
  assert.equal(log.nested.label, 'synthetic-item');
});

test('effective Next lint configuration does not enter the unpatched rootDir glob path', async () => {
  const { ESLint } = webRequire('eslint'),
    cwd = fileURLToPath(new URL('../apps/web', import.meta.url)),
    lint = new ESLint({ cwd });
  const files = [join(cwd, 'next.config.ts')],
    pending = [join(cwd, 'src')];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name))
        files.push(path);
    }
  }
  let checked = 0;
  for (const file of files) {
    const config = await lint.calculateConfigForFile(file);
    if (!config) continue;
    checked++;
    assert.equal(
      config.settings?.next?.rootDir,
      undefined,
      'Review unpatched brace-glob exposure before adding a rootDir setting: ' +
        file,
    );
  }
  assert.ok(checked > 1);
});

test('the installed Next rule treats an unset rootDir as literal cwd without invoking brace parsing', () => {
  const { getRootDirs } = webRequire(
    join(
      dirname(webRequire.resolve('@next/eslint-plugin-next')),
      'utils',
      'get-root-dirs.js',
    ),
  );
  const cwd = 'synthetic-' + '{'.repeat(2000) + 'fixture' + '}'.repeat(2000);
  assert.deepEqual(getRootDirs({ cwd, settings: {} }), [cwd]);
  assert.deepEqual(getRootDirs({ cwd, settings: { next: {} } }), [cwd]);
});
