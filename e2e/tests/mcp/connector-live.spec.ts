import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { API_BASE_URL } from '../../playwright.config';
import {
  assertConnectorBuilt,
  connectConnector,
  runConnector,
  openConnector,
  callTool,
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

function storedRefreshToken(path: string): string | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { refreshToken?: string };
  return parsed.refreshToken ?? null;
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

    const replay = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: API_BASE_URL },
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
): Promise<string> {
  const credentialFile = credentialFileFor(label);
  const result = await connectConnector({
    apiUrl: API_BASE_URL,
    email: account.email,
    password: account.password,
    credentialFile,
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
