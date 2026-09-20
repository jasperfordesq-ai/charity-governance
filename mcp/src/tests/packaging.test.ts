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
  // Publishing claims a public name and commits somebody to maintaining it,
  // which is the owner's decision rather than an engineering one. Everything
  // else a publish needs is in place below, so dropping this line is now the
  // only line.
  assert.equal(json('package.json')['private'], true);
});

test('the built entry point the bundle names exists after a build', () => {
  assert.ok(
    existsSync(resolve(PACKAGE_ROOT, 'dist/cli.js')),
    'this suite runs from dist, so the entry point must be beside it',
  );
});

// ── what an npm publish would actually ship ────────────────────────────────

test('everything a publish needs is there, so removing one line is enough', () => {
  const pkg = json('package.json');

  // The comment above used to say publishing was one line away. It was not:
  // without these, a publish would have shipped the sources and the tests,
  // and npm would have warned about a package with no licence and no
  // description. Now it is one line.
  assert.equal(pkg['license'], 'AGPL-3.0-or-later');
  assert.ok(typeof pkg['description'] === 'string' && (pkg['description'] as string).length > 40);
  assert.ok(pkg['repository'], 'npm shows the source link on the listing');
});

test('a publish cannot ship an unbuilt or untested dist', () => {
  const scripts = json('package.json')['scripts'] as Record<string, string>;
  // `npm test` compiles first, so this covers both.
  assert.equal(scripts['prepublishOnly'], 'npm test');
});

test('the tarball carries the built connector and nothing else', async (t) => {
  // Asked of npm rather than inferred from the files list, because the list
  // is the intention and the tarball is the fact.
  const { execFileSync } = await import('node:child_process');

  let output: string;
  try {
    output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    t.skip('npm could not be run here');
    return;
  }

  const [tarball] = JSON.parse(output) as [{ files: { path: string }[] }];
  const paths = tarball.files.map((file) => file.path);

  assert.ok(paths.includes('dist/cli.js'), 'the entry point must ship');
  assert.ok(paths.includes('manifest.json'), 'the Claude Desktop bundle manifest must ship');
  assert.ok(paths.includes('README.md'), 'somebody installing this needs the instructions');

  const tests = paths.filter((path) => path.includes('.test.'));
  assert.deepEqual(tests, [], 'tests are not part of what an operator installs');

  const sources = paths.filter((path) => path.startsWith('src/'));
  assert.deepEqual(sources, [], 'the sources are on GitHub; the tarball carries the build');

  const handover = paths.filter((path) => path.includes('HANDOVER'));
  assert.deepEqual(handover, [], 'the handover is for whoever maintains this, not for npm');
});
