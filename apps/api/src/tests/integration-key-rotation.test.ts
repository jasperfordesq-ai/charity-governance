import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  loadIntegrationCredential,
  storeIntegrationCredential,
  type IntegrationCredentialWriteClient,
} from '../services/integration-credential.service.js';
import {
  beginIntegrationKeyRotation,
  integrationKeyRotationStatus,
  resealIntegrationCredentials,
} from '../services/integration-key-rotation.js';
import { integrationKeyFingerprint } from '../services/integration-crypto.js';
import { AppError } from '../utils/errors.js';
import { parseIntegrationKeyRotationArgs } from '../jobs/rotate-integration-encryption-key.js';

const keyA = randomBytes(32);
const keyB = randomBytes(32);
const keyC = randomBytes(32);

type Row = { id: string; integrationId: string; kind: string; sealed: unknown; generation: number;
  expiresAt: Date | null; updatedAt: Date };
type Control = { id: number; generation: number; activeKeyFingerprint: string | null;
  retiredKeyFingerprint: string | null; rotatedAt: Date | null };

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  for (const [field, condition] of Object.entries(where)) {
    const value = row[field];
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('lt' in (condition as object) && !((value as number) < (condition as { lt: number }).lt)) return false;
      if ('gt' in (condition as object) && !(String(value) > (condition as { gt: string }).gt)) return false;
    } else if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
    } else if (value !== condition) return false;
  }
  return true;
}

/** A stateful stand-in for the three delegates, with a clock that ticks per write. */
function store() {
  const integrations = new Map([
    ['int-1', { organisationId: 'org-a', provider: 'CONFLUENCE' }],
    ['int-2', { organisationId: 'org-b', provider: 'CONFLUENCE' }],
  ]);
  const rows: Row[] = [];
  let control: Control | null = null;
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, tick++));
  // Runs once at the start of the next transaction, to interleave a rotation
  // between a store choosing its key and committing.
  const hooks: { beforeTransaction?: () => Promise<void> } = {};
  const client = {
    organisationIntegration: {
      findUnique: async ({ where }: { where: { id: string } }) => integrations.get(where.id) ?? null,
    },
    integrationSecretControl: {
      findUnique: async () => (control ? { ...control } : null),
      upsert: async ({ create, update }: { create: Control; update: Partial<Control> }) => {
        control = control ? { ...control, ...update }
          : Object.assign({ retiredKeyFingerprint: null, rotatedAt: null }, create);
        return control;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Control> }) => {
        if (!control || !matches(control as unknown as Record<string, unknown>, where)) return { count: 0 };
        control = { ...control, ...data };
        return { count: 1 };
      },
    },
    integrationCredential: {
      upsert: async ({ where, create, update }: { where: { integrationId_kind: { integrationId: string; kind: string } };
        create: Omit<Row, 'id' | 'updatedAt'>; update: Partial<Row> }) => {
        const key = where.integrationId_kind;
        const existing = rows.find(r => r.integrationId === key.integrationId && r.kind === key.kind);
        if (existing) Object.assign(existing, update, { updatedAt: now() });
        else rows.push({ id: `cred-${rows.length + 1}`, ...create, updatedAt: now() } as Row);
        return {};
      },
      findUnique: async ({ where }: { where: { integrationId_kind: { integrationId: string; kind: string } } }) => {
        const key = where.integrationId_kind;
        const row = rows.find(r => r.integrationId === key.integrationId && r.kind === key.kind);
        return row ? { sealed: row.sealed } : null;
      },
      findMany: async ({ where, take }: { where?: Record<string, unknown>; take?: number } = {}) =>
        rows.filter(r => matches(r as unknown as Record<string, unknown>, where))
          .sort((a, b) => a.id.localeCompare(b.id)).slice(0, take ?? rows.length).map(r => ({ ...r })),
      count: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        rows.filter(r => matches(r as unknown as Record<string, unknown>, where)).length,
      groupBy: async () => {
        const counts = new Map<number, number>();
        for (const row of rows) counts.set(row.generation, (counts.get(row.generation) ?? 0) + 1);
        return [...counts].sort((a, b) => a[0] - b[0])
          .map(([generation, all]) => ({ generation, _count: { _all: all } }));
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hits = rows.filter(r => matches(r as unknown as Record<string, unknown>, where));
        for (const row of hits) Object.assign(row, data, { updatedAt: now() });
        return { count: hits.length };
      },
    },
    $transaction: async <T>(run: (tx: unknown) => Promise<T>) => {
      const before = hooks.beforeTransaction;
      hooks.beforeTransaction = undefined;
      if (before) await before();
      return run(client);
    },
  };
  return { client: client as unknown as IntegrationCredentialWriteClient, rows, control: () => control, hooks };
}

async function withKeys<T>(active: Buffer | null, previous: Buffer | null, run: () => Promise<T>): Promise<T> {
  const saved = [process.env.INTEGRATION_ENCRYPTION_KEY, process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS];
  if (active) process.env.INTEGRATION_ENCRYPTION_KEY = active.toString('hex');
  else delete process.env.INTEGRATION_ENCRYPTION_KEY;
  if (previous) process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS = previous.toString('hex');
  else delete process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS;
  try {
    return await run();
  } finally {
    if (saved[0] === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
    else process.env.INTEGRATION_ENCRYPTION_KEY = saved[0];
    if (saved[1] === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS;
    else process.env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS = saved[1];
  }
}

const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;

test('a full online rotation keeps every credential readable at every step and leaves nothing on the old key', async () => {
  const { client, rows, control } = store();
  const load = (integrationId: string) => loadIntegrationCredential(client, { integrationId, kind: 'refresh_token' });

  await withKeys(keyA, null, async () => {
    await storeIntegrationCredential(client, { integrationId: 'int-1', kind: 'refresh_token', plaintext: 'token-one' });
    assert.equal(control()?.activeKeyFingerprint, integrationKeyFingerprint(keyA));
  });

  // Step 1: new key configured, old key kept as previous, begin not yet run.
  await withKeys(keyB, keyA, async () => {
    assert.equal((await integrationKeyRotationStatus(client)).state, 'ROTATION_PENDING');
    assert.equal(await load('int-1'), 'token-one');
    await storeIntegrationCredential(client, { integrationId: 'int-2', kind: 'refresh_token', plaintext: 'token-two' });
    assert.equal(rows.find(r => r.integrationId === 'int-2')?.generation, 1, 'pending rotation still seals under the old generation');

    // Step 2: begin.
    const begun = await beginIntegrationKeyRotation(client, 1);
    assert.deepEqual([begun.generation, begun.alreadyBegun], [2, false]);
    assert.equal(control()?.activeKeyFingerprint, integrationKeyFingerprint(keyB));
    assert.equal(control()?.retiredKeyFingerprint, integrationKeyFingerprint(keyA));
    assert.equal((await beginIntegrationKeyRotation(client, 1)).alreadyBegun, true, 'begin is idempotent');

    // Mid-rotation: old rows still open, by their own generation's key.
    const mid = await integrationKeyRotationStatus(client);
    assert.deepEqual([mid.state, mid.awaitingReseal], ['RESEALING', 2]);
    assert.equal(await load('int-1'), 'token-one');
    assert.equal(await load('int-2'), 'token-two');

    // Step 3: reseal.
    const result = await resealIntegrationCredentials(client, 50);
    assert.deepEqual([result.resealed, result.skippedChanged, result.failed.length, result.remaining], [2, 0, 0, 0]);
    assert.ok(rows.every(r => r.generation === 2));
    assert.equal((await integrationKeyRotationStatus(client)).state, 'STEADY');
  });

  // Step 4: previous key removed; everything still opens under the new key.
  await withKeys(keyB, null, async () => {
    assert.equal(await load('int-1'), 'token-one');
    assert.equal(await load('int-2'), 'token-two');
  });
});

test('removing the previous key before re-sealing is named as a stale generation, never as corruption', async () => {
  const { client } = store();
  await withKeys(keyA, null, () => storeIntegrationCredential(client,
    { integrationId: 'int-1', kind: 'refresh_token', plaintext: 'token-one' }));
  await withKeys(keyB, keyA, () => beginIntegrationKeyRotation(client, 1));
  await withKeys(keyB, null, async () => {
    await assert.rejects(loadIntegrationCredential(client, { integrationId: 'int-1', kind: 'refresh_token' }),
      code('INTEGRATION_SECRET_GENERATION_STALE'));
  });
  // A previous key that is not the recorded retired key is ignored, not trusted.
  await withKeys(keyB, keyC, async () => {
    await assert.rejects(loadIntegrationCredential(client, { integrationId: 'int-1', kind: 'refresh_token' }),
      code('INTEGRATION_SECRET_GENERATION_STALE'));
  });
  // Restoring the right previous key recovers it without any re-store.
  await withKeys(keyB, keyA, async () => {
    assert.equal(await loadIntegrationCredential(client, { integrationId: 'int-1', kind: 'refresh_token' }), 'token-one');
  });
});

test('a credential newer than the recorded generation is named as a control-record inconsistency', async () => {
  const { client, rows } = store();
  await withKeys(keyA, null, () => storeIntegrationCredential(client,
    { integrationId: 'int-1', kind: 'refresh_token', plaintext: 'token-one' }));
  (rows[0]!.sealed as { generation: number }).generation = 3;
  await withKeys(keyA, null, async () => {
    await assert.rejects(loadIntegrationCredential(client, { integrationId: 'int-1', kind: 'refresh_token' }),
      code('INTEGRATION_SECRET_GENERATION_AHEAD'));
  });
});

test('begin refuses unsafe or ambiguous rotations and changes nothing', async () => {
  const { client, control } = store();
  await withKeys(keyB, keyA, async () => {
    await assert.rejects(beginIntegrationKeyRotation(client, 1), code('INTEGRATION_ROTATION_NOTHING_RECORDED'));
  });
  await withKeys(keyA, null, () => storeIntegrationCredential(client,
    { integrationId: 'int-1', kind: 'refresh_token', plaintext: 'token-one' }));
  const before = JSON.stringify(control());
  await withKeys(keyB, null, async () => {
    await assert.rejects(beginIntegrationKeyRotation(client, 1), code('INTEGRATION_ROTATION_KEYS_REQUIRED'));
  });
  await withKeys(keyA, keyA, async () => {
    await assert.rejects(beginIntegrationKeyRotation(client, 1), code('INTEGRATION_ROTATION_SAME_KEY'));
  });
  await withKeys(keyB, keyC, async () => {
    await assert.rejects(beginIntegrationKeyRotation(client, 1), code('INTEGRATION_ROTATION_PREVIOUS_KEY_MISMATCH'));
  });
  await withKeys(keyB, keyA, async () => {
    await assert.rejects(beginIntegrationKeyRotation(client, 2), code('INTEGRATION_ROTATION_GENERATION_CHANGED'));
    await assert.rejects(beginIntegrationKeyRotation(client, 0), code('INTEGRATION_ROTATION_GENERATION_REQUIRED'));
  });
  assert.equal(JSON.stringify(control()), before, 'no refused begin changed the control record');

  // A second rotation cannot begin while rows from the first remain.
  await withKeys(keyB, keyA, () => beginIntegrationKeyRotation(client, 1));
  await withKeys(keyC, keyB, async () => {
    await assert.rejects(beginIntegrationKeyRotation(client, 2), code('INTEGRATION_ROTATION_UNFINISHED'));
  });
});

test('reseal never overwrites a row that changed underneath it, and refuses before begin', async () => {
  const { client, rows } = store();
  await withKeys(keyA, null, () => storeIntegrationCredential(client,
    { integrationId: 'int-1', kind: 'refresh_token', plaintext: 'token-one' }));
  await withKeys(keyB, keyA, async () => {
    await assert.rejects(resealIntegrationCredentials(client), code('INTEGRATION_ROTATION_NOT_BEGUN'));
    await beginIntegrationKeyRotation(client, 1);
    const original = client.integrationCredential.findMany;
    // Simulate a concurrent writer touching the row between read and write.
    // Only the batch read (the one with `take`) is intercepted; the status
    // count reads before it must see the row as it was.
    (client.integrationCredential as unknown as { findMany: typeof original }).findMany = (async (args: never) => {
      const read = await original(args);
      if ((args as { take?: number } | undefined)?.take !== undefined) {
        rows[0]!.updatedAt = new Date(Date.UTC(2030, 0, 1));
      }
      return read;
    }) as typeof original;
    const result = await resealIntegrationCredentials(client);
    assert.deepEqual([result.resealed, result.skippedChanged, result.remaining], [0, 1, 1]);
    (client.integrationCredential as unknown as { findMany: typeof original }).findMany = original;
    const retry = await resealIntegrationCredentials(client);
    assert.deepEqual([retry.resealed, retry.remaining], [1, 0]);
    assert.equal(await loadIntegrationCredential(client, { integrationId: 'int-1', kind: 'refresh_token' }), 'token-one');
  });
});

test('a reseal batch reports an unreadable row by code and leaves it untouched', async () => {
  const { client, rows } = store();
  await withKeys(keyA, null, () => storeIntegrationCredential(client,
    { integrationId: 'int-1', kind: 'refresh_token', plaintext: 'token-one' }));
  const tampered = rows[0]!.sealed as { ciphertext: string };
  tampered.ciphertext = Buffer.from('not-the-ciphertext').toString('base64');
  const snapshot = JSON.stringify(rows[0]!.sealed);
  await withKeys(keyB, keyA, async () => {
    await beginIntegrationKeyRotation(client, 1);
    const result = await resealIntegrationCredentials(client);
    assert.deepEqual(result.failed, [{ id: rows[0]!.id, code: 'INTEGRATION_SECRET_UNREADABLE' }]);
    assert.equal(result.remaining, 1);
  });
  assert.equal(JSON.stringify(rows[0]!.sealed), snapshot);
});

test('the rotation command parses only its three modes and requires an explicit expected generation', () => {
  assert.deepEqual(parseIntegrationKeyRotationArgs(['status']), { mode: 'status' });
  assert.deepEqual(parseIntegrationKeyRotationArgs(['begin', '--expected-generation', '3']),
    { mode: 'begin', expectedGeneration: 3 });
  assert.deepEqual(parseIntegrationKeyRotationArgs(['reseal']), { mode: 'reseal', batch: 50 });
  assert.deepEqual(parseIntegrationKeyRotationArgs(['reseal', '--batch', '10']), { mode: 'reseal', batch: 10 });
  assert.deepEqual(parseIntegrationKeyRotationArgs(['reseal', '--after', 'cred-9', '--batch', '5']),
    { mode: 'reseal', batch: 5, after: 'cred-9' });
  for (const argv of [[], ['begin'], ['begin', '--expected-generation'], ['begin', '--expected-generation', '0'],
    ['begin', '--expected-generation', 'x'], ['reseal', '--batch', '-1'], ['status', '--batch', '2'],
    ['rotate'], ['begin', '--expected-generation', '2', '--force', '1'],
    // A flag of another mode, a repeated flag and a stray word all refuse.
    ['reseal', '--expected-generation', '3'], ['begin', '--batch', '2', '--expected-generation', '2'],
    ['reseal', '--batch', '10', '--batch', '1'], ['reseal', '--after', 'a b'], ['reseal', '--after'],
    ['status', 'now'], ['begin', '--expected-generation', '2', 'extra']]) {
    assert.throws(() => parseIntegrationKeyRotationArgs(argv), Error, argv.join(' '));
  }
});

test('a pending rotation trusts only the previous key that matches the recorded fingerprint', async () => {
  const { client } = store();
  await withKeys(keyA, null, () => storeIntegrationCredential(client,
    { integrationId: 'int-1', kind: 'refresh_token', plaintext: 'token-one' }));
  await withKeys(keyB, keyC, async () => {
    assert.equal((await integrationKeyRotationStatus(client)).state, 'KEY_MISMATCH');
    await assert.rejects(loadIntegrationCredential(client, { integrationId: 'int-1', kind: 'refresh_token' }),
      code('INTEGRATION_KEY_MISMATCH'));
  });
});

test('begin refuses a control record that names no key, even when the row exists', async () => {
  const { client } = store();
  await client.integrationSecretControl.upsert({ where: { id: 1 },
    create: { id: 1, generation: 1, activeKeyFingerprint: null }, update: {} });
  await withKeys(keyB, keyA, async () => {
    await assert.rejects(beginIntegrationKeyRotation(client, 1), code('INTEGRATION_ROTATION_NOTHING_RECORDED'));
  });
});

test('a store racing a rotation never commits a credential under the retired key', async () => {
  const { client, rows, hooks } = store();
  await withKeys(keyA, null, () => storeIntegrationCredential(client,
    { integrationId: 'int-1', kind: 'refresh_token', plaintext: 'token-one' }));
  await withKeys(keyB, keyA, async () => {
    // The store chooses the old key (rotation pending), then begin and a full
    // re-seal both finish before its transaction runs.
    hooks.beforeTransaction = async () => {
      await beginIntegrationKeyRotation(client, 1);
      assert.equal((await resealIntegrationCredentials(client)).remaining, 0);
    };
    await storeIntegrationCredential(client, { integrationId: 'int-2', kind: 'refresh_token', plaintext: 'token-two' });
    assert.deepEqual(rows.map(r => r.generation), [2, 2], 'the racing write was redone under the new generation');
    assert.equal((await integrationKeyRotationStatus(client)).awaitingReseal, 0);
  });
  // The retired key can now be removed without losing the racing credential.
  await withKeys(keyB, null, async () => {
    assert.equal(await loadIntegrationCredential(client, { integrationId: 'int-2', kind: 'refresh_token' }), 'token-two');
  });
});

test('a store whose generation keeps changing gives up without writing', async () => {
  const { client, rows } = store();
  await withKeys(keyA, null, () => storeIntegrationCredential(client,
    { integrationId: 'int-1', kind: 'refresh_token', plaintext: 'token-one' }));
  const snapshot = JSON.stringify(rows);
  const control = client.integrationSecretControl as unknown as { updateMany: unknown };
  const original = control.updateMany;
  let calls = 0;
  // Every fence finds the generation moved on.
  control.updateMany = async () => {
    calls += 1;
    return { count: 0 };
  };
  try {
    await withKeys(keyA, null, async () => {
      await assert.rejects(storeIntegrationCredential(client,
        { integrationId: 'int-1', kind: 'refresh_token', plaintext: 'token-new' }),
      code('INTEGRATION_SECRET_GENERATION_CHANGED'));
    });
  } finally {
    control.updateMany = original;
  }
  assert.equal(calls, 3, 'three attempts, then a refusal');
  assert.equal(JSON.stringify(rows), snapshot);
});

test('reseal moves past rows that keep failing, and status counts by generation', async () => {
  const { client, rows } = store();
  await withKeys(keyA, null, async () => {
    for (const id of ['int-1', 'int-2']) {
      await storeIntegrationCredential(client, { integrationId: id, kind: 'refresh_token', plaintext: `token-${id}` });
    }
    await storeIntegrationCredential(client, { integrationId: 'int-1', kind: 'access_token', plaintext: 'access-one' });
  });
  // The first row in id order will never open.
  (rows[0]!.sealed as { ciphertext: string }).ciphertext = Buffer.from('broken').toString('base64');
  await withKeys(keyB, keyA, async () => {
    await beginIntegrationKeyRotation(client, 1);
    const status = await integrationKeyRotationStatus(client);
    assert.deepEqual([status.credentialsByGeneration, status.awaitingReseal], [{ 1: 3 }, 3]);
    const first = await resealIntegrationCredentials(client, 1);
    assert.deepEqual([first.resealed, first.failed.map(f => f.id), first.next], [0, [rows[0]!.id], rows[0]!.id]);
    const again = await resealIntegrationCredentials(client, 1);
    assert.deepEqual(again.failed.map(f => f.id), [rows[0]!.id], 'without a cursor the same row fills the batch');
    const moved = await resealIntegrationCredentials(client, 1, first.next!);
    assert.deepEqual([moved.resealed, moved.failed.length, moved.next], [1, 0, rows[1]!.id]);
    const last = await resealIntegrationCredentials(client, 5, moved.next!);
    assert.deepEqual([last.resealed, last.remaining, last.next], [1, 1, null]);
    const after = await integrationKeyRotationStatus(client);
    assert.deepEqual([after.credentialsByGeneration, after.awaitingReseal, after.state], [{ 1: 1, 2: 2 }, 1, 'RESEALING']);
  });
});
