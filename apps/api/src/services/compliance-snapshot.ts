import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  ComplianceApprovalReadinessResponse,
  ComplianceApprovalSnapshotPayload,
  ComplianceEvidenceRecordSnapshot,
  ComplianceEvidenceStandardSnapshot,
} from '@charitypilot/shared';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SNAPSHOT_KIND = 'charitypilot.compliance-approval' as const;
const SNAPSHOT_FORMAT_VERSION = 1 as const;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ComplianceSnapshotRecordV1 = ComplianceEvidenceRecordSnapshot;
export type ComplianceSnapshotStandardV1 = ComplianceEvidenceStandardSnapshot;
export type ComplianceApprovalSnapshotPayloadV1 = ComplianceApprovalSnapshotPayload;

export interface StoredComplianceApprovalSnapshot {
  id: string;
  organisationId: string;
  reportingYear: number;
  approvalSequence: number;
  formatVersion: number;
  evidenceHash: string;
  snapshotHash: string;
  payload: unknown;
  approvedAt: Date | string;
  createdById: string;
  createdByName: string | null;
}

export class ComplianceSnapshotIntegrityError extends Error {
  readonly code = 'COMPLIANCE_SNAPSHOT_INTEGRITY_FAILED';

  constructor() {
    super('Stored compliance approval snapshot failed integrity verification');
    this.name = 'ComplianceSnapshotIntegrityError';
  }
}

/**
 * Canonical JSON for approval evidence. The implementation follows the JSON
 * Canonicalization Scheme's object-key ordering and ECMAScript primitive
 * serialization rules while rejecting values that are not valid I-JSON.
 */
export function canonicalizeComplianceSnapshot(value: unknown): string {
  const ancestors = new Set<object>();
  let visitedNodes = 0;

  const canonicalize = (current: unknown, depth: number): string => {
    visitedNodes += 1;
    if (depth > 100 || visitedNodes > 100_000) {
      throw new ComplianceSnapshotIntegrityError();
    }

    if (current === null) return 'null';
    if (typeof current === 'boolean') return current ? 'true' : 'false';

    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new ComplianceSnapshotIntegrityError();
      return JSON.stringify(current);
    }

    if (typeof current === 'string') {
      assertValidUnicode(current);
      return JSON.stringify(current);
    }

    if (typeof current !== 'object') {
      throw new ComplianceSnapshotIntegrityError();
    }

    if (ancestors.has(current)) throw new ComplianceSnapshotIntegrityError();
    ancestors.add(current);

    try {
      if (Array.isArray(current)) {
        const values: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) throw new ComplianceSnapshotIntegrityError();
          values.push(canonicalize(current[index], depth + 1));
        }
        return `[${values.join(',')}]`;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ComplianceSnapshotIntegrityError();
      }

      const record = current as Record<string, unknown>;
      const properties = Object.keys(record)
        .sort()
        .map((key) => {
          assertValidUnicode(key);
          return `${JSON.stringify(key)}:${canonicalize(record[key], depth + 1)}`;
        });
      return `{${properties.join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  return canonicalize(value, 0);
}

export function hashComplianceSnapshot(value: unknown): string {
  return createHash('sha256')
    .update(canonicalizeComplianceSnapshot(value), 'utf8')
    .digest('hex');
}

export function parseComplianceSnapshotPayload(value: unknown): ComplianceApprovalSnapshotPayloadV1 {
  try {
    const payload = objectWithKeys(value, ['kind', 'formatVersion', 'evidence', 'approval']);
    if (payload.kind !== SNAPSHOT_KIND || payload.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
      throw new ComplianceSnapshotIntegrityError();
    }

    const evidence = objectWithKeys(payload.evidence, [
      'organisation',
      'reportingYear',
      'scope',
      'matrixLastChecked',
      'standards',
      'readiness',
    ]);
    const organisation = objectWithKeys(evidence.organisation, ['id', 'name', 'rcnNumber']);
    requireNonEmptyString(organisation.id);
    requireNonEmptyString(organisation.name);
    requireNullableString(organisation.rcnNumber);
    requireInteger(evidence.reportingYear, 2018, 2100);

    const scope = objectWithKeys(evidence.scope, ['complexity', 'plan', 'conditionalObligationProfile']);
    requireEnum(scope.complexity, ['SIMPLE', 'COMPLEX']);
    requireEnum(scope.plan, ['ESSENTIALS', 'COMPLETE']);
    requireJsonObject(scope.conditionalObligationProfile);
    requireIsoDate(evidence.matrixLastChecked);

    if (!Array.isArray(evidence.standards) || evidence.standards.length === 0) {
      throw new ComplianceSnapshotIntegrityError();
    }
    const standardIds = new Set<string>();
    const standards = evidence.standards.map((entry) => parseStandard(entry, standardIds));
    assertStandardsSorted(standards);
    if (standards.some((entry) => entry.record === null)) {
      throw new ComplianceSnapshotIntegrityError();
    }
    const readiness = requireSnapshotReadiness(evidence.readiness);
    if (readiness.matrixLastChecked !== evidence.matrixLastChecked) {
      throw new ComplianceSnapshotIntegrityError();
    }

    const approval = objectWithKeys(payload.approval, [
      'sequence',
      'boardMeetingDate',
      'minuteReference',
      'approvedByName',
      'approvedByRole',
      'approvalNotes',
      'recordedById',
      'recordedByName',
      'approvedAt',
    ]);
    requireInteger(approval.sequence, 1, Number.MAX_SAFE_INTEGER);
    requireIsoDate(approval.boardMeetingDate);
    requireNonEmptyString(approval.minuteReference);
    requireNonEmptyString(approval.approvedByName);
    requireNullableString(approval.approvedByRole);
    requireNullableString(approval.approvalNotes);
    requireNonEmptyString(approval.recordedById);
    requireNullableString(approval.recordedByName);
    requireIsoUtcTimestamp(approval.approvedAt);

    // A final canonicalization pass rejects nested undefined values, sparse
    // arrays, unsupported objects, cycles, invalid Unicode and non-finite numbers.
    canonicalizeComplianceSnapshot(payload);
    return payload as unknown as ComplianceApprovalSnapshotPayloadV1;
  } catch (error) {
    if (error instanceof ComplianceSnapshotIntegrityError) throw error;
    throw new ComplianceSnapshotIntegrityError();
  }
}

export function verifyComplianceSnapshot(input: {
  payload: unknown;
  evidenceHash?: string;
  snapshotHash: string;
}): boolean {
  try {
    const payload = parseComplianceSnapshotPayload(input.payload);
    if (!equalSha256(input.snapshotHash, hashComplianceSnapshot(payload))) return false;
    if (input.evidenceHash !== undefined && !equalSha256(input.evidenceHash, hashComplianceSnapshot(payload.evidence))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function parseAndVerifyStoredComplianceSnapshot(
  snapshot: StoredComplianceApprovalSnapshot,
): ComplianceApprovalSnapshotPayloadV1 {
  const payload = parseComplianceSnapshotPayload(snapshot.payload);
  const approvedAt = snapshot.approvedAt instanceof Date
    ? snapshot.approvedAt.toISOString()
    : snapshot.approvedAt;

  if (
    snapshot.formatVersion !== SNAPSHOT_FORMAT_VERSION ||
    payload.evidence.organisation.id !== snapshot.organisationId ||
    payload.evidence.reportingYear !== snapshot.reportingYear ||
    payload.approval.sequence !== snapshot.approvalSequence ||
    payload.approval.approvedAt !== approvedAt ||
    payload.approval.recordedById !== snapshot.createdById ||
    payload.approval.recordedByName !== snapshot.createdByName ||
    !equalSha256(snapshot.evidenceHash, hashComplianceSnapshot(payload.evidence)) ||
    !equalSha256(snapshot.snapshotHash, hashComplianceSnapshot(payload))
  ) {
    throw new ComplianceSnapshotIntegrityError();
  }

  return payload;
}

function parseStandard(value: unknown, standardIds: Set<string>): ComplianceSnapshotStandardV1 {
  const entry = objectWithKeys(value, ['principle', 'standard', 'record']);
  const principle = objectWithKeys(entry.principle, ['id', 'number', 'title', 'sortOrder']);
  requireNonEmptyString(principle.id);
  requireInteger(principle.number, 1, Number.MAX_SAFE_INTEGER);
  requireNonEmptyString(principle.title);
  requireInteger(principle.sortOrder, 0, Number.MAX_SAFE_INTEGER);

  const standard = objectWithKeys(entry.standard, [
    'id',
    'code',
    'title',
    'isCore',
    'isAdditional',
    'sortOrder',
  ]);
  requireNonEmptyString(standard.id);
  requireNonEmptyString(standard.code);
  requireNonEmptyString(standard.title);
  requireBoolean(standard.isCore);
  requireBoolean(standard.isAdditional);
  requireInteger(standard.sortOrder, 0, Number.MAX_SAFE_INTEGER);
  if (standardIds.has(standard.id as string)) throw new ComplianceSnapshotIntegrityError();
  standardIds.add(standard.id as string);

  let record: ComplianceSnapshotRecordV1 | null = null;
  if (entry.record !== null) {
    const parsedRecord = objectWithKeys(entry.record, [
      'id',
      'revision',
      'status',
      'actionTaken',
      'evidence',
      'notes',
      'explanationIfNA',
      'updatedAt',
      'updatedById',
    ]);
    requireNonEmptyString(parsedRecord.id);
    requireInteger(parsedRecord.revision, 1, Number.MAX_SAFE_INTEGER);
    requireEnum(parsedRecord.status, [
      'COMPLIANT',
      'WORKING_TOWARDS',
      'NOT_STARTED',
      'NOT_APPLICABLE',
      'EXPLAIN',
    ]);
    requireNullableString(parsedRecord.actionTaken);
    requireNullableString(parsedRecord.evidence);
    requireNullableString(parsedRecord.notes);
    requireNullableString(parsedRecord.explanationIfNA);
    requireIsoUtcTimestamp(parsedRecord.updatedAt);
    requireNullableString(parsedRecord.updatedById);
    record = parsedRecord as unknown as ComplianceSnapshotRecordV1;
  }

  return {
    principle: principle as unknown as ComplianceSnapshotStandardV1['principle'],
    standard: standard as unknown as ComplianceSnapshotStandardV1['standard'],
    record,
  };
}

function assertStandardsSorted(standards: ComplianceSnapshotStandardV1[]): void {
  for (let index = 1; index < standards.length; index += 1) {
    const previous = standards[index - 1];
    const current = standards[index];
    const comparison =
      previous.principle.sortOrder - current.principle.sortOrder ||
      previous.standard.sortOrder - current.standard.sortOrder ||
      previous.standard.code.localeCompare(current.standard.code) ||
      previous.standard.id.localeCompare(current.standard.id);
    if (comparison > 0) throw new ComplianceSnapshotIntegrityError();
  }
}

function objectWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ComplianceSnapshotIntegrityError();
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new ComplianceSnapshotIntegrityError();
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireJsonObject(value: unknown): asserts value is Record<string, JsonValue> {
  if (!isPlainObject(value)) throw new ComplianceSnapshotIntegrityError();
  canonicalizeComplianceSnapshot(value);
}

function requireSnapshotReadiness(value: unknown): Omit<ComplianceApprovalReadinessResponse, 'evidenceHash'> {
  const readiness = objectWithKeys(value, [
    'ready',
    'missingRecords',
    'missingEvidence',
    'missingExplanations',
    'profileIssues',
    'conditionalReviewItems',
    'matrixReviewItems',
    'matrixLastChecked',
  ]);
  if (readiness.ready !== true) throw new ComplianceSnapshotIntegrityError();
  for (const key of [
    'missingRecords',
    'missingEvidence',
    'missingExplanations',
    'profileIssues',
    'conditionalReviewItems',
    'matrixReviewItems',
  ] as const) {
    if (!Array.isArray(readiness[key])) throw new ComplianceSnapshotIntegrityError();
  }
  for (const key of ['missingRecords', 'missingEvidence', 'missingExplanations', 'profileIssues'] as const) {
    if ((readiness[key] as unknown[]).length !== 0) throw new ComplianceSnapshotIntegrityError();
  }
  for (const item of readiness.conditionalReviewItems as unknown[]) {
    const review = objectWithKeys(item, [
      'profileKey',
      'label',
      'recommendedAction',
      'standardCodes',
      'commencementStatuses',
      'professionalReview',
      'sourceRefs',
      'applicabilityNotes',
    ]);
    requireNonEmptyString(review.profileKey);
    requireNonEmptyString(review.label);
    requireNonEmptyString(review.recommendedAction);
    requireStringArray(review.standardCodes);
    requireStringArray(review.commencementStatuses);
    requireStringArray(review.professionalReview);
    requireSourceRefs(review.sourceRefs);
    requireStringArray(review.applicabilityNotes);
  }
  for (const item of readiness.matrixReviewItems as unknown[]) {
    const review = objectWithKeys(item, [
      'standardCode',
      'matrixEntryId',
      'commencementStatus',
      'boardApproval',
      'professionalReview',
      'sourceRefs',
      'applicabilityNote',
      'evidenceRequired',
    ]);
    requireNonEmptyString(review.standardCode);
    requireNonEmptyString(review.matrixEntryId);
    requireNonEmptyString(review.commencementStatus);
    requireNonEmptyString(review.boardApproval);
    requireStringArray(review.professionalReview);
    requireSourceRefs(review.sourceRefs);
    requireNonEmptyString(review.applicabilityNote);
    requireStringArray(review.evidenceRequired);
  }
  requireIsoDate(readiness.matrixLastChecked);
  canonicalizeComplianceSnapshot(readiness);
  return readiness as unknown as Omit<ComplianceApprovalReadinessResponse, 'evidenceHash'>;
}

function requireStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new ComplianceSnapshotIntegrityError();
  for (const item of value) requireNonEmptyString(item);
}

function requireSourceRefs(value: unknown): void {
  if (!Array.isArray(value)) throw new ComplianceSnapshotIntegrityError();
  for (const item of value) {
    const source = objectWithKeys(item, ['name', 'owner', 'url', 'lastChecked', 'note']);
    requireNonEmptyString(source.name);
    requireNonEmptyString(source.owner);
    requireNonEmptyString(source.url);
    requireIsoDate(source.lastChecked);
    requireNonEmptyString(source.note);
    try {
      if (new URL(source.url as string).protocol !== 'https:') throw new ComplianceSnapshotIntegrityError();
    } catch (error) {
      if (error instanceof ComplianceSnapshotIntegrityError) throw error;
      throw new ComplianceSnapshotIntegrityError();
    }
  }
}

function requireNonEmptyString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ComplianceSnapshotIntegrityError();
  assertValidUnicode(value);
}

function requireNullableString(value: unknown): asserts value is string | null {
  if (value !== null && typeof value !== 'string') throw new ComplianceSnapshotIntegrityError();
  if (typeof value === 'string') assertValidUnicode(value);
}

function requireBoolean(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new ComplianceSnapshotIntegrityError();
}

function requireInteger(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ComplianceSnapshotIntegrityError();
  }
}

function requireEnum<const T extends readonly string[]>(value: unknown, allowed: T): asserts value is T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new ComplianceSnapshotIntegrityError();
}

function requireIsoDate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) throw new ComplianceSnapshotIntegrityError();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ComplianceSnapshotIntegrityError();
  }
}

function requireIsoUtcTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ISO_UTC_TIMESTAMP.test(value)) throw new ComplianceSnapshotIntegrityError();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new ComplianceSnapshotIntegrityError();
  }
}

function equalSha256(left: string, right: string): boolean {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ComplianceSnapshotIntegrityError();
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw new ComplianceSnapshotIntegrityError();
  }
}
