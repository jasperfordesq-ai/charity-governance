import { PERSONAL_SERVER_DEPLOYMENT_MODE, getPersonalServerOrigin } from './personal-server.js';

// The capability axes. One deployment "mode" used to imply all of these at
// once, which made multi-tenant-with-local-providers unrepresentable. Each
// axis is now its own env var; when unset, its default derives from
// CHARITYPILOT_DEPLOYMENT_MODE so every existing install keeps today's
// behaviour without setting anything.
//
// An empty string is ALSO treated as unset (⇒ derive the default), not as an
// error. That's not leniency for its own sake: Docker `ARG X` / `ENV X=$X`
// pairs (see apps/web/Dockerfile) have no way to express "unset" — an ARG
// that isn't passed at build time makes the ENV value the empty string, not
// absent. Every build that doesn't pass these build args (which is every
// build today) would otherwise fail `next build` (the prerendered sitemap
// route reads one of these at build time) or throw at render in the shipped
// client bundle. Whitespace-only and misspelled values are NOT treated as
// unset — those still throw; only exactly '' derives the default.
//
// isPersonalServerDeployment() still exists — for the appliance LIFECYCLE
// only (installer jobs, recovery machinery, appliance env validation).
// Nothing behavioural should key on it any more; key on an axis here.

export type DeploymentEnv = Record<string, string | undefined>;

function isApplianceMode(env: DeploymentEnv): boolean {
  return env.CHARITYPILOT_DEPLOYMENT_MODE === PERSONAL_SERVER_DEPLOYMENT_MODE;
}

function axis<T extends string>(
  env: DeploymentEnv,
  name: string,
  allowed: readonly T[],
  applianceDefault: T,
  standardDefault: T,
): T {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return isApplianceMode(env) ? applianceDefault : standardDefault;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(
      `FATAL: ${name} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as T;
}

export function isMultiTenant(env: DeploymentEnv = process.env): boolean {
  return axis(env, 'CHARITYPILOT_TENANCY', ['multi', 'single'] as const, 'single', 'multi') === 'multi';
}

export function isRegistrationOpen(env: DeploymentEnv = process.env): boolean {
  return axis(env, 'CHARITYPILOT_REGISTRATION', ['open', 'closed'] as const, 'closed', 'open') === 'open';
}

export function emailDeliveryMode(env: DeploymentEnv = process.env): 'provider' | 'manual-link' {
  return axis(env, 'CHARITYPILOT_EMAIL_DELIVERY', ['provider', 'manual-link'] as const, 'manual-link', 'provider');
}

export function billingMode(env: DeploymentEnv = process.env): 'stripe' | 'none' {
  return axis(env, 'CHARITYPILOT_BILLING', ['stripe', 'none'] as const, 'none', 'stripe');
}

// Where manually surfaced links point. In appliance mode the validated
// personal-server origin (exact-origin match between FRONTEND_URL and
// NEXT_PUBLIC_API_URL, HTTPS-DNS or exact loopback-http) is the ONLY
// acceptable origin: this path is deliberately fail-closed. A misconfigured
// appliance — mismatched FRONTEND_URL/NEXT_PUBLIC_API_URL, an IP-address
// origin, a non-exact loopback, a trailing slash, anything
// getPersonalServerOrigin's validation exists to catch — yields null rather
// than silently falling back to a raw, unvalidated FRONTEND_URL. Outside
// appliance mode, FRONTEND_URL — required by production env validation — is
// the tenant web origin. The token rides the URL FRAGMENT, never the query
// string: fragments do not reach servers, proxies, or access logs.
function manualLinkOrigin(env: DeploymentEnv): URL | null {
  if (isApplianceMode(env)) {
    return getPersonalServerOrigin(env);
  }
  const frontend = env.FRONTEND_URL;
  if (!frontend) return null;
  try {
    const url = new URL(frontend);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

// Generalised over manualInviteUrl: any one-time auth link (invite,
// password-set, email-verify) built the same way — validated origin, token
// riding the fragment, never the query string.
export function manualAuthLinkUrl(
  path: '/reset-password' | '/verify-email' | '/accept-invite',
  token: string,
  env: DeploymentEnv = process.env,
): string | null {
  const origin = manualLinkOrigin(env);
  if (!origin || !token) return null;
  const url = new URL(path, origin);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

export function manualInviteUrl(token: string, env: DeploymentEnv = process.env): string | null {
  return manualAuthLinkUrl('/accept-invite', token, env);
}
