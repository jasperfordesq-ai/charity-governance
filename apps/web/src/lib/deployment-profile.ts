// Web mirror of apps/api/src/utils/deployment-profile.ts — same four capability
// axes, exposed to the browser bundle. The shape differs from the API version
// for one reason: Next.js only inlines `process.env.NEXT_PUBLIC_*` at build
// time when it appears as a literal, static property access
// (`process.env.NEXT_PUBLIC_X`). A dynamic lookup — `env[name]`, or an env
// object passed in as a parameter and indexed by a variable — is never
// replaced, so it would read `undefined` in the shipped client bundle no
// matter what was set at build time. That is why, unlike the API's axis(),
// each exported function below reads its own env var directly at the call
// site and hands the already-read value to `pick`, instead of a shared helper
// doing `env[name]`.
//
// MODE (and the APPLIANCE flag derived from it) is read once, at module load.
// In a real Next.js build this is exactly the constant the bundler inlines —
// NEXT_PUBLIC_* values are fixed for the life of a built bundle — so
// evaluating it once here mirrors production behaviour exactly. Nothing
// behavioural should key on NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE directly
// any more; key on an axis exported from this module instead.
const MODE = process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE;
const APPLIANCE = MODE === 'personal-server';

function pick<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  applianceDefault: T,
  standardDefault: T,
): T {
  if (raw === undefined) return APPLIANCE ? applianceDefault : standardDefault;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`Invalid deployment-profile value: ${raw}`);
  }
  return raw as T;
}

export const webTenancyIsMulti = (): boolean =>
  pick(process.env.NEXT_PUBLIC_CHARITYPILOT_TENANCY, ['multi', 'single'] as const, 'single', 'multi') === 'multi';

export const webRegistrationIsOpen = (): boolean =>
  pick(process.env.NEXT_PUBLIC_CHARITYPILOT_REGISTRATION, ['open', 'closed'] as const, 'closed', 'open') === 'open';

export const webEmailDelivery = (): 'provider' | 'manual-link' =>
  pick(process.env.NEXT_PUBLIC_CHARITYPILOT_EMAIL_DELIVERY, ['provider', 'manual-link'] as const, 'manual-link', 'provider');

export const webBillingMode = (): 'stripe' | 'none' =>
  pick(process.env.NEXT_PUBLIC_CHARITYPILOT_BILLING, ['stripe', 'none'] as const, 'none', 'stripe');
