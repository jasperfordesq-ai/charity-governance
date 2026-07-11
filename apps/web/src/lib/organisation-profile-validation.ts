import { changedValueNeedsConfirmation } from './confirmation-correction';
import { MAX_ORGANISATION_MEMBER_COUNT } from '@charitypilot/shared';

export type OrganisationProfileValidationInput = {
  name: string;
  legalForm: string | null;
  persistedLegalForm: string | null;
  legalFormConfirmed: boolean;
  croAnnualReturnDate: string;
  persistedCroAnnualReturnDate: string;
  croAnnualReturnDateConfirmed: boolean;
  memberCount: string;
};

/**
 * Return only errors that make the proposed patch unsafe or invalid.
 *
 * Missing setup facts such as legal form remain visible in the profile
 * completion checklist, but they must not prevent an administrator from
 * saving an unrelated fact. A newly selected legal form or CRO ARD is
 * different: it must be explicitly confirmed before it can replace the
 * persisted evidence state.
 */
export function organisationProfileBlockingErrors({
  name,
  legalForm,
  persistedLegalForm,
  legalFormConfirmed,
  croAnnualReturnDate,
  persistedCroAnnualReturnDate,
  croAnnualReturnDateConfirmed,
  memberCount,
}: OrganisationProfileValidationInput): string[] {
  const errors: string[] = [];

  if (!name.trim()) errors.push('Organisation name is required.');

  if (changedValueNeedsConfirmation(legalForm, persistedLegalForm, legalFormConfirmed)) {
    errors.push('Confirm the newly selected legal form before saving it.');
  }

  if (changedValueNeedsConfirmation(
    croAnnualReturnDate || null,
    persistedCroAnnualReturnDate || null,
    croAnnualReturnDateConfirmed,
  )) {
    errors.push('Confirm the changed CRO Annual Return Date was copied from CORE before saving it.');
  }

  if (
    memberCount &&
    (!Number.isSafeInteger(Number(memberCount)) ||
      Number(memberCount) < 1 ||
      Number(memberCount) > MAX_ORGANISATION_MEMBER_COUNT)
  ) {
    errors.push('Member count must be a whole number between 1 and 2,147,483,647.');
  }

  return errors;
}
