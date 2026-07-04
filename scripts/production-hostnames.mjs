export const APPROVED_PUBLIC_HOST_ROOT = 'charitypilot.ie';
export const CANONICAL_PRODUCTION_WEB_ORIGIN = 'https://app.charitypilot.ie';
export const CANONICAL_PRODUCTION_API_ORIGIN = 'https://api.charitypilot.ie';

export function normaliseHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function isApprovedCharityPilotHostname(hostname) {
  const normalizedHostname = normaliseHostname(hostname);
  return normalizedHostname === APPROVED_PUBLIC_HOST_ROOT || normalizedHostname.endsWith(`.${APPROVED_PUBLIC_HOST_ROOT}`);
}

export function canonicalOriginIssue(name, origin, role) {
  const expected = role === 'web' ? CANONICAL_PRODUCTION_WEB_ORIGIN : CANONICAL_PRODUCTION_API_ORIGIN;
  const label = role === 'api' ? 'API' : role;
  if (origin !== expected) {
    return `${name} must use the canonical production ${label} origin ${expected}`;
  }
  return null;
}
