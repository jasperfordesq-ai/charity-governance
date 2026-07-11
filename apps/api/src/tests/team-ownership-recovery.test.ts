import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  executeOwnershipRecovery,
  parseOwnershipRecoveryArgs,
  type OwnershipRecoveryCommand,
} from '../jobs/recover-team-ownership.js';

type LockedUserFixture = {
  id: string;
  organisationId: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  lifecycleStatus: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
  membershipVersion: number;
  emailVerified: boolean;
};

const baseArgs = [
  '--organisation-id', 'org-1',
  '--expected-owner-id', 'owner-1',
  '--target-user-id', 'admin-1',
  '--expected-target-email', 'admin@example.org',
  '--operator', 'support.operator@example.org',
  '--case-reference', 'SEC-2026-0042',
  '--confirm-authority-verified',
  '--confirm-target-identity-verified',
];

const reviewedVersionArgs = [
  '--expected-organisation-version', '3',
  '--expected-owner-version', '7',
  '--expected-target-version', '4',
];
const reviewedConfirmation =
  'TRANSFER OWNERSHIP TO admin-1 AT ORGANISATION 3 OWNER 7 TARGET 4';

function command(overrides: Partial<OwnershipRecoveryCommand> = {}): OwnershipRecoveryCommand {
  return {
    mode: 'execute',
    organisationId: 'org-1',
    expectedOwnerId: 'owner-1',
    targetUserId: 'admin-1',
    expectedTargetEmail: 'admin@example.org',
    expectedOrganisationVersion: 3,
    expectedOwnerVersion: 7,
    expectedTargetVersion: 4,
    operator: 'support.operator@example.org',
    caseReference: 'SEC-2026-0042',
    authorityVerified: true,
    targetIdentityVerified: true,
    sessionRevocationUnderstood: true,
    executionConfirmation: reviewedConfirmation,
    ...overrides,
  };
}

function user(overrides: Partial<LockedUserFixture> = {}): LockedUserFixture {
  return {
    id: 'admin-1',
    organisationId: 'org-1',
    email: 'admin@example.org',
    role: 'ADMIN',
    lifecycleStatus: 'ACTIVE',
    membershipVersion: 4,
    emailVerified: true,
    ...overrides,
  };
}

const owner = () => user({
  id: 'owner-1',
  email: 'owner@example.org',
  role: 'OWNER',
  membershipVersion: 7,
});

test('ownership recovery parser requires a safe mode, bounded evidence, and explicit authority', () => {
  assert.throws(() => parseOwnershipRecoveryArgs(baseArgs), /exactly one mode/);
  assert.throws(
    () => parseOwnershipRecoveryArgs(['--dry-run', ...baseArgs.filter((arg) => arg !== '--confirm-authority-verified')]),
    /confirm-authority-verified/,
  );
  assert.throws(
    () => parseOwnershipRecoveryArgs(['--dry-run', ...baseArgs, '--unknown']),
    /Unknown option/,
  );
  assert.throws(
    () => parseOwnershipRecoveryArgs([
      '--dry-run',
      ...baseArgs.map((argument) => (
        argument === 'SEC-2026-0042' ? 'x'.repeat(129) : argument
      )),
    ]),
    /case-reference must be at most 128/,
  );

  assert.deepEqual(parseOwnershipRecoveryArgs(['--dry-run', ...baseArgs]), {
    mode: 'dry-run',
    organisationId: 'org-1',
    expectedOwnerId: 'owner-1',
    targetUserId: 'admin-1',
    expectedTargetEmail: 'admin@example.org',
    expectedOrganisationVersion: undefined,
    expectedOwnerVersion: undefined,
    expectedTargetVersion: undefined,
    operator: 'support.operator@example.org',
    caseReference: 'SEC-2026-0042',
    authorityVerified: true,
    targetIdentityVerified: true,
    sessionRevocationUnderstood: false,
    executionConfirmation: undefined,
  });
});

test('execute mode requires both session impact acknowledgement and an exact target-bound phrase', () => {
  assert.throws(
    () => parseOwnershipRecoveryArgs(['--execute', ...baseArgs]),
    /expected-organisation-version/,
  );
  assert.throws(
    () => parseOwnershipRecoveryArgs(['--execute', ...baseArgs, ...reviewedVersionArgs]),
    /confirm-session-revocation-understood/,
  );
  assert.throws(
    () => parseOwnershipRecoveryArgs([
      '--execute', ...baseArgs, ...reviewedVersionArgs,
      '--confirm-session-revocation-understood',
      '--confirm-execute', 'TRANSFER OWNERSHIP',
    ]),
    /must exactly equal/,
  );
  assert.throws(
    () => parseOwnershipRecoveryArgs([
      '--dry-run', ...baseArgs,
      '--confirm-session-revocation-understood',
    ]),
    /Execution-only confirmations/,
  );

  assert.equal(parseOwnershipRecoveryArgs([
    '--execute', ...baseArgs, ...reviewedVersionArgs,
    '--confirm-session-revocation-understood',
    '--confirm-execute', reviewedConfirmation,
  ]).mode, 'execute');
});

test('the exported executor rejects parser-bypass commands before opening a transaction', async (t) => {
  const invalidCommands = [
    command({ expectedOrganisationVersion: undefined }),
    command({ sessionRevocationUnderstood: false }),
    command({ executionConfirmation: 'TRANSFER OWNERSHIP' }),
    { ...command(), authorityVerified: false } as unknown as OwnershipRecoveryCommand,
    { ...command(), targetIdentityVerified: false } as unknown as OwnershipRecoveryCommand,
  ];

  for (const [index, invalidCommand] of invalidCommands.entries()) {
    await t.test(`invalid command ${index + 1}`, async () => {
      let transactionOpened = false;
      const client = {
        $transaction: async () => {
          transactionOpened = true;
          throw new Error('transaction must not open');
        },
      };
      await assert.rejects(() => executeOwnershipRecovery(client as never, invalidCommand));
      assert.equal(transactionOpened, false);
    });
  }
});

test('dry-run locks and verifies the live state but performs no mutation or audit', async () => {
  const events: string[] = [];
  let rawCall = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) {
        events.push('lock-organisation');
        return [{ id: 'org-1', lifecycleStatus: 'ACTIVE', lifecycleVersion: 3 }];
      }
      if (rawCall === 2) {
        events.push('lock-billing-authority-grant');
        return [];
      }
      events.push('lock-users');
      return [user(), owner()].sort((left, right) => left.id.localeCompare(right.id));
    },
    authSession: {
      count: async ({ where }: { where: { userId: string } }) => {
        events.push(`count-sessions:${where.userId}`);
        return where.userId === 'owner-1' ? 2 : 1;
      },
    },
    deadlineReminderLog: {
      count: async () => {
        events.push('count-reserved-reminders');
        return 3;
      },
    },
  };
  let isolationLevel: unknown;
  const prisma = {
    $transaction: async (
      operation: (client: typeof tx) => Promise<unknown>,
      options: { isolationLevel?: unknown },
    ) => {
      isolationLevel = options.isolationLevel;
      return operation(tx);
    },
  };

  const result = await executeOwnershipRecovery(prisma as never, command({
    mode: 'dry-run',
    sessionRevocationUnderstood: false,
    executionConfirmation: undefined,
  }));

  assert.deepEqual(events, [
    'lock-organisation',
    'lock-billing-authority-grant',
    'lock-users',
    'count-sessions:owner-1',
    'count-sessions:admin-1',
    'count-reserved-reminders',
  ]);
  assert.equal(isolationLevel, 'Serializable');
  assert.equal(result.mode, 'DRY_RUN');
  assert.equal(result.mutationApplied, false);
  assert.equal(result.previousOwnerRevokedSessionCount, 2);
  assert.equal(result.targetRevokedSessionCount, 1);
  assert.equal(result.skippedReminderCount, 3);
  assert.equal(result.auditEventType, null);
  assert.equal(result.credentialsIssued, false);
});

test('execute atomically demotes then promotes, revokes both principals, and appends SUPPORT audit evidence', async () => {
  const events: string[] = [];
  const roleWrites: Array<Record<string, unknown>> = [];
  const sessionWrites: Array<Record<string, unknown>> = [];
  let auditData: Record<string, unknown> | undefined;
  let rawCall = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) {
        events.push('lock-organisation');
        return [{ id: 'org-1', lifecycleStatus: 'ACTIVE', lifecycleVersion: 3 }];
      }
      if (rawCall === 2) {
        events.push('lock-billing-authority-grant');
        return [];
      }
      events.push('lock-users');
      return [user(), owner()].sort((left, right) => left.id.localeCompare(right.id));
    },
    user: {
      updateMany: async (args: Record<string, unknown>) => {
        events.push((args.data as { role: string }).role === 'ADMIN' ? 'demote-owner' : 'promote-target');
        roleWrites.push(args);
        return { count: 1 };
      },
    },
    authSession: {
      updateMany: async (args: Record<string, unknown>) => {
        const userId = (args.where as { userId: string }).userId;
        events.push(`revoke-sessions:${userId}`);
        sessionWrites.push(args);
        return { count: userId === 'owner-1' ? 2 : 1 };
      },
    },
    deadlineReminderLog: {
      updateMany: async () => {
        events.push('skip-reminders');
        return { count: 1 };
      },
    },
    securityAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push('append-audit');
        auditData = data;
        return {};
      },
    },
  };
  let transactionCalls = 0;
  const prisma = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => {
      transactionCalls += 1;
      return operation(tx);
    },
  };
  const now = new Date('2026-07-11T08:00:00.000Z');

  const result = await executeOwnershipRecovery(prisma as never, command(), now);

  assert.equal(transactionCalls, 1);
  assert.deepEqual(events, [
    'lock-organisation',
    'lock-billing-authority-grant',
    'lock-users',
    'demote-owner',
    'promote-target',
    'revoke-sessions:owner-1',
    'revoke-sessions:admin-1',
    'skip-reminders',
    'append-audit',
  ]);
  assert.equal((roleWrites[0].data as { role: string }).role, 'ADMIN');
  assert.equal((roleWrites[1].data as { role: string }).role, 'OWNER');
  for (const write of sessionWrites) {
    assert.deepEqual(write.data, {
      revokedAt: now,
      revocationReason: 'OWNERSHIP_CHANGED',
    });
  }
  assert.equal(auditData?.type, 'OWNERSHIP_RECOVERED');
  assert.equal(auditData?.actorKind, 'SUPPORT');
  assert.equal(auditData?.actorUserId, null);
  assert.equal(auditData?.actorLabel, 'support.operator@example.org');
  assert.equal(auditData?.subjectLabel, 'admin@example.org');
  assert.equal(auditData?.subjectUserId, 'admin-1');
  assert.equal(auditData?.requestId, 'SEC-2026-0042');
  assert.equal((auditData?.context as Record<string, unknown>).credentialsIssued, false);
  assert.equal(result.mode, 'EXECUTED');
  assert.equal(result.mutationApplied, true);
  assert.equal(result.credentialsIssued, false);
});

test('recovery locks billing authority before users and refuses an unresolved Portal capability', async () => {
  const events: string[] = [];
  let rawCall = 0;
  const tx = {
    $queryRaw: async () => {
      rawCall += 1;
      if (rawCall === 1) {
        events.push('organisation');
        return [{ id: 'org-1', lifecycleStatus: 'ACTIVE', lifecycleVersion: 3 }];
      }
      events.push('billing-authority-grant');
      return [{
        id: '00000000-0000-4000-8000-000000000777',
        organisationId: 'org-1',
        kind: 'PORTAL',
        state: 'CAPABILITY_ISSUED',
        actorUserId: 'owner-1',
        actorSessionId: 'session-owner-1',
        actorMembershipVersion: 7,
        safeReleaseAfter: null,
      }];
    },
  };
  const prisma = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  };

  await assert.rejects(
    () => executeOwnershipRecovery(prisma as never, command()),
    (error: unknown) => Boolean(
      error &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'BILLING_AUTHORITY_CAPABILITY_ACTIVE'
    ),
  );
  assert.deepEqual(events, ['organisation', 'billing-authority-grant']);
});

test('recovery fails closed on organisation, owner, target, email, and verification mismatches', async (t) => {
  const cases: Array<{
    name: string;
    organisation?: Record<string, unknown>;
    users?: LockedUserFixture[];
    expected: RegExp;
  }> = [
    {
      name: 'inactive organisation',
      organisation: { id: 'org-1', lifecycleStatus: 'SUSPENDED', lifecycleVersion: 4 },
      expected: /organisation is not active/,
    },
    {
      name: 'organisation changed after dry-run',
      organisation: { id: 'org-1', lifecycleStatus: 'ACTIVE', lifecycleVersion: 4 },
      expected: /organisation version does not match/,
    },
    {
      name: 'unexpected current owner',
      users: [owner(), user()].map((row) => row.id === 'owner-1' ? { ...row, id: 'owner-2' } : row),
      expected: /does not match --expected-owner-id/,
    },
    {
      name: 'target from another tenant is absent',
      users: [owner()],
      expected: /target user was not found in this organisation/,
    },
    {
      name: 'owner membership changed after dry-run',
      users: [{ ...owner(), membershipVersion: 8 }, user()],
      expected: /current owner version does not match/,
    },
    {
      name: 'inactive target',
      users: [owner(), user({ lifecycleStatus: 'SUSPENDED' })],
      expected: /target user is not active/,
    },
    {
      name: 'unverified target',
      users: [owner(), user({ emailVerified: false })],
      expected: /target user email is not verified/,
    },
    {
      name: 'target email mismatch',
      users: [owner(), user({ email: 'someone-else@example.org' })],
      expected: /target email does not match/,
    },
    {
      name: 'target membership changed after dry-run',
      users: [owner(), user({ membershipVersion: 5 })],
      expected: /target version does not match/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let rawCall = 0;
      let writes = 0;
      const tx = {
        $queryRaw: async () => {
          rawCall += 1;
          if (rawCall === 1) {
            return [scenario.organisation ?? { id: 'org-1', lifecycleStatus: 'ACTIVE', lifecycleVersion: 3 }];
          }
          if (rawCall === 2) return [];
          return scenario.users ?? [owner(), user()];
        },
        user: { updateMany: async () => { writes += 1; return { count: 1 }; } },
      };
      const prisma = {
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      };
      await assert.rejects(
        () => executeOwnershipRecovery(prisma as never, command()),
        scenario.expected,
      );
      assert.equal(writes, 0);
    });
  }
});

test('recovery is an offline job only and is not mounted by a public route', () => {
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
  assert.doesNotMatch(routeSource, /recover-team-ownership|OWNERSHIP_RECOVERED/);

  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['jobs:recover-team-ownership'],
    'node dist/jobs/recover-team-ownership.js',
  );

  const jobSource = readFileSync(
    join(process.cwd(), 'src', 'jobs', 'recover-team-ownership.ts'),
    'utf8',
  );
  assert.doesNotMatch(jobSource, /passwordHash|authSession\.create|resetToken/);
});
