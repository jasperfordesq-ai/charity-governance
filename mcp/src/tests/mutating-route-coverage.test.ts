import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { TOOLS } from '../tools.js';
import { FILE_TOOLS } from '../file-tools.js';
import { EXCLUDED_MUTATIONS } from '../mutating-route-coverage.js';

const here = dirname(fileURLToPath(import.meta.url));
const API_ROUTES = resolve(here, '../../../apps/api/src/routes');

/**
 * Every route the API registers with a method that changes something.
 *
 * The whole routes tree is walked rather than each group's `index.ts`, because
 * several mutating routes live in sibling files — the owner realm and the
 * Confluence integration among them — and a scan that missed those would make
 * the coverage rule quietly weaker than it reads.
 */
const MUTATION = /[A-Za-z]*[Aa]pp\.(post|patch|put|delete)(?:<[^(]*>)?\(\s*['"]([^'"]*)['"]/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * The prefix each source file's routes are registered under.
 *
 * Read from the API's own wiring rather than guessed from the directory,
 * because two real cases break the guess: `/api/v1/organisation` is served
 * from `routes/organisations/`, and the connector auth routes live in
 * `routes/auth/connector.ts` but register under `/api/v1/auth/connector`
 * rather than under `/api/v1/auth`. A parser that got the second one wrong
 * would report connector sign-in as an unaccounted mutation on the browser
 * auth group, which is a confusing way to be told nothing useful.
 */
function prefixesByFile(): Map<string, string> {
  const server = readFileSync(resolve(API_ROUTES, '..', 'server.ts'), 'utf8');

  const importedFrom = new Map<string, string>();
  for (const match of server.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*'\.\/routes\/([A-Za-z-]+(?:\/[A-Za-z-]+)*)\.js'/g,
  )) {
    for (const name of match[1]!.split(',').map((n) => n.trim()).filter(Boolean)) {
      importedFrom.set(name, `${match[2]!}.ts`);
    }
  }

  const byFile = new Map<string, string>();
  for (const match of server.matchAll(
    /register\(\s*(\w+)\s*,\s*\{\s*prefix:\s*(?:'([^']+)'|(\w+))/g,
  )) {
    const file = importedFrom.get(match[1]!);
    if (!file) continue;

    let prefix = match[2];
    if (!prefix) {
      const constName = match[3]!;
      const constFile = importedFrom.get(constName) ?? file;
      const source = readFileSync(resolve(API_ROUTES, '..', 'routes', constFile), 'utf8');
      const value = new RegExp(`export const ${constName}\\s*=\\s*'([^']+)'`).exec(source);
      if (!value) continue;
      prefix = value[1]!;
    }
    if (prefix.startsWith('/api/v1')) byFile.set(file, prefix);
  }
  return byFile;
}

const SEPARATOR = /[\\/]/;

function prefixFor(relativeFile: string, byFile: Map<string, string>): string {
  const exact = byFile.get(relativeFile.split(SEPARATOR).join('/'));
  if (exact) return exact;

  // Registered indirectly by its group's index.ts (the owner realm and the
  // integrations group both do this), so it inherits the group's prefix.
  const directory = relativeFile.split(SEPARATOR)[0]!;
  const group = byFile.get(`${directory}/index.ts`);
  return group ?? `/api/v1/${directory}`;
}

function discoverMutations(): string[] {
  const byFile = prefixesByFile();
  const found: string[] = [];
  for (const file of sourceFiles(API_ROUTES)) {
    const relative = file.slice(API_ROUTES.length + 1);
    const prefix = prefixFor(relative, byFile);
    for (const match of readFileSync(file, 'utf8').matchAll(MUTATION)) {
      const sub = match[2]!;
      const path = sub === '/' ? prefix : `${prefix}${sub}`;
      found.push(`${match[1]!.toUpperCase()} ${path}`);
    }
  }
  return [...new Set(found)].sort();
}

/** `METHOD path` for every tool that changes something. */
function toolMutations(): Set<string> {
  const routes = new Set<string>();
  for (const tool of TOOLS) {
    if (tool.method) routes.add(`${tool.method} ${tool.path}`);
  }
  // The file tools are not ordinary tool definitions; both of their routes are
  // named here so the two lists cannot drift apart silently.
  for (const tool of FILE_TOOLS) {
    if (tool.name === 'document_upload') routes.add('POST /api/v1/documents');
  }
  return routes;
}

test('the mutation parser really finds routes', () => {
  const found = discoverMutations();

  // A parser that matched nothing would make every assertion below vacuous.
  assert.ok(found.length > 40, `expected many mutating routes, found ${found.length}`);
  assert.ok(
    found.includes('PATCH /api/v1/organisation'),
    'the singular-prefix, plural-directory case must resolve',
  );
  assert.ok(
    found.includes('POST /api/v1/owner/tenants'),
    'routes in sibling files must be found, not just those in index.ts',
  );
  assert.ok(
    found.includes('POST /api/v1/team/members/:id/suspend'),
    'routes registered on a nested scope must be found',
  );
  assert.ok(
    found.includes('POST /api/v1/auth/connector/approve'),
    'a file registered under its own sub-prefix must resolve to that prefix',
  );
});

test('every mutating route is either a tool or an exclusion with a reason', () => {
  const excluded = new Set(EXCLUDED_MUTATIONS.map((entry) => entry.route));
  const tools = toolMutations();

  const unaccounted = discoverMutations().filter(
    (route) => !tools.has(route) && !excluded.has(route),
  );

  assert.deepEqual(
    unaccounted,
    [],
    'these routes change data and the connector neither offers them nor says why not. '
      + 'Add a tool, or add an entry to EXCLUDED_MUTATIONS giving the reason.',
  );
});

test('no exclusion is stale', () => {
  const real = new Set(discoverMutations());
  const gone = EXCLUDED_MUTATIONS.filter(
    (entry) => !entry.notInGroupIndex && !real.has(entry.route),
  ).map((entry) => entry.route);

  assert.deepEqual(gone, [], 'these exclusions name routes the API no longer registers');
});

test('a route is never both a tool and an exclusion', () => {
  const tools = toolMutations();
  const both = EXCLUDED_MUTATIONS.filter((entry) => tools.has(entry.route)).map((e) => e.route);

  assert.deepEqual(both, [], 'an exclusion that is also offered says one thing and does another');
});

test('every exclusion gives a real reason', () => {
  for (const entry of EXCLUDED_MUTATIONS) {
    assert.ok(
      entry.reason.trim().length > 40,
      `${entry.route} needs a reason somebody can disagree with, not a label`,
    );
    assert.match(entry.route, /^(POST|PATCH|PUT|DELETE) \/api\/v1\//, `${entry.route} is malformed`);
  }
});

test('every write tool names a route the API registers with that method', () => {
  const real = new Set(discoverMutations());
  const missing = [...toolMutations()].filter((route) => !real.has(route));

  assert.deepEqual(
    missing,
    [],
    'a tool pointing at a route that does not exist fails only when somebody tries it',
  );
});
