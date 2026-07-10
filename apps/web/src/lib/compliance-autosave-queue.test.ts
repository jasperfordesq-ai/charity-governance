import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ComplianceAutosaveQueue,
  type ComplianceAutosaveResult,
  type ComplianceRevisionConflict,
} from './compliance-autosave-queue';

type Draft = { actionTaken: string };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function conflictError(expectedRevision: number, currentRevision: number) {
  return {
    response: {
      data: {
        code: 'COMPLIANCE_RECORD_REVISION_CONFLICT',
        details: { expectedRevision, currentRevision },
      },
    },
  };
}

function parseConflict(error: unknown): ComplianceRevisionConflict | null {
  const data = (error as {
    response?: { data?: { code?: string; details?: { expectedRevision?: number; currentRevision?: number } } };
  })?.response?.data;
  if (
    data?.code !== 'COMPLIANCE_RECORD_REVISION_CONFLICT' ||
    !Number.isInteger(data.details?.expectedRevision) ||
    !Number.isInteger(data.details?.currentRevision)
  ) {
    return null;
  }
  return {
    expectedRevision: data.details?.expectedRevision as number,
    currentRevision: data.details?.currentRevision as number,
  };
}

test('serializes one standard and sends a newer edit after the active revision is acknowledged', async () => {
  const saves: Array<{
    data: Draft;
    expectedRevision: number;
    result: Deferred<ComplianceAutosaveResult>;
  }> = [];
  const phases: string[] = [];
  const queue = new ComplianceAutosaveQueue<Draft>({
    initialRevision: 1,
    parseConflict,
    save: (data, expectedRevision) => {
      const result = deferred<ComplianceAutosaveResult>();
      saves.push({ data, expectedRevision, result });
      return result.promise;
    },
    onStateChange: (snapshot) => phases.push(snapshot.phase),
  });

  queue.enqueue({ actionTaken: 'A' });
  const firstFlush = queue.flush();
  assert.equal(saves.length, 1);
  assert.equal(saves[0]?.expectedRevision, 1);

  queue.enqueue({ actionTaken: 'B' });
  const secondFlush = queue.flush();
  assert.equal(saves.length, 1, 'B must not start while A is in flight');

  saves[0]?.result.resolve({ revision: 2 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(saves.length, 2);
  assert.deepEqual(saves[1]?.data, { actionTaken: 'B' });
  assert.equal(saves[1]?.expectedRevision, 2);
  assert.notEqual(queue.getSnapshot().phase, 'saved', 'A must not report Saved while B remains');

  saves[1]?.result.resolve({ revision: 3 });
  assert.deepEqual(await firstFlush, { status: 'saved', revision: 3 });
  assert.deepEqual(await secondFlush, { status: 'saved', revision: 3 });
  assert.equal(queue.getSnapshot().durableGeneration, queue.getSnapshot().localGeneration);
  assert.equal(queue.getSnapshot().phase, 'saved');
  assert.equal(phases.at(-1), 'saved');
});

test('coalesces rapid queued edits to the newest full draft', async () => {
  const first = deferred<ComplianceAutosaveResult>();
  const second = deferred<ComplianceAutosaveResult>();
  const calls: Array<{ data: Draft; expectedRevision: number }> = [];
  const queue = new ComplianceAutosaveQueue<Draft>({
    initialRevision: 0,
    parseConflict,
    save: (data, expectedRevision) => {
      calls.push({ data, expectedRevision });
      return calls.length === 1 ? first.promise : second.promise;
    },
  });

  queue.enqueue({ actionTaken: 'A' });
  const flush = queue.flush();
  queue.enqueue({ actionTaken: 'B' });
  queue.enqueue({ actionTaken: 'C' });

  first.resolve({ revision: 1 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { data: { actionTaken: 'C' }, expectedRevision: 1 });

  second.resolve({ revision: 2 });
  assert.deepEqual(await flush, { status: 'saved', revision: 2 });
});

test('reconciles an ambiguous failed request before sending the newer retained draft', async () => {
  const attempts: Array<{ data: Draft; expectedRevision: number }> = [];
  let fail = true;
  const queue = new ComplianceAutosaveQueue<Draft>({
    initialRevision: 4,
    parseConflict,
    save: async (data, expectedRevision) => {
      attempts.push({ data, expectedRevision });
      if (fail) throw new Error('network unavailable');
      return { revision: data.actionTaken === 'A' ? 5 : 6 };
    },
  });

  queue.enqueue({ actionTaken: 'A' });
  const failed = queue.flush();
  queue.enqueue({ actionTaken: 'B' });

  assert.deepEqual(await failed, { status: 'error', revision: 4 });
  assert.equal(queue.getSnapshot().phase, 'error');
  assert.deepEqual(queue.getSnapshot().localDraft, { actionTaken: 'B' });

  fail = false;
  assert.deepEqual(await queue.retry(), { status: 'saved', revision: 6 });
  assert.deepEqual(attempts, [
    { data: { actionTaken: 'A' }, expectedRevision: 4 },
    { data: { actionTaken: 'A' }, expectedRevision: 4 },
    { data: { actionTaken: 'B' }, expectedRevision: 5 },
  ]);
});

test('revision conflict pauses writes and preserves the newest local draft', async () => {
  let calls = 0;
  const queue = new ComplianceAutosaveQueue<Draft>({
    initialRevision: 2,
    parseConflict,
    save: async () => {
      calls += 1;
      throw conflictError(2, 3);
    },
  });

  queue.enqueue({ actionTaken: 'My first draft' });
  const outcomePromise = queue.flush();
  queue.enqueue({ actionTaken: 'My newest draft' });
  const outcome = await outcomePromise;

  assert.deepEqual(outcome, {
    status: 'conflict',
    revision: 2,
    conflict: { expectedRevision: 2, currentRevision: 3 },
  });
  assert.equal(queue.getSnapshot().phase, 'conflict');
  assert.deepEqual(queue.getSnapshot().localDraft, { actionTaken: 'My newest draft' });
  assert.equal(queue.hasUnsettledChanges(), true);

  assert.equal((await queue.flush()).status, 'conflict');
  assert.equal((await queue.retry()).status, 'conflict');
  assert.equal(calls, 1, 'conflicts must never trigger a blind overwrite retry');
});

test('dispose drops unsent drafts and never starts them after an active response', async () => {
  const first = deferred<ComplianceAutosaveResult>();
  const calls: Draft[] = [];
  const queue = new ComplianceAutosaveQueue<Draft>({
    initialRevision: 1,
    parseConflict,
    save: (data) => {
      calls.push(data);
      return first.promise;
    },
  });

  queue.enqueue({ actionTaken: 'A' });
  const flush = queue.flush();
  queue.enqueue({ actionTaken: 'B' });
  queue.dispose();

  assert.deepEqual(await flush, { status: 'disposed', revision: 1 });
  first.resolve({ revision: 2 });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, [{ actionTaken: 'A' }]);
});

test('captures synchronous transport failures and lets retry settle normally', async () => {
  let shouldThrow = true;
  const queue = new ComplianceAutosaveQueue<Draft>({
    initialRevision: 0,
    parseConflict,
    save: () => {
      if (shouldThrow) throw new Error('synchronous adapter failure');
      return Promise.resolve({ revision: 1 });
    },
  });

  queue.enqueue({ actionTaken: 'A' });
  assert.deepEqual(await queue.flush(), { status: 'error', revision: 0 });
  shouldThrow = false;
  assert.deepEqual(await queue.retry(), { status: 'saved', revision: 1 });
});

test('accepts a same-revision no-op as durable and continues with a newer queued edit', async () => {
  const first = deferred<ComplianceAutosaveResult>();
  const second = deferred<ComplianceAutosaveResult>();
  const calls: Array<{ data: Draft; expectedRevision: number }> = [];
  const queue = new ComplianceAutosaveQueue<Draft>({
    initialRevision: 3,
    parseConflict,
    save: (data, expectedRevision) => {
      calls.push({ data, expectedRevision });
      return calls.length === 1 ? first.promise : second.promise;
    },
  });

  queue.enqueue({ actionTaken: 'A' });
  const flush = queue.flush();
  queue.enqueue({ actionTaken: 'B' });

  first.resolve({ revision: 3 });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls, [
    { data: { actionTaken: 'A' }, expectedRevision: 3 },
    { data: { actionTaken: 'B' }, expectedRevision: 3 },
  ]);
  assert.notEqual(queue.getSnapshot().phase, 'saved');

  second.resolve({ revision: 4 });
  assert.deepEqual(await flush, { status: 'saved', revision: 4 });
  assert.equal(queue.getSnapshot().durableGeneration, queue.getSnapshot().localGeneration);
});
