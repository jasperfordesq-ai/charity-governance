import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  changedValueNeedsConfirmation,
  confirmationCorrectionValue,
} from './confirmation-correction';

test('confirmation corrections preserve explicit false patches', () => {
  assert.equal(
    confirmationCorrectionValue('CLG', 'CLG', false, '2026-07-10T12:00:00.000Z'),
    false,
  );
  assert.equal(
    confirmationCorrectionValue('2026-09-30', '2026-09-30', false, '2026-07-10T12:00:00.000Z'),
    false,
  );
  assert.equal(confirmationCorrectionValue('CLG', 'CLG', true, null), true);
  assert.equal(
    confirmationCorrectionValue('CLG', 'CLG', true, '2026-07-10T12:00:00.000Z'),
    undefined,
  );
});

test('a changed fact still requires confirmation while an unchanged fact can be unconfirmed', () => {
  assert.equal(changedValueNeedsConfirmation('OTHER', 'CLG', false), true);
  assert.equal(changedValueNeedsConfirmation('OTHER', 'CLG', true), false);
  assert.equal(changedValueNeedsConfirmation('CLG', 'CLG', false), false);

  assert.equal(
    confirmationCorrectionValue('OTHER', 'CLG', true, '2026-07-10T12:00:00.000Z'),
    true,
  );
  assert.equal(
    confirmationCorrectionValue(null, '2026-09-30', false, '2026-07-10T12:00:00.000Z'),
    false,
  );
});

test('organisation confirmation warnings explain supersession until reconfirmation', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../src/app/(dashboard)/organisation/organisation-profile-form.tsx'),
    'utf8',
  );
  assert.match(source, /supersedes current derived company dates until the legal form is reconfirmed/iu);
  assert.match(source, /supersedes current derived CRO dates until the ARD is reconfirmed from CORE/iu);
});
