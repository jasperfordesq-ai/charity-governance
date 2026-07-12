import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  bindAuthRecoveryControlForRuntime,
  requireAuthRecoveryControlForCurrentSecret,
  requireAuthRecoveryControlForRuntime,
} from '../services/auth-recovery-control.js';
import { authRecoverySecretFingerprint } from '../services/password-recovery-crypto.js';

const SECRET = Buffer.alloc(48, 0x31).toString('base64url');

function transactionFixture(input: {
  activeSecretFingerprint: string | null;
  retired?: boolean;
}) {
  let boundFingerprint: string | null = null;
  const tx = {
    async $queryRaw(query: TemplateStringsArray) {
      const sql = query.join(' ');
      if (sql.includes('FROM "AuthRecoveryControl"')) {
        return [{
          id: 1,
          blocked: false,
          generation: 1,
          activeSecretFingerprint: input.activeSecretFingerprint,
          retiredSecretFingerprint: null,
        }];
      }
      if (sql.includes('FROM "AuthRecoveryRetiredSecret"')) {
        return [{ retired: input.retired === true }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async $executeRaw(_query: TemplateStringsArray, fingerprint: string) {
      boundFingerprint = fingerprint;
      return 1;
    },
  };
  const prisma = {
    async $transaction<T>(callback: (client: Prisma.TransactionClient) => Promise<T>) {
      return callback(tx as unknown as Prisma.TransactionClient);
    },
  } as unknown as PrismaClient;
  return { tx: tx as unknown as Prisma.TransactionClient, prisma, getBound: () => boundFingerprint };
}

test('runtime startup performs the sole explicit initial fingerprint bind', async () => {
  const fixture = transactionFixture({ activeSecretFingerprint: null });
  const state = await bindAuthRecoveryControlForRuntime(fixture.prisma, SECRET);
  assert.equal(state.activeSecretFingerprint, authRecoverySecretFingerprint(SECRET));
  assert.equal(fixture.getBound(), authRecoverySecretFingerprint(SECRET));
});

test('rotation-style strict assertion never lazily binds an unbound control', async () => {
  const fixture = transactionFixture({ activeSecretFingerprint: null });
  await assert.rejects(
    () => requireAuthRecoveryControlForCurrentSecret(fixture.tx, SECRET),
    /has not been explicitly bound/,
  );
  assert.equal(fixture.getBound(), null);
});

test('non-API runtimes require an existing matching bind and never initialize it', async () => {
  const unbound = transactionFixture({ activeSecretFingerprint: null });
  await assert.rejects(
    () => requireAuthRecoveryControlForRuntime(unbound.prisma, SECRET),
    /has not been explicitly bound/,
  );
  assert.equal(unbound.getBound(), null);

  const fingerprint = authRecoverySecretFingerprint(SECRET);
  const bound = transactionFixture({ activeSecretFingerprint: fingerprint });
  const state = await requireAuthRecoveryControlForRuntime(bound.prisma, SECRET);
  assert.equal(state.activeSecretFingerprint, fingerprint);
  assert.equal(bound.getBound(), null);
});

test('initial binding rejects a fingerprint already present in retired history', async () => {
  const fixture = transactionFixture({ activeSecretFingerprint: null, retired: true });
  await assert.rejects(
    () => bindAuthRecoveryControlForRuntime(fixture.prisma, SECRET),
    /previously retired/,
  );
  assert.equal(fixture.getBound(), null);
});
