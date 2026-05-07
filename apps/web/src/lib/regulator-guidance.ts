export const officialGuidanceLinks = [
  {
    title: 'Charities Governance Code',
    href: 'https://www.charitiesregulator.ie/media/fpbnz5xz/charities-governance-code.pdf',
    note: 'The six principles, core and additional standards, ten reporting steps, and the Compliance Record Form appendix.',
  },
  {
    title: 'Sample completed Compliance Record Form',
    href: 'https://www.charitiesregulator.ie/media/1847/sample-completed-compliance-record-form.pdf',
    note: 'A worked example showing actions taken, evidence, and explanation fields.',
  },
  {
    title: 'Guidance for Charity Trustees',
    href: 'https://www.charitiesregulator.ie/media/tg2dfgiy/guidance-for-charity-trustees-july-2017.pdf',
    note: 'Trustee role, general duties, and duties under the Charities Act 2009.',
  },
  {
    title: 'Managing Conflicts of Interest',
    href: 'https://www.charitiesregulator.ie/media/zsrpbnom/managing-conflicts-of-interest-may-2018.pdf',
    note: 'Conflict identification, recording, decision handling, and trustee conduct.',
  },
  {
    title: 'Internal Financial Controls Guidelines',
    href: 'https://www.charitiesregulator.ie/media/1267/financial-controls-guidelines.pdf',
    note: 'Controls for income, expenditure, banking, assets, investments, and monitoring.',
  },
  {
    title: 'Fundraising from the Public Guidelines',
    href: 'https://www.charitiesregulator.ie/media/o5ul004d/guidance-for-fundraising-english.pdf',
    note: 'Good practice for open, transparent, honest, respectful, and accountable fundraising.',
  },
  {
    title: 'Charities (Amendment) Act 2024 overview',
    href: 'https://www.charitiesregulator.ie/media/1aioqohj/charities-amendment-act-2024.pdf',
    note: 'Key changes including trustee duties, financial regulations, and accounting regulation preparation.',
  },
];

export const regulatorOperatingModel = [
  {
    title: 'Maintain the public register details',
    cadence: 'Whenever details change',
    owner: 'Secretary or governance lead',
    evidence: 'RCN, contact details, trustee details, charitable purposes, bank account changes, and governing document updates.',
  },
  {
    title: 'Run the Governance Code annual cycle',
    cadence: 'Every reporting year',
    owner: 'Board of charity trustees',
    evidence: 'Compliance Record Form, board approval minute, actions taken, evidence list, explanations for gaps or not-applicable standards.',
  },
  {
    title: 'File the Annual Report',
    cadence: 'Within 10 months of financial year end',
    owner: 'Board with finance lead',
    evidence: 'Annual Report submission, financial statements/accounts, activity narrative, income/expenditure details, trustee approval.',
  },
  {
    title: 'Review financial controls and risk',
    cadence: 'At least annually, with board reporting during the year',
    owner: 'Treasurer, finance committee, or board',
    evidence: 'Budget, management accounts, bank reconciliations, approval limits, risk register, insurance review, audit trail.',
  },
  {
    title: 'Keep trustee governance live',
    cadence: 'At appointment and throughout term',
    owner: 'Chair and secretary',
    evidence: 'Trustee register, signed code of conduct, induction record, conflicts register, term review, skills audit, succession plan.',
  },
];

export const evidencePackItems = [
  {
    category: 'CONSTITUTION',
    title: 'Governing document',
    standards: '1.1, 4.1, 5.7',
    why: 'Trustees must understand the charity purpose, powers, and current legal form.',
  },
  {
    category: 'CODE_OF_CONDUCT',
    title: 'Board code of conduct',
    standards: '2.3, 5.7',
    why: 'The Code expects a signed conduct standard for charity trustees.',
  },
  {
    category: 'POLICY',
    title: 'Conflicts, complaints, fundraising, finance, volunteer/staff policies',
    standards: '2.2, 3.2, 3.3, 3.4, 4.3, 4.4, 6.4',
    why: 'Policies turn governance commitments into repeatable procedures.',
  },
  {
    category: 'BOARD_MINUTES',
    title: 'Board minutes and agendas',
    standards: '5.2, 5.3, 5.4',
    why: 'Minutes prove decisions, finance review, conflict declarations, and approval of the Compliance Record Form.',
  },
  {
    category: 'FINANCIAL_STATEMENT',
    title: 'Financial statements/accounts',
    standards: '4.4, 6.5, 6.6',
    why: 'Annual reporting and financial controls depend on clear, approved financial information.',
  },
  {
    category: 'ANNUAL_REPORT',
    title: 'Annual Report copy',
    standards: '6.5, 6.6',
    why: 'The Annual Report is the public accountability record filed with the Regulator.',
  },
  {
    category: 'RISK_REGISTER',
    title: 'Risk register',
    standards: '4.5, 4.8',
    why: 'Trustees must identify risks and show how they are managed.',
  },
  {
    category: 'INSURANCE',
    title: 'Insurance schedule and renewal review',
    standards: '4.6',
    why: 'Trustees need evidence that cover is appropriate and reviewed.',
  },
  {
    category: 'STRATEGIC_PLAN',
    title: 'Annual plan or strategic plan',
    standards: '1.3, 1.4, 1.6, 1.7',
    why: 'The board needs a current plan, resource view, and progress monitoring evidence.',
  },
];

export const productAuditMap = [
  {
    area: 'Compliance Record Form',
    status: 'Strong foundation',
    now: 'All six principles and standards are seeded, records auto-save, and export exists.',
    next: 'Add board approval workflow, reviewer sign-off, annual rollover, and gap-remediation tasks.',
  },
  {
    area: 'Annual reporting',
    status: 'Partial',
    now: 'Deadlines can track the 10-month filing date when the year end is present.',
    next: 'Add Annual Report data capture: activities, beneficiaries, income, expenditure, employees, volunteers, and public-register readiness.',
  },
  {
    area: 'Trustee governance',
    status: 'Good first pass',
    now: 'Trustee register tracks conduct, induction, active status, and term-limit warnings.',
    next: 'Add conflicts register, trustee eligibility checks, skills audit, board appraisal, and succession planning.',
  },
  {
    area: 'Evidence vault',
    status: 'Useful but early',
    now: 'Documents can be uploaded and linked to standards.',
    next: 'Add required-evidence checklist, review dates, version history, and document owner assignments.',
  },
  {
    area: 'Financial controls and risk',
    status: 'Thin',
    now: 'Risk register and financial statements can be stored as documents.',
    next: 'Add structured risk register, controls checklist, budget/management account board-review log, and insurance renewal workflow.',
  },
  {
    area: 'Regulatory change watch',
    status: 'Missing',
    now: 'The app did not surface 2024 Act/accounting-regulation watch items.',
    next: 'Track new accounting regulations, SORP readiness, and legal-form dependent reporting obligations.',
  },
];
