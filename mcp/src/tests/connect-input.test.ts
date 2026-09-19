import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readPasswordFromStdin, assertNonInteractiveConnectAllowed } from '../connect-input.js';

function stream(chunks: Buffer[]): AsyncIterable<Buffer> {
  return Readable.from(chunks) as unknown as AsyncIterable<Buffer>;
}

test('the password is the first line, without its terminator', async () => {
  const value = await readPasswordFromStdin(stream([Buffer.from('hunter2\n')]));
  assert.equal(value, 'hunter2');
});

test('a CRLF terminator is stripped', async () => {
  const value = await readPasswordFromStdin(stream([Buffer.from('hunter2\r\n')]));
  assert.equal(value, 'hunter2');
});

test('anything after the first line is ignored', async () => {
  const value = await readPasswordFromStdin(stream([Buffer.from('hunter2\nignored\n')]));
  assert.equal(value, 'hunter2');
});

test('a multi-byte character split across chunks survives', async () => {
  // "Siobhán" — the á is 0xC3 0xA1, delivered in two separate reads. Decoding
  // each chunk on its own would produce a replacement character.
  const full = Buffer.from('Siobhán1x\n', 'utf8');
  const split = full.indexOf(0xc3) + 1;
  const value = await readPasswordFromStdin(
    stream([full.subarray(0, split), full.subarray(split)]),
  );
  assert.equal(value, 'Siobhán1x');
});

test('an empty stdin is an error rather than an empty password', async () => {
  await assert.rejects(() => readPasswordFromStdin(stream([])), /no password/i);
});

test('--password-stdin is refused outside the local profile', () => {
  assert.throws(
    () => assertNonInteractiveConnectAllowed({ profile: 'default', passwordStdin: true }, false),
    /--profile local/,
  );
});

test('--password-stdin is refused when stdin is a terminal', () => {
  assert.throws(
    () => assertNonInteractiveConnectAllowed({ profile: 'local', passwordStdin: true }, true),
    /terminal/i,
  );
});

test('an interactive connect is unaffected', () => {
  assert.doesNotThrow(
    () => assertNonInteractiveConnectAllowed({ profile: 'default', passwordStdin: false }, true),
  );
});
