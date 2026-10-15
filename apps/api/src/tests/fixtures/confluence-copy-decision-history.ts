import { createHash } from 'node:crypto';
import { RecoveryAuthorityJournal } from '../../services/recovery-authority-journal.js';
import { readConfluenceCopyDecisionHistory } from '../../services/confluence-copy-decision-history.js';
import { prepareConfluenceCopyRecoveryFacts } from '../../services/confluence-copy-recovery-facts.js';
import { sealConfluenceCopyRecoveryFacts } from '../../services/confluence-copy-recovery-envelope.js';
import type { RecoveryControlValue } from '../../services/recovery-operation-reservation.js';
import type { RecoveryDataKeys } from '../../services/recovery-preparation-envelope.js';
import { recoveryFactsFixture, recoveryContextFixture as context } from './confluence-copy-recovery-facts.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function states() {
  const first = recoveryFactsFixture(), second = recoveryFactsFixture();
  second.operationId = 'state-2'; second.factsRevision = 2;
  second.previousFactsDigest = prepareConfluenceCopyRecoveryFacts(first).digest;
  second.capturedAt = '2026-10-15T18:07:00.000Z';
  second.permissionWithdrawal = { id: 'pw-a', organisationId: 'org-a', permissionId: 'permission-a',
    actorUserId: 'owner-a', evidenceRef: 'C01-WITHDRAW', reason: 'Withdraw the exact synthetic permission', occurredAt: '2026-10-15T18:06:00.000Z' };
  second.reviewWithdrawal = { id: 'rw-a', organisationId: 'org-a', reviewId: 'review-a', actorUserId: 'owner-a',
    evidenceRef: 'C01-WITHDRAW', reason: 'Withdraw the exact synthetic review', occurredAt: '2026-10-15T18:06:00.000Z' };
  return [first,second];
}

export async function fixture(values = states(), kind = 'CONFLUENCE_COPY_DECISION_STATE_V1') {
  const entries = new Map<string,string>(), objects = new Map<string,string>();
  const keys: RecoveryDataKeys = {
    generate: async supplied => ({ key: Buffer.alloc(32,7), keyId: supplied.keyId, wrappedKey: Buffer.from('synthetic-key').toString('base64') }),
    unwrap: async (_wrapped,supplied) => ({ key: Buffer.alloc(32,7), keyId: supplied.keyId }),
  };
  let previousDigest: string | null = null;
  for (const [index,value] of values.entries()) {
    const facts = prepareConfluenceCopyRecoveryFacts(value);
    const envelope = await sealConfluenceCopyRecoveryFacts(facts.body,{ ...context, operationId: value.operationId },keys);
    objects.set(value.operationId,envelope.envelope);
    // Already-existing synthetic published history. This does not simulate or
    // authorise reservation release; publisher/control joining is tested elsewhere.
    const unsigned = { format: 1, installationId: context.installationId, organisationId: context.organisationId,
      generation: index + 1, previousDigest, operationId: value.operationId, kind, factsDigest: envelope.digest };
    const digest = hash(JSON.stringify(unsigned));
    entries.set(`authority/${context.installationId}/${context.organisationId}/${String(index + 1).padStart(10,'0')}.json`,JSON.stringify({ ...unsigned, digest }));
    previousDigest = digest;
  }
  const state = { current: { format: 2, installationId: context.installationId, organisationId: context.organisationId,
    writerId: 'writer-a', writerEpoch: 1, generation: values.length, digest: previousDigest,
    activeOperation: null, revision: 'synthetic-live-revision' } as RecoveryControlValue & { revision: string } };
  const control = { readControl: async () => structuredClone(state.current), compareAndSwapControl: async () => { throw new Error('Read-only verification must never write control'); } };
  const journal = new RecoveryAuthorityJournal({ read: async key => entries.get(key) ?? null,
    create: async () => { throw new Error('Read-only verification must never write journal'); } },
    { installationId: context.installationId, organisationId: context.organisationId },
    { installationId: context.installationId, organisationId: context.organisationId, generation: 0, digest: null });
  const store = { readConfluenceCopyState: async (id: string) => objects.get(id) ?? null };
  const read = (local: { body: string; digest: string }[] = [], allowed = [context.keyId]) =>
    readConfluenceCopyDecisionHistory(journal,control,keys,store,allowed,local);
  return { read, entries, objects, state, keys, journal, control, values };
}
