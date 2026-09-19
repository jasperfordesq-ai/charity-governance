import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import {
  documentStorageProviders,
  type DocumentStorageProviderRegistry,
} from './document-storage-provider.js';
import { envDefaultProviderId } from './document-storage-resolution.js';
import { isProductionEnv } from '../utils/deployment-profile.js';

// Like owner-tenants.service.ts, this file reads and writes Organisation rows
// without a tenant scope. No tenant-facing route may import it; the sole-writer
// test enforces that.

/**
 * What a platform operator may configure for one charity, and what they need to
 * see to configure it sensibly.
 *
 * Three things are settable. Each is a decision the charity cannot make for
 * itself today and which somebody at the platform therefore has to make on
 * their behalf, which is exactly why every change here is audited with the
 * operator's name and their reason.
 */
export type StorageProviderOption = {
  id: string;
  stage: string;
  /** False when the deployment itself forbids it, with the reason why. */
  selectable: boolean;
  unavailableBecause?: string;
};

export type TenantConfiguration = {
  tenantId: string;
  name: string;
  /** null means "follow the deployment default". */
  documentStorageProvider: string | null;
  documentStorageAlphaOptIn: boolean;
  /** What null resolves to right now, so the console can say so. */
  deploymentDefaultProvider: string;
  availableProviders: StorageProviderOption[];
  plan: string | null;
  subscriptionStatus: string | null;
  /** Read-only: connecting Confluence needs the charity's own Atlassian sign-in. */
  confluence: {
    status: string;
    connectedAt: Date | null;
    spaceKey: string | null;
    lastError: string | null;
  } | null;
  updatedAt: Date;
};

const PLANS = ['ESSENTIALS', 'COMPLETE'] as const;
export type TenantPlan = (typeof PLANS)[number];

const LOCAL_PROVIDER_ID = 'local';

/**
 * Why a provider cannot be chosen on this deployment, or undefined if it can.
 *
 * The local driver is the only one with a deployment-level veto, and it is the
 * same rule `document-storage-resolution.ts` applies when a request actually
 * reaches storage. Saying it here as well means the console refuses at the
 * point of choosing rather than letting an operator save a setting that would
 * fail later, on somebody else's upload.
 */
function unavailableBecause(
  provider: string,
  registry: DocumentStorageProviderRegistry,
): string | undefined {
  if (provider !== LOCAL_PROVIDER_ID) return undefined;
  if (!isProductionEnv()) return undefined;
  if (envDefaultProviderId(registry) === LOCAL_PROVIDER_ID) return undefined;

  return (
    'This deployment stores documents with a hosted provider, and local storage here would '
    + 'write files inside the container: ephemeral, outside the backup, and outside the '
    + 'residency guarantee.'
  );
}

function providerOptions(registry: DocumentStorageProviderRegistry): StorageProviderOption[] {
  return registry.list().map((descriptor) => {
    const blocked = unavailableBecause(descriptor.id, registry);
    return {
      id: descriptor.id,
      stage: descriptor.stage,
      selectable: !blocked,
      ...(blocked ? { unavailableBecause: blocked } : {}),
    };
  });
}

const configurationSelect = {
  id: true,
  name: true,
  documentStorageProvider: true,
  documentStorageAlphaOptIn: true,
  updatedAt: true,
  subscription: { select: { plan: true, status: true } },
  integrations: {
    where: { provider: 'CONFLUENCE' as const },
    select: { status: true, connectedAt: true, config: true, lastError: true },
    take: 1,
  },
} as const;

type ConfigurationRow = {
  id: string;
  name: string;
  documentStorageProvider: string | null;
  documentStorageAlphaOptIn: boolean;
  updatedAt: Date;
  subscription: { plan: string; status: string } | null;
  integrations: Array<{
    status: string;
    connectedAt: Date | null;
    config: unknown;
    lastError: string | null;
  }>;
};

function spaceKeyOf(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const value = (config as Record<string, unknown>)['spaceKey'];
  return typeof value === 'string' ? value : null;
}

function toConfiguration(
  row: ConfigurationRow,
  registry: DocumentStorageProviderRegistry,
): TenantConfiguration {
  const integration = row.integrations[0];
  return {
    tenantId: row.id,
    name: row.name,
    documentStorageProvider: row.documentStorageProvider,
    documentStorageAlphaOptIn: row.documentStorageAlphaOptIn,
    deploymentDefaultProvider: envDefaultProviderId(registry),
    availableProviders: providerOptions(registry),
    plan: row.subscription?.plan ?? null,
    subscriptionStatus: row.subscription?.status ?? null,
    confluence: integration
      ? {
          status: integration.status,
          connectedAt: integration.connectedAt,
          spaceKey: spaceKeyOf(integration.config),
          lastError: integration.lastError,
        }
      : null,
    updatedAt: row.updatedAt,
  };
}

export async function getTenantConfiguration(
  prisma: PrismaClient,
  tenantId: string,
  registry: DocumentStorageProviderRegistry = documentStorageProviders,
): Promise<TenantConfiguration> {
  const row = (await prisma.organisation.findUnique({
    where: { id: tenantId },
    select: configurationSelect,
  })) as unknown as ConfigurationRow | null;

  if (!row) throw new AppError(404, 'TENANT_NOT_FOUND', 'Organisation not found');
  return toConfiguration(row, registry);
}

export type TenantConfigurationChange = {
  /** Absent means "leave it alone"; null means "follow the deployment default". */
  documentStorageProvider?: string | null;
  documentStorageAlphaOptIn?: boolean;
  plan?: TenantPlan;
};

/**
 * Validates a requested provider against the same three rules the request path
 * applies, so a setting that would fail on the charity's next upload cannot be
 * saved in the first place.
 */
function assertProviderSelectable(
  provider: string,
  alphaOptIn: boolean,
  registry: DocumentStorageProviderRegistry,
): void {
  if (!registry.isKnown(provider)) {
    throw new AppError(
      400,
      'UNKNOWN_STORAGE_PROVIDER',
      `There is no document storage provider called "${provider}".`,
    );
  }

  const blocked = unavailableBecause(provider, registry);
  if (blocked) {
    throw new AppError(400, 'STORAGE_PROVIDER_NOT_AVAILABLE', blocked);
  }

  const descriptor = registry.list().find((entry) => entry.id === provider);
  if (descriptor?.stage === 'alpha' && !alphaOptIn) {
    throw new AppError(
      400,
      'STORAGE_PROVIDER_ALPHA',
      `${provider} is an alpha provider. The charity has to opt in to alpha providers before `
        + 'it can be selected, which is a decision to take with them rather than for them.',
    );
  }
}

export async function updateTenantConfiguration(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    change: TenantConfigurationChange;
    reason: string;
    operator: { id: string; email: string };
  },
  registry: DocumentStorageProviderRegistry = documentStorageProviders,
): Promise<TenantConfiguration> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError(
      400,
      'REASON_REQUIRED',
      'A reason is required: this changes another organisation’s configuration.',
    );
  }

  const { change } = input;
  if (
    change.documentStorageProvider === undefined
    && change.documentStorageAlphaOptIn === undefined
    && change.plan === undefined
  ) {
    throw new AppError(400, 'NOTHING_TO_CHANGE', 'No configuration change was requested.');
  }

  return prisma.$transaction(async (tx) => {
    // Locked before it is read, as the lifecycle transition does, so two
    // operators cannot interleave between the read and the write.
    const locked = (await tx.$queryRaw(
      Prisma.sql`SELECT "id", "documentStorageProvider", "documentStorageAlphaOptIn"
                   FROM "Organisation" WHERE "id" = ${input.tenantId} FOR UPDATE`,
    )) as Array<{
      id: string;
      documentStorageProvider: string | null;
      documentStorageAlphaOptIn: boolean;
    }>;

    const current = locked[0];
    if (!current) throw new AppError(404, 'TENANT_NOT_FOUND', 'Organisation not found');

    // The opt-in that applies is the one this change leaves behind, not the one
    // it started with: turning the opt-in on and choosing an alpha provider in
    // the same request is a coherent thing to want.
    const alphaOptIn = change.documentStorageAlphaOptIn ?? current.documentStorageAlphaOptIn;

    if (change.documentStorageProvider !== undefined && change.documentStorageProvider !== null) {
      assertProviderSelectable(change.documentStorageProvider, alphaOptIn, registry);
    }

    // Turning the opt-in OFF while an alpha provider is selected would leave the
    // charity on a provider it is no longer allowed to be on.
    const provider =
      change.documentStorageProvider === undefined
        ? current.documentStorageProvider
        : change.documentStorageProvider;
    if (provider && !alphaOptIn) {
      const descriptor = registry.list().find((entry) => entry.id === provider);
      if (descriptor?.stage === 'alpha') {
        throw new AppError(
          400,
          'STORAGE_PROVIDER_ALPHA',
          `${provider} is an alpha provider and is currently selected. Move the charity to a `
            + 'stable provider before withdrawing its opt-in.',
        );
      }
    }

    const data: Record<string, unknown> = {};
    if (change.documentStorageProvider !== undefined) {
      data['documentStorageProvider'] = change.documentStorageProvider;
    }
    if (change.documentStorageAlphaOptIn !== undefined) {
      data['documentStorageAlphaOptIn'] = change.documentStorageAlphaOptIn;
    }
    if (Object.keys(data).length > 0) {
      await tx.organisation.update({ where: { id: input.tenantId }, data });
    }

    if (change.plan !== undefined) {
      const updated = await tx.subscription.updateMany({
        where: { organisationId: input.tenantId },
        data: { plan: change.plan },
      });
      if (updated.count === 0) {
        throw new AppError(
          409,
          'NO_SUBSCRIPTION',
          'This organisation has no subscription record, so its plan cannot be changed here.',
        );
      }
    }

    await tx.securityAuditEvent.create({
      data: {
        organisationId: input.tenantId,
        type: 'ORGANISATION_CONFIGURATION_CHANGED',
        actorKind: 'SUPPORT',
        actorUserId: null,
        actorLabel: input.operator.email,
        subjectLabel: `Organisation ${input.tenantId}`,
        reason,
        context: {
          operatorId: input.operator.id,
          // Before and after for every field the request touched, so the row
          // answers "what changed" without needing the previous row.
          ...(change.documentStorageProvider !== undefined
            ? {
                previousDocumentStorageProvider: current.documentStorageProvider,
                newDocumentStorageProvider: change.documentStorageProvider,
              }
            : {}),
          ...(change.documentStorageAlphaOptIn !== undefined
            ? {
                previousDocumentStorageAlphaOptIn: current.documentStorageAlphaOptIn,
                newDocumentStorageAlphaOptIn: change.documentStorageAlphaOptIn,
              }
            : {}),
          ...(change.plan !== undefined ? { newPlan: change.plan } : {}),
        },
      },
    });

    const row = (await tx.organisation.findUnique({
      where: { id: input.tenantId },
      select: configurationSelect,
    })) as unknown as ConfigurationRow;

    return toConfiguration(row, registry);
  });
}

export type TenantAdministrativeEvent = {
  id: string;
  type: string;
  actorLabel: string;
  reason: string;
  occurredAt: Date;
  context: unknown;
};

/**
 * What platform operators have done to this charity, newest first.
 *
 * Only the events an operator caused: suspensions, closures and configuration
 * changes. The charity's own security trail — who suspended whom, whose
 * sessions were revoked — is theirs, is visible to them on their Team page,
 * and is nobody at the platform's business to browse. An operator needs to see
 * what the platform did, which is a much narrower thing.
 */
const OPERATOR_CAUSED_EVENTS = [
  'ORGANISATION_SUSPENDED',
  'ORGANISATION_REACTIVATED',
  'ORGANISATION_CLOSED',
  'ORGANISATION_CONFIGURATION_CHANGED',
] as const;

const ADMINISTRATIVE_EVENT_LIMIT = 50;

export async function listTenantAdministrativeEvents(
  prisma: PrismaClient,
  tenantId: string,
): Promise<TenantAdministrativeEvent[]> {
  const rows = await prisma.securityAuditEvent.findMany({
    where: {
      organisationId: tenantId,
      type: { in: [...OPERATOR_CAUSED_EVENTS] },
      actorKind: 'SUPPORT',
    },
    select: {
      id: true,
      type: true,
      actorLabel: true,
      reason: true,
      occurredAt: true,
      context: true,
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: ADMINISTRATIVE_EVENT_LIMIT,
  });

  return rows as TenantAdministrativeEvent[];
}
