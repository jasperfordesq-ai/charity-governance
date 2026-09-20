import type { ToolDefinition } from './tools.js';

/**
 * The platform operator's tools.
 *
 * This is the whole surface of the operator realm. It is not added to the
 * charity tools; it REPLACES them. A connector connected with
 * `--realm operator` offers these six and nothing else, and refuses every
 * charity tool by name even though it was never advertised.
 *
 * ## Why there is no tool here that reads a charity's records
 *
 * CharityPilot is a processor. Each charity is the controller of its own
 * trustee, conflict, staff and document data, and a processor may act on that
 * data only on the controller's documented instructions. An operator browsing
 * a charity's register because they can is not that.
 *
 * The practical consequence is the same as the legal one. A platform whose
 * operator can read any customer's trustee register at will does not pass an
 * enterprise data-protection review, and this product is meant to pass one.
 *
 * So the operator realm administers charities and never reads inside them.
 * The tenant summary below is the whole of what it can see about one: a name,
 * two registration numbers, a lifecycle status, a plan, and a COUNT of users.
 * Not the users.
 *
 * To read one charity's records, connect to that charity in the charity realm,
 * as a person who belongs to it, with that charity's knowledge. That is a
 * different credential and a different tool set, and the difference is the
 * point.
 */

const APPROVAL_NOTE =
  ' Every operator change is confirmed by a person at a terminal before it happens: '
  + 'CharityPilot answers with an identifier and a command to run.';

const LIFECYCLE_VERSION =
  'The lifecycleVersion from tenant_get, read just now. CharityPilot refuses the '
  + 'change if the charity\'s lifecycle moved in the meantime.';

export const OPERATOR_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'tenant_list',
    description:
      'Every charity on this platform: name, registration numbers, lifecycle status, plan, '
      + 'subscription status and how many user accounts each has. Never any of their records '
      + 'and never any person. Filter by status, or search by name with q.',
    path: '/api/v1/owner/tenants',
    params: [
      { kind: 'text', name: 'q', max: 200, describe: 'Part of a charity name to search for.' },
      {
        kind: 'enum',
        name: 'status',
        values: ['ACTIVE', 'SUSPENDED', 'CLOSED'],
      },
      { kind: 'count', name: 'limit', min: 1, max: 100, describe: 'How many to return.' },
      { kind: 'text', name: 'cursor', max: 64, describe: 'The cursor from a previous page.' },
    ],
    noRecordsBecause:
      'A tenant summary is administrative: a name, registration numbers, a lifecycle '
      + 'status, a plan and a count of user accounts. It carries no governance record '
      + 'and nobody\'s personal data, which is the defining property of this realm.',
  },
  {
    name: 'tenant_get',
    description:
      'One charity\'s administrative summary by identifier, including the lifecycleVersion '
      + 'that tenant_lifecycle requires. Carries no governance records and no personal data.',
    path: '/api/v1/owner/tenants/:id',
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause:
      'The same administrative summary tenant_list returns, for one charity.',
  },
  {
    name: 'tenant_history',
    description:
      'What platform operators have done to one charity: suspensions, reactivations, '
      + 'closures and configuration changes, each with who did it and the reason they gave. '
      + 'Only operator actions — this is not the charity\'s own activity record, which an '
      + 'operator has no business reading.',
    path: '/api/v1/owner/tenants/:id/history',
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause:
      'Administrative events caused by operators, filtered to that actor kind by the API. '
      + 'The actor named is the operator, not anyone at the charity.',
  },
  {
    name: 'tenant_configuration',
    description:
      'One charity\'s platform configuration: its plan, and which document storage provider '
      + 'it uses. Read this before changing it, so you are changing what you think you are.',
    path: '/api/v1/owner/tenants/:id/configuration',
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause:
      'Platform configuration: a plan name and a storage provider. No records, no people.',
  },
  {
    name: 'tenant_create',
    description:
      'Provision a new charity on this platform, with its first owner account.' + APPROVAL_NOTE,
    path: '/api/v1/owner/tenants',
    method: 'POST',
    level: 'write',
    noRecordsBecause:
      'Creates an organisation and invites its first owner. The owner\'s name and email '
      + 'are supplied by the operator provisioning the account, not read out of any '
      + 'charity\'s records.',
    body: [
      { kind: 'string', name: 'organisationName', max: 200, required: true },
      { kind: 'string', name: 'ownerName', max: 200, required: true },
      {
        kind: 'string',
        name: 'ownerEmail',
        max: 254,
        required: true,
        describe: 'Where the invitation to set a password is sent.',
      },
      { kind: 'enum', name: 'plan', values: ['ESSENTIALS', 'COMPLETE'], required: true },
      {
        kind: 'enum',
        name: 'billing',
        values: ['trial', 'comped'],
        describe: 'Defaults to trial. A comped tenant takes no trialDays.',
      },
      {
        kind: 'integer',
        name: 'trialDays',
        min: 1,
        max: 365,
        describe: 'Required for trial billing, and refused for comped.',
      },
    ],
  },
  {
    name: 'tenant_configure',
    description:
      'Change one charity\'s plan or document storage provider. Omitted fields are left '
      + 'alone, so a change to the plan cannot reset the storage provider by accident.'
      + APPROVAL_NOTE,
    path: '/api/v1/owner/tenants/:id/configuration',
    method: 'PATCH',
    level: 'write',
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause: 'Changes a plan and a storage provider. No records, no people.',
    body: [
      { kind: 'enum', name: 'plan', values: ['ESSENTIALS', 'COMPLETE'] },
      {
        kind: 'string',
        name: 'documentStorageProvider',
        max: 64,
        describe: 'The provider key, or omit to leave it as it is.',
      },
      { kind: 'boolean', name: 'documentStorageAlphaOptIn' },
      {
        kind: 'string',
        name: 'reason',
        max: 500,
        required: true,
        control: true,
        describe: 'Why. Recorded against the charity and readable in tenant_history.',
      },
    ],
  },
  {
    name: 'tenant_lifecycle',
    description:
      'Suspend, reactivate or CLOSE a charity. Closing ends its access to CharityPilot and '
      + 'is where data-retention obligations begin; it is the most destructive action in the '
      + 'product and it is not reversible through this connector.' + APPROVAL_NOTE,
    path: '/api/v1/owner/tenants/:id/lifecycle',
    method: 'POST',
    // ADMIN rather than write. Closing a charity is not an ordinary change,
    // and the level has to be chosen deliberately at connect to reach it.
    level: 'admin',
    destructive: true,
    params: [{ kind: 'id', name: 'id' }],
    noRecordsBecause:
      'Moves a charity between lifecycle states. It reads and writes no record inside one.',
    body: [
      {
        kind: 'enum',
        name: 'action',
        values: ['SUSPEND', 'REACTIVATE', 'CLOSE'],
        required: true,
      },
      {
        kind: 'string',
        name: 'reason',
        max: 1000,
        required: true,
        control: true,
        describe: 'Why. Recorded against the charity and readable in tenant_history.',
      },
      {
        kind: 'integer',
        name: 'expectedLifecycleVersion',
        min: 1,
        max: 1_000_000,
        required: true,
        control: true,
        describe: LIFECYCLE_VERSION,
      },
    ],
  },
];

/** The tool names this realm offers, for the refusal message when one is not. */
export const OPERATOR_TOOL_NAMES: readonly string[] = OPERATOR_TOOLS.map((tool) => tool.name);
