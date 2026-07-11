import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  executeBillingAuthorityReconciliation,
  parseBillingAuthorityReconciliationArgs,
  type BillingAuthorityReconciliationCommand,
} from '../jobs/reconcile-billing-authority.js';

const NOW = new Date('2026-07-11T12:00:00.000Z');
const GRANT_ID = '00000000-0000-4000-8000-000000000707';
const PROVIDER_EVIDENCE = 'Redacted Stripe review finding EVID-2026-0711-07';

type ReleaseCommand = Extract<BillingAuthorityReconciliationCommand, { mode: 'release' }>;
type DryRunCommand = Extract<BillingAuthorityReconciliationCommand, { mode: 'dry-run' }>;

type GrantFixture = {
  id: string;
  organisationId: string;
  kind: 'CHECKOUT' | 'PORTAL';
  actorUserId: string;
  actorSessionId: string;
  actorMembershipVersion: number;
  state: 'CLAIMED' | 'PROVIDER_STARTED' | 'CAPABILITY_ISSUED' | 'RELEASED';
  providerResourceId: string | null;
  safeReleaseAfter: Date | null;
  claimedAt: Date;
  providerStartedAt: Date | null;
  capabilityIssuedAt: Date | null;
  releasedAt: Date | null;
  releaseReason: ReleaseCommand['reason'] | null;
  releaseActor: string | null;
  releaseEvidence: Record<string, unknown> | null;
};

const baseArgs = [
  '--organisation-id', 'org-1',
  '--grant-id', GRANT_ID,
  '--expected-state', 'CAPABILITY_ISSUED',
  '--reason', 'PROVIDER_CAPABILITY_REVOKED',
  '--operator', 'support.operator@example.org',
  '--case-reference', 'INC-2026-0707',
  '--provider-evidence', PROVIDER_EVIDENCE,
  '--confirm-authority-verified',
];

function replaceOption(args: string[], option: string, value: string): string[] {
  const result = [...args];
  const index = result.indexOf(option);
  assert.notEqual(index, -1);
  result[index + 1] = value;
  return result;
}

function grant(overrides: Partial<GrantFixture> = {}): GrantFixture {
  return {
    id: GRANT_ID,
    organisationId: 'org-1',
    kind: 'CHECKOUT',
    actorUserId: 'owner-1',
    actorSessionId: 'session-owner-1',
    actorMembershipVersion: 7,
    state: 'CAPABILITY_ISSUED',
    providerResourceId: 'cs_test_redacted_identifier',
    safeReleaseAfter: new Date('2026-07-11T11:00:00.000Z'),
    claimedAt: new Date('2026-07-11T10:00:00.000Z'),
    providerStartedAt: new Date('2026-07-11T10:00:01.000Z'),
    capabilityIssuedAt: new Date('2026-07-11T10:00:02.000Z'),
    releasedAt: null,
    releaseReason: null,
    releaseActor: null,
    releaseEvidence: null,
    ...overrides,
  };
}

function dryRunCommand(overrides: Partial<DryRunCommand> = {}): DryRunCommand {
  return {
    mode: 'dry-run',
    organisationId: 'org-1',
    grantId: GRANT_ID,
    expectedState: 'CAPABILITY_ISSUED',
    reason: 'PROVIDER_CAPABILITY_REVOKED',
    operator: 'support.operator@example.org',
    caseReference: 'INC-2026-0707',
    providerEvidence: PROVIDER_EVIDENCE,
    authorityVerified: true,
    billingProviderIoQuiesced: false,
    ...overrides,
  };
}

function expectedConfirmation(
  command: Pick<ReleaseCommand, 'grantId' | 'organisationId' | 'expectedState' | 'reason'>,
): string {
  const target = `RELEASE BILLING AUTHORITY ${command.grantId} FOR ${command.organisationId} FROM ${command.expectedState} AS ${command.reason}`;
  return command.expectedState === 'CLAIMED' || command.expectedState === 'PROVIDER_STARTED'
    ? `${target} WITH BILLING PROVIDER IO QUIESCED`
    : target;
}

function releaseCommand(overrides: Partial<ReleaseCommand> = {}): ReleaseCommand {
  const result: ReleaseCommand = {
    mode: 'release',
    organisationId: 'org-1',
    grantId: GRANT_ID,
    expectedState: 'CAPABILITY_ISSUED',
    reason: 'PROVIDER_CAPABILITY_REVOKED',
    operator: 'support.operator@example.org',
    caseReference: 'INC-2026-0707',
    providerEvidence: PROVIDER_EVIDENCE,
    authorityVerified: true,
    billingProviderIoQuiesced: false,
    executionConfirmation: '',
    ...overrides,
  };
  if (overrides.executionConfirmation === undefined) {
    result.executionConfirmation = expectedConfirmation(result);
  }
  return result;
}

function transactionFixture(
  lockedGrant: GrantFixture,
  updateCount = 1,
) {
  const events: string[] = [];
  let rawCall = 0;
  let updateArgs: Record<string, unknown> | undefined;
  let transactionOptions: Record<string, unknown> | undefined;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) {
        events.push('lock-organisation');
        return [{ id: 'org-1', lifecycleStatus: 'ACTIVE', lifecycleVersion: 4 }];
      }
      events.push('lock-grant');
      return [lockedGrant];
    },
    billingAuthorityGrant: {
      updateMany: async (args: Record<string, unknown>) => {
        events.push('release-grant');
        updateArgs = args;
        return { count: updateCount };
      },
    },
  };
  const client = {
    $transaction: async (
      operation: (transaction: typeof tx) => Promise<unknown>,
      options: Record<string, unknown>,
    ) => {
      transactionOptions = options;
      return operation(tx);
    },
  };
  return {
    client,
    events,
    get updateArgs() { return updateArgs; },
    get transactionOptions() { return transactionOptions; },
  };
}

test('parser exposes only list, dry-run, and release modes with bounded operator evidence', () => {
  assert.deepEqual(parseBillingAuthorityReconciliationArgs(['--list']), { mode: 'list' });
  assert.throws(
    () => parseBillingAuthorityReconciliationArgs(['--list', '--operator', 'somebody']),
    /does not accept release options/,
  );
  assert.throws(
    () => parseBillingAuthorityReconciliationArgs(['--dry-run', ...baseArgs, '--unknown']),
    /Unknown option/,
  );
  assert.throws(
    () => parseBillingAuthorityReconciliationArgs([
      '--dry-run',
      ...baseArgs.filter((argument) => argument !== '--confirm-authority-verified'),
    ]),
    /confirm-authority-verified/,
  );
  assert.throws(
    () => parseBillingAuthorityReconciliationArgs([
      '--dry-run',
      ...replaceOption(baseArgs, '--provider-evidence', 'https://dashboard.stripe.example/session'),
    ]),
    /not a URL or secret/,
  );
  assert.throws(
    () => parseBillingAuthorityReconciliationArgs([
      '--dry-run',
      ...replaceOption(baseArgs, '--provider-evidence', 'whsec_do-not-record-this'),
    ]),
    /not a URL or secret/,
  );
  assert.throws(
    () => parseBillingAuthorityReconciliationArgs([
      '--dry-run', ...baseArgs, '--confirm-release', '   ',
    ]),
    /must not be supplied with --dry-run/,
  );

  const parsed = parseBillingAuthorityReconciliationArgs(['--dry-run', ...baseArgs]);
  assert.equal(parsed.mode, 'dry-run');
  assert.equal(parsed.authorityVerified, true);
  assert.equal(parsed.providerEvidence, PROVIDER_EVIDENCE);
  assert.equal(parsed.billingProviderIoQuiesced, false);
});

test('pre-capability dry-run and release require an explicit quiescence attestation bound into the phrase', () => {
  const claimedArgs = replaceOption(
    replaceOption(baseArgs, '--expected-state', 'CLAIMED'),
    '--reason',
    'PROVIDER_CONFIRMED_NOT_ISSUED',
  );
  assert.throws(
    () => parseBillingAuthorityReconciliationArgs(['--dry-run', ...claimedArgs]),
    /confirm-billing-provider-io-quiesced is required/,
  );

  const quiescedArgs = [...claimedArgs, '--confirm-billing-provider-io-quiesced'];
  const dryRun = parseBillingAuthorityReconciliationArgs(['--dry-run', ...quiescedArgs]);
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.billingProviderIoQuiesced, true);

  const targetPhrase = `RELEASE BILLING AUTHORITY ${GRANT_ID} FOR org-1 FROM CLAIMED AS PROVIDER_CONFIRMED_NOT_ISSUED WITH BILLING PROVIDER IO QUIESCED`;
  assert.throws(
    () => parseBillingAuthorityReconciliationArgs([
      '--release', ...quiescedArgs,
      '--confirm-release', `RELEASE BILLING AUTHORITY ${GRANT_ID} FOR org-1 FROM CLAIMED AS PROVIDER_CONFIRMED_NOT_ISSUED`,
    ]),
    /must exactly equal/,
  );
  const release = parseBillingAuthorityReconciliationArgs([
    '--release', ...quiescedArgs,
    '--confirm-release', targetPhrase,
  ]);
  assert.equal(release.mode, 'release');
  assert.equal(release.executionConfirmation, targetPhrase);
});

test('execution API repeats required evidence and exact-confirmation checks before opening a transaction', async () => {
  let transactionCalls = 0;
  let listCalls = 0;
  const client = {
    $transaction: async () => { transactionCalls += 1; },
    billingAuthorityGrant: {
      findMany: async () => { listCalls += 1; return []; },
    },
  };
  await assert.rejects(
    () => executeBillingAuthorityReconciliation(
      client as never,
      releaseCommand({ executionConfirmation: 'RELEASE A DIFFERENT GRANT' }),
      NOW,
    ),
    /target-bound confirmation is invalid/,
  );
  await assert.rejects(
    () => executeBillingAuthorityReconciliation(
      client as never,
      releaseCommand({ providerEvidence: '   ' }),
      NOW,
    ),
    /--provider-evidence is required/,
  );
  await assert.rejects(
    () => executeBillingAuthorityReconciliation(
      client as never,
      releaseCommand({ providerEvidence: 'sk_live_do-not-record-this' }),
      NOW,
    ),
    /provider evidence contains a URL or secret/,
  );
  await assert.rejects(
    () => executeBillingAuthorityReconciliation(
      client as never,
      { ...releaseCommand(), mode: 'bogus' } as unknown as BillingAuthorityReconciliationCommand,
      NOW,
    ),
    /mode is invalid/,
  );
  await assert.rejects(
    () => executeBillingAuthorityReconciliation(
      client as never,
      { mode: 'list', organisationId: 'org-1' } as unknown as BillingAuthorityReconciliationCommand,
      NOW,
    ),
    /list mode accepts no release fields/,
  );
  assert.equal(transactionCalls, 0);
  assert.equal(listCalls, 0);
});

test('dry-run locks organisation then exact grant under Serializable isolation and performs no write', async () => {
  const fixture = transactionFixture(grant());
  const result = await executeBillingAuthorityReconciliation(
    fixture.client as never,
    dryRunCommand(),
    NOW,
  );

  assert.deepEqual(fixture.events, ['lock-organisation', 'lock-grant']);
  assert.equal(fixture.transactionOptions?.isolationLevel, 'Serializable');
  assert.equal(fixture.transactionOptions?.maxWait, 10_000);
  assert.equal(fixture.transactionOptions?.timeout, 10_000);
  if (Array.isArray(result)) assert.fail('dry-run returned list-mode output');
  assert.equal(result.mode, 'DRY_RUN');
  assert.equal(result.mutationApplied, false);
  assert.equal(result.requiredReleaseConfirmation, releaseCommand().executionConfirmation);
});

test('release from CLAIMED fails closed without runtime quiescence and records it immutably when attested', async () => {
  const claimedGrant = grant({
    state: 'CLAIMED',
    providerResourceId: null,
    safeReleaseAfter: null,
    providerStartedAt: null,
    capabilityIssuedAt: null,
  });
  let transactionCalls = 0;
  const neverClient = {
    $transaction: async () => { transactionCalls += 1; },
  };
  await assert.rejects(
    () => executeBillingAuthorityReconciliation(
      neverClient as never,
      releaseCommand({
        expectedState: 'CLAIMED',
        reason: 'PROVIDER_CONFIRMED_NOT_ISSUED',
        executionConfirmation: `RELEASE BILLING AUTHORITY ${GRANT_ID} FOR org-1 FROM CLAIMED AS PROVIDER_CONFIRMED_NOT_ISSUED WITH BILLING PROVIDER IO QUIESCED`,
      }),
      NOW,
    ),
    /provider I\/O are not attested quiescent/,
  );
  assert.equal(transactionCalls, 0);

  const fixture = transactionFixture(claimedGrant);
  const result = await executeBillingAuthorityReconciliation(
    fixture.client as never,
    releaseCommand({
      expectedState: 'CLAIMED',
      reason: 'PROVIDER_CONFIRMED_NOT_ISSUED',
      billingProviderIoQuiesced: true,
    }),
    NOW,
  );

  assert.deepEqual(fixture.events, ['lock-organisation', 'lock-grant', 'release-grant']);
  if (Array.isArray(result)) assert.fail('release returned list-mode output');
  assert.equal(result.mode, 'RELEASED');
  const data = fixture.updateArgs?.data as Record<string, unknown>;
  assert.equal(data.state, 'RELEASED');
  assert.equal(data.releaseReason, 'PROVIDER_CONFIRMED_NOT_ISSUED');
  assert.equal(data.releaseActor, 'RESTRICTED_OPERATOR:support.operator@example.org');
  const evidence = data.releaseEvidence as Record<string, unknown>;
  assert.equal(evidence.billingProviderIoQuiesced, true);
  assert.equal(evidence.providerIoQuiescenceRequired, true);
  assert.equal(evidence.authorityVerified, true);
  assert.equal(evidence.caseReference, 'INC-2026-0707');
  assert.equal(evidence.providerEvidence, PROVIDER_EVIDENCE);
  assert.equal(evidence.targetConfirmation, releaseCommand({
    expectedState: 'CLAIMED',
    reason: 'PROVIDER_CONFIRMED_NOT_ISSUED',
    billingProviderIoQuiesced: true,
  }).executionConfirmation);
});

test('Portal release supports only restricted operator attestation with provider evidence', async () => {
  const portalGrant = grant({ kind: 'PORTAL', safeReleaseAfter: null });
  const refused = transactionFixture(portalGrant);
  await assert.rejects(
    () => executeBillingAuthorityReconciliation(
      refused.client as never,
      releaseCommand(),
      NOW,
    ),
    /Portal authority may only be released by RESTRICTED_OPERATOR_ATTESTATION/,
  );
  assert.deepEqual(refused.events, ['lock-organisation', 'lock-grant']);

  const allowed = transactionFixture(portalGrant);
  await executeBillingAuthorityReconciliation(
    allowed.client as never,
    releaseCommand({ reason: 'RESTRICTED_OPERATOR_ATTESTATION' }),
    NOW,
  );
  const data = allowed.updateArgs?.data as Record<string, unknown>;
  const evidence = data.releaseEvidence as Record<string, unknown>;
  assert.equal(data.releaseReason, 'RESTRICTED_OPERATOR_ATTESTATION');
  assert.equal(evidence.grantKind, 'PORTAL');
  assert.equal(evidence.providerEvidence, PROVIDER_EVIDENCE);
});

test('Checkout safe reasons fail closed when their recorded provider evidence is absent or premature', async (t) => {
  const cases: Array<{
    name: string;
    row: GrantFixture;
    command: ReleaseCommand;
    expected: RegExp;
  }> = [
    {
      name: 'not issued contradicts an issued capability',
      row: grant(),
      command: releaseCommand({ reason: 'PROVIDER_CONFIRMED_NOT_ISSUED' }),
      expected: /requires no recorded capability or provider resource/,
    },
    {
      name: 'revoked lacks a provider resource',
      row: grant({ providerResourceId: null }),
      command: releaseCommand(),
      expected: /requires recorded provider-start and resource evidence/,
    },
    {
      name: 'terminal lacks capability-issued evidence',
      row: grant({ state: 'PROVIDER_STARTED', capabilityIssuedAt: null }),
      command: releaseCommand({
        expectedState: 'PROVIDER_STARTED',
        reason: 'PROVIDER_CAPABILITY_TERMINAL',
        billingProviderIoQuiesced: true,
      }),
      expected: /requires recorded capability-issued and resource evidence/,
    },
    {
      name: 'safe release time has not elapsed',
      row: grant({ safeReleaseAfter: new Date('2026-07-11T12:00:01.000Z') }),
      command: releaseCommand({ reason: 'CHECKOUT_SAFE_RELEASE_AFTER_ELAPSED' }),
      expected: /requires an issued capability, provider resource, and elapsed recorded safe-release time/,
    },
    {
      name: 'generic restricted attestation is Portal-only',
      row: grant(),
      command: releaseCommand({ reason: 'RESTRICTED_OPERATOR_ATTESTATION' }),
      expected: /RESTRICTED_OPERATOR_ATTESTATION is Portal-only/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = transactionFixture(scenario.row);
      await assert.rejects(
        () => executeBillingAuthorityReconciliation(
          fixture.client as never,
          scenario.command,
          NOW,
        ),
        scenario.expected,
      );
      assert.deepEqual(fixture.events, ['lock-organisation', 'lock-grant']);
    });
  }
});

test('release refuses state drift and compare-and-set misses', async () => {
  const stateDrift = transactionFixture(grant({ state: 'PROVIDER_STARTED' }));
  await assert.rejects(
    () => executeBillingAuthorityReconciliation(stateDrift.client as never, releaseCommand(), NOW),
    /expected CAPABILITY_ISSUED, found PROVIDER_STARTED/,
  );

  const casMiss = transactionFixture(grant(), 0);
  await assert.rejects(
    () => executeBillingAuthorityReconciliation(casMiss.client as never, releaseCommand(), NOW),
    /grant changed concurrently/,
  );
});

test('list returns only unresolved grants in stable organisation/id order', async () => {
  let findArgs: Record<string, unknown> | undefined;
  const rows = [grant()];
  const client = {
    billingAuthorityGrant: {
      findMany: async (args: Record<string, unknown>) => {
        findArgs = args;
        return rows;
      },
    },
  };
  assert.equal(
    await executeBillingAuthorityReconciliation(client as never, { mode: 'list' }),
    rows,
  );
  assert.deepEqual(findArgs?.where, { state: { not: 'RELEASED' } });
  assert.deepEqual(findArgs?.orderBy, [
    { organisationId: 'asc' },
    { id: 'asc' },
  ]);
});

test('billing-authority reconciliation is an offline package job and is not mounted by a route', () => {
  const routesRoot = join(process.cwd(), 'src', 'routes');
  const routeFiles: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) routeFiles.push(path);
    }
  };
  visit(routesRoot);
  const routeSource = routeFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(routeSource, /reconcile-billing-authority|BillingAuthorityReconciliation/);

  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['jobs:reconcile-billing-authority'],
    'node dist/jobs/reconcile-billing-authority.js',
  );

  const jobSource = readFileSync(
    join(process.cwd(), 'src', 'jobs', 'reconcile-billing-authority.ts'),
    'utf8',
  );
  assert.match(jobSource, /TransactionIsolationLevel\.Serializable/);
  assert.match(jobSource, /FROM "Organisation"[\s\S]*FOR UPDATE/);
  assert.match(jobSource, /FROM "BillingAuthorityGrant"[\s\S]*FOR UPDATE/);
  assert.match(jobSource, /confirm-billing-provider-io-quiesced/);
});
