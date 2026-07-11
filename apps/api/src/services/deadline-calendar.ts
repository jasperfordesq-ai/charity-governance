import { createHash } from 'node:crypto';
import {
  IRISH_COMPANIES_ACT_WORKING_DAY_RULESET_VERSION,
  addCalendarDays,
  addCalendarMonthsClamp,
  adjustIrishCompaniesActDeadlineToWorkingDay,
  compareCivilDates,
  isCivilDate,
  minCivilDate,
  parseCivilDate,
} from '@charitypilot/shared';

export const GENERATED_DEADLINE_RULE_VERSION = 1;

export const GENERATED_DEADLINE_KEYS = {
  CHARITY_ANNUAL_REPORT: 'irish.charity.annual-report',
  COMPANY_FINANCIAL_STATEMENTS: 'irish.company.financial-statements',
  COMPANY_ANNUAL_MEMBER_ACTION: 'irish.company.annual-member-action',
  CRO_ANNUAL_RETURN: 'irish.cro.annual-return',
} as const;

export type GeneratedDeadlineKind = keyof typeof GENERATED_DEADLINE_KEYS;

export type OrganisationCalendarProfile = {
  financialYearEnd: string | null;
  legalForm: string | null;
  legalFormConfirmedAt: Date | string | null;
  incorporationDate: string | null;
  memberCount: number | null;
  lastActualAgmDate: string | null;
  lastUnanimousAnnualMemberResolutionDate: string | null;
  croAnnualReturnDate: string | null;
  croAnnualReturnDateConfirmedAt: Date | string | null;
};

export type GeneratedDeadlineSource = {
  authority: string;
  title: string;
  url: string;
  checkedAt: string;
  classification: 'statutory' | 'official-guidance' | 'derived-planning-convention';
};

export type GeneratedDeadlineSpec = {
  kind: GeneratedDeadlineKind;
  key: string;
  title: string;
  description: string;
  dueDate: string;
  ruleVersion: number;
  fingerprint: string;
  sources: GeneratedDeadlineSource[];
  inputs: Record<string, unknown>;
  professionalReviewRequired: boolean;
  warnings: string[];
};

const source = {
  charityAnnualReport: {
    authority: 'Law Reform Commission',
    title: 'Charities Act 2009, section 52 (revised)',
    url: 'https://revisedacts.lawreform.ie/eli/2009/act/6/section/52/revised/en/html',
    checkedAt: '2026-07-10',
    classification: 'statutory',
  },
  financialStatements: {
    authority: 'Law Reform Commission',
    title: 'Companies Act 2014, section 341 (revised)',
    url: 'https://revisedacts.lawreform.ie/eli/2014/act/38/section/341/revised/en/html',
    checkedAt: '2026-07-10',
    classification: 'statutory',
  },
  annualMeeting: {
    authority: 'Law Reform Commission',
    title: 'Companies Act 2014, section 175 (revised)',
    url: 'https://revisedacts.lawreform.ie/eli/2014/act/38/section/175/revised/en/html',
    checkedAt: '2026-07-10',
    classification: 'statutory',
  },
  clgMeetingApplication: {
    authority: 'Law Reform Commission',
    title: 'Companies Act 2014, section 1202 (revised)',
    url: 'https://revisedacts.lawreform.ie/eli/2014/act/38/section/1202/revised/en/html',
    checkedAt: '2026-07-10',
    classification: 'statutory',
  },
  croAnnualReturn: {
    authority: 'Companies Registration Office',
    title: 'Filing an Annual Return',
    url: 'https://cro.ie/Annual-Return/Filing-an-Annual-Return/',
    checkedAt: '2026-07-10',
    classification: 'official-guidance',
  },
  croStatute: {
    authority: 'Law Reform Commission',
    title: 'Companies Act 2014, section 343 (revised)',
    url: 'https://revisedacts.lawreform.ie/eli/2014/act/38/section/343/revised/en/html',
    checkedAt: '2026-07-10',
    classification: 'statutory',
  },
  companiesActPeriods: {
    authority: 'Law Reform Commission',
    title: 'Companies Act 2014, section 3 (revised)',
    url: 'https://revisedacts.lawreform.ie/eli/2014/act/38/section/3/revised/en/html',
    checkedAt: '2026-07-10',
    classification: 'statutory',
  },
  publicHolidays: {
    authority: 'Irish Statute Book',
    title: 'Organisation of Working Time Act 1997, Schedule 2',
    url: 'https://www.irishstatutebook.ie/eli/1997/act/20/schedule/2/enacted/en/html',
    checkedAt: '2026-07-10',
    classification: 'statutory',
  },
  publicHolidays2022: {
    authority: 'Irish Statute Book',
    title: 'Organisation of Working Time (Covid-19 Commemoration) Regulations 2022 (S.I. No. 50/2022)',
    url: 'https://www.irishstatutebook.ie/eli/2022/si/50/made/en/print',
    checkedAt: '2026-07-10',
    classification: 'statutory',
  },
} as const satisfies Record<string, GeneratedDeadlineSource>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function checkedCivilDate(value: string | null, label: string) {
  if (value === null) return null;
  if (!isCivilDate(value)) {
    throw new RangeError(`${label} must be a valid YYYY-MM-DD civil date`);
  }
  return value;
}

function buildSpec(input: Omit<GeneratedDeadlineSpec, 'fingerprint'>): GeneratedDeadlineSpec {
  return {
    ...input,
    fingerprint: fingerprint({
      key: input.key,
      dueDate: input.dueDate,
      ruleVersion: input.ruleVersion,
      sources: input.sources,
      inputs: input.inputs,
      professionalReviewRequired: input.professionalReviewRequired,
      warnings: input.warnings,
    }),
  };
}

function yearOf(value: string) {
  return parseCivilDate(value).year;
}

export function deriveIrishGovernanceDeadlines(profile: OrganisationCalendarProfile): GeneratedDeadlineSpec[] {
  const financialYearEnd = checkedCivilDate(profile.financialYearEnd, 'financialYearEnd');
  const incorporationDate = checkedCivilDate(profile.incorporationDate, 'incorporationDate');
  const lastActualAgmDate = checkedCivilDate(profile.lastActualAgmDate, 'lastActualAgmDate');
  const lastResolutionDate = checkedCivilDate(
    profile.lastUnanimousAnnualMemberResolutionDate,
    'lastUnanimousAnnualMemberResolutionDate',
  );
  const croAnnualReturnDate = checkedCivilDate(profile.croAnnualReturnDate, 'croAnnualReturnDate');
  const confirmedClg = profile.legalForm === 'CLG' && Boolean(profile.legalFormConfirmedAt);
  const deadlines: GeneratedDeadlineSpec[] = [];

  if (financialYearEnd) {
    deadlines.push(buildSpec({
      kind: 'CHARITY_ANNUAL_REPORT',
      key: GENERATED_DEADLINE_KEYS.CHARITY_ANNUAL_REPORT,
      title: 'Charities Regulator annual report',
      description:
        'Calculated planning date: ten calendar months after the recorded financial year end. Confirm the live date in MyAccount and obtain professional advice for extensions or edge cases.',
      dueDate: addCalendarMonthsClamp(financialYearEnd, 10),
      ruleVersion: GENERATED_DEADLINE_RULE_VERSION,
      sources: [source.charityAnnualReport],
      inputs: {
        financialYearEnd,
        monthArithmetic: 'calendar-months-with-missing-day-clamped-to-month-end',
      },
      professionalReviewRequired: true,
      warnings: [
        'Month-end clamping is a documented planning convention, not professional advice.',
        'A regulator-approved longer period must be recorded separately and must not be inferred.',
      ],
    }));
  }

  if (confirmedClg && financialYearEnd) {
    const unadjustedDueDate = addCalendarMonthsClamp(financialYearEnd, 9);
    deadlines.push(buildSpec({
      kind: 'COMPANY_FINANCIAL_STATEMENTS',
      key: GENERATED_DEADLINE_KEYS.COMPANY_FINANCIAL_STATEMENTS,
      title: 'Company financial statements to members',
      description:
        'Calculated planning date: nine calendar months after the recorded financial year end for laying or providing the statutory financial statements and reports. Confirm applicability with the company secretary or accountant.',
      dueDate: adjustIrishCompaniesActDeadlineToWorkingDay(unadjustedDueDate),
      ruleVersion: GENERATED_DEADLINE_RULE_VERSION,
      sources: [
        source.financialStatements,
        source.companiesActPeriods,
        source.publicHolidays,
        source.publicHolidays2022,
      ],
      inputs: {
        financialYearEnd,
        legalForm: profile.legalForm,
        legalFormConfirmed: true,
        unadjustedDueDate,
        workingDayRuleSet: IRISH_COMPANIES_ACT_WORKING_DAY_RULESET_VERSION,
        monthArithmetic: 'calendar-months-with-missing-day-clamped-to-month-end',
      },
      professionalReviewRequired: true,
      warnings: [
        'This is distinct from the CRO annual-return filing date and from meeting notice/circulation lead time.',
        'A Saturday, Sunday or Irish public-holiday expiry is advanced under Companies Act 2014 section 3.',
      ],
    }));
  }

  const soleMemberResolutionIsLatest = Boolean(
    profile.memberCount === 1 &&
    lastResolutionDate &&
    (!lastActualAgmDate || compareCivilDates(lastResolutionDate, lastActualAgmDate) > 0),
  );

  if (confirmedClg && (soleMemberResolutionIsLatest || lastActualAgmDate || incorporationDate)) {
    let unadjustedDueDate: string;
    let rule: string;
    if (soleMemberResolutionIsLatest) {
      unadjustedDueDate = addCalendarMonthsClamp(lastResolutionDate!, 12);
      rule = 'sole-member-written-resolution-plus-12-month-internal-review-cadence';
    } else if (lastActualAgmDate) {
      const fifteenMonthDate = addCalendarMonthsClamp(lastActualAgmDate, 15);
      const calendarYearCap = `${String(yearOf(lastActualAgmDate) + 1).padStart(4, '0')}-12-31`;
      unadjustedDueDate = minCivilDate(fifteenMonthDate, calendarYearCap);
      rule = 'earlier-of-last-actual-agm-plus-15-months-and-end-of-following-calendar-year';
    } else {
      unadjustedDueDate = addCalendarMonthsClamp(incorporationDate!, 18);
      rule = 'incorporation-plus-18-months';
    }
    const dueDate = soleMemberResolutionIsLatest
      ? unadjustedDueDate
      : adjustIrishCompaniesActDeadlineToWorkingDay(unadjustedDueDate);

    deadlines.push(buildSpec({
      kind: 'COMPANY_ANNUAL_MEMBER_ACTION',
      key: GENERATED_DEADLINE_KEYS.COMPANY_ANNUAL_MEMBER_ACTION,
      title: 'Annual general meeting / member-action review',
      description:
        'Calculated review date based on the confirmed CLG profile and its recorded incorporation, actual AGM, or eligible sole-member written-resolution evidence. A written resolution is never treated as an AGM and requires professional eligibility and evidence review.',
      dueDate,
      ruleVersion: GENERATED_DEADLINE_RULE_VERSION,
      sources: soleMemberResolutionIsLatest
        ? [source.annualMeeting, source.clgMeetingApplication]
        : [
            source.annualMeeting,
            source.clgMeetingApplication,
            source.companiesActPeriods,
            source.publicHolidays,
            source.publicHolidays2022,
          ],
      inputs: {
        incorporationDate,
        lastActualAgmDate,
        lastUnanimousAnnualMemberResolutionDate: lastResolutionDate,
        memberCount: profile.memberCount,
        legalForm: profile.legalForm,
        legalFormConfirmed: true,
        rule,
        unadjustedDueDate,
        workingDayRuleSet: soleMemberResolutionIsLatest
          ? null
          : IRISH_COMPANIES_ACT_WORKING_DAY_RULESET_VERSION,
        monthArithmetic: 'calendar-months-with-missing-day-clamped-to-month-end',
      },
      professionalReviewRequired: true,
      warnings: [
        'The calendar-year cap is a derived conservative planning calculation from the annual and 15-month requirements.',
        ...(soleMemberResolutionIsLatest
          ? []
          : ['A Saturday, Sunday or Irish public-holiday expiry is advanced under Companies Act 2014 section 3.']),
        'Do not record a unanimous written resolution as an actual AGM.',
        ...(soleMemberResolutionIsLatest
          ? [
              'The 12-month sole-member written-resolution date is an internal review cadence, not a statutory deadline calculation.',
              'Confirm sole-member eligibility and every section 175(3) condition with the company secretary or solicitor before relying on a written resolution.',
            ]
          : []),
        'A CLG with two or more members cannot use the section 175(3) dispensation; verify member count and constitution.',
      ],
    }));
  }

  if (croAnnualReturnDate && profile.croAnnualReturnDateConfirmedAt) {
    const ardLimit = addCalendarDays(croAnnualReturnDate, 56);
    const accountsLimit = financialYearEnd
      ? addCalendarDays(addCalendarMonthsClamp(financialYearEnd, 9), 56)
      : null;
    const unadjustedDueDate = accountsLimit ? minCivilDate(ardLimit, accountsLimit) : ardLimit;
    const dueDate = adjustIrishCompaniesActDeadlineToWorkingDay(unadjustedDueDate);

    deadlines.push(buildSpec({
      kind: 'CRO_ANNUAL_RETURN',
      key: GENERATED_DEADLINE_KEYS.CRO_ANNUAL_RETURN,
      title: 'CRO annual return filing',
      description:
        'Review-only planning date from the exact ARD copied from CORE. It applies the published 56-day period, the accounts-bound earlier-of rule when a financial year end is present, and the Companies Act weekend/public-holiday adjustment. Verify the live deadline in CORE or with an accountant.',
      dueDate,
      ruleVersion: GENERATED_DEADLINE_RULE_VERSION,
      sources: [
        source.croAnnualReturn,
        source.croStatute,
        source.companiesActPeriods,
        source.publicHolidays,
        source.publicHolidays2022,
      ],
      inputs: {
        croAnnualReturnDate,
        croAnnualReturnDateConfirmed: true,
        financialYearEnd,
        ardPlus56: ardLimit,
        accountsLimit,
        unadjustedDueDate,
        workingDayRuleSet: IRISH_COMPANIES_ACT_WORKING_DAY_RULESET_VERSION,
      },
      professionalReviewRequired: true,
      warnings: [
        'An earlier return made-up date makes the 56-day period run earlier.',
        'First returns, altered ARDs, court extensions and other exceptions require direct CORE/accountant confirmation.',
      ],
    }));
  }

  return deadlines.sort((left, right) => compareCivilDates(left.dueDate, right.dueDate) || left.key.localeCompare(right.key));
}
