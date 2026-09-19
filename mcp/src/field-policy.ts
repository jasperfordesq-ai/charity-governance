export type ModelName = 'BoardMember' | 'Member' | 'ConflictRecord' | 'ComplaintRecord' | 'GoverningAct';

export const SAFE_FIELDS: Record<ModelName, readonly string[]> = {
  BoardMember: [
    'id', 'organisationId', 'name', 'role', 'appointedDate', 'termEndDate',
    'isActive', 'conductSigned', 'conductSignedDate', 'inductionCompleted',
    'inductionDate', 'appointmentKind', 'createdAt', 'updatedAt',
  ],
  // The minute book's own fields are all identifiers, types, dates, references and
  // statuses. `resolutions` (the free-text narrative, including who abstained and
  // the conflictRecordId that would reopen the join withholding
  // ConflictRecord.boardMemberId is meant to close) is a relation, not a scalar, so
  // it is already absent from this list — the allowlist drops it without needing an
  // entry in WITHHELD_FIELDS.
  GoverningAct: [
    'id', 'organisationId', 'kind', 'status', 'actDate', 'reference', 'title',
    'statutoryBasis', 'approvedAtActId', 'approvedAt', 'documentId',
    'createdAt', 'updatedAt',
  ],
  // name is withheld: unlike trustees, ordinary charity members appear on no public
  // register, so the public-record argument that makes BoardMember.name safe does
  // not carry here.
  Member: [
    'id', 'organisationId', 'dateEntered', 'dateCeased',
    'retentionDeleteAt', 'createdAt', 'updatedAt',
  ],
  // boardMemberId is deliberately NOT here. It is a foreign key into BoardMember,
  // whose id and name are both safe, so leaving it in would let any caller join the
  // two registers and reconstruct who declared a conflict — defeating the point of
  // withholding trusteeName.
  ConflictRecord: [
    'id', 'organisationId', 'status', 'dateDeclared',
    'meetingDate', 'nextReviewDate', 'minuteReference', 'createdAt', 'updatedAt',
  ],
  ComplaintRecord: [
    'id', 'organisationId', 'status', 'receivedDate', 'reviewedByBoard',
    'boardMinuteReference', 'createdAt', 'updatedAt',
  ],
};

export const WITHHELD_FIELDS: Record<ModelName, readonly string[]> = {
  BoardMember: ['email', 'dateOfBirth', 'residentialAddress', 'formerNames', 'otherDirectorships'],
  Member: ['address', 'name'],
  ConflictRecord: ['trusteeName', 'matter', 'nature', 'actionTaken', 'decision', 'boardMemberId'],
  ComplaintRecord: ['summary', 'source', 'actionTaken', 'outcome'],
  // notes is the one free-text narrative field on the minute book: an open box
  // that can carry anything, including the kind of personal detail the other
  // withheld fields exist to hold back.
  GoverningAct: ['notes'],
};

export function applyFieldPolicy<T>(model: ModelName, value: T, allowPersonalData: boolean): T {
  if (allowPersonalData) return value;
  return filter(model, value) as T;
}

/**
 * The API wraps list responses in an envelope — either just `{ data }` (see
 * apps/api/src/utils/response.ts's sendSuccess) or a paginated
 * `{ data, total, page, pageSize, hasMore }` (see
 * apps/api/src/services/board-member.service.ts). Neither shape is the model
 * itself, so filtering it as one drops every key that isn't a model field —
 * which includes `data`, emptying the response. Detected generically by an
 * array-valued `data` property, not by route, so any current or future
 * envelope-shaped response is handled the same way.
 */
function isEnvelope(value: unknown): value is Record<string, unknown> & { data: unknown[] } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).data)
  );
}

function filter(model: ModelName, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => filter(model, item));
  if (value === null || typeof value !== 'object') return value;

  if (isEnvelope(value)) {
    const { data, ...meta } = value;
    return { ...meta, data: filter(model, data) };
  }

  const allowed = SAFE_FIELDS[model];
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (allowed.includes(key)) out[key] = val;
  }
  return out;
}
