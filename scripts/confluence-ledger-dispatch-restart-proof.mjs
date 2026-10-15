import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { ConfluenceCopyLedgerDispatcher } from '../apps/api/dist/services/confluence-copy-ledger-dispatcher.js';
import { RecoveryAuthorityJournal } from '../apps/api/dist/services/recovery-authority-journal.js';

// Synthetic child only. Do not accept ambient VM or provider credentials.
assert.equal(process.env.CHARITYPILOT_SYNTHETIC_LEDGER_CAPTURE_PROOF,'1');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.protocol,'postgresql:'); assert.equal(url.hostname,'127.0.0.1');
assert.equal(url.username,'synthetic_ledger_runtime'); assert.equal(url.search,'');
assert.match(url.pathname,/^\/copy_ledger_[a-f0-9]{32}$/);
assert.ok(Number(url.port) > 0 && Number(url.port) < 65536);
const inputText = readFileSync(0,'utf8'); assert.ok(Buffer.byteLength(inputText) <= 2 * 1024 * 1024);
const input = JSON.parse(inputText);
assert.ok(['PUT','HEAD','ACK','NONE'].includes(input.failure));
const prisma = new PrismaClient();
try {
  const candidate = await prisma.confluenceCopyLedgerCandidate.findFirstOrThrow({
    where: { id: input.candidateId, organisationId: 'org-a' }, include: { capture: true } });
  const context = candidate.capture.context, identity = { installationId: context.installationId, organisationId: 'org-a' };
  const external = input.external, rows = new Map(external.rows);
  const control = { readControl: async () => structuredClone(external.control),
    compareAndSwapControl: async (revision,next) => {
      if (revision !== external.control.revision) return false;
      external.control = { ...next, revision: `dispatch-${++external.version}` };
      if (input.failure === 'HEAD' && next.generation === 1) throw new Error('Synthetic committed head response lost');
      return true;
    }, releaseConfluenceCopyLedgerControl: async (revision) => {
      if (revision !== external.control.revision) return false;
      external.releases++; external.control = { ...external.control, activeOperation: null, revision: `dispatch-${++external.version}` };
      if (input.failure === 'ACK') throw new Error('Synthetic committed acknowledgement response lost');
      return true;
    } };
  const objects = { readConfluenceCopyLedger: async id => id === context.operationId ? external.envelope : null,
    createConfluenceCopyLedger: async (id,envelope) => {
      assert.equal(id,context.operationId); external.puts++;
      if (external.envelope !== null) return false;
      external.envelope = envelope;
      if (input.failure === 'PUT') throw new Error('Synthetic committed upload response lost');
      return true;
    } };
  const journal = new RecoveryAuthorityJournal({ read: async key => rows.get(key) ?? null,
    create: async (key,body) => { if (rows.has(key)) return false; rows.set(key,body); return true; } },
    identity,{ ...identity, generation: 0, digest: null });
  const keys = { generate: async () => { throw new Error('Dispatcher must not generate keys'); },
    unwrap: async () => ({ key: Buffer.alloc(32,7), keyId: context.keyId }) };
  let status, result;
  try {
    result = await new ConfluenceCopyLedgerDispatcher(prisma).resume('org-a','owner-a',candidate.id,{ journal,control,objects,keys });
    status = 'ACKNOWLEDGED';
  } catch (error) {
    assert.equal(error.message,'Confluence ledger metadata dispatch is unresolved; retain the original candidate and reconcile its attempt');
    status = 'UNRESOLVED';
  }
  process.stdout.write(JSON.stringify({ status, result, external: { ...external, rows: [...rows] } }));
} finally { await prisma.$disconnect(); }
