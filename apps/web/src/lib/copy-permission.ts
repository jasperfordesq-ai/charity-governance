export type CopyPermissionReview = { id: string; snapshotSha256: string; expiresAt: string; withdrawnAt: string | null };
export const COPY_PERMISSION_FIELDS = [
  { key: 'scopeId', label: 'Registered synthetic scope ID' },
  { key: 'scopeEvidenceRef', label: 'Registered scope evidence reference' },
  { key: 'disposalPolicyEvidenceRef', label: 'Disposal policy evidence reference' },
  { key: 'evidenceRef', label: 'Permission decision reference' },
  { key: 'expiresAt', label: 'Permission expiry (UTC)' },
] as const;
const evidence = /^[A-Z0-9][A-Z0-9-]{2,119}$/;
/** Form preparation only. The API authenticates the actor, locks/rechecks the
 * registered scope and observes the exact source before recording permission. */
export function buildCopyPermission(input: { role: string; review: CopyPermissionReview;
  fields: Record<string, string>; confirmed: boolean }, now = Date.now()) {
  const fields = Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [key, value.trim()]));
  const expires = Date.parse(fields.expiresAt ?? ''), reviewExpiry = Date.parse(input.review.expiresAt);
  const reason = fields.reason ?? '';
  if (input.role !== 'OWNER' || input.confirmed !== true || input.review.withdrawnAt !== null
    || !/^[a-f0-9]{64}$/.test(input.review.snapshotSha256) || !Number.isFinite(now)
    || !Number.isFinite(reviewExpiry) || reviewExpiry <= now || !Number.isFinite(expires)
    || expires <= now || expires > reviewExpiry || expires > now + 3600000
    || new Date(expires).toISOString() !== fields.expiresAt
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(fields.scopeId ?? '')
    || !['scopeEvidenceRef', 'disposalPolicyEvidenceRef', 'evidenceRef'].every(key => evidence.test(fields[key] ?? ''))
    || Array.from(reason).length < 10 || Array.from(reason).length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(reason)) {
    throw new Error('Check the current Owner review, exact registered scope, evidence, UTC expiry and synthetic-copy confirmation.');
  }
  return { scopeId: fields.scopeId, scopeEvidenceRef: fields.scopeEvidenceRef,
    disposalPolicyEvidenceRef: fields.disposalPolicyEvidenceRef, evidenceRef: fields.evidenceRef,
    reason, expiresAt: fields.expiresAt, expectedSnapshotSha256: input.review.snapshotSha256,
    attestation: 'AUTHORISE PURGE OF THIS SYNTHETIC CONFLUENCE COPY; RETAIN PRIMARY' };
}
