import assert from 'node:assert/strict';
import test from 'node:test';
import { IRISH_COMPLIANCE_MATRIX_LAST_CHECKED, narrativeWarningDate } from '@charitypilot/shared';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'compliance-report-evidence-test-secret';

const { ComplianceService } = await import('../services/compliance.service.js');
const { narrativeWarnings, targetDatesIn, irishToday } = await import('../services/compliance-narrative.js');
const { buildComplianceReportHtml, buildApprovedComplianceReportHtml } = await import('../routes/export/compliance-report-html.js');
const { hashComplianceSnapshot, parseAndVerifyStoredComplianceSnapshot } = await import('../services/compliance-snapshot.js');
const fx = await import('./retained-approval-fixture.js');

/*
 * Found in live use on 2026-10-14. Two trustees signed the Code of Conduct,
 * the signed PDFs were uploaded, set CURRENT and linked to standards 2.1,
 * 2.3, 5.6 and 5.7, and the board register recorded both signatures. None of
 * it reached the year-end Compliance Record report, which kept saying no
 * trustee had signed, with a target date six weeks past.
 *
 * The fixture below is that situation, plus every kind of document that must
 * NOT be shown as evidence, plus every personal particular that must NOT
 * appear in the report.
 */

const NOW = new Date('2026-10-14T12:00:00.000Z');

/** A date as the report prints it, so the test does not depend on the ICU build's padding. */
const shown = (iso: string) => new Date(iso).toLocaleDateString('en-IE', { timeZone: 'UTC' });
const principleTwo = { id: 'p-2', number: 2, title: 'Behaving with integrity', description: '', sortOrder: 2 };
const principleFive = { id: 'p-5', number: 5, title: 'Working effectively', description: '', sortOrder: 5 };

function standard(id: string, code: string, principle: typeof principleTwo, sortOrder: number, isCore = true) {
  return { id, principleId: principle.id, principle, code, title: `Standard ${code}`, isCore, isAdditional: !isCore, sortOrder };
}

const STANDARDS = [
  standard('s-2-1', '2.1', principleTwo, 1),
  standard('s-2-3', '2.3', principleTwo, 3),
  standard('s-5-6', '5.6', principleFive, 6),
  standard('s-5-7', '5.7', principleFive, 7),
];

const NARRATIVE_EDITED = new Date('2026-09-01T10:00:00.000Z');

function record(standardId: string, actionTaken: string) {
  return {
    id: `rec-${standardId}`, organisationId: 'org-1', standardId, reportingYear: 2026,
    status: 'WORKING_TOWARDS', actionTaken, evidence: 'Adopted code of conduct.',
    notes: null, explanationIfNA: null, revision: 3, updatedById: 'user-1',
    createdAt: new Date('2026-08-01T09:00:00.000Z'), updatedAt: NARRATIVE_EDITED,
  };
}

const RECORDS = [
  record('s-2-1', 'Values agreed.'),
  record('s-2-3', 'Code of conduct adopted; no trustee has signed yet. Target: 3 September 2026'),
  record('s-5-6', 'Induction pack drafted. Target: 2026-12-01'),
  record('s-5-7', 'Trustees briefed on their role.'),
];

type Doc = {
  id: string; organisationId: string; name: string; description: string | null; category: string;
  lifecycleStatus: string; deletedAt: Date | null; createdAt: Date; approvedDate: Date | null;
};

const PERSONAL_DESCRIPTION = 'Signed by Aoife Example of 12 Main Street, Ennis';

function doc(id: string, name: string, lifecycleStatus: string, extra: Partial<Doc> = {}): Doc {
  return {
    id, organisationId: 'org-1', name, description: PERSONAL_DESCRIPTION, category: 'CODE_OF_CONDUCT',
    lifecycleStatus, deletedAt: null, createdAt: new Date('2026-10-14T09:00:00.000Z'),
    approvedDate: new Date('2026-10-11T00:00:00.000Z'), ...extra,
  };
}

const DOCS: Doc[] = [
  doc('d-signed-a', 'Code of Conduct, Trustee Declaration (signed) A', 'CURRENT'),
  doc('d-signed-b', 'Code of Conduct, Trustee Declaration (signed) B', 'CURRENT'),
  doc('d-superseded', 'Code of Conduct 2024 (SUPERSEDED-MARKER)', 'SUPERSEDED'),
  doc('d-draft', 'Induction pack (DRAFT-MARKER)', 'DRAFT'),
  doc('d-retired', 'Old declaration (RETIRED-MARKER)', 'RETIRED'),
  doc('d-historical', 'Historical declaration (HISTORICAL-MARKER)', 'HISTORICAL'),
  doc('d-unreviewed', 'Legacy declaration (UNREVIEWED-MARKER)', 'UNREVIEWED'),
  doc('d-removed', 'Removed declaration (REMOVED-MARKER)', 'CURRENT', { deletedAt: new Date('2026-10-12T00:00:00.000Z') }),
  doc('d-other-org', 'Another charity (OTHER-ORG-MARKER)', 'CURRENT', { organisationId: 'org-2' }),
  doc('d-additional', 'Additional standard evidence (ADDITIONAL-MARKER)', 'CURRENT'),
  doc('d-escaped', 'Board <script>alert(1)</script> & "pack"', 'CURRENT', { category: 'BOARD_MINUTES', approvedDate: null }),
];

const LINKS: Array<{ documentId: string; standardId: string }> = [
  ...['s-2-1', 's-2-3', 's-5-6', 's-5-7'].flatMap((standardId) => [
    { documentId: 'd-signed-a', standardId },
    { documentId: 'd-signed-b', standardId },
  ]),
  { documentId: 'd-superseded', standardId: 's-2-3' },
  { documentId: 'd-draft', standardId: 's-5-6' },
  { documentId: 'd-retired', standardId: 's-2-3' },
  { documentId: 'd-historical', standardId: 's-2-3' },
  { documentId: 'd-unreviewed', standardId: 's-2-3' },
  { documentId: 'd-removed', standardId: 's-2-3' },
  { documentId: 'd-other-org', standardId: 's-2-3' },
  { documentId: 'd-additional', standardId: 's-additional' },
  { documentId: 'd-escaped', standardId: 's-2-1' },
];

const LINKED_AT = new Date('2026-10-14T10:00:00.000Z');
const AUDITS = [
  ...LINKS.map((link) => ({ organisationId: 'org-1', documentId: link.documentId, kind: 'STANDARD_LINK', next: link.standardId, occurredAt: LINKED_AT })),
  // An older link of the same pair: the newest row is the live link's time.
  { organisationId: 'org-1', documentId: 'd-signed-a', kind: 'STANDARD_LINK', next: 's-2-3', occurredAt: new Date('2026-01-01T00:00:00.000Z') },
  // Escaped evidence was linked before the narrative was written: no warning.
  { organisationId: 'org-1', documentId: 'd-escaped', kind: 'STANDARD_LINK', next: 's-2-1', occurredAt: new Date('2026-08-15T00:00:00.000Z') },
].filter((audit) => !(audit.documentId === 'd-escaped' && audit.occurredAt === LINKED_AT));

const TRUSTEES = [
  {
    id: 'b-1', organisationId: 'org-1', name: 'Aoife Example', role: 'Chair', isActive: true,
    conductSigned: true, conductSignedDate: new Date('2026-10-11T00:00:00.000Z'),
    inductionCompleted: true, inductionDate: new Date('2026-02-01T00:00:00.000Z'),
    email: 'aoife.private@example.ie', dateOfBirth: new Date('1970-02-03T00:00:00.000Z'),
    residentialAddress: '12 Main Street, Ennis', otherDirectorships: 'Example Holdings DAC', formerNames: 'Aoife Former',
  },
  {
    id: 'b-2', organisationId: 'org-1', name: 'Brian Example', role: 'Treasurer', isActive: true,
    conductSigned: true, conductSignedDate: new Date('2026-10-11T00:00:00.000Z'),
    inductionCompleted: false, inductionDate: null,
    email: 'brian.private@example.ie', dateOfBirth: new Date('1965-07-08T00:00:00.000Z'),
    residentialAddress: '4 Quay Road, Galway', otherDirectorships: 'Quay Ventures CLG', formerNames: null,
  },
  {
    id: 'b-3', organisationId: 'org-1', name: 'Former TrusteeMarker', role: 'Secretary', isActive: false,
    conductSigned: true, conductSignedDate: new Date('2025-01-01T00:00:00.000Z'),
    inductionCompleted: true, inductionDate: new Date('2025-01-01T00:00:00.000Z'),
    email: null, dateOfBirth: null, residentialAddress: null, otherDirectorships: null, formerNames: null,
  },
];

const PERSONAL_PARTICULARS = [
  'aoife.private@example.ie', 'brian.private@example.ie', '1970', '1965', '03/02/1970', '08/07/1965',
  '12 Main Street', 'Ennis', '4 Quay Road', 'Galway', 'Example Holdings', 'Quay Ventures', 'Aoife Former',
  PERSONAL_DESCRIPTION, 'Former TrusteeMarker',
];

type Calls = { links: unknown[]; trustees: unknown[]; audits: unknown[] };

/**
 * A fake that applies the filters a link query can carry, so a document that
 * is not CURRENT, removed, another charity's, or outside the plan's standards
 * is excluded only if the service asked for it to be. It deliberately returns
 * the WHOLE document, description included, and the WHOLE trustee row, so
 * the report is proven not to print what the query happened to bring back.
 */
function buildPrisma(options: {
  plan?: 'ESSENTIALS' | 'COMPLETE';
  complexity?: 'SIMPLE' | 'COMPLEX';
  links?: typeof LINKS;
  audits?: typeof AUDITS;
  trustees?: typeof TRUSTEES;
  records?: typeof RECORDS;
  standards?: typeof STANDARDS;
  organisation?: Record<string, unknown>;
} = {}) {
  const calls: Calls = { links: [], trustees: [], audits: [] };
  const standards = options.standards ?? STANDARDS;
  const allStandards = [...standards, standard('s-additional', '9.9', principleFive, 9, false)];
  const docsById = new Map(DOCS.map((d) => [d.id, d]));
  const prisma = {
    organisation: { findUniqueOrThrow: async () => options.organisation ?? ({
      id: 'org-1', name: 'Example Charity', rcnNumber: '20012345',
      complexity: options.complexity ?? 'SIMPLE',
      conditionalObligationProfile: fx.retainedOrganisation.conditionalObligationProfile,
    }) },
    subscription: { findUnique: async () => ({ plan: options.plan ?? 'ESSENTIALS' }) },
    governanceStandard: { findMany: async () => standards },
    complianceRecord: { findMany: async () => options.records ?? RECORDS },
    documentStandardLink: {
      findMany: async (args: { where: { standard?: { isCore?: boolean }; document?: Partial<Doc> } }) => {
        calls.links.push(args);
        const where = args.where;
        return (options.links ?? LINKS).flatMap((link) => {
          const document = docsById.get(link.documentId)!;
          const linkedStandard = allStandards.find((s) => s.id === link.standardId)!;
          if (where.standard?.isCore !== undefined && linkedStandard.isCore !== where.standard.isCore) return [];
          if (where.document?.organisationId !== undefined && document.organisationId !== where.document.organisationId) return [];
          if (where.document && 'deletedAt' in where.document && where.document.deletedAt === null && document.deletedAt !== null) return [];
          if (where.document?.lifecycleStatus !== undefined && document.lifecycleStatus !== where.document.lifecycleStatus) return [];
          return [{ ...link, document }];
        });
      },
    },
    documentControlAudit: {
      findMany: async (args: { where: { organisationId: string; kind: string; documentId: { in: string[] } } }) => {
        calls.audits.push(args);
        return (options.audits ?? AUDITS).filter((audit) => audit.organisationId === args.where.organisationId
          && audit.kind === args.where.kind && args.where.documentId.in.includes(audit.documentId));
      },
    },
    boardMember: {
      findMany: async (args: { where: { organisationId: string; isActive?: boolean } }) => {
        calls.trustees.push(args);
        return (options.trustees ?? TRUSTEES).filter((t) => t.organisationId === args.where.organisationId
          && (args.where.isActive === undefined || t.isActive === args.where.isActive));
      },
    },
  };
  return { prisma, calls, service: new ComplianceService(prisma as never) };
}

// ---------------------------------------------------------------------------
// Item 3: narrative staleness, as a pure function
// ---------------------------------------------------------------------------

test('target dates are read in the forms trustees write, and anything else is left alone', () => {
  assert.deepEqual(targetDatesIn('Target: 3 September 2026'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('target:3rd Sept 2026 then TARGET: 2026-12-01'), ['2026-09-03', '2026-12-01']);
  assert.deepEqual(targetDatesIn('Target: 03/09/2026'), ['2026-09-03'], 'day first, as in Ireland');
  assert.deepEqual(targetDatesIn('Target: 31 February 2026'), [], 'an impossible date is not guessed at');
  assert.deepEqual(targetDatesIn('Target: next spring'), []);
  assert.deepEqual(targetDatesIn('Targeted: 3 September 2026'), [], 'only the word "Target" followed by a colon');
  assert.deepEqual(targetDatesIn(null), []);
});

// Live 4.1, 4.4 and 4.5 still spoke of the 3 September 2026 board meeting in
// words other than "Target:" and were not flagged (14 Oct 2026).
test('a date written as still to come is found whatever words introduce it', () => {
  for (const text of [
    'Policy to be approved at the board meeting on 3 September 2026.',
    'Will be tabled at the 3 September 2026 meeting.',
    'Awaiting the board meeting of 03/09/2026 to adopt the register.',
    'The board is to consider the revised policy on 3rd Sept. 2026.',
    'Review scheduled for 2026-09-03, with the policy circulated beforehand.',
    'Due by 3 September 2026',
    'Draft circulated. The next board meeting on 3 September 2026 will adopt it.',
    'Pending approval at the forthcoming meeting (3 September 2026).',
  ]) {
    assert.deepEqual(targetDatesIn(text), ['2026-09-03'], text);
  }
});

test('background editing dates do not replace deadlines in the current action', () => {
  assert.deepEqual(targetDatesIn(
    'Due 30 September 2026.\n--- BACKGROUND (moved out of the notes field on 31 August 2026 so the next step is readable) ---',
  ), ['2026-09-30']);
  assert.deepEqual(targetDatesIn('Notes edited on 31 August 2026 to explain the next step.'), []);
  assert.deepEqual(targetDatesIn('The next step was recorded on 31 August 2026.'), []);
  assert.deepEqual(targetDatesIn('Notes edited on 31 August 2026 and next review on 30 September 2026.'), ['2026-09-30']);
});

test('present-tense action instructions and compound approval requirements carry deadlines', () => {
  assert.deepEqual(targetDatesIn('Action: the Board minutes its decision on 3 September 2026 and brings forward a review in 2027.'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('The refreshed policy needs formal receipt and ratification by the Board on 3 September 2026.'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('The next review is on 3 September 2026.'), ['2026-09-03']);
});

test('next AGM and qualified future events remain deadlines without treating next step as one', () => {
  for (const event of ['AGM', 'EGM', 'annual review', 'annual general meeting', 'quarterly board meeting']) {
    assert.deepEqual(targetDatesIn(`The next ${event} is on 3 September 2026.`), ['2026-09-03'], event);
  }
  assert.deepEqual(targetDatesIn('Notes reorganised on 31 August 2026 so the next step in the review is readable.'), []);
});

test('separate completed and pending actions retain their own date context', () => {
  assert.deepEqual(targetDatesIn('Review carried out in March 2026 and ratification pending the board meeting on 3 September 2026.'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('Review recorded on 1 March 2026 and ratification pending the board meeting on 3 September 2026.'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('The policy needs formal receipt and formal ratification by the Board on 3 September 2026.'), ['2026-09-03']);
});

test('an Action label does not turn completed adoption into a future deadline', () => {
  assert.deepEqual(targetDatesIn('Action: The board adopted the policy on 3 March 2026.'), []);
  assert.deepEqual(targetDatesIn('Action: The board approved the policy on 3 March 2026.'), []);
  assert.deepEqual(targetDatesIn('Action: The policy was approved on 3 March 2026.'), []);
  assert.deepEqual(targetDatesIn('Action: The policy has already been approved on 3 March 2026.'), []);
  assert.deepEqual(targetDatesIn('Action: Policy to be approved on 3 September 2026.'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('Action: Circulate the approved policy at the board meeting on 3 September 2026.'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('Action: Bring the signed declarations to the board meeting on 3 September 2026.'), ['2026-09-03']);
});

test('a paired requirement shares its deadline through meeting prepositions and parentheses', () => {
  for (const ending of ['during the board meeting on', 'within the board meeting on', 'at the meeting on']) {
    assert.deepEqual(targetDatesIn(`The policy needs formal receipt and ratification ${ending} 3 September 2026.`), ['2026-09-03']);
  }
  assert.deepEqual(targetDatesIn('The policy needs formal receipt and ratification (3 September 2026).'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('The policy needs formal receipt and ratification was approved on 3 March 2026.'), []);
  assert.deepEqual(targetDatesIn('The revised policy needs formal receipt and ratification of the original policy was approved on 3 March 2026.'), []);
});

test('a later upcoming event does not turn an earlier editing date into a deadline', () => {
  assert.deepEqual(targetDatesIn('Notes edited on 31 August 2026 to explain the next AGM.'), []);
  assert.deepEqual(targetDatesIn('Notes edited on 31 August 2026 to explain the next AGM on 3 September 2026.'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('Draft recorded on 31 August 2026 for the policy to be approved on 3 September 2026.'), ['2026-09-03']);
});

test('future wording immediately after an event date still qualifies that event', () => {
  assert.deepEqual(targetDatesIn('The board meeting on 3 September 2026 will approve the policy.'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('The 3 September 2026 meeting will approve the policy.'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('The 3 September 2026 annual general meeting will approve the policy.'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('The board meeting on 3 September 2026 is awaiting confirmation.'), ['2026-09-03']);
  assert.deepEqual(targetDatesIn('Notes edited on 31 August 2026 will be kept for the next AGM.'), []);
});

test('a date describing something already done is not a stale promise', () => {
  for (const text of [
    'Adopted at the board meeting on 10 March 2026.',
    'Reviewed on 1 May 2026 and will be reviewed annually.',
    'The meeting scheduled for 3 September 2026 was held and minuted.',
    'Signed on 11 October 2026; next review in 2027.',
    'Approved by the board on 3 March 2026.',
    'Code adopted 21 March 2026, and the trustees will keep it under review.',
  ]) {
    assert.deepEqual(targetDatesIn(text), [], text);
  }
});

test('a meeting-date narrative now in the past is a TARGET_DATE_PASSED warning', () => {
  const warnings = narrativeWarnings({
    standards: [{ id: 's-41', code: '4.1' }],
    records: new Map([['s-41', { actionTaken: 'Register to be approved at the board meeting on 3 September 2026.', updatedAt: NARRATIVE_EDITED }]]),
    links: [],
    now: NOW,
  });
  assert.deepEqual(warnings.map((w) => w.kind === 'TARGET_DATE_PASSED' && `${w.standardCode} ${w.targetDate}`), ['4.1 2026-09-03']);
});

test('a target is a calendar day in Ireland: due today is not yet past', () => {
  const standards = [{ id: 's', code: '2.3' }];
  const records = new Map([['s', { actionTaken: 'Target: 14 October 2026', updatedAt: NARRATIVE_EDITED }]]);
  // 23:30 UTC on the 13th is already the 14th in Dublin (IST, UTC+1).
  assert.equal(irishToday(new Date('2026-10-13T23:30:00.000Z')), '2026-10-14');
  assert.deepEqual(narrativeWarnings({ standards, records, links: [], now: new Date('2026-10-14T22:00:00.000Z') }), []);
  assert.equal(narrativeWarnings({ standards, records, links: [], now: new Date('2026-10-15T00:30:00.000Z') }).length, 1);
});

test('only a link made AFTER the narrative was last edited is a warning', () => {
  const standards = [{ id: 's', code: '2.3' }];
  const records = new Map([['s', { actionTaken: 'Done.', updatedAt: NARRATIVE_EDITED }]]);
  const before = { standardId: 's', documentId: 'd-old', linkedAt: new Date('2026-08-01T00:00:00.000Z') };
  const same = { standardId: 's', documentId: 'd-same', linkedAt: NARRATIVE_EDITED };
  const after = { standardId: 's', documentId: 'd-new', linkedAt: LINKED_AT };
  const warnings = narrativeWarnings({ standards, records, links: [before, same, after], now: NOW });
  assert.deepEqual(warnings, [{
    kind: 'EVIDENCE_LINKED_AFTER_NARRATIVE', standardId: 's', standardCode: '2.3',
    recordUpdatedAt: NARRATIVE_EDITED.toISOString(), documentId: 'd-new', linkedAt: LINKED_AT.toISOString(),
  }]);
});

test('a standard with no record has no narrative to be stale', () => {
  assert.deepEqual(narrativeWarnings({
    standards: [{ id: 's', code: '2.3' }], records: new Map(),
    links: [{ standardId: 's', documentId: 'd', linkedAt: LINKED_AT }], now: NOW,
  }), []);
});

// ---------------------------------------------------------------------------
// Item 3: the readiness check warns, never blocks, and never touches the hash
// ---------------------------------------------------------------------------

test('approval readiness warns about the live incident: target passed and declarations linked since', async () => {
  const { service } = buildPrisma();
  const readiness = await service.getApprovalReadiness('org-1', 2026, NOW);

  const forTwoThree = readiness.narrativeWarnings.filter((w) => w.standardCode === '2.3');
  assert.deepEqual(forTwoThree.map((w) => w.kind === 'TARGET_DATE_PASSED' ? `target ${w.targetDate}` : `linked ${w.documentId}`), [
    'linked d-signed-a',
    'linked d-signed-b',
    'target 2026-09-03',
  ]);
  const linkedA = forTwoThree.find((w) => w.kind === 'EVIDENCE_LINKED_AFTER_NARRATIVE' && w.documentId === 'd-signed-a');
  assert.equal(linkedA?.kind === 'EVIDENCE_LINKED_AFTER_NARRATIVE' && linkedA.linkedAt, LINKED_AT.toISOString(),
    'the newest link audit row is the live link time');

  const mentioned = new Set(readiness.narrativeWarnings.flatMap((w) => w.kind === 'EVIDENCE_LINKED_AFTER_NARRATIVE' ? [w.documentId] : []));
  for (const excluded of ['d-superseded', 'd-draft', 'd-retired', 'd-historical', 'd-unreviewed', 'd-removed', 'd-other-org', 'd-additional', 'd-escaped']) {
    assert.ok(!mentioned.has(excluded), `${excluded} must not trigger a warning`);
  }
  assert.ok(!readiness.narrativeWarnings.some((w) => w.kind === 'TARGET_DATE_PASSED' && w.standardCode === '5.6'),
    'a target still in the future is not a warning');
  // A warning, not a blocker: these records are otherwise complete.
  assert.equal(readiness.ready, true);
});

test('linking evidence, trustee declarations and the calendar never change the evidence hash', async () => {
  const quiet = await buildPrisma({ links: [], audits: [], trustees: [] }).service.getApprovalReadiness('org-1', 2026, new Date('2026-08-01T12:00:00.000Z'));
  const busy = await buildPrisma().service.getApprovalReadiness('org-1', 2026, NOW);

  assert.equal(quiet.narrativeWarnings.length, 0);
  assert.ok(busy.narrativeWarnings.length > 0, 'the busy case really did compute warnings');
  assert.equal(busy.evidenceHash, quiet.evidenceHash);
});

test('a link with no audit row predates link auditing and is not claimed to be newer than the narrative', async () => {
  const { service } = buildPrisma({ audits: [] });
  const readiness = await service.getApprovalReadiness('org-1', 2026, NOW);
  assert.ok(!readiness.narrativeWarnings.some((w) => w.kind === 'EVIDENCE_LINKED_AFTER_NARRATIVE'));
});

// ---------------------------------------------------------------------------
// Items 1 and 2: what the report reads
// ---------------------------------------------------------------------------

test('linked evidence is read only for CURRENT, unremoved documents of this charity, within the plan scope', async () => {
  for (const [plan, complexity, scoped] of [
    ['ESSENTIALS', 'SIMPLE', true], ['ESSENTIALS', 'COMPLEX', true], ['COMPLETE', 'SIMPLE', true], ['COMPLETE', 'COMPLEX', false],
  ] as const) {
    const { service, calls } = buildPrisma({ plan, complexity });
    await service.getReportEvidence('org-1');
    assert.deepEqual(calls.links[0], {
      where: {
        ...(scoped ? { standard: { isCore: true } } : {}),
        document: { organisationId: 'org-1', deletedAt: null, lifecycleStatus: 'CURRENT' },
      },
      select: {
        documentId: true,
        standardId: true,
        document: { select: { name: true, category: true, approvedDate: true, createdAt: true } },
      },
    }, `${plan}/${complexity}`);
  }
});

test('trustee declarations read active trustees by name and declaration dates only', async () => {
  const { service, calls } = buildPrisma();
  await service.getReportEvidence('org-1');
  assert.deepEqual(calls.trustees[0], {
    where: { organisationId: 'org-1', isActive: true },
    select: { name: true, conductSigned: true, conductSignedDate: true, inductionCompleted: true, inductionDate: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
});

test('an additional-standard link is shown only to a complex organisation on the Complete plan', async () => {
  const essentials = await buildPrisma().service.getReportEvidence('org-1');
  assert.equal(essentials.documentsByStandard.has('s-additional'), false);
  const complete = await buildPrisma({ plan: 'COMPLETE', complexity: 'COMPLEX' }).service.getReportEvidence('org-1');
  assert.deepEqual(complete.documentsByStandard.get('s-additional')?.map((d) => d.documentId), ['d-additional']);
});

// ---------------------------------------------------------------------------
// Items 1, 2 and 3: what the report shows
// ---------------------------------------------------------------------------

async function renderReport() {
  const { service } = buildPrisma();
  const readiness = await service.getApprovalReadiness('org-1', 2026, NOW);
  const evidence = await service.getReportEvidence('org-1');
  const html = buildComplianceReportHtml(
    { name: 'Example Charity', rcnNumber: '20012345' },
    [
      { number: 2, title: principleTwo.title, standards: STANDARDS.slice(0, 2) },
      { number: 5, title: principleFive.title, standards: STANDARDS.slice(2) },
    ],
    new Map(RECORDS.map((r) => [r.standardId, r])),
    { status: 'DRAFT', boardMeetingDate: null, minuteReference: null, approvedByName: null, approvedByRole: null, approvalNotes: null, approvedAt: null },
    readiness,
    null,
    2026,
    evidence,
  );
  return { html, readiness };
}

function rowFor(html: string, code: string): string {
  const row = html.split('<tr>').find((chunk) => chunk.includes(`<strong>${code}</strong>`));
  assert.ok(row, `a row for standard ${code}`);
  return row;
}

test('the 2.3 row lists the two signed declarations, with date and category', async () => {
  const { html } = await renderReport();
  const row = rowFor(html, '2.3');
  assert.match(row, /Code of Conduct, Trustee Declaration \(signed\) A/);
  assert.match(row, /Code of Conduct, Trustee Declaration \(signed\) B/);
  assert.equal(row.match(/<li>/g)?.length, 2, 'exactly two linked documents');
  assert.match(row, /Code of conduct, 11\/10\/2026/, 'approval date preferred over upload date');
  assert.match(row, /See Trustee declarations appendix/);
});

test('a SUPERSEDED, DRAFT, RETIRED, HISTORICAL, UNREVIEWED, removed or foreign document never appears in the report', async () => {
  const { html } = await renderReport();
  for (const marker of ['SUPERSEDED-MARKER', 'DRAFT-MARKER', 'RETIRED-MARKER', 'HISTORICAL-MARKER', 'UNREVIEWED-MARKER', 'REMOVED-MARKER', 'OTHER-ORG-MARKER', 'ADDITIONAL-MARKER']) {
    assert.ok(!html.includes(marker), `${marker} must not appear`);
  }
});

test('linked document names are escaped, and upload date stands in when there is no approval date', async () => {
  const { html } = await renderReport();
  const row = rowFor(html, '2.1');
  assert.ok(!html.includes('<script>'));
  assert.match(row, /Board &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;pack&quot;/);
  assert.match(row, /Board minutes, 14\/10\/2026/);
});

test('the trustee table shows two code-of-conduct signatures dated 11 October 2026, and no former trustee', async () => {
  const { html } = await renderReport();
  const appendix = html.slice(html.indexOf('Trustee declarations (generated-time appendix)'));
  assert.ok(appendix.length > 0);
  const table = appendix.slice(0, appendix.indexOf('</table>'));
  const signed = `Yes, ${shown('2026-10-11')}`;
  assert.ok(table.includes(`<td>Aoife Example</td><td>${signed}</td><td>Yes, ${shown('2026-02-01')}</td>`), table);
  assert.ok(table.includes(`<td>Brian Example</td><td>${signed}</td><td>No</td>`), table);
  assert.equal(table.split(signed).length - 1, 2, 'exactly two code-of-conduct signatures');
  assert.ok(!table.includes('Former TrusteeMarker'));
});

test('no personal particulars and no document description appear anywhere in the report', async () => {
  const { html } = await renderReport();
  for (const particular of PERSONAL_PARTICULARS) {
    assert.ok(!html.includes(particular), `must not contain: ${particular}`);
  }
});

test('the report header warns that the 2.3 narrative is older than its evidence, before any standard', async () => {
  const { html } = await renderReport();
  const warning = html.indexOf('Narrative may be out of date');
  assert.ok(warning > 0);
  assert.ok(warning < html.indexOf('<h2>Principle 2'), 'in the header, ahead of the standards');
  const section = html.slice(warning, html.indexOf('</section>', warning));
  // Grouped: one line per standard and kind, never one per document.
  const expected = [
    ['2.1', '2 documents linked since this record was last edited (latest 14 Oct 2026)'],
    ['2.3', '2 documents linked since this record was last edited (latest 14 Oct 2026)'],
    ['2.3', `Target date ${narrativeWarningDate('2026-09-03')} has passed`],
    ['5.6', '2 documents linked since this record was last edited (latest 14 Oct 2026)'],
    ['5.7', '2 documents linked since this record was last edited (latest 14 Oct 2026)'],
  ];
  let from = 0;
  for (const [code, message] of expected) {
    const at = section.indexOf(`<tr><td>${code}</td><td>${message}</td>`, from);
    assert.ok(at >= from, `in order: ${code} — ${message}\n${section}`);
    from = at + 1;
  }
  assert.equal(section.split('<tr><td>').length - 1, expected.length, 'no per-document rows');
  assert.match(html, /outside the hashed board-approved/);
});

test('the owner\'s ruling is printed beside the linked-documents column', async () => {
  const { html } = await renderReport();
  const header = html.slice(html.indexOf('<th>Linked documents'), html.indexOf('</th>', html.indexOf('<th>Linked documents')));
  assert.ok(header.includes('The board approves the narrative; the document list is supporting evidence.'), header);
});

test('a report built without generated-time evidence is unchanged in shape', () => {
  const html = buildComplianceReportHtml(
    { name: 'Example Charity', rcnNumber: null },
    [{ number: 2, title: principleTwo.title, standards: STANDARDS.slice(0, 1) }],
    new Map(),
    { status: 'DRAFT', boardMeetingDate: null, minuteReference: null, approvedByName: null, approvedByRole: null, approvalNotes: null, approvedAt: null },
    { ready: true, missingRecords: [], missingEvidence: [], missingExplanations: [], profileIssues: [], conditionalReviewItems: [], matrixReviewItems: [], matrixLastChecked: IRISH_COMPLIANCE_MATRIX_LAST_CHECKED },
    null,
    2026,
  );
  assert.ok(!html.includes('Trustee declarations'));
  assert.ok(!html.includes('Narrative may be out of date'));
  assert.ok(!html.includes('See Trustee declarations appendix'));
});

// ---------------------------------------------------------------------------
// Item 4: an approval retained before this change still validates after it
// ---------------------------------------------------------------------------

const retainedStored = {
  id: 'snap-retained', organisationId: fx.retainedOrganisation.id, reportingYear: 2026, approvalSequence: 1,
  formatVersion: 1, evidenceHash: fx.RETAINED_EVIDENCE_HASH, snapshotHash: fx.RETAINED_SNAPSHOT_HASH,
  payload: fx.retainedStoredPayload, approvedAt: fx.retainedApproval.approvedAt,
  createdById: 'user-retained', createdByName: 'Recording User',
};

test('a retained pre-change snapshot still verifies, byte for byte', () => {
  const payload = parseAndVerifyStoredComplianceSnapshot(retainedStored);
  assert.equal(hashComplianceSnapshot(fx.retainedStoredPayload), fx.RETAINED_SNAPSHOT_HASH);
  assert.equal(hashComplianceSnapshot(payload.evidence), fx.RETAINED_EVIDENCE_HASH);
  assert.equal(payload.formatVersion, 1, 'no format change was needed, so none was made');
});

test('the approved-snapshot export renders the retained approval without any generated-time section', () => {
  const payload = parseAndVerifyStoredComplianceSnapshot(retainedStored);
  const html = buildApprovedComplianceReportHtml(payload, {
    snapshotId: retainedStored.id, evidenceHash: retainedStored.evidenceHash, snapshotHash: retainedStored.snapshotHash,
  });
  assert.ok(html.includes(fx.RETAINED_EVIDENCE_HASH));
  assert.ok(html.includes(fx.RETAINED_SNAPSHOT_HASH));
  assert.ok(html.includes('no trustee has signed yet. Target: 3 September 2026'), 'the approved text, exactly as approved');
  for (const absent of ['Linked documents', 'Trustee declarations', 'Narrative may be out of date']) {
    assert.ok(!html.includes(absent), `${absent} belongs only in the generated-time report`);
  }
});

function retainedPrisma(withLaterEvents: boolean) {
  const base = buildPrisma({
    organisation: fx.retainedOrganisation,
    standards: fx.retainedStandards as typeof STANDARDS,
    records: fx.retainedRecords as typeof RECORDS,
    // Everything that happened after the approval: declarations signed,
    // uploaded and linked; the target date passing.
    links: withLaterEvents ? [{ documentId: 'd-signed-a', standardId: 's-2-3' }, { documentId: 'd-signed-b', standardId: 's-2-3' }] : [],
    audits: withLaterEvents ? AUDITS.map((a) => ({ ...a, organisationId: fx.retainedOrganisation.id })) : [],
    trustees: withLaterEvents ? TRUSTEES.map((t) => ({ ...t, organisationId: fx.retainedOrganisation.id })) : [],
  });
  // The fake filters by organisation; the retained charity owns these documents.
  for (const d of DOCS) if (d.id === 'd-signed-a' || d.id === 'd-signed-b') d.organisationId = fx.retainedOrganisation.id;
  return base;
}

test('the live evidence hash for unchanged records still equals the retained approval hash, after later events', async (t) => {
  try {
    const { service, prisma } = retainedPrisma(true);
    const readiness = await service.getApprovalReadiness(fx.retainedOrganisation.id, 2026, NOW);
    assert.ok(readiness.narrativeWarnings.length >= 3, 'the later events were seen: two links and a passed target');

    const quiet = await retainedPrisma(false).service.getApprovalReadiness(fx.retainedOrganisation.id, 2026, NOW);
    assert.equal(readiness.evidenceHash, quiet.evidenceHash);

    if (IRISH_COMPLIANCE_MATRIX_LAST_CHECKED !== fx.RETAINED_MATRIX_LAST_CHECKED_AT_CAPTURE) {
      // A later matrix revision legitimately changes current evidence; the
      // retained snapshot itself is still verified by the tests above.
      t.diagnostic('compliance matrix revised since capture; frozen-hash comparison skipped');
      return;
    }
    assert.equal(readiness.evidenceHash, fx.RETAINED_EVIDENCE_HASH,
      'a retained approval has stopped matching its unchanged records: approvals would read as withdrawn');

    // And the sign-off screen still calls that approval current, judged
    // against the hash frozen in the stored snapshot, not the live one.
    Object.assign(prisma, {
      complianceSignoff: { findUnique: async () => ({
        id: 'signoff-retained', organisationId: fx.retainedOrganisation.id, reportingYear: 2026, status: 'APPROVED',
        boardMeetingDate: new Date('2026-09-02T00:00:00.000Z'), minuteReference: 'BM-2026-09',
        approvedByName: 'Chairperson', approvedByRole: 'Chair', approvalNotes: null,
        approvedAt: new Date(fx.retainedApproval.approvedAt), revision: 2, approvalSequence: 1,
        currentApprovalSnapshotId: retainedStored.id,
        currentApprovalSnapshot: { ...retainedStored, approvedAt: new Date(retainedStored.approvedAt) },
        invalidatedAt: null, invalidationReason: null, invalidatedById: null, updatedById: 'user-retained',
        createdAt: new Date('2026-09-02T19:30:00.000Z'), updatedAt: new Date('2026-09-02T19:30:00.000Z'),
      }) },
      complianceApprovalSnapshot: { findFirst: async () => null },
    });
    const signoff = await service.getSignoff(fx.retainedOrganisation.id, 2026);
    assert.equal(signoff.approvalCurrent, true);
  } finally {
    for (const d of DOCS) if (d.id === 'd-signed-a' || d.id === 'd-signed-b') d.organisationId = 'org-1';
  }
});
