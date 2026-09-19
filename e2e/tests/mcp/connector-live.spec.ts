import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { API_BASE_URL } from '../../playwright.config';
import { withDb } from '../../helpers/db';
import {
  assertConnectorBuilt,
  connectConnector,
  runConnector,
  openConnector,
  callTool,
  storedRefreshToken,
  accessTokenFromStoredCredential,
  CONNECTOR_CLIENT_HEADER,
  type ConnectorAccessLevel,
} from '../../helpers/mcp-connector';
import {
  seedMcpFixture,
  PD_SENTINELS,
  TENANT_B_SENTINEL,
  type McpFixture,
} from '../../helpers/mcp-seed';

/**
 * Concern: the MCP connector against a real API. Every other connector test
 * stubs fetch, so this is the only place the sign-in, refresh rotation,
 * personal-data gate and tenant scoping are exercised end to end.
 *
 * No browser is used. The spec spawns the built connector over stdio and
 * speaks the same JSON-RPC an AI client speaks.
 */
test.describe.configure({ mode: 'serial' });

let fixture: McpFixture;
let credentialDir: string;

function credentialFileFor(label: string): string {
  return join(credentialDir, `${label}.json`);
}

function containsNone(haystack: string, secrets: string[]): boolean {
  return secrets.every((secret) => !haystack.includes(secret));
}

test.beforeAll(async () => {
  assertConnectorBuilt();
  credentialDir = mkdtempSync(join(tmpdir(), 'charitypilot-mcp-live-'));
  fixture = await seedMcpFixture({ apiUrl: API_BASE_URL });
});

test.describe('MCP connector lifecycle', () => {
  test('status reports no session before connect', async () => {
    const result = await runConnector(
      ['status', '--profile', 'local', '--base-url', API_BASE_URL],
      { credentialFile: credentialFileFor('lifecycle') },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Not connected');
  });

  test('connect names the account and organisation and leaks no token', async () => {
    const credentialFile = credentialFileFor('lifecycle');
    const result = await connectConnector({
      apiUrl: API_BASE_URL,
      email: fixture.owner.email,
      password: fixture.owner.password,
      credentialFile,
    });

    // Assert on the exit code, not on stderr being empty: Node writes its own
    // warnings there and an empty-string assertion would fail for reasons that
    // have nothing to do with the connector.
    expect(result.code, `connect failed: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(fixture.owner.email);
    expect(result.stdout).toContain('(OWNER)');
    expect(result.stdout).toContain('MCP Harness Charity');
    expect(result.stdout).toContain('withheld (default)');

    const token = storedRefreshToken(credentialFile);
    expect(token, 'a refresh token must be stored').toBeTruthy();
    expect(containsNone(result.stdout, [token!]), 'stdout must not echo the token').toBe(true);
    expect(containsNone(result.stderr, [token!]), 'stderr must not echo the token').toBe(true);
  });

  test('status afterwards names the same account and organisation', async () => {
    const result = await runConnector(
      ['status', '--profile', 'local', '--base-url', API_BASE_URL],
      { credentialFile: credentialFileFor('lifecycle') },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(fixture.owner.email);
    expect(result.stdout).toContain('MCP Harness Charity');
  });

  test('the advertised tools are exactly the read surface, and none takes an organisationId', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('lifecycle'),
    });
    try {
      const listed = await connector.client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      // Hardcoded on purpose: a list read from the artifact under test would
      // agree with it however wrong it became. Adding a tool means adding it
      // here, which is the moment to ask whether it should exist.
      expect(names).toEqual([
        'annual_report_readiness',
        'approval_readiness',
        'board_register',
        'board_submissions',
        'complaints_list',
        'compliance_principle',
        'compliance_principles',
        'compliance_record',
        'compliance_records',
        'compliance_signoff',
        'compliance_summary',
        'conflicts_list',
        'confluence_status',
        'dashboard_overview',
        'deadlines_history',
        'deadlines_list',
        'document',
        'documents_list',
        'financial_controls',
        'fundraising_list',
        'governing_acts',
        'governing_acts_voids',
        'members_list',
        'organisation',
        'registers_summary',
        'risks_list',
        'team_list',
      ]);
      expect(JSON.stringify(listed.tools)).not.toContain('organisationId');
    } finally {
      await connector.close();
    }
  });

  test('a fresh process refreshes the session, rotating the stored token', async () => {
    const credentialFile = credentialFileFor('lifecycle');
    const before = storedRefreshToken(credentialFile);
    expect(before).toBeTruthy();

    const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile });
    try {
      const result = await callTool(connector.client, 'compliance_summary');
      expect(result.isError, `compliance_summary failed: ${result.text}`).toBe(false);
    } finally {
      await connector.close();
    }

    const after = storedRefreshToken(credentialFile);
    expect(after).toBeTruthy();
    expect(after, 'refresh tokens are single-use and must rotate').not.toBe(before);
    expect(
      containsNone(connector.stderr(), [before!, after!]),
      'no refresh token may reach stderr',
    ).toBe(true);
  });

  test('an unknown tool is a clean error', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('lifecycle'),
    });
    try {
      const result = await callTool(connector.client, 'definitely_not_a_tool');
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/unknown tool/i);
      expect(result.text).not.toMatch(/\n\s+at /);
    } finally {
      await connector.close();
    }
  });

  test('disconnect revokes the session on the server, not just locally', async () => {
    const credentialFile = credentialFileFor('lifecycle');
    const token = storedRefreshToken(credentialFile);
    expect(token).toBeTruthy();

    const result = await runConnector(
      ['disconnect', '--profile', 'local', '--base-url', API_BASE_URL],
      { credentialFile },
    );
    expect(result.code, `disconnect failed: ${result.stderr}`).toBe(0);
    expect(storedRefreshToken(credentialFile)).toBeNull();

    const replay = await fetch(`${API_BASE_URL}/api/v1/auth/connector/refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
      },
      body: JSON.stringify({ refreshToken: token }),
    });
    expect(replay.status, 'the revoked token must be rejected by the API').toBe(401);
  });

  test('a tool call after disconnect asks for connect, without a stack trace', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('lifecycle'),
    });
    try {
      const result = await callTool(connector.client, 'compliance_summary');
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Not connected');
      expect(result.text).not.toMatch(/\n\s+at /);
    } finally {
      await connector.close();
    }
  });

  test('a password with an accented character signs in', async () => {
    const result = await connectConnector({
      apiUrl: API_BASE_URL,
      email: fixture.accentedOwner.email,
      password: fixture.accentedOwner.password,
      credentialFile: credentialFileFor('accented'),
    });
    expect(result.code, `accented connect failed: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(fixture.accentedOwner.email);
  });
});

const READ_TOOLS = [
  'approval_readiness',
  'board_register',
  'compliance_principles',
  'compliance_records',
  'compliance_summary',
  'dashboard_overview',
  'deadlines_history',
  'deadlines_list',
  'documents_list',
  'governing_acts',
] as const;

const BOARD_MEMBER_WITHHELD = [
  'dateOfBirth',
  'residentialAddress',
  'email',
  'formerNames',
  'otherDirectorships',
] as const;

async function connectAs(
  label: string,
  account: { email: string; password: string },
  accessLevel?: ConnectorAccessLevel,
): Promise<string> {
  const credentialFile = credentialFileFor(label);
  const result = await connectConnector({
    apiUrl: API_BASE_URL,
    email: account.email,
    password: account.password,
    credentialFile,
    ...(accessLevel ? { accessLevel } : {}),
  });
  expect(result.code, `connect as ${label} failed: ${result.stderr}`).toBe(0);
  return credentialFile;
}

test.describe('Personal-data gate, closed (the default)', () => {
  test('board_register returns the real envelope and withholds every personal field', async () => {
    const credentialFile = await connectAs('gate-closed', fixture.owner);
    const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile });
    try {
      const result = await callTool(connector.client, 'board_register');
      expect(result.isError, result.text).toBe(false);

      const body = result.json as { data: Array<Record<string, unknown>>; total: number };
      expect(Object.keys(body).sort()).toEqual(['data', 'hasMore', 'page', 'pageSize', 'total']);
      expect(body.total).toBe(3);
      expect(body.data).toHaveLength(3);
      expect(result.text).toContain('Aoife Chairperson');

      for (const record of body.data) {
        for (const field of BOARD_MEMBER_WITHHELD) {
          expect(record, `${field} must not reach the model`).not.toHaveProperty(field);
        }
      }
      for (const sentinel of PD_SENTINELS) {
        expect(result.text, `${sentinel} must not appear anywhere`).not.toContain(sentinel);
      }
    } finally {
      await connector.close();
    }
  });

  test('governing_acts withholds notes and resolutions', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('gate-closed'),
    });
    try {
      const result = await callTool(connector.client, 'governing_acts');
      expect(result.isError, result.text).toBe(false);
      expect(result.text).toContain('Quarterly board meeting');
      expect(result.text).not.toContain('PD-CANARY-NOTES');
      expect(result.text).not.toContain('PD-CANARY-RESOLUTION');
    } finally {
      await connector.close();
    }
  });

  test('documents_list returns metadata and never file bytes', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('gate-closed'),
    });
    try {
      const result = await callTool(connector.client, 'documents_list');
      expect(result.isError, result.text).toBe(false);
      expect(result.text).toContain('MCP harness constitution');
      expect(result.text).not.toContain('%PDF');
    } finally {
      await connector.close();
    }
  });

  test('every read tool succeeds and none returns the other charity', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('gate-closed'),
    });
    try {
      for (const name of READ_TOOLS) {
        const result = await callTool(connector.client, name);
        expect(result.isError, `${name} failed: ${result.text}`).toBe(false);
        expect(result.text, `${name} must not reach the other charity`).not.toContain(
          TENANT_B_SENTINEL,
        );
      }
    } finally {
      await connector.close();
    }
  });
});

test.describe('Personal-data gate, open', () => {
  test('the withheld fields really were there', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('gate-closed'),
      allowPersonalData: true,
    });
    try {
      const board = await callTool(connector.client, 'board_register');
      expect(board.isError, board.text).toBe(false);
      // Without this, every closed-gate assertion above could pass on data
      // that was never populated in the first place.
      for (const sentinel of [
        'PD-CANARY-ADDRESS',
        'PD-CANARY-FORMER',
        'PD-CANARY-DIRECTORSHIPS',
        '1968-03-14',
      ]) {
        expect(board.text, `${sentinel} must be present with the gate open`).toContain(sentinel);
      }

      const acts = await callTool(connector.client, 'governing_acts');
      expect(acts.text).toContain('PD-CANARY-NOTES');
      expect(acts.text).toContain('PD-CANARY-RESOLUTION');

      expect(board.text, 'the gate is about fields, never tenancy').not.toContain(
        TENANT_B_SENTINEL,
      );
    } finally {
      await connector.close();
    }
  });
});

test.describe('Tenant isolation', () => {
  test('the other charity sees its own trustee and never this one', async () => {
    const credentialFile = await connectAs('org-b', fixture.orgB);
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile,
      allowPersonalData: true,
    });
    try {
      const result = await callTool(connector.client, 'board_register');
      expect(result.isError, result.text).toBe(false);
      // Proves the sentinel is reachable at all, so its absence in the owner's
      // session is a real boundary rather than an empty organisation.
      expect(result.text).toContain(TENANT_B_SENTINEL);
      expect(result.text).not.toContain('Aoife Chairperson');
    } finally {
      await connector.close();
    }
  });
});

test.describe('Roles', () => {
  for (const role of ['admin', 'member'] as const) {
    test(`a ${role} reads every tool, and the closed gate still withholds`, async () => {
      const credentialFile = await connectAs(role, fixture[role]);
      const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile });
      try {
        for (const name of READ_TOOLS) {
          const result = await callTool(connector.client, name);
          expect(result.isError, `${name} failed for ${role}: ${result.text}`).toBe(false);
        }
        const board = await callTool(connector.client, 'board_register');
        for (const sentinel of PD_SENTINELS) {
          expect(board.text).not.toContain(sentinel);
        }
      } finally {
        await connector.close();
      }
    });
  }

  test('a member can open the gate, which the API does not police', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('member'),
      allowPersonalData: true,
    });
    try {
      const board = await callTool(connector.client, 'board_register');
      // Live evidence for the spec's open question to the data protection
      // officer: reads are not role-gated by the API, so the client-side flag
      // alone decides whether a trustee's home address reaches a model.
      expect(board.text).toContain('PD-CANARY-ADDRESS');
    } finally {
      await connector.close();
    }
  });
});

/* --- phase 1: every readable route, gated ------------------------------- */

/**
 * The tools that answer without arguments. Driven off what the connector
 * actually advertises rather than a list written here, so a tool added later
 * is covered without anyone remembering to add it — which is the failure this
 * suite exists to prevent.
 */
async function listedToolNames(credentialFile: string): Promise<string[]> {
  const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile });
  try {
    const listed = await connector.client.listTools();
    return listed.tools
      .filter((tool) => {
        const schema = tool.inputSchema as { required?: string[] } | undefined;
        return !schema?.required || schema.required.length === 0;
      })
      .map((tool) => tool.name);
  } finally {
    await connector.close();
  }
}

test.describe('Phase 1: the whole readable surface', () => {
  test('every tool that needs no arguments answers, and none leaks a sentinel', async () => {
    const credentialFile = await connectAs('phase1', fixture.owner);
    const names = await listedToolNames(credentialFile);
    expect(names.length, 'the connector should advertise the full read surface').toBeGreaterThan(20);

    const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile });
    try {
      for (const name of names) {
        const result = await callTool(connector.client, name);
        expect(result.isError, `${name} failed: ${result.text}`).toBe(false);

        for (const sentinel of PD_SENTINELS) {
          expect(
            result.text.includes(sentinel),
            `${name} leaked ${sentinel} through the closed gate`,
          ).toBe(false);
        }
        expect(result.text, `${name} reached the other charity`).not.toContain(TENANT_B_SENTINEL);
      }
    } finally {
      await connector.close();
    }
  });

  test('the register tools return their records with the identifying fields withheld', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('phase1'),
    });
    try {
      const risks = await callTool(connector.client, 'risks_list');
      expect(risks.isError, risks.text).toBe(false);
      expect(risks.text).toContain('Reliance on a single funder');
      expect(risks.text).toContain('FINANCIAL');

      const complaints = await callTool(connector.client, 'complaints_list');
      expect(complaints.isError, complaints.text).toBe(false);
      expect(complaints.text).toContain('OPEN');

      const fundraising = await callTool(connector.client, 'fundraising_list');
      expect(fundraising.isError, fundraising.text).toBe(false);
      expect(fundraising.text).toContain('Spring street collection');

      const members = await callTool(connector.client, 'members_list');
      expect(members.isError, members.text).toBe(false);
    } finally {
      await connector.close();
    }
  });

  test('the dashboard no longer carries activity free text or staff names', async () => {
    // The regression test for the gap this phase closed: the dashboard shipped
    // declaring no model at all, so its records went straight past the gate.
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('phase1'),
    });
    try {
      const closed = await callTool(connector.client, 'dashboard_overview');
      expect(closed.isError, closed.text).toBe(false);
      expect(closed.text, 'activity descriptions are free text naming people').not.toContain(
        'Updated board member',
      );
      expect(closed.text).not.toContain('PD-CANARY-DEADLINE-DESCRIPTION');
    } finally {
      await connector.close();
    }

    const open = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('phase1'),
      allowPersonalData: true,
    });
    try {
      const result = await callTool(open.client, 'dashboard_overview');
      expect(result.isError, result.text).toBe(false);
      // Proves the closed-gate absence above was a filter doing its job rather
      // than a dashboard that had nothing to show.
      expect(result.text).toContain('PD-CANARY-DEADLINE-DESCRIPTION');
    } finally {
      await open.close();
    }
  });

  test('the gate opens for every tool, proving the closed-gate absences were filtering', async () => {
    const credentialFile = credentialFileFor('phase1');
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile,
      allowPersonalData: true,
    });
    try {
      const seen = new Set<string>();
      for (const name of await listedToolNames(credentialFile)) {
        const result = await callTool(connector.client, name);
        expect(result.isError, `${name} failed with the gate open: ${result.text}`).toBe(false);
        for (const sentinel of PD_SENTINELS) {
          if (result.text.includes(sentinel)) seen.add(sentinel);
        }
      }
      // Not every sentinel is reachable without arguments, but a closed gate
      // that hid data nobody ever planted would prove nothing, so require most
      // of them to be visible once it is open.
      expect(seen.size, `only ${seen.size} sentinels were reachable with the gate open`)
        .toBeGreaterThan(10);
    } finally {
      await connector.close();
    }
  });

  test('pagination reaches the API rather than being quietly ignored', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('phase1'),
    });
    try {
      const first = await callTool(connector.client, 'board_register', { page: 1, pageSize: 2 });
      expect(first.isError, first.text).toBe(false);
      const firstPage = first.json as { data: unknown[]; hasMore: boolean; total: number };
      expect(firstPage.data).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.total).toBe(3);

      const second = await callTool(connector.client, 'board_register', { page: 2, pageSize: 2 });
      const secondPage = second.json as { data: unknown[]; hasMore: boolean };
      expect(secondPage.data).toHaveLength(1);
      expect(secondPage.hasMore).toBe(false);
      expect(JSON.stringify(secondPage.data)).not.toEqual(JSON.stringify(firstPage.data));
    } finally {
      await connector.close();
    }
  });

  test('an argument the tool does not declare is refused, not ignored', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('phase1'),
    });
    try {
      const result = await callTool(connector.client, 'board_register', { organisationId: 'other' });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/unknown argument/i);
      expect(result.text).not.toMatch(/\n\s+at /);

      const outOfRange = await callTool(connector.client, 'board_register', { pageSize: 5000 });
      expect(outOfRange.isError).toBe(true);
      expect(outOfRange.text).toMatch(/pageSize/);
    } finally {
      await connector.close();
    }
  });

  test('a tool taking an identifier fetches exactly that record', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('phase1'),
    });
    try {
      const missing = await callTool(connector.client, 'document');
      expect(missing.isError, 'the identifier is required').toBe(true);
      expect(missing.text).toMatch(/id/);

      const found = await callTool(connector.client, 'document', { id: fixture.ids.documentId });
      expect(found.isError, found.text).toBe(false);
      expect(found.text).toContain('MCP harness constitution');
      expect(found.text, 'file bytes are never returned').not.toContain('%PDF');
    } finally {
      await connector.close();
    }
  });

  test('a member is refused an administrator-only tool, with a clean message', async () => {
    const credentialFile = await connectAs('phase1-member', fixture.member);
    const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile });
    try {
      const result = await callTool(connector.client, 'confluence_status');
      expect(result.isError, 'a member must not read integration status').toBe(true);
      expect(result.text).toMatch(/403/);
      expect(result.text, 'an authorisation refusal is not a crash').not.toMatch(/\n\s+at /);
    } finally {
      await connector.close();
    }
  });
});

/**
 * Concern: the session posture the connector signs in with, enforced by the
 * API rather than by the connector.
 *
 * Every refusal here is provoked by posting directly with the session's own
 * access token, not through a tool. A connector that simply offered no write
 * tool would look identical from the outside, and would still leave the API
 * open to anything holding the credential.
 */
test.describe('Connector session posture', () => {
  const UNSAFE_PATH = '/api/v1/board-members';

  async function postAs(credentialFile: string): Promise<Response> {
    const accessToken = await accessTokenFromStoredCredential({
      apiUrl: API_BASE_URL,
      credentialFile,
    });
    return fetch(`${API_BASE_URL}${UNSAFE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
      },
      body: JSON.stringify({ name: 'Posture Probe', role: 'TRUSTEE' }),
    });
  }

  test('connect at read level says so, and the session still reads everything', async () => {
    const credentialFile = credentialFileFor('posture-read');
    const result = await connectConnector({
      apiUrl: API_BASE_URL,
      email: fixture.owner.email,
      password: fixture.owner.password,
      credentialFile,
      accessLevel: 'read',
    });
    expect(result.code, `connect failed: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Access level: READ');

    const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile });
    try {
      const summary = await callTool(connector.client, 'compliance_summary');
      expect(summary.isError, summary.text).toBe(false);
      const register = await callTool(connector.client, 'board_register');
      expect(register.isError, register.text).toBe(false);
    } finally {
      await connector.close();
    }
  });

  test('a read-level session is refused an unsafe method by the API itself', async () => {
    const response = await postAs(credentialFileFor('posture-read'));

    expect(response.status, 'a read session must not be able to write').toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe('SESSION_READ_ONLY');
  });

  test('a write-level session is allowed the same request, so the refusal was the level', async () => {
    const credentialFile = credentialFileFor('posture-write');
    const result = await connectConnector({
      apiUrl: API_BASE_URL,
      email: fixture.owner.email,
      password: fixture.owner.password,
      credentialFile,
      accessLevel: 'write',
    });
    expect(result.code, `connect failed: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Access level: WRITE');

    const response = await postAs(credentialFile);

    // The point is only that the read-only gate is not what stops it. Whatever
    // the route makes of the payload is the route's business.
    expect(response.status, 'a write session must get past the posture check').not.toBe(403);
  });

  test('a browser-shaped request to a connector route is refused before any credential is read', async () => {
    const body = JSON.stringify({
      email: fixture.owner.email,
      password: fixture.owner.password,
      accessLevel: 'ADMIN',
    });

    const noClientHeader = await fetch(`${API_BASE_URL}/api/v1/auth/connector/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(noClientHeader.status).toBe(403);
    expect(((await noClientHeader.json()) as { code?: string }).code)
      .toBe('BROWSER_CLIENT_REJECTED');

    const withOrigin = await fetch(`${API_BASE_URL}/api/v1/auth/connector/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
        origin: API_BASE_URL,
      },
      body,
    });
    expect(withOrigin.status, 'an origin is browser evidence even when it is allow-listed')
      .toBe(403);

    const withSecFetch = await fetch(`${API_BASE_URL}/api/v1/auth/connector/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
        'sec-fetch-site': 'same-origin',
      },
      body,
    });
    expect(withSecFetch.status).toBe(403);
  });

  test('a connector token is refused on the browser refresh route, and survives the attempt', async () => {
    const credentialFile = credentialFileFor('posture-write');
    const token = storedRefreshToken(credentialFile);
    expect(token).toBeTruthy();

    const crossChannel = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: API_BASE_URL },
      body: JSON.stringify({ refreshToken: token }),
    });
    expect(crossChannel.status, 'a keychain token must be useless in a browser').toBe(401);

    // The route clears cookies on any failure, so a Set-Cookie header is
    // expected here. What must not happen is a cookie carrying a value: the
    // refusal may expire a browser's session, never start one.
    const handed = crossChannel.headers.get('set-cookie') ?? '';
    for (const pair of handed.matchAll(/charitypilot_[a-z]+=([^;,]*)/g)) {
      expect(pair[1], `a cookie was handed back with a value: ${pair[0]}`).toBe('');
    }

    // A refusal is not a replay: the token was never spent, so the session
    // family must still be alive. Quarantining here would mean anyone who
    // could guess a token could log the owner out.
    const stillWorks = await accessTokenFromStoredCredential({
      apiUrl: API_BASE_URL,
      credentialFile,
    });
    expect(stillWorks.length).toBeGreaterThan(0);
  });

  test('a credential is not sent to a host other than the one that issued it', async () => {
    const credentialFile = credentialFileFor('posture-write');
    const otherHost = API_BASE_URL.replace('127.0.0.1', 'localhost');
    expect(otherHost, 'the test needs two spellings that are genuinely different origins')
      .not.toBe(API_BASE_URL);

    const result = await runConnector(
      ['status', '--profile', 'local', '--base-url', otherHost],
      { credentialFile },
    );

    expect(result.code, 'a redirected base URL must fail, not quietly connect').not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/issued by/i);
    expect(
      `${result.stdout}${result.stderr}`,
      'the refusal must not carry the credential it refused to send',
    ).not.toContain(storedRefreshToken(credentialFile) ?? 'unreachable');
  });
});

/**
 * Concern: the accountability that has to exist before the connector is given
 * authority. A record of what a client did, an administrator level for the
 * routes that destroy things, and a session the owner can see on the Team page.
 */
test.describe('Connector accountability', () => {
  // Signed in as the administrator rather than the owner. The connector sign-in
  // route limits attempts per email address, and by the time this block runs
  // the owner's address has been used for more sign-ins than that budget
  // allows; the failure looked like a wrong password, which is exactly the
  // confusion the connector's 429 message now avoids.
  const account = () => fixture.admin;

  // Created by the first test and deleted by the last. Deleting a seeded
  // record instead would quietly remove something the gate tests above read.
  let probeBoardMemberId = '';

  async function activityRows(sessionPattern: string) {
    return withDb(async (client) => {
      const result = await client.query(
        `SELECT "method", "routePattern", "statusCode", "accessLevel", "reason", "resourceId"
           FROM "ClientActivityEvent"
          WHERE "routePattern" LIKE $1
          ORDER BY "occurredAt" DESC, "id" DESC`,
        [sessionPattern],
      );
      return result.rows as Array<Record<string, unknown>>;
    });
  }

  test('a connector write leaves one row naming the route pattern and the reason', async () => {
    const credentialFile = credentialFileFor('accountability-write');
    const connected = await connectConnector({
      apiUrl: API_BASE_URL,
      email: account().email,
      password: account().password,
      credentialFile,
      accessLevel: 'write',
    });
    expect(connected.code, connected.stderr).toBe(0);

    const accessToken = await accessTokenFromStoredCredential({
      apiUrl: API_BASE_URL,
      credentialFile,
    });

    const before = (await activityRows('%/board-members%')).length;

    const response = await fetch(`${API_BASE_URL}/api/v1/board-members`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
        'x-charitypilot-reason': 'Adding the trustee the owner named',
      },
      body: JSON.stringify({ name: 'Activity Probe', role: 'Trustee', appointedDate: '2026-02-01' }),
    });
    // Read once: the body is a stream, and consuming it for the failure message
    // would leave nothing to parse the identifier out of.
    const created = (await response.json()) as { data?: { id?: string } };
    expect(response.status, JSON.stringify(created)).toBe(201);
    probeBoardMemberId = created.data?.id ?? '';
    expect(probeBoardMemberId).not.toBe('');

    const rows = await activityRows('%/board-members%');
    expect(rows.length, 'exactly one row per write').toBe(before + 1);

    const row = rows[0]!;
    expect(row['method']).toBe('POST');
    expect(row['routePattern'], 'the pattern, never the requested path').toBe('/api/v1/board-members');
    expect(row['statusCode']).toBe(201);
    expect(row['accessLevel']).toBe('WRITE');
    expect(row['reason']).toBe('Adding the trustee the owner named');
  });

  test('a read leaves no row, so the writes are not buried', async () => {
    const before = (await activityRows('%')).length;

    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('accountability-write'),
    });
    try {
      const result = await callTool(connector.client, 'board_register');
      expect(result.isError, result.text).toBe(false);
    } finally {
      await connector.close();
    }

    expect((await activityRows('%')).length).toBe(before);
  });

  test('a write-level session is refused a destructive route, and the refusal is recorded', async () => {
    const credentialFile = credentialFileFor('accountability-write');
    const accessToken = await accessTokenFromStoredCredential({
      apiUrl: API_BASE_URL,
      credentialFile,
    });

    const response = await fetch(
      `${API_BASE_URL}/api/v1/board-members/${probeBoardMemberId}`,
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${accessToken}`,
          [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
        },
      },
    );

    expect(response.status, 'deleting needs an administrator-level session').toBe(403);
    expect((await response.json()).code).toBe('SESSION_LEVEL_TOO_LOW');

    const rows = await activityRows('%/board-members%');
    const refusal = rows.find((row) => row['method'] === 'DELETE');
    expect(refusal, 'a refused attempt is the row most worth reading').toBeTruthy();
    expect(refusal!['statusCode']).toBe(403);
    expect(refusal!['resourceId']).toBe(probeBoardMemberId);
  });

  test('an administrator-level session is allowed the same route, so the refusal was the level', async () => {
    const credentialFile = credentialFileFor('accountability-admin');
    const connected = await connectConnector({
      apiUrl: API_BASE_URL,
      email: account().email,
      password: account().password,
      credentialFile,
      accessLevel: 'admin',
    });
    expect(connected.code, connected.stderr).toBe(0);
    expect(connected.stdout).toContain('Access level: ADMIN');

    const accessToken = await accessTokenFromStoredCredential({
      apiUrl: API_BASE_URL,
      credentialFile,
    });

    const response = await fetch(
      `${API_BASE_URL}/api/v1/board-members/${probeBoardMemberId}`,
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${accessToken}`,
          [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
        },
      },
    );

    expect(
      response.status,
      'an administrator-level session must get past the level check',
    ).not.toBe(403);
  });

  test('the owner can see the connector session on the Team page, and what it may do', async () => {
    const credentialFile = credentialFileFor('accountability-admin');
    const accessToken = await accessTokenFromStoredCredential({
      apiUrl: API_BASE_URL,
      credentialFile,
    });

    const response = await fetch(
      `${API_BASE_URL}/api/v1/team/members/${account().userId}/sessions`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
        },
      },
    );
    const sessions = (await response.json()) as Array<Record<string, unknown>>;
    expect(response.status, JSON.stringify(sessions)).toBe(200);
    const connectorSessions = sessions.filter(
      (session) => session['clientKind'] === 'MCP_CONNECTOR',
    );

    expect(
      connectorSessions.length,
      'a connector session the owner cannot see is one they cannot revoke',
    ).toBeGreaterThan(0);
    expect(
      connectorSessions.some((session) => session['accessLevel'] === 'ADMIN'),
      'the level must be shown, not just the kind',
    ).toBe(true);
    expect(
      sessions.every((session) => typeof session['accessLevel'] === 'string'),
      'every session reports a level',
    ).toBe(true);
  });
});
