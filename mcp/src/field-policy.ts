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
  if (isEnvelope(value)) return filterEnvelope(model, value) as T;
  return filterRecord(model, value) as T;
}

/**
 * The API wraps responses in an envelope — either just `{ data }` for a single
 * record or a list with no pagination (see apps/api/src/utils/response.ts's
 * sendSuccess), or a paginated `{ data, total, page, pageSize, hasMore }` (see
 * apps/api/src/services/board-member.service.ts). Neither shape is the model
 * itself; `data` may be a single record (a detail route) or an array (a list
 * route).
 *
 * This is checked exactly ONCE, at the top of applyFieldPolicy — never during
 * recursion. The envelope is something the API wraps around a result set; it
 * is never a record. A record can legitimately have its own field named
 * `data` (nothing stops a future migration adding one), and if this check
 * were re-applied while recursing into a record's own fields, such a record
 * would be misread as a nested envelope: its other fields would be spread
 * through untouched instead of going through the allowlist, and the
 * personal-data gate would be defeated for that record. Checking only at the
 * top means every value below it — including anything inside `data`, however
 * deep — goes through the plain allowlist filter in filterRecord, with no
 * further envelope detection.
 */
function isEnvelope(value: unknown): value is Record<string, unknown> & { data: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = (value as Record<string, unknown>).data;
  return Array.isArray(data) || (data !== null && typeof data === 'object');
}

/** The only envelope keys other than `data` that are ever allowed through the gate. */
const ENVELOPE_META_FIELDS = ['total', 'page', 'pageSize', 'hasMore'] as const;

/**
 * Filters an envelope's `data` (record or array of records) through the plain
 * allowlist, and allowlists the envelope's own keys too: only the known
 * pagination fields survive alongside the filtered `data`. Any other sibling
 * key on the envelope (e.g. a route that additionally returns
 * `pendingInvites` or a `summary` object) is dropped when the gate is closed,
 * the same way an unclassified field on a record is dropped — an envelope
 * sibling nobody allowlisted is exactly as capable of carrying personal data
 * as a record field nobody allowlisted.
 */
function filterEnvelope(model: ModelName, value: Record<string, unknown> & { data: unknown }): unknown {
  const out: Record<string, unknown> = {};
  for (const key of ENVELOPE_META_FIELDS) {
    if (key in value) out[key] = value[key];
  }
  out.data = filterRecord(model, value.data);
  return out;
}

/** Plain allowlist filter for a record or array of records. No envelope detection at any depth. */
function filterRecord(model: ModelName, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => filterRecord(model, item));
  if (value === null || typeof value !== 'object') return value;

  const allowed = SAFE_FIELDS[model];
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (allowed.includes(key)) out[key] = val;
  }
  return out;
}
