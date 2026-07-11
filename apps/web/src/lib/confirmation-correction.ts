/**
 * Return the explicit confirmation patch needed to move from the persisted
 * evidence state to the edited state. `false` is meaningful: it revokes a
 * prior confirmation without deleting the underlying fact.
 */
export function confirmationCorrectionValue<T extends string>(
  nextValue: T | null,
  persistedValue: T | null,
  nextConfirmed: boolean,
  persistedConfirmedAt: string | null | undefined,
): boolean | undefined {
  const persistedConfirmed = Boolean(persistedValue && persistedConfirmedAt);
  if (nextValue !== persistedValue || nextConfirmed !== persistedConfirmed) {
    return nextConfirmed;
  }
  return undefined;
}

/**
 * A newly entered or changed fact must be confirmed before it can replace the
 * persisted value. The unchanged persisted fact may be explicitly unconfirmed
 * as an evidence correction.
 */
export function changedValueNeedsConfirmation<T extends string>(
  nextValue: T | null,
  persistedValue: T | null,
  nextConfirmed: boolean,
): boolean {
  return Boolean(nextValue && nextValue !== persistedValue && !nextConfirmed);
}
