import { isIP } from 'node:net';

export const PERSONAL_SERVER_DEPLOYMENT_MODE = 'personal-server';

type DeploymentEnv = Record<string, string | undefined>;

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

export function isPersonalServerDeployment(env: DeploymentEnv = process.env): boolean {
  return env.CHARITYPILOT_DEPLOYMENT_MODE === PERSONAL_SERVER_DEPLOYMENT_MODE;
}

export function parseExactOrigin(value: string | undefined): URL | null {
  if (!value || value.trim() !== value) return null;

  try {
    const url = new URL(value);
    return url.origin === value ? url : null;
  } catch {
    return null;
  }
}

export function isExactLoopbackHttpOrigin(value: string | undefined): boolean {
  const url = parseExactOrigin(value);
  if (!url || url.protocol !== 'http:') return false;

  const hostname = normalizedHostname(url.hostname);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function isHttpsDnsOrigin(value: string | undefined): boolean {
  const url = parseExactOrigin(value);
  if (!url || url.protocol !== 'https:' || isIP(normalizedHostname(url.hostname))) return false;

  const hostname = normalizedHostname(url.hostname);
  if (!hostname || hostname.length > 253) return false;
  return hostname.split('.').every((label) => (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  ));
}

export function getPersonalServerOrigin(env: DeploymentEnv = process.env): URL | null {
  if (!isPersonalServerDeployment(env)) return null;

  const frontendOrigin = parseExactOrigin(env.FRONTEND_URL);
  const apiOrigin = parseExactOrigin(env.NEXT_PUBLIC_API_URL);
  if (!frontendOrigin || !apiOrigin || frontendOrigin.origin !== apiOrigin.origin) return null;
  if (!isHttpsDnsOrigin(frontendOrigin.origin) && !isExactLoopbackHttpOrigin(frontendOrigin.origin)) return null;

  return frontendOrigin;
}

export function personalServerAllowsInsecureCookies(env: DeploymentEnv = process.env): boolean {
  const origin = getPersonalServerOrigin(env);
  return Boolean(origin && origin.protocol === 'http:' && isExactLoopbackHttpOrigin(origin.origin));
}

export function personalServerManualInviteUrl(
  token: string,
  env: DeploymentEnv = process.env,
): string | null {
  const origin = getPersonalServerOrigin(env);
  if (!origin || !token) return null;

  const inviteUrl = new URL('/accept-invite', origin);
  inviteUrl.hash = new URLSearchParams({ token }).toString();
  return inviteUrl.toString();
}
