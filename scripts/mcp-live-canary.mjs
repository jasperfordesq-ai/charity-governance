#!/usr/bin/env node
/**
 * Break the connector on purpose and require the live suite to notice.
 *
 * Three tests in the original connector build passed whether or not the code
 * worked. A green suite is evidence only once it has been shown to go red.
 *
 * Usage: node scripts/mcp-live-canary.mjs <name>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Anchors are regular expressions carrying `\r?\n` because these sources are
// checked out with CRLF endings on Windows; a plain "\n" anchor silently
// matches nothing, and a canary that cannot apply its mutation would report
// the suite failing for the wrong reason.
const MUTATIONS = {
  'gate-leaks-dob': {
    file: 'mcp/src/field-policy.ts',
    // The line ending is captured and reused so the mutated file keeps the
    // endings it had. The newline is part of the anchor because
    // "  BoardMember: [" also begins the single-line WITHHELD_FIELDS entry,
    // and mutating that one would prove nothing.
    find: /( {2}BoardMember: \[)(\r?\n)/g,
    replace: "$1$2    'dateOfBirth',$2",
    expect: 'board_register must withhold dateOfBirth from the closed gate.',
  },
  'gate-always-open': {
    file: 'mcp/src/tools.ts',
    find: /( {2}return applyFieldPolicy\(tool\.model, raw, )allowPersonalData(\);)/g,
    replace: '$1true$2',
    expect: 'governing_acts must withhold notes and resolutions from the closed gate.',
  },
};

const name = process.argv[2];
const mutation = MUTATIONS[name];
if (!mutation) {
  console.error(`Usage: node scripts/mcp-live-canary.mjs <${Object.keys(MUTATIONS).join('|')}>`);
  process.exit(2);
}

const original = readFileSync(mutation.file, 'utf8');
const occurrences = (original.match(mutation.find) ?? []).length;
if (occurrences !== 1) {
  console.error(
    `Canary "${name}" expected exactly one anchor in ${mutation.file}, found ${occurrences}. `
      + 'Update the mutation rather than letting it hit the wrong place.',
  );
  process.exit(2);
}

function build() {
  execFileSync('npm', ['run', 'build'], { cwd: 'mcp', stdio: 'inherit', shell: true });
}

let outcome = 'unknown';
try {
  writeFileSync(mutation.file, original.replace(mutation.find, mutation.replace));
  // A mutation that does not compile would make the suite fail for the wrong
  // reason and the canary would congratulate itself. The build is therefore
  // judged separately, and a broken build is a broken canary, not a pass.
  try {
    build();
  } catch {
    outcome = 'build-broken';
    throw new Error('build');
  }
  try {
    execFileSync('npm', ['run', 'test:e2e:mcp'], { stdio: 'inherit', shell: true });
    outcome = 'suite-passed';
  } catch {
    outcome = 'suite-failed';
  }
} catch {
  // Falls through to the restore below with `outcome` already set.
} finally {
  writeFileSync(mutation.file, original);
  build();
}

if (outcome === 'build-broken') {
  console.error(
    `CANARY BROKEN: "${name}" does not compile, so the suite would have failed for the wrong `
      + 'reason. Rewrite the mutation so it is valid code that behaves wrongly.',
  );
  process.exit(2);
}
if (outcome !== 'suite-failed') {
  console.error(`CANARY FAILED: the suite passed with "${name}" applied. ${mutation.expect}`);
  process.exit(1);
}
console.log(`Canary "${name}" behaved correctly: the suite failed while the mutation was applied.`);
