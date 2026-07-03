import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrganisationService } from '../services/organisation.service.js';

function fullOrgRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'org-1',
    name: 'Acme Charity',
    rcnNumber: null,
    croNumber: null,
    legalForm: 'CLG',
    complexity: 'SIMPLE',
    charitablePurpose: [],
    financialYearEnd: null,
    registeredAddress: null,
    contactEmail: null,
    contactPhone: null,
    website: null,
    dateRegistered: null,
    lastAgmDate: null,
    conditionalObligationProfile: null,
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

test('updateOrganisation regenerates derived deadlines inside the same Prisma transaction', async () => {
  const calls: string[] = [];
  const tx = {
    organisation: {
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
      findFirst: async () => {
        calls.push('tx.deadline.findFirst');
        return null;
      },
      create: async () => {
        calls.push('tx.deadline.create');
        return {};
      },
      update: async () => {
        calls.push('tx.deadline.update');
        return {};
      },
      deleteMany: async () => {
        calls.push('tx.deadline.deleteMany');
        return { count: 0 };
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

  await service.updateOrganisation('org-1', { financialYearEnd: '2026-12-31' });

  assert.deepEqual(calls.slice(0, 3), [
    'prisma.$transaction',
    'tx.organisation.update',
    'tx.organisation.findUniqueOrThrow',
  ]);
  assert.ok(calls.includes('tx.deadline.deleteMany'), 'stale auto deadlines must be cleaned in the transaction');
  assert.ok(calls.includes('tx.deadline.findFirst'), 'auto deadline lookup must use the transaction client');
  assert.ok(calls.includes('tx.deadline.create'), 'auto deadline writes must use the transaction client');
});

test('updateOrganisation skips deadline regeneration for non-date profile edits', async () => {
  const calls: string[] = [];
  const tx = {
    organisation: {
      update: async () => {
        calls.push('tx.organisation.update');
        return fullOrgRecord({ name: 'Renamed Charity' });
      },
    },
    deadline: {
      findFirst: async () => {
        calls.push('tx.deadline.findFirst');
        return null;
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

  await service.updateOrganisation('org-1', { name: 'Renamed Charity' });

  assert.deepEqual(calls, ['prisma.$transaction', 'tx.organisation.update']);
});

test('updateOrganisation persists conditional obligation facts without regenerating deadlines', async () => {
  const calls: string[] = [];
  let updateData: unknown;
  const tx = {
    organisation: {
      update: async (args: { data: unknown }) => {
        calls.push('tx.organisation.update');
        updateData = args.data;
        return fullOrgRecord({ conditionalObligationProfile: conditionalProfile });
      },
    },
    deadline: {
      findFirst: async () => {
        calls.push('tx.deadline.findFirst');
        return null;
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

  const result = await service.updateOrganisation('org-1', { conditionalObligationProfile: conditionalProfile });

  assert.deepEqual(calls, ['prisma.$transaction', 'tx.organisation.update']);
  assert.deepEqual(updateData, { conditionalObligationProfile: conditionalProfile });
  assert.deepEqual(result.conditionalObligationProfile, conditionalProfile);
});
