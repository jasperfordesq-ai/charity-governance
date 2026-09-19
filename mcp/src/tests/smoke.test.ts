import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTOR_VERSION } from '../version.js';

test('the package exposes a semver version string', () => {
  assert.match(CONNECTOR_VERSION, /^\d+\.\d+\.\d+$/);
});
