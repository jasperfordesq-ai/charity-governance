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
 *   reseal [--batch <n>]                re-seal one bounded batch; repeat until 0 remain
 *
 * Output is JSON with fingerprints and counts only. No key or credential is
 * ever printed.
 */
export type IntegrationKeyRotationCommand =
  | { mode: 'status' }
  | { mode: 'begin'; expectedGeneration: number }
  | { mode: 'reseal'; batch: number };

export function parseIntegrationKeyRotationArgs(argv: string[]): IntegrationKeyRotationCommand {
  const [mode, ...rest] = argv;
  const value = (flag: string): string | undefined => {
    const index = rest.indexOf(flag);
    if (index === -1) return undefined;
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };
  const known = new Set(['--expected-generation', '--batch']);
  for (let i = 0; i < rest.length; i += 2) {
    if (!known.has(rest[i]!)) throw new Error(`Unknown option ${rest[i]}`);
  }
  const integer = (raw: string | undefined, flag: string): number => {
    if (raw === undefined || !/^[1-9][0-9]{0,6}$/.test(raw)) throw new Error(`${flag} must be a positive integer`);
    return Number(raw);
  };
  if (mode === 'status' && rest.length === 0) return { mode: 'status' };
  if (mode === 'begin') {
    return { mode: 'begin', expectedGeneration: integer(value('--expected-generation'), '--expected-generation') };
  }
  if (mode === 'reseal') {
    const batch = value('--batch');
    return { mode: 'reseal', batch: batch === undefined ? 50 : integer(batch, '--batch') };
  }
  throw new Error('Usage: rotate-integration-encryption-key status | begin --expected-generation <n> | reseal [--batch <n>]');
}

export async function runIntegrationKeyRotation(prisma: PrismaClient, command: IntegrationKeyRotationCommand) {
  if (command.mode === 'status') return integrationKeyRotationStatus(prisma);
  if (command.mode === 'begin') return beginIntegrationKeyRotation(prisma, command.expectedGeneration);
  return resealIntegrationCredentials(prisma, command.batch);
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
