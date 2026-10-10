import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { serializeErrorForLog } from '../utils/logger.js';
import { resealUserSecondFactorSecrets } from '../services/user-second-factor.service.js';
import { resealOperatorSecondFactorSecrets } from '../services/operator-second-factor.service.js';

/**
 * After rotating JWT_SECRET (charity users) or OWNER_JWT_SECRET (operators),
 * with the old value kept as JWT_SECRET_PREVIOUS / OWNER_JWT_SECRET_PREVIOUS:
 *
 *   reseal-second-factor-secrets user [--batch <n>]
 *   reseal-second-factor-secrets operator [--batch <n>]
 *
 * Repeat until `remaining` is 0, then remove the *_PREVIOUS variable. An
 * authenticator also re-seals itself on its next successful sign-in. Output is
 * counts and row ids only; no secret is printed.
 */
export function parseResealArgs(argv: string[]): { realm: 'user' | 'operator'; batch: number } {
  const [realm, ...rest] = argv;
  if (realm !== 'user' && realm !== 'operator') {
    throw new Error('Usage: reseal-second-factor-secrets user|operator [--batch <n>]');
  }
  if (rest.length === 0) return { realm, batch: 100 };
  if (rest.length !== 2 || rest[0] !== '--batch' || !/^[1-9][0-9]{0,3}$/.test(rest[1]!)) {
    throw new Error('--batch must be a positive integer up to 1000');
  }
  return { realm, batch: Number(rest[1]) };
}

async function main(): Promise<number> {
  let command: { realm: 'user' | 'operator'; batch: number };
  try {
    command = parseResealArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const prisma = new PrismaClient();
  try {
    const result = command.realm === 'user'
      ? await resealUserSecondFactorSecrets(prisma, command.batch)
      : await resealOperatorSecondFactorSecrets(prisma, command.batch);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.failed.length > 0 ? 1 : 0;
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
