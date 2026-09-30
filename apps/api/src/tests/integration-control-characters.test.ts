import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normaliseDeclaredValue } from '../services/integration-declared-environment.service.js';
import { integrationAuditActor } from '../services/integration-audit.service.js';

test('integration declarations reject embedded controls and audit labels strip them', async () => {
  const controls = [...Array(32).keys(), ...Array.from({ length: 33 }, (_, index) => 127 + index)];
  for (const point of controls) {
    const char = String.fromCharCode(point);
    // Line breaks retain their existing declaration normalization semantics.
    if (point !== 10 && point !== 13) {
      assert.throws(() => normaliseDeclaredValue('plan', `a${char}b`), /unsupported control/);
    }
    const actor = await integrationAuditActor({
      user: { findFirst: async () => ({ name: `a${char}b`, email: 'synthetic@example.invalid' }) },
    }, { userId: 'synthetic-user', organisationId: 'synthetic-charity' });
    assert.equal(actor.label, 'ab', `audit label control U+${point.toString(16)}`);
  }
  assert.equal(normaliseDeclaredValue('plan', ' EU (Ireland) '), 'EU (Ireland)');
});
