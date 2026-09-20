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
  // The two pillars of the connector's session posture. Both live in the API,
  // because a connector that merely declined to offer a write tool would look
  // identical from the outside while leaving the route open to anything
  // holding the credential.
  'connector-route-accepts-a-browser': {
    file: 'apps/api/src/utils/non-browser-client.ts',
    find: /(if \(headerValue\(request\.headers\[header\]\) )!== undefined(\) return refuse\(\);)/g,
    // Still valid code, and still compares two strings, so the build stays
    // honest; it simply never matches, which is what "the check was removed"
    // looks like from the outside.
    replace: "$1=== 'a-value-no-browser-ever-sends'$2",
    expect:
      'a connector route must refuse a request carrying an origin or a Sec-Fetch header.',
  },
  // The activity record is the reason writes are allowed at all. A hook that
  // silently stops firing is indistinguishable from a client that never wrote,
  // which is precisely the state this must never quietly reach.
  'activity-never-recorded': {
    file: 'apps/api/src/plugins/client-activity-log.ts',
    // Narrows the hook to a client kind that cannot exist, rather than deleting
    // the write, so the file still compiles and still calls Prisma.
    find: /(if \(!session \|\| session\.clientKind !== )"MCP_CONNECTOR"(\) return;)/g,
    replace: '$1(("WEB") as typeof session.clientKind)$2',
    expect: 'a connector write must leave exactly one client activity row.',
  },
  'read-only-session-may-write': {
    file: 'apps/api/src/middleware/auth.ts',
    // Inverted rather than deleted: comparing the access level against an
    // invented string would not type-check, and a canary that cannot compile
    // proves nothing.
    find: /( {4})!(SAFE_METHODS\.has\(request\.method\))/g,
    replace: '$1$2',
    expect: 'a read-level session must be refused an unsafe method with SESSION_READ_ONLY.',
  },
  // The approval is the only thing between an agent and a deletion. Both of
  // these make it useless while leaving it apparently present, which is the
  // shape a real regression would take.
  'approval-is-reusable': {
    file: 'apps/api/src/middleware/action-approval.ts',
    // Both layers at once. The rule is enforced in the guard and again in the
    // conditional update, so defeating one alone leaves the other enforcing it
    // and the canary would pass while proving nothing.
    edits: [
      {
        find: /approval\.consumedAt === null &&/g,
        replace: '(approval.consumedAt === null || true) &&',
      },
      {
        find: / {14}consumedAt: null,\r?\n {14}approvedAt: \{ not: null \},/g,
        replace: '              approvedAt: { not: null },',
      },
    ],
    expect: 'an approval must be spent by the one request that used it.',
  },
  'approval-not-needed': {
    file: 'apps/api/src/middleware/action-approval.ts',
    find: /(if \(!session \|\| session\.clientKind !== )"MCP_CONNECTOR"(\) return;)/g,
    replace: '$1(("WEB") as typeof session.clientKind)$2',
    expect: 'a removal from a connector session must be refused until a person approves it.',
  },
  // An upload reads from the operator's own machine. Containment decided on
  // the spelling alone looks identical until somebody uses a link.
  'upload-escapes-its-directory': {
    file: 'mcp/src/files.ts',
    find: /(  const within = relative\(realRoot, real\);\r?\n  if \(within === '' \|\| )within\.startsWith\('\.\.'\) \|\| isAbsolute\(within\)(\) \{)/g,
    replace: "$1false$2",
    expect: 'a file outside the named directory must not be uploadable.',
  },
  // The dashboard shipped for a while returning its payload unfiltered. This
  // reproduces that exact state: a shape that hands the value straight back.
  'dashboard-passthrough': {
    file: 'mcp/src/field-policy.ts',
    find: /( {2}dashboard: )filterDashboard(,)/g,
    replace: '$1((value) => value)$2',
    expect:
      'dashboard_overview must withhold activity free text and staff names from the closed gate.',
  },
  // The summary a person reads before typing a password used to name only the
  // route. This puts it back to that state while leaving the lookup table in
  // place, so the file still compiles.
  'approval-summary-nameless': {
    file: 'apps/api/src/services/action-summary.ts',
    find: /( {6})named = await lookup\(prisma, organisationId, params\);/g,
    replace: '$1named = null;',
    expect: 'the refusal and the approval preview must name the record being removed.',
  },
  // A client decides whether to ask before a call from these hints. A delete
  // that says it is not destructive is a delete nobody is asked about.
  'delete-says-it-is-safe': {
    file: 'mcp/src/tools.ts',
    find: /( {4}destructiveHint: )tool\.destructive === true(,)/g,
    replace: '$1false$2',
    expect: 'board_member_delete must carry destructiveHint true.',
  },
  // The personal-data gate is a property of the session now. A login route
  // that ignored what was asked for would hand every connector session the
  // whole record, and nothing about the connector would look different.
  'every-session-sees-everything': {
    file: 'apps/api/src/routes/auth/connector.ts',
    find: /(const dataScope = )body\.dataScope \?\? "WITHHELD"(;)/g,
    replace: '$1"FULL"$2',
    expect: 'a session connected without asking for personal data must not see it.',
  },
  // The floor is what stops a member holding a session that reads a trustee's
  // home address. Widening it leaves every other test green.
  'any-role-may-see-personal-data': {
    file: 'apps/api/src/routes/auth/connector.ts',
    find: /(const DATA_SCOPE_ROLE_FLOOR = new Set\(\["OWNER", "ADMIN")(\]\);)/g,
    replace: '$1, "MEMBER"$2',
    expect: 'a member must be refused a session that sees personal data.',
  },
};

const name = process.argv[2];
const mutation = MUTATIONS[name];
if (!mutation) {
  console.error(`Usage: node scripts/mcp-live-canary.mjs <${Object.keys(MUTATIONS).join('|')}>`);
  process.exit(2);
}

const original = readFileSync(mutation.file, 'utf8');

// A mutation may carry several edits. Some rules are enforced in two places —
// once in a guard and again in a conditional database update — and defeating
// only one of them leaves the other enforcing the rule, so the canary would
// pass while proving nothing.
const edits = Array.isArray(mutation.edits)
  ? mutation.edits
  : [{ find: mutation.find, replace: mutation.replace }];

for (const edit of edits) {
  const occurrences = (original.match(edit.find) ?? []).length;
  if (occurrences !== 1) {
    console.error(
      `Canary "${name}" expected exactly one anchor for ${edit.find} in ${mutation.file}, `
        + `found ${occurrences}. Update the mutation rather than letting it hit the wrong place.`,
    );
    process.exit(2);
  }
}

function applyEdits(source) {
  return edits.reduce((text, edit) => text.replace(edit.find, edit.replace), source);
}

function build() {
  // The API is rebuilt by the isolated stack from source on every run, so only
  // the connector needs an explicit build here. Building it regardless keeps
  // the restore path identical whichever file a mutation touched.
  execFileSync('npm', ['run', 'build'], { cwd: 'mcp', stdio: 'inherit', shell: true });
}

let outcome = 'unknown';
try {
  writeFileSync(mutation.file, applyEdits(original));
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
