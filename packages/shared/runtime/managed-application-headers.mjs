// Values remain untrusted application inputs; they never identify a mesh peer.
export const managedApplicationHeaders = Object.freeze([
  'x-charitypilot-readiness-key',
  'x-charitypilot-approval',
  'x-charitypilot-client',
  'x-charitypilot-reason',
  'x-charitypilot-reason-encoding',
]);
export function isManagedProxyClaim(name) {
  const key = name.toLowerCase();
  return (
    key === 'forwarded' ||
    key.startsWith('x-forwarded-') ||
    key === 'x-real-ip' ||
    key === 'cf-connecting-ip' ||
    key === 'true-client-ip' ||
    (key.startsWith('x-charitypilot-') &&
      !managedApplicationHeaders.includes(key))
  );
}
