import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { PERSONAL_SERVER_DEPLOYMENT_MODE } from '../utils/personal-server.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_HOURS = 24;

export function assertOperatorBootstrapRuntime(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') {
    throw new Error('Platform operator bootstrap requires NODE_ENV=production');
  }
  if (env.CHARITYPILOT_DEPLOYMENT_MODE === PERSONAL_SERVER_DEPLOYMENT_MODE) {
    throw new Error('Platform operator bootstrap is not available on a personal-server deployment');
  }
}

function parseAbsoluteOrigin(env: Record<string, string | undefined>): string {
  const origin = env.OWNER_CONSOLE_ORIGIN ?? env.APP_ORIGIN;
  if (!origin) {
    throw new Error(
      'Set OWNER_CONSOLE_ORIGIN or APP_ORIGIN to an absolute URL (e.g., https://console.example.org)',
    );
  }
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Must use http:// or https://');
    }
    return origin;
  } catch (err) {
    throw new Error(
      `Invalid origin: ${origin}. Set OWNER_CONSOLE_ORIGIN or APP_ORIGIN to an absolute URL (e.g., https://console.example.org)`,
    );
  }
}

function generateResetToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export async function reissuePlatformOperatorResetToken(
  prisma: PrismaClient,
  email: string,
  env: Record<string, string | undefined>,
): Promise<{ operatorId: string; resetToken: string }> {
  // Validate origin BEFORE any database operation
  parseAbsoluteOrigin(env);

  const existing = await prisma.platformOperator.findUnique({ where: { email }, select: { id: true } });
  if (!existing) {
    throw new Error(`No platform operator found with email ${email}. Operator not found.`);
  }

  const { raw, hash } = generateResetToken();
  const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000);

  await prisma.platformOperator.update({
    where: { id: existing.id },
    data: {
      resetToken: hash,
      resetTokenExpiry,
    },
  });

  return { operatorId: existing.id, resetToken: raw };
}

export async function createPlatformOperator(
  prisma: PrismaClient,
  input: { email: string; name: string },
  env: Record<string, string | undefined> = {},
  reissue: boolean = false,
): Promise<{ operatorId: string; resetToken: string }> {
  const { email, name } = input;

  // Validate origin BEFORE any database operation
  parseAbsoluteOrigin(env);

  if (email.trim() !== email || email !== email.toLowerCase() || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new Error('Operator email must be a canonical lowercase email address');
  }
  if (!name.trim()) {
    throw new Error('Operator name must not be empty');
  }

  const existing = await prisma.platformOperator.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    if (reissue) {
      return reissuePlatformOperatorResetToken(prisma, email, env);
    }
    throw new Error(`A platform operator with email ${email} already exists`);
  }

  // The operator never receives a password from the command line. A random,
  // discarded secret fills passwordHash so the column is never empty and no
  // login is possible until the reset link is used.
  const unusablePassword = crypto.randomBytes(32).toString('base64url');
  const { raw, hash } = generateResetToken();
  const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000);

  const created = await prisma.platformOperator.create({
    data: {
      email,
      name,
      passwordHash: await bcrypt.hash(unusablePassword, 10),
      resetToken: hash,
      resetTokenExpiry,
    },
    select: { id: true },
  });

  return { operatorId: created.id, resetToken: raw };
}

async function main(): Promise<void> {
  assertOperatorBootstrapRuntime();

  const emailArg = process.argv.find((a) => a.startsWith('--email='))?.split('=')[1];
  const nameArg = process.argv.find((a) => a.startsWith('--name='))?.split('=')[1] ?? 'Platform owner';
  const reissueArg = process.argv.some((a) => a === '--reissue');

  if (!emailArg) {
    throw new Error(
      'Usage: npm run owner:create -- --email=<canonical-lowercase-email> [--name=<name>] [--reissue]',
    );
  }

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const { operatorId, resetToken } = await createPlatformOperator(
      prisma,
      { email: emailArg, name: nameArg },
      { OWNER_CONSOLE_ORIGIN: process.env.OWNER_CONSOLE_ORIGIN, APP_ORIGIN: process.env.APP_ORIGIN },
      reissueArg,
    );
    const origin = process.env.OWNER_CONSOLE_ORIGIN ?? process.env.APP_ORIGIN ?? '';
    const action = reissueArg ? 'Reissued reset token for' : 'Created platform operator';
    process.stdout.write(`${action} ${operatorId} (${emailArg}).\n`);
    process.stdout.write(`Set-password link (valid ${RESET_TOKEN_HOURS}h, shown once):\n`);
    process.stdout.write(`${origin}/owner/set-password?token=${resetToken}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly, so the module stays importable by tests.
if (process.argv[1]?.endsWith('create-platform-operator.js')) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
