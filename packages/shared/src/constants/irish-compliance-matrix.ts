import type { ConditionalObligationProfile } from '../types/api.js';

export type CommencementStatus = 'in_force' | 'not_commenced' | 'conditional' | 'guidance';

export type ProfessionalReviewFlag =
  | 'solicitor'
  | 'accountant'
  | 'data_protection'
  | 'employment'
  | 'equality'
  | 'health_and_safety'
  | 'safeguarding'
  | 'protected_disclosures'
  | 'governance_expert';

export interface ComplianceSourceRef {
  name: string;
  owner: string;
  url: string;
  lastChecked: string;
  note: string;
}

export interface IrishComplianceMatrixEntry {
  id: string;
  sourceRefs: ComplianceSourceRef[];
  /**
   * Describes the matrix prompt or obligation bundle. It is not a legal conclusion
   * that every cited source or specialist obligation applies to every charity.
   */
  commencementStatus: CommencementStatus;
  applicabilityNote: string;
  principleNumbers: number[];
  standardCodes: string[];
  featureArea:
    | 'onboarding'
    | 'organisation'
    | 'compliance'
    | 'documents'
    | 'board'
    | 'deadlines'
    | 'registers'
    | 'regulator'
    | 'export'
    | 'team'
    | 'billing';
  userTask: string;
  evidenceRequired: string[];
  boardApproval: 'required' | 'recommended' | 'conditional' | 'not_applicable';
  professionalReview: ProfessionalReviewFlag[];
  copyTone: string;
  testExpectation: string;
}

export interface ConditionalObligationReviewRule {
  profileKey: keyof ConditionalObligationProfile;
  label: string;
  recommendedAction: string;
  standardCodes: string[];
}

export const IRISH_COMPLIANCE_MATRIX_LAST_CHECKED = '2026-07-05';

export const CONDITIONAL_OBLIGATION_REVIEW_RULES: ConditionalObligationReviewRule[] = [
  {
    profileKey: 'hasPaidStaff',
    label: 'Employment obligations',
    recommendedAction:
      'Review employment, equality, payroll, protected-disclosure and role-delegation evidence with the appropriate professional advisers.',
    standardCodes: ['3.4', '3.5', '3.6', '4.2'],
  },
  {
    profileKey: 'hasVolunteers',
    label: 'Volunteer role and supervision evidence',
    recommendedAction:
      'Keep role descriptions, onboarding, supervision and policy ownership records proportionate to the volunteer activity.',
    standardCodes: ['3.1', '3.2', '3.3'],
  },
  {
    profileKey: 'raisesFundsFromPublic',
    label: 'Public fundraising controls',
    recommendedAction:
      'Review fundraising controls, third-party fundraiser arrangements, complaints handling and board oversight records.',
    standardCodes: ['4.3', '6.4'],
  },
  {
    profileKey: 'worksWithChildrenOrVulnerableAdults',
    label: 'Safeguarding review',
    recommendedAction:
      'Confirm whether safeguarding statements, vetting, incident escalation and specialist board-review records are required.',
    standardCodes: ['4.2', '4.5'],
  },
  {
    profileKey: 'processesPersonalData',
    label: 'Data protection accountability',
    recommendedAction:
      'Review privacy, retention, processor, access-control and breach-response evidence under data-protection obligations.',
    standardCodes: ['4.2', '6.1'],
  },
  {
    profileKey: 'operatesPremisesOrEvents',
    label: 'Premises, events and safety controls',
    recommendedAction:
      'Review insurance, risk assessment, safety-statement and incident/escalation records for premises or events.',
    standardCodes: ['4.2', '4.4', '4.5'],
  },
  {
    profileKey: 'isPublicSectorBody',
    label: 'Public-sector context review',
    recommendedAction:
      'Review public-sector, protected-disclosure, publication and stakeholder-accountability obligations before relying on generic workflows.',
    standardCodes: ['4.2', '6.1', '6.2'],
  },
  {
    profileKey: 'usesDataProcessors',
    label: 'Data processor review',
    recommendedAction:
      'Review processor due diligence, contracts, storage locations, access controls and retention evidence with data-protection advice where needed.',
    standardCodes: ['4.2', '6.1'],
  },
];

const sourceRef = (
  name: string,
  owner: string,
  url: string,
  note: string,
): ComplianceSourceRef => ({
  name,
  owner,
  url,
  lastChecked: IRISH_COMPLIANCE_MATRIX_LAST_CHECKED,
  note,
});

const governanceCodeSource = sourceRef(
  'Charities Governance Code',
  'Charities Regulator',
  'https://www.charitiesregulator.ie/media/fpbnz5xz/charities-governance-code.pdf',
  'Canonical six-principle Governance Code and standards catalogue.',
);

const complianceRecordFormSource = sourceRef(
  'Charities Governance Code Compliance Record Form',
  'Charities Regulator',
  'https://www.charitiesregulator.ie/en/guidance/forms-and-templates/forms',
  'Official annual record form used to document actions and evidence.',
);

const charitiesActSource = sourceRef(
  'Charities Act 2009 Revised',
  'Law Reform Commission',
  'https://revisedacts.lawreform.ie/eli/2009/act/6/revised/en/pdf?annotations=false',
  'Administrative consolidation of current Charities Act 2009 text.',
);

const charitiesAmendmentAct2024Source = sourceRef(
  'Charities (Amendment) Act 2024 commencement and effects',
  'Irish Statute Book',
  'https://www.irishstatutebook.ie/eli/isbc/2024_21.html',
  'Commencement and legislative-effects table for 2024 charity amendments.',
);

const annualReportingSource = sourceRef(
  'Annual report - how to submit',
  'Charities Regulator',
  'https://www.charitiesregulator.ie/en/information-for-charities/annual-report-how-to-submit',
  'Regulator guidance on annual report submission through MyAccount.',
);

const financialControlsSource = sourceRef(
  'Internal financial controls guidelines for charities',
  'Charities Regulator',
  'https://www.charitiesregulator.ie/en/guidance/financial-guidance',
  'Regulator financial-control guidance and editable checklist resources.',
);

const fundraisingSource = sourceRef(
  'Guidelines for Charitable Organisations on Fundraising from the Public',
  'Charities Regulator',
  'https://www.charitiesregulator.ie/en/guidance/managing-a-charity/general',
  'Regulator fundraising guidance for charities raising funds from the public.',
);

const conflictSource = sourceRef(
  'Managing Conflicts of Interest',
  'Charities Regulator',
  'https://www.charitiesregulator.ie/en/guidance/managing-a-charity/general',
  'Regulator guidance on identifying and managing charity conflicts.',
);

const dataProtectionSource = sourceRef(
  'For Organisations',
  'Data Protection Commission',
  'https://www.dataprotection.ie/en/organisations',
  'Organisational obligations under data protection law and GDPR.',
);

const healthAndSafetySource = sourceRef(
  'Safety Statement and Risk Assessment',
  'Health and Safety Authority',
  'https://www.hsa.ie/topics/managing_health_and_safety/safety_statement_and_risk_assessment/',
  'Employer risk-assessment and safety-statement guidance.',
);

const safeguardingSource = sourceRef(
  'Guidance on Developing a Child Safeguarding Statement',
  'Tusla',
  'https://www.tusla.ie/uploads/content/4214-TUSLA_Guidance_on_Developing_a_CSS_LR.PDF',
  'Guidance for organisations required to prepare child safeguarding statements.',
);

const protectedDisclosuresSource = sourceRef(
  'Protected Disclosures',
  'Charities Regulator',
  'https://www.charitiesregulator.ie/en/information-for-the-public/protected-disclosures',
  'Protected disclosure route and workplace-reporting context.',
);

const employmentSource = sourceRef(
  'Information Guides and Booklets',
  'Workplace Relations Commission',
  'https://www.workplacerelations.ie/en/publications_forms/guides_booklets/',
  'Employment, labour and equality law guides for employers.',
);

const equalitySource = sourceRef(
  'Your Rights',
  'Irish Human Rights and Equality Commission',
  'https://www.ihrec.ie/your-rights',
  'Public guidance on equality and human-rights law in Ireland.',
);

export const IRISH_COMPLIANCE_MATRIX: IrishComplianceMatrixEntry[] = [
  {
    id: 'purpose-planning-and-public-benefit',
    sourceRefs: [governanceCodeSource, complianceRecordFormSource, charitiesActSource],
    commencementStatus: 'guidance',
    applicabilityNote:
      'Applies as a Governance Code planning prompt for every charity; legal-form and public-benefit conclusions require trustee and professional review where needed.',
    principleNumbers: [1],
    standardCodes: ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8'],
    featureArea: 'organisation',
    userTask: 'Record the charity purpose, public-benefit rationale, resources, plans and periodic purpose reviews.',
    evidenceRequired: [
      'Governing document purpose clause',
      'Annual or strategic plan',
      'Board minutes approving or reviewing plans',
      'Public-benefit and resource review notes',
    ],
    boardApproval: 'recommended',
    professionalReview: ['governance_expert'],
    copyTone: 'Frame as trustee-led planning evidence, not a legal conclusion about charitable status.',
    testExpectation: 'All Principle 1 standards are discoverable from the matrix with Code and Compliance Record citations.',
  },
  {
    id: 'values-conflicts-and-conduct',
    sourceRefs: [governanceCodeSource, complianceRecordFormSource, conflictSource],
    commencementStatus: 'guidance',
    applicabilityNote:
      'Applies to every charity as governance evidence; the specific conflict-management procedure should fit the charity size and decision context.',
    principleNumbers: [2],
    standardCodes: ['2.1', '2.2', '2.3'],
    featureArea: 'registers',
    userTask: 'Maintain values, conflict-of-interest handling, signed trustee conduct records and related board evidence.',
    evidenceRequired: [
      'Published values statement',
      'Conflict of interest policy or procedure',
      'Conflict register extracts',
      'Signed trustee code of conduct records',
    ],
    boardApproval: 'required',
    professionalReview: ['governance_expert'],
    copyTone: 'Make conflicts visible and manageable while preserving trustee judgement and confidentiality.',
    testExpectation: 'Principle 2 standards map to conflict and conduct evidence without unsupported standard codes.',
  },
  {
    id: 'people-volunteers-employment-and-policy-controls',
    sourceRefs: [governanceCodeSource, complianceRecordFormSource, employmentSource, equalitySource],
    commencementStatus: 'conditional',
    applicabilityNote:
      'Role clarity applies to every charity; employment-law prompts apply only where the charity has paid staff, and equality review depends on activities and workforce context.',
    principleNumbers: [3],
    standardCodes: ['3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7'],
    featureArea: 'team',
    userTask: 'Document roles, volunteer arrangements, paid-staff controls and operational-policy ownership where applicable.',
    evidenceRequired: [
      'Role descriptions and delegation schedule',
      'Volunteer recruitment and supervision procedures',
      'Employment policy checklist for paid staff',
      'Operational policy review log',
    ],
    boardApproval: 'conditional',
    professionalReview: ['employment', 'equality', 'governance_expert'],
    copyTone: 'Use conditional wording for paid-staff duties and avoid implying every charity is an employer.',
    testExpectation: 'Principle 3 standards are covered with employment and equality review flags for relevant organisations.',
  },
  {
    id: 'legal-register-and-specialist-obligations',
    sourceRefs: [
      governanceCodeSource,
      complianceRecordFormSource,
      charitiesActSource,
      charitiesAmendmentAct2024Source,
      dataProtectionSource,
      healthAndSafetySource,
      safeguardingSource,
      protectedDisclosuresSource,
    ],
    commencementStatus: 'conditional',
    applicabilityNote:
      'Applies as a legal-obligations register prompt for every charity; specialist topics apply only where the charity profile triggers them, such as personal data, staff, child-facing services, insurance risks or reporting-channel thresholds.',
    principleNumbers: [4],
    standardCodes: ['4.1', '4.2', '4.6', '4.7', '4.9'],
    featureArea: 'regulator',
    userTask: 'Keep a review-ready register of legal form, regulator notifications, insurance and specialist obligations.',
    evidenceRequired: [
      'Legal and regulatory obligations register',
      'Governing document review record',
      'Regulator notification or consent record where applicable',
      'Insurance schedule',
      'Specialist policy review notes',
    ],
    boardApproval: 'conditional',
    professionalReview: [
      'solicitor',
      'data_protection',
      'health_and_safety',
      'safeguarding',
      'protected_disclosures',
      'governance_expert',
    ],
    copyTone: 'Flag specialist topics for review and state that applicability depends on the charity profile.',
    testExpectation: 'Standard 4.2 returns this regulator-area entry and includes solicitor plus conditional specialist flags.',
  },
  {
    id: 'charities-amendment-2024-commencement-monitoring',
    sourceRefs: [charitiesAmendmentAct2024Source, charitiesActSource],
    commencementStatus: 'not_commenced',
    applicabilityNote:
      'Monitor the Irish Statute Book commencement table for Charities (Amendment) Act 2024 provisions that are not yet commenced; do not treat those provisions as current live duties until a commencement order brings them into force.',
    principleNumbers: [4],
    standardCodes: ['4.1', '4.2'],
    featureArea: 'regulator',
    userTask: 'Keep a board-visible watch item for uncommenced 2024 Act provisions and record the date, source and reviewer for each status check.',
    evidenceRequired: [
      'Commencement-status review log',
      'Board note or action item confirming the status check',
      'Solicitor or governance-review note before changing product wording or user duties',
    ],
    boardApproval: 'conditional',
    professionalReview: ['solicitor', 'governance_expert'],
    copyTone: 'Use monitoring language only; this is not a current live compliance duty until the relevant provision is commenced.',
    testExpectation: 'The matrix includes explicit not-yet-commenced 2024 Act monitoring prompts with solicitor review.',
  },
  {
    id: 'fundraising-from-the-public',
    sourceRefs: [governanceCodeSource, complianceRecordFormSource, fundraisingSource],
    commencementStatus: 'conditional',
    applicabilityNote:
      'Applies only where the charity raises funds from the public or uses fundraising partners; otherwise record why the prompt is not applicable.',
    principleNumbers: [4],
    standardCodes: ['4.3'],
    featureArea: 'registers',
    userTask: 'Record public fundraising activities, controls, third-party fundraisers and board review evidence.',
    evidenceRequired: [
      'Fundraising activity register',
      'Fundraising controls checklist',
      'Third-party fundraiser agreements where relevant',
      'Fundraising complaints and review notes',
    ],
    boardApproval: 'conditional',
    professionalReview: ['governance_expert'],
    copyTone: 'Only present this as applicable when the charity raises funds from the public.',
    testExpectation: 'Fundraising standard 4.3 is covered by a conditional entry with regulator fundraising guidance.',
  },
  {
    id: 'financial-controls-and-risk-management',
    sourceRefs: [governanceCodeSource, complianceRecordFormSource, financialControlsSource],
    commencementStatus: 'guidance',
    applicabilityNote:
      'Applies to every charity as controls and risk evidence; accounting review depth should scale with income, assets, restricted funds and transaction complexity.',
    principleNumbers: [4],
    standardCodes: ['4.4', '4.5', '4.8'],
    featureArea: 'compliance',
    userTask: 'Maintain financial-control evidence and risk-register review records for trustee oversight.',
    evidenceRequired: [
      'Financial controls checklist',
      'Budget and management accounts review minutes',
      'Risk register',
      'Board risk-review minute reference',
    ],
    boardApproval: 'required',
    professionalReview: ['accountant', 'governance_expert'],
    copyTone: 'Treat controls and risk as trustee oversight evidence with professional accounting review where appropriate.',
    testExpectation: 'Financial-control and risk standards are covered with accountant review where relevant.',
  },
  {
    id: 'board-meetings-decisions-and-induction',
    sourceRefs: [governanceCodeSource, complianceRecordFormSource],
    commencementStatus: 'guidance',
    applicabilityNote:
      'Applies to every charity with proportionate evidence for its board size, meeting cadence and trustee turnover.',
    principleNumbers: [5],
    standardCodes: ['5.1', '5.2', '5.3', '5.4', '5.6', '5.7', '5.8', '5.10', '5.12'],
    featureArea: 'board',
    userTask: 'Evidence trustee skills, meeting cadence, agendas, minutes, decisions, induction and issue escalation.',
    evidenceRequired: [
      'Trustee role and skills record',
      'Board calendar and agendas',
      'Board packs and minutes',
      'Induction completion records',
      'Issue or action log',
    ],
    boardApproval: 'recommended',
    professionalReview: ['governance_expert'],
    copyTone: 'Support practical board discipline without overstating procedural formality for smaller charities.',
    testExpectation: 'Core board effectiveness standards map to board evidence and remain source-cited.',
  },
  {
    id: 'trustee-succession-review-and-development',
    sourceRefs: [governanceCodeSource, complianceRecordFormSource, equalitySource],
    commencementStatus: 'guidance',
    applicabilityNote:
      'Core trustee review prompts apply to every charity; additional succession, diversity and formal review prompts are most relevant to complex charities or those with board turnover.',
    principleNumbers: [5],
    standardCodes: ['5.5', '5.9', '5.11', '5.13', '5.14'],
    featureArea: 'team',
    userTask: 'Track term limits, succession planning, diversity considerations, board reviews and trustee development.',
    evidenceRequired: [
      'Trustee term and succession plan',
      'Board effectiveness review',
      'Skills audit',
      'Training and development log',
      'Diversity consideration notes',
    ],
    boardApproval: 'recommended',
    professionalReview: ['equality', 'governance_expert'],
    copyTone: 'Present diversity and development as structured governance review topics, not quotas or legal advice.',
    testExpectation: 'Additional board development standards are covered with equality review flagged where relevant.',
  },
  {
    id: 'public-communications-and-stakeholders',
    sourceRefs: [governanceCodeSource, complianceRecordFormSource, charitiesActSource],
    commencementStatus: 'guidance',
    applicabilityNote:
      'Applies to every charity for public identity and stakeholder accountability; funder-reporting and subscribed-standard prompts apply where those relationships exist.',
    principleNumbers: [6],
    standardCodes: ['6.1', '6.2', '6.3', '6.4', '6.5', '6.7', '6.8'],
    featureArea: 'documents',
    userTask: 'Record public identity checks, stakeholder communication, complaints handling and subscribed standards.',
    evidenceRequired: [
      'RCN and charity-name communications checklist',
      'Stakeholder map',
      'Complaints procedure and complaint review log',
      'Funder reporting tracker',
      'Public standards statement',
    ],
    boardApproval: 'conditional',
    professionalReview: ['governance_expert'],
    copyTone: 'Encourage transparent records and explain-or-evidence handling for stakeholder-facing duties.',
    testExpectation: 'Public accountability standards map to communications and complaints evidence.',
  },
  {
    id: 'annual-report-and-accounts-publication',
    sourceRefs: [
      governanceCodeSource,
      complianceRecordFormSource,
      annualReportingSource,
      charitiesActSource,
      charitiesAmendmentAct2024Source,
    ],
    commencementStatus: 'in_force',
    applicabilityNote:
      'Applies to registered charities for annual reporting readiness; accounts format, audit or examination requirements depend on legal form, income and current statutory thresholds.',
    principleNumbers: [6],
    standardCodes: ['6.6'],
    featureArea: 'deadlines',
    userTask: 'Track annual report readiness, accounts availability and filing evidence for the reporting year.',
    evidenceRequired: [
      'Approved annual report',
      'Approved accounts or financial statements',
      'Public availability record',
      'Annual report filing confirmation',
    ],
    boardApproval: 'required',
    professionalReview: ['accountant', 'governance_expert'],
    copyTone: 'State filing and publication tasks as compliance workflow prompts, with accounting review where appropriate.',
    testExpectation: 'Annual reporting standard 6.6 is covered with annual-report and Charities Act citations.',
  },
  {
    id: 'charities-amendment-2024-reporting-accounts-monitoring',
    sourceRefs: [charitiesAmendmentAct2024Source, annualReportingSource, charitiesActSource],
    commencementStatus: 'not_commenced',
    applicabilityNote:
      'Monitor not yet commenced 2024 Act changes that may affect annual reporting, accounts, regulator filing, publication or related statutory wording; keep current annual-report workflows tied to provisions actually in force.',
    principleNumbers: [6],
    standardCodes: ['6.6'],
    featureArea: 'deadlines',
    userTask: 'Track future reporting/accounting commencement updates separately from the current annual report filing workflow.',
    evidenceRequired: [
      'Annual reporting law-change watch note',
      'Source-cited commencement table extract or link',
      'Accountant/solicitor review before changing reporting prompts or deadline logic',
    ],
    boardApproval: 'conditional',
    professionalReview: ['solicitor', 'accountant', 'governance_expert'],
    copyTone: 'Keep this as a future-law monitoring item, not a current reporting duty or live filing deadline.',
    testExpectation: 'Annual reporting readiness includes an explicit 2024 Act not-yet-commenced monitoring item.',
  },
];

export function getMatrixEntriesForStandard(code: string): IrishComplianceMatrixEntry[] {
  return IRISH_COMPLIANCE_MATRIX.filter((entry) => entry.standardCodes.includes(code));
}

export function getProfessionalReviewFlags(code: string): ProfessionalReviewFlag[] {
  return [
    ...new Set(
      getMatrixEntriesForStandard(code).flatMap((entry) => entry.professionalReview),
    ),
  ];
}
