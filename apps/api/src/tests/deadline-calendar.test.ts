import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GENERATED_DEADLINE_KEYS,
  deriveIrishGovernanceDeadlines,
  type OrganisationCalendarProfile,
} from '../services/deadline-calendar.js';

function profile(overrides: Partial<OrganisationCalendarProfile> = {}): OrganisationCalendarProfile {
  return {
    financialYearEnd: null,
    legalForm: null,
    legalFormConfirmedAt: null,
    incorporationDate: null,
    memberCount: null,
    lastActualAgmDate: null,
    lastUnanimousAnnualMemberResolutionDate: null,
    croAnnualReturnDate: null,
    croAnnualReturnDateConfirmedAt: null,
    ...overrides,
  };
}

test('charity annual-report calculation clamps 31 August plus ten months to 30 June', () => {
  const [deadline] = deriveIrishGovernanceDeadlines(profile({ financialYearEnd: '2025-08-31' }));

  assert.equal(deadline.key, GENERATED_DEADLINE_KEYS.CHARITY_ANNUAL_REPORT);
  assert.equal(deadline.dueDate, '2026-06-30');
  assert.match(deadline.fingerprint, /^[0-9a-f]{64}$/);
});

test('company rules require explicitly confirmed CLG status', () => {
  const base = {
    financialYearEnd: '2025-05-31',
    incorporationDate: '2025-01-31',
  };

  assert.deepEqual(
    deriveIrishGovernanceDeadlines(profile({ ...base, legalForm: 'CLG' })).map((item) => item.kind),
    ['CHARITY_ANNUAL_REPORT'],
  );

  const confirmed = deriveIrishGovernanceDeadlines(profile({
    ...base,
    legalForm: 'CLG',
    legalFormConfirmedAt: new Date('2026-07-10T00:00:00Z'),
  }));
  const statements = confirmed.find((item) => item.kind === 'COMPANY_FINANCIAL_STATEMENTS');
  assert.equal(statements?.inputs.unadjustedDueDate, '2026-02-28');
  assert.equal(statements?.dueDate, '2026-03-02');
  assert.equal(confirmed.find((item) => item.kind === 'COMPANY_ANNUAL_MEMBER_ACTION')?.dueDate, '2026-07-31');
});

test('later AGM planning takes the earlier 15-month and following-calendar-year limit', () => {
  const deadlines = deriveIrishGovernanceDeadlines(profile({
    legalForm: 'CLG',
    legalFormConfirmedAt: '2026-07-10T00:00:00Z',
    incorporationDate: '2020-01-01',
    lastActualAgmDate: '2025-11-30',
    lastUnanimousAnnualMemberResolutionDate: '2026-06-30',
    memberCount: 2,
  }));
  const action = deadlines.find((item) => item.kind === 'COMPANY_ANNUAL_MEMBER_ACTION');

  assert.equal(action?.dueDate, '2026-12-31');
  assert.equal(action?.inputs.lastActualAgmDate, '2025-11-30');
  assert.equal(action?.inputs.lastUnanimousAnnualMemberResolutionDate, '2026-06-30');
  // With two members the s.175(3) dispensation is unavailable, so the written
  // resolution cannot advance the calculation and the warning says why.
  assert.match(
    action?.warnings.join(' ') ?? '',
    /A CLG with two or more members cannot use the section 175\(3\) dispensation/,
  );
});

test('Companies Act working-day adjustment also applies to the first AGM planning limit', () => {
  const deadlines = deriveIrishGovernanceDeadlines(profile({
    legalForm: 'CLG',
    legalFormConfirmedAt: '2026-01-01T00:00:00Z',
    incorporationDate: '2024-08-31',
  }));
  const action = deadlines.find((item) => item.kind === 'COMPANY_ANNUAL_MEMBER_ACTION');

  assert.equal(action?.inputs.unadjustedDueDate, '2026-02-28');
  assert.equal(action?.dueDate, '2026-03-02');
});

// s.193(4) deems a written resolution passed at a meeting held on the date of
// the last signature, so the s.175(1) limits run from it exactly as they run
// from an actual AGM: the earlier of 15 months and 31 December of the following
// calendar year. This replaced a flat +12-month "review cadence".
test('a newer sole-member written resolution runs the AGM limits from the resolution date', () => {
  const deadlines = deriveIrishGovernanceDeadlines(profile({
    legalForm: 'CLG',
    legalFormConfirmedAt: '2026-07-10T00:00:00Z',
    incorporationDate: '2020-01-01',
    memberCount: 1,
    lastActualAgmDate: '2024-05-31',
    lastUnanimousAnnualMemberResolutionDate: '2026-06-30',
  }));
  const action = deadlines.find((item) => item.kind === 'COMPANY_ANNUAL_MEMBER_ACTION');

  // 2026-06-30 + 15 months = 2027-09-30, earlier than the 2027-12-31 cap.
  assert.equal(action?.dueDate, '2027-09-30');
  assert.equal(
    action?.inputs.rule,
    'earlier-of-sole-member-resolution-plus-15-months-and-end-of-following-calendar-year',
  );
  // The resolution discharges the AGM obligation under s.175(4) without itself
  // becoming an AGM - the distinction the warning has to preserve.
  assert.match(
    action?.warnings.join(' ') ?? '',
    /discharges the AGM obligation .*\(s\.175\(4\)\) but does not itself become an AGM/,
  );
  // Eligibility is unconfirmed here (constitutionPermitsWrittenResolutions is
  // unset), so it must still demand professional review.
  assert.equal(action?.professionalReviewRequired, true);
  assert.match(action?.warnings.join(' ') ?? '', /Confirm sole-member eligibility/);
});

test('written resolutions do not advance the AGM calculation for multi-member or unknown-member CLGs', () => {
  for (const memberCount of [2, null]) {
    const deadlines = deriveIrishGovernanceDeadlines(profile({
      legalForm: 'CLG',
      legalFormConfirmedAt: '2026-07-10T00:00:00Z',
      incorporationDate: '2020-01-01',
      memberCount,
      lastActualAgmDate: '2025-11-30',
      lastUnanimousAnnualMemberResolutionDate: '2026-06-30',
    }));
    const action = deadlines.find((item) => item.kind === 'COMPANY_ANNUAL_MEMBER_ACTION');

    assert.equal(action?.dueDate, '2026-12-31');
    assert.equal(
      action?.inputs.rule,
      'earlier-of-last-actual-agm-plus-15-months-and-end-of-following-calendar-year',
    );
  }
});

test('CRO calculation requires a confirmed exact ARD and applies earlier-of plus working-day rules', () => {
  const unconfirmed = deriveIrishGovernanceDeadlines(profile({ croAnnualReturnDate: '2026-10-30' }));
  assert.equal(unconfirmed.some((item) => item.kind === 'CRO_ANNUAL_RETURN'), false);

  const confirmed = deriveIrishGovernanceDeadlines(profile({
    financialYearEnd: '2026-01-31',
    croAnnualReturnDate: '2026-10-30',
    croAnnualReturnDateConfirmedAt: new Date('2026-07-10T00:00:00Z'),
  }));
  const cro = confirmed.find((item) => item.kind === 'CRO_ANNUAL_RETURN');

  assert.equal(cro?.inputs.ardPlus56, '2026-12-25');
  assert.equal(cro?.inputs.accountsLimit, '2026-12-26');
  assert.equal(cro?.dueDate, '2026-12-28');
  assert.match(cro?.warnings.join(' ') ?? '', /Verify|confirmation/i);
});

test('fingerprints are deterministic and change with source inputs', () => {
  const first = deriveIrishGovernanceDeadlines(profile({ financialYearEnd: '2025-12-31' }))[0];
  const repeat = deriveIrishGovernanceDeadlines(profile({ financialYearEnd: '2025-12-31' }))[0];
  const changed = deriveIrishGovernanceDeadlines(profile({ financialYearEnd: '2026-12-31' }))[0];

  assert.equal(first.fingerprint, repeat.fingerprint);
  assert.notEqual(first.fingerprint, changed.fingerprint);
});

test('invalid non-null civil inputs fail closed', () => {
  assert.throws(
    () => deriveIrishGovernanceDeadlines(profile({ financialYearEnd: '2025-02-31' })),
    /financialYearEnd must be a valid YYYY-MM-DD civil date/,
  );
});
