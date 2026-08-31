import assert from 'node:assert/strict';
import { test } from 'node:test';

// deployment-profile.ts caches MODE/APPLIANCE at module load — a deliberate
// mirror of how Next.js inlines process.env.NEXT_PUBLIC_* once, at build time
// (see the comment at the top of that file). Exercising both the
// appliance-derived and standard-derived defaults in one test process means
// forcing a fresh module evaluation per scenario: a plain top-level `import`
// would reuse whichever MODE was captured by the first evaluation. Node's
// CommonJS require cache is keyed by resolved path, so deleting that cache
// entry before each `require` forces the module to re-read `process.env`.
const MODULE_PATH = require.resolve('./deployment-profile');

type Axis = Record<string, string | undefined>;
type DeploymentProfileModule = typeof import('./deployment-profile');

const AXIS_KEYS = [
  'NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE',
  'NEXT_PUBLIC_CHARITYPILOT_TENANCY',
  'NEXT_PUBLIC_CHARITYPILOT_REGISTRATION',
  'NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY',
  'NEXT_PUBLIC_CHARITYPILOT_BILLING',
] as const;

function withEnv<T>(vars: Axis, fn: (mod: DeploymentProfileModule) => T): T {
  const saved: Axis = {};
  for (const key of AXIS_KEYS) saved[key] = process.env[key];
  for (const key of AXIS_KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  delete require.cache[MODULE_PATH];
  try {
    // Forced fresh reload; see the comment above `MODULE_PATH`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./deployment-profile') as DeploymentProfileModule;
    return fn(mod);
  } finally {
    for (const key of AXIS_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete require.cache[MODULE_PATH];
  }
}

test('appliance defaults: single tenancy, closed registration, manual links, no billing', () => {
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server' }, (mod) => {
    assert.equal(mod.webTenancyIsMulti(), false);
    assert.equal(mod.webRegistrationIsOpen(), false);
    assert.equal(mod.webEmailDelivery(), 'manual-link');
    assert.equal(mod.webBillingMode(), 'none');
  });
});

test('standard-mode defaults: multi tenancy, open registration, provider email, stripe billing', () => {
  withEnv({}, (mod) => {
    assert.equal(mod.webTenancyIsMulti(), true);
    assert.equal(mod.webRegistrationIsOpen(), true);
    assert.equal(mod.webEmailDelivery(), 'provider');
    assert.equal(mod.webBillingMode(), 'stripe');
  });
});

test('explicit values override the mode-derived default in both directions', () => {
  withEnv(
    { NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', NEXT_PUBLIC_CHARITYPILOT_TENANCY: 'multi' },
    (mod) => assert.equal(mod.webTenancyIsMulti(), true),
  );
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_TENANCY: 'single' }, (mod) => assert.equal(mod.webTenancyIsMulti(), false));

  withEnv(
    { NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', NEXT_PUBLIC_CHARITYPILOT_REGISTRATION: 'open' },
    (mod) => assert.equal(mod.webRegistrationIsOpen(), true),
  );
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_REGISTRATION: 'closed' }, (mod) => assert.equal(mod.webRegistrationIsOpen(), false));

  withEnv(
    { NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY: 'provider' },
    (mod) => assert.equal(mod.webEmailDelivery(), 'provider'),
  );
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY: 'manual-link' }, (mod) => assert.equal(mod.webEmailDelivery(), 'manual-link'));

  withEnv(
    { NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', NEXT_PUBLIC_CHARITYPILOT_BILLING: 'stripe' },
    (mod) => assert.equal(mod.webBillingMode(), 'stripe'),
  );
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_BILLING: 'none' }, (mod) => assert.equal(mod.webBillingMode(), 'none'));
});

test('the private-VM combination is representable', () => {
  withEnv(
    {
      NEXT_PUBLIC_CHARITYPILOT_TENANCY: 'multi',
      NEXT_PUBLIC_CHARITYPILOT_REGISTRATION: 'closed',
      NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
      NEXT_PUBLIC_CHARITYPILOT_BILLING: 'none',
    },
    (mod) => {
      assert.equal(mod.webTenancyIsMulti(), true);
      assert.equal(mod.webRegistrationIsOpen(), false);
      assert.equal(mod.webEmailDelivery(), 'manual-link');
      assert.equal(mod.webBillingMode(), 'none');
    },
  );
});

test('an invalid axis value throws loudly', () => {
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_TENANCY: 'both' }, (mod) => {
    assert.throws(() => mod.webTenancyIsMulti(), /Invalid deployment-profile value: both/);
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_REGISTRATION: 'yes' }, (mod) => {
    assert.throws(() => mod.webRegistrationIsOpen(), /Invalid deployment-profile value: yes/);
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY: 'smtp' }, (mod) => {
    assert.throws(() => mod.webEmailDelivery(), /Invalid deployment-profile value: smtp/);
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_BILLING: 'paypal' }, (mod) => {
    assert.throws(() => mod.webBillingMode(), /Invalid deployment-profile value: paypal/);
  });
});

test('whitespace or empty values are rejected, not treated as unset', () => {
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_TENANCY: ' multi' }, (mod) => {
    assert.throws(() => mod.webTenancyIsMulti(), /Invalid deployment-profile value/);
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_TENANCY: '' }, (mod) => {
    assert.throws(() => mod.webTenancyIsMulti(), /Invalid deployment-profile value/);
  });
});
