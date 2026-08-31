import assert from 'node:assert/strict';
import { test } from 'node:test';

import sitemap from './sitemap';

// Regression pin for the Docker build-arg bug: apps/web/Dockerfile's `ARG X` +
// `ENV X=$X` pairs set the four NEXT_PUBLIC_CHARITYPILOT_* axis vars to the
// empty string whenever the build arg isn't passed (which is every existing
// build). sitemap() is prerendered at build time and reads webBillingMode()
// / webRegistrationIsOpen() — under the old strict-empty-throws behaviour
// this failed `next build` for the production image. It must return entries
// without throwing when the axis vars are ''.
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

test('sitemap() does not throw and returns entries when all axis env vars are empty strings (Docker build-arg regression pin)', () => {
  withEnv(
    {
      NEXT_PUBLIC_CHARITYPILOT_TENANCY: '',
      NEXT_PUBLIC_CHARITYPILOT_REGISTRATION: '',
      NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY: '',
      NEXT_PUBLIC_CHARITYPILOT_BILLING: '',
    },
    () => {
      let entries: ReturnType<typeof sitemap> | undefined;
      assert.doesNotThrow(() => {
        entries = sitemap();
      });
      assert.ok(entries && entries.length > 0);
      // standard-mode defaults derived from '': registration open and
      // billing enabled, so /register and /pricing should both be present.
      const urls = (entries ?? []).map((entry) => entry.url);
      assert.ok(urls.some((url) => url.endsWith('/register')));
      assert.ok(urls.some((url) => url.endsWith('/pricing')));
    },
  );
});
