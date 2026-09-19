import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

export const CONNECTOR_CLI = resolve(__dirname, '../../mcp/dist/cli.js');

/**
 * The harness drives the built connector, not its source. A missing build is
 * reported as an instruction rather than skipped, so the suite can never pass
 * by quietly testing nothing.
 */
export function assertConnectorBuilt(): void {
  if (!existsSync(CONNECTOR_CLI)) {
    throw new Error(
      `The MCP connector is not built at ${CONNECTOR_CLI}. Run: cd mcp && npm ci && npm run build`,
    );
  }
}

function childEnvironment(credentialFile: string): Record<string, string> {
  // getDefaultEnvironment() is the SDK's safe inherited subset (PATH, HOME and
  // similar). CHARITYPILOT_BASE_URL is deliberately NOT inherited: every call
  // passes --base-url explicitly so an ambient value cannot redirect the test.
  return { ...getDefaultEnvironment(), CHARITYPILOT_CREDENTIAL_FILE: credentialFile };
}

export interface ConnectorRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runConnector(
  args: string[],
  options: { credentialFile: string; stdinText?: string },
): Promise<ConnectorRunResult> {
  assertConnectorBuilt();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CONNECTOR_CLI, ...args], {
      env: childEnvironment(options.credentialFile),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(options.stdinText ?? '');
  });
}

export type ConnectorAccessLevel = 'read' | 'write' | 'admin';

export async function connectConnector(options: {
  apiUrl: string;
  email: string;
  password: string;
  credentialFile: string;
  accessLevel?: ConnectorAccessLevel;
}): Promise<ConnectorRunResult> {
  const args = [
    'connect',
    '--profile', 'local',
    '--base-url', options.apiUrl,
    '--email', options.email,
    '--password-stdin',
  ];
  // Omitted rather than defaulted: a test that never passes one is then
  // exercising the connector's own default, which is the case worth covering.
  if (options.accessLevel) args.push('--access-level', options.accessLevel);
  return runConnector(args, {
    credentialFile: options.credentialFile,
    stdinText: `${options.password}\n`,
  });
}

/**
 * The refresh token as the connector actually stored it.
 *
 * The file holds the credential store's opaque value, which since origin
 * binding is itself a small JSON record. A test that posted the record
 * verbatim would be rejected for the wrong reason, and would keep passing
 * after the thing it guards had broken.
 */
export function storedRefreshToken(path: string): string | null {
  if (!existsSync(path)) return null;
  const outer = JSON.parse(readFileSync(path, 'utf8')) as { refreshToken?: unknown };
  if (typeof outer.refreshToken !== 'string') return null;
  try {
    const bound = JSON.parse(outer.refreshToken) as { refreshToken?: unknown };
    if (typeof bound.refreshToken === 'string') return bound.refreshToken;
  } catch {
    // A plain string: an entry written before binding existed.
  }
  return outer.refreshToken;
}

export const CONNECTOR_CLIENT_HEADER = 'x-charitypilot-client';
const CONNECTOR_CLIENT_VALUE = 'mcp-connector/0.1.0';

/**
 * Spends the stored refresh token for an access token, the way the connector
 * would, and writes the rotated credential back so the connector keeps working.
 *
 * This exists so a test can make a request the connector has no tool for. A
 * refusal seen that way is unambiguously the API's, not the connector quietly
 * declining to offer something.
 */
export async function accessTokenFromStoredCredential(options: {
  apiUrl: string;
  credentialFile: string;
}): Promise<string> {
  const refreshToken = storedRefreshToken(options.credentialFile);
  if (!refreshToken) throw new Error(`No stored credential at ${options.credentialFile}`);

  const response = await fetch(`${options.apiUrl}/api/v1/auth/connector/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [CONNECTOR_CLIENT_HEADER]: CONNECTOR_CLIENT_VALUE,
    },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) {
    throw new Error(`Could not mint an access token: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { accessToken: string; refreshToken: string };

  // The token just spent is dead. Leaving it on disk would quarantine the whole
  // session family the next time the connector refreshed.
  const outer = JSON.parse(readFileSync(options.credentialFile, 'utf8')) as { refreshToken: string };
  let stored: string = body.refreshToken;
  try {
    const bound = JSON.parse(outer.refreshToken) as Record<string, unknown>;
    if (bound && bound['v'] === 1) {
      stored = JSON.stringify({ ...bound, refreshToken: body.refreshToken });
    }
  } catch {
    // Plain string entry: store the rotated token the same way.
  }
  writeFileSync(options.credentialFile, `${JSON.stringify({ refreshToken: stored })}\n`, {
    mode: 0o600,
  });

  return body.accessToken;
}

export interface OpenConnector {
  client: Client;
  stderr(): string;
  close(): Promise<void>;
}

export async function openConnector(options: {
  apiUrl: string;
  credentialFile: string;
  allowPersonalData?: boolean;
}): Promise<OpenConnector> {
  assertConnectorBuilt();
  const args = [CONNECTOR_CLI, 'serve', '--profile', 'local', '--base-url', options.apiUrl];
  if (options.allowPersonalData) args.push('--allow-personal-data');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: childEnvironment(options.credentialFile),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'charitypilot-live-harness', version: '0.0.0' });
  await client.connect(transport);

  let captured = '';
  transport.stderr?.on('data', (chunk) => {
    captured += String(chunk);
  });

  return {
    client,
    stderr: () => captured,
    close: async () => {
      await client.close();
    },
  };
}

export interface ToolCallResult {
  isError: boolean;
  text: string;
  json: unknown;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.map((part) => part.text ?? '').join('');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: result.isError === true, text, json };
}
