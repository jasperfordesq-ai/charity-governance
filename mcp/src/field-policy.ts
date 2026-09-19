export type ModelName = 'BoardMember' | 'Member' | 'ConflictRecord' | 'ComplaintRecord';

export const SAFE_FIELDS: Record<ModelName, readonly string[]> = {
  BoardMember: [
    'id', 'organisationId', 'name', 'role', 'appointedDate', 'termEndDate',
    'isActive', 'conductSigned', 'conductSignedDate', 'inductionCompleted',
    'inductionDate', 'appointmentKind', 'createdAt', 'updatedAt',
  ],
  Member: [
    'id', 'organisationId', 'name', 'dateEntered', 'dateCeased',
    'retentionDeleteAt', 'createdAt', 'updatedAt',
  ],
  ConflictRecord: [
    'id', 'organisationId', 'boardMemberId', 'status', 'dateDeclared',
    'meetingDate', 'nextReviewDate', 'minuteReference', 'createdAt', 'updatedAt',
  ],
  ComplaintRecord: [
    'id', 'organisationId', 'status', 'receivedDate', 'reviewedByBoard',
    'boardMinuteReference', 'createdAt', 'updatedAt',
  ],
};

export const WITHHELD_FIELDS: Record<ModelName, readonly string[]> = {
  BoardMember: ['email', 'dateOfBirth', 'residentialAddress', 'formerNames', 'otherDirectorships'],
  Member: ['address'],
  ConflictRecord: ['trusteeName', 'matter', 'nature', 'actionTaken', 'decision'],
  ComplaintRecord: ['summary', 'source', 'actionTaken', 'outcome'],
};

export function applyFieldPolicy<T>(model: ModelName, value: T, allowPersonalData: boolean): T {
  if (allowPersonalData) return value;
  return filter(model, value) as T;
}

function filter(model: ModelName, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => filter(model, item));
  if (value === null || typeof value !== 'object') return value;

  const allowed = SAFE_FIELDS[model];
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (allowed.includes(key)) out[key] = val;
  }
  return out;
}
