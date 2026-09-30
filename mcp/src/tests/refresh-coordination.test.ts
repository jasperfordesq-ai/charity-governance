import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import {
  ConnectorRefreshLockUnavailableError,
  connectorRefreshLockPort,
  withConnectorRefreshLock,
} from '../refresh-coordination.js';

const ORIGIN = 'https://refresh-coordination-fixture.test';

test('the same origin and realm serialize refresh work before reading a shared credential', async () => {
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  const order: string[] = [];
  const first = withConnectorRefreshLock(ORIGIN, 'charity', async () => {
    order.push('first-enter');
    firstEntered();
    await gate;
    order.push('first-leave');
  });
  await entered;
  const second = withConnectorRefreshLock(ORIGIN, 'charity', async () => {
    order.push('second-enter');
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(order, ['first-enter']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-enter', 'first-leave', 'second-enter']);
});

test('an occupied coordination port fails closed before refresh work begins', async () => {
  const origin = 'https://blocked-refresh-fixture.test';
  const port = connectorRefreshLockPort(origin, 'operator');
  const blocker = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve());
  });
  let used = false;
  try {
    await assert.rejects(
      withConnectorRefreshLock(origin, 'operator', async () => { used = true; }, 75),
      ConnectorRefreshLockUnavailableError,
    );
    assert.equal(used, false);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('an unsuccessful refresh releases the coordination port', async () => {
  const origin = 'https://failed-refresh-fixture.test';
  await assert.rejects(
    withConnectorRefreshLock(origin, 'charity', async () => { throw new Error('fixture failure'); }),
    /fixture failure/,
  );
  assert.equal(await withConnectorRefreshLock(origin, 'charity', async () => 'next'), 'next');
});

test('a separate process cannot enter the same credential refresh until its holder exits', async () => {
  const origin = 'https://cross-process-refresh-fixture.test';
  const moduleUrl = new URL('../refresh-coordination.js', import.meta.url).href;
  const script = `import { withConnectorRefreshLock } from ${JSON.stringify(moduleUrl)};
    await withConnectorRefreshLock(${JSON.stringify(origin)}, 'charity', async () => {
      process.stdout.write('LOCKED\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
    });
    process.stdin.pause();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [ready] = await Promise.race([
      once(child.stdout, 'data'),
      new Promise<never>((_, reject) => {
        readyTimer = setTimeout(() => reject(new Error('Child never acquired the refresh lock')), 5_000);
      }),
    ]);
    assert.match(String(ready), /LOCKED/);
    let entered = false;
    const contender = withConnectorRefreshLock(origin, 'charity', async () => { entered = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(entered, false, 'the parent must wait for the child process to release the lock');
    child.stdin.write('release\n');
    await contender;
    assert.equal(entered, true);
    const [exitCode] = await exited;
    assert.equal(exitCode, 0);
  } finally {
    if (readyTimer) clearTimeout(readyTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
