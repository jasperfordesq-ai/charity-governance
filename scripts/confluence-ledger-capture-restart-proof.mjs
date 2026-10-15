import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { ConfluenceCopyLedgerCaptureStore } from '../apps/api/dist/services/confluence-copy-ledger-capture-store.js';
import { ConfluenceCopyLedgerCandidateStore } from '../apps/api/dist/services/confluence-copy-ledger-candidate-store.js';

// Test child only: refuse ambient/real databases before creating a client.
assert.equal(process.env.CHARITYPILOT_SYNTHETIC_LEDGER_CAPTURE_PROOF,'1');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.protocol,'postgresql:'); assert.equal(url.hostname,'127.0.0.1');
assert.equal(url.username,'synthetic_ledger_runtime');
assert.match(url.pathname,/^\/copy_ledger_[a-f0-9]{32}$/); assert.equal(url.search,'');
assert.ok(Number(url.port) > 0 && Number(url.port) < 65536);
const input = JSON.parse(process.env.CHARITYPILOT_SYNTHETIC_LEDGER_CAPTURE_INPUT);
const prisma = new PrismaClient();
try {
  if (process.env.CHARITYPILOT_SYNTHETIC_LEDGER_CANDIDATE_ID) {
    const result = await new ConfluenceCopyLedgerCandidateStore(prisma).prepare('org-a','owner-a',
      process.env.CHARITYPILOT_SYNTHETIC_LEDGER_CANDIDATE_ID,{
        generate: async () => { throw new Error('Restart must never generate a new key'); },
        unwrap: async (_wrappedKey,context) => ({ key: Buffer.alloc(32,7), keyId: context.keyId }),
      });
    const progress = await prisma.confluenceCopyLedgerProgress.findMany({ where: { candidateId: result.id, organisationId: 'org-a' },
      select: { id: true, stage: true }, orderBy: { id: 'asc' } });
    process.stdout.write(JSON.stringify({ id: result.id, candidate: result.candidate, replayed: result.replayed, progress }));
  } else {
  const result = await new ConfluenceCopyLedgerCaptureStore(prisma).prepare('org-a','owner-a',input);
  process.stdout.write(JSON.stringify({ id: result.id, body: result.body, digest: result.digest, replayed: result.replayed }));
  }
} finally { await prisma.$disconnect(); }
