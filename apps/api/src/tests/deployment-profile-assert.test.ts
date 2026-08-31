import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../utils/errors.js';
import { assertDeploymentProfile } from '../utils/deployment-profile.js';
import { validateRuntimeEnv } from '../utils/personal-server-env.js';

const APPLIANCE_DEFAULT = { CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server' };
const STANDARD_DEFAULT = {};

test('both default profiles are coherent: neither the appliance nor the standard default throws', () => {
  assert.doesNotThrow(() => assertDeploymentProfile(APPLIANCE_DEFAULT));
  assert.doesNotThrow(() => assertDeploymentProfile(STANDARD_DEFAULT));
});

test('open registration with manual-link email delivery is refused, naming both axes', () => {
  assert.throws(
    () =>
      assertDeploymentProfile({
        CHARITYPILOT_REGISTRATION: 'open',
        CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
      }),
    (error: unknown) =>
      error instanceof Error &&
      /CHARITYPILOT_REGISTRATION/.test(error.message) &&
      /CHARITYPILOT_EMAIL_DELIVERY/.test(error.message) &&
      /manual-link/.test(error.message),
  );
});

test('single tenancy with open registration is refused, naming both axes', () => {
  assert.throws(
    () =>
      assertDeploymentProfile({
        CHARITYPILOT_TENANCY: 'single',
        CHARITYPILOT_REGISTRATION: 'open',
      }),
    (error: unknown) =>
      error instanceof Error &&
      /CHARITYPILOT_TENANCY/.test(error.message) &&
      /CHARITYPILOT_REGISTRATION/.test(error.message),
  );
});

test('registration open with manual-link email but multi tenancy explicit is still refused only for the email/registration reason', () => {
  // Confirms the two checks are independent: multi tenancy alone doesn't
  // suppress the registration/email-delivery contradiction.
  assert.throws(
    () =>
      assertDeploymentProfile({
        CHARITYPILOT_TENANCY: 'multi',
        CHARITYPILOT_REGISTRATION: 'open',
        CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
      }),
    /CHARITYPILOT_EMAIL_DELIVERY/,
  );
});

test('an invalid axis value fails at the assert, naming the variable', () => {
  assert.throws(() => assertDeploymentProfile({ CHARITYPILOT_BILLING: 'paypal' }), /CHARITYPILOT_BILLING/);
  assert.throws(() => assertDeploymentProfile({ CHARITYPILOT_TENANCY: 'both' }), /CHARITYPILOT_TENANCY/);
  assert.throws(() => assertDeploymentProfile({ CHARITYPILOT_REGISTRATION: 'yes' }), /CHARITYPILOT_REGISTRATION/);
  assert.throws(() => assertDeploymentProfile({ CHARITYPILOT_EMAIL_DELIVERY: 'smtp' }), /CHARITYPILOT_EMAIL_DELIVERY/);
});

// Wiring: validateRuntimeEnv must call assertDeploymentProfile() BEFORE
// either branch's own validator, in both the appliance and the standard
// (production) path. Proven without building a fully valid environment for
// either branch: an incoherent axis combination is supplied, and every other
// var the branch-specific validator would need is left unset/invalid. If
// assertDeploymentProfile ran first as required, the thrown error is a plain
// Error naming the axis contradiction. If the branch-specific validator ran
// first instead, it would throw its own AppError (PERSONAL_SERVER_ENV_INVALID
// or PRODUCTION_ENV_INVALID) with a details array instead — proving the
// ordering, not just that a throw happened.
const RUNTIME_ENV_KEYS = [
  'CHARITYPILOT_DEPLOYMENT_MODE',
  'CHARITYPILOT_TENANCY',
  'CHARITYPILOT_REGISTRATION',
  'CHARITYPILOT_EMAIL_DELIVERY',
  'CHARITYPILOT_BILLING',
] as const;

function withRuntimeEnv(vars: Partial<Record<(typeof RUNTIME_ENV_KEYS)[number], string | undefined>>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of RUNTIME_ENV_KEYS) saved[key] = process.env[key];
  for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('validateRuntimeEnv asserts the deployment profile before the appliance validator', () => {
  withRuntimeEnv(
    {
      CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
      CHARITYPILOT_TENANCY: 'single',
      CHARITYPILOT_REGISTRATION: 'open',
      // Isolates the tenancy/registration contradiction: without this, the
      // appliance's manual-link email default would also be incoherent with
      // open registration, and that check fires first.
      CHARITYPILOT_EMAIL_DELIVERY: 'provider',
    },
    () => {
      assert.throws(
        () => validateRuntimeEnv(),
        (error: unknown) =>
          error instanceof Error &&
          !(error instanceof AppError) &&
          /CHARITYPILOT_TENANCY/.test(error.message) &&
          /CHARITYPILOT_REGISTRATION/.test(error.message),
      );
    },
  );
});

test('validateRuntimeEnv asserts the deployment profile before the standard (production) validator', () => {
  withRuntimeEnv(
    {
      CHARITYPILOT_DEPLOYMENT_MODE: undefined,
      CHARITYPILOT_REGISTRATION: 'open',
      CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
    },
    () => {
      assert.throws(
        () => validateRuntimeEnv(),
        (error: unknown) =>
          error instanceof Error &&
          !(error instanceof AppError) &&
          /CHARITYPILOT_REGISTRATION/.test(error.message) &&
          /CHARITYPILOT_EMAIL_DELIVERY/.test(error.message),
      );
    },
  );
});
