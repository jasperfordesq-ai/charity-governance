import type { ApiClient } from './client.js';
import {
  applyFieldPolicy,
  applyShapePolicy,
  SAFE_FIELDS,
  type ModelName,
  type ShapeName,
} from './field-policy.js';
import { buildPath, inputSchemaFor, paramName, type ParamSpec } from './tool-input.js';
import { buildBody, bodySchemaFor, type FieldSpec } from './tool-body.js';
import {
  DEADLINE_REMINDER_STATUSES,
  GOVERNING_ACT_KINDS,
  GOVERNING_ACT_STATUSES,
} from './enums.js';
import { WRITE_TOOLS } from './write-tools.js';
import { ConnectorError } from './errors.js';

export interface ToolDefinition {
  name: string;
  description: string;
  path: string;
  /** Declared arguments. The advertised JSON Schema is generated from these,
   *  so what a client is told it may send and what the validator accepts
   *  cannot drift apart. */
  params?: readonly ParamSpec[];
  /** Every record in this payload is one model. */
  model?: ModelName;
  /** This payload mixes models; a named shape filter handles it. */
  shape?: ShapeName;
  /** Why this payload needs neither: it carries no records about anyone. */
  noRecordsBecause?: string;
  /** The HTTP method. Absent means a read. */
  method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Body fields this tool accepts. Anything else is refused, not forwarded. */
  body?: readonly FieldSpec[];
  /** The least session access level that may call this tool. Absent means read. */
  level?: 'read' | 'write' | 'admin';
  /** Removes something, or cannot be undone. A reason is required, and the API
   *  asks a person to approve it before it happens. */
  destructive?: boolean;
  /** Keys stripped from the response whatever the gate says. The gate governs
   *  personal data; a credential is a different thing, and opening the gate
   *  must not release one. */
  redactAlways?: readonly string[];
}

/**
 * Narrows each record to the fields the caller asked for.
 *
 * Only ever a subset of what the gate would release anyway: the argument is
 * validated against the same allowlist, so asking for a field cannot reach
 * one. It exists because a long register is a long payload, and an agent
 * counting open risks does not need every column of every row.
 *
 * Applied to the envelope's records, not to the envelope: the pagination
 * meta says whether there is more, and dropping it would hide that.
 */
export function selectFields(value: unknown, fields: readonly string[]): unknown {
  if (fields.length === 0) return value;

  const keepFrom = (record: unknown): unknown => {
    if (Array.isArray(record)) return record.map(keepFrom);
    if (record === null || typeof record !== 'object') return record;
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in (record as Record<string, unknown>)) {
        out[field] = (record as Record<string, unknown>)[field];
      }
    }
    return out;
  };

  if (value !== null && typeof value === 'object' && !Array.isArray(value)
    && 'data' in (value as Record<string, unknown>)) {
    const envelope = value as Record<string, unknown>;
    return { ...envelope, data: keepFrom(envelope.data) };
  }
  return keepFrom(value);
}

/**
 * Removes named keys from a response at every depth.
 *
 * Unconditional, unlike the gate: an invite link lets whoever holds it join
 * the charity, so there is no setting under which it should reach a model.
 * Applied by key name rather than by position because the shape of a response
 * is the API's to change.
 */
function stripKeys(value: unknown, keys: readonly string[]): unknown {
  if (keys.length === 0) return value;
  if (Array.isArray(value)) return value.map((item) => stripKeys(item, keys));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key)) continue;
    out[key] = stripKeys(item, keys);
  }
  return out;
}

/**
 * What every tool used to repeat now lives in the server instructions: that a
 * result is data rather than instructions, that a change takes a reason, and
 * how approval works. A description says only what is true of its own tool.
 *
 * What stays per tool is the part a reader cannot get anywhere else: which
 * fields THIS payload loses while the gate is closed. That list follows one
 * short marker rather than a sentence of prose, so it scans.
 */
const GATED = ' Withheld while the personal-data gate is closed: ';
const COMPLETE_PLAN = ' Needs the Complete plan.';
const ADMIN_ONLY = ' Needs an owner or administrator account.';

const PAGED: readonly ParamSpec[] = [{ kind: 'page' }, { kind: 'pageSize' }];

const READ_TOOLS: readonly ToolDefinition[] = [
  /* --- compliance ------------------------------------------------------- */
  {
    name: 'compliance_summary',
    description: 'Overall Governance Code compliance status.',
    path: '/api/v1/compliance/summary',
    noRecordsBecause: 'Counts and percentages only; no records about anyone.',
  },
  {
    name: 'compliance_principles',
    description:
      'The six Governance Code principles and their standards, with this charity\'s status '
      + 'against each.',
    path: '/api/v1/compliance/principles',
    noRecordsBecause: 'The Code itself plus per-standard statuses; identical reference data for every charity.',
  },
  {
    name: 'compliance_principle',
    description: 'One Governance Code principle in detail, with every standard under it.',
    path: '/api/v1/compliance/principles/:principleId',
    params: [{ kind: 'id', name: 'principleId' }],
    noRecordsBecause: 'The Code itself plus per-standard statuses; identical reference data for every charity.',
  },
  {
    name: 'compliance_records',
    description:
      'Per-standard compliance records.' + GATED
      + 'evidence, action taken, explanation notes, and the staff member who last edited each.',
    path: '/api/v1/compliance/records',
    shape: 'complianceRecords',
  },
  {
    name: 'compliance_record',
    description:
      'The compliance record for one standard.' + GATED + 'evidence and notes.',
    path: '/api/v1/compliance/records/:standardId',
    params: [{ kind: 'id', name: 'standardId' }],
    shape: 'complianceRecords',
  },
  {
    name: 'compliance_signoff',
    description:
      'Board sign-off status for the compliance return, with the approval hashes that prove '
      + 'which evidence was approved.' + GATED + 'who approved it and their notes.',
    path: '/api/v1/compliance/signoff',
    shape: 'complianceSignoff',
  },
  {
    name: 'approval_readiness',
    description: 'Whether the charity is ready for board approval of its compliance return.',
    path: '/api/v1/compliance/approval-readiness',
    noRecordsBecause: 'Standard identifiers, codes and statuses; no records about anyone.',
  },

  /* --- the charity itself ----------------------------------------------- */
  {
    name: 'organisation',
    description:
      'The charity\'s own registration details: names, numbers, legal form, financial year end '
      + 'and key dates.' + GATED + 'registered address, contact email, contact phone, which for '
      + 'a small charity are frequently a trustee\'s own.',
    path: '/api/v1/organisation',
    model: 'Organisation',
  },
  {
    name: 'dashboard_overview',
    description:
      'Dashboard overview: compliance figures, the next deadlines, board alerts and recent '
      + 'activity.' + GATED + 'activity descriptions, which are free text naming people, and '
      + 'staff names.',
    path: '/api/v1/dashboard',
    shape: 'dashboard',
  },

  /* --- deadlines --------------------------------------------------------- */
  {
    name: 'deadlines_list',
    description:
      'Governance deadlines: returns, filings, reviews and meetings.' + GATED
      + 'deadline descriptions and the profile snapshot that generated each one.',
    path: '/api/v1/deadlines',
    params: PAGED,
    model: 'Deadline',
  },
  {
    name: 'deadlines_history',
    description: 'Completed governance deadlines, with the same fields withheld as the deadline list.',
    path: '/api/v1/deadlines/history',
    params: PAGED,
    model: 'Deadline',
  },
  {
    name: 'deadlines_reminder_history',
    description:
      'Whether each deadline reminder was sent, skipped or failed, and when.' + GATED
      + 'the recipient\'s email address and the provider\'s error text, which quotes it.'
      + ADMIN_ONLY,
    path: '/api/v1/deadlines/reminder-history',
    params: [
      ...PAGED,
      { kind: 'enum', name: 'status', values: DEADLINE_REMINDER_STATUSES },
    ],
    shape: 'reminderHistory',
  },

  /* --- the board and the minute book ------------------------------------- */
  {
    name: 'board_register',
    description:
      'Trustees: names, roles, terms, conduct and induction status.' + GATED
      + 'dates of birth, home addresses, former names, other directorships, email addresses.',
    path: '/api/v1/board-members',
    params: PAGED,
    model: 'BoardMember',
  },
  {
    name: 'board_member_get',
    description:
      'One trustee by identifier, as the board register returns them. Use this to resolve a '
      + 'boardMemberId carried on a conflict record rather than paging the register.' + GATED
      + 'date of birth, home address, former names, other directorships, email address.',
    path: '/api/v1/board-members/:id',
    params: [{ kind: 'id', name: 'id' }],
    model: 'BoardMember',
  },
  {
    name: 'governing_acts',
    description:
      'The minute book: board meetings, written resolutions and general meetings, with kind, '
      + 'status, dates, references and titles.' + GATED + 'resolution text, who abstained, and '
      + 'any link back to a conflict record.' + COMPLETE_PLAN,
    path: '/api/v1/governing-acts',
    params: [
      { kind: 'year' },
      { kind: 'enum', name: 'kind', values: GOVERNING_ACT_KINDS },
      { kind: 'enum', name: 'status', values: GOVERNING_ACT_STATUSES },
    ],
    model: 'GoverningAct',
  },
  {
    name: 'governing_act_get',
    description:
      'One meeting or written resolution by identifier, with its resolutions. The minute book '
      + 'tool returns every act, which is a great deal to read to answer a question about '
      + 'one.' + GATED + 'resolution text, who abstained, and any link back to a conflict '
      + 'record.' + COMPLETE_PLAN,
    path: '/api/v1/governing-acts/:id',
    params: [{ kind: 'id', name: 'id' }],
    model: 'GoverningAct',
  },
  {
    name: 'governing_acts_voids',
    description:
      'Minutes that were voided, with the reference and dates that keep them traceable.' + GATED
      + 'the stored copy of the voided minute, the reason given, who voided it.' + COMPLETE_PLAN,
    path: '/api/v1/governing-acts/voids',
    model: 'GoverningActVoid',
  },
  {
    name: 'board_submissions',
    description:
      'Documents submitted to the board for approval, split into evidenced and outstanding, each '
      + 'linked to the resolution that approved it.' + GATED + 'resolution text and document '
      + 'owners.' + COMPLETE_PLAN,
    path: '/api/v1/governing-acts/board-submissions',
    shape: 'boardSubmissions',
  },

  /* --- registers --------------------------------------------------------- */
  {
    name: 'registers_summary',
    description:
      'How many conflicts, risks, complaints and fundraising activities are open.' + COMPLETE_PLAN,
    path: '/api/v1/governance-registers/summary',
    noRecordsBecause: 'Six counts and percentages; no records about anyone.',
  },
  {
    name: 'conflicts_list',
    description:
      'The conflicts of interest register: status, dates and minute references.' + GATED
      + 'the trustee named, the matter, its nature, the action taken, the decision.'
      + COMPLETE_PLAN,
    path: '/api/v1/governance-registers/conflicts',
    model: 'ConflictRecord',
  },
  {
    name: 'risks_list',
    description:
      'The risk register: title, category, likelihood, impact, status and review dates.' + GATED
      + 'description, mitigation, the named owner.' + COMPLETE_PLAN,
    path: '/api/v1/governance-registers/risks',
    model: 'RiskRecord',
  },
  {
    name: 'complaints_list',
    description:
      'The complaints register: status, dates and whether the board reviewed each one.' + GATED
      + 'summary, source, action taken, outcome.' + COMPLETE_PLAN,
    path: '/api/v1/governance-registers/complaints',
    model: 'ComplaintRecord',
  },
  {
    name: 'fundraising_list',
    description:
      'The fundraising register: activity, dates, whether it was public facing, and complaint '
      + 'counts.' + GATED + 'any third-party fundraiser named, the controls, the review outcome.'
      + COMPLETE_PLAN,
    path: '/api/v1/governance-registers/fundraising',
    model: 'FundraisingRecord',
  },
  {
    name: 'annual_report_readiness',
    description:
      'Whether the annual report is ready to file, as a set of checks and dates.' + GATED
      + 'the narrative sections, including the summary of beneficiaries.' + COMPLETE_PLAN,
    path: '/api/v1/governance-registers/annual-report',
    params: [{ kind: 'year' }],
    model: 'AnnualReportReadiness',
  },
  {
    name: 'financial_controls',
    description:
      'The financial controls review: which controls were reviewed, when, and against which '
      + 'minute.' + GATED + 'the reviewer named and the follow-up actions.' + COMPLETE_PLAN,
    path: '/api/v1/governance-registers/financial-controls',
    params: [{ kind: 'year' }],
    model: 'FinancialControlReview',
  },
  {
    name: 'members_list',
    description:
      'The statutory register of members: when each was entered and ceased.' + GATED
      + 'members\' names and addresses, which unlike trustees\' appear on no public register.'
      + COMPLETE_PLAN,
    path: '/api/v1/members',
    params: [{ kind: 'flag', name: 'includeFormer' }],
    model: 'Member',
  },

  /* --- documents --------------------------------------------------------- */
  {
    name: 'documents_list',
    description:
      'Evidence document metadata: name, category, size, type, version and approval state. File '
      + 'contents are never returned.' + GATED + 'the document owner and description.',
    path: '/api/v1/documents',
    params: PAGED,
    model: 'Document',
  },
  {
    name: 'document',
    description: 'One evidence document\'s metadata. File contents are never returned.',
    path: '/api/v1/documents/:id',
    params: [{ kind: 'id', name: 'id' }],
    model: 'Document',
  },

  /* --- people with access ------------------------------------------------ */
  {
    name: 'team_list',
    description:
      'Who has access to this charity\'s CharityPilot account and at what role, and which '
      + 'invitations are outstanding.' + GATED + 'account holders\' names and email addresses.',
    path: '/api/v1/team',
    shape: 'team',
  },
  {
    name: 'team_sessions_list',
    description:
      'One colleague\'s sign-in sessions: when each began, when it expires, whether it is '
      + 'still active, and whether it belongs to a browser or a connector and at what level. '
      + 'Use it to find the session to revoke.' + GATED + 'the label they gave their own '
      + 'machine, and the reason any session was revoked.' + ADMIN_ONLY,
    path: '/api/v1/team/members/:id/sessions',
    params: [{ kind: 'id', name: 'id' }],
    shape: 'teamSessions',
  },
  {
    name: 'security_audit',
    description:
      'The twenty most recent security events for this charity: role changes, suspensions, '
      + 'removals, session revocations and replayed credentials, with when each happened.'
      + GATED + 'who acted, who it was about, and the reason given, all of which are prose '
      + 'naming people.' + ADMIN_ONLY,
    path: '/api/v1/team/security-audit',
    shape: 'securityAudit',
  },

  /* --- billing ------------------------------------------------------------ */
  {
    name: 'billing_status',
    description:
      'The charity\'s own subscription: plan, status, billing interval, whether it is set to '
      + 'cancel, and the trial and period end dates. Starting a payment is deliberately not '
      + 'offered here.',
    path: '/api/v1/billing/status',
    noRecordsBecause:
      'The charity\'s own plan, status and dates, plus flags saying which billing actions are '
      + 'available to the caller; no records about anyone.',
  },

  /* --- integrations ------------------------------------------------------ */
  {
    name: 'confluence_status',
    description:
      'Whether Confluence is connected, to which site and space, and when it last published.'
      + ADMIN_ONLY,
    path: '/api/v1/integrations/confluence/status',
    noRecordsBecause:
      'Connection status for one integration; the route allowlists its own keys and returns no credential.',
  },
];

/**
 * Every tool, reads first.
 *
 * The order is stable and alphabetical within each half, because a client
 * that lists tools shows them in the order given, and a person scanning the
 * list should meet everything that only looks before anything that changes.
 */
export const TOOLS: readonly ToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS];

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export function titleFor(name: string): string {
  const [first = '', ...rest] = name.split('_');
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/**
 * The hints the protocol lets a tool carry, derived from the definition so
 * they cannot disagree with it.
 *
 * `destructiveHint` follows the approval gate: a removal or a void. An update
 * changes a record but leaves it, and calling it destructive would make every
 * client prompt for every field correction, which teaches people to click
 * through. `openWorldHint` is false throughout: the connector reaches one API
 * and nothing else.
 */
export function annotationsFor(tool: ToolDefinition): ToolAnnotations {
  const read = tool.method === undefined;
  return {
    title: titleFor(tool.name),
    readOnlyHint: read,
    destructiveHint: tool.destructive === true,
    idempotentHint: read || tool.method === 'PUT' || tool.method === 'DELETE',
    openWorldHint: false,
  };
}

export const TOOL_GROUPS = [
  'compliance',
  'organisation',
  'deadlines',
  'board',
  'minute-book',
  'registers',
  'documents',
  'team',
  'billing',
  'integrations',
] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/**
 * Groups follow the API's own route prefixes, so a tool cannot be filed under
 * the wrong heading by hand and a tool added later lands in a group without
 * anyone remembering. Sixty-odd tools always listed is a real cost in a
 * client's context; a person working on the minute book can ask for that.
 */
const GROUP_BY_PREFIX: readonly (readonly [string, ToolGroup])[] = [
  ['/api/v1/compliance', 'compliance'],
  ['/api/v1/organisation', 'organisation'],
  ['/api/v1/dashboard', 'organisation'],
  ['/api/v1/deadlines', 'deadlines'],
  ['/api/v1/board-members', 'board'],
  ['/api/v1/governing-acts', 'minute-book'],
  ['/api/v1/governance-registers', 'registers'],
  ['/api/v1/members', 'registers'],
  ['/api/v1/documents', 'documents'],
  ['/api/v1/team', 'team'],
  ['/api/v1/billing', 'billing'],
  ['/api/v1/integrations', 'integrations'],
];

export function groupOf(tool: { path: string }): ToolGroup {
  for (const [prefix, group] of GROUP_BY_PREFIX) {
    if (tool.path === prefix || tool.path.startsWith(`${prefix}/`)) return group;
  }
  throw new Error(`${tool.path} belongs to no tool group`);
}

/**
 * What a client is told a result looks like.
 *
 * Declared only for tools whose payload is one model, and generated from the
 * same allowlist the gate applies, so the schema is the gate's promise made
 * checkable: with the gate closed, only the listed fields are present. Every
 * property is left untyped and additional properties are allowed, because the
 * open gate returns the full record and a client validating a result against
 * this schema must not be told a true record is invalid.
 */
export function outputSchemaFor(tool: ToolDefinition): object | undefined {
  if (!tool.model) return undefined;
  const record = {
    type: 'object',
    description:
      `One ${tool.model} record. With the personal-data gate closed only the listed `
      + 'fields are present; with it open the full record is.',
    properties: Object.fromEntries(SAFE_FIELDS[tool.model].map((field) => [field, {}])),
    additionalProperties: true,
  };
  return {
    type: 'object',
    properties: {
      data: {
        anyOf: [
          { type: 'array', items: record },
          record,
          { type: 'null' },
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
        ],
      },
      total: { type: 'integer' },
      page: { type: 'integer' },
      pageSize: { type: 'integer' },
      hasMore: { type: 'boolean' },
    },
    additionalProperties: true,
  };
}

/**
 * A tool declares a model when every record in its payload is one model, or a
 * shape when the payload mixes them. Declaring both is a contradiction about
 * what the payload is, so it throws rather than silently preferring one.
 *
 * A tool declaring neither returns its payload unfiltered, which is only
 * legitimate for responses that carry no records at all — counts and
 * statuses. A test enforces that, because four tools shipped for a while with
 * neither and their records went straight past the gate.
 */
export function applyPolicy(
  tool: ToolDefinition,
  raw: unknown,
  allowPersonalData: boolean,
): unknown {
  if (tool.model && tool.shape) {
    throw new Error(`${tool.name} declares both a model and a shape; it can only be one.`);
  }
  if (tool.model) return applyFieldPolicy(tool.model, raw, allowPersonalData);
  if (tool.shape) return applyShapePolicy(tool.shape, raw, allowPersonalData);
  return raw;
}

/**
 * Splits the caller's arguments into the ones that shape the URL and the ones
 * that make up the body, plus the reason and approval that travel as headers.
 *
 * Both halves reject anything they do not declare, so a field intended for the
 * body cannot be smuggled into the path and an argument that belongs to
 * neither is refused rather than quietly dropped.
 */
function partition(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): {
  pathArgs: Record<string, unknown>;
  bodyArgs: Record<string, unknown>;
  reason: string | undefined;
  approvalId: string | undefined;
} {
  const pathNames = new Set((tool.params ?? []).map(paramName));
  const pathArgs: Record<string, unknown> = {};
  const bodyArgs: Record<string, unknown> = {};
  let reason: string | undefined;
  let approvalId: string | undefined;

  for (const [key, value] of Object.entries(args)) {
    if (key === 'reason') {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('reason must say why the change is being made.');
      }
      reason = value.trim();
      continue;
    }
    if (key === 'approvalId') {
      if (typeof value !== 'string') throw new Error('approvalId must be text.');
      approvalId = value;
      continue;
    }
    if (pathNames.has(key)) {
      pathArgs[key] = value;
      continue;
    }
    bodyArgs[key] = value;
  }

  return { pathArgs, bodyArgs, reason, approvalId };
}

/**
 * The body fields a tool declares that the personal-data gate would withhold
 * on the way out.
 *
 * Derived from the same allowlist the gate uses, rather than from a list
 * written out by hand. A hand-written list was what let `conflict_create` ship
 * accepting a trustee's name, the matter and its nature — every one of them a
 * field the gate drops from a read — while a test that only knew about dates
 * of birth and home addresses stayed green.
 *
 * Control fields are excluded: a concurrency stamp and a confirmation flag
 * describe the request, not the charity or anyone in it.
 */
export function gatedFieldsOf(tool: ToolDefinition): readonly string[] {
  if (!tool.model || !tool.body) return [];
  const safe = new Set(SAFE_FIELDS[tool.model]);
  return tool.body
    .filter((field) => !field.control && !safe.has(field.name))
    .map((field) => field.name);
}

/**
 * The gated fields a particular CALL actually supplies.
 *
 * Judged per call rather than per tool, because most updates do not touch the
 * withheld half of a record. Changing a risk's status or its minute reference
 * says nothing about a person; rewriting its description might. Gating the
 * whole tool would have refused the first to prevent the second, and would
 * have made most of the write surface unusable by default for no gain.
 */
export function gatedFieldsInCall(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): readonly string[] {
  const gated = new Set(gatedFieldsOf(tool));
  return Object.keys(args).filter((key) => gated.has(key));
}

/**
 * True when this tool cannot be used at all without opening the gate: one of
 * the fields the API requires is one the gate withholds.
 *
 * A conflict of interest that names nobody and describes no matter is not a
 * conflict record, so `conflict_create` is in this position. `risk_update` is
 * not: it can perfectly well change a status alone.
 */
export function needsPersonalData(tool: ToolDefinition): boolean {
  if (!tool.model || !tool.body) return false;
  const safe = new Set(SAFE_FIELDS[tool.model]);
  return tool.body.some(
    (field) => field.required && !field.control && !safe.has(field.name),
  );
}

/**
 * What a client is told it may send.
 *
 * Generated from the same declarations the validator enforces, so the advertised
 * schema and the accepted arguments cannot drift apart. A tool that changes
 * something also advertises `reason`, and a tool that destroys something
 * advertises `approvalId` as well, because a caller has no other way to learn
 * that the identifier it was handed in a refusal is meant to come back here.
 */
export function toolInputSchema(tool: ToolDefinition): object {
  const fromParams = inputSchemaFor(tool.params ?? []) as {
    properties: Record<string, unknown>;
    required?: string[];
  };
  const fromBody = (tool.body ? bodySchemaFor(tool.body) : { properties: {} }) as {
    properties: Record<string, unknown>;
    required?: string[];
  };

  const properties: Record<string, unknown> = {
    ...fromParams.properties,
    ...fromBody.properties,
  };
  const required = [...(fromParams.required ?? []), ...(fromBody.required ?? [])];

  // Only on reads of one model: a write returns the record it changed, where
  // narrowing the answer would hide what was written.
  if (!tool.method && tool.model) {
    properties['fields'] = {
      type: 'array',
      // organisationId is left out: it is the same on every record a session
      // can see, so asking for it buys nothing, and the tenant is never
      // something a caller names.
      items: {
        type: 'string',
        enum: SAFE_FIELDS[tool.model].filter((field) => field !== 'organisationId'),
      },
      description:
        'Return only these fields of each record, to keep a long list short. The '
        + 'pagination figures are always returned.',
    };
  }

  if (tool.method) {
    properties['reason'] = {
      type: 'string',
      maxLength: 500,
      description: tool.destructive
        ? 'Why this is being removed. Required, and recorded against the action.'
        : 'Why the change is being made. Recorded against the action.',
    };
    if (tool.destructive) {
      required.push('reason');
      properties['approvalId'] = {
        type: 'string',
        description:
          'The approval identifier CharityPilot gave when it last refused this action. '
          + 'Include it after the person has approved it in their own terminal.',
      };
    }
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) schema['required'] = required;
  return schema;
}

/**
 * Splits a requested field list off the arguments, refusing anything the gate
 * would not release in the first place.
 */
function takeFields(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): { fields: string[]; rest: Record<string, unknown> } {
  if (!('fields' in args)) return { fields: [], rest: args };

  const { fields: requested, ...rest } = args;
  if (!tool.model) {
    throw new Error(`${tool.name} does not take a fields argument.`);
  }
  if (!Array.isArray(requested) || requested.some((field) => typeof field !== 'string')) {
    throw new Error('fields must be a list of field names.');
  }

  const safe = new Set(SAFE_FIELDS[tool.model]);
  const unknown = (requested as string[]).filter((field) => !safe.has(field));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.join(', ')} cannot be asked for on a ${tool.model}. Available: `
        + `${[...safe].join(', ')}.`,
    );
  }

  return { fields: requested as string[], rest };
}

export async function runTool(
  tool: ToolDefinition,
  client: ApiClient,
  allowPersonalData: boolean,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (!tool.method) {
    // Peeled off before the path is built: it shapes the answer here rather
    // than travelling to an API that has no such parameter.
    const { fields, rest } = takeFields(tool, args);
    const path = buildPath(tool.path, tool.params ?? [], rest);
    const raw = await client.get<unknown>(path);
    const filtered = stripKeys(applyPolicy(tool, raw, allowPersonalData), tool.redactAlways ?? []);
    return selectFields(filtered, fields);
  }

  const { pathArgs, bodyArgs, reason, approvalId } = partition(tool, args);

  // Checked here as well as in the listing, because a client may call a tool
  // it was never shown. The fields are the record: refusing them individually
  // would leave a tool that cannot produce a valid request.
  const gated = gatedFieldsInCall(tool, bodyArgs);
  if (gated.length > 0 && !allowPersonalData) {
    throw new ConnectorError(
      'PERSONAL_DATA_WITHHELD',
      `This call would write ${gated.join(', ')}, which the personal-data gate withholds `
        + `when reading a ${tool.model}. Writing them needs the connector started with `
        + '--allow-personal-data, which is a data-protection decision rather than a '
        + 'convenience. Nothing was sent. Fields the gate does not withhold can be changed '
        + 'without it.',
    );
  }

  // A reason is required for the actions that cannot be undone, and only for
  // those. Demanding one everywhere would train a caller to write filler.
  if (tool.destructive && !reason) {
    throw new ConnectorError(
      'REASON_REQUIRED',
      `${tool.name} removes something permanently. Pass a reason saying why, which is `
        + 'recorded against the action.',
      { action: 'fix_arguments' },
    );
  }

  // One route wants the reason in its body as well as in the header: voiding a
  // minute-book entry records why beside the entry, because the entry is kept
  // rather than removed. Without this the field would be peeled off as the
  // activity reason and the request would be refused for missing it.
  if (reason && tool.body?.some((field) => field.name === 'reason')) {
    bodyArgs['reason'] = reason;
  }

  const path = buildPath(tool.path, tool.params ?? [], pathArgs);
  const body = tool.body ? buildBody(tool.body, bodyArgs) : undefined;
  const options = { reason, approvalId };

  const raw =
    tool.method === 'DELETE'
      ? await client.delete<unknown>(path, options)
      : tool.method === 'POST'
        ? await client.post<unknown>(path, body ?? {}, options)
        : tool.method === 'PUT'
          ? await client.put<unknown>(path, body ?? {}, options)
          : await client.patch<unknown>(path, body ?? {}, options);

  // The response to a write is the record as it now stands, so it goes through
  // the same gate a read would. A write is not a way around the policy.
  return stripKeys(applyPolicy(tool, raw, allowPersonalData), tool.redactAlways ?? []);
}
