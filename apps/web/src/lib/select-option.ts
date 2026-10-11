/**
 * The value a HeroUI single-selection <Select> reports through `onChange`, or
 * `undefined` when it is not one of `keys`.
 *
 * HeroUI renders a hidden native <select> alongside its listbox, and browser
 * autofill and automation drive that element. A change there reaches HeroUI's
 * selection state as a bare string, which is iterated character by character:
 * choosing "STRATEGIC_PLAN" first reports the key "S" and only then, through the
 * native change event, the real value. `onSelectionChange` sees only the "S", so
 * every Select reads `onChange` and passes the value through this check.
 *
 * `keys` should hold only the options a person may choose: the hidden native
 * <select> ignores `isDisabled`, so a disabled option must be left out here.
 */
export function selectOption<K extends string>(value: string, keys: Iterable<K>): K | undefined {
  for (const key of keys) {
    if (key === value) return key;
  }
  return undefined;
}
