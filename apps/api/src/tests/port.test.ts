import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePort } from '../utils/port.js';

test('parsePort accepts exact integer ports', () => {
  assert.equal(parsePort('3002', 3001), 3002);
  assert.equal(parsePort(undefined, 3002), 3002);
});

test('parsePort rejects malformed or out-of-range port values', () => {
  for (const value of ['3002abc', '0', '65536', '-1', '']) {
    assert.throws(() => parsePort(value, 3002), /PORT must be an integer from 1 to 65535/);
  }
});
