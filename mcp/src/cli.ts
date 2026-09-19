#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';
import { parseArgs } from './config.js';
import { createKeyringStore } from './credentials.js';
import { Session } from './session.js';
import { startServer } from './server.js';
import { ApiClient } from './client.js';
import { redactSecrets } from './redact.js';

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
  const store = createKeyringStore();
  const session = new Session({ baseUrl: config.baseUrl, store });

  if (config.command === 'connect') {
    const email = await prompt('CharityPilot email: ', false);
    const password = await prompt('Password (not shown): ', true);
    const identity = await session.login(email, password);
    stdout.write(
      `Connected as ${identity.name} <${identity.email}> (${identity.role})\n` +
      `Organisation: ${identity.organisationName}\n` +
      `Personal data: ${config.allowPersonalData ? 'ALLOWED' : 'withheld (default)'}\n`,
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
      stdout.write(
        `Connected as ${me.name} <${me.email}> (${me.role})\n` +
        `Organisation: ${me.organisation?.name ?? '(unnamed organisation)'}\n` +
        `Personal data: ${config.allowPersonalData ? 'ALLOWED' : 'withheld (default)'}\n`,
      );
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
  stdout.write(`${redactSecrets((error as Error).message)}\n`);
  exit(1);
});
