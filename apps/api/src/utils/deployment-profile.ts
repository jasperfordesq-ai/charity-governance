import { PERSONAL_SERVER_DEPLOYMENT_MODE } from './personal-server.js';

// The capability axes. One deployment "mode" used to imply all of these at
// once, which made multi-tenant-with-local-providers unrepresentable. Each
// axis is now its own env var; when unset, its default derives from
// CHARITYPILOT_DEPLOYMENT_MODE so every existing install keeps today's
// behaviour without setting anything.
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
  if (raw === undefined) {
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
