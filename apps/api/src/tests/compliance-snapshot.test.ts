import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ComplianceSnapshotIntegrityError,
  canonicalizeComplianceSnapshot,
  hashComplianceSnapshot,
  parseAndVerifyStoredComplianceSnapshot,
  parseComplianceSnapshotPayload,
  verifyComplianceSnapshot,
  type ComplianceApprovalSnapshotPayloadV1,
} from '../services/compliance-snapshot.js';

function validPayload(): ComplianceApprovalSnapshotPayloadV1 {
  return {
    kind: 'charitypilot.compliance-approval',
    formatVersion: 1,
    evidence: {
      organisation: {
        id: 'org-1',
        name: 'Example Charity',
        rcnNumber: 'RCN 12345',
      },
      reportingYear: 2026,
      scope: {
        complexity: 'SIMPLE',
        plan: 'ESSENTIALS',
        conditionalObligationProfile: {
          hasPaidStaff: false,
          hasVolunteers: true,
          raisesFundsFromPublic: false,
          worksWithChildrenOrVulnerableAdults: false,
          processesPersonalData: false,
          operatesPremisesOrEvents: false,
          isPublicSectorBody: false,
          usesDataProcessors: false,
        },
      },
      matrixLastChecked: '2026-07-10',
      standards: [
        {
          principle: {
            id: 'principle-1',
            number: 1,
            title: 'Advancing charitable purpose',
            sortOrder: 1,
          },
          standard: {
            id: 'standard-1-1',
            code: '1.1',
            title: 'Know the charitable purpose',
            isCore: true,
            isAdditional: false,
            sortOrder: 1,
          },
          record: {
            id: 'record-1',
            revision: 4,
            status: 'COMPLIANT',
            actionTaken: 'Reviewed by trustees',
            evidence: 'Board minutes BM-12',
            notes: 'Internal follow-up remains private',
            explanationIfNA: null,
            updatedAt: '2026-07-10T10:15:30.000Z',
            updatedById: 'user-1',
          },
        },
      ],
      readiness: {
        ready: true,
        missingRecords: [],
        missingEvidence: [],
        missingExplanations: [],
        profileIssues: [],
        conditionalReviewItems: [],
        matrixReviewItems: [
          {
            standardCode: '1.1',
            matrixEntryId: 'matrix-1',
            commencementStatus: 'in_force',
            boardApproval: 'required',
            professionalReview: ['governance_expert'],
            sourceRefs: [
              {
                name: 'Governance Code',
                owner: 'Charities Regulator',
                url: 'https://www.charitiesregulator.ie/',
                lastChecked: '2026-07-10',
                note: 'Official governance source',
              },
            ],
            applicabilityNote: 'Applies to the in-scope standard.',
            evidenceRequired: ['Board minutes'],
          },
        ],
        matrixLastChecked: '2026-07-10',
      },
    },
    approval: {
      sequence: 2,
      boardMeetingDate: '2026-07-09',
      minuteReference: 'BM-2026-07 item 4',
      approvedByName: 'A. Chair',
      approvedByRole: 'Chairperson',
      approvalNotes: 'Approved subject to tracked follow-up.',
      recordedById: 'user-1',
      recordedByName: 'Admin User',
      approvedAt: '2026-07-10T11:00:00.000Z',
    },
  };
}

test('canonical snapshot JSON and hash are stable across object insertion order', () => {
  const left = { z: 1, 2: 'two', 10: 'ten', nested: { b: true, a: null } };
  const right = { nested: { a: null, b: true }, 10: 'ten', 2: 'two', z: 1 };

  const expected = '{"10":"ten","2":"two","nested":{"a":null,"b":true},"z":1}';
  assert.equal(canonicalizeComplianceSnapshot(left), expected);
  assert.equal(canonicalizeComplianceSnapshot(right), expected);
  assert.equal(hashComplianceSnapshot(left), hashComplianceSnapshot(right));
  assert.match(hashComplianceSnapshot(left), /^[a-f0-9]{64}$/);
});

test('canonicalization rejects values that cannot be immutable canonical JSON', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  for (const invalid of [
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: new Date('2026-01-01T00:00:00.000Z') },
    { value: '\ud800' },
    cyclic,
  ]) {
    assert.throws(
      () => canonicalizeComplianceSnapshot(invalid),
      ComplianceSnapshotIntegrityError,
    );
  }
});

test('valid approval payload verifies both evidence and complete snapshot hashes', () => {
  const payload = validPayload();
  const evidenceHash = hashComplianceSnapshot(payload.evidence);
  const snapshotHash = hashComplianceSnapshot(payload);

  assert.deepEqual(parseComplianceSnapshotPayload(payload), payload);
  assert.equal(verifyComplianceSnapshot({ payload, evidenceHash, snapshotHash }), true);

  const verified = parseAndVerifyStoredComplianceSnapshot({
    id: 'snapshot-1',
    organisationId: 'org-1',
    reportingYear: 2026,
    approvalSequence: 2,
    formatVersion: 1,
    evidenceHash,
    snapshotHash,
    payload,
    approvedAt: new Date('2026-07-10T11:00:00.000Z'),
    createdById: 'user-1',
    createdByName: 'Admin User',
  });
  assert.equal(verified.approval.minuteReference, 'BM-2026-07 item 4');
});

test('stored snapshot verification fails closed for payload, hash, or row metadata changes', () => {
  const payload = validPayload();
  const stored = {
    id: 'snapshot-1',
    organisationId: 'org-1',
    reportingYear: 2026,
    approvalSequence: 2,
    formatVersion: 1,
    evidenceHash: hashComplianceSnapshot(payload.evidence),
    snapshotHash: hashComplianceSnapshot(payload),
    payload,
    approvedAt: new Date('2026-07-10T11:00:00.000Z'),
    createdById: 'user-1',
    createdByName: 'Admin User',
  };

  const tamperedPayload = structuredClone(payload);
  tamperedPayload.evidence.standards[0].record!.evidence = 'Changed after approval';
  assert.equal(
    verifyComplianceSnapshot({
      payload: tamperedPayload,
      evidenceHash: stored.evidenceHash,
      snapshotHash: stored.snapshotHash,
    }),
    false,
  );

  for (const changed of [
    { ...stored, organisationId: 'org-2' },
    { ...stored, reportingYear: 2025 },
    { ...stored, approvalSequence: 3 },
    { ...stored, formatVersion: 2 },
    { ...stored, evidenceHash: '0'.repeat(64) },
    { ...stored, snapshotHash: '0'.repeat(64) },
    { ...stored, approvedAt: new Date('2026-07-10T11:00:01.000Z') },
    { ...stored, createdById: 'user-2' },
    { ...stored, createdByName: 'Different User' },
  ]) {
    assert.throws(
      () => parseAndVerifyStoredComplianceSnapshot(changed),
      ComplianceSnapshotIntegrityError,
    );
  }
});

test('payload validation rejects unready, incomplete, duplicate, and unsorted evidence', () => {
  const unready = structuredClone(validPayload());
  unready.evidence.readiness.ready = false;

  const missingNotes = structuredClone(validPayload()) as unknown as {
    evidence: { standards: Array<{ record: Record<string, unknown> }> };
  };
  delete missingNotes.evidence.standards[0].record.notes;

  const duplicate = structuredClone(validPayload());
  duplicate.evidence.standards.push(structuredClone(duplicate.evidence.standards[0]));

  const missingRecord = structuredClone(validPayload());
  missingRecord.evidence.standards[0].record = null;

  const contradictoryReadiness = structuredClone(validPayload());
  contradictoryReadiness.evidence.readiness.missingRecords.push({
    standardId: 'standard-1-1',
    standardCode: '1.1',
    status: 'NOT_STARTED',
  });

  const unsorted = structuredClone(validPayload());
  const later = structuredClone(unsorted.evidence.standards[0]);
  later.standard.id = 'standard-1-2';
  later.standard.code = '1.2';
  later.standard.sortOrder = 2;
  later.record!.id = 'record-2';
  unsorted.evidence.standards.unshift(later);

  for (const invalid of [
    unready,
    missingNotes,
    duplicate,
    missingRecord,
    contradictoryReadiness,
    unsorted,
  ]) {
    assert.throws(() => parseComplianceSnapshotPayload(invalid), ComplianceSnapshotIntegrityError);
  }
});
