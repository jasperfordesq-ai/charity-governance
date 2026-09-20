import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

  test('the advertised tools are exactly the surface this session may use, and none takes an organisationId', async () => {
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
        'annual_report_set',
        'approval_readiness',
        'board_member_create',
        'board_member_delete',
        'board_member_update',
        'board_register',
        'board_submissions',
        'complaint_delete',
        'complaint_update',
        'complaints_list',
        'compliance_principle',
        'compliance_principles',
        'compliance_record',
        'compliance_record_set',
        'compliance_records',
        'compliance_signoff',
        'compliance_signoff_set',
        'compliance_summary',
        'conflict_delete',
        'conflict_update',
        'conflicts_list',
        'confluence_status',
        'dashboard_overview',
        'deadline_create',
        'deadline_delete',
        'deadline_update',
        'deadlines_history',
        'deadlines_list',
        'document',
        'document_approval_set',
        'document_delete',
        'document_link_standard',
        'document_unlink_standard',
        'documents_list',
        'financial_controls',
        'financial_controls_set',
        'fundraising_create',
        'fundraising_delete',
        'fundraising_list',
        'fundraising_update',
        'governing_act_create',
        'governing_act_update',
        'governing_acts',
        'governing_acts_voids',
        'member_update',
        'members_list',
        'organisation',
        'organisation_update',
        'registers_summary',
        'resolution_update',
        'risk_delete',
        'risk_update',
        'risks_list',
        'session_info',
        'team_list',
      ]);
      // The tenant is never an argument. Output schemas do name organisationId,
      // because records carry it, so only what a client may SEND is checked.
      expect(JSON.stringify(listed.tools.map((tool) => tool.inputSchema))).not.toContain('organisationId');
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
      // The API's own code is named, and the connector says what it means for
      // the agent: a role refusal, which no re-connection changes.
      expect(result.text).toMatch(/FORBIDDEN/);
      expect(result.text).toMatch(/role does not allow/);
      expect(result.text, 'an authorisation refusal is not a crash').not.toMatch(/\n\s+at /);
    } finally {
      await connector.close();
    }
  });
});

/**
 * Concern: what the connector tells a client beyond the tools, so an agent
 * that has never met CharityPilot can use it from the first call. These read
 * the advertised list rather than a hand-written one, so a tool added later is
 * covered without anyone remembering.
 */
test.describe('Phase B: legible to the agent', () => {
  // The lifecycle block disconnects its credential on purpose, so this block
  // reuses the owner's Phase 1 credential, which stays connected. It does not
  // sign in again: the API allows five sign-ins per email a minute, and the
  // suite already spends most of them.
  let phaseBCredential = '';

  test('the server carries instructions, and every tool carries annotations', async () => {
    phaseBCredential = credentialFileFor('phase1');
    const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile: phaseBCredential });
    try {
      expect(connector.client.getInstructions() ?? '').toContain('session_info');
      const listed = await connector.client.listTools();
      for (const tool of listed.tools) {
        const annotations = tool.annotations as { readOnlyHint?: unknown; destructiveHint?: unknown } | undefined;
        expect(typeof annotations?.readOnlyHint, tool.name).toBe('boolean');
        expect(typeof annotations?.destructiveHint, tool.name).toBe('boolean');
      }
      const remove = listed.tools.find((tool) => tool.name === 'board_member_delete');
      expect((remove?.annotations as { destructiveHint?: boolean } | undefined)?.destructiveHint).toBe(true);
    } finally {
      await connector.close();
    }
  });

  test('every argument-free tool answers with structured content equal to its text', async () => {
    const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile: phaseBCredential });
    try {
      const listed = await connector.client.listTools();
      const argumentFree = listed.tools.filter((tool) => {
        const schema = tool.inputSchema as { required?: string[] };
        const changes = /_(delete|set|create|update|void|upload|download)$/.test(tool.name);
        return !(schema.required?.length) && !changes;
      });
      expect(argumentFree.length).toBeGreaterThan(20);
      for (const tool of argumentFree) {
        const result = await callTool(connector.client, tool.name);
        expect(result.isError, `${tool.name}: ${result.text}`).toBe(false);
        expect(result.structured, tool.name).toEqual(result.json);
      }
    } finally {
      await connector.close();
    }
  });

  test('an error is structured with a code and an action', async () => {
    const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile: phaseBCredential });
    try {
      const result = await callTool(connector.client, 'document', { id: 'no-such-document' });
      expect(result.isError).toBe(true);
      const structured = result.structured as Record<string, unknown>;
      expect(structured['code']).toBe('DOCUMENT_NOT_FOUND');
      expect(structured['action']).toBe('fix_arguments');
    } finally {
      await connector.close();
    }
  });

  test('session_info names the charity and the level, and withholds the person until the gate opens', async () => {
    const closed = await openConnector({ apiUrl: API_BASE_URL, credentialFile: phaseBCredential });
    try {
      const info = await callTool(closed.client, 'session_info');
      expect(info.isError, info.text).toBe(false);
      expect(info.text).toContain('MCP Harness Charity');
      expect(info.text).toContain('"role": "OWNER"');
      // The local profile's default level is admin; the API, not the flag, is
      // what this reports, which the read-level status test proves separately.
      expect(info.text).toContain('"accessLevel": "admin"');
      expect(info.text).toContain('"accessLevelNote": "As the API reports it."');
      expect(info.text).not.toContain(fixture.owner.email);
    } finally {
      await closed.close();
    }
    const open = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: phaseBCredential,
      allowPersonalData: true,
    });
    try {
      const info = await callTool(open.client, 'session_info');
      expect(info.text).toContain(fixture.owner.email);
    } finally {
      await open.close();
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

    // Run WITHOUT the flag: status must report the level the API holds, not
    // the default the flag would supply.
    const status = await runConnector(
      ['status', '--profile', 'local', '--base-url', API_BASE_URL],
      { credentialFile },
    );
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout, 'status must report the level the API holds, not the default flag')
      .toContain('Access level: READ');

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

/**
 * Concern: writing from the connector, and the approval that gates the half of
 * it that cannot be undone.
 *
 * Driven through the connector over stdio, the way an assistant drives it, so
 * what is proved is the thing a person would actually experience.
 */
test.describe('Connector writes and approval', () => {
  let writeCredentialFile = '';
  let adminCredentialFile = '';
  let createdRiskId = '';

  async function latestApprovals() {
    return withDb(async (client) => {
      const result = await client.query(
        `SELECT "id", "summary", "approvedAt", "consumedAt", "sessionFamilyId", "routePattern"
           FROM "AuthActionApproval"
          ORDER BY "createdAt" DESC
          LIMIT 5`,
      );
      return result.rows as Array<Record<string, unknown>>;
    });
  }

  test('a read-level session is offered no tool that changes anything', async () => {
    const credentialFile = credentialFileFor('writes-read');
    const connected = await connectConnector({
      apiUrl: API_BASE_URL,
      email: fixture.writer.email,
      password: fixture.writer.password,
      credentialFile,
      accessLevel: 'read',
    });
    expect(connected.code, connected.stderr).toBe(0);

    const connector = await openConnector({ apiUrl: API_BASE_URL, credentialFile });
    try {
      const names = (await connector.client.listTools()).tools.map((tool) => tool.name);

      expect(names.length).toBeGreaterThan(20);
      expect(names).not.toContain('deadline_create');
      expect(names).not.toContain('board_member_delete');
    } finally {
      await connector.close();
    }
  });

  test('a tool that was never advertised is still refused when called', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('writes-read'),
    });
    try {
      const result = await callTool(connector.client, 'deadline_create', {
        title: 'Should never exist',
        dueDate: '2026-12-01',
      });

      expect(result.isError, 'hiding a tool is not the same as refusing it').toBe(true);
      expect(result.text).toMatch(/needs a session with write access/);
      expect(result.text).toMatch(/Nothing was sent/);
    } finally {
      await connector.close();
    }
  });

  test('a write-level session creates a record through a tool', async () => {
    writeCredentialFile = credentialFileFor('writes-write');
    const connected = await connectConnector({
      apiUrl: API_BASE_URL,
      email: fixture.writer.email,
      password: fixture.writer.password,
      credentialFile: writeCredentialFile,
      accessLevel: 'write',
    });
    expect(connected.code, connected.stderr).toBe(0);

    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: writeCredentialFile,
    });
    try {
      const result = await callTool(connector.client, 'deadline_create', {
        title: 'Written by the connector',
        dueDate: '2026-12-01',
        reason: 'Proving the write path end to end',
      });
      expect(result.isError, result.text).toBe(false);

      const created = result.json as { data?: { id?: string; title?: string } };
      expect(created.data?.id, 'the created record must come back').toBeTruthy();
      expect(created.data?.title).toBe('Written by the connector');

      const listed = await callTool(connector.client, 'deadlines_list');
      expect(listed.text).toContain('Written by the connector');
    } finally {
      await connector.close();
    }
  });

  test('the write left an activity row naming the route and the reason', async () => {
    const rows = await withDb(async (client) => {
      const result = await client.query(
        `SELECT "method", "routePattern", "statusCode", "reason"
           FROM "ClientActivityEvent"
          WHERE "routePattern" LIKE '%/deadlines'
          ORDER BY "occurredAt" DESC LIMIT 1`,
      );
      return result.rows as Array<Record<string, unknown>>;
    });

    expect(rows.length).toBe(1);
    expect(rows[0]!['method']).toBe('POST');
    expect(rows[0]!['statusCode']).toBe(201);
    expect(rows[0]!['reason']).toBe('Proving the write path end to end');
  });

  test('a field the tool does not declare is refused rather than forwarded', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: writeCredentialFile,
    });
    try {
      const result = await callTool(connector.client, 'deadline_create', {
        title: 'Should not be created',
        dueDate: '2026-12-02',
        organisationId: 'some-other-charity',
      });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/Unknown field "organisationId"/);
    } finally {
      await connector.close();
    }
  });

  test('creating a record that needs withheld fields is refused while the gate is closed', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: writeCredentialFile,
    });
    try {
      const names = (await connector.client.listTools()).tools.map((tool) => tool.name);
      expect(
        names,
        'a tool that could only ever be refused should not be advertised',
      ).not.toContain('risk_create');

      const refused = await callTool(connector.client, 'risk_create', {
        title: 'Should never be created',
        category: 'GOVERNANCE',
        description: 'Names a member of staff',
        likelihood: 1,
        impact: 1,
        mitigation: 'None',
        reason: 'Proving the write gate',
      });

      expect(refused.isError, 'hiding a tool is not refusing it').toBe(true);
      expect(refused.text).toMatch(/personal-data gate withholds/);
      expect(refused.text).toMatch(/Nothing was sent/);
    } finally {
      await connector.close();
    }
  });

  test('an update that touches only safe fields is allowed with the gate closed', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: writeCredentialFile,
    });
    try {
      const names = (await connector.client.listTools()).tools.map((tool) => tool.name);
      expect(
        names,
        'an update that can change a status alone must stay available',
      ).toContain('risk_update');
    } finally {
      await connector.close();
    }
  });

  test('a removal is refused, with something for a person to run', async () => {
    adminCredentialFile = credentialFileFor('writes-admin');
    const connected = await connectConnector({
      apiUrl: API_BASE_URL,
      email: fixture.writer.email,
      password: fixture.writer.password,
      credentialFile: adminCredentialFile,
      accessLevel: 'admin',
    });
    expect(connected.code, connected.stderr).toBe(0);

    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: adminCredentialFile,
      // A risk record cannot be created without its description and
      // mitigation, both of which the gate withholds when reading one.
      allowPersonalData: true,
    });
    try {
      const made = await callTool(connector.client, 'risk_create', {
        title: 'Risk created so it can be removed',
        category: 'GOVERNANCE',
        description: 'Exists only for this test',
        likelihood: 1,
        impact: 1,
        mitigation: 'None needed',
        reason: 'Setting up the approval test',
      });
      expect(made.isError, made.text).toBe(false);
      createdRiskId = (made.json as { data: { id: string } }).data.id;

      const refused = await callTool(connector.client, 'risk_delete', {
        id: createdRiskId,
        reason: 'Removing the record this test created',
      });

      expect(refused.isError, 'a removal must not just happen').toBe(true);
      expect(refused.text).toMatch(/charitypilot-mcp approve /);
      expect(refused.text).toMatch(/will not do this until you approve it yourself/);
      expect(refused.text, 'the refusal names the record being removed')
        .toContain('Risk created so it can be removed');
      expect(refused.text).toMatch(/exactly the same arguments plus approvalId: /);

      const pending = await latestApprovals();
      expect(pending.length, 'an approval was minted for the action').toBeGreaterThan(0);
      expect(pending[0]!['approvedAt'], 'nothing approves it but the password route').toBeNull();
    } finally {
      await connector.close();
    }
  });

  test('the approval can be read back by its owner and by nobody else', async () => {
    const pending = await latestApprovals();
    const approvalId = String(pending[0]!['id']);

    // The admin credential belongs to the writer, who asked for the removal.
    const ownToken = await accessTokenFromStoredCredential({
      apiUrl: API_BASE_URL,
      credentialFile: adminCredentialFile,
    });
    const own = await fetch(`${API_BASE_URL}/api/v1/auth/connector/approvals/${approvalId}`, {
      headers: { authorization: `Bearer ${ownToken}`, [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0' },
    });
    expect(own.status).toBe(200);
    const body = (await own.json()) as Record<string, unknown>;
    expect(String(body['summary'])).toContain('Risk created so it can be removed');
    expect(body['resourceId']).toBe(createdRiskId);
    expect(body['approvedAt']).toBeNull();

    // The owner, still connected from Phase 1: same charity, different person
    // from the writer who asked.
    const otherToken = await accessTokenFromStoredCredential({
      apiUrl: API_BASE_URL,
      credentialFile: credentialFileFor('phase1'),
    });
    const other = await fetch(`${API_BASE_URL}/api/v1/auth/connector/approvals/${approvalId}`, {
      headers: { authorization: `Bearer ${otherToken}`, [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0' },
    });
    expect(other.status, 'an approval is readable only by the person it belongs to').toBe(404);
    expect(((await other.json()) as Record<string, unknown>)['code']).toBe('APPROVAL_NOT_FOUND');
  });

  test('the record still exists, because the refusal refused', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: adminCredentialFile,
      // A risk record cannot be created without its description and
      // mitigation, both of which the gate withholds when reading one.
      allowPersonalData: true,
    });
    try {
      const risks = await callTool(connector.client, 'risks_list');
      expect(risks.text).toContain('Risk created so it can be removed');
    } finally {
      await connector.close();
    }
  });

  test('approving lets exactly that one action through, once', async () => {
    const pending = await latestApprovals();
    const approvalId = String(pending[0]!['id']);

    // The connector command requires a terminal, which is the whole point of
    // it, so this approves the way that command does: with the session token
    // already held and the password, against the same route.
    const accessToken = await accessTokenFromStoredCredential({
      apiUrl: API_BASE_URL,
      credentialFile: adminCredentialFile,
    });

    const granted = await fetch(`${API_BASE_URL}/api/v1/auth/connector/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
      },
      body: JSON.stringify({ approvalId, password: fixture.writer.password }),
    });
    expect(granted.status).toBe(200);

    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: adminCredentialFile,
      // A risk record cannot be created without its description and
      // mitigation, both of which the gate withholds when reading one.
      allowPersonalData: true,
    });
    try {
      const removed = await callTool(connector.client, 'risk_delete', {
        id: createdRiskId,
        reason: 'Removing the record this test created',
        approvalId,
      });
      expect(removed.isError, removed.text).toBe(false);

      const risks = await callTool(connector.client, 'risks_list');
      expect(risks.text).not.toContain('Risk created so it can be removed');

      const spent = await withDb(async (dbClient) => {
        const result = await dbClient.query(
          `SELECT "consumedAt" FROM "AuthActionApproval" WHERE "id" = $1`,
          [approvalId],
        );
        return result.rows as Array<Record<string, unknown>>;
      });
      expect(spent[0]!['consumedAt'], 'the approval is spent by the request that used it')
        .not.toBeNull();

      // Single-use, and the distinction matters: the record is gone now, so a
      // second attempt would fail either way. What proves the approval was
      // spent is that the request is refused BEFORE it reaches the route, with
      // a fresh approval demanded, rather than reaching it and finding nothing.
      const again = await callTool(connector.client, 'risk_delete', {
        id: createdRiskId,
        reason: 'Trying to spend the approval twice',
        approvalId,
      });
      expect(again.isError).toBe(true);
      expect(
        again.text,
        'a spent approval must buy nothing, not merely fail for another reason',
      ).toMatch(/charitypilot-mcp approve /);
    } finally {
      await connector.close();
    }
  });

  test('a wrong password approves nothing', async () => {
    let approvalId = '';
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: adminCredentialFile,
      // A risk record cannot be created without its description and
      // mitigation, both of which the gate withholds when reading one.
      allowPersonalData: true,
    });
    try {
      const made = await callTool(connector.client, 'risk_create', {
        title: 'Risk for the wrong-password case',
        category: 'GOVERNANCE',
        description: 'Exists only for this test',
        likelihood: 1,
        impact: 1,
        mitigation: 'None needed',
        reason: 'Setting up the wrong-password test',
      });
      expect(made.isError, made.text).toBe(false);
      const riskId = (made.json as { data: { id: string } }).data.id;

      const refused = await callTool(connector.client, 'risk_delete', {
        id: riskId,
        reason: 'Should not happen',
      });
      expect(refused.isError).toBe(true);
      // Anchored on the command, not the word: the message also says "approve it
      // yourself" further up, and a looser pattern captures "it".
      approvalId = /charitypilot-mcp approve ([A-Za-z0-9_-]+)/.exec(refused.text)?.[1] ?? '';
      expect(approvalId).not.toBe('');
    } finally {
      await connector.close();
    }

    const accessToken = await accessTokenFromStoredCredential({
      apiUrl: API_BASE_URL,
      credentialFile: adminCredentialFile,
    });

    const attempt = await fetch(`${API_BASE_URL}/api/v1/auth/connector/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        [CONNECTOR_CLIENT_HEADER]: 'mcp-connector/0.1.0',
      },
      body: JSON.stringify({ approvalId, password: 'not-the-password' }),
    });

    expect(attempt.status).toBe(401);

    const rows = await withDb(async (client) => {
      const result = await client.query(
        `SELECT "approvedAt" FROM "AuthActionApproval" WHERE "id" = $1`,
        [approvalId],
      );
      return result.rows as Array<Record<string, unknown>>;
    });
    expect(rows[0]!['approvedAt'], 'a wrong password must grant nothing').toBeNull();
  });
});

/**
 * Concern: moving files between this machine and the charity's documents.
 *
 * The round trip is what proves it: a file uploaded and then downloaded must
 * come back byte for byte, or something in the path mangled it.
 */
test.describe('Connector documents', () => {
  let fileCredentialFile = '';
  let uploadRoot = '';
  let downloadDir = '';
  let uploadedId = '';

  const UPLOAD_BYTES = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    'utf8',
  );

  test.beforeAll(async () => {
    uploadRoot = mkdtempSync(join(tmpdir(), 'charitypilot-upload-'));
    downloadDir = mkdtempSync(join(tmpdir(), 'charitypilot-download-'));
    writeFileSync(join(uploadRoot, 'policy.pdf'), UPLOAD_BYTES);
    // Outside the root, to prove the containment is real rather than assumed.
    writeFileSync(join(uploadRoot, '..', 'outside-the-root.pdf'), UPLOAD_BYTES);

    fileCredentialFile = credentialFileFor('documents');
    const connected = await connectConnector({
      apiUrl: API_BASE_URL,
      email: fixture.writer.email,
      password: fixture.writer.password,
      credentialFile: fileCredentialFile,
      accessLevel: 'write',
    });
    expect(connected.code, connected.stderr).toBe(0);
  });

  test('neither file tool is offered until the operator enables it', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: fileCredentialFile,
    });
    try {
      const names = (await connector.client.listTools()).tools.map((tool) => tool.name);

      expect(names).not.toContain('document_upload');
      expect(names).not.toContain('document_download');
    } finally {
      await connector.close();
    }
  });

  test('calling a file tool that is off says so, rather than failing obscurely', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: fileCredentialFile,
    });
    try {
      const result = await callTool(connector.client, 'document_upload', {
        path: 'policy.pdf',
        name: 'Should not upload',
        category: 'POLICY',
      });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/--upload-root/);
    } finally {
      await connector.close();
    }
  });

  test('with a directory named, a file is uploaded and appears in the documents list', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: fileCredentialFile,
      uploadRoot,
    });
    try {
      const names = (await connector.client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('document_upload');
      expect(names, 'only the tool that was enabled').not.toContain('document_download');

      const result = await callTool(connector.client, 'document_upload', {
        path: 'policy.pdf',
        name: 'Uploaded by the connector',
        category: 'POLICY',
        reason: 'Proving the upload path end to end',
      });
      expect(result.isError, result.text).toBe(false);

      const uploaded = (result.json as { uploaded: { id: string; bytes: number } }).uploaded;
      uploadedId = uploaded.id;
      expect(uploadedId).toBeTruthy();
      expect(uploaded.bytes).toBe(UPLOAD_BYTES.length);

      const listed = await callTool(connector.client, 'documents_list');
      expect(listed.text).toContain('Uploaded by the connector');
      expect(listed.text, 'a list of documents is not a list of their contents')
        .not.toContain('%PDF');
    } finally {
      await connector.close();
    }
  });

  test('a file outside the named directory cannot be uploaded', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: fileCredentialFile,
      uploadRoot,
    });
    try {
      const result = await callTool(connector.client, 'document_upload', {
        path: join('..', 'outside-the-root.pdf'),
        name: 'Should never upload',
        category: 'POLICY',
      });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/outside the directory this connector may use/);
    } finally {
      await connector.close();
    }
  });

  test('the upload left an activity row, like every other change', async () => {
    const rows = await withDb(async (client) => {
      const result = await client.query(
        `SELECT "method", "routePattern", "statusCode", "reason"
           FROM "ClientActivityEvent"
          WHERE "routePattern" LIKE '%/documents'
          ORDER BY "occurredAt" DESC LIMIT 1`,
      );
      return result.rows as Array<Record<string, unknown>>;
    });

    expect(rows.length).toBe(1);
    expect(rows[0]!['method']).toBe('POST');
    expect(rows[0]!['reason']).toBe('Proving the upload path end to end');
  });

  test('the document comes back byte for byte, and its contents stay off the wire', async () => {
    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: fileCredentialFile,
      downloadDir,
    });
    try {
      const result = await callTool(connector.client, 'document_download', {
        id: uploadedId,
        reason: 'Proving the download path end to end',
      });
      expect(result.isError, result.text).toBe(false);

      const saved = (result.json as { saved: { path: string; sha256: string } }).saved;
      expect(readFileSync(saved.path)).toEqual(UPLOAD_BYTES);
      expect(saved.sha256).toBe(createHash('sha256').update(UPLOAD_BYTES).digest('hex'));

      expect(
        result.text,
        'the point of returning a path is that the contents never reach the model',
      ).not.toContain('%PDF');
      expect(saved.path.startsWith(downloadDir)).toBe(true);
    } finally {
      await connector.close();
    }
  });

  test('a read-level session is offered no file tool, even with directories named', async () => {
    const readOnly = credentialFileFor('documents-read');
    const connected = await connectConnector({
      apiUrl: API_BASE_URL,
      email: fixture.writer.email,
      password: fixture.writer.password,
      credentialFile: readOnly,
      accessLevel: 'read',
    });
    expect(connected.code, connected.stderr).toBe(0);

    const connector = await openConnector({
      apiUrl: API_BASE_URL,
      credentialFile: readOnly,
      uploadRoot,
      downloadDir,
    });
    try {
      const names = (await connector.client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain('document_upload');
      expect(names).not.toContain('document_download');

      const refused = await callTool(connector.client, 'document_upload', {
        path: 'policy.pdf',
        name: 'Should never upload',
        category: 'POLICY',
      });
      expect(refused.isError, 'hiding a tool is not refusing it').toBe(true);
    } finally {
      await connector.close();
    }
  });
});
