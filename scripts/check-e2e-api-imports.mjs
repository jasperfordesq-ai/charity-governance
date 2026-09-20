#!/usr/bin/env node
/**
 * The E2E harness may reach into apps/api, but only for dependency-free code.
 *
 * e2e/tsconfig.json compiles `**\/*.ts`, so anything the harness imports out of
 * apps/api is type-checked as part of the harness — and so is everything that
 * file imports, transitively. The harness installs its own node_modules
 * (`npm ci --prefix e2e`) and nothing else, so the moment that graph reaches a
 * module importing `fastify`, `@prisma/client` or any other third-party
 * package, `tsc` cannot resolve it and the E2E workflow fails. In the CI
 * workflow the same edge fails differently and more confusingly: the root
 * dependencies are installed, so the import resolves, but the harness is
 * type-checked before `db:generate` has written the Prisma client, so the
 * generated types are missing and the errors point at unrelated lines.
 *
 * Neither failure reproduces locally, because local module resolution walks up
 * to the root node_modules and finds everything. That is what makes this worth
 * a guard rather than a lesson: the only place it shows up is CI.
 *
 * The rule this enforces is the one the harness already followed by accident —
 * share pure modules (node: builtins and relative imports only), never a
 * service wired into the framework.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const E2E_DIR = join(REPO_ROOT, 'e2e');
const API_ROOT = join(REPO_ROOT, 'apps', 'api');

/** Directories that hold no harness sources worth scanning. */
const SKIP_DIRS = new Set(['node_modules', 'playwright-artifacts', 'test-results', 'dist', '.git']);

/**
 * Matches static and dynamic imports plus re-exports. Deliberately textual: a
 * full parse would need a TypeScript dependency, and this only has to read
 * first-party source written in the house style.
 */
const IMPORT_PATTERN = /(?:import|export)\s*(?:[\w*{}\n\r\t ,$]*?\s*from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function collectFiles(dir, extensions, found = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(join(dir, entry.name), extensions, found);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function importSpecifiers(filePath) {
  const source = readFileSync(filePath, 'utf8');
  const specifiers = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

/**
 * Resolve a relative specifier to a file on disk. The API is written as ESM
 * with `.js` specifiers that mean `.ts` on disk, which is the only case that
 * needs translating.
 */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    base,
    join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isBuiltin(specifier) {
  return specifier.startsWith('node:');
}

export async function findForbiddenImports() {
  const harnessFiles = await collectFiles(E2E_DIR, ['.ts', '.mts', '.cts']);

  /** API files the harness reaches, mapped to the chain that got there. */
  const entryPoints = new Map();
  for (const file of harnessFiles) {
    for (const specifier of importSpecifiers(file)) {
      if (!isRelative(specifier)) continue;
      const target = resolveRelative(file, specifier);
      if (!target || !target.startsWith(API_ROOT)) continue;
      if (!entryPoints.has(target)) {
        entryPoints.set(target, [relative(REPO_ROOT, file)]);
      }
    }
  }

  const violations = [];
  const seen = new Set();
  const queue = [...entryPoints.entries()].map(([file, chain]) => ({ file, chain }));

  while (queue.length > 0) {
    const { file, chain } = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    const here = [...chain, relative(REPO_ROOT, file)];
    for (const specifier of importSpecifiers(file)) {
      if (isBuiltin(specifier)) continue;
      if (!isRelative(specifier)) {
        violations.push({ chain: here, specifier });
        continue;
      }
      const target = resolveRelative(file, specifier);
      // An unresolvable relative import is the type-checker's problem, not
      // this guard's; staying quiet keeps the failure message about one thing.
      if (target && target.startsWith(API_ROOT)) queue.push({ file: target, chain: here });
    }
  }

  return { violations, reached: [...seen].map((file) => relative(REPO_ROOT, file)).sort() };
}

function formatViolation({ chain, specifier }) {
  const arrow = chain.map((step) => step.split('\\').join('/')).join('\n    -> ');
  return `  imports ${JSON.stringify(specifier)}\n    ${arrow}`;
}

async function main() {
  const { violations, reached } = await findForbiddenImports();

  if (violations.length === 0) {
    console.log(
      `E2E harness import check passed: ${reached.length} apps/api module(s) reached, all dependency-free.`,
    );
    return;
  }

  console.error(
    'The E2E harness reaches apps/api modules that import third-party packages.\n'
      + 'The harness installs only e2e/node_modules, so these cannot be type-checked there,\n'
      + 'and in CI the harness is type-checked before the Prisma client is generated.\n'
      + 'Share pure modules (node: builtins and relative imports only) instead.\n',
  );
  for (const violation of violations) console.error(formatViolation(violation));
  console.error(`\n${violations.length} forbidden import(s).`);
  process.exit(1);
}

// Only run when invoked directly, so the test can import the checker.
if (process.argv[1] && resolve(process.argv[1]).endsWith('check-e2e-api-imports.mjs')) {
  await main();
}
