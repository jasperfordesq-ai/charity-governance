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
//       short-circuit and (for the drill) still reach its `finally` teardown.
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
//     process.env).
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

// POSIX-sh (busybox ash in alpine, or bash in the postgres image) one-liner:
// for every regular file under the given directory, print
// `<sha256>\t<bytes>\t<relative-path>\n`, sorted for determinism. Tab-
// separated so a path containing spaces still parses correctly (path is
// whatever remains after the first two tabs).
function hashListingShellScript(dir) {
  return (
    `cd ${shQuote(dir)} && find . -type f | LC_ALL=C sort | while IFS= read -r f; do ` +
    'h=$(sha256sum "$f" | cut -d" " -f1); s=$(wc -c < "$f"); ' +
    'printf "%s\\t%s\\t%s\\n" "$h" "$s" "${f#./}"; ' +
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

function parseRowCensus(stdout) {
  const census = {};
  for (const rawLine of (stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const table = line.slice(0, eq);
    const count = Number.parseInt(line.slice(eq + 1), 10);
    census[table] = Number.isFinite(count) ? count : null;
  }
  return census;
}

/**
 * Pure comparison of two row-census maps ({table: count}). Returns
 * { ok, mismatches }, where each mismatch names the table plus the expected
 * and actual counts (null when a table is present on only one side).
 */
export function compareRowCensus(expected, actual) {
  const tables = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})]);
  const mismatches = [];
  for (const table of [...tables].sort()) {
    const expectedCount = expected?.[table] ?? null;
    const actualCount = actual?.[table] ?? null;
    if (expectedCount !== actualCount) {
      mismatches.push({ table, expected: expectedCount, actual: actualCount });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
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
 * Orchestrates a pre-migration backup: pg_dump -Fc of the live compose `db`
 * service, a tar of the documents volume, a per-document sha256 hash
 * listing, and a manifest recording all of it plus a live row census. Never
 * runs a single command that could mutate the live db (read-only pg_dump,
 * read-only documents mount).
 */
export async function runBackup(ctx) {
  const plan = backupPlan({ stateDir: ctx.stateDir, now: ctx.now ? ctx.now() : new Date() });
  mkdirSync(plan.dir, { recursive: true, mode: 0o700 });

  await ctx.runCommand(pgDumpCommand(ctx), { env: commandEnv(ctx), outputFile: plan.dumpFile });
  const dumpEntry = { path: DUMP_ARTIFACT_NAME, ...(await sha256File(plan.dumpFile)) };

  const censusResult = await ctx.runCommand(liveRowCensusCommand(ctx), { env: commandEnv(ctx) });
  const rowCensus = parseRowCensus(censusResult?.stdout);

  await ctx.runCommand(documentsTarCommand(ctx), { env: commandEnv(ctx), outputFile: plan.documentsTar });
  const hashResult = await ctx.runCommand(documentsHashCommand(ctx), { env: commandEnv(ctx) });
  const documentEntries = parseHashListing(hashResult?.stdout);

  const manifest = buildManifest([dumpEntry, ...documentEntries], {
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

function drillStartCommand(containerName, dumpDir, password) {
  return [
    'docker',
    'run',
    '-d',
    '--name',
    containerName,
    '--network',
    'none',
    '--tmpfs',
    '/var/lib/postgresql/data:rw,noexec,nosuid,size=4g',
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

function drillReadinessCommand(containerName) {
  return ['docker', 'exec', containerName, 'pg_isready', '-U', DRILL_DATABASE_USER, '-d', DRILL_DATABASE_NAME];
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

function drillTeardownCommand(containerName) {
  return ['docker', 'rm', '-f', '-v', containerName];
}

/**
 * Restores the most recent backup's dump into a THROWAWAY, network-isolated
 * container (never the live compose `db`), takes a row census and compares
 * it against the manifest's recorded live census, and re-verifies every
 * manifested file's sha256 (the on-disk dump plus every document extracted
 * from the tar) against a freshly recomputed set — catching both silent
 * corruption of the retained backup and a restore that silently drops or
 * duplicates data. The scratch container is force-removed in a `finally`
 * regardless of which step failed.
 */
export async function runRestoreDrill(ctx) {
  const plan = ctx.plan;
  const manifest = JSON.parse(readFileSync(plan.manifestFile, 'utf8'));

  const dumpEntry = { path: DUMP_ARTIFACT_NAME, ...(await sha256File(plan.dumpFile)) };

  const containerName = drillContainerName(ctx);
  const password = ctx.randomPassword ? ctx.randomPassword() : randomBytes(32).toString('base64url');
  const env = commandEnv(ctx, {
    POSTGRES_USER: DRILL_DATABASE_USER,
    POSTGRES_PASSWORD: password,
    POSTGRES_DB: DRILL_DATABASE_NAME,
  });

  try {
    await ctx.runCommand(drillStartCommand(containerName, dirname(plan.dumpFile), password), { env });
    await ctx.runCommand(drillReadinessCommand(containerName), { env });
    await ctx.runCommand(drillRestoreCommand(containerName, basename(plan.dumpFile)), { env });

    const censusResult = await ctx.runCommand(drillRowCensusCommand(containerName), { env });
    const restoredRowCensus = parseRowCensus(censusResult?.stdout);
    const censusComparison = compareRowCensus(manifest.meta?.rowCensus, restoredRowCensus);
    if (!censusComparison.ok) {
      throw new Error(
        `Restore drill row census mismatch: ${censusComparison.mismatches
          .map((m) => `${m.table} expected=${m.expected} actual=${m.actual}`)
          .join(', ')}`,
      );
    }

    const hashResult = await ctx.runCommand(drillDocumentsExtractAndHashCommand(containerName, basename(plan.documentsTar)), { env });
    const restoredDocumentEntries = parseHashListing(hashResult?.stdout);

    const manifestVerification = verifyManifest(manifest, [dumpEntry, ...restoredDocumentEntries]);
    if (!manifestVerification.ok) {
      throw new Error(
        `Restore drill manifest verification failed: missing=${manifestVerification.missing.join(', ') || 'none'}; ` +
          `mismatched=${manifestVerification.mismatched.map((m) => m.path).join(', ') || 'none'}; ` +
          `extra=${manifestVerification.extra.join(', ') || 'none'}`,
      );
    }

    return { ok: true, rowCensus: restoredRowCensus, manifestVerification };
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
