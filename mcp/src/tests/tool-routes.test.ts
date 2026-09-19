import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TOOLS } from '../tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(here, '../../../apps/api/src');

/**
 * Maps each registered `/api/v1/...` prefix to the directory that serves it, by
 * following the API's own wiring rather than guessing that the prefix and the
 * directory share a name. Two real cases break that guess: `/api/v1/organisation`
 * is served from `routes/organisations/` (singular prefix, plural directory),
 * and the integrations prefix is an exported constant rather than a literal at
 * the registration site.
 */
function routeDirectoriesByPrefix(): Map<string, string> {
  const server = readFileSync(resolve(API_SRC, 'server.ts'), 'utf8');

  // import { xRoutes } from './routes/<dir>/index.js';
  const importedFrom = new Map<string, string>();
  for (const match of server.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*'\.\/routes\/([a-z-]+)\/index\.js'/g,
  )) {
    for (const name of match[1]!.split(',').map((n) => n.trim()).filter(Boolean)) {
      importedFrom.set(name, match[2]!);
    }
  }

  const byPrefix = new Map<string, string>();
  for (const match of server.matchAll(
    /register\(\s*(\w+)\s*,\s*\{\s*prefix:\s*(?:'([^']+)'|(\w+))/g,
  )) {
    const handler = match[1]!;
    const directory = importedFrom.get(handler);
    if (!directory) continue;

    let prefix = match[2];
    if (!prefix) {
      // prefix: SOME_CONST — resolve it in the module that exports it.
      const constName = match[3]!;
      const constDirectory = importedFrom.get(constName) ?? directory;
      const source = readFileSync(resolve(API_SRC, 'routes', constDirectory, 'index.ts'), 'utf8');
      const value = new RegExp(`export const ${constName}\\s*=\\s*'([^']+)'`).exec(source);
      if (!value) continue;
      prefix = value[1]!;
    }
    if (prefix.startsWith('/api/v1')) byPrefix.set(prefix, directory);
  }
  return byPrefix;
}

test('the wiring parser finds the route groups it is meant to follow', () => {
  const byPrefix = routeDirectoriesByPrefix();
  // A parser that matched nothing would let every tool path through
  // unchecked, so assert it really resolved the awkward cases.
  assert.ok(byPrefix.size > 8, `expected many route groups, found ${byPrefix.size}`);
  assert.equal(
    byPrefix.get('/api/v1/organisation'),
    'organisations',
    'a singular prefix served from a plural directory must resolve',
  );
  assert.equal(
    byPrefix.get('/api/v1/integrations'),
    'integrations',
    'a prefix declared as an exported constant must resolve',
  );
});

test('every tool path resolves to a route the API actually registers', () => {
  const byPrefix = routeDirectoriesByPrefix();
  const prefixes = [...byPrefix.keys()].sort((a, b) => b.length - a.length);
  const unresolved: string[] = [];

  for (const tool of TOOLS) {
    const prefix = prefixes.find(
      (candidate) => tool.path === candidate || tool.path.startsWith(`${candidate}/`),
    );
    if (!prefix) {
      unresolved.push(`${tool.name}: no route group registered for ${tool.path}`);
      continue;
    }

    const subPath = tool.path.slice(prefix.length) || '/';
    const routeFile = readFileSync(
      resolve(API_SRC, 'routes', byPrefix.get(prefix)!, 'index.ts'),
      'utf8',
    );
    if (!routeFile.includes(`'${subPath}'`) && !routeFile.includes(`"${subPath}"`)) {
      unresolved.push(`${tool.name}: routes/${byPrefix.get(prefix)!}/index.ts registers no '${subPath}'`);
    }
  }

  assert.deepEqual(
    unresolved,
    [],
    'A tool points at a route the API does not serve. It would 404 on first use.',
  );
});

test('every tool declares how its payload is gated', () => {
  // The dashboard, the compliance records, the document list and both deadline
  // tools each shipped for a while declaring nothing, so their records went
  // straight past the closed gate. A tool may name the single model its records
  // are, or a shape when the payload mixes models, or say in words why it
  // carries no records at all — but it may not stay silent.
  const silent = TOOLS.filter((tool) => !tool.model && !tool.shape && !tool.noRecordsBecause);
  assert.deepEqual(
    silent.map((tool) => tool.name),
    [],
    'A tool must declare a model, a shape, or a reason it carries no records.',
  );

  for (const tool of TOOLS) {
    assert.ok(
      !(tool.model && tool.shape),
      `${tool.name} declares both a model and a shape; it can only be one`,
    );
    if (tool.noRecordsBecause) {
      assert.ok(
        tool.noRecordsBecause.length > 25,
        `${tool.name}: say why it carries no records, in a sentence`,
      );
    }
  }
});

test('a tool with a path parameter declares it', () => {
  for (const tool of TOOLS) {
    for (const segment of tool.path.split('/')) {
      if (!segment.startsWith(':')) continue;
      const name = segment.slice(1);
      const declared = (tool.params ?? []).some(
        (param) => param.kind === 'id' && param.name === name,
      );
      assert.ok(declared, `${tool.name} has :${name} in its path but does not declare it`);
    }
  }
});
