import { Prisma, PrismaClient, type PrismaClient as PrismaClientType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateStrongPersonalServerPassword } from './initialize-personal-server.js';
import { hashOpaqueToken } from '../services/session-tokens.js';
import {
  getPersonalServerOrigin,
  isExactLoopbackHttpOrigin,
  isHttpsDnsOrigin,
  isPersonalServerDeployment,
  parseExactOrigin,
  PERSONAL_SERVER_DEPLOYMENT_MODE,
} from '../utils/personal-server.js';

const SALT_ROUNDS = 12;
const PERSONAL_ACCOUNT_ADVISORY_LOCK = 1_129_337_112;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

type AccountEnv = Record<string, string | undefined>;
type AccountClient = Pick<PrismaClientType, '$transaction'>;

export type PersonalServerPasswordReset = {
  email: string;
  password: string;
};

export type PersonalServerResetLinkRequest = {
  email: string;
  origin: string;
};

function assertPersonalServerAccountRuntime(env: AccountEnv): void {
  if (env.NODE_ENV !== 'production') {
    throw new Error('Personal server account administration requires NODE_ENV=production');
  }
  if (!isPersonalServerDeployment(env)) {
    throw new Error(
      `Personal server account administration requires CHARITYPILOT_DEPLOYMENT_MODE=${PERSONAL_SERVER_DEPLOYMENT_MODE}`,
    );
  }
}

function canonicalAccountEmail(env: AccountEnv): string {
  const email = env.PERSONAL_SERVER_ACCOUNT_EMAIL ?? '';
  if (
    !email ||
    email.trim() !== email ||
    email !== email.toLowerCase() ||
    email.length > 254 ||
    CONTROL_CHARACTERS.test(email) ||
    !EMAIL_PATTERN.test(email)
  ) {
    throw new Error('PERSONAL_SERVER_ACCOUNT_EMAIL must be a canonical lowercase email address');
  }
  return email;
}

export function getPersonalServerPasswordReset(
  env: AccountEnv = process.env,
): PersonalServerPasswordReset {
  assertPersonalServerAccountRuntime(env);

  return {
    email: canonicalAccountEmail(env),
    password: validateStrongPersonalServerPassword(
      env.PERSONAL_SERVER_ACCOUNT_PASSWORD,
      'PERSONAL_SERVER_ACCOUNT_PASSWORD',
    ),
  };
}

export function getPersonalServerResetLinkRequest(
  env: AccountEnv = process.env,
): PersonalServerResetLinkRequest {
  assertPersonalServerAccountRuntime(env);
  const origin = getPersonalServerOrigin(env);
  if (!origin) {
    throw new Error('Personal server reset-link requires one valid exact personal-server origin');
  }
  return { email: canonicalAccountEmail(env), origin: origin.origin };
}

export async function issuePersonalServerResetLink(
  client: AccountClient,
  command: PersonalServerResetLinkRequest,
  now = new Date(),
): Promise<{ resetLinkCreated: true; resetUrl: string; expiresAt: string }> {
  const origin = parseExactOrigin(command.origin);
  if (!origin || (!isHttpsDnsOrigin(origin.origin) && !isExactLoopbackHttpOrigin(origin.origin))) {
    throw new Error('Personal server reset-link refused: origin is not an exact safe personal-server origin');
  }
  const plaintextToken = crypto.randomBytes(32).toString('base64url');
  const resetToken = hashOpaqueToken(plaintextToken);
  const resetTokenExpiry = new Date(now.getTime() + 60 * 60 * 1000);
  const resetUrl = new URL('/reset-password', origin);
  resetUrl.hash = new URLSearchParams({ token: plaintextToken }).toString();

  return client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${PERSONAL_ACCOUNT_ADVISORY_LOCK})`;

    const organisationCount = await tx.organisation.count();
    if (organisationCount !== 1) {
      throw new Error('Personal server reset-link refused: expected exactly one organisation');
    }

    const user = await tx.user.findUnique({
      where: { email: command.email },
      select: { id: true, organisationId: true, lifecycleStatus: true },
    });
    if (!user || user.lifecycleStatus !== 'ACTIVE') {
      throw new Error('Personal server reset-link refused: active account not found');
    }

    const updated = await tx.user.updateMany({
      where: {
        id: user.id,
        email: command.email,
        organisationId: user.organisationId,
        lifecycleStatus: 'ACTIVE',
      },
      data: { resetToken, resetTokenExpiry },
    });
    if (updated.count !== 1) {
      throw new Error('Personal server reset-link refused: account changed concurrently');
    }

    return {
      resetLinkCreated: true,
      resetUrl: resetUrl.toString(),
      expiresAt: resetTokenExpiry.toISOString(),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function resetPersonalServerPassword(
  client: AccountClient,
  command: PersonalServerPasswordReset,
  now = new Date(),
): Promise<{ passwordReset: true; sessionsRevoked: number }> {
  const passwordHash = await bcrypt.hash(command.password, SALT_ROUNDS);

  return client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${PERSONAL_ACCOUNT_ADVISORY_LOCK})`;

    const organisationCount = await tx.organisation.count();
    if (organisationCount !== 1) {
      throw new Error('Personal server password reset refused: expected exactly one organisation');
    }

    const user = await tx.user.findUnique({
      where: { email: command.email },
      select: {
        id: true,
        email: true,
        lifecycleStatus: true,
        organisationId: true,
      },
    });
    if (!user || user.lifecycleStatus !== 'ACTIVE') {
      throw new Error('Personal server password reset refused: active account not found');
    }

    const updated = await tx.user.updateMany({
      where: {
        id: user.id,
        email: command.email,
        organisationId: user.organisationId,
        lifecycleStatus: 'ACTIVE',
      },
      data: {
        passwordHash,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });
    if (updated.count !== 1) {
      throw new Error('Personal server password reset refused: account changed concurrently');
    }

    const revoked = await tx.authSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now, revocationReason: 'PASSWORD_RESET' },
    });

    return { passwordReset: true, sessionsRevoked: revoked.count };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function parseCommand(args: string[]): 'reset-link' | 'reset-password' {
  if (args.length !== 1 || (args[0] !== 'reset-link' && args[0] !== 'reset-password')) {
    throw new Error('Usage: node dist/jobs/personal-server-account.js <reset-link|reset-password>');
  }
  return args[0];
}

async function main(): Promise<void> {
  const commandName = parseCommand(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const result = commandName === 'reset-link'
      ? await issuePersonalServerResetLink(prisma, getPersonalServerResetLinkRequest())
      : await resetPersonalServerPassword(prisma, getPersonalServerPasswordReset());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Personal server account administration failed';
    process.stderr.write(`[personal-server-account] ${message}\n`);
    process.exitCode = 1;
  });
}
