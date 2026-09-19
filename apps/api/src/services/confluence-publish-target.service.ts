/**
 * Where a charity's governance documents are published: the Confluence space
 * an administrator chose, and the site that space belongs to.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THIS IS A SEPARATE MODULE BECAUSE THE CONNECTION SERVICE IS CLOSED — AND
 * BECAUSE THE CHOICE MUST OUTLIVE A RECONNECT.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * `confluence-connection.service.ts` owns every other write to
 * `OrganisationIntegration`, and `connectConfluence` builds a
 * `connectingState` that **includes `config`** and spreads it into the
 * upsert's `update`. A reconnect therefore overwrites `config` wholesale.
 *
 * Follow that through, because it is not hypothetical: an administrator
 * connects, chooses a space, documents publish. Something goes wrong and they
 * **reconnect — the recovery action CharityPilot's own error messages
 * recommend.** A choice stored in `config` would be silently wiped at that
 * moment. Publication would stop, the integration would still read
 * `CONNECTED`, and nothing on screen would explain why. The schema comment on
 * `config` even says "site id, space key", so the trap invites you in.
 *
 * The four `publishSpace*` columns this module owns are **not** part of
 * `connectingState`, so they survive a reconnect *by construction* rather than
 * by anybody remembering. That is the whole reason they exist, and it is why
 * this module writes them with a narrow `updateMany` rather than reaching for
 * the connection service's upsert.
 *
 * ## Space ids are per-site, so the site is recorded alongside the space
 *
 * A space id means nothing without the site it came from. A charity that
 * reconnects to a **different** Atlassian site and kept its old space id would
 * aim every future publication at a space that does not exist there — a
 * failure that would surface as a broken pipeline, not as a question anybody
 * could answer. So `publishSpaceSiteId` is stored beside the choice and a
 * mismatch against the connection's current site reads as **no space chosen**:
 * the screen simply asks again. This is the same reasoning that puts `cloudId`
 * on the erasure row rather than resolving it live.
 *
 * ## Connected is not publishing
 *
 * {@link confluencePublishTargetForOrganisation} returning `null` is the gate
 * publication hangs on. An organisation that has connected but not chosen has
 * no destination, and **must not enqueue a publication** — a charity that
 * believes it is mirroring and is not is worse off than one that knows it has
 * a step left. The screen says so in as many words; see
 * `apps/web/src/lib/integration-status.ts`.
 */
import { AppError } from '../utils/errors.js';
import type { ListSpacesResult } from './confluence-spaces.js';

/** The destination, fully resolved. Everything a publish needs and nothing else. */
export type ConfluencePublishTarget = {
  /** The Atlassian cloud id of the site — recorded, never re-resolved. */
  cloudId: string;
  spaceId: string;
  spaceKey: string;
  /** Display text only; may be empty for a space Confluence returned unnamed. */
  spaceName: string;
};

/**
 * The columns this module reads. Deliberately a structural type: a caller that
 * already holds the row (the status route does) passes it straight in rather
 * than provoking a second query.
 */
export type PublishTargetRow = {
  config: unknown;
  publishSpaceId: string | null;
  publishSpaceKey: string | null;
  publishSpaceName: string | null;
  publishSpaceSiteId: string | null;
};

/** The narrow slice of Prisma this module uses. */
export type PublishTargetClient = {
  organisationIntegration: {
    findUnique(args: {
      where: { organisationId_provider: { organisationId: string; provider: 'CONFLUENCE' } };
      select: Record<string, boolean>;
    }): Promise<Record<string, unknown> | null>;
    updateMany(args: {
      where: { id: string; organisationId: string };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
};

/** Asks Confluence for one page of spaces, continuing from `cursor` if given. */
export type SpaceLister = (cursor?: string) => Promise<ListSpacesResult>;

const PROVIDER = 'CONFLUENCE' as const;

/**
 * How many times the validation walk will follow a continuation cursor.
 *
 * `listSpaces` already bounds its own internal walk and hands back a
 * `nextCursor` when it stops, so this bounds the *resumptions*: 10 × 40 pages
 * of 250 is a hundred thousand spaces, far past anything real. Exhausting it
 * refuses the choice rather than accepting an unverified id — the safe
 * direction, because the id is baked into every page this pipeline creates.
 */
const MAX_VALIDATION_CONTINUATIONS = 10;

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The Atlassian cloud id of the connected site, read out of the `config` JSON
 * `connectConfluence` writes it to as `siteId`.
 *
 * One reading, exported, because two readings of the same fact are two
 * readings that can disagree — and here a disagreement would mean a stored
 * space silently matching or failing to match the site it belongs to.
 */
export function confluenceSiteIdFromConfig(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const value = (config as Record<string, unknown>).siteId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The chosen destination, or `null` when there is none to use.
 *
 * Every condition below is a separate reason to publish nowhere, and each is
 * checked on its own so that a half-written row can never be resolved into a
 * half-valid destination:
 *
 * - the connection records no site at all;
 * - no space id, key or recorded site was ever stored;
 * - **the recorded site is not the site now connected** — the reconnect case.
 *
 * The stale columns are deliberately **not** cleared here. This is a read: a
 * charity that reconnects back to the original site finds its choice intact,
 * and one that stays on the new site simply chooses again, overwriting them.
 * Clearing on read would turn a glance at the screen into a destructive act.
 */
export function readConfluencePublishTarget(row: PublishTargetRow): ConfluencePublishTarget | null {
  const cloudId = confluenceSiteIdFromConfig(row.config);
  if (cloudId === null) return null;

  const spaceId = nonEmpty(row.publishSpaceId);
  if (spaceId === null) return null;

  const spaceKey = nonEmpty(row.publishSpaceKey);
  if (spaceKey === null) return null;

  const recordedSiteId = nonEmpty(row.publishSpaceSiteId);
  if (recordedSiteId === null) return null;

  // Space ids are per-site: a space id from another site names nothing here.
  if (recordedSiteId !== cloudId) return null;

  return {
    cloudId,
    spaceId,
    spaceKey,
    // Display text only, and its absence is not a reason to refuse to publish.
    spaceName: typeof row.publishSpaceName === 'string' ? row.publishSpaceName : '',
  };
}

/**
 * The destination an organisation publishes to, or `null`.
 *
 * **This is the gate.** A publication may only be enqueued for an organisation
 * this returns a target for: a `CONNECTED` integration is necessary and not
 * sufficient, because connecting is the opt-in and choosing a space is the
 * destination, and neither substitutes for the other.
 *
 * Scoped on `organisationId_provider` with the organisation taken from the
 * caller — the same structural scoping every route in
 * `routes/integrations/index.ts` uses, and for the same reason: an id that was
 * never accepted cannot be forged.
 */
export async function confluencePublishTargetForOrganisation(
  prisma: PublishTargetClient,
  organisationId: string,
): Promise<ConfluencePublishTarget | null> {
  const row = await prisma.organisationIntegration.findUnique({
    where: { organisationId_provider: { organisationId, provider: PROVIDER } },
    select: {
      status: true,
      config: true,
      publishSpaceId: true,
      publishSpaceKey: true,
      publishSpaceName: true,
      publishSpaceSiteId: true,
    },
  });

  if (row === null) return null;
  // A stored choice on a connection that is not live is not a destination.
  if (row.status !== 'CONNECTED') return null;

  return readConfluencePublishTarget(row as unknown as PublishTargetRow);
}

/**
 * Records the space this charity publishes into.
 *
 * **The id is validated against the spaces Confluence actually listed**, and
 * that is not ceremony. An arbitrary id accepted from a browser aims
 * publication at a space the charity never intended, and that id is then baked
 * into every page this pipeline creates and into the erasure target recorded
 * beside it. Only the id is accepted from the caller; the key and the name are
 * taken from the listing, so nothing a caller supplies can mislabel a space on
 * the screen that shows it.
 *
 * `integrationId` and `cloudId` are derived by the caller from the
 * authenticated organisation's own row — never accepted from a request. The
 * write names both the row and the organisation, so a wrong id cannot reach
 * another charity's row even if one were ever passed in.
 */
export async function chooseConfluencePublishSpace(
  prisma: PublishTargetClient,
  params: { integrationId: string; organisationId: string; cloudId: string; spaceId: string },
  listSpaces: SpaceLister,
): Promise<ConfluencePublishTarget> {
  const requested = typeof params.spaceId === 'string' ? params.spaceId.trim() : '';
  if (requested.length === 0) {
    throw new AppError(
      400,
      'CONFLUENCE_SPACE_ID_REQUIRED',
      'Choose a Confluence space to publish into. No space id was supplied.',
    );
  }

  const listed = await findListedSpace(listSpaces, params.spaceId);
  if (listed === null) {
    throw new AppError(
      400,
      'CONFLUENCE_SPACE_NOT_LISTED',
      'That space is not one of the spaces this organisation’s Confluence connection can see, so it ' +
        'cannot be chosen as a publish destination. Reload the list of spaces and choose one from it.',
    );
  }

  await prisma.organisationIntegration.updateMany({
    where: { id: params.integrationId, organisationId: params.organisationId },
    data: {
      publishSpaceId: listed.id,
      publishSpaceKey: listed.key,
      publishSpaceName: listed.name,
      // The site the space belongs to, stored with it. See the module header.
      publishSpaceSiteId: params.cloudId,
    },
  });

  return { cloudId: params.cloudId, spaceId: listed.id, spaceKey: listed.key, spaceName: listed.name };
}

/**
 * The listed space with exactly this id, or `null`.
 *
 * Compared byte for byte against what Confluence listed, so an id differing
 * only by whitespace is not a match. That is deliberate: Phase 5's
 * `parseConfluenceErasureTarget` refuses an untrimmed id **permanently**, so an
 * untrimmed id stored here would publish happily and only fail when a charity
 * asked for erasure — after the Irish copy was gone.
 */
async function findListedSpace(
  listSpaces: SpaceLister,
  spaceId: string,
): Promise<{ id: string; key: string; name: string } | null> {
  let cursor: string | undefined;

  for (let attempt = 0; attempt <= MAX_VALIDATION_CONTINUATIONS; attempt += 1) {
    const { spaces, nextCursor } = await listSpaces(cursor);

    const match = spaces.find((space) => space.id === spaceId);
    if (match !== undefined) return match;

    if (nextCursor === undefined || nextCursor === null) return null;
    cursor = nextCursor;
  }

  // The bound was reached without finding it. Refused rather than accepted:
  // an unverified id is the thing this function exists to prevent.
  return null;
}
