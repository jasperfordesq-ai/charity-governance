import assert from 'node:assert/strict';
import test from 'node:test';
import { upsertComplianceSignoffSchema } from '../schemas/compliance.js';
import { createDeadlineSchema } from '../schemas/deadline.js';
import { uploadDocumentSchema } from '../schemas/document.js';
import { createConflictRecordSchema } from '../schemas/governance-registers.js';
import { updateOrganisationSchema } from '../schemas/organisation.js';

test('shared date schemas reject impossible calendar dates instead of Date.parse normalization', () => {
  const cases = [
    ['organisation financial year end', updateOrganisationSchema, { financialYearEnd: '2026-02-31' }],
    ['deadline due date', createDeadlineSchema, { title: 'Annual return', dueDate: '2026-02-31' }],
    [
      'governance register declared date',
      createConflictRecordSchema,
      {
        trusteeName: 'A Trustee',
        matter: 'Related-party payment',
        nature: 'Potential conflict',
        dateDeclared: '2026-02-31',
        actionTaken: 'Recorded and recused',
      },
    ],
    [
      'compliance signoff board date',
      upsertComplianceSignoffSchema,
      {
        reportingYear: 2026,
        status: 'APPROVED',
        boardMeetingDate: '2026-02-31',
        minuteReference: 'BM-2026-01',
        approvedByName: 'Chair',
      },
    ],
    [
      'document approval date',
      uploadDocumentSchema,
      { name: 'Safeguarding policy', category: 'POLICY', approvedDate: '2026-02-31' },
    ],
  ] as const;

  for (const [label, schema, payload] of cases) {
    assert.equal(schema.safeParse(payload).success, false, `${label} must reject impossible dates`);
  }
});

test('shared date schemas accept real ISO dates and datetimes', () => {
  assert.equal(updateOrganisationSchema.safeParse({ financialYearEnd: '2024-02-29' }).success, true);
  assert.equal(createDeadlineSchema.safeParse({ title: 'Annual return', dueDate: '2026-06-06' }).success, true);
  assert.equal(uploadDocumentSchema.safeParse({
    name: 'Board minutes',
    category: 'BOARD_MINUTES',
    approvedDate: '2026-06-06T12:00:00.000Z',
  }).success, true);
});

test('updateOrganisationSchema accepts conditional obligation profile facts', () => {
  const result = updateOrganisationSchema.safeParse({
    conditionalObligationProfile: {
      hasPaidStaff: true,
      hasVolunteers: true,
      raisesFundsFromPublic: true,
      worksWithChildrenOrVulnerableAdults: false,
      processesPersonalData: true,
      operatesPremisesOrEvents: true,
      isPublicSectorBody: false,
      usesDataProcessors: true,
    },
  });

  assert.equal(result.success, true);
});

test('updateOrganisationSchema rejects invalid conditional obligation profile facts', () => {
  const result = updateOrganisationSchema.safeParse({
    conditionalObligationProfile: {
      hasPaidStaff: 'yes',
      raisesFundsFromPublic: true,
      unknownTrigger: true,
    },
  });

  assert.equal(result.success, false);
});
