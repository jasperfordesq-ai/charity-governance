import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { serializeErrorForLog } from '../utils/logger.js';
import { revokeInstallationSessions,
  type SessionRevocationRealm } from '../services/installation-session-revocation.js';

/**
 * Revoke every live session on this installation, for use after a suspected
 * exposure of JWT_SECRET or OWNER_JWT_SECRET. See
 * services/installation-session-revocation.ts.
 *
 *   revoke-all-sessions user|operator|all --reason "<why>"            counts only
 *   revoke-all-sessions user|operator|all --reason "<why>" --confirm  revokes
 *
 * Run it after the rotated secret is live, or a session could be refreshed
 * again under the old one. Output is counts only.
 */
export type RevokeAllSessionsCommand = { realm: SessionRevocationRealm; reason: string; confirm: boolean };

const USAGE = 'Usage: revoke-all-sessions user|operator|all --reason "<why>" [--confirm]';

export function parseRevokeAllSessionsArgs(argv: string[]): RevokeAllSessionsCommand {
  const [realm, ...rest] = argv;
  if (realm !== 'user' && realm !== 'operator' && realm !== 'all') throw new Error(USAGE);
  let reason: string | undefined;
  let confirm = false;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--confirm' && !confirm) {
      confirm = true;
    } else if (flag === '--reason' && reason === undefined) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--reason needs a value');
      reason = value;
      i += 1;
    } else {
      throw new Error(`Unexpected or repeated argument ${flag}. ${USAGE}`);
    }
  }
  if (reason === undefined) throw new Error(`--reason is required. ${USAGE}`);
  return { realm, reason, confirm };
}

async function main(): Promise<number> {
  let command: RevokeAllSessionsCommand;
  try {
    command = parseRevokeAllSessionsArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const prisma = new PrismaClient();
  try {
    const result = await revokeInstallationSessions(prisma, command);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.confirmed) process.stdout.write('Nothing was revoked. Repeat with --confirm to revoke.\n');
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
