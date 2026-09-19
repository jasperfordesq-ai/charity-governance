import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseConfluencePublishSpace,
  confluencePublishTargetForOrganisation,
  confluenceSiteIdFromConfig,
  readConfluencePublishTarget,
  type PublishTargetRow,
} from '../services/confluence-publish-target.service.js';
import type { ListSpacesResult } from '../services/confluence-spaces.js';
import { AppError } from '../utils/errors.js';

// ── the fake datastore ──────────────────────────────────────────────────────
//
// Hand-written, like `integrations-route.test.ts`'s: no Prisma, no database.
// It records every `where` it is handed, so a test can prove the write was
// scoped to the organisation rather than merely that it happened.

type Row = {
  id: string;
  organisationId: string;
  provider: 'CONFLUENCE';
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  config: Record<string, unknown> | null;
  publishSpaceId: string | null;
  publishSpaceKey: string | null;
  publishSpaceName: string | null;
  publishSpaceSiteId: string | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'integration-a',
    organisationId: 'org-a',
    provider: 'CONFLUENCE',
    status: 'CONNECTED',
    config: { siteId: 'site-1', siteUrl: 'https://charity-a.atlassian.net', siteName: 'Charity A', siteCount: 1 },
    publishSpaceId: null,
    publishSpaceKey: null,
    publishSpaceName: null,
    publishSpaceSiteId: null,
    ...overrides,
  };
}

function makeStore(rows: Row[]) {
  const stored = rows.map((r) => ({ ...r }));
  const calls = { findUnique: [] as unknown[], updateMany: [] as unknown[] };

  const client = {
    organisationIntegration: {
      findUnique: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        calls.findUnique.push(args.where);
        const composite = args.where.organisationId_provider as
          | { organisationId: string; provider: string }
          | undefined;
        const found = stored.find(
          (r) => r.organisationId === composite?.organisationId && r.provider === composite?.provider,
        );
        if (!found) return null;
        if (!args.select) return { ...found };
        const projected: Record<string, unknown> = {};
        for (const key of Object.keys(args.select)) {
          projected[key] = (found as unknown as Record<string, unknown>)[key];
        }
        return projected;
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.updateMany.push(args.where);
        const match = stored.find(
          (r) =>
            (args.where.id === undefined || r.id === args.where.id) &&
            (args.where.organisationId === undefined || r.organisationId === args.where.organisationId),
        );
        if (!match) return { count: 0 };
        Object.assign(match, args.data);
        return { count: 1 };
      },
    },
  };

  return { client: client as never, calls, stored };
}

const GOVERNANCE = { id: 'space-gov', key: 'GOV', name: 'Governance' };
const FINANCE = { id: 'space-fin', key: 'FIN', name: 'Finance' };

/** A lister standing in for `listSpaces` bound to a client, one page. */
function lists(...spaces: Array<{ id: string; key: string; name: string }>) {
  return async (): Promise<ListSpacesResult> => ({ spaces });
}

function listerThatMustNotRun() {
  return async (): Promise<ListSpacesResult> => {
    throw new Error('Confluence must not be asked for spaces on this path');
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Choosing a space
// ────────────────────────────────────────────────────────────────────────────

test('a space from the listed set is stored on its own columns, and config is left untouched', async () => {
  const store = makeStore([row()]);

  const target = await chooseConfluencePublishSpace(
    store.client,
    { integrationId: 'integration-a', organisationId: 'org-a', cloudId: 'site-1', spaceId: 'space-gov' },
    lists(FINANCE, GOVERNANCE),
  );

  assert.deepEqual(target, {
    cloudId: 'site-1',
    spaceId: 'space-gov',
    spaceKey: 'GOV',
    spaceName: 'Governance',
  });

  const saved = store.stored[0]!;
  assert.equal(saved.publishSpaceId, 'space-gov');
  assert.equal(saved.publishSpaceKey, 'GOV');
  assert.equal(saved.publishSpaceName, 'Governance');
  assert.equal(saved.publishSpaceSiteId, 'site-1');

  // The whole point of the dedicated columns: `config` is what a reconnect
  // overwrites wholesale, so nothing about the choice may be written there.
  assert.deepEqual(saved.config, {
    siteId: 'site-1',
    siteUrl: 'https://charity-a.atlassian.net',
    siteName: 'Charity A',
    siteCount: 1,
  });
});

test('the key and name are taken from the listing, never from the caller', async () => {
  const store = makeStore([row()]);

  // A caller cannot label a space whatever it likes: only the id is accepted,
  // and everything else comes from what Confluence actually listed.
  const target = await chooseConfluencePublishSpace(
    store.client,
    { integrationId: 'integration-a', organisationId: 'org-a', cloudId: 'site-1', spaceId: 'space-fin' },
    lists({ id: 'space-fin', key: 'FIN', name: 'Finance' }),
  );

  assert.equal(target.spaceKey, 'FIN');
  assert.equal(target.spaceName, 'Finance');
});

test('a space id that was never listed is refused, and nothing is written', async () => {
  const store = makeStore([row()]);

  await assert.rejects(
    () =>
      chooseConfluencePublishSpace(
        store.client,
        { integrationId: 'integration-a', organisationId: 'org-a', cloudId: 'site-1', spaceId: 'space-somebody-elses' },
        lists(GOVERNANCE, FINANCE),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'CONFLUENCE_SPACE_NOT_LISTED');
      return true;
    },
  );

  assert.equal(store.calls.updateMany.length, 0, 'a refused choice must not write anything');
  assert.equal(store.stored[0]!.publishSpaceId, null);
});

test('an id that differs only by whitespace is not the listed space', async () => {
  const store = makeStore([row()]);

  // The database refuses an untrimmed id too, but this is the earlier and
  // kinder refusal: an untrimmed id reaching a published page becomes a
  // PERMANENT erasure failure in Phase 5, long after the Irish copy is gone.
  await assert.rejects(
    () =>
      chooseConfluencePublishSpace(
        store.client,
        { integrationId: 'integration-a', organisationId: 'org-a', cloudId: 'site-1', spaceId: ' space-gov ' },
        lists(GOVERNANCE),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      assert.ok(
        error.code === 'CONFLUENCE_SPACE_NOT_LISTED' || error.code === 'CONFLUENCE_SPACE_ID_REQUIRED',
        `an untrimmed id must be refused, but got ${error.code}`,
      );
      return true;
    },
  );
  assert.equal(store.stored[0]!.publishSpaceId, null);
});

test('a blank space id is refused before Confluence is asked for anything', async () => {
  const store = makeStore([row()]);

  for (const spaceId of ['', '   ']) {
    await assert.rejects(
      () =>
        chooseConfluencePublishSpace(
          store.client,
          { integrationId: 'integration-a', organisationId: 'org-a', cloudId: 'site-1', spaceId },
          listerThatMustNotRun(),
        ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, 'CONFLUENCE_SPACE_ID_REQUIRED');
        return true;
      },
    );
  }
  assert.equal(store.calls.updateMany.length, 0);
});

test('a space on a later page of the listing is still a valid choice', async () => {
  const store = makeStore([row()]);
  const cursors: Array<string | undefined> = [];

  const target = await chooseConfluencePublishSpace(
    store.client,
    { integrationId: 'integration-a', organisationId: 'org-a', cloudId: 'site-1', spaceId: 'space-gov' },
    async (cursor?: string): Promise<ListSpacesResult> => {
      cursors.push(cursor);
      if (cursor === undefined) return { spaces: [FINANCE], nextCursor: 'PAGE-2' };
      return { spaces: [GOVERNANCE] };
    },
  );

  assert.equal(target.spaceId, 'space-gov');
  assert.deepEqual(cursors, [undefined, 'PAGE-2'], 'the walk must follow the cursor it was handed');
});

test('the write names the requesting organisation as well as the integration row', async () => {
  const store = makeStore([row()]);

  await chooseConfluencePublishSpace(
    store.client,
    { integrationId: 'integration-a', organisationId: 'org-a', cloudId: 'site-1', spaceId: 'space-gov' },
    lists(GOVERNANCE),
  );

  assert.deepEqual(store.calls.updateMany, [{ id: 'integration-a', organisationId: 'org-a' }]);
});

test('choosing a space records the site it belongs to, not merely the space', async () => {
  const store = makeStore([row({ config: { siteId: 'site-2' } })]);

  await chooseConfluencePublishSpace(
    store.client,
    { integrationId: 'integration-a', organisationId: 'org-a', cloudId: 'site-2', spaceId: 'space-gov' },
    lists(GOVERNANCE),
  );

  assert.equal(store.stored[0]!.publishSpaceSiteId, 'site-2');
});

// ────────────────────────────────────────────────────────────────────────────
// Reading the target back — the per-site rule
// ────────────────────────────────────────────────────────────────────────────

function chosen(overrides: Partial<Row> = {}): PublishTargetRow {
  return row({
    publishSpaceId: 'space-gov',
    publishSpaceKey: 'GOV',
    publishSpaceName: 'Governance',
    publishSpaceSiteId: 'site-1',
    ...overrides,
  });
}

test('a chosen space is still the destination after a reconnect to the same site', () => {
  // A reconnect rewrites `config` wholesale; the same site comes back with the
  // same id, and the publish columns were never part of that write.
  const target = readConfluencePublishTarget(
    chosen({ config: { siteId: 'site-1', siteUrl: 'https://charity-a.atlassian.net', siteName: 'Charity A' } }),
  );

  assert.deepEqual(target, {
    cloudId: 'site-1',
    spaceId: 'space-gov',
    spaceKey: 'GOV',
    spaceName: 'Governance',
  });
});

test('a reconnect to a DIFFERENT site reports no space chosen', () => {
  // Space ids are per-site. Keeping the old one would aim every future
  // publication at a space that does not exist on the new site.
  const target = readConfluencePublishTarget(
    chosen({ config: { siteId: 'site-2', siteUrl: 'https://charity-b.atlassian.net' } }),
  );

  assert.equal(target, null);
});

test('every half-written or unusable target reads as no space chosen', () => {
  const cases: Array<{ why: string; roww: PublishTargetRow }> = [
    { why: 'nothing chosen at all', roww: row() },
    { why: 'no space id', roww: chosen({ publishSpaceId: null }) },
    { why: 'a blank space id', roww: chosen({ publishSpaceId: '   ' }) },
    { why: 'no space key', roww: chosen({ publishSpaceKey: null }) },
    { why: 'a blank space key', roww: chosen({ publishSpaceKey: '' }) },
    { why: 'no recorded site', roww: chosen({ publishSpaceSiteId: null }) },
    { why: 'a blank recorded site', roww: chosen({ publishSpaceSiteId: ' ' }) },
    { why: 'no site id in config', roww: chosen({ config: {} }) },
    { why: 'no config at all', roww: chosen({ config: null }) },
    { why: 'a site that is not the connected one', roww: chosen({ config: { siteId: 'site-9' } }) },
  ];

  for (const { why, roww } of cases) {
    assert.equal(readConfluencePublishTarget(roww), null, `${why}: must read as no space chosen`);
  }
});

test('a space with no display name is still a usable destination', () => {
  // `listSpaces` yields '' for a space Confluence returned without a name.
  // Display text is not a reason to refuse to publish.
  const target = readConfluencePublishTarget(chosen({ publishSpaceName: '' }));
  assert.equal(target?.spaceId, 'space-gov');
  assert.equal(target?.spaceName, '');
});

test('confluenceSiteIdFromConfig reads only a non-empty string siteId', () => {
  assert.equal(confluenceSiteIdFromConfig({ siteId: 'site-1' }), 'site-1');
  for (const config of [null, undefined, {}, [], 'site-1', { siteId: '' }, { siteId: 7 }]) {
    assert.equal(confluenceSiteIdFromConfig(config), null, `${JSON.stringify(config) ?? 'undefined'} is not a site id`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// The gate publication itself hangs on
// ────────────────────────────────────────────────────────────────────────────

test('a connected organisation that has chosen a space has a publish destination', async () => {
  const store = makeStore([chosen() as Row]);

  const target = await confluencePublishTargetForOrganisation(store.client, 'org-a');

  assert.deepEqual(target, { cloudId: 'site-1', spaceId: 'space-gov', spaceKey: 'GOV', spaceName: 'Governance' });
});

test('a connected organisation with no chosen space has NO publish destination, so nothing may enqueue', async () => {
  const store = makeStore([row()]);

  assert.equal(
    await confluencePublishTargetForOrganisation(store.client, 'org-a'),
    null,
    'connected-but-not-chosen is connected-but-not-publishing',
  );
});

test('a reconnect to a different site leaves the organisation with no publish destination', async () => {
  const store = makeStore([chosen({ config: { siteId: 'site-2' } }) as Row]);

  assert.equal(await confluencePublishTargetForOrganisation(store.client, 'org-a'), null);
});

test('no publish destination without a live connection, whatever the columns say', async () => {
  for (const status of ['DISCONNECTED', 'ERROR'] as const) {
    const store = makeStore([chosen({ status }) as Row]);
    assert.equal(
      await confluencePublishTargetForOrganisation(store.client, 'org-a'),
      null,
      `status ${status} must not publish`,
    );
  }
});

test('an organisation with no integration row at all has no publish destination', async () => {
  const store = makeStore([]);
  assert.equal(await confluencePublishTargetForOrganisation(store.client, 'org-b'), null);
});

test('the destination lookup is scoped to the organisation asking for it', async () => {
  const store = makeStore([chosen() as Row]);

  assert.equal(await confluencePublishTargetForOrganisation(store.client, 'org-b'), null);
  assert.deepEqual(store.calls.findUnique, [
    { organisationId_provider: { organisationId: 'org-b', provider: 'CONFLUENCE' } },
  ]);
});
