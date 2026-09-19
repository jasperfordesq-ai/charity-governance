export type ModelName =
  | 'BoardMember'
  | 'Member'
  | 'ConflictRecord'
  | 'ComplaintRecord'
  | 'GoverningAct'
  | 'RiskRecord'
  | 'FundraisingRecord'
  | 'FinancialControlReview'
  | 'AnnualReportReadiness'
  | 'ComplianceRecord'
  | 'ComplianceSignoff'
  | 'Deadline'
  | 'Document'
  | 'Resolution'
  | 'GovernancePrinciple'
  | 'GovernanceStandard'
  | 'Organisation'
  | 'User'
  | 'TeamInvite'
  | 'GoverningActVoid'
  | 'Subscription';

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
  // `owner` is a named person accountable for the risk. Unlike a trustee they are
  // on no public register, so the same reasoning that withholds Member.name applies.
  // `description` and `mitigation` are open boxes that routinely describe conduct.
  RiskRecord: [
    'id', 'organisationId', 'title', 'category', 'likelihood', 'impact',
    'reviewDate', 'status', 'boardMinuteReference', 'createdAt', 'updatedAt',
  ],
  // `thirdPartyFundraiser` names a person or firm engaged by the charity.
  FundraisingRecord: [
    'id', 'organisationId', 'name', 'activityType', 'startDate', 'endDate',
    'publicFacing', 'complaintsReceived', 'status', 'boardMinuteReference',
    'createdAt', 'updatedAt',
  ],
  // The booleans are the governance answer — which controls were reviewed. The
  // reviewer's name and the free-text actions are not needed to answer that.
  FinancialControlReview: [
    'id', 'organisationId', 'reportingYear', 'bankReconciliationsReviewed',
    'dualAuthorisation', 'budgetApproved', 'managementAccountsReviewed',
    'reservesReviewed', 'restrictedFundsReviewed', 'assetsInsuranceReviewed',
    'payrollControlsReviewed', 'fundraisingControlsReviewed', 'reviewDate',
    'minuteReference', 'createdAt', 'updatedAt',
  ],
  // Every narrative field is withheld, including publicBenefitStatement and
  // activitiesNarrative. They are destined for a published annual report, which
  // argues for releasing them — but they are free text written before that
  // publication decision is taken, and beneficiariesSummary in particular can
  // describe identifiable vulnerable people. The readiness booleans and dates
  // answer "are we ready to file", which is what this record is for.
  AnnualReportReadiness: [
    'id', 'organisationId', 'reportingYear', 'financialStatementsApproved',
    'annualReportUploaded', 'trusteeDetailsReviewed', 'fundraisingReviewed',
    'complaintsReviewed', 'boardApprovalDate', 'filingStatus', 'filedDate',
    'createdAt', 'updatedAt',
  ],
  // The compliance status per standard is the governance answer. The evidence and
  // explanation fields are free text, and updatedById identifies the person.
  ComplianceRecord: [
    'id', 'organisationId', 'standardId', 'reportingYear', 'status',
    'revision', 'createdAt', 'updatedAt',
  ],
  ComplianceSignoff: [
    'id', 'organisationId', 'reportingYear', 'status', 'boardMeetingDate',
    'minuteReference', 'approvedAt', 'revision', 'approvalSequence',
    'currentApprovalSnapshotId', 'invalidatedAt', 'createdAt', 'updatedAt',
  ],
  // `title` is the obligation and is the point of the record. `description` is an
  // open box. The generation* Json columns snapshot the organisation profile that
  // produced the deadline, so they can carry anything the profile carried.
  Deadline: [
    'id', 'organisationId', 'title', 'dueDate', 'scheduleVersion',
    'isAutoGenerated', 'generatedKind', 'generatedKey', 'generationVersion',
    'generationRuleVersion', 'generationFingerprint', 'profileRuleKey',
    'isComplete', 'completedDate', 'completionDateKnown', 'reminderDays',
    'supersededAt', 'supersededById', 'archivedAt', 'createdAt', 'updatedAt',
  ],
  // `name` is governance evidence and is how a document is referred to. `owner` is
  // a person, `description` is free text, and `fileUrl` is the storage path, which
  // encodes the original filename and must never leave the API.
  Document: [
    'id', 'organisationId', 'name', 'category', 'fileSize', 'mimeType',
    'version', 'approvedDate', 'nextReviewDate', 'boardMinuteReference',
    'approvalAsserted', 'approvedByResolutionId', 'createdAt', 'updatedAt',
  ],
  // conflictRecordId is withheld for the same reason as ConflictRecord.boardMemberId:
  // it is the join that reconstructs who declared a conflict.
  Resolution: [
    'id', 'organisationId', 'governingActId', 'itemNumber', 'carried',
    'createdAt', 'updatedAt',
  ],
  // Reference data describing the Governance Code itself. No tenant data at all.
  GovernancePrinciple: ['id', 'number', 'title', 'description', 'sortOrder'],
  GovernanceStandard: ['id', 'principleId', 'code', 'title', 'isCore', 'isAdditional', 'sortOrder'],
  // A small charity's registered address is frequently a trustee's home address,
  // and the contact email and phone are frequently a named individual's.
  Organisation: [
    'id', 'name', 'rcnNumber', 'croNumber', 'legalForm', 'legalFormConfirmedAt',
    'complexity', 'charitablePurpose', 'financialYearEnd', 'website',
    'dateRegistered', 'incorporationDate', 'croAnnualReturnDate',
    'croAnnualReturnDateConfirmedAt', 'lastActualAgmDate',
    'lastUnanimousAnnualMemberResolutionDate', 'memberCount',
    'constitutionPermitsWrittenResolutions', 'lifecycleStatus',
    'lifecycleChangedAt', 'lifecycleVersion', 'documentStorageProvider',
    'documentStorageAlphaOptIn', 'createdAt', 'updatedAt',
  ],
  // Who holds an account is personal; what authority the account carries is
  // governance. The secret columns are withheld as secrets, not as personal data.
  User: [
    'id', 'organisationId', 'role', 'emailVerified', 'lifecycleStatus',
    'membershipChangedAt', 'membershipVersion', 'createdAt', 'updatedAt',
  ],
  // `token` is a bearer credential that would let its holder join the charity.
  TeamInvite: [
    'id', 'organisationId', 'role', 'acceptedAt', 'revokedAt', 'expiresAt',
    'createdAt', 'updatedAt',
  ],
  // `snapshot` is an opaque Json copy of the whole act and every resolution. A
  // field allowlist cannot see inside it, so it fails closed. The reference and
  // dates are kept so a void is still traceable without reopening its contents.
  GoverningActVoid: [
    'id', 'organisationId', 'reference', 'kind', 'status', 'actDate',
    'statutoryBasis', 'resolutionCount', 'voidedAt', 'createdAt',
  ],
  Subscription: [
    'id', 'organisationId', 'stripeStatus', 'plan', 'status', 'billingInterval',
    'cancelAtPeriodEnd', 'trialEndsAt', 'currentPeriodStart', 'currentPeriodEnd',
    'cancelledAt', 'createdAt', 'updatedAt',
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
  RiskRecord: ['description', 'mitigation', 'owner'],
  FundraisingRecord: ['thirdPartyFundraiser', 'controls', 'reviewOutcome'],
  FinancialControlReview: ['reviewedBy', 'actions'],
  AnnualReportReadiness: [
    'activitiesNarrative', 'publicBenefitStatement', 'beneficiariesSummary', 'notes',
  ],
  ComplianceRecord: ['actionTaken', 'evidence', 'notes', 'explanationIfNA', 'updatedById'],
  ComplianceSignoff: [
    'approvedByName', 'approvedByRole', 'approvalNotes', 'invalidationReason',
    'invalidatedById', 'updatedById',
  ],
  Deadline: [
    'description', 'generationSource', 'generationInputs', 'supersessionReason',
  ],
  Document: ['description', 'fileUrl', 'owner', 'uploadedById'],
  Resolution: ['text', 'abstentions', 'conflictRecordId'],
  GovernancePrinciple: [],
  GovernanceStandard: [],
  Organisation: [
    'registeredAddress', 'contactEmail', 'contactPhone', 'conditionalObligationProfile',
    'stripeCustomerId',
  ],
  User: [
    'email', 'name', 'passwordHash', 'resetToken', 'resetTokenExpiry',
    'verifyToken', 'verifyTokenExpiry',
  ],
  TeamInvite: ['email', 'token', 'invitedById'],
  GoverningActVoid: [
    'title', 'notes', 'snapshot', 'reason', 'voidedByUserId', 'voidedByEmail',
  ],
  Subscription: ['stripeSubscriptionId'],
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

/* ------------------------------------------------------------------------- *
 * Shapes: payloads that mix models
 * ------------------------------------------------------------------------- */

/**
 * Four routes return more than one model in a single payload, so no single
 * ModelName describes them. The alternative to handling them explicitly is
 * leaving them ungated, which is exactly how the dashboard came to return
 * interpolated trustee and staff names through a closed gate.
 *
 * Every shape is built from the same per-model record filters above, so each
 * model's allowlist is stated in exactly one place and a shape cannot quietly
 * disagree with it.
 */
export type ShapeName = 'dashboard' | 'team' | 'boardSubmissions' | 'complianceSignoff';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pick(value: unknown, keys: readonly string[]): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in record) out[key] = record[key];
  }
  return out;
}

function mapArray(value: unknown, fn: (item: unknown) => unknown): unknown {
  return Array.isArray(value) ? value.map(fn) : value;
}

/**
 * `recentActivity[].description` is assembled by interpolation, for example
 * "Updated board member 'Aoife Chairperson'". The personal data is inside the
 * string, so there is no field to allowlist and nothing to filter — the whole
 * value is withheld, along with the staff name beside it. What survives is the
 * shape of the activity: what kind of thing changed and when.
 *
 * `boardAlerts[].memberName` is kept, because it is a trustee's name and
 * BoardMember.name is classified safe above on the public-register argument.
 * Keeping it here and dropping it there would be the policy disagreeing with
 * itself.
 */
function filterDashboard(value: unknown): unknown {
  const envelope = asRecord(value);
  if (!envelope) return value;
  const data = asRecord(envelope.data);
  if (!data) return { data: envelope.data };

  return {
    data: {
      // Aggregate compliance figures and the principle reference data beside
      // them carry no records about a person.
      compliance: data.compliance,
      upcomingDeadlines: filterRecord('Deadline', data.upcomingDeadlines),
      boardAlerts: mapArray(data.boardAlerts, (alert) =>
        pick(alert, ['memberId', 'memberName', 'alertType'])),
      recentActivity: mapArray(data.recentActivity, (item) =>
        pick(item, ['id', 'type', 'timestamp'])),
    },
  };
}

/**
 * `activeSessionCount` is not a User column — it is an aggregate the team
 * service adds, and only for entries the caller may inspect. It is a count, so
 * it is kept explicitly rather than dropped as an unknown field.
 */
function filterTeam(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;

  return {
    members: mapArray(record.members, (member) => {
      const filtered = asRecord(filterRecord('User', member)) ?? {};
      const raw = asRecord(member);
      if (raw && 'activeSessionCount' in raw) {
        filtered.activeSessionCount = raw.activeSessionCount;
      }
      return filtered;
    }),
    invites: mapArray(record.invites, (invite) => filterRecord('TeamInvite', invite)),
  };
}

/** A Document projection, nesting a Resolution, nesting a GoverningAct. */
function filterBoardSubmission(value: unknown): unknown {
  const raw = asRecord(value);
  if (!raw) return value;
  const filtered = asRecord(filterRecord('Document', raw)) ?? {};

  // `evidenced` is computed by the route, not a Document column, and says only
  // whether evidence exists.
  if ('evidenced' in raw) filtered.evidenced = raw.evidenced;

  if ('resolution' in raw) {
    const resolution = asRecord(raw.resolution);
    if (resolution) {
      const filteredResolution = asRecord(filterRecord('Resolution', resolution)) ?? {};
      if ('governingAct' in resolution) {
        filteredResolution.governingAct = filterRecord('GoverningAct', resolution.governingAct);
      }
      filtered.resolution = filteredResolution;
    } else {
      filtered.resolution = raw.resolution;
    }
  }
  return filtered;
}

function filterBoardSubmissions(value: unknown): unknown {
  const envelope = asRecord(value);
  if (!envelope) return value;
  const data = asRecord(envelope.data);
  if (!data) return { data: envelope.data };

  const outstanding = asRecord(data.outstanding);
  return {
    data: {
      evidenced: mapArray(data.evidenced, filterBoardSubmission),
      outstanding: outstanding
        ? {
            notEvidenced: mapArray(outstanding.notEvidenced, filterBoardSubmission),
            notSubmitted: mapArray(outstanding.notSubmitted, filterBoardSubmission),
          }
        : data.outstanding,
    },
  };
}

/**
 * The signoff record itself, plus the two approval summaries beside it. Those
 * summaries are identifiers, a sequence number, two content hashes and a
 * timestamp — no personal data — so they are kept rather than dropped as
 * unrecognised envelope siblings.
 */
const APPROVAL_SUMMARY_FIELDS = [
  'id', 'approvalSequence', 'evidenceHash', 'snapshotHash', 'approvedAt',
] as const;

function filterComplianceSignoff(value: unknown): unknown {
  const envelope = asRecord(value);
  if (!envelope) return value;
  const data = asRecord(envelope.data);
  if (!data) return { data: envelope.data };

  const out = asRecord(filterRecord('ComplianceSignoff', data)) ?? {};
  for (const key of ['currentApproval', 'latestApproval']) {
    if (key in data) {
      out[key] = data[key] === null ? null : pick(data[key], APPROVAL_SUMMARY_FIELDS);
    }
  }
  return { data: out };
}

const SHAPES: Record<ShapeName, (value: unknown) => unknown> = {
  dashboard: filterDashboard,
  team: filterTeam,
  boardSubmissions: filterBoardSubmissions,
  complianceSignoff: filterComplianceSignoff,
};

export function applyShapePolicy<T>(shape: ShapeName, value: T, allowPersonalData: boolean): T {
  if (allowPersonalData) return value;
  const filter = SHAPES[shape];
  if (!filter) {
    // Unreachable through the type system, but a tool declaring a shape that
    // does not exist must fail closed rather than return the payload raw.
    throw new Error(`Unknown response shape: ${String(shape)}`);
  }
  return filter(value) as T;
}
