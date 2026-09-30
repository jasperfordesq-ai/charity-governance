import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RegisterStatus } from '@charitypilot/shared';
import { GovernanceRegisterService } from '../services/governance-register.service.js';

test('complaint create, edit and delete append actor-bound metadata without copying narratives', async () => {
  const time = new Date('2026-09-28T10:00:00.000Z');
  let row: Record<string, unknown> | null = null;
  const audits: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => [{ id: 'org-1' }],
    complaintRecord: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...data, id: 'complaint-1', updatedAt: time };
        return row;
      },
      findFirst: async () => row,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...row, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)), updatedAt: time };
        return row;
      },
      delete: async () => { row = null; },
    },
    governanceRegisterChangeAudit: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return { id: `audit-${audits.length}` }; } },
  };
  const service = new GovernanceRegisterService({ $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx) } as never);

  await service.createComplaint('org-1', { receivedDate: '2026-09-01', summary: 'Person and sensitive narrative' }, 'actor-1');
  await service.updateComplaint('org-1', 'complaint-1', { status: RegisterStatus.CLOSED, summary: 'Changed private account' }, time.toISOString(), 'actor-2');
  await service.removeComplaint('org-1', 'complaint-1', 'actor-3');

  assert.equal(row, null);
  assert.deepEqual(audits.map(({ recordKind, action, actorUserId, previousStatus, nextStatus }) => ({ recordKind, action, actorUserId, previousStatus, nextStatus })), [
    { recordKind: 'COMPLAINT', action: 'CREATE', actorUserId: 'actor-1', previousStatus: null, nextStatus: 'OPEN' },
    { recordKind: 'COMPLAINT', action: 'UPDATE', actorUserId: 'actor-2', previousStatus: 'OPEN', nextStatus: 'CLOSED' },
    { recordKind: 'COMPLAINT', action: 'DELETE', actorUserId: 'actor-3', previousStatus: 'CLOSED', nextStatus: null },
  ]);
  assert.deepEqual(audits[1].changedFields, ['status', 'summary']);
  assert.doesNotMatch(JSON.stringify(audits), /Person and sensitive narrative|Changed private account/);
});

test('a complaint audit write failure fails the create operation', async () => {
  const tx = {
    $queryRaw: async () => [{ id: 'org-1' }],
    complaintRecord: { create: async () => ({ id: 'complaint-1', status: 'OPEN' }) },
    governanceRegisterChangeAudit: { create: async () => { throw new Error('audit unavailable'); } },
  };
  const service = new GovernanceRegisterService({ $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx) } as never);
  await assert.rejects(
    service.createComplaint('org-1', { receivedDate: '2026-09-01', summary: 'Private complaint' }, 'actor-1'),
    /audit unavailable/,
  );
});

test('conflict and fundraising actions retain actor and status history without sensitive field values', async () => {
  const time = new Date('2026-09-28T10:00:00.000Z');
  const audits: Array<Record<string, unknown>> = [];
  let conflict: Record<string, unknown> | null = null;
  let fundraising: Record<string, unknown> | null = null;
  const tx = {
    $queryRaw: async () => [{ id: 'org-1' }],
    conflictRecord: {
      create: async ({ data }: { data: Record<string, unknown> }) => (conflict = { ...data, id: 'conflict-1', updatedAt: time }),
      findFirst: async () => conflict,
      update: async ({ data }: { data: Record<string, unknown> }) => (conflict = { ...conflict, ...data, updatedAt: time }),
      delete: async () => { conflict = null; },
    },
    fundraisingRecord: {
      create: async ({ data }: { data: Record<string, unknown> }) => (fundraising = { ...data, id: 'fundraising-1', updatedAt: time }),
      findFirst: async () => fundraising,
      update: async ({ data }: { data: Record<string, unknown> }) => (fundraising = { ...fundraising, ...data, updatedAt: time }),
      delete: async () => { fundraising = null; },
    },
    governanceRegisterChangeAudit: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return { id: `audit-${audits.length}` }; } },
  };
  const service = new GovernanceRegisterService({ $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx) } as never);

  await service.createConflict('org-1', { trusteeName: 'Private person', matter: 'Sensitive interest', nature: 'Personal', dateDeclared: '2026-09-01' } as never, 'actor-1');
  await service.updateConflict('org-1', 'conflict-1', { status: 'MANAGED', matter: 'Changed private matter' } as never, time.toISOString(), 'actor-2');
  await service.removeConflict('org-1', 'conflict-1', 'actor-3');
  await service.createFundraising('org-1', { name: 'Private fundraiser', controls: 'Sensitive controls' } as never, 'actor-4');
  await service.updateFundraising('org-1', 'fundraising-1', { status: RegisterStatus.CLOSED, controls: 'Changed private controls' }, time.toISOString(), 'actor-5');
  await service.removeFundraising('org-1', 'fundraising-1', 'actor-6');

  assert.deepEqual(audits.map(({ recordKind, action, actorUserId, previousStatus, nextStatus }) => ({ recordKind, action, actorUserId, previousStatus, nextStatus })), [
    { recordKind: 'CONFLICT', action: 'CREATE', actorUserId: 'actor-1', previousStatus: null, nextStatus: 'DECLARED' },
    { recordKind: 'CONFLICT', action: 'UPDATE', actorUserId: 'actor-2', previousStatus: 'DECLARED', nextStatus: 'MANAGED' },
    { recordKind: 'CONFLICT', action: 'DELETE', actorUserId: 'actor-3', previousStatus: 'MANAGED', nextStatus: null },
    { recordKind: 'FUNDRAISING', action: 'CREATE', actorUserId: 'actor-4', previousStatus: null, nextStatus: 'OPEN' },
    { recordKind: 'FUNDRAISING', action: 'UPDATE', actorUserId: 'actor-5', previousStatus: 'OPEN', nextStatus: 'CLOSED' },
    { recordKind: 'FUNDRAISING', action: 'DELETE', actorUserId: 'actor-6', previousStatus: 'CLOSED', nextStatus: null },
  ]);
  assert.deepEqual(audits[1].changedFields, ['status', 'matter']);
  assert.deepEqual(audits[4].changedFields, ['status', 'controls']);
  assert.doesNotMatch(JSON.stringify(audits), /Private person|Sensitive interest|Changed private matter|Private fundraiser|Sensitive controls|Changed private controls/);
});

test('annual and financial control upserts audit both creation and revision without copying narrative', async () => {
  const time = new Date('2026-09-28T10:00:00.000Z');
  const audits: Array<Record<string, unknown>> = [];
  let annual: Record<string, unknown> | null = null;
  let financial: Record<string, unknown> | null = null;
  const tx = {
    $queryRaw: async () => [{ id: 'org-1' }],
    annualReportReadiness: {
      findUnique: async () => annual,
      upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => (annual = {
        ...(annual ?? create), ...(annual ? update : {}), id: 'annual-1', updatedAt: time,
      }),
    },
    financialControlReview: {
      findUnique: async () => financial,
      upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => (financial = {
        ...(financial ?? create), ...(financial ? update : {}), id: 'financial-1', updatedAt: time,
      }),
    },
    governanceRegisterChangeAudit: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return { id: `audit-${audits.length}` }; } },
  };
  const service = new GovernanceRegisterService({
    $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx),
    financialControlReview: { findUnique: async () => financial },
  } as never);

  await service.upsertAnnualReportReadiness('org-1', { reportingYear: 2026, activitiesNarrative: 'Private annual account' }, 'actor-1');
  await service.upsertAnnualReportReadiness('org-1', { reportingYear: 2026, publicBenefitStatement: 'Changed private account' }, 'actor-2');
  await service.upsertFinancialControlReview('org-1', { reportingYear: 2026, actions: 'Private control action' }, 'actor-3');
  await service.upsertFinancialControlReview('org-1', { reportingYear: 2026, actions: 'Changed private action' }, 'actor-4');

  assert.deepEqual(audits.map(({ recordKind, action, actorUserId, changedFields }) => ({ recordKind, action, actorUserId, changedFields })), [
    { recordKind: 'ANNUAL_REPORT', action: 'CREATE', actorUserId: 'actor-1', changedFields: ['activitiesNarrative'] },
    { recordKind: 'ANNUAL_REPORT', action: 'UPDATE', actorUserId: 'actor-2', changedFields: ['publicBenefitStatement'] },
    { recordKind: 'FINANCIAL_CONTROL', action: 'CREATE', actorUserId: 'actor-3', changedFields: ['actions'] },
    { recordKind: 'FINANCIAL_CONTROL', action: 'UPDATE', actorUserId: 'actor-4', changedFields: ['actions'] },
  ]);
  assert.equal(audits[0].nextStatus, 'NOT_STARTED');
  assert.equal(audits[1].previousStatus, 'NOT_STARTED');
  assert.doesNotMatch(JSON.stringify(audits), /Private annual account|Changed private account|Private control action|Changed private action/);
});
