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

import { readdirSync } from 'node:fs';

// Rules are checked against comment-stripped SQL, case-insensitively. Each
// rule is a single regex matched with .match() (not /g — we only need to know
// whether a rule fires, plus one excerpt for the report).
const BLOCKED = [
  ['drop-table', /\bDROP\s+TABLE\b/i],
  ['drop-column', /\bALTER\s+TABLE\b[\s\S]{0,300}?\bDROP\s+COLUMN\b/i],
  ['truncate', /\bTRUNCATE\b/i],
  ['rename-table', /\bALTER\s+TABLE\b[\s\S]{0,200}?\bRENAME\s+TO\b/i],
  ['rename-column', /\bALTER\s+TABLE\b[\s\S]{0,300}?\bRENAME\s+COLUMN\b/i],
  ['alter-column-type', /\bALTER\s+TABLE\b[\s\S]{0,300}?\bALTER\s+COLUMN\b[\s\S]{0,120}?\bTYPE\b/i],
  ['set-not-null', /\bALTER\s+TABLE\b[\s\S]{0,300}?\bSET\s+NOT\s+NULL\b/i],
];

const WARNED = [
  // SHARE lock blocks writes for the build duration; fine at current volume,
  // this warning is future-you's reminder. CONCURRENTLY is the allowed form.
  ['create-index-non-concurrent', /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/i],
  // A constraint added without NOT VALID is validated synchronously against
  // every existing row while holding a lock the old colour's writers can hit.
  // NOT VALID defers that scan to a later, explicit VALIDATE CONSTRAINT.
  // The lookahead window (150 chars after CHECK/FOREIGN KEY) is sized to
  // clear a realistic constraint expression or FK reference clause before
  // giving up on finding a trailing NOT VALID.
  ['validating-constraint', /\bADD\s+CONSTRAINT\b[\s\S]{0,200}?\b(?:CHECK|FOREIGN\s+KEY)\b(?![\s\S]{0,150}?\bNOT\s+VALID\b)/i],
];

const EXCERPT_MAX = 160;

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function excerptOf(matchText) {
  const collapsed = matchText.replace(/\s+/g, ' ').trim();
  return collapsed.length > EXCERPT_MAX ? `${collapsed.slice(0, EXCERPT_MAX)}…` : collapsed;
}

/**
 * Pending migrations = release directory's migration folder names minus the
 * ones the live database already reports as applied, sorted ascending
 * (Prisma migration folder names are timestamp-prefixed, so sort order is
 * apply order).
 */
export function pendingMigrations(releaseMigrationsDir, appliedNames) {
  const applied = new Set(appliedNames ?? []);
  const names = readdirSync(releaseMigrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !applied.has(name));
  return names.sort();
}

/**
 * Lints one migration's SQL against the BLOCKED/WARNED vocabulary above.
 * Returns { blocked, warned }, each an array of { id, migration, excerpt }.
 */
export function lintMigrationSql(name, sql) {
  const stripped = stripComments(sql ?? '');
  const blocked = [];
  const warned = [];

  for (const [id, pattern] of BLOCKED) {
    const match = stripped.match(pattern);
    if (match) {
      blocked.push({ id, migration: name, excerpt: excerptOf(match[0]) });
    }
  }

  for (const [id, pattern] of WARNED) {
    const match = stripped.match(pattern);
    if (match) {
      warned.push({ id, migration: name, excerpt: excerptOf(match[0]) });
    }
  }

  return { blocked, warned };
}

/**
 * Gates a batch of pending migrations ([{name, sql}]).
 *
 * - blocked/warned: flattened findings across all pending migrations.
 * - ok: false when there is at least one blocked finding and allowDestructive
 *   is not set; true otherwise.
 * - overridden: when allowDestructive is set and there were blocked findings,
 *   this carries the same list that ok=false would otherwise have blocked on
 *   — an explicit, logged record that the gate was overridden rather than
 *   never having tripped.
 */
export function gateMigrations(pending, { allowDestructive = false } = {}) {
  const blocked = [];
  const warned = [];

  for (const { name, sql } of pending ?? []) {
    const findings = lintMigrationSql(name, sql);
    blocked.push(...findings.blocked);
    warned.push(...findings.warned);
  }

  const overridden = allowDestructive && blocked.length > 0 ? blocked : [];
  const ok = !(blocked.length > 0 && !allowDestructive);

  return { ok, blocked, warned, overridden };
}
