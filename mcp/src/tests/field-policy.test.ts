import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFieldPolicy, SAFE_FIELDS, WITHHELD_FIELDS } from '../field-policy.js';

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
