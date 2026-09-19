import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TOOLS } from '../tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(here, '../../../apps/api/src');

test('every tool path resolves to a route the API actually registers', () => {
  const server = readFileSync(resolve(API_SRC, 'server.ts'), 'utf8');
  const unresolved: string[] = [];

  for (const tool of TOOLS) {
    const match = /^\/api\/v1\/([a-z-]+)(\/.*)?$/.exec(tool.path);
    if (!match) {
      unresolved.push(`${tool.name}: ${tool.path} is not an /api/v1/<group> path`);
      continue;
    }
    const group = match[1]!;
    const subPath = match[2] ?? '/';

    if (!server.includes(`prefix: '/api/v1/${group}'`)) {
      unresolved.push(`${tool.name}: no route group registered at /api/v1/${group}`);
      continue;
    }

    let routeFile: string;
    try {
      routeFile = readFileSync(resolve(API_SRC, 'routes', group, 'index.ts'), 'utf8');
    } catch {
      unresolved.push(`${tool.name}: routes/${group}/index.ts not found`);
      continue;
    }

    const registersSubPath =
      routeFile.includes(`'${subPath}'`) || routeFile.includes(`"${subPath}"`);
    if (!registersSubPath) {
      unresolved.push(`${tool.name}: routes/${group}/index.ts registers no '${subPath}'`);
    }
  }

  assert.deepEqual(
    unresolved,
    [],
    'A tool points at a route the API does not serve. It would 404 on first use.',
  );
});
