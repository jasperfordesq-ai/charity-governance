import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createApplicationPrismaClient } from '../utils/application-prisma-client.js';
import { registerSyntheticConfluenceScope } from '../services/confluence-synthetic-scope.js';

const usage = 'Usage: register-confluence-synthetic-scope --input <absolute JSON file> [--confirm <preview SHA-256>]';
export function parseSyntheticScopeArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!, value = argv[i + 1];
    if (!['--input', '--confirm'].includes(flag) || args.has(flag) || !value || value.startsWith('--')) throw new Error(usage);
    args.set(flag, value);
  }
  const inputFile = args.get('--input'), confirmation = args.get('--confirm');
  if (!inputFile || !isAbsolute(inputFile) || (confirmation !== undefined && !/^[a-f0-9]{64}$/.test(confirmation))) throw new Error(usage);
  return { inputFile, confirmation };
}

export async function readSyntheticScopeInput(path: string) {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('A regular input file is required.');
    const buffer = Buffer.alloc(16385);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead === 0 || bytesRead > 16384) throw new Error('Input must contain at most 16 KiB of JSON.');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
  } finally { await file.close(); }
}

async function main() {
  let client: PrismaClient | undefined;
  try {
    const command = parseSyntheticScopeArgs(process.argv.slice(2));
    const input = await readSyntheticScopeInput(command.inputFile);
    const raw = process.env.DATABASE_MAINTENANCE_URL;
    if (!raw) throw new Error('A dedicated maintenance database connection is required.');
    // Do not fall back to the ordinary runtime credential. Reuse the public
    // profile's verified TLS transport while binding private/local construction
    // explicitly to this maintenance URL rather than the ambient DATABASE_URL.
    client = await createApplicationPrismaClient({ ...process.env, DATABASE_URL: raw }, {
      createClient: url => new PrismaClient({ datasources: { db: { url: url ?? raw } }, log: [], errorFormat: 'minimal' }),
    });
    const result = await registerSyntheticConfluenceScope(client, input, command.confirmation);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch {
    // Database/file/driver errors may contain credentials or sensitive paths.
    process.stderr.write('Synthetic scope registration failed. Check the input, current review, maintenance connection and exact preview confirmation. No provider action was attempted.\n');
    return 1;
  } finally { await client?.$disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('Synthetic scope command could not finish safely. Check its recorded state before retrying.\n');
    process.exitCode = 1;
  });
}
