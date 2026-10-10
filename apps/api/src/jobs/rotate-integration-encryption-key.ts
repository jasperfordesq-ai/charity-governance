import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { serializeErrorForLog } from '../utils/logger.js';
import {
  beginIntegrationKeyRotation,
  integrationKeyRotationStatus,
  resealIntegrationCredentials,
} from '../services/integration-key-rotation.js';

/**
 * Operator command for rotating INTEGRATION_ENCRYPTION_KEY. See the procedure
 * at the top of services/integration-key-rotation.ts.
 *
 *   status                              where the rotation stands; decrypts nothing
 *   begin --expected-generation <n>     advance the generation (new key active,
 *                                       old key as INTEGRATION_ENCRYPTION_KEY_PREVIOUS)
 *   reseal [--batch <n>] [--after <id>] re-seal one bounded batch; repeat until 0 remain.
 *                                       A batch that reports failures also reports
 *                                       `next`; pass it as --after to move past them.
 *
 * Output is JSON with fingerprints and counts only. No key or credential is
 * ever printed.
 */
export type IntegrationKeyRotationCommand =
  | { mode: 'status' }
  | { mode: 'begin'; expectedGeneration: number }
  | { mode: 'reseal'; batch: number; after?: string };

const USAGE = 'Usage: rotate-integration-encryption-key status | begin --expected-generation <n>'
  + ' | reseal [--batch <n>] [--after <credential id>]';

/** Strict: a flag outside its mode, a repeated flag or a stray word refuses
 * before anything runs, so an operator's slip never changes what is written. */
export function parseIntegrationKeyRotationArgs(argv: string[]): IntegrationKeyRotationCommand {
  const [mode, ...rest] = argv;
  const allowed: Record<string, readonly string[]> = {
    status: [],
    begin: ['--expected-generation'],
    reseal: ['--batch', '--after'],
  };
  if (mode === undefined || !Object.hasOwn(allowed, mode)) throw new Error(USAGE);
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const next = rest[i + 1];
    if (!allowed[mode]!.includes(flag)) throw new Error(`${flag} is not an option of ${mode}. ${USAGE}`);
    if (flags.has(flag)) throw new Error(`${flag} was given more than once`);
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    flags.set(flag, next);
  }
  const integer = (raw: string | undefined, flag: string): number => {
    if (raw === undefined || !/^[1-9][0-9]{0,6}$/.test(raw)) throw new Error(`${flag} must be a positive integer`);
    return Number(raw);
  };
  if (mode === 'status') return { mode: 'status' };
  if (mode === 'begin') {
    return { mode: 'begin', expectedGeneration: integer(flags.get('--expected-generation'), '--expected-generation') };
  }
  const batch = flags.get('--batch');
  const after = flags.get('--after');
  if (after !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(after)) {
    throw new Error('--after must be a credential id from an earlier reseal');
  }
  return { mode: 'reseal', batch: batch === undefined ? 50 : integer(batch, '--batch'),
    ...(after === undefined ? {} : { after }) };
}

export async function runIntegrationKeyRotation(prisma: PrismaClient, command: IntegrationKeyRotationCommand) {
  if (command.mode === 'status') return integrationKeyRotationStatus(prisma);
  if (command.mode === 'begin') return beginIntegrationKeyRotation(prisma, command.expectedGeneration);
  return resealIntegrationCredentials(prisma, command.batch, command.after);
}

async function main(): Promise<number> {
  let command: IntegrationKeyRotationCommand;
  try {
    command = parseIntegrationKeyRotationArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const prisma = new PrismaClient();
  try {
    const result = await runIntegrationKeyRotation(prisma, command);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (command.mode === 'reseal' && 'failed' in result && result.failed.length > 0) return 1;
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify(serializeErrorForLog(error))}\n`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
