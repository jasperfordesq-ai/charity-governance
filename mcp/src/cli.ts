#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr, argv, exit } from 'node:process';
import { parseArgs } from './config.js';
import { chooseCredentialStore, bindCredentialToOrigin } from './credentials.js';
import {
  readPasswordFromStdin,
  assertNonInteractiveConnectAllowed,
  assertApproveAllowed,
} from './connect-input.js';
import { Session } from './session.js';
import { startServer } from './server.js';
import { ApiClient } from './client.js';
import { redactSecrets } from './redact.js';
import { CONNECTOR_VERSION } from './version.js';
import { fetchSessionPosture } from './session-level.js';
import { formatStatus } from './status.js';
import { approvalState, explainState, formatApprovalPreview } from './approval-preview.js';

const USAGE = `charitypilot-mcp ${CONNECTOR_VERSION}

An MCP server that lets an AI client read and change one charity's CharityPilot
records as you. Run with no command to serve over stdio to an AI client.

Commands (run these yourself, in a terminal):
  connect      Sign in and store a refresh token in the OS credential store.
               --access-level read|write|admin   (default: write)
               --email <address>
  status       Who the stored credential resolves to, and the level the API holds.
  approve <id> Approve one action CharityPilot refused. Terminal only.
  disconnect   Revoke the session on the server and clear the credential.
  serve        Start the MCP server (the default).

Options:
  --base-url <https://host>   The API. Defaults to the tailnet address.
  --allow-personal-data       Release the fields the personal-data gate withholds.
                              A data-protection decision; ask your DPO first.
  --upload-root <dir>         Offer document_upload for files under this directory.
  --download-dir <dir>        Offer document_download, writing into this directory.
  --toolsets <a,b>            Offer only these tool groups. See README.
  --verbose                   Log each tool call to stderr, secrets redacted.
  --profile local             Loopback-only test profile. See README.
  --version, --help
`;

async function prompt(question: string, hidden: boolean): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  if (!hidden) {
    const answer = await rl.question(question);
    rl.close();
    return answer.trim();
  }
  stdout.write(question);
  const previouslyRaw = stdin.isRaw ?? false;
  stdin.setRawMode?.(true);
  // Bytes are accumulated raw, not decoded chunk-by-chunk: a multi-byte UTF-8
  // character (e.g. an accented letter in "Siobhán") can arrive split across
  // separate read events, and decoding each chunk on its own would turn the
  // split sequence into a replacement character. Decoding happens once, from
  // the full accumulated buffer, after input is complete.
  let bytes = Buffer.alloc(0);
  try {
    outer: for await (const chunk of stdin as AsyncIterable<Buffer>) {
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) break outer;
        if (byte === 0x03) { stdin.setRawMode?.(previouslyRaw); rl.close(); exit(130); }
        if (byte === 0x7f) {
          bytes = Buffer.from(bytes.toString('utf8').slice(0, -1), 'utf8');
          continue;
        }
        bytes = Buffer.concat([bytes, Buffer.from([byte])]);
      }
    }
  } finally {
    stdin.setRawMode?.(previouslyRaw);
  }
  stdout.write('\n');
  rl.close();
  return bytes.toString('utf8');
}

async function main(): Promise<void> {
  const config = parseArgs(argv.slice(2));
  if (config.command === 'version') {
    stdout.write(`charitypilot-mcp ${CONNECTOR_VERSION}\n`);
    return;
  }
  if (config.command === 'help') {
    stdout.write(USAGE);
    return;
  }
  assertNonInteractiveConnectAllowed(config, stdin.isTTY === true);
  // Bound to the base URL in use: a credential minted against one host is never
  // presented to another, whatever changed the configuration.
  const store = bindCredentialToOrigin(
    chooseCredentialStore({
      profile: config.profile,
      credentialFile: process.env.CHARITYPILOT_CREDENTIAL_FILE,
    }),
    config.baseUrl,
  );
  const session = new Session({
    baseUrl: config.baseUrl,
    store,
    accessLevel: config.accessLevel,
  });

  if (config.command === 'connect') {
    const email = config.email ?? (await prompt('CharityPilot email: ', false));
    // CHARITYPILOT_BASE_URL can silently point this at a different host. Show it
    // before the password is typed, not after, so a wrong host is caught before
    // anything sensitive is sent to it.
    stdout.write(`Target: ${config.baseUrl}\n`);
    const password = config.passwordStdin
      ? await readPasswordFromStdin(stdin as AsyncIterable<Buffer>)
      : await prompt('Password (not shown): ', true);
    const identity = await session.login(email, password);
    stdout.write(
      `Connected as ${identity.name} <${identity.email}> (${identity.role})\n` +
      `Organisation: ${identity.organisationName}\n` +
      `Access level: ${config.accessLevel.toUpperCase()}\n` +
      `Personal data: ${config.allowPersonalData ? 'ALLOWED' : 'withheld (default)'}\n`,
    );
    return;
  }

  if (config.command === 'approve') {
    assertApproveAllowed(config, stdin.isTTY === true);
    // The target is printed before anything else, as connect does: an approval
    // sent to the wrong host is a password sent to the wrong host.
    stdout.write(`Target: ${config.baseUrl}\n`);
    // What is being approved is shown BEFORE the password is asked for. The
    // summary is the API's own, built from the route and the record, so the
    // person is checking the agent's account against the server's.
    const preview = await session.describeApproval(config.approvalId!);
    stdout.write(formatApprovalPreview(preview));
    const state = approvalState(preview, new Date());
    if (state !== 'pending') {
      stdout.write(`${explainState(state)}\n`);
      return;
    }
    const password = await prompt('Password (not shown): ', true);
    const outcome = await session.approve(config.approvalId!, password);
    stdout.write(
      `Approved: ${outcome.summary ?? preview.summary}\n`
        + 'Ask the assistant to try the action again with exactly the same arguments plus '
        + `approvalId: ${config.approvalId}. The approval covers that one action and nothing else.\n`,
    );
    return;
  }

  if (config.command === 'disconnect') {
    await session.logout();
    stdout.write('Disconnected. The stored credential has been removed and the session revoked.\n');
    return;
  }

  if (config.command === 'status') {
    if (!store.read()) {
      stdout.write('Not connected. Run: charitypilot-mcp connect\n');
      return;
    }
    const client = new ApiClient({ session, baseUrl: config.baseUrl });
    try {
      const me = await client.get<{
        email: string; name: string; role: string;
        organisation?: { name?: string } | null;
      }>('/api/v1/auth/me');
      // The level is read from the API, where it is held, not from the flag
      // this process was started with; the two disagree whenever the flag is
      // omitted, which is most of the time.
      const posture = await fetchSessionPosture(client);
      stdout.write(formatStatus(me, posture, config.allowPersonalData));
    } catch (error) {
      stdout.write(
        `Stored credential found, but it could not be verified: ${redactSecrets((error as Error).message)}\n`,
      );
    }
    return;
  }

  await startServer(config, session);
}

main().catch((error: unknown) => {
  // In `serve` mode, stdout IS the MCP JSON-RPC transport — the AI client reads it
  // as protocol frames. Writing anything else there, including a startup failure,
  // injects non-JSON into that stream and breaks the client's parser. Everything
  // that reaches this handler (parseArgs failures, a broken startServer, etc.) is
  // therefore reported on stderr, never stdout. connect/status/disconnect print
  // their own output on stdout directly, before this handler ever runs, because a
  // human is meant to read it there.
  stderr.write(`${redactSecrets((error as Error).message)}\n`);
  exit(1);
});
