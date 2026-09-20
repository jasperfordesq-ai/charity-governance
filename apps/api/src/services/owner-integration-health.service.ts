/**
 * What an operator can see about one tenant's Confluence integration.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * READ-ONLY, WITH NO WRITE ACTIONS, AND THAT IS A DESIGN CONSTRAINT.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * There is no operator "reconnect", no operator "clear the error", no operator
 * "re-queue". Connecting Confluence requires the charity's own Atlassian
 * sign-in, so an operator could not perform it even if the button existed — and
 * an operator-triggered republish would push a charity's governance documents
 * to a third-party site on somebody else's behalf, which is not an action a
 * platform operator has any standing to take. The owner console's job here is
 * to let somebody answer "why has this charity's publishing stopped" without
 * asking them to read the database.
 *
 * ## What it deliberately does not carry
 *
 * No token, no envelope, no key fingerprint, and no `refreshClaimToken`. The
 * fields below are connection facts, counts, and timestamps. `lastError` is
 * included because `confluence-connection.service.ts` only ever writes one of
 * two fixed reasons there and never Atlassian's own error text — if that ever
 * changes, this is a place it would leak, and `owner-integration-health.test.ts`
 * pins the response's key set for that reason.
 *
 * ## Granted versus required scopes
 *
 * Both are shown, because the difference is the single most common cause of an
 * integration that looks healthy and cannot erase: a charity that authorised
 * before the delete scopes were added has a working connection with a missing
 * permission, and nothing about `status: CONNECTED` says so.
 */
import type { PrismaClient } from '@prisma/client';
import { missingConfluenceScopes } from './confluence-scopes.js';
import type { IntegrationReconcileOutcome } from './confluence-reconcile.service.js';
import { ATLASSIAN_REFRESH_INACTIVITY_EXPIRY_MS } from './integration-reconcile.service.js';

const PROVIDER = 'CONFLUENCE' as const;

export type IntegrationPublicationCounts = {
  pending: number;
  processed: number;
  deadLettered: number;
  retired: number;
};

export type IntegrationRemoteStateCounts = {
  visible: number;
  archived: number;
  trashed: number;
  gone: number;
  unknown: number;
  neverChecked: number;
};

export type TenantIntegrationHealth = {
  provider: 'CONFLUENCE';
  status: string;
  connectedAt: string | null;
  lastError: string | null;
  siteUrl: string | null;
  siteName: string | null;
  spaceKey: string | null;
  spaceName: string | null;
  grantedScopes: string[];
  missingScopes: string[];
  lastRefreshedAt: string | null;
  lastReconcileAt: string | null;
  lastReconcileOutcome: IntegrationReconcileOutcome | null;
  /**
   * When the authorisation lapses if the charity does not use it, and whether
   * a notice has been raised. Null when there is no clock to run — an
   * integration that is not connected, or one with neither a refresh nor a
   * connection timestamp to age from.
   */
  authorisationExpiresAt: string | null;
  authorisationLapseNoticedAt: string | null;
  publications: IntegrationPublicationCounts;
  remoteStates: IntegrationRemoteStateCounts;
  declaredPlan: string | null;
  declaredResidency: string | null;
  declaredAt: string | null;
  /** Always false. See `integration-declared-environment.service.ts`. */
  residencyControlledByCharityPilot: false;
};

type HealthClient = {
  organisationIntegration: {
    findUnique(args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    }): Promise<Record<string, unknown> | null>;
  };
  documentPublication: {
    groupBy(args: {
      by: string[];
      where: Record<string, unknown>;
      _count: { _all: true };
    }): Promise<Array<Record<string, unknown>>>;
  };
};

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function readConfigString(config: unknown, key: string): string | null {
  if (config === null || typeof config !== 'object') return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function countsFrom(
  rows: Array<Record<string, unknown>>,
  field: string,
): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  for (const row of rows) {
    const key = row[field] === null || row[field] === undefined ? null : String(row[field]);
    const count = (row._count as { _all?: number } | undefined)?._all ?? 0;
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  return counts;
}

/**
 * One tenant's integration health, or `null` when it has never connected.
 *
 * `null` rather than a zeroed object on purpose: "this charity has no
 * Confluence integration" and "this charity has an integration with nothing in
 * it" are different answers, and a console that rendered the second for the
 * first would have an operator looking for a fault in a charity that simply
 * does not use the feature.
 */
export async function getTenantIntegrationHealth(
  prisma: PrismaClient,
  tenantId: string,
): Promise<TenantIntegrationHealth | null> {
  const client = prisma as unknown as HealthClient;
  const integration = await client.organisationIntegration.findUnique({
    where: { organisationId_provider: { organisationId: tenantId, provider: PROVIDER } },
    // Narrow, and every omission is deliberate: `refreshClaimToken`,
    // `refreshClaimedAt` and `refreshFailureCount` are internal machinery, and
    // the credential rows are not reachable from here at all.
    select: {
      status: true,
      connectedAt: true,
      lastError: true,
      config: true,
      publishSpaceKey: true,
      publishSpaceName: true,
      grantedScopes: true,
      lastRefreshedAt: true,
      lastReconcileAt: true,
      lastReconcileOutcome: true,
      dormancyNoticedAt: true,
      declaredPlan: true,
      declaredResidency: true,
      declaredAt: true,
    },
  } as never);

  if (integration === null) return null;

  const [stateRows, remoteRows] = await Promise.all([
    client.documentPublication.groupBy({
      by: ['state'],
      where: { organisationId: tenantId, provider: 'confluence' },
      _count: { _all: true },
    }),
    client.documentPublication.groupBy({
      by: ['remoteState'],
      where: { organisationId: tenantId, provider: 'confluence' },
      _count: { _all: true },
    }),
  ]);

  const byState = countsFrom(stateRows, 'state');
  const byRemote = countsFrom(remoteRows, 'remoteState');

  const grantedScopes = Array.isArray(integration.grantedScopes)
    ? (integration.grantedScopes as string[])
    : [];

  // The clock the dormancy sweep runs, reproduced so the console shows the same
  // date the sweep would act on rather than a second opinion. `lastRefreshedAt`
  // first, falling back to `connectedAt`, because the 90 days run from the
  // grant and a tenant that never refreshed must not look eternally young.
  const ageFrom =
    (integration.lastRefreshedAt as Date | null) ?? (integration.connectedAt as Date | null);
  const authorisationExpiresAt =
    integration.status === 'CONNECTED' && ageFrom instanceof Date
      ? new Date(ageFrom.getTime() + ATLASSIAN_REFRESH_INACTIVITY_EXPIRY_MS)
      : null;

  return {
    provider: PROVIDER,
    status: String(integration.status),
    connectedAt: iso(integration.connectedAt),
    lastError: (integration.lastError as string | null) ?? null,
    siteUrl: readConfigString(integration.config, 'siteUrl'),
    siteName: readConfigString(integration.config, 'siteName'),
    spaceKey: (integration.publishSpaceKey as string | null) ?? null,
    spaceName: (integration.publishSpaceName as string | null) ?? null,
    grantedScopes,
    // The single most common cause of an integration that looks healthy and
    // cannot erase.
    missingScopes: missingConfluenceScopes(grantedScopes),
    lastRefreshedAt: iso(integration.lastRefreshedAt),
    lastReconcileAt: iso(integration.lastReconcileAt),
    lastReconcileOutcome:
      (integration.lastReconcileOutcome as IntegrationReconcileOutcome | null) ?? null,
    authorisationExpiresAt: authorisationExpiresAt?.toISOString() ?? null,
    authorisationLapseNoticedAt: iso(integration.dormancyNoticedAt),
    publications: {
      pending: byState.get('PENDING') ?? 0,
      processed: byState.get('PROCESSED') ?? 0,
      deadLettered: byState.get('DEAD_LETTER') ?? 0,
      retired: byState.get('RETIRED') ?? 0,
    },
    remoteStates: {
      visible: byRemote.get('VISIBLE') ?? 0,
      archived: byRemote.get('ARCHIVED') ?? 0,
      trashed: byRemote.get('TRASHED') ?? 0,
      gone: byRemote.get('GONE') ?? 0,
      unknown: byRemote.get('UNKNOWN') ?? 0,
      // Counted separately from UNKNOWN, and the distinction matters to whoever
      // is reading this: never checked means the reconcile job has not reached
      // it yet, UNKNOWN means the site refused to say.
      neverChecked: byRemote.get(null) ?? 0,
    },
    declaredPlan: (integration.declaredPlan as string | null) ?? null,
    declaredResidency: (integration.declaredResidency as string | null) ?? null,
    declaredAt: iso(integration.declaredAt),
    residencyControlledByCharityPilot: false,
  };
}
