// =============================================================================
// Blue-green backup and restore-drill primitives (Task 7)
// =============================================================================
//
// The owner retired the appliance's proven `scripts/postgres-backup.mjs`
// recovery machinery in favour of this lighter, compose-native pair for the
// blue-green engine. This module is the safety net: a pre-migration backup
// (database dump + documents volume tar, sha256-manifested) and a restore
// drill that PROVES the dump restores cleanly and the documents survive
// byte-for-byte — entirely against THROWAWAY containers, never the live db.
//
// -----------------------------------------------------------------------------
// The row-census race (read before touching runBackup/runRestoreDrill)
// -----------------------------------------------------------------------------
// In this engine's phase order, `runBackup` runs BEFORE the deploy quiesces
// the scheduler/job singletons (Task 8 phase 2 vs phase 7) — the app is
// still live-serving writes while the backup runs. `runBackup` therefore
// takes its row census IMMEDIATELY BEFORE `pg_dump`, not after, to keep that
// race window as small as it can be — but it is still a NEAR-IN-TIME
// reference, never a same-transaction snapshot. `runRestoreDrill`'s
// comparison against that census is EXACT (zero tolerance) by default; set
// `BLUEGREEN_DRILL_CENSUS_TOLERANCE` (ctx.env, a non-negative integer
// "rows per table" allowance) only when the backup being drilled is KNOWN
// to have been taken while the app was still live-serving — i.e. widen it
// deliberately, per-invocation, never as a new silent default. Leave it at
// 0 for a backup taken while genuinely quiesced (e.g. a manual pre-
// maintenance backup).
//
// -----------------------------------------------------------------------------
// ctx shape (shared by runBackup and runRestoreDrill)
// -----------------------------------------------------------------------------
// {
//   runCommand: async (command, options?) => { stdout: string }
//     - command is the full argv array, e.g. ['docker', 'compose', ...].
//     - options.env, when given, is the process env for the child.
//     - options.outputFile, when given, means "write the command's raw
//       stdout bytes to this path atomically" (used for pg_dump and the
//       documents tar, both binary); the resolved value's `stdout` may be
//       '' in that case. Text-returning commands (row census, pg_restore,
//       the hash listings) omit outputFile and rely on the resolved
//       `stdout` string.
//     - MUST throw (reject) when the command exits non-zero. Never silently
//       swallow a failure — runBackup/runRestoreDrill rely on the throw to
//       short-circuit and (for the drill) still reach its diagnostics and
//       teardown steps.
//   stateDir: string — backups live under `${stateDir}/backups/<ISO-stamp>`.
//   envFile: string — the deployment's BLUEGREEN_ENV_FILE path. Merged into
//     every runCommand call's env as BLUEGREEN_ENV_FILE so the compose
//     file's `env_file: ${BLUEGREEN_ENV_FILE:?...}` interpolation resolves.
//     This is an environment VARIABLE, never a `--env-file` CLI flag — the
//     bluegreen compose file has no use for the latter.
//   composeArgs: string[] — inserted directly after `docker compose`, e.g.
//     ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen']. Task 8
//     owns the one place that sets this so every bluegreen compose
//     invocation across the engine (build/gate/up/backup/...) agrees.
//   env?: object — base env merged under BLUEGREEN_ENV_FILE (default
//     process.env). Also where BLUEGREEN_DRILL_CENSUS_TOLERANCE is read
//     from for runRestoreDrill (see the race note above).
//   now?: () => Date — clock injection (default () => new Date()).
//   databaseName?/databaseUser?: string — live db creds for pg_dump and the
//     row census (default 'charitypilot' / 'charitypilot').
//   documentsVolume?: string — the named volume to tar/verify (default
//     'charitypilot-bluegreen-documents').
//   commit?/activeColor?: string|null — recorded into the manifest's meta.
//   plan (runRestoreDrill only): a backupPlan(...)-shaped object identifying
//     which backup to drill (Task 8 passes the plan runBackup returned, or
//     one reconstructed from an existing backup directory name).
// }
// =============================================================================

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { DEFAULT_POSTGRES_IMAGE } from '../postgres-backup.mjs';
import { DOCUMENT_ARCHIVE_IMAGE } from '../personal-server.mjs';

const DEFAULT_DATABASE_NAME = 'charitypilot';
const DEFAULT_DATABASE_USER = 'charitypilot';
const DEFAULT_DOCUMENTS_VOLUME = 'charitypilot-bluegreen-documents';
const DRILL_DATABASE_NAME = 'charitypilot_drill';
const DRILL_DATABASE_USER = 'charitypilot_drill';
const DRILL_CONTAINER_PREFIX = 'charitypilot-bluegreen-drill-';
const MANIFEST_FORMAT = 'charitypilot-bluegreen-backup-manifest/v1';
const DUMP_ARTIFACT_NAME = 'database.dump';
const DOCUMENTS_ARTIFACT_NAME = 'documents.tar';
const MANIFEST_ARTIFACT_NAME = 'manifest.json';
const READINESS_MAX_ATTEMPTS = 120;
const READINESS_POLL_INTERVAL_MS = 1000;
// Two, not one: a single passing pg_isready can be the temporary bootstrap
// server official Postgres images run during a fresh initdb (see
// waitForDrillReadiness below) rather than the real server the restore
// actually needs.
const READINESS_REQUIRED_CONSECUTIVE_PASSES = 2;

// A single SELECT that returns an EXACT (not estimated/n_live_tup) row count
// for every ordinary table in the public schema, one `table=count` line per
// row via query_to_xml/xpath — works unmodified against both the live db
// (backup time) and the restored throwaway db (drill time), and needs no
// hardcoded table list that would drift as the schema grows.
const ROW_CENSUS_QUERY =
  "SELECT c.relname || '=' || " +
  "(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text " +
  'FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
  "WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname;";

// NUL-delimited end-to-end (`find -print0` -> `xargs -0`) so a filename
// containing spaces, or most other unusual bytes, hashes correctly;
// `sha256sum --` guards a name that starts with '-'. `set -o pipefail`
// (both alpine-based images used here provide ash with pipefail support)
// turns a `find` failure into an actual command failure instead of being
// swallowed by `sha256sum`'s own exit status. sha256sum's own output line
// is fixed-width (64 hex chars, two spaces, then the name), so we `cut` it
// rather than split on spaces — a name containing spaces still parses.
//
// Output order is NOT guaranteed (no sort stage) — verifyManifest compares
// entries by path in a Map, never by sequence, so this doesn't affect
// correctness.
//
// KNOWN LIMITATION: the tab/newline-delimited OUTPUT record format below
// cannot represent a path that itself contains a newline byte — the outer
// `read -r line` loop splits records on '\n'. Such a path is not expected
// from this platform's document storage naming and is not specially
// detected here.
function hashListingShellScript(dir) {
  return (
    `cd ${shQuote(dir)} && set -o pipefail && ` +
    'find . -type f -print0 | xargs -0 -r sha256sum -- | while IFS= read -r line; do ' +
    'h=$(printf "%s" "$line" | cut -c1-64); f=$(printf "%s" "$line" | cut -c67-); ' +
    's=$(wc -c < "$f"); printf "%s\\t%s\\t%s\\n" "$h" "$s" "${f#./}"; ' +
    'done'
  );
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseHashListing(stdout) {
  const entries = [];
  for (const rawLine of (stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const firstTab = line.indexOf('\t');
    const secondTab = line.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const sha256 = line.slice(0, firstTab);
    const bytes = Number.parseInt(line.slice(firstTab + 1, secondTab), 10);
    const path = line.slice(secondTab + 1);
    entries.push({ path, sha256, bytes: Number.isFinite(bytes) ? bytes : null });
  }
  return entries;
}

// Parses `psql -tAc` row-census output ("table=count" per line). Throws
// rather than silently returning a partial/empty map on ANY unparseable
// line — a query that broke (permission error, a typo'd column, psql
// printing "(0 rows)") must fail loudly, never be mistaken for a
// legitimately empty result.
function parseRowCensus(stdout) {
  const census = {};
  for (const rawLine of (stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq === -1) {
      throw new Error(`Row census output contained an unparseable line: ${JSON.stringify(line)}`);
    }
    const table = line.slice(0, eq);
    const countText = line.slice(eq + 1);
    if (!/^\d+$/.test(countText)) {
      throw new Error(`Row census output contained a non-numeric count for "${table}": ${JSON.stringify(countText)}`);
    }
    census[table] = Number.parseInt(countText, 10);
  }
  return census;
}

// Additionally refuses a census that parsed cleanly but produced ZERO
// tables — the schema has on the order of 30 tables, so zero means the
// query silently matched nothing (wrong schema, wrong role, a broken
// WHERE clause) rather than a legitimately empty database. This is the
// other half of the "vacuous green" fix: parseRowCensus alone would let a
// blank stdout through as `{}`, and `compareRowCensus({}, {})` would then
// report `ok: true` — this guard makes sure `{}` never reaches that
// comparison from either the backup or the drill side.
function parseRowCensusOrThrow(stdout, context) {
  const census = parseRowCensus(stdout);
  if (Object.keys(census).length === 0) {
    throw new Error(
      `Row census (${context}) produced zero tables — the census query likely failed silently or matched no relations; refusing to treat an empty census as valid`,
    );
  }
  return census;
}

/**
 * Pure comparison of two row-census maps ({table: count}). `tolerance`
 * (default 0, i.e. exact) is the maximum allowed |actual - expected| per
 * table before it counts as a mismatch — see the module header's race note
 * for when a caller should widen it. Returns { ok, mismatches }, where each
 * mismatch names the table, the expected/actual counts, and the signed
 * drift (`actual - expected`; `null` when a table is present on only one
 * side, since there's no meaningful delta to report).
 */
export function compareRowCensus(expected, actual, tolerance = 0) {
  const tables = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})]);
  const mismatches = [];
  for (const table of [...tables].sort()) {
    const expectedCount = expected?.[table] ?? null;
    const actualCount = actual?.[table] ?? null;
    if (expectedCount === null || actualCount === null) {
      if (expectedCount !== actualCount) {
        mismatches.push({ table, expected: expectedCount, actual: actualCount, drift: null });
      }
      continue;
    }
    const drift = actualCount - expectedCount;
    if (Math.abs(drift) > tolerance) {
      mismatches.push({ table, expected: expectedCount, actual: actualCount, drift });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function censusToleranceFrom(ctx) {
  const raw = (ctx.env ?? process.env)?.BLUEGREEN_DRILL_CENSUS_TOLERANCE;
  if (raw === undefined || raw === null || raw === '') return 0;
  const trimmed = String(raw).trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!/^\d+$/.test(trimmed) || !Number.isFinite(parsed)) {
    throw new Error(`BLUEGREEN_DRILL_CENSUS_TOLERANCE must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function sha256File(filePath) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolvePromise({ sha256: hash.digest('hex'), bytes }));
  });
}

/**
 * Pure. Computes the on-disk layout for one backup taken at `now`.
 */
export function backupPlan({ stateDir, now }) {
  const timestamp = now instanceof Date ? now : new Date(now);
  const stamp = timestamp.toISOString().replace(/[:.]/g, '-');
  const dir = join(stateDir, 'backups', stamp);
  return {
    dir,
    dumpFile: join(dir, DUMP_ARTIFACT_NAME),
    documentsTar: join(dir, DOCUMENTS_ARTIFACT_NAME),
    manifestFile: join(dir, MANIFEST_ARTIFACT_NAME),
  };
}

/**
 * Pure. Builds the manifest object written alongside a backup's artifacts.
 * `entries` is `[{path, sha256, bytes}]`; `meta` carries at least
 * `{commit, activeColor, createdAt}` and may carry extra fields (this
 * module adds `rowCensus`).
 */
export function buildManifest(entries, meta) {
  return {
    format: MANIFEST_FORMAT,
    meta: { ...meta },
    entries: (entries ?? []).map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      bytes: entry.bytes,
    })),
  };
}

/**
 * Pure. Compares a manifest's recorded entries against a freshly recomputed
 * set (same shape as `buildManifest`'s `entries`), keyed by `path`. Returns
 * { ok, missing, mismatched, extra }:
 *   - missing: paths the manifest records that recomputedEntries lacks.
 *   - mismatched: paths present in both whose sha256 or bytes differ
 *     (each `{path, expected: {sha256, bytes}, actual: {sha256, bytes}}`).
 *   - extra: paths recomputedEntries has that the manifest never recorded.
 *   - ok: true iff all three arrays are empty.
 */
export function verifyManifest(manifest, recomputedEntries) {
  const manifestByPath = new Map((manifest?.entries ?? []).map((entry) => [entry.path, entry]));
  const recomputedByPath = new Map((recomputedEntries ?? []).map((entry) => [entry.path, entry]));

  const missing = [];
  const mismatched = [];
  for (const [path, expected] of manifestByPath) {
    const actual = recomputedByPath.get(path);
    if (!actual) {
      missing.push(path);
      continue;
    }
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      mismatched.push({
        path,
        expected: { sha256: expected.sha256, bytes: expected.bytes },
        actual: { sha256: actual.sha256, bytes: actual.bytes },
      });
    }
  }

  const extra = [...recomputedByPath.keys()].filter((path) => !manifestByPath.has(path)).sort();

  return {
    ok: missing.length === 0 && mismatched.length === 0 && extra.length === 0,
    missing: missing.sort(),
    mismatched,
    extra,
  };
}

/**
 * Pure. `existingDirs` is `[{name, mtime}]` (mtime: Date or epoch ms).
 * Returns the `name`s of directories strictly older than `keepDays` as of
 * `now` — a directory exactly `keepDays` old is kept (the boundary is
 * exclusive on the delete side).
 */
export function retentionPlan(existingDirs, keepDays, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const cutoffMs = nowMs - keepDays * 24 * 60 * 60 * 1000;
  return (existingDirs ?? [])
    .filter((entry) => {
      const mtimeMs = entry.mtime instanceof Date ? entry.mtime.getTime() : new Date(entry.mtime).getTime();
      return mtimeMs < cutoffMs;
    })
    .map((entry) => entry.name);
}

function composePrefix(ctx) {
  return ['docker', 'compose', ...(ctx.composeArgs ?? [])];
}

function commandEnv(ctx, extra = {}) {
  return {
    ...(ctx.env ?? process.env),
    BLUEGREEN_ENV_FILE: ctx.envFile,
    ...extra,
  };
}

function pgDumpCommand(ctx) {
  return [
    ...composePrefix(ctx),
    'exec',
    '-T',
    'db',
    'pg_dump',
    '-U',
    ctx.databaseUser ?? DEFAULT_DATABASE_USER,
    '-d',
    ctx.databaseName ?? DEFAULT_DATABASE_NAME,
    '-Fc',
    '--no-owner',
    '--no-privileges',
  ];
}

function liveRowCensusCommand(ctx) {
  return [
    ...composePrefix(ctx),
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    ctx.databaseUser ?? DEFAULT_DATABASE_USER,
    '-d',
    ctx.databaseName ?? DEFAULT_DATABASE_NAME,
    '-tAc',
    ROW_CENSUS_QUERY,
  ];
}

function documentsTarCommand(ctx) {
  return [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--mount',
    `type=volume,src=${ctx.documentsVolume ?? DEFAULT_DOCUMENTS_VOLUME},dst=/documents,readonly`,
    DOCUMENT_ARCHIVE_IMAGE,
    'tar',
    '-cf',
    '-',
    '-C',
    '/documents',
    '.',
  ];
}

function documentsHashCommand(ctx) {
  return [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--mount',
    `type=volume,src=${ctx.documentsVolume ?? DEFAULT_DOCUMENTS_VOLUME},dst=/documents,readonly`,
    DOCUMENT_ARCHIVE_IMAGE,
    'sh',
    '-c',
    hashListingShellScript('/documents'),
  ];
}

/**
 * Orchestrates a pre-migration backup: a live row census (taken first, to
 * minimise the race window — see the module header), pg_dump -Fc of the
 * live compose `db` service, a tar of the documents volume, a per-document
 * sha256 hash listing, and a manifest recording all of it — including the
 * dump's and the tar's OWN hashes, so a half-written artifact is detectable
 * at rest without ever running a drill. Never runs a single command that
 * could mutate the live db (read-only pg_dump, read-only documents mount).
 */
export async function runBackup(ctx) {
  const plan = backupPlan({ stateDir: ctx.stateDir, now: ctx.now ? ctx.now() : new Date() });
  mkdirSync(plan.dir, { recursive: true, mode: 0o700 });

  const censusResult = await ctx.runCommand(liveRowCensusCommand(ctx), { env: commandEnv(ctx) });
  const rowCensus = parseRowCensusOrThrow(censusResult?.stdout, 'live db');

  await ctx.runCommand(pgDumpCommand(ctx), { env: commandEnv(ctx), outputFile: plan.dumpFile });
  const dumpEntry = { path: DUMP_ARTIFACT_NAME, ...(await sha256File(plan.dumpFile)) };

  await ctx.runCommand(documentsTarCommand(ctx), { env: commandEnv(ctx), outputFile: plan.documentsTar });
  const documentsTarEntry = { path: DOCUMENTS_ARTIFACT_NAME, ...(await sha256File(plan.documentsTar)) };

  const hashResult = await ctx.runCommand(documentsHashCommand(ctx), { env: commandEnv(ctx) });
  const documentEntries = parseHashListing(hashResult?.stdout);

  const manifest = buildManifest([dumpEntry, documentsTarEntry, ...documentEntries], {
    commit: ctx.commit ?? null,
    activeColor: ctx.activeColor ?? null,
    createdAt: new Date().toISOString(),
    rowCensus,
  });

  writeFileSync(plan.manifestFile, JSON.stringify(manifest, null, 2));

  return { plan, manifest };
}

function drillContainerName(ctx) {
  const stamp = ctx.now ? ctx.now().getTime() : Date.now();
  const suffix = ctx.randomId ? ctx.randomId() : randomBytes(4).toString('hex');
  return `${DRILL_CONTAINER_PREFIX}${stamp}-${suffix}`;
}

// The data directory is an ANONYMOUS volume (a bare container path, no host
// source), not a size-capped tmpfs: an artificial size cap is exactly the
// kind of thing that makes a drill fail precisely when the real database
// has grown enough for the drill to matter most. `docker rm -f -v` (see
// drillTeardownCommand) already reclaims anonymous volumes on cleanup, so
// this doesn't leak disk between drills.
function drillStartCommand(containerName, dumpDir) {
  return [
    'docker',
    'run',
    '-d',
    '--name',
    containerName,
    '--network',
    'none',
    '-v',
    '/var/lib/postgresql/data',
    '-v',
    `${dumpDir}:/backup:ro`,
    '-e',
    'POSTGRES_USER',
    '-e',
    'POSTGRES_PASSWORD',
    '-e',
    'POSTGRES_DB',
    DEFAULT_POSTGRES_IMAGE,
  ];
}

// One single-shot pg_isready probe per attempt (unlike scripts/personal-
// server.mjs's waitForRecoveryDatabase, which loops entirely inside one
// recorded shell command) — waitForDrillReadiness below drives the retry
// loop from JS instead, so it can require several consecutive passes rather
// than trusting the first one.
function drillReadinessProbeCommand(containerName) {
  return ['docker', 'exec', containerName, 'pg_isready', '-U', DRILL_DATABASE_USER, '-d', DRILL_DATABASE_NAME];
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `docker run -d` returns as soon as the container is CREATED; initdb
// inside a fresh postgres image still takes real seconds, so a single
// pg_isready probe reliably fails against real docker at first — that part
// is unchanged. What a single PASSING probe cannot rule out: official
// Postgres images perform a two-phase startup on a truly fresh (anonymous-
// volume) initdb — a temporary server accepts connections just long enough
// to run init scripts, then shuts down completely before the real server
// starts listening. `pg_isready` can catch that temporary server's socket,
// report ready, and hand control back to a restore that then races the
// shutdown/restart window and fails with "no such file or directory" even
// though the poll "passed". Requiring READINESS_REQUIRED_CONSECUTIVE_PASSES
// consecutive passes (across the existing 1-second interval) makes that
// impossible: the temporary server is gone well before two probes a second
// apart could both land inside its brief window. A single failing probe
// resets the streak to zero, so one flaky miss can't be "covered" by an
// earlier pass from the temp server. Same overall attempt budget as before;
// the timeout error additionally carries the last probe's own error text,
// so a genuinely dead container reports why it never looked ready instead
// of only the generic attempt-budget message.
export async function waitForDrillReadiness(ctx, containerName, env) {
  let consecutivePasses = 0;
  // Retained so a timeout can report WHY the container never looked ready
  // (e.g. "no such file or directory" during the postgres restart window)
  // instead of just the generic attempt-budget message — a container that
  // is genuinely dead otherwise burns the full ~120s poll and reports
  // nothing more useful than "timed out".
  let lastProbeError = null;

  for (let attempt = 1; attempt <= READINESS_MAX_ATTEMPTS; attempt += 1) {
    let passed = true;
    try {
      await ctx.runCommand(drillReadinessProbeCommand(containerName), { env });
      lastProbeError = null;
    } catch (error) {
      passed = false;
      lastProbeError = error;
    }

    consecutivePasses = passed ? consecutivePasses + 1 : 0;
    if (consecutivePasses >= READINESS_REQUIRED_CONSECUTIVE_PASSES) return;

    if (attempt < READINESS_MAX_ATTEMPTS) {
      await (ctx.sleep ? ctx.sleep(READINESS_POLL_INTERVAL_MS) : defaultSleep(READINESS_POLL_INTERVAL_MS));
    }
  }

  const lastProbeErrorText =
    lastProbeError instanceof Error
      ? lastProbeError.message
      : lastProbeError === null
        ? "the final probe attempt passed in isolation (never twice in a row)"
        : String(lastProbeError);

  throw new Error(
    `Restore drill readiness poll timed out after ${READINESS_MAX_ATTEMPTS} attempts (requires ${READINESS_REQUIRED_CONSECUTIVE_PASSES} consecutive successful pg_isready checks); last probe error: ${lastProbeErrorText}`,
  );
}

function drillRestoreCommand(containerName, dumpFileName) {
  return [
    'docker',
    'exec',
    containerName,
    'pg_restore',
    '-U',
    DRILL_DATABASE_USER,
    '-d',
    DRILL_DATABASE_NAME,
    '--clean',
    '--if-exists',
    // --exit-on-error (mirrors personal-server.mjs's restore) and
    // --single-transaction (mirrors postgres-backup.mjs's restore) together:
    // without them pg_restore's default behaviour is to log a per-object
    // error and KEEP GOING, so a partially-lost restore still exits 0 — the
    // exact silent-half-restore failure mode this drill exists to catch.
    '--exit-on-error',
    '--single-transaction',
    '--no-owner',
    '--no-privileges',
    `/backup/${dumpFileName}`,
  ];
}

function drillRowCensusCommand(containerName) {
  return ['docker', 'exec', containerName, 'psql', '-U', DRILL_DATABASE_USER, '-d', DRILL_DATABASE_NAME, '-tAc', ROW_CENSUS_QUERY];
}

function drillDocumentsExtractAndHashCommand(containerName, tarFileName) {
  return [
    'docker',
    'exec',
    containerName,
    'sh',
    '-c',
    `mkdir -p /drill-documents && tar -xf /backup/${tarFileName} -C /drill-documents && ${hashListingShellScript('/drill-documents')}`,
  ];
}

// Best-effort operator diagnostics: `docker logs` on a drill container that
// failed initdb, refused the restore, etc. is exactly what a human needs
// and the container is about to be force-removed. Only ever invoked from
// the failure path, immediately before teardown.
function drillLogsCommand(containerName) {
  return ['docker', 'logs', containerName];
}

function drillTeardownCommand(containerName) {
  return ['docker', 'rm', '-f', '-v', containerName];
}

/**
 * Restores the most recent backup's dump into a THROWAWAY, network-isolated
 * container (never the live compose `db`), takes a row census and compares
 * it against the manifest's recorded live census (see the module header for
 * the race this comparison is exact-by-default against), and re-verifies
 * every manifested file's sha256 — the on-disk dump, the on-disk documents
 * tar, and every document extracted from that tar — against a freshly
 * recomputed set, catching both silent corruption of the retained backup
 * and a restore that silently drops or duplicates data. Refuses outright
 * (before touching docker at all) a manifest with no entries or an empty/
 * absent row census — those are exactly the shapes a silently-broken
 * backup produces, and drilling them would always pass vacuously. On any
 * failure once the scratch container exists, `docker logs` is captured for
 * operator diagnostics before the container is force-removed in a
 * `finally` that runs regardless of which step failed.
 */
export async function runRestoreDrill(ctx) {
  const plan = ctx.plan;
  const manifest = JSON.parse(readFileSync(plan.manifestFile, 'utf8'));

  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error('Restore drill refuses a manifest with no entries — nothing to verify a restore against');
  }
  if (!manifest.meta?.rowCensus || Object.keys(manifest.meta.rowCensus).length === 0) {
    throw new Error('Restore drill refuses a manifest with an empty or absent row census — nothing to compare the restored db against');
  }

  const dumpEntry = { path: DUMP_ARTIFACT_NAME, ...(await sha256File(plan.dumpFile)) };
  const documentsTarEntry = { path: DOCUMENTS_ARTIFACT_NAME, ...(await sha256File(plan.documentsTar)) };

  const tolerance = censusToleranceFrom(ctx);
  const containerName = drillContainerName(ctx);
  const env = commandEnv(ctx, {
    POSTGRES_USER: DRILL_DATABASE_USER,
    POSTGRES_PASSWORD: ctx.randomPassword ? ctx.randomPassword() : randomBytes(32).toString('base64url'),
    POSTGRES_DB: DRILL_DATABASE_NAME,
  });

  try {
    await ctx.runCommand(drillStartCommand(containerName, dirname(plan.dumpFile)), { env });
    await waitForDrillReadiness(ctx, containerName, env);
    await ctx.runCommand(drillRestoreCommand(containerName, basename(plan.dumpFile)), { env });

    const censusResult = await ctx.runCommand(drillRowCensusCommand(containerName), { env });
    const restoredRowCensus = parseRowCensusOrThrow(censusResult?.stdout, 'restored drill db');
    const censusComparison = compareRowCensus(manifest.meta.rowCensus, restoredRowCensus, tolerance);
    if (!censusComparison.ok) {
      throw new Error(
        `Restore drill row census mismatch (tolerance=${tolerance}): ${censusComparison.mismatches
          .map((m) => `${m.table} expected=${m.expected} actual=${m.actual}${m.drift === null ? '' : ` drift=${m.drift}`}`)
          .join(', ')}`,
      );
    }

    const hashResult = await ctx.runCommand(drillDocumentsExtractAndHashCommand(containerName, basename(plan.documentsTar)), { env });
    const restoredDocumentEntries = parseHashListing(hashResult?.stdout);

    const manifestVerification = verifyManifest(manifest, [dumpEntry, documentsTarEntry, ...restoredDocumentEntries]);
    if (!manifestVerification.ok) {
      throw new Error(
        `Restore drill manifest verification failed: missing=${manifestVerification.missing.join(', ') || 'none'}; ` +
          `mismatched=${manifestVerification.mismatched.map((m) => m.path).join(', ') || 'none'}; ` +
          `extra=${manifestVerification.extra.join(', ') || 'none'}`,
      );
    }

    return { ok: true, rowCensus: restoredRowCensus, manifestVerification };
  } catch (error) {
    try {
      await ctx.runCommand(drillLogsCommand(containerName), { env });
    } catch (logsError) {
      console.error(
        `Restore drill diagnostics collection for ${containerName} failed: ${logsError instanceof Error ? logsError.message : String(logsError)}`,
      );
    }
    throw error;
  } finally {
    // Best-effort: a teardown failure must never mask whatever error (if
    // any) is already propagating out of the try block above — it only
    // gets to add a warning, never to replace the real failure.
    try {
      await ctx.runCommand(drillTeardownCommand(containerName), { env });
    } catch (teardownError) {
      console.error(
        `Restore drill teardown for ${containerName} failed: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`,
      );
    }
  }
}
