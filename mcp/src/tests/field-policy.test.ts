import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFieldPolicy,
  applyShapePolicy,
  SAFE_FIELDS,
  WITHHELD_FIELDS,
} from '../field-policy.js';

const TRUSTEE = {
  id: 'bm1', name: 'A Trustee', role: 'Chair', appointedDate: '2024-01-01',
  isActive: true, conductSigned: true, inductionCompleted: true,
  email: 'a@b.ie', dateOfBirth: '1970-01-01', residentialAddress: '1 Main St',
  formerNames: 'Old Name', otherDirectorships: 'Other CLG',
};

test('withheld board-member fields are removed by default', () => {
  const out = applyFieldPolicy('BoardMember', TRUSTEE, false) as Record<string, unknown>;
  for (const field of ['dateOfBirth', 'residentialAddress', 'formerNames', 'otherDirectorships', 'email']) {
    assert.ok(!(field in out), `${field} must be withheld`);
  }
});

test('safe board-member fields survive', () => {
  const out = applyFieldPolicy('BoardMember', TRUSTEE, false) as Record<string, unknown>;
  assert.equal(out.name, 'A Trustee');
  assert.equal(out.role, 'Chair');
  assert.equal(out.conductSigned, true);
});

test('the gate returns everything when allowed', () => {
  assert.deepEqual(applyFieldPolicy('BoardMember', TRUSTEE, true), TRUSTEE);
});

test('it is an allowlist: an unknown field is dropped, not passed through', () => {
  const withNewColumn = { ...TRUSTEE, someFutureSensitiveColumn: 'leak' };
  const out = applyFieldPolicy('BoardMember', withNewColumn, false) as Record<string, unknown>;
  assert.ok(!('someFutureSensitiveColumn' in out),
    'a column nobody classified must be withheld, not leaked');
});

test('arrays are filtered element by element', () => {
  const out = applyFieldPolicy('BoardMember', [TRUSTEE, TRUSTEE], false) as Record<string, unknown>[];
  assert.equal(out.length, 2);
  assert.ok(!('dateOfBirth' in out[0]!));
});

test('complaint content is withheld but its compliance shape survives', () => {
  const complaint = {
    id: 'c1', status: 'OPEN', receivedDate: '2026-01-01', reviewedByBoard: true,
    boardMinuteReference: 'M-12', summary: 'allegation about a named person',
    source: 'anonymous', actionTaken: 'investigated', outcome: 'upheld',
  };
  const out = applyFieldPolicy('ComplaintRecord', complaint, false) as Record<string, unknown>;
  assert.equal(out.reviewedByBoard, true);
  assert.equal(out.status, 'OPEN');
  for (const field of ['summary', 'source', 'actionTaken', 'outcome']) {
    assert.ok(!(field in out), `${field} must be withheld`);
  }
});

test('conflict content is withheld but its compliance shape survives', () => {
  const conflict = {
    id: 'cr1', status: 'DECLARED', dateDeclared: '2026-01-01', meetingDate: '2026-02-01',
    nextReviewDate: '2027-01-01', minuteReference: 'M-9',
    trusteeName: 'A Trustee', matter: 'supplier', nature: 'family interest',
    actionTaken: 'recused', decision: 'noted',
  };
  const out = applyFieldPolicy('ConflictRecord', conflict, false) as Record<string, unknown>;
  assert.equal(out.minuteReference, 'M-9');
  for (const field of ['trusteeName', 'matter', 'nature', 'actionTaken', 'decision']) {
    assert.ok(!(field in out), `${field} must be withheld`);
  }
});

test('the conflicts register cannot be joined back to a named trustee', () => {
  const conflict = {
    id: 'cr1', organisationId: 'o1', boardMemberId: 'bm1', status: 'DECLARED',
    dateDeclared: '2026-01-01', minuteReference: 'M-9',
    trusteeName: 'A Trustee', matter: 'supplier', nature: 'family interest',
    actionTaken: 'recused', decision: 'noted',
  };
  const out = applyFieldPolicy('ConflictRecord', conflict, false) as Record<string, unknown>;
  assert.ok(!('trusteeName' in out), 'the name must be withheld');
  assert.ok(!('boardMemberId' in out),
    'the join key must be withheld too, or the name can be recovered from the board register');
  assert.equal(out.status, 'DECLARED', 'the compliance shape must survive');
  assert.equal(out.minuteReference, 'M-9');
});

test('a nested relation array is dropped, not passed through unfiltered', () => {
  const trustee = {
    id: 'bm1', name: 'A Trustee', role: 'Chair',
    conflictRecords: [{ trusteeName: 'A Trustee', nature: 'family interest' }],
  };
  const out = applyFieldPolicy('BoardMember', trustee, false) as Record<string, unknown>;
  assert.ok(!('conflictRecords' in out),
    'an unknown key carrying nested personal data must not survive');
});

test('a paginated envelope keeps its pagination fields and filters the records inside data', () => {
  const envelope = {
    data: [TRUSTEE, { ...TRUSTEE, id: 'bm2', name: 'B Trustee' }],
    total: 2, page: 1, pageSize: 50, hasMore: false,
  };
  const out = applyFieldPolicy('BoardMember', envelope, false) as typeof envelope;

  assert.equal(out.total, 2);
  assert.equal(out.page, 1);
  assert.equal(out.pageSize, 50);
  assert.equal(out.hasMore, false);
  assert.equal(out.data.length, 2);
  for (const record of out.data as unknown as Record<string, unknown>[]) {
    assert.ok(!('dateOfBirth' in record), 'records inside the envelope must still be filtered');
  }
});

test('a bare { data: [...] } envelope (no pagination fields) is handled the same way', () => {
  const envelope = { data: [TRUSTEE] };
  const out = applyFieldPolicy('BoardMember', envelope, false) as typeof envelope;
  assert.equal(out.data.length, 1);
  assert.ok(!('dateOfBirth' in (out.data[0] as unknown as Record<string, unknown>)));
});

test('an envelope is returned whole when the gate is open', () => {
  const envelope = { data: [TRUSTEE], total: 1, page: 1, pageSize: 50, hasMore: false };
  assert.deepEqual(applyFieldPolicy('BoardMember', envelope, true), envelope);
});

test('a record that itself carries an array-valued data field is still fully filtered, not mistaken for a nested envelope', () => {
  // A future `data Json[]` column on BoardMember would put a `data` key on every
  // record the API returns nested inside the real envelope's own `data` array.
  // Envelope detection must not re-fire on that inner record: if it did, the
  // record's other fields (including dateOfBirth and residentialAddress) would be
  // spread through untouched instead of going through the allowlist.
  const poisoned = {
    id: 'bm1', name: 'A Trustee', dateOfBirth: '1970-01-01',
    residentialAddress: '1 Main St', email: 'a@b.ie', data: [],
  };
  const envelope = { data: [poisoned], total: 1, page: 1, pageSize: 50, hasMore: false };
  const out = applyFieldPolicy('BoardMember', envelope, false) as typeof envelope;

  assert.equal(out.data.length, 1);
  const record = out.data[0] as unknown as Record<string, unknown>;
  assert.equal(record.id, 'bm1');
  assert.equal(record.name, 'A Trustee');
  for (const field of ['dateOfBirth', 'residentialAddress', 'email', 'data']) {
    assert.ok(!(field in record), `${field} must be withheld — the record must not be treated as an envelope`);
  }
});

test('an unexpected envelope sibling key carrying personal data does not survive the gate', () => {
  const envelope = {
    data: [TRUSTEE],
    total: 1, page: 1, pageSize: 50, hasMore: false,
    pendingInvites: [{ name: 'Invitee', email: 'invitee@example.ie', dateOfBirth: '1990-01-01' }],
    summary: { chairDateOfBirth: '1960-01-01' },
  };
  const out = applyFieldPolicy('BoardMember', envelope, false) as Record<string, unknown>;

  assert.ok(!('pendingInvites' in out), 'an unallowlisted envelope sibling must not survive');
  assert.ok(!('summary' in out), 'an unallowlisted envelope sibling must not survive');
  assert.equal(out.total, 1);
  assert.equal(out.page, 1);
  assert.equal(out.pageSize, 50);
  assert.equal(out.hasMore, false);
  assert.equal((out.data as unknown[]).length, 1);
});

test('a single-record envelope { data: {...} } is filtered as one record, not emptied', () => {
  const envelope = { data: TRUSTEE };
  const out = applyFieldPolicy('BoardMember', envelope, false) as { data: Record<string, unknown> };

  assert.equal(out.data.id, 'bm1');
  assert.equal(out.data.name, 'A Trustee');
  for (const field of ['dateOfBirth', 'residentialAddress', 'email', 'formerNames', 'otherDirectorships']) {
    assert.ok(!(field in out.data), `${field} must be withheld`);
  }
});

test('a single-record envelope is returned whole when the gate is open', () => {
  const envelope = { data: TRUSTEE };
  assert.deepEqual(applyFieldPolicy('BoardMember', envelope, true), envelope);
});

test('GoverningAct: notes and the resolutions relation are withheld, the act itself survives', () => {
  const act = {
    id: 'ga1', organisationId: 'o1', kind: 'BOARD_MEETING', status: 'APPROVED',
    actDate: '2026-01-01', reference: 'M-1', title: 'January board meeting',
    statutoryBasis: 'Companies Act 2014 s.225', notes: 'sensitive narrative',
    resolutions: [{ id: 'r1', text: 'text', abstentions: 'A B', conflictRecordId: 'cr1' }],
  };
  const out = applyFieldPolicy('GoverningAct', act, false) as Record<string, unknown>;

  assert.equal(out.id, 'ga1');
  assert.equal(out.reference, 'M-1');
  assert.equal(out.statutoryBasis, 'Companies Act 2014 s.225');
  assert.ok(!('notes' in out), 'free-text notes must be withheld');
  assert.ok(!('resolutions' in out), 'the resolutions relation must be dropped by the allowlist');
});

test('GoverningAct inside a { data: [...] } envelope is filtered per-record', () => {
  const act = {
    id: 'ga1', reference: 'M-1', notes: 'sensitive',
    resolutions: [{ id: 'r1', text: 'text', conflictRecordId: 'cr1' }],
  };
  const out = applyFieldPolicy('GoverningAct', { data: [act] }, false) as { data: Record<string, unknown>[] };
  assert.equal(out.data[0]!.reference, 'M-1');
  assert.ok(!('notes' in out.data[0]!));
  assert.ok(!('resolutions' in out.data[0]!));
});

test('safe and withheld lists never overlap', () => {
  for (const model of Object.keys(SAFE_FIELDS) as (keyof typeof SAFE_FIELDS)[]) {
    const overlap = SAFE_FIELDS[model].filter((f) => WITHHELD_FIELDS[model].includes(f));
    assert.deepEqual(overlap, [], `${model} classifies a field both ways`);
  }
});

/* --- shapes: the payloads that mix models ------------------------------- */

test('the dashboard withholds interpolated free text and unlisted deadline columns', () => {
  const raw = {
    data: {
      compliance: { overallPercent: 42 },
      upcomingDeadlines: [
        {
          id: 'd1', title: 'File the B1', dueDate: '2026-09-30',
          description: 'ask Aoife about this', generationInputs: { profile: 'x' },
          isComplete: false,
        },
      ],
      boardAlerts: [
        { memberId: 'b1', memberName: 'Aoife Chairperson', alertType: 'conduct_unsigned' },
      ],
      recentActivity: [
        {
          id: 'board-member-b1', type: 'board_member',
          timestamp: '2026-03-02T00:00:00.000Z',
          description: "Updated board member 'Aoife Chairperson'",
          userId: 'u1', userName: 'Staff Person',
        },
      ],
    },
  };

  const filtered = applyShapePolicy('dashboard', raw, false) as {
    data: {
      compliance: { overallPercent: number };
      upcomingDeadlines: Record<string, unknown>[];
      recentActivity: Record<string, unknown>[];
    };
  };

  assert.equal(filtered.data.compliance.overallPercent, 42, 'aggregate figures survive');
  assert.equal(filtered.data.upcomingDeadlines[0]!.title, 'File the B1');
  assert.ok(
    !('generationInputs' in filtered.data.upcomingDeadlines[0]!),
    'an unlisted deadline column must be dropped',
  );
  assert.ok(
    !('description' in filtered.data.upcomingDeadlines[0]!),
    'deadline free text is withheld',
  );

  const serialised = JSON.stringify(filtered);
  assert.ok(!serialised.includes('Staff Person'), 'a staff name must not survive the closed gate');
  assert.ok(
    !serialised.includes('Updated board member'),
    'free text assembled by interpolation must not survive',
  );
  assert.ok(serialised.includes('conduct_unsigned'), 'the alert type is the useful part and survives');
  assert.ok(
    serialised.includes('Aoife Chairperson'),
    'a trustee name survives, because BoardMember.name is classified safe',
  );
});

test('the dashboard returns everything when the gate is open', () => {
  const raw = {
    data: {
      compliance: {}, upcomingDeadlines: [], boardAlerts: [],
      recentActivity: [{ description: 'Updated a board member', userName: 'Staff Person' }],
    },
  };
  const filtered = applyShapePolicy('dashboard', raw, true) as {
    data: { recentActivity: { userName: string }[] };
  };
  assert.equal(filtered.data.recentActivity[0]!.userName, 'Staff Person');
});

test('the team payload filters members and invites by their own models', () => {
  const raw = {
    members: [
      { id: 'u1', email: 'a@b.test', name: 'Staff Person', role: 'ADMIN', activeSessionCount: 2 },
    ],
    invites: [
      {
        id: 'i1', email: 'new@b.test', role: 'MEMBER',
        invitedByName: 'Staff Person', token: 'invite-secret',
      },
    ],
  };
  const filtered = applyShapePolicy('team', raw, false);
  const closed = JSON.stringify(filtered);

  assert.ok(!closed.includes('Staff Person'), 'staff names are withheld');
  assert.ok(!closed.includes('a@b.test'), 'account emails are withheld');
  assert.ok(!closed.includes('invite-secret'), 'an invite token is a credential and must never pass');
  assert.ok(closed.includes('ADMIN'), 'the role is the governance-relevant part and survives');
  assert.equal(
    (filtered as { members: { activeSessionCount?: number }[] }).members[0]!.activeSessionCount,
    2,
    'a session count is an aggregate, not personal data',
  );
});

test('a void withholds the snapshot blob, which an allowlist cannot see inside', () => {
  const raw = {
    data: [{
      id: 'v1', organisationId: 'o1', reference: 'BM-1', kind: 'BOARD_MEETING',
      status: 'SUPERSEDED', actDate: '2026-01-01', voidedAt: '2026-03-02',
      title: 'Removal of a named trustee',
      voidedByEmail: 'owner@example.org', reason: 'duplicate of BM-2',
      snapshot: { title: 'Removal of a named trustee', resolutions: [{ text: 'Jane Doe removed' }] },
    }],
  };
  const closed = JSON.stringify(applyFieldPolicy('GoverningActVoid', raw, false));

  assert.ok(!closed.includes('Jane Doe'), 'the opaque blob must not pass the closed gate');
  assert.ok(!closed.includes('owner@example.org'), 'the voiding operator is withheld');
  assert.ok(!closed.includes('duplicate of BM-2'), 'the free-text reason is withheld');
  assert.ok(closed.includes('BM-1'), 'the reference survives so the void is still traceable');
});

test('board submissions filter three nested models at three depths', () => {
  const raw = {
    data: {
      evidenced: [{
        id: 'doc1', name: 'Minutes March 2026', category: 'BOARD_MINUTES',
        owner: 'Aoife Chairperson', description: 'signed copy', evidenced: true,
        resolution: {
          id: 'r1', itemNumber: '4.2', text: 'RESOLVED that Jane Doe be removed',
          abstentions: 'Jane Doe', carried: true,
          governingAct: { id: 'ga1', reference: 'BM-1', title: 'Board meeting', notes: 'private note' },
        },
      }],
      outstanding: { notEvidenced: [], notSubmitted: [] },
    },
  };
  const filtered = applyShapePolicy('boardSubmissions', raw, false);
  const closed = JSON.stringify(filtered);

  assert.ok(closed.includes('Minutes March 2026'), 'the document name survives');
  assert.ok(closed.includes('4.2'), 'the resolution item number survives');
  assert.ok(closed.includes('BM-1'), 'the act reference survives at the third level');
  assert.ok(!closed.includes('Jane Doe'), 'resolution text and abstentions are withheld');
  assert.ok(!closed.includes('signed copy'), 'document free text is withheld');
  assert.ok(!closed.includes('Aoife Chairperson'), 'the document owner is withheld');
  assert.ok(!closed.includes('private note'), 'the act notes are withheld even when nested');
});

test('the signoff keeps its approval summaries, which carry only hashes and dates', () => {
  const raw = {
    data: {
      id: 's1', organisationId: 'o1', reportingYear: 2026, status: 'APPROVED',
      approvedByName: 'Aoife Chairperson', approvalNotes: 'agreed at the March meeting',
      currentApproval: {
        id: 'a1', approvalSequence: 3, evidenceHash: 'abc', snapshotHash: 'def',
        approvedAt: '2026-03-02', createdByName: 'Aoife Chairperson',
      },
      latestApproval: null,
    },
  };
  const filtered = applyShapePolicy('complianceSignoff', raw, false) as {
    data: { currentApproval: Record<string, unknown>; latestApproval: unknown };
  };
  const closed = JSON.stringify(filtered);

  assert.ok(
    !closed.includes('Aoife Chairperson'),
    'the approver is withheld, including inside the summary',
  );
  assert.ok(!closed.includes('agreed at the March meeting'), 'approval notes are withheld');
  assert.equal(filtered.data.currentApproval.evidenceHash, 'abc', 'the evidence hash survives');
  assert.equal(filtered.data.currentApproval.approvalSequence, 3);
  assert.equal(
    filtered.data.latestApproval,
    null,
    'an absent approval stays null rather than becoming an empty object',
  );
});

test('an unknown shape fails closed rather than returning the payload raw', () => {
  assert.throws(
    () => applyShapePolicy('nope' as never, { data: { secret: 1 } }, false),
    /unknown response shape/i,
  );
});
