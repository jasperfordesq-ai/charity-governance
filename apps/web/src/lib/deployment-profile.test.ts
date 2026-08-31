import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  webTenancyIsMulti,
  webRegistrationIsOpen,
  webEmailDelivery,
  webBillingMode,
} from './deployment-profile';

// deployment-profile.ts reads process.env fresh on every call (see the
// comment at the top of that file) rather than caching anything at module
// load — required so proxy.ts (a long-lived Node server process handling
// many requests) sees the real, current environment rather than whatever was
// present when the module first loaded. That means a plain save/restore
// around process.env, with no module-cache tricks, is enough to exercise
// every scenario in this one process — mirroring Task 1's API-side cases.
type Axis = Record<string, string | undefined>;

const AXIS_KEYS = [
  'NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE',
  'NEXT_PUBLIC_CHARITYPILOT_TENANCY',
  'NEXT_PUBLIC_CHARITYPILOT_REGISTRATION',
  'NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY',
  'NEXT_PUBLIC_CHARITYPILOT_BILLING',
] as const;

function withEnv<T>(vars: Axis, fn: () => T): T {
  const saved: Axis = {};
  for (const key of AXIS_KEYS) saved[key] = process.env[key];
  for (const key of AXIS_KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const key of AXIS_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('appliance defaults: single tenancy, closed registration, manual links, no billing', () => {
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server' }, () => {
    assert.equal(webTenancyIsMulti(), false);
    assert.equal(webRegistrationIsOpen(), false);
    assert.equal(webEmailDelivery(), 'manual-link');
    assert.equal(webBillingMode(), 'none');
  });
});

test('standard-mode defaults: multi tenancy, open registration, provider email, stripe billing', () => {
  withEnv({}, () => {
    assert.equal(webTenancyIsMulti(), true);
    assert.equal(webRegistrationIsOpen(), true);
    assert.equal(webEmailDelivery(), 'provider');
    assert.equal(webBillingMode(), 'stripe');
  });
});

test('explicit values override the mode-derived default in both directions', () => {
  withEnv(
    { NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', NEXT_PUBLIC_CHARITYPILOT_TENANCY: 'multi' },
    () => assert.equal(webTenancyIsMulti(), true),
  );
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_TENANCY: 'single' }, () => assert.equal(webTenancyIsMulti(), false));

  withEnv(
    { NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', NEXT_PUBLIC_CHARITYPILOT_REGISTRATION: 'open' },
    () => assert.equal(webRegistrationIsOpen(), true),
  );
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_REGISTRATION: 'closed' }, () => assert.equal(webRegistrationIsOpen(), false));

  withEnv(
    { NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY: 'provider' },
    () => assert.equal(webEmailDelivery(), 'provider'),
  );
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY: 'manual-link' }, () => assert.equal(webEmailDelivery(), 'manual-link'));

  withEnv(
    { NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', NEXT_PUBLIC_CHARITYPILOT_BILLING: 'stripe' },
    () => assert.equal(webBillingMode(), 'stripe'),
  );
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_BILLING: 'none' }, () => assert.equal(webBillingMode(), 'none'));
});

test('the private-VM combination is representable', () => {
  withEnv(
    {
      NEXT_PUBLIC_CHARITYPILOT_TENANCY: 'multi',
      NEXT_PUBLIC_CHARITYPILOT_REGISTRATION: 'closed',
      NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
      NEXT_PUBLIC_CHARITYPILOT_BILLING: 'none',
    },
    () => {
      assert.equal(webTenancyIsMulti(), true);
      assert.equal(webRegistrationIsOpen(), false);
      assert.equal(webEmailDelivery(), 'manual-link');
      assert.equal(webBillingMode(), 'none');
    },
  );
});

test('an invalid axis value throws loudly', () => {
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_TENANCY: 'both' }, () => {
    assert.throws(() => webTenancyIsMulti(), /Invalid deployment-profile value: both/);
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_REGISTRATION: 'yes' }, () => {
    assert.throws(() => webRegistrationIsOpen(), /Invalid deployment-profile value: yes/);
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY: 'smtp' }, () => {
    assert.throws(() => webEmailDelivery(), /Invalid deployment-profile value: smtp/);
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_BILLING: 'paypal' }, () => {
    assert.throws(() => webBillingMode(), /Invalid deployment-profile value: paypal/);
  });
});

test('whitespace values are rejected, not treated as unset', () => {
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_TENANCY: ' multi' }, () => {
    assert.throws(() => webTenancyIsMulti(), /Invalid deployment-profile value/);
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_TENANCY: 'mutli' }, () => {
    assert.throws(() => webTenancyIsMulti(), /Invalid deployment-profile value/);
  });
});

test('empty string is treated as unset and derives the mode default (Docker ARG/ENV cannot express unset)', () => {
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_TENANCY: '' }, () => {
    assert.equal(webTenancyIsMulti(), true);
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', NEXT_PUBLIC_CHARITYPILOT_TENANCY: '' }, () => {
    assert.equal(webTenancyIsMulti(), false);
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_REGISTRATION: '' }, () => {
    assert.equal(webRegistrationIsOpen(), true);
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', NEXT_PUBLIC_CHARITYPILOT_REGISTRATION: '' }, () => {
    assert.equal(webRegistrationIsOpen(), false);
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY: '' }, () => {
    assert.equal(webEmailDelivery(), 'provider');
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY: '' }, () => {
    assert.equal(webEmailDelivery(), 'manual-link');
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_BILLING: '' }, () => {
    assert.equal(webBillingMode(), 'stripe');
  });
  withEnv({ NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server', NEXT_PUBLIC_CHARITYPILOT_BILLING: '' }, () => {
    assert.equal(webBillingMode(), 'none');
  });
});

test('all NEXT_PUBLIC_CHARITYPILOT_* axis vars set to the empty string derive defaults without throwing (Docker build-arg regression pin)', () => {
  withEnv(
    {
      NEXT_PUBLIC_CHARITYPILOT_TENANCY: '',
      NEXT_PUBLIC_CHARITYPILOT_REGISTRATION: '',
      NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY: '',
      NEXT_PUBLIC_CHARITYPILOT_BILLING: '',
    },
    () => {
      assert.doesNotThrow(() => {
        assert.equal(webTenancyIsMulti(), true);
        assert.equal(webRegistrationIsOpen(), true);
        assert.equal(webEmailDelivery(), 'provider');
        assert.equal(webBillingMode(), 'stripe');
      });
    },
  );
});
