/** Run in the browser so its timezone and native datetime-local format apply. */
export function localDateTimeValue({ now, offset }: { now: string; offset: number }): string {
  const date = new Date(new Date(now).getTime() + offset);
  const input = document.createElement('input');
  input.type = 'datetime-local';
  input.step = '0.001';
  input.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
  if (new Date(input.value).getTime() !== date.getTime()) throw new Error('Observation precision was lost');
  return input.value;
}
