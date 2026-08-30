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

export async function createPlatformOperator(
  prisma: PrismaClient,
  input: { email: string; name: string },
): Promise<{ operatorId: string; resetToken: string }> {
  const { email, name } = input;
  if (email.trim() !== email || email !== email.toLowerCase() || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new Error('Operator email must be a canonical lowercase email address');
  }
  if (!name.trim()) {
    throw new Error('Operator name must not be empty');
  }

  const existing = await prisma.platformOperator.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    throw new Error(`A platform operator with email ${email} already exists`);
  }

  const resetToken = crypto.randomBytes(32).toString('base64url');
  const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000);

  // The operator never receives a password from the command line. A random,
  // discarded secret fills passwordHash so the column is never empty and no
  // login is possible until the reset link is used.
  const unusablePassword = crypto.randomBytes(32).toString('base64url');

  const created = await prisma.platformOperator.create({
    data: {
      email,
      name,
      passwordHash: await bcrypt.hash(unusablePassword, 10),
      resetToken: crypto.createHash('sha256').update(resetToken).digest('hex'),
      resetTokenExpiry,
    },
    select: { id: true },
  });

  return { operatorId: created.id, resetToken };
}

async function main(): Promise<void> {
  assertOperatorBootstrapRuntime();

  const emailArg = process.argv.find((a) => a.startsWith('--email='))?.split('=')[1];
  const nameArg = process.argv.find((a) => a.startsWith('--name='))?.split('=')[1] ?? 'Platform owner';
  if (!emailArg) {
    throw new Error('Usage: npm run owner:create -- --email=<canonical-lowercase-email> [--name=<name>]');
  }

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const { operatorId, resetToken } = await createPlatformOperator(prisma, { email: emailArg, name: nameArg });
    const origin = process.env.OWNER_CONSOLE_ORIGIN ?? process.env.APP_ORIGIN ?? '';
    process.stdout.write(`Created platform operator ${operatorId} (${emailArg}).\n`);
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
