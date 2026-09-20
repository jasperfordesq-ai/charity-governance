import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CONNECTOR_VERSION } from '../version.js';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(here, '../..');

function json(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(PACKAGE_ROOT, name), 'utf8')) as Record<string, unknown>;
}

/**
 * The bundle manifest is what a person installs in Claude Desktop, and it
 * repeats things the package already states. Three of them drifting apart
 * would be discovered by whoever tried to install it.
 */
test('the bundle, the package and the connector agree on the version', () => {
  const manifest = json('manifest.json');
  const pkg = json('package.json');

  assert.equal(manifest['version'], pkg['version']);
  assert.equal(manifest['version'], CONNECTOR_VERSION);
});

test('the bundle starts the file the package says is the entry point', () => {
  const manifest = json('manifest.json');
  const pkg = json('package.json');

  const server = manifest['server'] as {
    entry_point: string;
    mcp_config: { command: string; args: string[] };
  };
  const bin = (pkg['bin'] as Record<string, string>)['charitypilot-mcp'];

  assert.equal(server.entry_point, 'dist/cli.js');
  assert.equal(bin, './dist/cli.js');
  assert.ok(
    server.mcp_config.args.some((arg) => arg.endsWith('dist/cli.js')),
    'the bundle must start the built CLI',
  );
  assert.ok(
    server.mcp_config.args.includes('serve'),
    'without a command the CLI would try to run connect from a place with no terminal',
  );
});

test('the bundle asks for the two directories, and neither is required', () => {
  const manifest = json('manifest.json');
  const config = manifest['user_config'] as Record<string, { type: string; required?: boolean }>;

  for (const field of ['upload_root', 'download_dir']) {
    assert.ok(config[field], `${field} must be offered`);
    assert.equal(config[field]!.type, 'directory');
    assert.notEqual(
      config[field]!.required,
      true,
      'reading from or writing to somebody’s machine is asked for, never assumed',
    );
  }
});

test('the bundle passes the directories the way the connector reads them', () => {
  const server = json('manifest.json')['server'] as {
    mcp_config: { env?: Record<string, string> };
  };

  assert.deepEqual(server.mcp_config.env, {
    CHARITYPILOT_UPLOAD_ROOT: '${user_config.upload_root}',
    CHARITYPILOT_DOWNLOAD_DIR: '${user_config.download_dir}',
  });
});

test('the package still refuses to be published by accident', () => {
  // Publishing is the owner's to do, and it is one line away: drop `private`
  // and choose a name. Until then npm refuses, which is the right default for
  // a package that talks to one charity's records.
  assert.equal(json('package.json')['private'], true);
});

test('the built entry point the bundle names exists after a build', () => {
  assert.ok(
    existsSync(resolve(PACKAGE_ROOT, 'dist/cli.js')),
    'this suite runs from dist, so the entry point must be beside it',
  );
});
