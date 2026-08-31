import assert from 'node:assert/strict';
import { test } from 'node:test';

const [{ isMultiTenant, isRegistrationOpen, emailDeliveryMode, billingMode }] =
  await Promise.all([import('../utils/deployment-profile.js')]);

const APPLIANCE = { CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server' };
const DEFAULT = {};

test('appliance defaults: single tenancy, closed registration, manual links, no billing', () => {
  assert.equal(isMultiTenant(APPLIANCE), false);
  assert.equal(isRegistrationOpen(APPLIANCE), false);
  assert.equal(emailDeliveryMode(APPLIANCE), 'manual-link');
  assert.equal(billingMode(APPLIANCE), 'none');
});

test('default-mode defaults: multi tenancy, open registration, provider email, stripe billing', () => {
  assert.equal(isMultiTenant(DEFAULT), true);
  assert.equal(isRegistrationOpen(DEFAULT), true);
  assert.equal(emailDeliveryMode(DEFAULT), 'provider');
  assert.equal(billingMode(DEFAULT), 'stripe');
});

test('explicit values override the mode-derived default in both directions', () => {
  assert.equal(isMultiTenant({ ...APPLIANCE, CHARITYPILOT_TENANCY: 'multi' }), true);
  assert.equal(isMultiTenant({ CHARITYPILOT_TENANCY: 'single' }), false);
  assert.equal(isRegistrationOpen({ ...APPLIANCE, CHARITYPILOT_REGISTRATION: 'open' }), true);
  assert.equal(isRegistrationOpen({ CHARITYPILOT_REGISTRATION: 'closed' }), false);
  assert.equal(emailDeliveryMode({ ...APPLIANCE, CHARITYPILOT_EMAIL_DELIVERY: 'provider' }), 'provider');
  assert.equal(emailDeliveryMode({ CHARITYPILOT_EMAIL_DELIVERY: 'manual-link' }), 'manual-link');
  assert.equal(billingMode({ ...APPLIANCE, CHARITYPILOT_BILLING: 'stripe' }), 'stripe');
  assert.equal(billingMode({ CHARITYPILOT_BILLING: 'none' }), 'none');
});

test('the private-VM combination is representable', () => {
  const vm = {
    CHARITYPILOT_TENANCY: 'multi',
    CHARITYPILOT_REGISTRATION: 'closed',
    CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
    CHARITYPILOT_BILLING: 'none',
  };
  assert.equal(isMultiTenant(vm), true);
  assert.equal(isRegistrationOpen(vm), false);
  assert.equal(emailDeliveryMode(vm), 'manual-link');
  assert.equal(billingMode(vm), 'none');
});

test('an invalid axis value throws loudly and names the variable', () => {
  assert.throws(() => isMultiTenant({ CHARITYPILOT_TENANCY: 'both' }), /CHARITYPILOT_TENANCY/);
  assert.throws(() => isRegistrationOpen({ CHARITYPILOT_REGISTRATION: 'yes' }), /CHARITYPILOT_REGISTRATION/);
  assert.throws(() => emailDeliveryMode({ CHARITYPILOT_EMAIL_DELIVERY: 'smtp' }), /CHARITYPILOT_EMAIL_DELIVERY/);
  assert.throws(() => billingMode({ CHARITYPILOT_BILLING: 'paypal' }), /CHARITYPILOT_BILLING/);
});

test('whitespace or empty values are rejected, not treated as unset', () => {
  assert.throws(() => isMultiTenant({ CHARITYPILOT_TENANCY: ' multi' }), /CHARITYPILOT_TENANCY/);
  assert.throws(() => isMultiTenant({ CHARITYPILOT_TENANCY: '' }), /CHARITYPILOT_TENANCY/);
});
