import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { selectOption } from './select-option';

const CATEGORIES = ['POLICY', 'STRATEGIC_PLAN', 'OTHER'] as const;

test('selectOption returns a value that is one of the keys', () => {
  assert.equal(selectOption('STRATEGIC_PLAN', CATEGORIES), 'STRATEGIC_PLAN');
  assert.equal(selectOption('OTHER', new Set(CATEGORIES)), 'OTHER');
});

test('selectOption refuses the first-character key the hidden native select reports first', () => {
  assert.equal(selectOption('S', CATEGORIES), undefined);
  assert.equal(selectOption('c', ['cm1abc', 'cm2def']), undefined);
});

test('selectOption refuses the blank option and anything outside the keys', () => {
  assert.equal(selectOption('', CATEGORIES), undefined);
  assert.equal(selectOption('strategic_plan', CATEGORIES), undefined);
  assert.equal(selectOption('STRATEGIC_PLAN', []), undefined);
});

// Concern: every HeroUI Select reads its value through onChange + selectOption.
// onSelectionChange receives only the first character of a key chosen through
// the hidden native <select>, so a Select wired to it cannot be set by autofill
// or automation, and a handler with side effects receives a key that does not exist.
// Only a <Select> element counts: other components (a selectable Table, a
// Listbox) use onSelectionChange legitimately, and comments are ignored.
function selectWiredToSelectionChange(source: string) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const match of code.matchAll(/<Select(?![A-Za-z0-9_])/g)) {
    const rest = code.slice(match.index);
    const end = rest.indexOf('</Select>');
    if ((end === -1 ? rest : rest.slice(0, end)).includes('onSelectionChange')) return true;
  }
  return false;
}

test('the Select scan flags only a Select wired to onSelectionChange', () => {
  assert.equal(selectWiredToSelectionChange('<Select label="x" onSelectionChange={f}><SelectItem key="a">A</SelectItem></Select>'), true);
  assert.equal(selectWiredToSelectionChange('<Select\n  onChange={g}\n  onSelectionChange={(keys) => f(keys)}\n>{items}</Select>'), true);
  assert.equal(selectWiredToSelectionChange('<Table selectionMode="single" onSelectionChange={f}>{rows}</Table>'), false);
  assert.equal(selectWiredToSelectionChange('<Select onChange={g}><SelectItem key="a">A</SelectItem></Select>\n<Table onSelectionChange={f} />'), false);
  assert.equal(selectWiredToSelectionChange('// never use onSelectionChange on a Select\n<Select onChange={g}>{items}</Select>'), false);
  assert.equal(selectWiredToSelectionChange('<SelectItem key="a" /> <Listbox onSelectionChange={f} />'), false);
});

test('no HeroUI Select in the web app is wired to onSelectionChange', () => {
  const src = join(process.cwd(), 'src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.tsx') && selectWiredToSelectionChange(readFileSync(path, 'utf8'))) {
        offenders.push(relative(src, path));
      }
    }
  };
  walk(src);
  assert.deepEqual(offenders, []);
});
