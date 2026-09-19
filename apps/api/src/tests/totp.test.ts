import assert from 'node:assert/strict';
import test from 'node:test';

const {
  hotp,
  totp,
  verifyTotp,
  toBase32,
  fromBase32,
  generateTotpSecret,
  totpEnrolmentUri,
  TOTP_PERIOD_SECONDS,
} = await import('../utils/totp.js');

/**
 * The published vectors are what make this implementation checkable rather than
 * merely plausible, which is the whole argument for writing the algorithm out
 * instead of taking a dependency.
 */
const RFC4226_SECRET = Buffer.from('12345678901234567890', 'utf8');

test('the RFC 4226 HOTP vectors all reproduce', () => {
  // Appendix D. Counter 0 through 9, the canonical table.
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];

  for (const [counter, code] of expected.entries()) {
    assert.equal(hotp(RFC4226_SECRET, counter), code, `counter ${counter}`);
  }
});

test('the RFC 6238 TOTP vectors reproduce for SHA-1', () => {
  // Appendix B, the SHA-1 rows, truncated to the six digits real
  // authenticators use rather than the eight the table prints.
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [seconds, eightDigits] of vectors) {
    assert.equal(
      totp(RFC4226_SECRET, seconds * 1000, 8),
      eightDigits,
      `t=${seconds}`,
    );
    assert.equal(
      totp(RFC4226_SECRET, seconds * 1000),
      eightDigits.slice(-6),
      `t=${seconds} truncated to six digits`,
    );
  }
});

test('base32 round-trips, and matches the known encoding of the RFC secret', () => {
  // "12345678901234567890" is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ in base32,
  // which is the string every authenticator test fixture on earth uses.
  assert.equal(toBase32(RFC4226_SECRET), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(fromBase32(toBase32(RFC4226_SECRET)), RFC4226_SECRET);
});

test('base32 decoding tolerates the way people paste secrets', () => {
  const secret = toBase32(RFC4226_SECRET);
  assert.deepEqual(fromBase32(secret.toLowerCase()), RFC4226_SECRET);
  assert.deepEqual(fromBase32(`${secret}====`), RFC4226_SECRET);
  assert.deepEqual(fromBase32(secret.replace(/(.{4})/g, '$1 ')), RFC4226_SECRET);
});

test('a secret that is not base32 is refused rather than decoded to nonsense', () => {
  assert.throws(() => fromBase32('not base32 at all!'), /not valid base32/);
});

test('a generated secret is 160 bits, which is what phones expect', () => {
  const secret = generateTotpSecret();

  assert.equal(fromBase32(secret).length, 20);
  assert.match(secret, /^[A-Z2-7]+$/);
});

test('two generated secrets differ', () => {
  assert.notEqual(generateTotpSecret(), generateTotpSecret());
});

test('a current code verifies and a stale one does not', () => {
  const secret = toBase32(RFC4226_SECRET);
  const now = 1_700_000_000_000;

  assert.equal(verifyTotp(secret, totp(RFC4226_SECRET, now), now), true);
  assert.equal(
    verifyTotp(secret, totp(RFC4226_SECRET, now - 5 * TOTP_PERIOD_SECONDS * 1000), now),
    false,
    'a code from two and a half minutes ago must not be accepted',
  );
});

test('one step of drift is accepted either side, and two is not', () => {
  const secret = toBase32(RFC4226_SECRET);
  const now = 1_700_000_000_000;
  const step = TOTP_PERIOD_SECONDS * 1000;

  assert.equal(verifyTotp(secret, totp(RFC4226_SECRET, now - step), now), true);
  assert.equal(verifyTotp(secret, totp(RFC4226_SECRET, now + step), now), true);
  assert.equal(
    verifyTotp(secret, totp(RFC4226_SECRET, now - 2 * step), now),
    false,
    'a wider window quietly halves the strength of the factor',
  );
  assert.equal(verifyTotp(secret, totp(RFC4226_SECRET, now + 2 * step), now), false);
});

test('a malformed code is refused without throwing', () => {
  const secret = toBase32(RFC4226_SECRET);

  for (const code of ['', '12345', '1234567', 'abcdef', '12 34 56 78', '../../etc']) {
    assert.equal(verifyTotp(secret, code), false, `"${code}" must not verify`);
  }
});

test('a code with spaces in it still verifies, because people paste them that way', () => {
  const now = 1_700_000_000_000;
  const code = totp(RFC4226_SECRET, now);

  assert.equal(verifyTotp(toBase32(RFC4226_SECRET), `${code.slice(0, 3)} ${code.slice(3)}`, now), true);
});

test('a malformed secret makes verification fail rather than throw', () => {
  // A stored secret that cannot be decoded is a broken enrolment, and the
  // caller should see a refused code rather than a crashed request.
  assert.equal(verifyTotp('!!!not base32!!!', '123456'), false);
  assert.equal(verifyTotp('', '123456'), false);
});

test('the enrolment URI is one an authenticator can actually read', () => {
  const uri = totpEnrolmentUri({
    secret: 'GEZDGNBVGY3TQOJQ',
    account: 'operator@example.org',
    issuer: 'CharityPilot Platform',
  });

  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /secret=GEZDGNBVGY3TQOJQ/);
  assert.match(uri, /algorithm=SHA1/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
  // Both the label prefix and the parameter, and both encoded: an issuer or an
  // address containing a space or a colon must not break the URI.
  assert.match(uri, /totp\/CharityPilot%20Platform:operator%40example\.org\?/);
  assert.match(uri, /issuer=CharityPilot\+Platform/);
});

test('the code changes every period and not within one', () => {
  const base = 1_700_000_000_000;
  const period = TOTP_PERIOD_SECONDS * 1000;
  const start = Math.floor(base / period) * period;

  assert.equal(totp(RFC4226_SECRET, start), totp(RFC4226_SECRET, start + period - 1));
  assert.notEqual(totp(RFC4226_SECRET, start), totp(RFC4226_SECRET, start + period));
});
