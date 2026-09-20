// A gate whose only exit is the override teaches everyone to reach for the
// override. Narrow these rules or give them proof-carrying exemptions; never
// widen silently. Every rule is pinned in both directions by
// migration-gate.test.mjs.
//
// Blue-green runs migrations against a database the OLD colour is still
// serving traffic against, so only expand/contract-safe changes are allowed
// to run unattended: additive schema changes that both the old and new code
// can tolerate. Anything that could break the old colour's still-running
// queries (dropping/renaming/retyping things it reads, or validating a
// constraint synchronously against the whole table) is BLOCKED by default;
// --allow-destructive is the intentional escape hatch for a deploy where a
// human has confirmed the old colour is already stopped or is known-safe.
//
// This module is pure and offline-testable: it never touches a database or
// the filesystem beyond reading migration directory names. The orchestrator
// (Task 7) is responsible for asking the LIVE database (via
// `docker compose ... exec -T db psql`) which migrations are already applied,
// and for reading each pending migration's migration.sql off disk.
//
// R1 fix (post-review): every "does X appear somewhere after ALTER TABLE"
// rule used an unbounded [\s\S]{0,N} bridging gap, which does not stop at a
// statement's terminating semicolon. Against real multi-statement migration
// files this both false-BLOCKED safe files (an earlier unrelated ALTER
// TABLE ... ALTER COLUMN ... SET DEFAULT bridging forward into a later,
// unrelated CREATE TYPE/ALTER TYPE/ADD COLUMN "type") and false-ALLOWED
// unsafe ones (a genuine DROP COLUMN sitting past the window, many clauses
// into one multi-clause ALTER TABLE). Every bridging gap below is now
// `[^;]{0,N}` — bounded by the statement's own semicolon, so it can span an
// arbitrarily clause-heavy single statement but can never reach into the
// next one.

import { readdirSync } from 'node:fs';

// Rules are checked against comment/string-stripped SQL, case-insensitively.
// Each rule is a single regex matched with .match() (not /g — we only need
// to know whether a rule fires, plus one excerpt for the report).
const BLOCKED = [
  ['drop-table', /\bDROP\s+TABLE\b/i],
  ['drop-column', /\bALTER\s+TABLE\b[^;]{0,600}?\bDROP\s+COLUMN\b/i],
  // Anchored to statement position (start-of-input, or right after a
  // preceding statement's terminating semicolon) rather than a bare \b, so a
  // trigger's event specifier — `BEFORE TRUNCATE ON "table"` — is never
  // mistaken for a real TRUNCATE statement. That trigger is additive
  // hardening DDL (it makes truncation harder, not easier) and must pass.
  ['truncate', /(?:^|;)\s*TRUNCATE\b/im],
  ['rename-table', /\bALTER\s+TABLE\b[^;]{0,600}?\bRENAME\s+TO\b/i],
  ['rename-column', /\bALTER\s+TABLE\b[^;]{0,600}?\bRENAME\s+COLUMN\b/i],
  // Prisma's real output spells this `ALTER COLUMN ... SET DATA TYPE ...`;
  // plain `... TYPE ...` is also valid Postgres grammar, so `SET DATA` is
  // optional. Both gaps are statement-bounded (see R1 fix note above) so an
  // unrelated `TYPE` token in a later statement — e.g. a column literally
  // named "type" — can never bridge into this match.
  ['alter-column-type', /\bALTER\s+TABLE\b[^;]{0,600}?\bALTER\s+COLUMN\b[^;]{0,120}?\b(?:SET\s+DATA\s+)?TYPE\b/i],
  ['set-not-null', /\bALTER\s+TABLE\b[^;]{0,600}?\bSET\s+NOT\s+NULL\b/i],
];

const WARNED = [
  // SHARE lock blocks writes for the build duration; fine at current volume,
  // this warning is future-you's reminder. CONCURRENTLY is the allowed form
  // — but it cannot run inside `prisma migrate deploy`'s implicit
  // transaction (Postgres refuses CREATE INDEX CONCURRENTLY in a
  // transaction block), so this warning is a deploy-window awareness signal
  // for a human to weigh, not an in-place fix the migration itself can make.
  ['create-index-non-concurrent', /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/i],
  // Symmetric with create-index-non-concurrent: DROP INDEX CONCURRENTLY
  // avoids the ACCESS EXCLUSIVE lock a plain DROP INDEX takes, which can
  // stall the still-serving old colour's queries that plan through the same
  // index for the duration of the drop. Data-safe either way — this is a
  // performance/availability signal, not a correctness one.
  ['drop-index-non-concurrent', /\bDROP\s+INDEX\s+(?!CONCURRENTLY)/i],
  // A constraint added without NOT VALID is validated synchronously against
  // every existing row while holding a lock the old colour's writers can
  // hit. NOT VALID defers that scan to a later, explicit VALIDATE
  // CONSTRAINT. Statement-bounded for the same reason as the BLOCKED rules
  // above: a NOT VALID in a *different* statement must not suppress this,
  // and a CHECK/FOREIGN KEY in a different statement must not trigger it.
  ['validating-constraint', /\bADD\s+CONSTRAINT\b[^;]{0,200}?\b(?:CHECK|FOREIGN\s+KEY)\b(?![^;]{0,150}?\bNOT\s+VALID\b)/i],
];

// The gate's one proof-carrying exemption.
//
// A destructive verb aimed at a table THIS SAME pending batch created is not
// destructive. Blue-green blocks these verbs because the colour still serving
// traffic has queries that read the thing being changed — but a table an
// earlier migration in this very batch creates has never existed while that
// colour was running, so it has no such queries and nothing of its can break.
//
// This is not a relaxation of the rule. It is the rule stated accurately: the
// rule was always about what the old colour can see. And it is proof-carrying
// — it applies only when the CREATE TABLE is in hand, in an earlier migration
// of the batch being gated, which `gateMigrations` walks in apply order.
//
// Deliberately NOT extended to a table created earlier in the SAME migration
// file. That case is safe by the identical argument, but nothing has needed
// it, and each widening here costs a reader their reason to believe the gate
// still means what it says. Add it when a migration actually wants it.
//
// The list below is exactly the four verbs the exemption was authorised for.
// `drop-table` and `alter-column-type` would qualify under the same argument
// and are still left out, for the same reason: the narrower rule is the one
// that can be checked by eye. Both are pinned as NOT exempt, so widening this
// set is a deliberate act with a failing test attached, not a drift.
const EXEMPTIBLE_ON_BATCH_CREATED_TABLE = new Set([
  'drop-column',
  'rename-column',
  'rename-table',
  'set-not-null',
]);

const EXCERPT_MAX = 160;

// Single-pass, string-literal-aware stripper. Removes `--` line comments and
// `/* */` block comments, and masks the *contents* of '...' string literals
// (escaped '' quotes included) to a single space — so neither a `--`/`/*`
// inside a literal can accidentally start a comment that swallows real SQL
// after it, nor can literal text (e.g. a log message that happens to say
// "DROP TABLE") accidentally trip a rule. A plain regex-based
// comment-stripper can't tell "inside a string" from "inside real SQL", so
// this walks the source one character at a time instead.
function stripSqlNoise(sql) {
  const src = sql ?? '';
  const n = src.length;
  let out = '';
  let i = 0;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '-' && next === '-') {
      // Line comment: skip to (but not past) the newline so line structure
      // is preserved for excerpts.
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      out += ' ';
      continue;
    }

    if (c === "'") {
      i++; // consume opening quote
      while (i < n) {
        if (src[i] === "'" && src[i + 1] === "'") {
          i += 2; // escaped quote: stays inside the literal
          continue;
        }
        if (src[i] === "'") {
          i++; // consume closing quote
          break;
        }
        i++;
      }
      out += ' '; // mask the entire literal (quotes and all)
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

// One table reference — `"Schema"."Name"`, `schema.name`, `"Name"`, `name` —
// reduced to a single comparable token. Quoted identifiers keep their case
// because Postgres does; unquoted ones fold to lower case because Postgres
// does that too. Only the last segment is kept: this deploy has one schema,
// and a reference that names it is the same table as one that does not.
function normaliseTableRef(raw) {
  if (!raw) return null;
  const segments = [...raw.matchAll(/"([^"]*)"|([A-Za-z_][\w$]*)/g)].map((part) =>
    part[1] !== undefined ? part[1] : part[2].toLowerCase(),
  );
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

// Statement-splitting on already-stripped SQL. Comments are gone and string
// literals are masked, so every remaining semicolon terminates a statement.
//
// Safe for this purpose even where it is imprecise: a dollar-quoted function
// body is not understood and would split mid-body, which can only lose a
// statement's identity and therefore only ever REFUSES an exemption. The
// failure direction is "block", which is the direction a gate should fail in.
function statementsOf(stripped) {
  return stripped.split(';');
}

const CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]*"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]*"|[A-Za-z_][\w$]*))?)/gi;
const ALTER_TABLE_TARGET = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?((?:"[^"]*"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]*"|[A-Za-z_][\w$]*))?)/i;

/**
 * The tables one migration's SQL creates, normalised.
 *
 * Exported so the evidence behind an exemption can be inspected and pinned
 * on its own, rather than only through the gate's verdict.
 */
export function tablesCreatedBy(sql) {
  const stripped = stripSqlNoise(sql);
  const created = new Set();
  for (const match of stripped.matchAll(CREATE_TABLE)) {
    const name = normaliseTableRef(match[1]);
    if (name) created.add(name);
  }
  return created;
}

/**
 * Every table targeted by a statement that trips `pattern`.
 *
 * A `null` entry means a statement tripped the rule but its target could not
 * be read — which denies the exemption, because an exemption needs proof and
 * an unreadable target is not proof.
 */
function targetsTripping(stripped, pattern) {
  const targets = [];
  for (const statement of statementsOf(stripped)) {
    if (!pattern.test(statement)) continue;
    const found = statement.match(ALTER_TABLE_TARGET);
    targets.push(found ? normaliseTableRef(found[1]) : null);
  }
  return targets;
}

function excerptOf(matchText) {
  const collapsed = matchText.replace(/\s+/g, ' ').trim();
  return collapsed.length > EXCERPT_MAX ? `${collapsed.slice(0, EXCERPT_MAX)}…` : collapsed;
}

/**
 * Splits a release's migration directory against the live database's
 * applied-migration names.
 *
 * Returns `{ pending, unknownApplied }`:
 *  - `pending`: dir names not in `appliedNames`, sorted ascending (Prisma
 *    migration folder names are timestamp-prefixed, so sort order is apply
 *    order).
 *  - `unknownApplied`: names the live database reports as applied that do
 *    NOT correspond to any directory in this release's checkout, sorted.
 *    These are correctly excluded from `pending` (nothing to run — a
 *    rollback deploy legitimately serves an older release than what most
 *    recently applied migrations against the db), but are surfaced rather
 *    than silently swallowed so the orchestrator/operator can see that the
 *    live db is ahead of the code being deployed.
 */
export function pendingMigrations(releaseMigrationsDir, appliedNames) {
  const applied = new Set(appliedNames ?? []);
  const onDisk = readdirSync(releaseMigrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const onDiskSet = new Set(onDisk);

  const pending = onDisk.filter((name) => !applied.has(name)).sort();
  const unknownApplied = [...applied].filter((name) => !onDiskSet.has(name)).sort();

  return { pending, unknownApplied };
}

/**
 * Lints one migration's SQL against the BLOCKED/WARNED vocabulary above.
 *
 * Returns { blocked, warned, exempted }, each an array of
 * { id, migration, excerpt }; an exempted finding also carries the `table`
 * whose creation earlier in the batch is the proof, and is the one thing that
 * can move a finding out of `blocked`.
 *
 * `tablesCreatedEarlierInBatch` is the accumulated evidence from the
 * migrations that run before this one. Called without it — as every caller
 * that lints a file in isolation does — nothing is exempt, so a migration
 * judged on its own is judged exactly as strictly as it was before.
 */
export function lintMigrationSql(name, sql, { tablesCreatedEarlierInBatch } = {}) {
  const stripped = stripSqlNoise(sql);
  const createdEarlier =
    tablesCreatedEarlierInBatch instanceof Set
      ? tablesCreatedEarlierInBatch
      : new Set(tablesCreatedEarlierInBatch ?? []);
  const blocked = [];
  const warned = [];
  const exempted = [];

  for (const [id, pattern] of BLOCKED) {
    const match = stripped.match(pattern);
    if (!match) continue;

    if (createdEarlier.size > 0 && EXEMPTIBLE_ON_BATCH_CREATED_TABLE.has(id)) {
      const targets = targetsTripping(stripped, pattern);
      // Every statement that trips the rule must aim at a table this batch
      // created. One that does not is a real finding, and it does not stop
      // being one because it shares a file with an exempt sibling.
      if (targets.length > 0 && targets.every((table) => table !== null && createdEarlier.has(table))) {
        exempted.push({
          id,
          migration: name,
          excerpt: excerptOf(match[0]),
          table: targets[0],
        });
        continue;
      }
    }

    blocked.push({ id, migration: name, excerpt: excerptOf(match[0]) });
  }

  for (const [id, pattern] of WARNED) {
    const match = stripped.match(pattern);
    if (match) {
      warned.push({ id, migration: name, excerpt: excerptOf(match[0]) });
    }
  }

  return { blocked, warned, exempted };
}

/**
 * Gates a batch of pending migrations ([{name, sql}]).
 *
 * - blocked/warned: flattened findings across all pending migrations. A
 *   pending entry whose `sql` is undefined/null (migration.sql missing or
 *   unreadable off disk) becomes its own blocking finding
 *   (`unreadable-migration`) rather than being lint-checked as empty SQL —
 *   an unreadable migration must never look clean.
 * - ok: false when there is at least one blocked finding and allowDestructive
 *   is not set; true otherwise.
 * - overridden: when allowDestructive is set and there were blocked findings,
 *   this carries the same list that ok=false would otherwise have blocked on
 *   — an explicit, logged record that the gate was overridden rather than
 *   never having tripped.
 * - exempted: findings that would have blocked but for the batch-created-table
 *   exemption above. Reported for the same reason `overridden` is: a rule that
 *   stopped applying must say so, or the next reader cannot tell a gate that
 *   passed from a gate that was quietly narrowed.
 */
export function gateMigrations(pending, { allowDestructive = false } = {}) {
  const blocked = [];
  const warned = [];
  const exempted = [];
  // Evidence accumulated in apply order: what the migrations BEFORE the one
  // being linted have created. `pendingMigrations` sorts, and Prisma's folder
  // names are timestamp-prefixed, so the order this walks is the order the
  // database will run them in.
  const createdEarlier = new Set();

  for (const { name, sql } of pending ?? []) {
    if (sql === undefined || sql === null) {
      blocked.push({
        id: 'unreadable-migration',
        migration: name,
        excerpt: '(no SQL content — migration.sql was missing or unreadable)',
      });
      // No evidence is taken from a file that could not be read.
      continue;
    }

    const findings = lintMigrationSql(name, sql, { tablesCreatedEarlierInBatch: createdEarlier });
    blocked.push(...findings.blocked);
    warned.push(...findings.warned);
    exempted.push(...findings.exempted);
    for (const table of tablesCreatedBy(sql)) createdEarlier.add(table);
  }

  const overridden = allowDestructive && blocked.length > 0 ? blocked : [];
  const ok = !(blocked.length > 0 && !allowDestructive);

  return { ok, blocked, warned, overridden, exempted };
}
