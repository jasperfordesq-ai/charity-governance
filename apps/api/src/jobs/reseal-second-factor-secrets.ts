import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { serializeErrorForLog } from '../utils/logger.js';
import { resealUserSecondFactorSecrets } from '../services/user-second-factor.service.js';
import type { SecondFactorResealPage } from '../services/totp-secret-envelope.js';
import { resealOperatorSecondFactorSecrets } from '../services/operator-second-factor.service.js';

/**
 * After rotating JWT_SECRET (charity users) or OWNER_JWT_SECRET (operators),
 * with the old value kept as JWT_SECRET_PREVIOUS / OWNER_JWT_SECRET_PREVIOUS:
 *
 *   reseal-second-factor-secrets user [--batch <n>]
 *   reseal-second-factor-secrets operator [--batch <n>]
 *
 * One run walks every row in pages of --batch, so memory and each database
 * read stay bounded, and a row that fails never stops the rows after it.
 * Repeat until `remaining` is 0, then remove the *_PREVIOUS variable. A
 * charity user's authenticator also re-seals itself on its next successful
 * sign-in; an operator's does not, so the operator realm must be run before
 * OWNER_JWT_SECRET_PREVIOUS is removed. Output is counts and row ids only; no
 * secret is printed.
 */
export function parseResealArgs(argv: string[]): { realm: 'user' | 'operator'; batch: number } {
  const [realm, ...rest] = argv;
  if (realm !== 'user' && realm !== 'operator') {
    throw new Error('Usage: reseal-second-factor-secrets user|operator [--batch <n>]');
  }
  if (rest.length === 0) return { realm, batch: 100 };
  if (rest.length !== 2 || rest[0] !== '--batch' || !/^[1-9][0-9]{0,3}$/.test(rest[1]!)
    || Number(rest[1]) > 1000) {
    throw new Error('--batch must be a positive integer up to 1000');
  }
  return { realm, batch: Number(rest[1]) };
}

/** The most failed row ids one run reports; beyond this only the count grows,
 * so memory stays bounded however many rows cannot be opened. */
export const RESEAL_FAILED_ID_LIMIT = 100;

/** Walk every page once and total the results. `remaining` counts the stale
 * rows this run did not re-seal (failed or changed meanwhile). */
export async function resealAllPages(page: (after?: string) => Promise<SecondFactorResealPage>) {
  const total = { scanned: 0, stale: 0, resealed: 0, skippedChanged: 0, failedCount: 0,
    failed: [] as string[], failedIdsTruncated: false, pages: 0 };
  let after: string | undefined;
  do {
    const result = await page(after);
    total.pages += 1;
    total.scanned += result.scanned;
    total.stale += result.stale;
    total.resealed += result.resealed;
    total.skippedChanged += result.skippedChanged;
    total.failedCount += result.failed.length;
    for (const id of result.failed) {
      if (total.failed.length < RESEAL_FAILED_ID_LIMIT) total.failed.push(id);
      else total.failedIdsTruncated = true;
    }
    if (result.next !== null && after !== undefined && result.next <= after) {
      throw new Error('Re-seal paging did not advance; stopping');
    }
    after = result.next ?? undefined;
  } while (after !== undefined);
  return { ...total, remaining: total.stale - total.resealed };
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
    const result = await resealAllPages((after) => command.realm === 'user'
      ? resealUserSecondFactorSecrets(prisma, command.batch, after)
      : resealOperatorSecondFactorSecrets(prisma, command.batch, after));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.failedCount > 0 ? 1 : 0;
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
