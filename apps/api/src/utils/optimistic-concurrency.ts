import { AppError } from "./errors.js";

/**
 * Refuses a change made against a record that has since moved.
 *
 * The stamp is optional on the way in. The screens that edit these records do
 * not carry one yet, and demanding it would stop a person saving a form. The
 * connector always sends it, because the case this exists for is an assistant
 * working from a record it read an hour ago and overwriting whatever somebody
 * changed in between — the person at the screen at least saw the record a
 * moment ago. A caller that supplies nothing is trusting last-write-wins, as
 * every caller did before.
 *
 * The code ends in _CONFLICT on purpose: that is the family the connector
 * already answers with "read it again and retry", so a new route joining this
 * pattern needs no change there.
 */
export function assertUnchanged(
  record: { updatedAt: Date },
  expectedUpdatedAt: string | undefined,
  code: string,
): void {
  if (expectedUpdatedAt === undefined) return;

  const expected = Date.parse(expectedUpdatedAt);
  if (Number.isNaN(expected) || record.updatedAt.getTime() !== expected) {
    throw new AppError(
      409,
      code,
      "This record changed since it was read. Read it again and retry with its "
        + "current updatedAt.",
    );
  }
}
