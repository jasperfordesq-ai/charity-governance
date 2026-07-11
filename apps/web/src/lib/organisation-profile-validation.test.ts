import assert from 'node:assert/strict';
import test from 'node:test';

import { organisationProfileBlockingErrors } from './organisation-profile-validation';

const validInput = {
  name: 'Example Charity',
  legalForm: null,
  persistedLegalForm: null,
  legalFormConfirmed: false,
  croAnnualReturnDate: '',
  persistedCroAnnualReturnDate: '',
  croAnnualReturnDateConfirmed: false,
  memberCount: '',
};

test('missing optional setup facts do not block an unrelated profile save', () => {
  assert.deepEqual(organisationProfileBlockingErrors(validInput), []);
});

test('new legal and CRO facts remain blocked until explicitly confirmed', () => {
  assert.deepEqual(
    organisationProfileBlockingErrors({
      ...validInput,
      legalForm: 'CLG',
      croAnnualReturnDate: '2026-09-30',
    }),
    [
      'Confirm the newly selected legal form before saving it.',
      'Confirm the changed CRO Annual Return Date was copied from CORE before saving it.',
    ],
  );

  assert.deepEqual(
    organisationProfileBlockingErrors({
      ...validInput,
      legalForm: 'CLG',
      legalFormConfirmed: true,
      croAnnualReturnDate: '2026-09-30',
      croAnnualReturnDateConfirmed: true,
    }),
    [],
  );
});

test('an unchanged persisted legal form can be unconfirmed without blocking unrelated edits', () => {
  assert.deepEqual(
    organisationProfileBlockingErrors({
      ...validInput,
      legalForm: 'CLG',
      persistedLegalForm: 'CLG',
      legalFormConfirmed: false,
    }),
    [],
  );
});

test('invalid required and numeric fields remain blocking errors', () => {
  assert.deepEqual(
    organisationProfileBlockingErrors({ ...validInput, name: ' ', memberCount: '1.5' }),
    [
      'Organisation name is required.',
      'Member count must be a whole number between 1 and 2,147,483,647.',
    ],
  );

  assert.deepEqual(
    organisationProfileBlockingErrors({ ...validInput, memberCount: '0' }),
    ['Member count must be a whole number between 1 and 2,147,483,647.'],
  );
  assert.deepEqual(
    organisationProfileBlockingErrors({ ...validInput, memberCount: '2147483648' }),
    ['Member count must be a whole number between 1 and 2,147,483,647.'],
  );
});
