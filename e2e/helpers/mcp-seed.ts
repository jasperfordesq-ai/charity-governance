import { uniqueEmail } from '../fixtures';
import {
  createAuthenticatedStorageState,
  createVerifiedAdmin,
  createVerifiedMember,
  createVerifiedOwner,
  withDb,
} from './db';

export const MCP_TEST_PASSWORD = 'McpHarness!2026';
/** The password path has never been exercised with a multi-byte character. */
export const MCP_ACCENTED_PASSWORD = 'Siobhán!2026';

/**
 * Strings planted in withheld fields. The gate is asserted by substring over
 * the whole serialised tool result, not by key name, so a field that is
 * renamed, nested or echoed somewhere unexpected still fails the test.
 */
export const PD_SENTINELS = [
  'PD-CANARY-ADDRESS',
  'PD-CANARY-FORMER',
  'PD-CANARY-DIRECTORSHIPS',
  'PD-CANARY-NOTES',
  'PD-CANARY-RESOLUTION',
  'pd-canary-chair@example.org',
  '1968-03-14',
] as const;

export const TENANT_B_SENTINEL = 'TENANT-B-CANARY';

const CHAIR_PERSONAL_DATA: Record<string, string> = {
  email: 'pd-canary-chair@example.org',
  dateOfBirth: '1968-03-14',
  residentialAddress: 'PD-CANARY-ADDRESS, 12 Harbour Road, Dublin',
  formerNames: 'PD-CANARY-FORMER',
  otherDirectorships: 'PD-CANARY-DIRECTORSHIPS',
};

// The signature check in document-upload-validation.ts requires the bytes to
// begin "%PDF-", so a plain-text stand-in is rejected.
const MINIMAL_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
    + '2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n'
    + 'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);

export interface McpAccount {
  userId: string;
  organisationId: string;
  email: string;
  password: string;
}

export interface McpFixture {
  owner: McpAccount;
  accentedOwner: McpAccount;
  admin: McpAccount;
  member: McpAccount;
  orgB: McpAccount;
  ids: { chairId: string; actId: string; documentId: string };
  documentBytes: Buffer;
}

async function bearerFor(userId: string, organisationId: string): Promise<string> {
  const state = await createAuthenticatedStorageState({ userId, organisationId, role: 'OWNER' });
  const cookie = state.cookies.find((entry) => entry.name === 'charitypilot_access');
  if (!cookie) throw new Error('seedMcpFixture: no access cookie in the generated storage state');
  return cookie.value;
}

/** Seeding uses a Bearer token, which the API accepts without an Origin header. */
async function api<T>(
  apiUrl: string,
  token: string,
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const isForm = init.body instanceof FormData;
  const response = await fetch(`${apiUrl}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
    },
    body: isForm
      ? (init.body as FormData)
      : init.body === undefined
        ? undefined
        : JSON.stringify(init.body),
  });
  if (!response.ok) {
    throw new Error(
      `seedMcpFixture: ${init.method} ${path} returned ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function useCompletePlan(organisationId: string): Promise<void> {
  // governance-registers, governing-acts and members are gated by
  // requireCompletePlan, so a plan gate must not be mistaken for a role result.
  const changed = await withDb(async (client) => {
    const result = await client.query(
      `UPDATE "Subscription" SET "plan" = 'COMPLETE', "updatedAt" = NOW() WHERE "organisationId" = $1`,
      [organisationId],
    );
    return result.rowCount ?? 0;
  });
  if (changed !== 1) throw new Error('seedMcpFixture: expected exactly one subscription to update');
}

export async function seedMcpFixture(options: { apiUrl: string }): Promise<McpFixture> {
  const { apiUrl } = options;
  const run = Date.now();

  const ownerEmail = uniqueEmail('mcp-owner');
  const owner = await createVerifiedOwner({
    email: ownerEmail,
    password: MCP_TEST_PASSWORD,
    name: 'MCP Harness Owner',
    organisationName: 'MCP Harness Charity',
  });
  await useCompletePlan(owner.organisationId);

  const accentedEmail = uniqueEmail('mcp-accent');
  const accentedOwner = await createVerifiedOwner({
    email: accentedEmail,
    password: MCP_ACCENTED_PASSWORD,
    name: 'MCP Accent Owner',
    organisationName: 'MCP Accent Charity',
  });

  const adminEmail = uniqueEmail('mcp-admin');
  const admin = await createVerifiedAdmin({
    email: adminEmail,
    name: 'MCP Harness Admin',
    organisationId: owner.organisationId,
    password: MCP_TEST_PASSWORD,
  });

  const memberEmail = uniqueEmail('mcp-member');
  const member = await createVerifiedMember({
    email: memberEmail,
    name: 'MCP Harness Member',
    organisationId: owner.organisationId,
    password: MCP_TEST_PASSWORD,
  });

  const token = await bearerFor(owner.userId, owner.organisationId);

  const chair = await api<{ data: { id: string } }>(apiUrl, token, '/api/v1/board-members', {
    method: 'POST',
    body: { name: 'Aoife Chairperson', role: 'Chair', appointedDate: '2024-01-15' },
  });

  // BoardMemberService.create builds its own column list and silently drops
  // dateOfBirth, residentialAddress, formerNames and otherDirectorships. Only
  // the update path spreads them. Without this PATCH the personal-data
  // assertions would pass against fields that were never populated.
  await api(apiUrl, token, `/api/v1/board-members/${chair.data.id}`, {
    method: 'PATCH',
    body: CHAIR_PERSONAL_DATA,
  });

  const chairAfterPatch = await api<{ data: Record<string, unknown> }>(
    apiUrl,
    token,
    `/api/v1/board-members/${chair.data.id}`,
    { method: 'GET' },
  );
  for (const field of Object.keys(CHAIR_PERSONAL_DATA)) {
    const expected = CHAIR_PERSONAL_DATA[field] as string;
    const actual = chairAfterPatch.data[field];
    if (typeof actual !== 'string' || !actual.startsWith(expected.slice(0, 10))) {
      throw new Error(
        `seedMcpFixture: ${field} did not persist (got ${JSON.stringify(actual)}). `
          + 'Every gate assertion would pass vacuously, so seeding fails here instead.',
      );
    }
  }

  await api(apiUrl, token, '/api/v1/board-members', {
    method: 'POST',
    body: { name: 'Brendan Treasurer', role: 'Treasurer', appointedDate: '2024-02-01' },
  });
  await api(apiUrl, token, '/api/v1/board-members', {
    method: 'POST',
    body: {
      name: 'Ciara Past-Trustee',
      role: 'Trustee',
      appointedDate: '2020-01-01',
      isActive: false,
    },
  });

  const act = await api<{ data: { id: string } }>(apiUrl, token, '/api/v1/governing-acts', {
    method: 'POST',
    body: {
      kind: 'BOARD_MEETING',
      actDate: '2026-03-02',
      // reference is unique per organisation, so it must differ between runs.
      reference: `MCP-ACT-${run}`,
      title: 'Quarterly board meeting',
      notes: 'PD-CANARY-NOTES',
    },
  });
  await api(apiUrl, token, `/api/v1/governing-acts/${act.data.id}/resolutions`, {
    method: 'POST',
    body: { text: 'PD-CANARY-RESOLUTION', carried: true },
  });

  await api(apiUrl, token, '/api/v1/governance-registers/conflicts', {
    method: 'POST',
    body: {
      boardMemberId: chair.data.id,
      trusteeName: 'Aoife Chairperson',
      matter: 'PD-CANARY-MATTER',
      nature: 'Supplier relationship with a firm under consideration.',
      dateDeclared: '2026-03-02',
      actionTaken: 'Declared at the outset and recused from the vote.',
    },
  });

  await api(apiUrl, token, '/api/v1/deadlines', {
    method: 'POST',
    // dueDate is civilDateSchema: date-only, never a datetime string.
    body: { title: 'MCP harness deadline', dueDate: '2026-12-31' },
  });

  const form = new FormData();
  form.append('name', 'MCP harness constitution');
  form.append('category', 'CONSTITUTION');
  form.append(
    'file',
    new Blob([new Uint8Array(MINIMAL_PDF)], { type: 'application/pdf' }),
    'mcp-harness.pdf',
  );
  const document = await api<{ data: { id: string } }>(apiUrl, token, '/api/v1/documents', {
    method: 'POST',
    body: form,
  });

  const orgBEmail = uniqueEmail('mcp-orgb');
  const orgB = await createVerifiedOwner({
    email: orgBEmail,
    password: MCP_TEST_PASSWORD,
    name: 'Other Charity Owner',
    organisationName: 'Other Charity',
  });
  const orgBToken = await bearerFor(orgB.userId, orgB.organisationId);
  await api(apiUrl, orgBToken, '/api/v1/board-members', {
    method: 'POST',
    body: { name: TENANT_B_SENTINEL, role: 'Chair', appointedDate: '2024-01-15' },
  });

  return {
    owner: { ...owner, email: ownerEmail, password: MCP_TEST_PASSWORD },
    accentedOwner: { ...accentedOwner, email: accentedEmail, password: MCP_ACCENTED_PASSWORD },
    admin: {
      userId: admin.userId,
      organisationId: admin.organisationId,
      email: adminEmail,
      password: MCP_TEST_PASSWORD,
    },
    member: {
      userId: member.userId,
      organisationId: member.organisationId,
      email: memberEmail,
      password: MCP_TEST_PASSWORD,
    },
    orgB: { ...orgB, email: orgBEmail, password: MCP_TEST_PASSWORD },
    ids: { chairId: chair.data.id, actId: act.data.id, documentId: document.data.id },
    documentBytes: MINIMAL_PDF,
  };
}
