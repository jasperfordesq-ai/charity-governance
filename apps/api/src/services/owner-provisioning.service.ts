import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

const VERIFY_TOKEN_HOURS = 48;

export async function provisionTenant(
  prisma: PrismaClient,
  input: {
    organisationName: string;
    ownerName: string;
    ownerEmail: string;
    plan: 'ESSENTIALS' | 'COMPLETE';
    trialDays: number;
  },
): Promise<{ organisationId: string; userId: string; verifyToken: string }> {
  if (!Number.isInteger(input.trialDays) || input.trialDays < 1) {
    throw new AppError(400, 'INVALID_TRIAL_DAYS', 'Trial length must be at least one day');
  }

  const email = input.ownerEmail.trim().toLowerCase();
  const verifyToken = crypto.randomBytes(32).toString('base64url');
  const verifyTokenHash = crypto.createHash('sha256').update(verifyToken).digest('hex');

  // The operator never chooses another person's credential: a random secret is
  // hashed and discarded, and the owner sets a real password via the link.
  const unusablePassword = crypto.randomBytes(32).toString('base64url');
  const passwordHash = await bcrypt.hash(unusablePassword, 10);

  const trialEndsAt = new Date(Date.now() + input.trialDays * 24 * 60 * 60 * 1000);
  const verifyTokenExpiry = new Date(Date.now() + VERIFY_TOKEN_HOURS * 60 * 60 * 1000);

  const created = await prisma.$transaction(async (tx) => {
    // The duplicate check happens INSIDE the transaction, alongside the
    // organisation/user/subscription writes, so a concurrent provision of the
    // same email cannot race past this check and leave a partial organisation
    // behind: register() elsewhere silently no-ops on a taken email to avoid
    // enumeration, but a trusted operator must see a real 409 instead.
    const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'That email already belongs to an account');
    }

    const organisation = await tx.organisation.create({ data: { name: input.organisationName } });

    const user = await tx.user.create({
      data: {
        email,
        name: input.ownerName,
        passwordHash,
        role: 'OWNER',
        organisationId: organisation.id,
        emailVerified: false,
        verifyToken: verifyTokenHash,
        verifyTokenExpiry,
      },
      select: { id: true },
    });

    await tx.subscription.create({
      data: { organisationId: organisation.id, plan: input.plan, status: 'TRIALING', trialEndsAt },
    });

    return { organisationId: organisation.id, userId: user.id };
  });

  return { ...created, verifyToken };
}
