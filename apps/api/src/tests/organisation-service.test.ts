import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrganisationService } from '../services/organisation.service.js';

const EXPECTED_UPDATED_AT = '2026-01-01T00:00:00.000Z';

function fullOrgRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'org-1',
    name: 'Acme Charity',
    rcnNumber: null,
    croNumber: null,
    legalForm: 'CLG',
    legalFormConfirmedAt: null,
    complexity: 'SIMPLE',
    charitablePurpose: [],
    financialYearEnd: null,
    registeredAddress: null,
    contactEmail: null,
    contactPhone: null,
    website: null,
    dateRegistered: null,
    incorporationDate: null,
    croAnnualReturnDate: null,
    croAnnualReturnDateConfirmedAt: null,
    lastActualAgmDate: null,
    lastUnanimousAnnualMemberResolutionDate: null,
    memberCount: null,
    conditionalObligationProfile: null,
    updatedAt: new Date(EXPECTED_UPDATED_AT),
    ...overrides,
  };
}

const conditionalProfile = {
  hasPaidStaff: true,
  hasVolunteers: true,
  raisesFundsFromPublic: true,
  worksWithChildrenOrVulnerableAdults: false,
  processesPersonalData: true,
  operatesPremisesOrEvents: true,
  isPublicSectorBody: false,
  usesDataProcessors: true,
};

function validationService(current: Record<string, unknown>) {
  let updateCalled = false;
  const tx = {
    $queryRaw: async () => [{ id: 'org-1' }],
    organisation: {
      findUnique: async () => fullOrgRecord(current),
      update: async () => {
        updateCalled = true;
        return fullOrgRecord(current);
      },
    },
    deadline: {},
  };
  return {
    service: new OrganisationService({
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as never),
    updateCalled: () => updateCalled,
  };
}

test('updateOrganisation regenerates derived deadlines inside the same Prisma transaction', async () => {
  const calls: string[] = [];
  const tx = {
    $queryRaw: async () => {
      calls.push('tx.$queryRaw');
      return [{ id: 'org-1' }];
    },
    organisation: {
      findUnique: async () => {
        calls.push('tx.organisation.findUnique');
        return fullOrgRecord();
      },
      update: async (_args: unknown) => {
        calls.push('tx.organisation.update');
        return fullOrgRecord({ financialYearEnd: new Date('2026-12-31T00:00:00.000Z') });
      },
      findUniqueOrThrow: async (_args: unknown) => {
        calls.push('tx.organisation.findUniqueOrThrow');
        return fullOrgRecord({ financialYearEnd: new Date('2026-12-31T00:00:00.000Z') });
      },
    },
    deadline: {
      findMany: async () => {
        calls.push('tx.deadline.findMany');
        return [];
      },
      create: async () => {
        calls.push('tx.deadline.create');
        return {};
      },
      update: async () => {
        calls.push('tx.deadline.update');
        return {};
      },
    },
  };
  const prisma = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      calls.push('prisma.$transaction');
      return callback(tx);
    },
  };
  const service = new OrganisationService(prisma as never);

  await service.updateOrganisation('org-1', {
    expectedUpdatedAt: EXPECTED_UPDATED_AT,
    financialYearEnd: '2026-12-31',
  });

  assert.deepEqual(calls.slice(0, 4), [
    'prisma.$transaction',
    'tx.$queryRaw',
    'tx.organisation.findUnique',
    'tx.organisation.update',
  ]);
  assert.ok(calls.includes('tx.organisation.findUniqueOrThrow'), 'calendar inputs must be read in the transaction');
  assert.ok(calls.includes('tx.deadline.findMany'), 'generated lifecycle lookup must use the transaction client');
  assert.ok(calls.includes('tx.deadline.create'), 'auto deadline writes must use the transaction client');
});

test('updateOrganisation skips deadline regeneration for non-date profile edits', async () => {
  const calls: string[] = [];
  const tx = {
    $queryRaw: async () => {
      calls.push('tx.$queryRaw');
      return [{ id: 'org-1' }];
    },
    organisation: {
      findUnique: async () => {
        calls.push('tx.organisation.findUnique');
        return fullOrgRecord();
      },
      update: async () => {
        calls.push('tx.organisation.update');
        return fullOrgRecord({ name: 'Renamed Charity' });
      },
    },
    deadline: {},
  };
  const prisma = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      calls.push('prisma.$transaction');
      return callback(tx);
    },
  };
  const service = new OrganisationService(prisma as never);

  await service.updateOrganisation('org-1', { expectedUpdatedAt: EXPECTED_UPDATED_AT, name: 'Renamed Charity' });

  assert.deepEqual(calls, [
    'prisma.$transaction',
    'tx.$queryRaw',
    'tx.organisation.findUnique',
    'tx.organisation.update',
  ]);
});

test('organisation optimistic version accepts an equivalent offset instant', async () => {
  const harness = validationService({ updatedAt: new Date(EXPECTED_UPDATED_AT) });
  await harness.service.updateOrganisation('org-1', {
    expectedUpdatedAt: '2026-01-01T01:00:00.000+01:00',
    name: 'Offset-safe charity edit',
  });
  assert.equal(harness.updateCalled(), true);
});

test('updateOrganisation persists conditional obligation facts without regenerating deadlines', async () => {
  const calls: string[] = [];
  let updateData: unknown;
  const tx = {
    $queryRaw: async () => {
      calls.push('tx.$queryRaw');
      return [{ id: 'org-1' }];
    },
    organisation: {
      findUnique: async () => {
        calls.push('tx.organisation.findUnique');
        return fullOrgRecord();
      },
      update: async (args: { data: unknown }) => {
        calls.push('tx.organisation.update');
        updateData = args.data;
        return fullOrgRecord({ conditionalObligationProfile: conditionalProfile });
      },
    },
    deadline: {
      findMany: async () => {
        calls.push('tx.deadline.findMany');
        return [];
      },
    },
  };
  const prisma = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      calls.push('prisma.$transaction');
      return callback(tx);
    },
  };
  const service = new OrganisationService(prisma as never);

  const result = await service.updateOrganisation('org-1', {
    expectedUpdatedAt: EXPECTED_UPDATED_AT,
    conditionalObligationProfile: conditionalProfile,
  });

  assert.deepEqual(calls, [
    'prisma.$transaction',
    'tx.$queryRaw',
    'tx.organisation.findUnique',
    'tx.organisation.update',
  ]);
  assert.deepEqual(updateData, { conditionalObligationProfile: conditionalProfile });
  assert.deepEqual(result.conditionalObligationProfile, conditionalProfile);
});

test('updateOrganisation returns a stable conflict after serializable retries are exhausted', async () => {
  let attempts = 0;
  const service = new OrganisationService({
    $transaction: async () => {
      attempts += 1;
      throw Object.assign(new Error('write conflict'), { code: 'P2034' });
    },
  } as never);

  await assert.rejects(
    () => service.updateOrganisation('org-1', { expectedUpdatedAt: EXPECTED_UPDATED_AT, name: 'Concurrent edit' }),
    (error: unknown) =>
      (error as { statusCode?: number; code?: string }).statusCode === 409 &&
      (error as { code?: string }).code === 'ORGANISATION_UPDATE_CONFLICT',
  );
  assert.equal(attempts, 3);
});

test('optimistic version binding rejects stale legal-form and CRO confirmations', async () => {
  for (const patch of [
    { confirmLegalForm: true },
    { confirmCroAnnualReturnDate: true },
  ] as const) {
    const harness = validationService({
      legalForm: 'TRUST',
      croAnnualReturnDate: new Date('2026-10-30T00:00:00.000Z'),
      updatedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await assert.rejects(
      () => harness.service.updateOrganisation('org-1', {
        expectedUpdatedAt: EXPECTED_UPDATED_AT,
        ...patch,
      }),
      (error: unknown) =>
        (error as { statusCode?: number; code?: string }).statusCode === 409 &&
        (error as { code?: string }).code === 'ORGANISATION_UPDATE_CONFLICT',
    );
    assert.equal(harness.updateCalled(), false);
  }
});

test('calendar evidence rejects impossible confirmation and future actual-event dates', async () => {
  for (const [body, expectedCode] of [
    [{ legalForm: null, confirmLegalForm: true }, 'LEGAL_FORM_REQUIRED'],
    [{ croAnnualReturnDate: null, confirmCroAnnualReturnDate: true }, 'CRO_ARD_REQUIRED'],
    [{ financialYearEnd: '9999-12-31' }, 'LEGAL_CALENDAR_DATE_OUT_OF_RANGE'],
    [{ incorporationDate: '9999-12-31' }, 'LEGAL_CALENDAR_DATE_OUT_OF_RANGE'],
    [{ lastActualAgmDate: '9999-12-31' }, 'LEGAL_CALENDAR_DATE_OUT_OF_RANGE'],
    [{ lastUnanimousAnnualMemberResolutionDate: '9999-12-31' }, 'LEGAL_CALENDAR_DATE_OUT_OF_RANGE'],
  ] as const) {
    const harness = validationService({ legalForm: null });
    await assert.rejects(
      () => harness.service.updateOrganisation('org-1', { expectedUpdatedAt: EXPECTED_UPDATED_AT, ...body }),
      (error: unknown) => (error as { code?: string }).code === expectedCode,
    );
    assert.equal(harness.updateCalled(), false);
  }
});

test('calendar evidence cannot pre-date a recorded incorporation', async () => {
  for (const [body, expectedCode] of [
    [{ lastActualAgmDate: '2024-12-31' }, 'ACTUAL_AGM_BEFORE_INCORPORATION'],
    [{ lastUnanimousAnnualMemberResolutionDate: '2024-12-31' }, 'MEMBER_RESOLUTION_BEFORE_INCORPORATION'],
    [{ croAnnualReturnDate: '2024-12-31', confirmCroAnnualReturnDate: true }, 'CRO_ARD_BEFORE_INCORPORATION'],
  ] as const) {
    const harness = validationService({ incorporationDate: new Date('2025-01-01T00:00:00.000Z') });
    await assert.rejects(
      () => harness.service.updateOrganisation('org-1', { expectedUpdatedAt: EXPECTED_UPDATED_AT, ...body }),
      (error: unknown) => (error as { code?: string }).code === expectedCode,
    );
    assert.equal(harness.updateCalled(), false);
  }
});

test('revoking a calendar confirmation supersedes the affected generated occurrence', async () => {
  const superseded: Array<Record<string, unknown>> = [];
  const currentDeadline = {
    id: 'company-action-1',
    organisationId: 'org-1',
    generatedKey: 'irish.company.annual-member-action',
    generationVersion: 1,
    generationRuleVersion: 1,
    generationFingerprint: 'a'.repeat(64),
    isAutoGenerated: true,
    isComplete: false,
    supersededAt: null,
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const confirmed = fullOrgRecord({
    legalForm: 'CLG',
    legalFormConfirmedAt: new Date('2026-01-01T00:00:00.000Z'),
    incorporationDate: new Date('2020-01-01T00:00:00.000Z'),
  });
  const unconfirmed = fullOrgRecord({
    ...confirmed,
    legalFormConfirmedAt: null,
  });
  const tx = {
    $queryRaw: async () => [{ id: 'org-1' }],
    organisation: {
      findUnique: async () => confirmed,
      update: async (args: { data: Record<string, unknown> }) => {
        assert.equal(args.data.legalFormConfirmedAt, null);
        return unconfirmed;
      },
      findUniqueOrThrow: async () => unconfirmed,
    },
    deadline: {
      findMany: async () => [currentDeadline],
      update: async (args: { data: Record<string, unknown> }) => {
        superseded.push(args.data);
        return currentDeadline;
      },
      create: async () => {
        throw new Error('unconfirmation must not create a replacement company occurrence');
      },
    },
  };
  const service = new OrganisationService({
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as never);

  await service.updateOrganisation('org-1', { expectedUpdatedAt: EXPECTED_UPDATED_AT, confirmLegalForm: false });

  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].supersessionReason, 'INPUT_REMOVED');
  assert.ok(superseded[0].supersededAt instanceof Date);
});
