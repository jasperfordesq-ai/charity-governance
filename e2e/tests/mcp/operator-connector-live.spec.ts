import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { API_BASE_URL } from '../../playwright.config';
import {
  createPlatformOperator,
  createVerifiedOwner,
  enrolOperatorSecondFactor,
  readOperatorApproval,
  readTenantLifecycle,
} from '../../helpers/db';
import { uniqueEmail } from '../../fixtures';
import {
  assertConnectorBuilt,
  connectConnector,
  openConnector,
  callTool,
  accessTokenFromStoredCredential,
  CONNECTOR_CLIENT_HEADER,
} from '../../helpers/mcp-connector';
import { fromBase32, totp } from '../../../apps/api/src/utils/totp';

/**
 * Concern: the operator connector against a real API.
 *
 * The claim is one sentence — a connector signed in as a platform operator can
 * administer every charity and cannot read inside any of them — and every unit
 * test of it stubs the boundary the claim is about. This is the only place the
 * operator sign-in, the mandatory second factor, the cross-realm refusals and
 * the approval round trip run end to end.
 *
 * No browser. The spec spawns the built connector over stdio and speaks the
 * same JSON-RPC an AI client speaks.
 */
test.describe.configure({ mode: 'serial' });

const OPERATOR_PASSWORD = 'OperatorConnector!2026';
const TENANT_PASSWORD = 'TenantOwner!2026';

let credentialDir = '';
let operatorEmail = '';
let operatorId = '';
let totpSecret = '';
let tenantId = '';
let tenantName = '';

function credentialFileFor(label: string): string {
  return join(credentialDir, `${label}.json`);
}

function code(): string {
  return totp(fromBase32(totpSecret));
}

test.beforeAll(async () => {
  assertConnectorBuilt();
  credentialDir = mkdtempSync(join(tmpdir(), 'charitypilot-operator-live-'));

  operatorEmail = uniqueEmail('operator-connector');
  const operator = await createPlatformOperator({
    email: operatorEmail,
    name: 'Connector Operator',
    password: OPERATOR_PASSWORD,
  });
  operatorId = operator.operatorId;

  tenantName = `Operator Probe Charity ${Date.now()}`;
  const owner = await createVerifiedOwner({
    email: uniqueEmail('operator-tenant'),
    password: TENANT_PASSWORD,
    name: 'Tenant Owner',
    organisationName: tenantName,
  });
  tenantId = owner.organisationId;
});

// ---------------------------------------------------------------------------
// The second factor is not optional
// ---------------------------------------------------------------------------

test('an operator with no authenticator cannot connect at all', async () => {
  // Before enrolment. The password is correct, and it is still refused: a
  // credential an agent installs, which can close a charity, may not rest on
  // a password alone.
  const result = await connectConnector({
    apiUrl: API_BASE_URL,
    email: operatorEmail,
    password: OPERATOR_PASSWORD,
    credentialFile: credentialFileFor('no-second-factor'),
    realm: 'operator',
    accessLevel: 'admin',
  });

  expect(result.code).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain('no authenticator enrolled');
  expect(`${result.stdout}${result.stderr}`).toContain('/owner/security');
});

test('a wrong authenticator code is refused once one is enrolled', async () => {
  totpSecret = await enrolOperatorSecondFactor(operatorId);

  const result = await connectConnector({
    apiUrl: API_BASE_URL,
    email: operatorEmail,
    password: OPERATOR_PASSWORD,
    credentialFile: credentialFileFor('wrong-code'),
    realm: 'operator',
    accessLevel: 'admin',
    code: '000000',
  });

  expect(result.code).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toMatch(/authenticator code/i);
});

test('the right code connects, and says what the realm cannot do', async () => {
  const result = await connectConnector({
    apiUrl: API_BASE_URL,
    email: operatorEmail,
    password: OPERATOR_PASSWORD,
    credentialFile: credentialFileFor('admin'),
    realm: 'operator',
    accessLevel: 'admin',
    code: code(),
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('PLATFORM OPERATOR');
  // The refusal is printed at connect, not discovered at the first tool call.
  expect(result.stdout).toContain('Personal data: NONE');
  expect(result.stdout).toContain('never reads');
});

// ---------------------------------------------------------------------------
// The wall
// ---------------------------------------------------------------------------

test('the advertised surface is the operator tools and session_info, and nothing else', async () => {
  const connector = await openConnector({
    apiUrl: API_BASE_URL,
    credentialFile: credentialFileFor('admin'),
    realm: 'operator',
  });
  try {
    const { tools } = await connector.client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual(
      [
        'session_info',
        'tenant_configuration',
        'tenant_configure',
        'tenant_create',
        'tenant_get',
        'tenant_history',
        'tenant_lifecycle',
        'tenant_list',
      ].sort(),
    );
  } finally {
    await connector.close();
  }
});

test('a charity tool is refused by name, and told which realm reads it', async () => {
  // Not advertised is not the same as not callable: the Model Context Protocol
  // does not stop a client calling a tool it was never shown.
  const connector = await openConnector({
    apiUrl: API_BASE_URL,
    credentialFile: credentialFileFor('admin'),
    realm: 'operator',
  });
  try {
    // Reads, writes and the reference resolver alike. board_member_delete is
    // included because a destructive charity tool reached from the operator
    // realm would be the worst version of this.
    for (const name of [
      'board_register',
      'conflicts_list',
      'documents_list',
      'governing_acts',
      'board_member_delete',
      'fetch',
      'search',
    ]) {
      const result = await callTool(connector.client, name, {});
      expect(result.isError, `${name} must be refused`).toBe(true);
      expect(result.text, `${name} must say which realm reads it`).toMatch(/platform operator/i);
      expect(result.text).toMatch(/charity realm/i);
    }
  } finally {
    await connector.close();
  }
});

test('a name that is no tool at all gets a different refusal from a charity tool', async () => {
  // The distinction matters. "Unknown tool" sends an agent looking for a
  // different spelling; the cross-realm refusal sends it to the right realm.
  const connector = await openConnector({
    apiUrl: API_BASE_URL,
    credentialFile: credentialFileFor('admin'),
    realm: 'operator',
  });
  try {
    const result = await callTool(connector.client, 'not_a_tool_at_all', {});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Unknown tool/i);
    expect(result.text).not.toMatch(/charity realm/i);
  } finally {
    await connector.close();
  }
});

test('session_info states the wall rather than leaving it to be inferred', async () => {
  const connector = await openConnector({
    apiUrl: API_BASE_URL,
    credentialFile: credentialFileFor('admin'),
    realm: 'operator',
  });
  try {
    const result = await callTool(connector.client, 'session_info', {});
    const info = result.json as Record<string, any>;

    expect(info.realm).toBe('operator');
    expect(info.operator.email).toBe(operatorEmail);
    expect(info.operator.secondFactorEnrolled).toBe(true);
    expect(info.session.dataScope).toBeNull();
    expect(String(info.scope.neverReaches)).toMatch(/no personal data/i);
  } finally {
    await connector.close();
  }
});

test('the tenant summary carries a count of users and never a user', async () => {
  const connector = await openConnector({
    apiUrl: API_BASE_URL,
    credentialFile: credentialFileFor('admin'),
    realm: 'operator',
  });
  try {
    const result = await callTool(connector.client, 'tenant_get', { id: tenantId });
    const text = result.text;

    expect(text).toContain(tenantName);
    // The charity's own owner is a real person with a real address, and the
    // operator realm must not be able to name them.
    expect(text).not.toContain('operator-tenant');
    expect(text).not.toMatch(/"users"\s*:\s*\[/);
  } finally {
    await connector.close();
  }
});

// ---------------------------------------------------------------------------
// The approval round trip, on the most destructive action in the product
// ---------------------------------------------------------------------------

let approvalId = '';

test('closing a charity is refused, and the charity is still open afterwards', async () => {
  const connector = await openConnector({
    apiUrl: API_BASE_URL,
    credentialFile: credentialFileFor('admin'),
    realm: 'operator',
  });
  try {
    const summary = await callTool(connector.client, 'tenant_get', { id: tenantId });
    const version = (summary.json as Record<string, any>)?.tenant?.lifecycleVersion
      ?? (summary.json as Record<string, any>)?.lifecycleVersion;
    expect(version, 'fixture assumption: the summary carries a lifecycle version').toBeTruthy();

    const result = await callTool(connector.client, 'tenant_lifecycle', {
      id: tenantId,
      action: 'CLOSE',
      reason: 'End to end proof that a refusal actually refuses.',
      expectedLifecycleVersion: version,
    });

    expect(result.isError).toBe(true);
    // The summary a person reads has to name the charity and say plainly what
    // closing means, or approving it is taking the agent's word for both.
    expect(result.text).toContain(tenantName);
    expect(result.text).toContain('CLOSE');
    expect(result.text).toMatch(/ends its access/i);
    // And it has to carry the command WITH the realm on it: running the
    // charity spelling would look up an approval that does not exist there.
    expect(result.text).toMatch(/charitypilot-mcp approve \S+ --realm operator/);

    const match = /charitypilot-mcp approve (\S+) --realm operator/.exec(result.text);
    approvalId = match?.[1] ?? '';
    expect(approvalId, 'the refusal must carry the approval identifier').toBeTruthy();
  } finally {
    await connector.close();
  }

  // The claim that matters. A charity closed while the agent is told it was
  // refused is the worst outcome of the two, and no unit test can see it.
  expect(await readTenantLifecycle(tenantId)).toBe('ACTIVE');
});

test('the approval exists, unapproved, and names the charity', async () => {
  const approval = await readOperatorApproval(approvalId);
  expect(approval).not.toBeNull();
  expect(approval?.approvedAt).toBeNull();
  expect(approval?.consumedAt).toBeNull();
  expect(approval?.resourceLabel).toBe(tenantName);
  expect(approval?.summary).toMatch(/CLOSE/);
});

test('a wrong password approves nothing', async () => {
  // Driven against the API rather than through the approve command, which
  // refuses a pipe by design. What is being checked is the server's rule.
  const accessToken = await accessTokenFromStoredCredential({
    apiUrl: API_BASE_URL,
    credentialFile: credentialFileFor('admin'),
    realm: 'operator',
  });

  const response = await fetch(`${API_BASE_URL}/api/v1/owner/auth/connector/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
    },
    body: JSON.stringify({ approvalId, password: 'NotTheOperatorPassword!' }),
  });

  expect(response.status).toBe(401);

  const approval = await readOperatorApproval(approvalId);
  expect(approval?.approvedAt).toBeNull();
  expect(await readTenantLifecycle(tenantId)).toBe('ACTIVE');
});

test('the right password approves it, and only that one action goes through', async () => {
  const accessToken = await accessTokenFromStoredCredential({
    apiUrl: API_BASE_URL,
    credentialFile: credentialFileFor('admin'),
    realm: 'operator',
  });

  const granted = await fetch(`${API_BASE_URL}/api/v1/owner/auth/connector/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
    },
    body: JSON.stringify({ approvalId, password: OPERATOR_PASSWORD }),
  });

  expect(granted.status).toBe(200);

  const approval = await readOperatorApproval(approvalId);
  expect(approval?.approvedAt).not.toBeNull();
  // Approved is not spent. The charity is still open until the action is
  // actually retried with the approval in hand.
  expect(approval?.consumedAt).toBeNull();
  expect(await readTenantLifecycle(tenantId)).toBe('ACTIVE');
});
