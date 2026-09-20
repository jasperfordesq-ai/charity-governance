import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TOOLS } from '../tools.js';
import { OPERATOR_TOOLS } from '../operator-tools.js';
import { EXCLUDED_ROUTES } from '../route-coverage.js';

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(here, '../../../apps/api/src');

/** Follows the API's wiring: prefix -> the directory that serves it. */
function routeDirectoriesByPrefix(): Map<string, string> {
  const server = readFileSync(resolve(API_SRC, 'server.ts'), 'utf8');

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
    const directory = importedFrom.get(match[1]!);
    if (!directory) continue;

    let prefix = match[2];
    if (!prefix) {
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

/**
 * Every GET route registered in a group's index.ts, as a full path.
 *
 * The pattern has to tolerate three things the API really does: a generic
 * between `get` and its arguments (`app.get<{ Params: ... }>(`), registration
 * on a nested scope under a different name (`authedApp.get(`), and either
 * quote style with the path on its own line.
 */
const GET_REGISTRATION = /\b\w+\.get(?:<[^>]*>)?\(\s*['"]([^'"]*)['"]/g;

function discoverGetRoutes(): string[] {
  const found: string[] = [];
  for (const [prefix, directory] of routeDirectoriesByPrefix()) {
    const source = readFileSync(resolve(API_SRC, 'routes', directory, 'index.ts'), 'utf8');
    for (const match of source.matchAll(GET_REGISTRATION)) {
      const subPath = match[1]!;
      found.push(subPath === '/' ? prefix : `${prefix}${subPath}`);
    }
  }
  return [...new Set(found)].sort();
}

test('the route parser really finds routes', () => {
  const routes = discoverGetRoutes();
  // A parser that silently matched nothing would make every assertion below
  // pass unconditionally, which is how a drift guard in this repo once came to
  // audit an empty list.
  assert.ok(
    routes.length > 30,
    `expected more than 30 GET routes, found ${routes.length}. The parser is broken, not the API.`,
  );
  for (const expected of [
    '/api/v1/board-members',
    '/api/v1/documents/:id/download',
    '/api/v1/governance-registers/conflicts',
    '/api/v1/team',
  ]) {
    assert.ok(routes.includes(expected), `expected to discover ${expected}`);
  }
});

test('every readable route is either a tool or an exclusion with a reason', () => {
  const toolPaths = new Set([...TOOLS, ...OPERATOR_TOOLS].map((tool) => tool.path));
  const excludedPaths = new Set(EXCLUDED_ROUTES.map((entry) => entry.path));

  const uncovered = discoverGetRoutes().filter(
    (route) => !toolPaths.has(route) && !excludedPaths.has(route),
  );

  assert.deepEqual(
    uncovered,
    [],
    'A readable route is neither exposed as a tool nor listed in mcp/src/route-coverage.ts. '
      + 'Decide which it is: leaving it out silently is how a route nobody noticed becomes a '
      + 'question the connector cannot answer, or a payload nobody gated.',
  );
});

test('no exclusion is stale', () => {
  const discovered = new Set(discoverGetRoutes());
  const stale = EXCLUDED_ROUTES.filter(
    (entry) => !entry.notInGroupIndex && !discovered.has(entry.path),
  ).map((entry) => entry.path);

  assert.deepEqual(
    stale,
    [],
    'An excluded route no longer exists. Remove it, so the list stays a record of live '
      + 'decisions rather than of routes that once existed.',
  );
});

test('a route is never both a tool and an exclusion', () => {
  const toolPaths = new Set([...TOOLS, ...OPERATOR_TOOLS].map((tool) => tool.path));
  const both = EXCLUDED_ROUTES.filter((entry) => toolPaths.has(entry.path)).map((e) => e.path);
  assert.deepEqual(both, [], 'A route cannot be both exposed and excluded.');
});

test('every exclusion gives a real reason', () => {
  for (const entry of EXCLUDED_ROUTES) {
    assert.ok(
      entry.reason.trim().length > 40,
      `${entry.path}: the reason must be a sentence someone can disagree with, not a label`,
    );
  }
});
