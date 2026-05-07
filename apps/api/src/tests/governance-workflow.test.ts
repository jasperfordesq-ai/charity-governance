import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptTeamInviteSchema,
  createCheckoutSchema,
  createRiskRecordSchema,
  inviteTeamMemberSchema,
  upsertAnnualReportReadinessSchema,
  upsertComplianceSignoffSchema,
} from '@charitypilot/shared';

test('risk register validation enforces 1-5 likelihood and impact scores', () => {
  const result = createRiskRecordSchema.safeParse({
    title: 'Late annual filing',
    category: 'GOVERNANCE',
    description: 'Financial statements could be approved too late for annual filing.',
    likelihood: 6,
    impact: 4,
    mitigation: 'Board timetable and finance lead assigned.',
  });

  assert.equal(result.success, false);
  if (result.success) assert.fail('Risk validation should have failed');
  assert.match(result.error.issues[0]?.path.join('.') ?? '', /likelihood/);
});

test('board approval sign-off requires meeting date, minute reference, and approver', () => {
  const result = upsertComplianceSignoffSchema.safeParse({
    reportingYear: 2026,
    status: 'APPROVED',
  });

  assert.equal(result.success, false);
  if (result.success) assert.fail('Approved sign-off without approval fields should fail');
  assert.deepEqual(
    result.error.issues.map((issue) => issue.path.join('.')).sort(),
    ['approvedByName', 'boardMeetingDate', 'minuteReference'],
  );
});

test('annual report readiness accepts the expected governance workflow fields', () => {
  const result = upsertAnnualReportReadinessSchema.safeParse({
    reportingYear: 2026,
    activitiesNarrative: 'Programmes delivered across the year.',
    publicBenefitStatement: 'Activities advanced the charity purpose for public benefit.',
    financialStatementsApproved: true,
    trusteeDetailsReviewed: true,
    filingStatus: 'BOARD_APPROVED',
    boardApprovalDate: '2026-09-15',
  });

  assert.equal(result.success, true);
});

test('team invites restrict assignable roles and enforce invited account password strength', () => {
  assert.equal(inviteTeamMemberSchema.safeParse({ email: 'person@example.org', role: 'OWNER' }).success, false);
  assert.equal(inviteTeamMemberSchema.safeParse({ email: 'person@example.org', role: 'ADMIN' }).success, true);
  assert.equal(
    acceptTeamInviteSchema.safeParse({
      token: 'abc',
      name: 'Invited Trustee',
      password: 'weak',
    }).success,
    false,
  );
});

test('billing checkout accepts only supported plan intervals', () => {
  assert.equal(createCheckoutSchema.safeParse({ plan: 'COMPLETE', interval: 'yearly' }).success, true);
  assert.equal(createCheckoutSchema.safeParse({ plan: 'COMPLETE', interval: 'weekly' }).success, false);
});
