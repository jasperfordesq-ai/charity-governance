#!/usr/bin/env node
// Asks the platform a question from a terminal, through the connector.
//
// Drives the built connector over the same stdio protocol an AI client uses, so
// what it shows is exactly what an assistant would see, filtered by the same
// personal-data gate and limited by the same session level. It uses the
// credential already in the OS credential store and never sees a password.
//
// It exists because "what does the connector actually return for this charity"
// is a question worth answering without wiring up an AI client, and because a
// person checking the gate should be able to see the real output rather than a
// description of it.
//
//   node ask-platform.mjs --list
//   node ask-platform.mjs compliance_summary
//   node ask-platform.mjs board_register '{"page":2}'
//   node ask-platform.mjs            # a situation report
//
// Read-only in practice: it passes no reason and no approval, so a write tool
// called through it is refused by the API rather than performed. Changing
// records from a terminal is what the web application is for.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, 'dist/cli.js');

const allowPersonalData = process.argv.includes('--allow-personal-data');
const args = process.argv.slice(2).filter((a) => a !== '--allow-personal-data');
const [toolName, rawArgs] = args;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [CLI, 'serve', ...(allowPersonalData ? ['--allow-personal-data'] : [])],
  env: getDefaultEnvironment(),
  stderr: 'pipe',
});
const client = new Client({ name: 'charitypilot-ask', version: '0.0.0' });
await client.connect(transport);

async function call(name, toolArgs = {}) {
  const result = await client.callTool({ name, arguments: toolArgs });
  const text = (result.content ?? []).map((c) => c.text ?? '').join('');
  return { isError: result.isError === true, text };
}

if (toolName === '--list') {
  const listed = await client.listTools();
  for (const t of listed.tools) console.log(t.name);
} else if (toolName) {
  const parsed = rawArgs ? JSON.parse(rawArgs) : {};
  const r = await call(toolName, parsed);
  console.log(r.isError ? `ERROR: ${r.text}` : r.text);
} else {
  // Default: a situation report from the tools that need no arguments.
  const REPORT = [
    'organisation',
    'compliance_summary',
    'approval_readiness',
    'registers_summary',
    'deadlines_list',
    'board_register',
    'documents_list',
    'team_list',
  ];
  for (const name of REPORT) {
    const r = await call(name);
    console.log(`\n========== ${name} ==========`);
    console.log(r.isError ? `ERROR: ${r.text}` : r.text.slice(0, 2600));
  }
}

await client.close();
