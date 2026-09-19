import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, registerSecret, clearSecrets } from '../redact.js';

beforeEach(() => clearSecrets());

test('a registered secret is replaced wherever it appears', () => {
  registerSecret('eyJhbGciOiJIUzI1NiJ9.abc');
  const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc failed');
  assert.equal(out, 'Authorization: Bearer [redacted] failed');
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9.abc'));
});

test('every occurrence is replaced, not just the first', () => {
  // Must be longer than the 8-character floor in registerSecret, or it is ignored.
  registerSecret('tok_1234567890');
  assert.equal(
    redactSecrets('tok_1234567890 and tok_1234567890'),
    '[redacted] and [redacted]',
  );
});

test('the length floor is exactly 8: a 9-character secret registers', () => {
  registerSecret('123456789');
  assert.equal(redactSecrets('123456789'), '[redacted]');
});

test('bearer-looking values are redacted even when never registered', () => {
  const out = redactSecrets('Authorization: Bearer aaa.bbb.ccc');
  assert.ok(!out.includes('aaa.bbb.ccc'));
});

test('cookie values are redacted even when never registered', () => {
  const out = redactSecrets('Set-Cookie: charitypilot_refresh=opaquevalue; Path=/');
  assert.ok(!out.includes('opaquevalue'));
});

test('short or empty secrets are ignored so redaction cannot blank the output', () => {
  registerSecret('');
  registerSecret('ab');
  assert.equal(redactSecrets('ab cd'), 'ab cd');
});

test('the length floor rejects exactly 8 characters', () => {
  registerSecret('12345678');
  assert.equal(redactSecrets('12345678'), '12345678', 'an 8-character value must not register');
});

test('an overlapping secret cannot leave a fragment of a longer one behind', () => {
  // Shorter FIRST: this is the only registration order under which unsorted
  // iteration replaces the short secret first and leaves the longer one's tail behind.
  registerSecret('abcdef1234');
  registerSecret('abcdef1234567890');
  const out = redactSecrets('token abcdef1234567890 here');
  assert.ok(!out.includes('567890'), 'no fragment of the longer secret may survive');
  assert.equal(out, 'token [redacted] here');
});
