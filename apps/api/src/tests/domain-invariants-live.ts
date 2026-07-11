import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { BoardMemberService } from '../services/board-member.service.js';
import { GovernanceRegisterService } from '../services/governance-register.service.js';
import { runDomainInvariantWrite } from '../utils/domain-validation.js';
import { AppError } from '../utils/errors.js';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function docker(args: string[], timeout = 30_000) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function assertCommand(result: ReturnType<typeof docker>, operation: string): void {
  assert.equal(
    result.status,
    0,
    `${operation} failed: ${(result.stderr || result.stdout || result.error?.message || 'unknown error').slice(0, 2000)}`,
  );
}

async function waitForPostgres(container: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = docker(
      ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
      5_000,
    );
    if (ready.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail('Disposable domain-invariant PostgreSQL fixture did not become ready');
}

async function removeContainer(container: string): Promise<void> {
  docker(['rm', '--force', container], 20_000);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const residue = docker(
      ['ps', '--all', '--filter', `name=^/${container}$`, '--format', '{{.ID}}'],
      10_000,
    );
    assertCommand(residue, 'Disposable domain-invariant PostgreSQL residue check');
    if (!residue.stdout.trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Disposable PostgreSQL container ${container} was not removed`);
}

type LockHooks = {
  before?: () => void;
  acquired?: () => void;
  release?: Promise<void>;
};

function withOrganisationLockHooks(client: PrismaClient, hooks: LockHooks): PrismaClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== '$transaction') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }

      return async (callback: (transaction: unknown) => Promise<unknown>, options?: unknown) =>
        target.$transaction(async (transaction) => {
          let intercepted = false;
          const controlledTransaction = new Proxy(transaction, {
            get(transactionTarget, transactionProperty, transactionReceiver) {
              if (transactionProperty !== '$queryRaw') {
                const value = Reflect.get(transactionTarget, transactionProperty, transactionReceiver);
                return typeof value === 'function' ? value.bind(transactionTarget) : value;
              }

              return async (...args: unknown[]) => {
                if (!intercepted) hooks.before?.();
                const result = await (transactionTarget.$queryRaw as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
                if (!intercepted) {
                  intercepted = true;
                  hooks.acquired?.();
                  await hooks.release;
                }
                return result;
              };
            },
          });
          return callback(controlledTransaction);
        }, options as never);
    },
  });
}

async function assertStillWaiting(attempted: Deferred, outcome: Promise<{ settled: boolean }>): Promise<void> {
  await attempted.promise;
  const state = await Promise.race([
    outcome,
    new Promise<{ settled: boolean }>((resolve) => setImmediate(() => resolve({ settled: false }))),
  ]);
  assert.equal(state.settled, false, 'the contender must wait behind the organisation row lock');
}

function validBoardMember(id: string, organisationId: string) {
  return {
    id,
    organisationId,
    name: `Trustee ${id}`,
    role: 'Trustee',
    appointedDate: new Date('2026-01-01T00:00:00.000Z'),
    conductSigned: false,
    inductionCompleted: false,
  };
}

function validConflict(boardMemberId: string) {
  return {
    boardMemberId,
    trusteeName: 'Concurrency Trustee',
    matter: 'Declared interest',
    nature: 'Supplier relationship',
    dateDeclared: '2026-02-01',
    actionTaken: 'Recused from discussion and decision',
  };
}

export async function runDomainInvariantsPrismaConcurrencyProof(
  postgresImage: string,
): Promise<void> {
  const container = `charitypilot-domain-invariants-${randomUUID()}`;
  const password = 'domain-invariants-fixture-only';
  const start = docker([
    'run', '--detach', '--rm', '--name', container,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    postgresImage,
  ], 120_000);
  assertCommand(start, 'Disposable domain-invariant PostgreSQL startup');

  let firstClient: PrismaClient | undefined;
  let secondClient: PrismaClient | undefined;
  try {
    await waitForPostgres(container);
    const publishedPort = docker(['port', container, '5432/tcp'], 10_000);
    assertCommand(publishedPort, 'Disposable PostgreSQL port lookup');
    const portMatch = publishedPort.stdout.trim().match(/127\.0\.0\.1:(\d+)/u);
    assert.ok(portMatch, `Unexpected loopback port output: ${publishedPort.stdout.trim()}`);
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${portMatch[1]}/postgres?schema=public`;

    const require = (await import('node:module')).createRequire(import.meta.url);
    const prismaCli = require.resolve('prisma/build/index.js');
    const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
    const migrate = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(
      migrate.status,
      0,
      `Prisma migrate deploy failed: ${(migrate.stderr || migrate.stdout || migrate.error?.message || '').slice(0, 3000)}`,
    );

    firstClient = new PrismaClient({ datasourceUrl: databaseUrl });
    secondClient = new PrismaClient({ datasourceUrl: databaseUrl });
    await Promise.all([firstClient.$connect(), secondClient.$connect()]);
    await firstClient.$transaction(async (transaction) => {
      await transaction.organisation.create({
        data: {
          id: 'org-concurrency',
          name: 'Concurrency Charity',
          charitablePurpose: [],
        },
      });
      await transaction.user.create({
        data: {
          id: 'owner-concurrency',
          organisationId: 'org-concurrency',
          email: 'owner-concurrency@example.invalid',
          name: 'Concurrency Owner',
          passwordHash: 'fixture-only-not-a-login-hash',
          role: 'OWNER',
          emailVerified: true,
        },
      });
    });

    await assert.rejects(
      () => runDomainInvariantWrite(() => firstClient!.boardMember.create({
        data: {
          ...validBoardMember('board-invalid-check', 'org-concurrency'),
          appointedDate: new Date('2026-03-02T00:00:00.000Z'),
          termEndDate: new Date('2026-03-01T00:00:00.000Z'),
        },
      })),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 400 &&
        error.code === 'VALIDATION_ERROR',
    );

    await firstClient.$executeRawUnsafe(`
      ALTER TABLE "FundraisingRecord"
      ADD CONSTRAINT "FundraisingRecord_live_unknown_check"
      CHECK ("name" <> 'trigger-unknown-check')
    `);
    await assert.rejects(
      () => runDomainInvariantWrite(() => firstClient!.fundraisingRecord.create({
        data: {
          organisationId: 'org-concurrency',
          name: 'trigger-unknown-check',
          activityType: 'Direct mail',
        },
      })),
      (error: unknown) =>
        !(error instanceof AppError) &&
        ((error as { code?: string }).code === 'P2004' ||
          (error as { name?: string }).name === 'PrismaClientUnknownRequestError'),
    );

    await assert.rejects(
      () => runDomainInvariantWrite(
        () => firstClient!.conflictRecord.create({
          data: {
            organisationId: 'org-concurrency',
            boardMemberId: 'missing-board-member',
            trusteeName: 'Missing',
            matter: 'Missing reference',
            nature: 'Test',
            dateDeclared: new Date('2026-02-01T00:00:00.000Z'),
            actionTaken: 'None',
          },
        }),
        { boardMemberForeignKeyFailure: 'target-not-found' },
      ),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 404 &&
        error.code === 'BOARD_MEMBER_NOT_FOUND',
    );

    await assert.rejects(
      () => runDomainInvariantWrite(
        () => firstClient!.boardMember.create({
          data: validBoardMember('board-missing-organisation', 'missing-organisation'),
        }),
        { boardMemberForeignKeyFailure: 'target-not-found' },
      ),
      (error: unknown) =>
        !(error instanceof AppError) &&
        ((error as { code?: string }).code === 'P2003' ||
          (error as { name?: string }).name === 'PrismaClientUnknownRequestError'),
    );

    await firstClient.boardMember.create({
      data: validBoardMember('board-reference-first', 'org-concurrency'),
    });
    const referenceLockAcquired = deferred();
    const releaseReference = deferred();
    const referenceFirstService = new GovernanceRegisterService(withOrganisationLockHooks(firstClient, {
      acquired: referenceLockAcquired.resolve,
      release: releaseReference.promise,
    }));
    const referenceFirst = referenceFirstService.createConflict(
      'org-concurrency',
      validConflict('board-reference-first'),
    );
    await referenceLockAcquired.promise;

    const deletionAttempted = deferred();
    const deletionSecondService = new BoardMemberService(withOrganisationLockHooks(secondClient, {
      before: deletionAttempted.resolve,
    }));
    const deletionSecondOutcome = deletionSecondService.remove('org-concurrency', 'board-reference-first')
      .then(() => ({ settled: true }), (error: unknown) => ({ settled: true, error }));
    await assertStillWaiting(deletionAttempted, deletionSecondOutcome);
    releaseReference.resolve();
    await referenceFirst;
    const deletionResult = await deletionSecondOutcome;
    assert.equal('error' in deletionResult, false);
    assert.equal(
      await firstClient.boardMember.count({ where: { id: 'board-reference-first' } }),
      0,
    );
    const preservedConflict = await firstClient.conflictRecord.findFirstOrThrow({
      where: { trusteeName: 'Concurrency Trustee', matter: 'Declared interest' },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(preservedConflict.boardMemberId, null, 'deletion must retain and detach conflict history');

    await firstClient.boardMember.create({
      data: validBoardMember('board-deletion-first', 'org-concurrency'),
    });
    const deletionLockAcquired = deferred();
    const releaseDeletion = deferred();
    const deletionFirstService = new BoardMemberService(withOrganisationLockHooks(firstClient, {
      acquired: deletionLockAcquired.resolve,
      release: releaseDeletion.promise,
    }));
    const deletionFirst = deletionFirstService.remove('org-concurrency', 'board-deletion-first');
    await deletionLockAcquired.promise;

    const referenceAttempted = deferred();
    const referenceSecondService = new GovernanceRegisterService(withOrganisationLockHooks(secondClient, {
      before: referenceAttempted.resolve,
    }));
    const referenceSecondOutcome = referenceSecondService.createConflict(
      'org-concurrency',
      validConflict('board-deletion-first'),
    ).then(
      () => ({ settled: true, error: null as unknown }),
      (error: unknown) => ({ settled: true, error }),
    );
    await assertStillWaiting(referenceAttempted, referenceSecondOutcome);
    releaseDeletion.resolve();
    await deletionFirst;
    const referenceResult = await referenceSecondOutcome;
    assert.equal(referenceResult.error instanceof AppError, true);
    assert.equal((referenceResult.error as AppError).statusCode, 404);
    assert.equal((referenceResult.error as AppError).code, 'BOARD_MEMBER_NOT_FOUND');
    assert.equal(
      await firstClient.conflictRecord.count({ where: { boardMemberId: 'board-deletion-first' } }),
      0,
    );
  } finally {
    await Promise.allSettled([
      firstClient?.$disconnect() ?? Promise.resolve(),
      secondClient?.$disconnect() ?? Promise.resolve(),
    ]);
    await removeContainer(container);
  }
}
