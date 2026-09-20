import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';

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

/** Files whose sends end the lifecycle rather than interrupt it. */
const EXEMPT = new Set([
  // The error handler and the not-found handler are the end of the request,
  // not a step in it. Both return anyway; the exemption is here so that a
  // change to either is a deliberate one.
  'src/plugins/error-handler.ts',
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const root = new URL(`../../${directory}/`, import.meta.url);
  const entries = await readdir(root);
  return entries.filter((name) => name.endsWith('.ts')).map((name) => `${directory}/${name}`);
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
