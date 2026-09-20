import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

/**
 * Every guard that refuses must return the reply it sent.
 *
 * Fastify's contract for an async hook is that returning the reply is what
 * says "I have answered this request". Sending without returning worked here
 * for a long time by accident: with exactly one `onSend` hook registered,
 * Fastify short-circuits anyway. Register a second one — which the connector's
 * idempotency plugin did — and it does not. Every refusal in the codebase then
 * became a refusal message with the action carried out behind it, including
 * the human approval standing between an agent and a deletion.
 *
 * This is a source assertion rather than a behaviour test because it is the
 * class, not the instance, that matters. A behaviour test covers the guard
 * somebody thought to write one for. This covers the guard somebody adds next
 * year.
 */
const GUARD_DIRECTORIES = ['src/middleware', 'src/plugins'];

/**
 * The same rule, for the handlers rather than the guards in front of them.
 *
 * A guard that does not return leaks the request past a refusal. A *handler*
 * that does not return makes Fastify answer a second time: `reply.sent` is
 * `raw.writableEnded`, still false while an async `onSend` hook runs, so a
 * handler resolving `undefined` looks like one that never answered. The second
 * answer re-runs every `onSend` hook and writes a head that is already
 * written — the live `ERR_HTTP_HEADERS_SENT`. Same shape, same fix, so the
 * same detector covers both. `tests/routes-answer-once.test.ts` holds the
 * behaviour this protects.
 */
const HANDLER_DIRECTORIES = ['src/routes'];

/** Files whose sends end the lifecycle rather than interrupt it. */
const EXEMPT = new Set([
  // The error handler and the not-found handler are the end of the request,
  // not a step in it. Both return anyway; the exemption is here so that a
  // change to either is a deliberate one.
  'src/plugins/error-handler.ts',
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const root = new URL(`../../${directory}/`, import.meta.url);
  const entries: Dirent[] = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    // Routes are nested a directory deep per resource, so this recurses; the
    // guard directories are flat and are unaffected by it.
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(`${directory}/${entry.name}`)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(`${directory}/${entry.name}`);
    }
  }
  return files;
}

/**
 * Statements that begin with `reply` and reach `.send(` before their
 * semicolon, minus the ones that are returned.
 *
 * A header set on its own is not a send and does not end a request, so
 * `reply.header(...)` alone is not an offender; `reply.header(...).send(...)`
 * is. Comments are stripped first, so prose about sending a reply is not
 * mistaken for one.
 */
function sendsWithoutReturning(source: string): number[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const statement = /(^|[;{}\n])([ \t]*)(return\s+)?reply\b[^;]*?\.send\s*\(/g;
  const lines: number[] = [];

  for (const match of code.matchAll(statement)) {
    if (match[3]) continue;
    // Counted from after the delimiter the match begins with: when that is a
    // newline, the match starts on the line above the statement.
    lines.push(code.slice(0, match.index + match[1]!.length).split('\n').length);
  }
  return lines;
}

/**
 * `handleError` is a send wearing a helper's name, so it needs the same rule.
 *
 * It returned `void` until this was fixed, which made the rule impossible to
 * obey: `return handleError(reply, err)` still resolved `undefined` and the
 * request was still answered twice. It returns the reply now, and this is what
 * stops the next call site dropping it.
 */
function handleErrorsWithoutReturning(source: string): number[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const statement = /(^|[;{}\n])([ \t]*)(return\s+)?handleError\s*\(/g;
  const lines: number[] = [];

  for (const match of code.matchAll(statement)) {
    if (match[3]) continue;
    lines.push(code.slice(0, match.index + match[1]!.length).split('\n').length);
  }
  return lines;
}

test('no guard sends a refusal without returning it', async () => {
  const offenders: string[] = [];

  for (const directory of GUARD_DIRECTORIES) {
    for (const file of await sourceFiles(directory)) {
      if (EXEMPT.has(file)) continue;
      const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
      for (const line of sendsWithoutReturning(source)) offenders.push(`${file}:${line}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'These send a reply without returning it. Fastify then carries on with the '
      + `request, so the thing being refused happens anyway:\n${offenders.join('\n')}`,
  );
});

test('no route handler answers without returning the answer', async () => {
  const offenders: string[] = [];

  for (const directory of HANDLER_DIRECTORIES) {
    for (const file of await sourceFiles(directory)) {
      const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
      for (const line of sendsWithoutReturning(source)) offenders.push(`${file}:${line}`);
      for (const line of handleErrorsWithoutReturning(source)) offenders.push(`${file}:${line}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'These answer the request without returning the answer. Fastify cannot tell '
      + 'that from a handler that never answered, so it answers a second time and '
      + `writes a head that is already written:\n${offenders.join('\n')}`,
  );
});

test('the detector finds the shape it is looking for', async () => {
  // Without this, a detector that matched nothing at all would report a clean
  // codebase for ever.
  assert.deepEqual(
    sendsWithoutReturning('async function guard(request, reply) {\n  reply.status(403).send({});\n}'),
    [2],
  );
  assert.deepEqual(
    sendsWithoutReturning('  reply\n    .header("retry-after", "2")\n    .status(429)\n    .send({});'),
    [1],
  );
  assert.deepEqual(
    sendsWithoutReturning('  return reply.status(403).send({});'),
    [],
    'a returned send is the correct shape',
  );
  assert.deepEqual(
    sendsWithoutReturning("  reply.header('X-Frame-Options', 'DENY');"),
    [],
    'a header on its own does not end a request',
  );
  assert.deepEqual(
    sendsWithoutReturning('  // reply.status(403).send({});'),
    [],
    'a comment is not code',
  );
});

test('the exemption list names only files that exist', async () => {
  // An exemption for a file somebody renamed covers nothing, silently, which
  // is how a list like this rots.
  const all = new Set((await Promise.all(GUARD_DIRECTORIES.map(sourceFiles))).flat());
  for (const file of EXEMPT) {
    assert.ok(all.has(file), `${file} is exempted but is not there any more`);
  }
});
