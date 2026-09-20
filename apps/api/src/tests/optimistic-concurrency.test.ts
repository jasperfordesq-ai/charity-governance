import assert from "node:assert/strict";
import test from "node:test";

const { assertUnchanged } = await import("../utils/optimistic-concurrency.js");
const { AppError } = await import("../utils/errors.js");

const RECORD = { updatedAt: new Date("2026-09-20T12:00:00.000Z") };

test("a caller that supplies no stamp is not refused", () => {
  // The screens do not carry one yet. Demanding it would stop a person saving
  // a form, and last-write-wins is what every caller had before.
  assert.doesNotThrow(() => assertUnchanged(RECORD, undefined, "X_CONFLICT"));
});

test("the stamp the caller read lets the change through", () => {
  assert.doesNotThrow(() =>
    assertUnchanged(RECORD, "2026-09-20T12:00:00.000Z", "X_CONFLICT"));
  // The same instant written with an offset is the same instant.
  assert.doesNotThrow(() =>
    assertUnchanged(RECORD, "2026-09-20T13:00:00.000+01:00", "X_CONFLICT"));
});

test("a stamp from before somebody else's change is refused", () => {
  assert.throws(
    () => assertUnchanged(RECORD, "2026-09-20T11:59:00.000Z", "REGISTER_UPDATE_CONFLICT"),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "REGISTER_UPDATE_CONFLICT");
      assert.match(error.message, /read it again/i);
      return true;
    },
  );
});

test("a stamp that is not a date is refused rather than ignored", () => {
  // Ignoring it would let a caller opt out of the check by sending rubbish.
  for (const nonsense of ["", "yesterday", "2026-13-45T99:99:99Z"]) {
    assert.throws(
      () => assertUnchanged(RECORD, nonsense, "X_CONFLICT"),
      AppError,
      `"${nonsense}" must not pass for a stamp`,
    );
  }
});

test("the code ends in _CONFLICT, which is the family the connector acts on", () => {
  // The connector answers that family with "read it again and retry". A code
  // outside it would leave an agent with no idea what to do.
  for (const code of ["REGISTER_UPDATE_CONFLICT", "BOARD_MEMBER_UPDATE_CONFLICT"]) {
    assert.ok(code.endsWith("_CONFLICT"));
    assert.throws(
      () => assertUnchanged(RECORD, "2026-01-01T00:00:00.000Z", code),
      (error: unknown) => error instanceof AppError && error.code === code,
    );
  }
});
