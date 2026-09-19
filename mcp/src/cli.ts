#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';
import { parseArgs } from './config.js';
import { createKeyringStore } from './credentials.js';
import { Session } from './session.js';
import { startServer } from './server.js';

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
  let value = '';
  for await (const chunk of stdin) {
    const char = chunk.toString('utf8');
    if (char === '\r' || char === '\n') break;
    if (char === '\x03') { stdin.setRawMode?.(previouslyRaw); rl.close(); exit(130); }
    if (char === '\x7f') { value = value.slice(0, -1); continue; }
    value += char;
  }
  stdin.setRawMode?.(previouslyRaw);
  stdout.write('\n');
  rl.close();
  return value;
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
    await session.accessToken();
    const identity = session.identity();
    stdout.write(
      identity
        ? `Connected as ${identity.email} — organisation: ${identity.organisationName}\n`
        : 'Connected (run a tool to confirm the organisation).\n',
    );
    return;
  }

  await startServer(config, session);
}

main().catch((error: unknown) => {
  stdout.write(`${(error as Error).message}\n`);
  exit(1);
});
