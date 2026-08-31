// Web mirror of apps/api/src/utils/deployment-profile.ts — same four capability
// axes, exposed to both the browser bundle and this app's Node-runtime server
// code (proxy.ts). The shape differs from the API version for one reason:
// Next.js only inlines `process.env.NEXT_PUBLIC_*` in the CLIENT bundle at
// build time when it appears as a literal, static property access
// (`process.env.NEXT_PUBLIC_X`). A dynamic lookup — `env[name]`, or an env
// object passed in as a parameter and indexed by a variable — is never
// replaced, so it would read `undefined` in the shipped client bundle no
// matter what was set at build time. That is why, unlike the API's axis(),
// each exported function below reads its own env var directly at the call
// site and hands the already-read value to `pick`, instead of a shared helper
// doing `env[name]`.
//
// The appliance check is read FRESH on every call (isAppliance(), inside
// pick()) rather than cached at module load. A cached module-level constant
// would be indistinguishable from a fresh read in the browser bundle — either
// way NEXT_PUBLIC_* is inlined to a fixed literal at build time — but this
// module is also require()'d directly by proxy.ts, which runs in the Node
// server runtime across many requests in one long-lived process. Caching the
// mode at first import would freeze it as of whichever request happened to
// load the module first, silently ignoring the actual (fixed, real)
// environment for the rest of that process's life. Reading fresh costs one
// property lookup and is correct in both contexts.
//
// An empty string is ALSO treated as unset (⇒ derive the default), not as an
// error. Docker `ARG X` / `ENV X=$X` pairs (see apps/web/Dockerfile) have no
// way to express "unset" — an ARG that isn't passed at build time makes the
// ENV value the empty string, not absent. Every build that doesn't pass these
// build args (which is every build today) would otherwise fail `next build`
// (the prerendered sitemap route reads these at build time) or throw at
// render in the shipped client bundle. Whitespace-only and misspelled values
// are NOT treated as unset — those still throw; only exactly '' derives the
// default.
function isAppliance(): boolean {
  return process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE === 'personal-server';
}

function pick<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  applianceDefault: T,
  standardDefault: T,
): T {
  if (raw === undefined || raw === '') return isAppliance() ? applianceDefault : standardDefault;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(
      `FATAL: ${name} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as T;
}

export const webTenancyIsMulti = (): boolean =>
  pick('NEXT_PUBLIC_CHARITYPILOT_TENANCY', process.env.NEXT_PUBLIC_CHARITYPILOT_TENANCY, ['multi', 'single'] as const, 'single', 'multi') === 'multi';

export const webRegistrationIsOpen = (): boolean =>
  pick('NEXT_PUBLIC_CHARITYPILOT_REGISTRATION', process.env.NEXT_PUBLIC_CHARITYPILOT_REGISTRATION, ['open', 'closed'] as const, 'closed', 'open') === 'open';

export const webEmailDelivery = (): 'provider' | 'manual-link' =>
  pick('NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY', process.env.NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY, ['provider', 'manual-link'] as const, 'manual-link', 'provider');

export const webBillingMode = (): 'stripe' | 'none' =>
  pick('NEXT_PUBLIC_CHARITYPILOT_BILLING', process.env.NEXT_PUBLIC_CHARITYPILOT_BILLING, ['stripe', 'none'] as const, 'none', 'stripe');
