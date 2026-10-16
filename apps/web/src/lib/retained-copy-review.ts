export const SYNTHETIC_REVIEW_FIELDS = [
  { key: 'evidenceRef', label: 'Review decision reference' },
  { key: 'retentionDecisionRef', label: 'Primary retention decision reference' },
  { key: 'holdReviewRef', label: 'Hold review reference' },
  { key: 'inventoryEvidenceRef', label: 'Copy inventory evidence reference' },
  { key: 'syntheticEvidenceRef', label: 'Synthetic test evidence reference' },
] as const;
export type CopyReviewActor = { id: string; organisationId: string; role: string };
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('A current source and copy observation is required.');
  return value as Record<string, unknown>;
}

/** Form preparation only. The authenticated API repeats all authority, schema,
 * clock and source checks; this builder cannot authorise provider execution. */
export function buildSyntheticCopyReview(input: { actor: CopyReviewActor; observation: unknown; publicationId: string;
  references: Record<string, string>; validityMinutes: number; confirmed: boolean }, now = Date.now()) {
  const observation = record(input.observation), snapshot = record(observation.snapshot), inventory = record(snapshot.inventory);
  const observed = typeof inventory.observedAt === 'string' ? Date.parse(inventory.observedAt) : NaN;
  if (input.actor.role !== 'OWNER' || snapshot.organisationId !== input.actor.organisationId
    || snapshot.publicationId !== input.publicationId || observation.sourceBytesObserved !== true
    || observation.actionAuthorized !== false || observation.syntheticVerified !== false || observation.allCopiesVerified !== false
    || snapshot.lifecycleStatus !== 'RETIRED' || snapshot.publicationState !== 'RETIRED'
    || snapshot.deletionHold !== false || snapshot.externalPublicationApproved !== false
    || typeof snapshot.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sourceSha256)
    || inventory.complete !== true || inventory.status !== 'CURRENT' || !Number.isFinite(now)
    || !Number.isFinite(observed) || observed > now || input.confirmed !== true) {
    throw new Error('Check the Owner, exact retained source, current observation and synthetic-content confirmation.');
  }
  if (!Number.isInteger(input.validityMinutes) || input.validityMinutes < 1 || input.validityMinutes > 60) {
    throw new Error('Choose a review validity between 1 and 60 minutes.');
  }
  const references = Object.fromEntries(SYNTHETIC_REVIEW_FIELDS.map(({ key }) => {
    const value = input.references[key]?.trim();
    if (!value || !/^[A-Z0-9][A-Z0-9-]{2,119}$/.test(value)) throw new Error('Provide every decision reference using uppercase letters, numbers and hyphens.');
    return [key, value];
  }));
  return { scope: 'SYNTHETIC_ONLY', primaryDisposition: 'RETAIN', copyDisposition: 'PURGE',
    reviewerId: input.actor.id, reviewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + input.validityMinutes * 60000).toISOString(),
    snapshot: structuredClone(snapshot), ...references };
}
