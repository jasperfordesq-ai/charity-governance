/**
 * The governance jobs that take more than one tool, written down.
 *
 * A charity's work is sequenced: a minute is recorded before the resolutions
 * under it, a document is linked to the standard it evidences before the
 * board is asked to approve it, and a deadline is corrected by fixing the
 * date it was generated from rather than by editing the deadline. An agent
 * can infer some of that from the tool list and gets the rest wrong.
 *
 * These are prompts in the protocol's sense: a client offers them to the
 * person, the person picks one, and the text arrives as their message. They
 * cost nothing at runtime and they carry the order of operations.
 *
 * Each one names the tools it expects to be used, because a prompt that
 * describes a job in the abstract is a prompt the model answers from memory.
 */
export interface PromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: readonly PromptArgument[];
  build: (args: Record<string, string>) => string;
}

const YEAR: PromptArgument = {
  name: 'year',
  description: 'The reporting year, as four digits. Defaults to the current one.',
};

function year(args: Record<string, string>): string {
  const given = args['year']?.trim();
  return /^\d{4}$/.test(given ?? '') ? given! : String(new Date().getUTCFullYear());
}

export const PROMPTS: readonly PromptDefinition[] = [
  {
    name: 'governance_health_check',
    title: 'Governance health check',
    description:
      'A whole-charity review: where compliance stands, what is overdue, what the board '
      + 'has not yet seen, and what the registers say.',
    arguments: [YEAR],
    build: (args) =>
      `Give me a governance health check for ${year(args)}.\n\n`
      + 'Start with session_info so we both know which charity this is. Then read, and do '
      + 'not change anything:\n'
      + '- compliance_summary and approval_readiness, for where the Governance Code return stands\n'
      + '- deadlines_list, for what is due or overdue\n'
      + '- registers_summary, then conflicts_list, risks_list and complaints_list for anything '
      + 'open or past its review date\n'
      + '- board_submissions, for documents the board has not approved\n'
      + '- board_register, for trustees whose term is ending or whose induction or code of '
      + 'conduct is outstanding\n\n'
      + 'Then tell me, in order of how soon it matters: what is overdue, what is at risk of '
      + 'becoming overdue, and what is merely untidy. Say which of them I can fix myself and '
      + 'which need a board decision. Do not change any record as part of this.',
  },
  {
    name: 'prepare_board_meeting',
    title: 'Prepare a board meeting',
    description:
      'Builds an agenda from what the records actually say is outstanding, and lists the '
      + 'papers the board needs in front of it.',
    arguments: [
      {
        name: 'meeting_date',
        description: 'The date of the meeting, as YYYY-MM-DD.',
        required: true,
      },
    ],
    build: (args) =>
      `Help me prepare the board meeting on ${args['meeting_date'] ?? 'the next board meeting'}.\n\n`
      + 'Read first: deadlines_list for anything falling due before the meeting after next; '
      + 'board_submissions for documents awaiting board approval; conflicts_list and risks_list '
      + 'for anything due for review; compliance_summary for standards still outstanding; and '
      + 'governing_acts for what the last meeting resolved, so nothing is carried twice.\n\n'
      + 'Then draft an agenda with a line per item saying why it is on it and what decision is '
      + 'being asked for. Separate the items that need a resolution from the ones that are for '
      + 'noting. List the papers to circulate. Do not record anything in the minute book yet: '
      + 'this meeting has not happened.',
  },
  {
    name: 'record_board_meeting',
    title: 'Record a board meeting',
    description:
      'Writes a held meeting into the minute book in the order the records expect: the '
      + 'entry, then its resolutions, then the documents it approved.',
    arguments: [
      { name: 'meeting_date', description: 'The date it was held, as YYYY-MM-DD.', required: true },
      { name: 'reference', description: 'The minute reference, unique within the charity.' },
    ],
    build: (args) =>
      `I want to record the board meeting held on ${args['meeting_date'] ?? '(tell me the date)'} `
      + 'in the minute book.\n\n'
      + 'Work in this order, and confirm each step with me before the next:\n'
      + `1. governing_act_create, kind BOARD_MEETING, status HELD, with the reference `
      + `${args['reference'] ? `${args['reference']} ` : ''}and a title that says what the meeting was.\n`
      + '2. resolution_create for each decision, one call each, in the order they were taken. '
      + 'Give each an item number. Say whether it carried.\n'
      + '3. If a resolution approved a document, document_approval_set to record which '
      + 'resolution approved it. Use documents_list to find the document first.\n'
      + '4. If the meeting reviewed a risk, a conflict or a complaint, update that record with '
      + 'the minute reference so the register points back here.\n\n'
      + 'Ask me for the text of each resolution rather than composing it. A minute book is a '
      + 'legal record: it says what happened, not what I meant.',
  },
  {
    name: 'annual_return_readiness',
    title: 'Annual return readiness',
    description:
      'Checks whether the annual report and the Governance Code return can be filed, and '
      + 'says exactly what is missing.',
    arguments: [YEAR],
    build: (args) =>
      `Can we file for ${year(args)} yet?\n\n`
      + `Read annual_report_readiness and financial_controls for ${year(args)}, `
      + 'approval_readiness and compliance_signoff for the Governance Code return, '
      + 'organisation for the filing dates the calendar is generated from, and deadlines_list '
      + 'for the filing deadlines themselves.\n\n'
      + 'Then answer in three parts: what is complete, what is missing and who has to do it, '
      + 'and whether any date in the organisation profile looks wrong — a deadline that appears '
      + 'overdue is usually a wrong date in the profile rather than a missed filing. Do not '
      + 'change anything; tell me what to change.',
  },
  {
    name: 'fix_a_wrong_deadline',
    title: 'A deadline looks wrong',
    description:
      'Works out whether a deadline is genuinely overdue or generated from a wrong date, '
      + 'and fixes the cause rather than the symptom.',
    arguments: [
      {
        name: 'deadline',
        description: 'Which deadline looks wrong, in your own words.',
        required: true,
      },
    ],
    build: (args) =>
      `This deadline looks wrong to me: ${args['deadline'] ?? '(describe it)'}.\n\n`
      + 'Read deadlines_list to find it and see whether it was generated or entered by hand, '
      + 'and organisation for the dates the calendar is generated from — the last annual '
      + 'general meeting, the financial year end, the CRO annual return date.\n\n'
      + 'A generated deadline cannot be corrected by editing it: it is produced from the '
      + 'profile, so the fix is organisation_update on whichever date is wrong, which '
      + 'regenerates the calendar. Tell me which date you believe is wrong and what it should '
      + 'be, and change it only once I have confirmed. If the deadline was entered by hand, '
      + 'deadline_update is the right tool.',
  },
];

export function findPrompt(name: string): PromptDefinition | undefined {
  return PROMPTS.find((prompt) => prompt.name === name);
}

/** What a client is told each prompt takes. */
export function promptListing() {
  return PROMPTS.map((prompt) => ({
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
    arguments: prompt.arguments.map((argument) => ({
      name: argument.name,
      description: argument.description,
      required: argument.required ?? false,
    })),
  }));
}
