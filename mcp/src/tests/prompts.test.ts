import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPTS, findPrompt, promptListing } from '../prompts.js';
import { TOOLS } from '../tools.js';
import { FILE_TOOLS } from '../file-tools.js';

const TOOL_NAMES = new Set([
  ...TOOLS.map((tool) => tool.name),
  ...FILE_TOOLS.map((tool) => tool.name),
  'session_info',
]);

test('every prompt names tools that exist', () => {
  // A prompt that names a tool by a name nobody implemented sends the model
  // looking for it, and the model then invents something close.
  for (const prompt of PROMPTS) {
    const body = prompt.build({});
    for (const mentioned of body.match(/\b[a-z][a-z_]*_[a-z_]+\b/g) ?? []) {
      // Only check words that look like tool names: lower case with an
      // underscore. Anything not in the list is prose unless it is a near miss.
      if (TOOL_NAMES.has(mentioned)) continue;
      assert.ok(
        !mentioned.startsWith('compliance_')
        && !mentioned.startsWith('board_')
        && !mentioned.startsWith('deadline')
        && !mentioned.startsWith('governing_')
        && !mentioned.startsWith('risk')
        && !mentioned.startsWith('conflict')
        && !mentioned.startsWith('document')
        && !mentioned.startsWith('organisation')
        && !mentioned.startsWith('registers_')
        && !mentioned.startsWith('annual_report')
        && !mentioned.startsWith('financial_controls')
        && !mentioned.startsWith('session_'),
        `${prompt.name} names "${mentioned}", which is not a tool`,
      );
    }
  }
});

test('a prompt that needs an argument says so, and still builds without one', () => {
  for (const prompt of PROMPTS) {
    const text = prompt.build({});
    assert.ok(text.length > 100, `${prompt.name} must produce a real message`);
    for (const argument of prompt.arguments) {
      assert.ok(argument.description.length > 0, `${prompt.name}.${argument.name}`);
    }
  }
});

test('an argument that is given is used', () => {
  const meeting = findPrompt('record_board_meeting')!;
  const text = meeting.build({ meeting_date: '2026-03-04', reference: 'BM-2026-03' });

  assert.match(text, /2026-03-04/);
  assert.match(text, /BM-2026-03/);
});

test('the year defaults to this one, and a nonsense year is ignored', () => {
  const readiness = findPrompt('annual_return_readiness')!;
  const current = String(new Date().getUTCFullYear());

  assert.match(readiness.build({}), new RegExp(current));
  assert.match(readiness.build({ year: 'last year' }), new RegExp(current));
  assert.match(readiness.build({ year: '2024' }), /2024/);
});

test('no prompt tells the assistant to change something without confirming', () => {
  // These are offered to a person who then watches an assistant act on them.
  // A recipe that writes without stopping is a recipe for a surprise.
  for (const prompt of PROMPTS) {
    const text = prompt.build({}).toLowerCase();
    if (!/_create|_update|_set\b/.test(text)) continue;
    assert.ok(
      /confirm|ask me|once i have|do not change|tell me what to change/.test(text),
      `${prompt.name} writes without saying it must check first`,
    );
  }
});

test('the listing tells a client what each prompt takes', () => {
  const listed = promptListing();

  assert.equal(listed.length, PROMPTS.length);
  for (const prompt of listed) {
    assert.ok(prompt.name.length > 0);
    assert.ok(prompt.title.length > 0);
    assert.ok(prompt.description.length > 0);
    for (const argument of prompt.arguments) {
      assert.equal(typeof argument.required, 'boolean');
    }
  }

  const meeting = listed.find((prompt) => prompt.name === 'record_board_meeting')!;
  assert.equal(meeting.arguments.find((a) => a.name === 'meeting_date')?.required, true);
});

test('an unknown prompt is not found rather than guessed at', () => {
  assert.equal(findPrompt('write_the_minutes_for_me'), undefined);
});
