import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LOCAL_ADMIN_EMAIL,
  DEFAULT_LOCAL_ADMIN_NAME,
  DEFAULT_LOCAL_ADMIN_ORGANISATION,
  getLocalAdminSeedConfig,
} from '../services/local-admin-seed.js';

test('local admin seed is disabled by default', () => {
  assert.equal(getLocalAdminSeedConfig({}).enabled, false);
});

test('local admin seed requires an explicit local admin password when enabled', () => {
  assert.throws(
    () => getLocalAdminSeedConfig({ SEED_LOCAL_ADMIN: 'true' }),
    /LOCAL_ADMIN_PASSWORD must be set when SEED_LOCAL_ADMIN=true/,
  );
});

test('local admin seed defaults create a verified owner with Complete access', () => {
  const config = getLocalAdminSeedConfig({
    SEED_LOCAL_ADMIN: 'true',
    LOCAL_ADMIN_PASSWORD: 'LocalAdmin123!',
  });

  assert.deepEqual(config, {
    enabled: true,
    email: DEFAULT_LOCAL_ADMIN_EMAIL,
    name: DEFAULT_LOCAL_ADMIN_NAME,
    organisationName: DEFAULT_LOCAL_ADMIN_ORGANISATION,
    password: 'LocalAdmin123!',
    subscriptionPlan: 'COMPLETE',
    subscriptionStatus: 'ACTIVE',
  });
});

test('legacy demo seed env maps to the local admin seed config', () => {
  const config = getLocalAdminSeedConfig({
    SEED_DEMO_WORKSPACE: 'true',
    DEMO_PASSWORD: 'LegacyDemo123!',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.email, 'demo@charitypilot.ie');
  assert.equal(config.name, 'Demo Owner');
  assert.equal(config.organisationName, 'CharityPilot Demo Charity');
  assert.equal(config.password, 'LegacyDemo123!');
});
