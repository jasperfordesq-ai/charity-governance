#!/usr/bin/env node
/**
 * Breaks an API guard on purpose and requires its own test to notice.
 *
 * The sibling of `mcp-live-canary.mjs`, for guards that a unit test covers
 * rather than the live stack: it is seconds rather than minutes, so a guard
 * added to a service or a route can be checked as it is written.
 *
 * A green test proves nothing until it has been shown to go red. Every
 * mutation below is valid TypeScript that still compiles and still calls the
 * thing it is breaking — a mutation that does not build would make the test
 * fail for the wrong reason, and the canary would congratulate itself.
 *
 * Usage:
 *   node scripts/api-guard-canary.mjs              # every mutation
 *   node scripts/api-guard-canary.mjs <name>       # one of them
 *
 * Run from the repository root.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Anchors carry `\r?\n` because these sources are checked out with CRLF
// endings on Windows; a plain "\n" anchor silently matches nothing, and a
// canary that cannot apply its mutation would report the suite failing for
// the wrong reason.
const MUTATIONS = {
  'document-edit-ignores-a-stale-read': {
    file: 'apps/api/src/services/document.service.ts',
    // Still called, still comparing two timestamps, so nothing is left unused
    // and the build stays honest. It simply always agrees, which is what "the
    // check stopped working" looks like from the outside.
    find: /assertUnchanged\(existing, expectedUpdatedAt, 'DOCUMENT_UPDATE_CONFLICT'\);/,
    replace:
      "assertUnchanged({ ...existing, updatedAt: new Date(expectedUpdatedAt ?? existing.updatedAt) },"
      + " expectedUpdatedAt, 'DOCUMENT_UPDATE_CONFLICT');",
    tests: ['documents-route'],
    expect: 'an edit carrying a stale updatedAt must be refused with DOCUMENT_UPDATE_CONFLICT.',
  },
  'a-null-cannot-clear-a-date': {
    file: 'apps/api/src/services/document.service.ts',
    // The collapse of null into undefined that a hand-written PATCH mapper
    // reaches for by habit. It looks identical until somebody clears a field.
    find: /  value === undefined \? undefined : value === null \? null : new Date\(value\);/,
    replace: '  value ? new Date(value) : undefined;',
    tests: ['documents-route'],
    expect: 'an explicit null must clear a review date rather than leave it alone.',
  },
  'an-empty-edit-is-accepted': {
    file: 'packages/shared/src/schemas/document.ts',
    find: /    if \(changed\.length === 0\) \{/,
    replace: '    if (changed.length < 0) {',
    shared: true,
    tests: ['documents-route'],
    expect:
      'an edit naming no field CharityPilot will change must be refused, not answered with a 200.',
  },
  'any-charity-may-read-any-trustee': {
    file: 'apps/api/src/services/board-member.service.ts',
    // The charity is still named in the query, so the parameter is still used
    // and the file still compiles; the filter simply excludes an identifier no
    // charity has, which matches every charity.
    find: /where: \{ id, organisationId \} \}\);/,
    replace: 'where: { id, organisationId: { not: `${organisationId}-no-charity` } } });',
    tests: ['board-members-reliability'],
    expect: 'reading one trustee must be scoped to the caller’s own charity.',
  },
  'any-charity-may-read-any-act': {
    file: 'apps/api/src/services/governing-act.service.ts',
    // Anchored on getById's own signature: the same where/include pair appears
    // four more times in this file, and mutating one of those would prove
    // something about a different method.
    find: /(async getById\(organisationId: string, id: string\): Promise<GoverningAct> \{\r?\n    const act = await this\.prisma\.governingAct\.findFirst\(\{\r?\n      where: \{ id, organisationId)( \},)/,
    replace: '$1: { not: `${organisationId}-no-charity` }$2',
    tests: ['governing-acts-reliability'],
    expect: 'reading one act must be scoped to the caller’s own charity.',
  },
  // The read budget. All three of these leave a key generator that still
  // compiles and still returns a string, which is what a regression here
  // would look like: nothing throws, and the limiter quietly counts the
  // wrong thing.
  'an-invented-token-buys-its-own-budget': {
    file: 'apps/api/src/utils/rate-limit-key.ts',
    find: /(  \} catch \{\r?\n    )return request\.ip;/,
    replace: '$1return `session:${token}`;',
    tests: ['rate-limit-key'],
    expect:
      'a bearer token that does not verify must fall back to the address, or the address '
      + 'limiter can be evaded by inventing a new token per request.',
  },
  'a-session-can-be-mistaken-for-an-address': {
    file: 'apps/api/src/utils/rate-limit-key.ts',
    find: /return `session:\$\{verifyAccessToken\(token\)\.sessionId\}`;/,
    replace: 'return `${verifyAccessToken(token).sessionId}`;',
    tests: ['rate-limit-key'],
    expect: 'a session key must be prefixed so it can never collide with an address.',
  },
  'the-limiter-ignores-the-session': {
    file: 'apps/api/src/server.ts',
    // The generator is still referenced, so the import is still used and the
    // build stays honest; it is simply never the value that is returned.
    find: /  keyGenerator: sessionOrAddressRateLimitKey,/,
    replace:
      '  keyGenerator: (request) => String(request.ip ?? sessionOrAddressRateLimitKey(request)),',
    tests: ['rate-limit-key'],
    expect: 'the shared limiter must be keyed by session, not only by address.',
  },
  'a-member-may-edit-a-document': {
    file: 'apps/api/src/routes/documents/index.ts',
    find: /(  app\.patch<\{ Params: \{ id: string \} \}>\('\/:id', )\{ preHandler: \[requireAdmin\] \}, (async)/,
    replace: '$1$2',
    tests: ['documents-route'],
    expect: 'a member must be refused a document edit.',
  },
};

const requested = process.argv[2];
if (requested !== undefined && !(requested in MUTATIONS)) {
  console.error(`Usage: node scripts/api-guard-canary.mjs [${Object.keys(MUTATIONS).join('|')}]`);
  process.exit(2);
}
const selected = requested === undefined ? Object.keys(MUTATIONS) : [requested];

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'pipe', shell: true });
}

function build(withShared) {
  // `packages/shared` is a built package: a schema change that is not compiled
  // never reaches the API, so a canary that skipped this step would report a
  // mutation working when it had never been applied.
  if (withShared) run('npm', ['run', 'build'], 'packages/shared');
  run('npx', ['tsc', '-p', 'tsconfig.json'], 'apps/api');
}

let problems = 0;

for (const name of selected) {
  const mutation = MUTATIONS[name];
  const original = readFileSync(mutation.file, 'utf8');
  const occurrences = (original.match(new RegExp(mutation.find.source, 'g')) ?? []).length;

  if (occurrences !== 1) {
    console.error(
      `CANARY BROKEN: "${name}" expected exactly one anchor in ${mutation.file}, found `
        + `${occurrences}. Update the mutation rather than letting it hit the wrong place.`,
    );
    problems += 1;
    continue;
  }

  let outcome = 'unknown';
  try {
    writeFileSync(mutation.file, original.replace(mutation.find, mutation.replace));
    try {
      build(mutation.shared === true);
    } catch {
      outcome = 'build-broken';
      throw new Error('build');
    }
    try {
      run(
        'node',
        ['--test', ...mutation.tests.map((file) => `dist/tests/${file}.test.js`)],
        'apps/api',
      );
      outcome = 'tests-passed';
    } catch {
      outcome = 'tests-failed';
    }
  } catch {
    // Falls through to the restore below with `outcome` already set.
  } finally {
    writeFileSync(mutation.file, original);
  }

  if (outcome === 'tests-failed') {
    console.log(`ok   ${name}`);
    continue;
  }

  problems += 1;
  if (outcome === 'build-broken') {
    console.error(
      `CANARY BROKEN: "${name}" does not compile, so the tests would have failed for the wrong `
        + 'reason. Rewrite the mutation so it is valid code that behaves wrongly.',
    );
  } else {
    console.error(`CANARY FAILED: the tests passed with "${name}" applied. ${mutation.expect}`);
  }
}

// Leaves the tree built from the restored sources, whichever mutation ran.
build(true);

console.log(problems === 0 ? 'Every canary behaved correctly.' : `${problems} canary problem(s).`);
process.exit(problems === 0 ? 0 : 1);
