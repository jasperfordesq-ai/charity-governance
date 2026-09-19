import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

export async function connectConnector(options: {
  apiUrl: string;
  email: string;
  password: string;
  credentialFile: string;
}): Promise<ConnectorRunResult> {
  return runConnector(
    [
      'connect',
      '--profile', 'local',
      '--base-url', options.apiUrl,
      '--email', options.email,
      '--password-stdin',
    ],
    { credentialFile: options.credentialFile, stdinText: `${options.password}\n` },
  );
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
