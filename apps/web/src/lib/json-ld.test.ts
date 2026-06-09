import assert from 'node:assert/strict';
import test from 'node:test';
import { serialiseJsonLdForScript } from './json-ld';

test('serialises JSON-LD without allowing script tag breakouts', () => {
  const payload = serialiseJsonLdForScript({
    headline: '</script><script>alert("xss")</script>',
    description: 'Line separator \u2028 and paragraph separator \u2029 plus ampersand &',
  });

  assert.doesNotMatch(payload, /<\/script/i);
  assert.doesNotMatch(payload, /<script/i);
  assert.doesNotMatch(payload, /[\u2028\u2029]/);
  assert.match(payload, /\\u003c\/script\\u003e\\u003cscript\\u003e/);
  assert.match(payload, /\\u0026/);
  assert.deepEqual(JSON.parse(payload), {
    headline: '</script><script>alert("xss")</script>',
    description: 'Line separator \u2028 and paragraph separator \u2029 plus ampersand &',
  });
});
