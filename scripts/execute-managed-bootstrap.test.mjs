import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, chmodSync, readFileSync, readdirSync, lstatSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bootstrapBinding, roles } from '../deploy/managed-bootstrap/binding.mjs';
import { compileBootstrapPlan } from './managed-bootstrap-plan.mjs';
import { createBootstrapServices, bootstrapPlanDigest, bootstrapConfirmation } from './execute-managed-bootstrap.mjs';
import { openBootstrapJournal } from './managed-bootstrap-journal.mjs';

function input() {
  const binding = { format: 1, provider: 'render', region: 'frankfurt', purpose: 'SYNTHETIC_IDENTITY_ONLY',
    bootstrapId: randomUUID(), installationId: 'synthetic', ownerId: 'tea-synthetic', environmentId: 'env-synthetic',
    sourceSha: '1'.repeat(40), expiresAt: new Date(Date.now() + 300000).toISOString(),
    names: Object.fromEntries(roles.map(role => [role, 'charitypilot-review-' + role])) };
  const configuration = { format: 1, binding, image: { url: 'ghcr.io/jasperfordesq-ai/bootstrap@sha256:' + '7'.repeat(64),
    sourceSha: binding.sourceSha, bindingSha256: bootstrapBinding(binding).sha256, platform: 'linux/amd64' } };
  const digest = bootstrapPlanDigest(compileBootstrapPlan(configuration));
  return { format: 1, configuration, expectedPlanSha256: digest, token: 'SYNTHETIC_NOT_FOR_PROVIDER_USE',
    confirmation: bootstrapConfirmation(binding.bootstrapId, digest) };
}
function memoryJournal() {
  const records = new Map();
  return { records, check() {}, append(name, record) { assert.ok(!records.has(name)); records.set(name, structuredClone(record)); } };
}
function response(body, index) {
  return { service: { id: 'srv-' + String(index + 1).repeat(20), name: body.name, ownerId: body.ownerId,
    environmentId: body.environmentId, type: body.type, imagePath: body.image.imagePath, autoDeployTrigger: 'off',
    serviceDetails: { ...body.serviceDetails }, deployHook: 'SYNTHETIC_HOOK_MUST_NOT_BE_RETAINED' },
    deployId: 'dep-' + String(index + 1).repeat(20) };
}
test('original intent is durable before each single POST; response is recorded before next role', async () => {
  const raw = input(), journal = memoryJournal(); let calls = 0;
  const report = await createBootstrapServices(raw, { journal, transport: async (url, options) => {
    assert.equal(url, 'https://api.render.com/v1/services'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer SYNTHETIC_NOT_FOR_PROVIDER_USE');
    const index = calls++; assert.ok(journal.records.has(index + '-intent.json'));
    if (index) assert.ok(journal.records.has((index - 1) + '-response.json'));
    const body = JSON.parse(options.body); raw.configuration.binding.ownerId = 'tea-mutated';
    assert.equal(body.ownerId, 'tea-synthetic'); return Response.json(response(body, index), { status: 201 });
  } });
  assert.equal(calls, 4); assert.equal(report.acknowledgedServices, 4); assert.equal(report.applicationReady, false);
  assert.equal(journal.records.size, 10);
  const retained = JSON.stringify([...journal.records]);
  assert.equal(retained.includes('SYNTHETIC_NOT_FOR_PROVIDER_USE'), false);
  assert.equal(retained.includes('SYNTHETIC_HOOK_MUST_NOT_BE_RETAINED'), false);
});
test('wrong review digest, unconfirmed creation and altered image refuse before journal or HTTP', async () => {
  for (const mutate of [v => { v.expectedPlanSha256 = '0'.repeat(64); }, v => { v.confirmation = 'yes'; },
    v => { v.configuration.image.url = v.configuration.image.url.replace('7'.repeat(64), '8'.repeat(64)); },
    v => { v.extra = true; }]) {
    const raw = input(), journal = memoryJournal(); mutate(raw); let calls = 0;
    await assert.rejects(createBootstrapServices(raw, { journal, transport: async () => { calls++; } }), /unresolved/);
    assert.equal(journal.records.size, 0); assert.equal(calls, 0);
  }
});
test('lost transport acknowledgement, malformed response and HTTP errors stop without retry', async () => {
  for (const mode of ['transport', 'invalid-json', 'http', 'redirect', 'oversize', 'wrong-owner', 'duplicate']) {
    const raw = input(), journal = memoryJournal(); let calls = 0;
    await assert.rejects(createBootstrapServices(raw, { journal, transport: async (_url, options) => {
      const index = calls++;
      if (mode === 'duplicate') return Response.json(response(JSON.parse(options.body), 0), { status: 201 });
      if (mode === 'transport') throw Error('SYNTHETIC_DO_NOT_ECHO');
      if (mode === 'invalid-json') return new Response('not json', { status: 201 });
      if (mode === 'http') return new Response('DO_NOT_RETAIN', { status: 500 });
      if (mode === 'redirect') return Response.redirect('https://foreign.invalid', 302);
      if (mode === 'oversize') return new Response('x'.repeat(65537), { status: 201 });
      const saved = response(JSON.parse(options.body), index); saved.service.ownerId = 'tea-foreign';
      return Response.json(saved, { status: 201 });
    } }), error => {
      assert.equal(error.message.includes('SYNTHETIC_DO_NOT_ECHO'), false);
      assert.equal(error.report.status, 'UNRESOLVED'); assert.equal(error.report.retryAuthorized, false); return true;
    });
    assert.equal(calls, mode === 'duplicate' ? 2 : 1);
    assert.ok(!journal.records.has('complete.json'));
    if (mode === 'wrong-owner') assert.equal(journal.records.get('0-response.json').requestedIdentityMatched, false);
  }
});
test('intent-write failure prevents POST and response-write failure prevents every later POST', async () => {
  for (const failedName of ['0-intent.json', '0-response.json']) for (const lostAck of [false, true]) {
    const journal = memoryJournal(), append = journal.append; let calls = 0;
    journal.append = (name, record) => {
      if (name !== failedName || lostAck) append.call(journal, name, record);
      if (name === failedName) throw Error('synthetic disk lost ACK');
    };
    await assert.rejects(createBootstrapServices(input(), { journal, transport: async (_url, options) => {
      calls++; return Response.json(response(JSON.parse(options.body), 0), { status: 201 });
    } }), /unresolved/);
    assert.equal(calls, failedName === '0-intent.json' ? 0 : 1);
    assert.equal(journal.records.has(failedName), lostAck);
    assert.ok(!journal.records.has('complete.json'));
  }
});
test('expiry after response delivery preserves original IDs but prevents the next dispatch', async t => {
  const raw = input(), journal = memoryJournal(); let calls = 0, now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await assert.rejects(createBootstrapServices(raw, { journal, transport: async (_url, options) => {
    calls++; now += 3600000; return Response.json(response(JSON.parse(options.body), 0), { status: 201 });
  } }), /unresolved/);
  assert.equal(calls, 1); assert.equal(journal.records.get('0-response.json').requestedIdentityMatched, true);
  assert.ok(!journal.records.has('1-intent.json'));
});
test('deadline cancels late and stalled bodies without new requests or late journal writes', async () => {
  for (const mode of ['late', 'body']) {
    const journal = memoryJournal(); let calls = 0, cancelled = 0;
    await assert.rejects(createBootstrapServices(input(), { journal, requestTimeoutMs: 15, transport: async () => {
      calls++;
      if (mode === 'late') await new Promise(resolve => setTimeout(resolve, 40));
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 201 });
    } }), /unresolved/);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(calls, 1); assert.ok(cancelled >= 1); assert.equal(journal.records.size, 2);
  }
});
test('cancellation after an original response preserves its receipt but stops the next role', async () => {
  const journal = memoryJournal(), append = journal.append, controller = new AbortController(); let calls = 0;
  journal.append = (name, record) => { append.call(journal, name, record); if (name === '0-response.json') controller.abort(); };
  await assert.rejects(createBootstrapServices(input(), { journal, signal: controller.signal, transport: async (_url, options) => {
    calls++; return Response.json(response(JSON.parse(options.body), 0), { status: 201 });
  } }), /unresolved/);
  assert.equal(calls, 1); assert.equal(journal.records.get('0-response.json').requestedIdentityMatched, true);
});
const native = process.platform === 'linux' && process.getuid() !== 0;
test('protected journal is exclusive, fsynced, private and refuses reuse, symlinks and broad permissions', { skip: !native }, () => {
  const parent = mkdtempSync(join(tmpdir(), 'charitypilot-bootstrap-journal-')); chmodSync(parent, 0o700);
  let journal;
  try {
    const id = randomUUID(); journal = openBootstrapJournal(parent, id);
    journal.append('operation.json', { synthetic: true });
    assert.throws(() => journal.append('operation.json', {}));
    assert.throws(() => openBootstrapJournal(parent, id));
    assert.equal(lstatSync(join(parent, id, 'operation.json')).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(parent, id, 'operation.json'), 'utf8')), { synthetic: true });
    assert.throws(() => journal.append('../escape.json', {})); journal.close();
    assert.throws(() => journal.check());
    const link = join(parent, 'alias'); symlinkSync(parent, link); assert.throws(() => openBootstrapJournal(link, randomUUID()));
    chmodSync(parent, 0o755); assert.throws(() => openBootstrapJournal(parent, randomUUID())); chmodSync(parent, 0o700);
    const empty = randomUUID(); mkdirSync(join(parent, empty), { mode: 0o700 }); assert.throws(() => openBootstrapJournal(parent, empty));
  } finally { journal?.close(); rmSync(parent, { recursive: true, force: true }); }
});
test('genuine caller SIGKILL leaves its original intent and prevents automatic reuse', { skip: !native, timeout: 10000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'charitypilot-bootstrap-loss-')); chmodSync(parent, 0o700);
  const id = randomUUID(), module = pathToFileURL(join(process.cwd(), 'scripts/managed-bootstrap-journal.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import {openBootstrapJournal} from ${JSON.stringify(module)}; const journal=openBootstrapJournal(process.argv[1],process.argv[2]); journal.append('0-intent.json',{dispatchMayHaveOccurred:true}); console.log('INTENT_SYNCED'); setInterval(()=>{},1000);`, parent, id],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    await Promise.race([once(child.stdout, 'data', { signal: AbortSignal.timeout(3000) }),
      closed.then(() => { throw Error('Synthetic child ended before durable intent'); })]);
    child.kill('SIGKILL');
    const [code, signal] = await closed; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    assert.deepEqual(readdirSync(join(parent, id)), ['0-intent.json']);
    assert.throws(() => openBootstrapJournal(parent, id));
  } finally {
    child.kill('SIGKILL');
    try { await closed; } finally { rmSync(parent, { recursive: true, force: true }); }
  }
});
test('CLI refuses non-execution arguments and oversized stdin before any provider operation', () => {
  for (const [args, body] of [[['--apply'], '{}'], [['--execute', '/unused'], 'x'.repeat(16385)]]) {
    const result = spawnSync(process.execPath, ['scripts/execute-managed-bootstrap.mjs', ...args], { input: body, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /preserve journal/);
  }
  const raw = input();
  const result = spawnSync(process.execPath, ['scripts/execute-managed-bootstrap.mjs', '--review'],
    { input: JSON.stringify(raw.configuration), encoding: 'utf8' });
  assert.equal(result.status, 0);
  const review = JSON.parse(result.stdout);
  assert.equal(review.expectedPlanSha256, raw.expectedPlanSha256);
  assert.equal(review.executionAuthorized, false); assert.equal(review.humanReviewVerified, false);
});
