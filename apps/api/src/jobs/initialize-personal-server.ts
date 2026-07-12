import { Prisma, PrismaClient, type PrismaClient as PrismaClientType } from '@prisma/client';
import { GOVERNANCE_PRINCIPLES } from '@charitypilot/shared';
import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { isConfiguredSecret } from '../utils/secrets.js';
import {
  isPersonalServerDeployment,
  PERSONAL_SERVER_DEPLOYMENT_MODE,
} from '../utils/personal-server.js';

const SALT_ROUNDS = 12;
const PERSONAL_INITIALIZER_ADVISORY_LOCK = 1_129_337_111;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

type InitializerEnv = Record<string, string | undefined>;
type InitializerClient = Pick<PrismaClientType, '$transaction'>;

export type PersonalServerInitializerConfig = {
  organisationName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
};

function canonicalText(
  value: string | undefined,
  name: string,
  maximumLength: number,
): string {
  const canonical = value?.trim() ?? '';
  if (!canonical) throw new Error(`${name} is required`);
  if (canonical !== value) throw new Error(`${name} must not contain leading or trailing whitespace`);
  if (canonical.length > maximumLength) throw new Error(`${name} must be at most ${maximumLength} characters`);
  if (CONTROL_CHARACTERS.test(canonical)) throw new Error(`${name} must not contain control characters`);
  return canonical;
}

export function validateStrongPersonalServerPassword(
  value: string | undefined,
  name = 'PERSONAL_SERVER_OWNER_PASSWORD',
): string {
  if (!isConfiguredSecret(value)) throw new Error(`${name} must be configured for this one-shot command`);
  if (CONTROL_CHARACTERS.test(value)) throw new Error(`${name} must not contain control characters`);
  if (value.length < 12 || Buffer.byteLength(value, 'utf8') > 72) {
    throw new Error(`${name} must be at least 12 characters and at most 72 UTF-8 bytes`);
  }
  if (!/[A-Z]/u.test(value) || !/[a-z]/u.test(value) || !/[0-9]/u.test(value) || !/[^A-Za-z0-9]/u.test(value)) {
    throw new Error(`${name} must contain uppercase, lowercase, number, and symbol characters`);
  }
  return value;
}

function canonicalEmail(value: string | undefined, name: string): string {
  const email = canonicalText(value, name, 254);
  if (email !== email.toLowerCase()) throw new Error(`${name} must be lowercase`);
  if (!EMAIL_PATTERN.test(email)) throw new Error(`${name} must be a valid email address`);
  return email;
}

export function getPersonalServerInitializerConfig(
  env: InitializerEnv = process.env,
): PersonalServerInitializerConfig {
  if (env.NODE_ENV !== 'production') {
    throw new Error('Personal server initialization requires NODE_ENV=production');
  }
  if (!isPersonalServerDeployment(env)) {
    throw new Error(
      `Personal server initialization requires CHARITYPILOT_DEPLOYMENT_MODE=${PERSONAL_SERVER_DEPLOYMENT_MODE}`,
    );
  }

  return {
    organisationName: canonicalText(
      env.PERSONAL_SERVER_ORGANISATION_NAME,
      'PERSONAL_SERVER_ORGANISATION_NAME',
      300,
    ),
    ownerName: canonicalText(env.PERSONAL_SERVER_OWNER_NAME, 'PERSONAL_SERVER_OWNER_NAME', 200),
    ownerEmail: canonicalEmail(env.PERSONAL_SERVER_OWNER_EMAIL, 'PERSONAL_SERVER_OWNER_EMAIL'),
    ownerPassword: validateStrongPersonalServerPassword(env.PERSONAL_SERVER_OWNER_PASSWORD),
  };
}

async function seedGovernanceReferenceData(tx: Prisma.TransactionClient): Promise<{
  principleCount: number;
  standardCount: number;
}> {
  let principleCount = 0;
  let standardCount = 0;
  let globalSortOrder = 1;

  for (const principle of GOVERNANCE_PRINCIPLES) {
    const storedPrinciple = await tx.governancePrinciple.upsert({
      where: { number: principle.number },
      update: {
        title: principle.title,
        description: principle.description,
        sortOrder: principle.number,
      },
      create: {
        number: principle.number,
        title: principle.title,
        description: principle.description,
        sortOrder: principle.number,
      },
    });
    principleCount += 1;

    for (const standard of principle.standards) {
      await tx.governanceStandard.upsert({
        where: { code: standard.code },
        update: {
          principleId: storedPrinciple.id,
          title: standard.title,
          isCore: standard.isCore,
          isAdditional: standard.isAdditional,
          sortOrder: globalSortOrder,
        },
        create: {
          principleId: storedPrinciple.id,
          code: standard.code,
          title: standard.title,
          isCore: standard.isCore,
          isAdditional: standard.isAdditional,
          sortOrder: globalSortOrder,
        },
      });
      globalSortOrder += 1;
      standardCount += 1;
    }
  }

  return { principleCount, standardCount };
}

export async function initializePersonalServer(
  client: InitializerClient,
  config: PersonalServerInitializerConfig,
  now = new Date(),
): Promise<{
  initialized: true;
  organisationCreated: 1;
  ownerCreated: 1;
  principleCount: number;
  standardCount: number;
}> {
  const passwordHash = await bcrypt.hash(config.ownerPassword, SALT_ROUNDS);

  return client.$transaction(async (tx) => {
    const advisoryLock = await tx.$queryRaw<Array<{ acquired: number }>>`
      WITH "advisoryLock" AS (
        SELECT pg_advisory_xact_lock(${PERSONAL_INITIALIZER_ADVISORY_LOCK})
      )
      SELECT 1::int AS "acquired" FROM "advisoryLock"
    `;
    if (advisoryLock.length !== 1 || advisoryLock[0]?.acquired !== 1) {
      throw new Error('Personal server initialization could not acquire its transaction lock');
    }

    const [organisationCount, userCount] = await Promise.all([
      tx.organisation.count(),
      tx.user.count(),
    ]);
    if (organisationCount !== 0 || userCount !== 0) {
      throw new Error(
        'Personal server initialization refused: Organisation and User tables must both be empty',
      );
    }

    const governance = await seedGovernanceReferenceData(tx);
    const organisation = await tx.organisation.create({
      data: { name: config.organisationName },
      select: { id: true },
    });
    await tx.user.create({
      data: {
        email: config.ownerEmail,
        name: config.ownerName,
        passwordHash,
        role: 'OWNER',
        organisationId: organisation.id,
        emailVerified: true,
      },
      select: { id: true },
    });
    await tx.subscription.create({
      data: {
        organisationId: organisation.id,
        plan: 'COMPLETE',
        status: 'ACTIVE',
        trialEndsAt: null,
        currentPeriodStart: now,
        currentPeriodEnd: null,
      },
      select: { id: true },
    });

    return {
      initialized: true,
      organisationCreated: 1,
      ownerCreated: 1,
      ...governance,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function main(): Promise<void> {
  const config = getPersonalServerInitializerConfig();
  const prisma = new PrismaClient();
  try {
    const result = await initializePersonalServer(prisma, config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Personal server initialization failed';
    process.stderr.write(`[personal-server-initialize] ${message}\n`);
    process.exitCode = 1;
  });
}
