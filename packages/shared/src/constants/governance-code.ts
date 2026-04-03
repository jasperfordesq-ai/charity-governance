/**
 * CRA Charities Governance Code — November 2018
 * All 6 principles, 32 core standards, 17 additional standards = 49 total.
 * Text is word-for-word from the official CRA document.
 */

export interface GovernancePrincipleData {
  number: number;
  title: string;
  description: string;
  standards: GovernanceStandardData[];
}

export interface GovernanceStandardData {
  code: string;
  title: string;
  isCore: boolean;
  isAdditional: boolean;
}

export const GOVERNANCE_PRINCIPLES: GovernancePrincipleData[] = [
  {
    number: 1,
    title: 'Advancing Charitable Purpose',
    description:
      'Charity trustees must ensure their charity promotes its charitable purpose only and that it is of public benefit.',
    standards: [
      {
        code: '1.1',
        title:
          'Be clear about the purpose of your charity and be able to explain this in simple terms to anyone who asks.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '1.2',
        title:
          'Consider whether or not any private benefit arises. If a private benefit arises, consider if it is reasonable, necessary and ancillary to the public benefit that your charity provides.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '1.3',
        title:
          'Agree an achievable plan for at least the next year that sets out what you will do to advance your purpose.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '1.4',
        title:
          "Make sure your charity has the resources it needs to do the activities you plan. If you don't have the resources, you need to show a plan for getting those resources.",
        isCore: true,
        isAdditional: false,
      },
      {
        code: '1.5',
        title:
          "From time to time, review what you are doing to make sure you are still: acting in line with your charity's purpose; and providing public benefit.",
        isCore: true,
        isAdditional: false,
      },
      {
        code: '1.6',
        title:
          "Develop your charity's strategic plan and associated operational plans.",
        isCore: false,
        isAdditional: true,
      },
      {
        code: '1.7',
        title:
          'Make sure there is an appropriate system in place to: monitor progress against your plans; and evaluate the effectiveness of the work of your charity.',
        isCore: false,
        isAdditional: true,
      },
      {
        code: '1.8',
        title:
          'From time to time, consider the advantages and disadvantages of working in partnership with other charities, including merging or dissolving (winding up).',
        isCore: false,
        isAdditional: true,
      },
    ],
  },
  {
    number: 2,
    title: 'Behaving with Integrity',
    description:
      'Charity trustees have a legal duty to act in the best interests of the charity, independent of personal interests. They must lead by example and create an ethical culture.',
    standards: [
      {
        code: '2.1',
        title:
          'Agree the basic values that matter to your charity and publicise these, so that everyone involved understands the way things should be done and how everyone is expected to behave.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '2.2',
        title:
          "Decide how you will deal with conflicts of interests and conflicts of loyalties. You should also decide how you will adhere to the Charities Regulator's guidelines on this topic.",
        isCore: true,
        isAdditional: false,
      },
      {
        code: '2.3',
        title:
          'Have a code of conduct for your board that is signed by all charity trustees. It must make clear the standard of behaviour expected from charity trustees. This includes things like maintaining board confidentiality and what to do in relation to: gifts and hospitality; and out-of-pocket expenses.',
        isCore: true,
        isAdditional: false,
      },
    ],
  },
  {
    number: 3,
    title: 'Leading People',
    description:
      'People should feel valued and have clarity around their own roles and the roles of others. Charity trustees are responsible for providing leadership to volunteers, employees and contractors.',
    standards: [
      {
        code: '3.1',
        title:
          'Be clear about the roles of everyone working in and for your charity, both on a voluntary and paid basis.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '3.2',
        title:
          'Make sure there are arrangements in place for the effective involvement of any volunteers, including what to do if any problems arise.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '3.3',
        title:
          'Make sure there are arrangements in place that comply with employment legislation for all paid staff including: recruitment; training and development; support, supervision and appraisal; remuneration and dismissal.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '3.4',
        title:
          'Agree operational policies where necessary, to guide the actions of everyone involved in your charity.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '3.5',
        title:
          'Make sure to document the roles, legal duties and delegated responsibility for decision-making of: individual charity trustees and the board as a whole; any sub-committees or working groups; staff and volunteers.',
        isCore: false,
        isAdditional: true,
      },
      {
        code: '3.6',
        title:
          'Make sure that there are written procedures in place which set out how volunteers are: recruited, supported and supervised while within your charity; and the conditions under which they exit.',
        isCore: false,
        isAdditional: true,
      },
      {
        code: '3.7',
        title:
          'Decide how you will develop operational policy in your charity. You also need to decide how your charity trustees will make sure that policy is put in place and kept up to date.',
        isCore: false,
        isAdditional: true,
      },
    ],
  },
  {
    number: 4,
    title: 'Exercising Control',
    description:
      "All charities must abide by all legal and regulatory requirements. The trustees are responsible for a charity's funds and any property or other assets. They must also consider and reduce risks.",
    standards: [
      {
        code: '4.1',
        title:
          "Decide if your charity's current legal form and governing document are fit for purpose. Make changes if necessary, telling the Charities Regulator in advance that you are doing so.",
        isCore: true,
        isAdditional: false,
      },
      {
        code: '4.2',
        title:
          'Find out the laws and regulatory requirements that are relevant to your charity and comply with them.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '4.3',
        title:
          "If your charity raises funds from the public, read the Charities Regulator's guidelines on this topic and make sure that your charity adheres to them as they apply to your charity.",
        isCore: true,
        isAdditional: false,
      },
      {
        code: '4.4',
        title:
          "Make sure you have appropriate financial controls in place to manage and account for your charity's money and other assets.",
        isCore: true,
        isAdditional: false,
      },
      {
        code: '4.5',
        title:
          'Identify any risks your charity might face and how to manage these.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '4.6',
        title:
          'Make sure your charity has appropriate and adequate insurance cover.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '4.7',
        title:
          'Have written procedures to make sure that you comply with all relevant legal and regulatory requirements.',
        isCore: false,
        isAdditional: true,
      },
      {
        code: '4.8',
        title:
          'Make sure there is a formal risk register that your board regularly reviews.',
        isCore: false,
        isAdditional: true,
      },
      {
        code: '4.9',
        title:
          'Consider adopting additional good practice standards that are relevant to the particular work that your charity does.',
        isCore: false,
        isAdditional: true,
      },
    ],
  },
  {
    number: 5,
    title: 'Working Effectively',
    description:
      'Running a charity well means capable charity trustees who work together as an effective team. Board meetings are especially important. It is vital that new charity trustees receive a proper induction.',
    standards: [
      {
        code: '5.1',
        title:
          'Identify charity trustees with the necessary skills to undertake: any designated roles set out in your governing document; and other roles as appropriate within the board.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '5.2',
        title:
          'Hold regular board meetings. Give enough notice before meetings and provide prepared agendas.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '5.3',
        title:
          'At a minimum, your board agendas should always include these items: reporting on activities; review of finances; and conflicts of interests and loyalties.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '5.4',
        title:
          'Make sure that your charity trustees have the facts to make informed decisions at board meetings and that these decisions are recorded accurately in the minutes.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '5.5',
        title:
          'Consider introducing term limits for your charity trustees, with a suggested maximum of nine years in total.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '5.6',
        title:
          'Recruit suitable new charity trustees as necessary and make sure that they receive an induction.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '5.7',
        title:
          "Make sure all of your trustees understand: their role as charity trustees; the charity's governing document; and this Code.",
        isCore: true,
        isAdditional: false,
      },
      {
        code: '5.8',
        title:
          'Commit to resolving problems and emerging issues as quickly as possible and in the best interests of your charity.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '5.9',
        title:
          'From time to time, review how your board operates and make any necessary improvements.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '5.10',
        title:
          'Make sure you send out board packs with enough notice and include all relevant reports and explanatory papers to enable informed decision-making.',
        isCore: false,
        isAdditional: true,
      },
      {
        code: '5.11',
        title:
          'Make sure that you have a charity trustee succession plan in place and consider how you can maximise diversity among your charity trustees.',
        isCore: false,
        isAdditional: true,
      },
      {
        code: '5.12',
        title:
          'Put in place a comprehensive induction programme for new charity trustees.',
        isCore: false,
        isAdditional: true,
      },
      {
        code: '5.13',
        title:
          'Conduct a regular review that includes an assessment of: the effectiveness of your board as a whole, office holders and individual charity trustees; adherence to the board code of conduct; and the structure, size, membership and terms of reference of any sub-committees.',
        isCore: false,
        isAdditional: true,
      },
      {
        code: '5.14',
        title:
          'Do regular skills audits and provide appropriate training and development to charity trustees. If necessary, recruit to fill any competency gaps on the board of your charity.',
        isCore: false,
        isAdditional: true,
      },
    ],
  },
  {
    number: 6,
    title: 'Being Accountable and Transparent',
    description:
      'Accountability means being open and transparent about all charity matters — being able to stand over what your charity does and how it does it, and justify this to anyone who queries it.',
    standards: [
      {
        code: '6.1',
        title:
          'Make sure that the name and Registered Charity Number (RCN) of your charity is displayed on all of your written materials, including your: website; social media platforms; and email communications.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '6.2',
        title:
          'Identify your stakeholders and decide how you will communicate with them.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '6.3',
        title:
          'Decide if and how you will involve your stakeholders in your: planning; decision-making; and review processes.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '6.4',
        title:
          'Make sure you have a procedure for dealing with: queries; comments; and complaints.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '6.5',
        title:
          'Follow the reporting requirements of all of your funders and donors, both public and private.',
        isCore: true,
        isAdditional: false,
      },
      {
        code: '6.6',
        title:
          "Produce unabridged (full) financial accounts and make sure that these and your charity's annual report are widely available and easy for everyone to access.",
        isCore: false,
        isAdditional: true,
      },
      {
        code: '6.7',
        title:
          'Make sure all the codes and standards of practice to which your charity subscribes are publicly stated.',
        isCore: false,
        isAdditional: true,
      },
      {
        code: '6.8',
        title:
          'Regularly review any complaints your charity receives and take action to improve organisational practice.',
        isCore: false,
        isAdditional: true,
      },
    ],
  },
];

/** Total counts for verification. */
export const GOVERNANCE_TOTALS = {
  principles: 6,
  coreStandards: 32,
  additionalStandards: 17,
  totalStandards: 49,
} as const;

/** Compliance status labels and colours for UI rendering. */
export const COMPLIANCE_STATUS_META = {
  COMPLIANT: { label: 'Compliant', colour: '#16a34a', bgColour: '#dcfce7' },
  WORKING_TOWARDS: { label: 'Working Towards', colour: '#d97706', bgColour: '#fef3c7' },
  NOT_STARTED: { label: 'Not Yet Started', colour: '#6b7280', bgColour: '#f3f4f6' },
  NOT_APPLICABLE: { label: 'Not Applicable', colour: '#2563eb', bgColour: '#dbeafe' },
  EXPLAIN: { label: 'Explain Non-Compliance', colour: '#dc2626', bgColour: '#fee2e2' },
} as const;

/** Document category labels for UI rendering. */
export const DOCUMENT_CATEGORY_LABELS: Record<string, string> = {
  CONSTITUTION: 'Constitution / Governing Document',
  POLICY: 'Policy',
  BOARD_MINUTES: 'Board Minutes',
  FINANCIAL_STATEMENT: 'Financial Statement',
  INSURANCE: 'Insurance Certificate',
  ANNUAL_REPORT: 'Annual Report',
  RISK_REGISTER: 'Risk Register',
  CODE_OF_CONDUCT: 'Code of Conduct',
  STRATEGIC_PLAN: 'Strategic Plan',
  OTHER: 'Other',
};

/** Legal form labels for UI rendering. */
export const LEGAL_FORM_LABELS: Record<string, string> = {
  CLG: 'Company Limited by Guarantee (CLG)',
  TRUST: 'Trust',
  UNINCORPORATED_ASSOCIATION: 'Unincorporated Association',
  OTHER: 'Other',
};

/** Charitable purpose labels from the Charities Act 2009. */
export const CHARITABLE_PURPOSE_LABELS: Record<string, string> = {
  POVERTY_RELIEF: 'Prevention or relief of poverty or economic hardship',
  EDUCATION: 'Advancement of education',
  RELIGION: 'Advancement of religion',
  COMMUNITY_BENEFIT: 'Other purposes of benefit to the community',
};
