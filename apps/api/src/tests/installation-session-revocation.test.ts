import assert from 'node:assert/strict';
import test from 'node:test';
import { revokeInstallationSessions,
  validateRevocationReason } from '../services/installation-session-revocation.js';
import { parseRevokeAllSessionsArgs } from '../jobs/revoke-all-sessions.js';
import { AppError } from '../utils/errors.js';

const NOW = new Date('2026-10-11T09:00:00.000Z');
const LATER = new Date('2026-10-12T09:00:00.000Z');
const EARLIER = new Date('2026-10-10T09:00:00.000Z');
const REASON = 'Suspected JWT_SECRET exposure; secret rotated 11 October';

type Session = { id: string; userId: string; revokedAt: Date | null; revocationReason: string | null; expiresAt: Date };
type OperatorSession = { id: string; revokedAt: Date | null; expiresAt: Date };

function live(row: { revokedAt: Date | null; expiresAt: Date }, where: { expiresAt: { gt: Date } }) {
  return row.revokedAt === null && row.expiresAt.getTime() > where.expiresAt.gt.getTime();
}

function store() {
  const users = [
    { id: 'u-a1', organisationId: 'org-a', name: 'Aoife Trustee', email: 'aoife@example.org' },
    { id: 'u-a2', organisationId: 'org-a', name: '', email: 'second@example.org' },
    { id: 'u-b1', organisationId: 'org-b', name: 'Bríd\u0007 Treasurer', email: 'brid@example.org' },
    { id: 'u-c1', organisationId: 'org-c', name: 'No Sessions', email: 'none@example.org' },
  ];
  const sessions: Session[] = [
    { id: 's1', userId: 'u-a1', revokedAt: null, revocationReason: null, expiresAt: LATER },
    { id: 's2', userId: 'u-a1', revokedAt: null, revocationReason: null, expiresAt: LATER },
    { id: 's3', userId: 'u-a2', revokedAt: null, revocationReason: null, expiresAt: LATER },
    { id: 's4', userId: 'u-b1', revokedAt: null, revocationReason: null, expiresAt: LATER },
    // Already revoked and already expired sessions are left as they are.
    { id: 's5', userId: 'u-c1', revokedAt: EARLIER, revocationReason: 'LOGOUT', expiresAt: LATER },
    { id: 's6', userId: 'u-c1', revokedAt: null, revocationReason: null, expiresAt: EARLIER },
  ];
  const operatorSessions: OperatorSession[] = [
    { id: 'o1', revokedAt: null, expiresAt: LATER },
    { id: 'o2', revokedAt: null, expiresAt: EARLIER },
    { id: 'o3', revokedAt: EARLIER, expiresAt: LATER },
  ];
  const audit: Array<Record<string, unknown>> = [];
  const tx = {
    authSession: {
      findMany: async ({ where }: { where: { expiresAt: { gt: Date } } }) =>
        sessions.filter((s) => live(s, where)).map((s) => ({ userId: s.userId })),
      updateManyAndReturn: async ({ where, data }: { where: { expiresAt: { gt: Date } };
        data: { revokedAt: Date; revocationReason: string } }) => {
        const hit = sessions.filter((s) => live(s, where));
        for (const s of hit) Object.assign(s, data);
        return hit.map((s) => ({ userId: s.userId }));
      },
    },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        users.filter((u) => where.id.in.includes(u.id)),
    },
    securityAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => { audit.push(data); return data; },
    },
    platformOperatorSession: {
      count: async ({ where }: { where: { expiresAt: { gt: Date } } }) =>
        operatorSessions.filter((s) => live(s, where)).length,
      updateMany: async ({ where, data }: { where: { expiresAt: { gt: Date } }; data: { revokedAt: Date } }) => {
        const hit = operatorSessions.filter((s) => live(s, where));
        for (const s of hit) Object.assign(s, data);
        return { count: hit.length };
      },
    },
  };
  const client = { $transaction: async <T>(run: (t: typeof tx) => Promise<T>) => run(tx) };
  return { client: client as never, sessions, operatorSessions, audit };
}

const code = (expected: string) => (error: unknown) => error instanceof AppError && error.code === expected;

test('without --confirm nothing is written; the counts are what a confirmed run would revoke', async () => {
  const s = store();
  const before = JSON.stringify([s.sessions, s.operatorSessions]);
  const result = await revokeInstallationSessions(s.client, { realm: 'all', reason: REASON, confirm: false, now: NOW });
  assert.deepEqual(result, { confirmed: false, realm: 'all', userSessions: 4, members: 3, charities: 2,
    operatorSessions: 1, revokedAt: null });
  assert.equal(JSON.stringify([s.sessions, s.operatorSessions]), before);
  assert.equal(s.audit.length, 0);
});

test('a confirmed run revokes every live charity session and records one event per member in their charity', async () => {
  const s = store();
  const result = await revokeInstallationSessions(s.client, { realm: 'user', reason: REASON, confirm: true, now: NOW });
  assert.deepEqual([result.userSessions, result.members, result.charities, result.operatorSessions, result.revokedAt],
    [4, 3, 2, 0, NOW.toISOString()]);
  for (const id of ['s1', 's2', 's3', 's4']) {
    const row = s.sessions.find((x) => x.id === id)!;
    assert.deepEqual([row.revokedAt, row.revocationReason], [NOW, 'INSTALLATION_SESSIONS_REVOKED'], id);
  }
  assert.deepEqual(s.sessions.find((x) => x.id === 's5')!.revocationReason, 'LOGOUT', 'an earlier revocation is kept');
  assert.equal(s.sessions.find((x) => x.id === 's6')!.revokedAt, null, 'an expired session is left alone');
  assert.ok(s.operatorSessions.every((o) => o.id !== 'o1' || o.revokedAt === null), 'user realm leaves operators');
  assert.deepEqual(s.audit.map((e) => [e.organisationId, e.subjectUserId, e.subjectLabel,
    (e.context as { revokedSessionCount: number }).revokedSessionCount]), [
    ['org-a', 'u-a1', 'Aoife Trustee', 2],
    ['org-a', 'u-a2', 'second@example.org', 1],
    ['org-b', 'u-b1', 'Bríd  Treasurer', 1],
  ]);
  for (const event of s.audit) {
    assert.deepEqual([event.type, event.actorKind, event.actorLabel, event.reason, 'actorUserId' in event],
      ['ALL_SESSIONS_REVOKED', 'SYSTEM', 'Installation operator', REASON, false]);
    assert.deepEqual(event.context, { scope: 'INSTALLATION', revokedSessionCount: event.subjectUserId === 'u-a1' ? 2 : 1 });
  }
  const again = await revokeInstallationSessions(s.client, { realm: 'user', reason: REASON, confirm: true, now: NOW });
  assert.deepEqual([again.userSessions, again.members], [0, 0], 'a repeat finds nothing left');
  assert.equal(s.audit.length, 3);
});

test('the operator realm revokes only live operator sessions and writes no charity event', async () => {
  const s = store();
  const result = await revokeInstallationSessions(s.client, { realm: 'operator', reason: REASON, confirm: true, now: NOW });
  assert.deepEqual([result.operatorSessions, result.userSessions, result.members], [1, 0, 0]);
  assert.deepEqual(s.operatorSessions.map((o) => o.revokedAt), [NOW, null, EARLIER]);
  assert.ok(s.sessions.slice(0, 4).every((x) => x.revokedAt === null));
  assert.equal(s.audit.length, 0);
});

test('a revocation needs a plain, meaningful reason, because every affected charity sees it', async () => {
  for (const reason of ['', 'too short', '   short   ','line one\nline two of the reason',
    'x'.repeat(501)]) {
    assert.throws(() => validateRevocationReason(reason), code('SESSION_REVOCATION_REASON_INVALID'), JSON.stringify(reason));
  }
  assert.equal(validateRevocationReason(REASON), REASON);
  assert.equal(validateRevocationReason(`  ${REASON}  `), REASON, 'surrounding spaces are trimmed');
  const s = store();
  await assert.rejects(revokeInstallationSessions(s.client, { realm: 'all', reason: 'short', confirm: true, now: NOW }),
    code('SESSION_REVOCATION_REASON_INVALID'));
  assert.ok(s.sessions.slice(0, 4).every((x) => x.revokedAt === null));
});

test('the command takes a realm, a required reason and an explicit --confirm, and nothing else', () => {
  assert.deepEqual(parseRevokeAllSessionsArgs(['user', '--reason', REASON]), { realm: 'user', reason: REASON, confirm: false });
  assert.deepEqual(parseRevokeAllSessionsArgs(['all', '--confirm', '--reason', REASON]),
    { realm: 'all', reason: REASON, confirm: true });
  for (const argv of [[], ['users', '--reason', REASON], ['user'], ['user', '--confirm'], ['user', '--reason'],
    ['user', '--reason', '--confirm'], ['user', '--reason', REASON, '--reason', REASON],
    ['user', '--reason', REASON, '--confirm', '--confirm'], ['user', '--reason', REASON, '--yes'],
    ['user', '--reason', REASON, 'extra']]) {
    assert.throws(() => parseRevokeAllSessionsArgs(argv), Error, argv.join(' '));
  }
});
