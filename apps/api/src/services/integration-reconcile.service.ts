/**
 * Tenant-level reconcile bookkeeping, and the dormancy sweep.
 *
 * A SEPARATE MODULE FOR THE SAME REASON `confluence-publish-target.service.ts`
 * IS ONE: `confluence-connection.service.ts` owns every other write to
 * `OrganisationIntegration`, and its `connectConfluence` spreads a whole
 * `connectingState` — `config` included — into an upsert. Anything written
 * through that path is at the mercy of a reconnect, which is the recovery
 * action CharityPilot's own error messages recommend. The columns here are
 * written with narrow `updateMany` calls instead, so a reconnect cannot erase
 * them by construction rather than by anybody remembering.
 *
 * ## The dormancy sweep is a ruling, not an optimisation
 *
 * Atlassian's rotating refresh tokens expire after 90 days without use. The
 * obvious remedy is a job that refreshes every connected tenant on a timer so
 * nothing ever lapses. The DPO ruled against that on 2026-09-20, in writing:
 * refreshing a token as a by-product of an integration that has a real
 * reconciliation purpose is legitimate, but refreshing one *solely* to stop an
 * otherwise dormant authorisation expiring is not — genuinely unused access
 * should not be preserved indefinitely for convenience, and requiring the
 * organisation to reconnect is the better outcome.
 *
 * So this module never refreshes anything. It watches the clock the charity's
 * own usage resets, warns while there is still time to act, and records the
 * lapse when it arrives. **`lastRefreshedAt` is never written here**, and a
 * test asserts it: a sweep that moved it would be a keepalive wearing a
 * different name.
 */
import type { IntegrationReconcileOutcome } from './confluence-reconcile.service.js';

const PROVIDER = 'CONFLUENCE' as const;

/**
 * Atlassian's documented inactivity expiry. **Their behaviour, quoted from
 * their documentation, not a CharityPilot guarantee** — nothing in this
 * repository would notice if they changed it, which is why the warning window
 * below is generous rather than tight.
 */
export const ATLASSIAN_REFRESH_INACTIVITY_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * When the charity is told. Thirty days of notice, because reconnecting needs
 * an Atlassian administrator and a charity's administrator may be a volunteer
 * who is not in the building every week.
 */
export const INTEGRATION_DORMANCY_WARN_AFTER_MS = 60 * 24 * 60 * 60 * 1000;

export type DormancyNotice = {
  integrationId: string;
  organisationId: string;
  outcome: Extract<IntegrationReconcileOutcome, 'EXPIRING_SOON' | 'EXPIRED'>;
  /** When the authorisation lapses, or lapsed. */
  expiresAt: Date;
};

export type ReconcileTenantRow = {
  integrationId: string;
  organisationId: string;
  siteId: string | null;
};

type IntegrationReconcileClient = {
  organisationIntegration: {
    findMany(args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
      orderBy?: unknown;
      take?: number;
    }): Promise<Array<Record<string, unknown>>>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
};

function readSiteId(config: unknown): string | null {
  if (config === null || typeof config !== 'object') return null;
  const siteId = (config as { siteId?: unknown }).siteId;
  return typeof siteId === 'string' && siteId.length > 0 ? siteId : null;
}

/**
 * The tenants to visit this run, oldest visit first.
 *
 * `lastReconcileAt` ascending with NULLS FIRST puts a newly connected charity
 * ahead of one seen an hour ago, so a tenant cannot be starved by the ordering.
 * Prisma emits `NULLS FIRST` for `{ sort: 'asc', nulls: 'first' }`; spelling it
 * out matters because PostgreSQL's default for ASC is NULLS LAST, which would
 * put every never-reconciled tenant at the back of a queue that is truncated by
 * `take`.
 */
export async function listTenantsForReconcile(
  prisma: IntegrationReconcileClient,
  limit: number,
): Promise<ReconcileTenantRow[]> {
  const rows = await prisma.organisationIntegration.findMany({
    where: { provider: PROVIDER, status: 'CONNECTED' },
    select: { id: true, organisationId: true, config: true },
    orderBy: [{ lastReconcileAt: { sort: 'asc', nulls: 'first' } }],
    take: Math.max(1, limit),
  });

  return rows.map((row) => ({
    integrationId: String(row.id),
    organisationId: String(row.organisationId),
    siteId: readSiteId(row.config),
  }));
}

/**
 * Stamps how a tenant's visit ended.
 *
 * Deliberately narrow: two columns, keyed on the integration id, and nothing
 * else. It is called after a visit that may have failed, so it must not be
 * capable of disturbing the connection state it is reporting on.
 */
export async function recordTenantReconcileOutcome(
  prisma: IntegrationReconcileClient,
  input: { integrationId: string; outcome: IntegrationReconcileOutcome; at: Date },
): Promise<void> {
  await prisma.organisationIntegration.updateMany({
    where: { id: input.integrationId },
    data: { lastReconcileAt: input.at, lastReconcileOutcome: input.outcome },
  });
}

type DormancyRow = {
  id: unknown;
  organisationId: unknown;
  connectedAt: unknown;
  lastRefreshedAt: unknown;
  lastReconcileOutcome: unknown;
  dormancyNoticedAt: unknown;
};

function asDate(value: unknown): Date | null {
  return value instanceof Date ? value : null;
}

/**
 * Warns, then records the lapse. Refreshes nothing.
 *
 * Returns one notice per **transition**, never one per run. The guard is the
 * comparison against the outcome already on the row: a tenant that has been
 * EXPIRING_SOON since last Tuesday produces no further notices until it crosses
 * into EXPIRED. Without that, a six-hourly sweep would write the same audit
 * event about 120 times across the warning window, which is how an audit log
 * stops being read.
 *
 * The clock is `lastRefreshedAt`, falling back to `connectedAt` for a charity
 * that has connected and never used the integration since — the 90 days run
 * from the grant, not from the first refresh, so a tenant that never refreshed
 * must not look eternally young.
 */
export async function sweepDormantIntegrations(
  prisma: IntegrationReconcileClient,
  options: {
    now: Date;
    warnAfterMs?: number;
    expireAfterMs?: number;
  },
): Promise<DormancyNotice[]> {
  const warnAfterMs = options.warnAfterMs ?? INTEGRATION_DORMANCY_WARN_AFTER_MS;
  const expireAfterMs = options.expireAfterMs ?? ATLASSIAN_REFRESH_INACTIVITY_EXPIRY_MS;
  const now = options.now.getTime();

  const rows = (await prisma.organisationIntegration.findMany({
    where: { provider: PROVIDER, status: 'CONNECTED' },
    select: {
      id: true,
      organisationId: true,
      connectedAt: true,
      lastRefreshedAt: true,
      lastReconcileOutcome: true,
      dormancyNoticedAt: true,
    },
  })) as unknown as DormancyRow[];

  const notices: DormancyNotice[] = [];

  for (const row of rows) {
    const integrationId = String(row.id);
    const organisationId = String(row.organisationId);
    // `lastRefreshedAt` first: it is the only column that moves when the
    // charity actually uses the integration, which is exactly the clock
    // Atlassian resets.
    const since = asDate(row.lastRefreshedAt) ?? asDate(row.connectedAt);
    const previous = row.lastReconcileOutcome === null ? null : String(row.lastReconcileOutcome);

    // A CONNECTED row with neither timestamp cannot be aged. Saying nothing is
    // right: the alternative is warning a charity about an expiry computed from
    // a date we do not have.
    if (since === null) continue;

    const age = now - since.getTime();
    const expiresAt = new Date(since.getTime() + expireAfterMs);

    if (age < warnAfterMs) {
      // Used again. Clear a stale notice so the next lapse is reported as the
      // new fact it is, rather than being suppressed by the last one.
      if (row.dormancyNoticedAt !== null || previous === 'EXPIRING_SOON' || previous === 'EXPIRED') {
        await prisma.organisationIntegration.updateMany({
          where: { id: integrationId },
          data: { dormancyNoticedAt: null, lastReconcileOutcome: null },
        });
      }
      continue;
    }

    const outcome: DormancyNotice['outcome'] = age >= expireAfterMs ? 'EXPIRED' : 'EXPIRING_SOON';
    if (previous === outcome) continue;

    const data: Record<string, unknown> = {
      lastReconcileOutcome: outcome,
      dormancyNoticedAt: options.now,
    };
    if (outcome === 'EXPIRED') {
      // The next publish must fail as "reconnect required" BY DESIGN rather
      // than by accident, which means the row has to say so before the attempt
      // rather than after it. Note what is not here: the publication rows and
      // their page references are untouched. A lapsed authorisation is not a
      // deletion, and the pages already published stay exactly where they are.
      data.status = 'ERROR';
      data.lastError = 'CONFLUENCE_AUTHORISATION_EXPIRED';
    }

    // Compare-and-set on the outcome we read, so two schedulers running the
    // sweep at once raise one notice between them rather than one each.
    const { count } = await prisma.organisationIntegration.updateMany({
      where: { id: integrationId, lastReconcileOutcome: previous },
      data,
    });
    if (count === 0) continue;

    notices.push({ integrationId, organisationId, outcome, expiresAt });
  }

  return notices;
}
