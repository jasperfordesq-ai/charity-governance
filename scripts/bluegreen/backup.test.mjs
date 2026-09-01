import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const backupScriptPath = join(scriptsDir, 'backup.mjs');

async function loadBackupModule() {
  assert.ok(existsSync(backupScriptPath), 'scripts/bluegreen/backup.mjs must exist');
  return import(pathToFileURL(backupScriptPath).href);
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function commandLine(command) {
  return command.join(' ');
}

// -----------------------------------------------------------------------------
// Pure functions
// -----------------------------------------------------------------------------

test('backupPlan lays out one stamped directory under stateDir/backups', async () => {
  const { backupPlan } = await loadBackupModule();
  const now = new Date('2026-08-31T12:34:56.789Z');
  const plan = backupPlan({ stateDir: '/state', now });

  const expectedStamp = '2026-08-31T12-34-56-789Z';
  assert.equal(plan.dir, join('/state', 'backups', expectedStamp));
  assert.equal(plan.dumpFile, join(plan.dir, 'database.dump'));
  assert.equal(plan.documentsTar, join(plan.dir, 'documents.tar'));
  assert.equal(plan.manifestFile, join(plan.dir, 'manifest.json'));
});

test('backupPlan accepts a plain Date-constructible value for now', async () => {
  const { backupPlan } = await loadBackupModule();
  const plan = backupPlan({ stateDir: '/state', now: '2026-01-01T00:00:00.000Z' });
  assert.equal(plan.dir, join('/state', 'backups', '2026-01-01T00-00-00-000Z'));
});

test('buildManifest carries meta and normalises entries to {path, sha256, bytes}', async () => {
  const { buildManifest } = await loadBackupModule();
  const manifest = buildManifest(
    [{ path: 'database.dump', sha256: 'aa', bytes: 10, extraneous: 'dropped' }],
    { commit: 'abc123', activeColor: 'blue', createdAt: '2026-08-31T00:00:00.000Z' },
  );

  assert.equal(manifest.meta.commit, 'abc123');
  assert.equal(manifest.meta.activeColor, 'blue');
  assert.equal(manifest.meta.createdAt, '2026-08-31T00:00:00.000Z');
  assert.deepEqual(manifest.entries, [{ path: 'database.dump', sha256: 'aa', bytes: 10 }]);
  assert.equal(manifest.entries[0].extraneous, undefined);
});

test('verifyManifest round-trips clean when recomputed entries exactly match', async () => {
  const { buildManifest, verifyManifest } = await loadBackupModule();
  const entries = [
    { path: 'database.dump', sha256: 'aa', bytes: 10 },
    { path: 'org/doc.pdf', sha256: 'bb', bytes: 20 },
  ];
  const manifest = buildManifest(entries, { commit: 'c', activeColor: 'blue', createdAt: 'now' });

  const result = verifyManifest(manifest, entries.map((e) => ({ ...e })));
  assert.deepEqual(result, { ok: true, missing: [], mismatched: [], extra: [] });
});

test('verifyManifest catches a flipped byte (sha256 differs) as mismatched', async () => {
  const { buildManifest, verifyManifest } = await loadBackupModule();
  const manifest = buildManifest([{ path: 'org/doc.pdf', sha256: 'bb', bytes: 20 }], {
    commit: 'c',
    activeColor: 'blue',
    createdAt: 'now',
  });

  const result = verifyManifest(manifest, [{ path: 'org/doc.pdf', sha256: 'cc', bytes: 20 }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, []);
  assert.equal(result.mismatched.length, 1);
  assert.equal(result.mismatched[0].path, 'org/doc.pdf');
  assert.equal(result.mismatched[0].expected.sha256, 'bb');
  assert.equal(result.mismatched[0].actual.sha256, 'cc');
});

test('verifyManifest catches a missing file', async () => {
  const { buildManifest, verifyManifest } = await loadBackupModule();
  const manifest = buildManifest(
    [
      { path: 'database.dump', sha256: 'aa', bytes: 10 },
      { path: 'org/doc.pdf', sha256: 'bb', bytes: 20 },
    ],
    { commit: 'c', activeColor: 'blue', createdAt: 'now' },
  );

  const result = verifyManifest(manifest, [{ path: 'database.dump', sha256: 'aa', bytes: 10 }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['org/doc.pdf']);
  assert.deepEqual(result.mismatched, []);
  assert.deepEqual(result.extra, []);
});

test('verifyManifest catches an extra file', async () => {
  const { buildManifest, verifyManifest } = await loadBackupModule();
  const manifest = buildManifest([{ path: 'database.dump', sha256: 'aa', bytes: 10 }], {
    commit: 'c',
    activeColor: 'blue',
    createdAt: 'now',
  });

  const result = verifyManifest(manifest, [
    { path: 'database.dump', sha256: 'aa', bytes: 10 },
    { path: 'org/unexpected.pdf', sha256: 'zz', bytes: 5 },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.mismatched, []);
  assert.deepEqual(result.extra, ['org/unexpected.pdf']);
});

test('retentionPlan keeps a directory exactly keepDays old and deletes one older', async () => {
  const { retentionPlan } = await loadBackupModule();
  const now = new Date('2026-08-31T00:00:00.000Z');
  const oneDayMs = 24 * 60 * 60 * 1000;
  const keepDays = 14;

  const exactlyAtBoundary = new Date(now.getTime() - keepDays * oneDayMs);
  const justPastBoundary = new Date(now.getTime() - keepDays * oneDayMs - 1);
  const wellWithinRetention = new Date(now.getTime() - oneDayMs);

  const existingDirs = [
    { name: 'boundary', mtime: exactlyAtBoundary },
    { name: 'past-boundary', mtime: justPastBoundary },
    { name: 'recent', mtime: wellWithinRetention },
  ];

  const result = retentionPlan(existingDirs, keepDays, now);
  assert.deepEqual(result, ['past-boundary']);
});

test('retentionPlan accepts epoch-ms mtimes and returns an empty plan when nothing qualifies', async () => {
  const { retentionPlan } = await loadBackupModule();
  const now = new Date('2026-08-31T00:00:00.000Z');
  const result = retentionPlan([{ name: 'today', mtime: now.getTime() }], 14, now);
  assert.deepEqual(result, []);
});

test('compareRowCensus matches identical censuses and flags a mismatch with expected/actual/drift', async () => {
  const { compareRowCensus } = await loadBackupModule();

  const clean = compareRowCensus({ Organisation: 3, User: 5 }, { Organisation: 3, User: 5 });
  assert.deepEqual(clean, { ok: true, mismatches: [] });

  const dirty = compareRowCensus({ Organisation: 3, User: 5 }, { Organisation: 2, User: 5 });
  assert.equal(dirty.ok, false);
  assert.deepEqual(dirty.mismatches, [{ table: 'Organisation', expected: 3, actual: 2, drift: -1 }]);

  const missingOnActualSide = compareRowCensus({ Organisation: 3 }, {});
  assert.equal(missingOnActualSide.ok, false);
  assert.deepEqual(missingOnActualSide.mismatches, [{ table: 'Organisation', expected: 3, actual: null, drift: null }]);

  const extraOnActualSide = compareRowCensus({}, { Organisation: 3 });
  assert.equal(extraOnActualSide.ok, false);
  assert.deepEqual(extraOnActualSide.mismatches, [{ table: 'Organisation', expected: null, actual: 3, drift: null }]);
});

test('compareRowCensus honours a positive tolerance and still flags drift beyond it', async () => {
  const { compareRowCensus } = await loadBackupModule();

  const withinTolerance = compareRowCensus({ Organisation: 3 }, { Organisation: 4 }, 1);
  assert.deepEqual(withinTolerance, { ok: true, mismatches: [] });

  const beyondTolerance = compareRowCensus({ Organisation: 3 }, { Organisation: 5 }, 1);
  assert.equal(beyondTolerance.ok, false);
  assert.deepEqual(beyondTolerance.mismatches, [{ table: 'Organisation', expected: 3, actual: 5, drift: 2 }]);

  // A missing-on-one-side table is never "within tolerance" — there's no
  // magnitude to compare against, so it always mismatches regardless of
  // the tolerance value.
  const missingStillMismatches = compareRowCensus({ Organisation: 3 }, {}, 100);
  assert.equal(missingStillMismatches.ok, false);
});

// -----------------------------------------------------------------------------
// runBackup — through an injected recording runCommand (no real docker)
// -----------------------------------------------------------------------------

function makeBackupRecordingRunCommand({ dumpBytes, tarBytes, censusStdout, hashListingStdout }) {
  const calls = [];
  const runCommand = async (command, options = {}) => {
    calls.push({ command, options });
    const line = commandLine(command);

    if (line.includes('pg_dump')) {
      writeFileSync(options.outputFile, dumpBytes);
      return { stdout: '' };
    }
    if (line.includes('psql') && line.includes('query_to_xml')) {
      return { stdout: censusStdout };
    }
    if (line.includes('tar') && command.includes('-cf') && command.includes('-')) {
      writeFileSync(options.outputFile, tarBytes);
      return { stdout: '' };
    }
    if (line.includes('sha256sum')) {
      return { stdout: hashListingStdout };
    }
    throw new Error(`unexpected recorded command in test fake: ${line}`);
  };
  return { runCommand, calls };
}

test('runBackup takes the row census before pg_dump, uses -Fc against the compose db service, and redirects into the plan dump file', async () => {
  const { runBackup } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-backup-test-');
  try {
    const dumpBytes = Buffer.from('fixture-dump-bytes-v1');
    const tarBytes = Buffer.from('fixture-tar-bytes-v1');
    const hashListingStdout = 'aaaa1111\t10\torg/doc.pdf\nbbbb2222\t20\torg/sub/other.pdf\n';
    const censusStdout = 'Organisation=3\nUser=5\n';

    const { runCommand, calls } = makeBackupRecordingRunCommand({ dumpBytes, tarBytes, censusStdout, hashListingStdout });

    const ctx = {
      runCommand,
      stateDir,
      envFile: '/deploy/env/production.env',
      composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
      now: () => new Date('2026-08-31T10:00:00.000Z'),
      commit: 'deadbeef',
      activeColor: 'blue',
    };

    const { plan, manifest } = await runBackup(ctx);

    const censusIndex = calls.findIndex((c) => commandLine(c.command).includes('query_to_xml'));
    const dumpIndex = calls.findIndex((c) => commandLine(c.command).includes('pg_dump'));
    assert.ok(censusIndex !== -1 && dumpIndex !== -1);
    assert.ok(censusIndex < dumpIndex, 'the row census must be taken BEFORE pg_dump to minimise the live-serving race window');

    const dumpCall = calls[dumpIndex];
    assert.ok(dumpCall.command.includes('-Fc'), 'pg_dump must use -Fc');
    assert.ok(dumpCall.command.includes('db'), 'pg_dump must target the compose db service');
    assert.ok(dumpCall.command.includes('docker'));
    assert.ok(dumpCall.command.includes('compose'));
    assert.ok(dumpCall.command.includes('exec'));
    assert.equal(dumpCall.options.outputFile, plan.dumpFile, 'pg_dump stdout must redirect into the plan dump file');
    assert.equal(dumpCall.options.env.BLUEGREEN_ENV_FILE, ctx.envFile);

    const hashCall = calls.find((c) => commandLine(c.command).includes('sha256sum'));
    assert.match(commandLine(hashCall.command), /find \. -type f -print0/);
    assert.match(commandLine(hashCall.command), /xargs -0 -r sha256sum --/);
    assert.match(commandLine(hashCall.command), /set -o pipefail/);

    assert.equal(readFileSync(plan.dumpFile).toString(), dumpBytes.toString());
    assert.equal(readFileSync(plan.documentsTar).toString(), tarBytes.toString());

    const expectedDumpSha256 = sha256Hex(dumpBytes);
    const dumpEntry = manifest.entries.find((e) => e.path === 'database.dump');
    assert.ok(dumpEntry, 'manifest must record the dump artifact');
    assert.equal(dumpEntry.sha256, expectedDumpSha256);
    assert.equal(dumpEntry.bytes, dumpBytes.length);

    const tarEntry = manifest.entries.find((e) => e.path === 'documents.tar');
    assert.ok(tarEntry, 'manifest must record the documents tar artifact itself, not just its contents');
    assert.equal(tarEntry.sha256, sha256Hex(tarBytes));
    assert.equal(tarEntry.bytes, tarBytes.length);

    assert.deepEqual(
      manifest.entries.filter((e) => e.path !== 'database.dump' && e.path !== 'documents.tar').map((e) => e.path).sort(),
      ['org/doc.pdf', 'org/sub/other.pdf'],
    );

    assert.equal(manifest.meta.commit, 'deadbeef');
    assert.equal(manifest.meta.activeColor, 'blue');
    assert.deepEqual(manifest.meta.rowCensus, { Organisation: 3, User: 5 });

    const writtenManifest = JSON.parse(readFileSync(plan.manifestFile, 'utf8'));
    assert.deepEqual(writtenManifest, manifest);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runBackup honours a different composeArgs/envFile/databaseName by changing the recorded commands', async () => {
  const { runBackup } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-backup-test-');
  try {
    const { runCommand, calls } = makeBackupRecordingRunCommand({
      dumpBytes: Buffer.from('d'),
      tarBytes: Buffer.from('t'),
      censusStdout: 'custom_table=1\n',
      hashListingStdout: '',
    });

    await runBackup({
      runCommand,
      stateDir,
      envFile: '/other/env-file',
      composeArgs: ['-f', 'custom.yml', '-p', 'custom-project'],
      databaseName: 'custom_db',
      databaseUser: 'custom_user',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const dumpCall = calls.find((c) => commandLine(c.command).includes('pg_dump'));
    assert.ok(dumpCall.command.includes('custom.yml'));
    assert.ok(dumpCall.command.includes('custom-project'));
    assert.ok(dumpCall.command.includes('custom_db'));
    assert.ok(dumpCall.command.includes('custom_user'));
    assert.equal(dumpCall.options.env.BLUEGREEN_ENV_FILE, '/other/env-file');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runBackup rejects a live census that parses to zero tables', async () => {
  const { runBackup } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-backup-test-');
  try {
    const { runCommand } = makeBackupRecordingRunCommand({
      dumpBytes: Buffer.from('d'),
      tarBytes: Buffer.from('t'),
      censusStdout: '',
      hashListingStdout: '',
    });

    await assert.rejects(
      () =>
        runBackup({
          runCommand,
          stateDir,
          envFile: '/deploy/env/production.env',
          composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
          now: () => new Date('2026-08-31T10:00:00.000Z'),
        }),
      /zero tables/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runBackup rejects psql noise/error output rather than treating it as an empty census', async () => {
  const { runBackup } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-backup-test-');
  try {
    const { runCommand } = makeBackupRecordingRunCommand({
      dumpBytes: Buffer.from('d'),
      tarBytes: Buffer.from('t'),
      censusStdout: '(0 rows)\nERROR: permission denied\n',
      hashListingStdout: '',
    });

    await assert.rejects(
      () =>
        runBackup({
          runCommand,
          stateDir,
          envFile: '/deploy/env/production.env',
          composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
          now: () => new Date('2026-08-31T10:00:00.000Z'),
        }),
      /unparseable line/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// runRestoreDrill — through an injected recording runCommand (no real docker)
// -----------------------------------------------------------------------------

function writeFixtureBackup(stateDir, { rowCensus = { Organisation: 3, User: 5 } } = {}) {
  const dumpBytes = Buffer.from('fixture-dump-bytes-for-drill');
  const tarBytes = Buffer.from('fixture-tar-bytes-for-drill');
  const documentEntries = [
    { path: 'org/doc.pdf', sha256: 'aaaa1111', bytes: 10 },
    { path: 'org/sub/other.pdf', sha256: 'bbbb2222', bytes: 20 },
  ];
  const dumpEntry = { path: 'database.dump', sha256: sha256Hex(dumpBytes), bytes: dumpBytes.length };
  const tarEntry = { path: 'documents.tar', sha256: sha256Hex(tarBytes), bytes: tarBytes.length };
  const now = new Date('2026-08-31T09:00:00.000Z');

  const plan = {
    dir: join(stateDir, 'backups', '2026-08-31T09-00-00-000Z'),
    dumpFile: join(stateDir, 'backups', '2026-08-31T09-00-00-000Z', 'database.dump'),
    documentsTar: join(stateDir, 'backups', '2026-08-31T09-00-00-000Z', 'documents.tar'),
    manifestFile: join(stateDir, 'backups', '2026-08-31T09-00-00-000Z', 'manifest.json'),
  };
  mkdirSync(plan.dir, { recursive: true });
  writeFileSync(plan.dumpFile, dumpBytes);
  writeFileSync(plan.documentsTar, tarBytes);

  const manifest = {
    format: 'charitypilot-bluegreen-backup-manifest/v1',
    meta: { commit: 'deadbeef', activeColor: 'blue', createdAt: now.toISOString(), rowCensus },
    entries: [dumpEntry, tarEntry, ...documentEntries],
  };
  writeFileSync(plan.manifestFile, JSON.stringify(manifest, null, 2));

  return { plan, manifest, documentEntries, dumpEntry, tarEntry };
}

function makeDrillRecordingRunCommand({
  rowCensusStdout = 'Organisation=3\nUser=5\n',
  documentHashStdout,
  failOn = null,
}) {
  const calls = [];
  const runCommand = async (command, options = {}) => {
    calls.push({ command, options });
    const line = commandLine(command);

    if (failOn && line.includes(failOn)) {
      throw new Error(`injected failure for: ${line}`);
    }

    if (command[0] === 'docker' && command[1] === 'logs') {
      return { stdout: 'fixture initdb/postgres log output\n' };
    }
    if (command.includes('run') && command.includes('-d')) {
      return { stdout: '' }; // start container
    }
    if (line.includes('pg_isready')) {
      return { stdout: '' }; // in-container readiness poll loop
    }
    if (line.includes('pg_restore')) {
      return { stdout: '' };
    }
    if (line.includes('psql') && line.includes('query_to_xml')) {
      return { stdout: rowCensusStdout };
    }
    if (line.includes('tar -xf') || line.includes('mkdir -p /drill-documents')) {
      return { stdout: documentHashStdout };
    }
    if (command.includes('rm') && command.includes('-f') && command.includes('-v')) {
      return { stdout: '' }; // teardown
    }
    throw new Error(`unexpected recorded command in drill test fake: ${line}`);
  };
  return { runCommand, calls };
}

function assertNeverTouchesLiveDb(calls) {
  for (const { command } of calls) {
    const line = commandLine(command);
    assert.ok(!command.includes('compose'), `drill command must never use docker compose: ${line}`);
    assert.ok(!command.includes('db'), `drill command must never target the live db service: ${line}`);
    assert.ok(!line.includes('compose.bluegreen.yml'), 'drill command must never reference the bluegreen compose file');
    assert.ok(
      !command.some((token) => /charitypilot-bluegreen-db/.test(token)),
      `drill command must never reference the compose db container-name family: ${line}`,
    );
    assert.ok(
      !command.some((token) => /postgresql:\/\/[^@]*@db(?::\d+)?\//.test(token)),
      `drill command must never carry a DSN whose host is "db": ${line}`,
    );
  }
}

function teardownCallsOf(calls) {
  return calls.filter((c) => c.command.includes('rm') && c.command.includes('-f') && c.command.includes('-v'));
}

function logsCallsOf(calls) {
  return calls.filter((c) => c.command[0] === 'docker' && c.command[1] === 'logs');
}

// -----------------------------------------------------------------------------
// waitForDrillReadiness — requires 2 CONSECUTIVE passing pg_isready probes,
// not just one, so a lone pass against Postgres's temporary bootstrap server
// (which then shuts down before the real server starts on a fresh initdb)
// can never be mistaken for real readiness.
// -----------------------------------------------------------------------------

const READINESS_PROBE_COMMAND = [
  'docker',
  'exec',
  'charitypilot-bluegreen-drill-readiness-test',
  'pg_isready',
  '-U',
  'charitypilot_drill',
  '-d',
  'charitypilot_drill',
];

// Honours its inputs: asserts every probe command matches the expected
// exact shape (container name, user, db) rather than blindly returning
// canned results regardless of what was asked, per project convention.
function makeSequencedReadinessRunCommand(outcomes) {
  let callIndex = 0;
  const runCommand = async (command) => {
    assert.deepEqual(command, READINESS_PROBE_COMMAND, `unexpected probe command at call ${callIndex}`);
    const outcome = callIndex < outcomes.length ? outcomes[callIndex] : outcomes[outcomes.length - 1];
    callIndex += 1;
    if (outcome === 'fail') throw new Error('pg_isready: no response');
  };
  return { runCommand, callCount: () => callIndex };
}

test('waitForDrillReadiness only passes once 2 probes succeed BACK TO BACK — an isolated earlier pass does not count', async () => {
  const { waitForDrillReadiness } = await loadBackupModule();
  // ok, fail, ok, ok — the only consecutive pair is the 3rd+4th call; the
  // isolated 1st pass must not be credited toward it.
  const { runCommand, callCount } = makeSequencedReadinessRunCommand(['ok', 'fail', 'ok', 'ok']);
  const sleeps = [];
  const ctx = { runCommand, sleep: async (ms) => { sleeps.push(ms); } };

  await waitForDrillReadiness(ctx, 'charitypilot-bluegreen-drill-readiness-test', { SOME: 'env' });

  assert.equal(callCount(), 4, 'must stop exactly at the consecutive pair, neither early nor late');
  assert.deepEqual(sleeps, [1000, 1000, 1000], 'sleeps between every attempt except the final passing one');
});

test('waitForDrillReadiness times out when passes never land consecutively', async () => {
  const { waitForDrillReadiness } = await loadBackupModule();
  // ok, then fail forever — one isolated pass, never a second one in a row.
  const { runCommand, callCount } = makeSequencedReadinessRunCommand(['ok', 'fail']);
  const sleeps = [];
  const ctx = { runCommand, sleep: async (ms) => { sleeps.push(ms); } };

  await assert.rejects(
    () => waitForDrillReadiness(ctx, 'charitypilot-bluegreen-drill-readiness-test', {}),
    /Restore drill readiness poll timed out after 120 attempts \(requires 2 consecutive successful pg_isready checks\)/,
  );

  assert.equal(callCount(), 120, 'must exhaust the full attempt budget, not give up early');
  assert.equal(sleeps.length, 119, 'sleeps between every attempt except the last (which times out instead)');
});

test('runRestoreDrill restores into a throwaway container, never the live db, and passes clean', async () => {
  const { runRestoreDrill } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-drill-test-');
  try {
    const { plan, documentEntries } = writeFixtureBackup(stateDir);
    const documentHashStdout = documentEntries.map((e) => `${e.sha256}\t${e.bytes}\t${e.path}`).join('\n') + '\n';

    const { runCommand, calls } = makeDrillRecordingRunCommand({ documentHashStdout });

    const ctx = {
      runCommand,
      stateDir,
      envFile: '/deploy/env/production.env',
      composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
      plan,
      sleep: async () => {}, // instant: no real 1s waits between readiness probes in tests
    };

    const result = await runRestoreDrill(ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(result.rowCensus, { Organisation: 3, User: 5 });
    assert.deepEqual(result.manifestVerification, { ok: true, missing: [], mismatched: [], extra: [] });

    assertNeverTouchesLiveDb(calls);
    assert.equal(logsCallsOf(calls).length, 0, 'docker logs must never run on the clean path');

    const startCall = calls.find((c) => c.command.includes('run') && c.command.includes('-d'));
    assert.ok(startCall, 'must start a scratch container');
    const nameIndex = startCall.command.indexOf('--name');
    const containerName = startCall.command[nameIndex + 1];
    assert.match(containerName, /^charitypilot-bluegreen-drill-/);

    // The data directory must be an anonymous volume (bare container path,
    // no host source, no artificial size cap) rather than a size-capped
    // tmpfs.
    const dataVolumeIndex = startCall.command.indexOf('/var/lib/postgresql/data');
    assert.ok(dataVolumeIndex > 0, 'drill container must mount an anonymous volume for the data directory');
    assert.equal(startCall.command[dataVolumeIndex - 1], '-v');
    assert.ok(!commandLine(startCall.command).includes('tmpfs'), 'drill container must not use a size-capped tmpfs for the data directory');
    assert.ok(!commandLine(startCall.command).includes('size='), 'drill container must not cap the data directory size');

    // Requires 2 consecutive passing probes (see waitForDrillReadiness), so a
    // clean run records exactly two pg_isready attempts, not one.
    const readinessCalls = calls.filter((c) => commandLine(c.command).includes('pg_isready'));
    assert.equal(readinessCalls.length, 2);
    for (const call of readinessCalls) {
      assert.deepEqual(call.command, ['docker', 'exec', containerName, 'pg_isready', '-U', 'charitypilot_drill', '-d', 'charitypilot_drill']);
    }

    const restoreCall = calls.find((c) => commandLine(c.command).includes('pg_restore'));
    assert.ok(restoreCall.command.includes('--exit-on-error'), 'pg_restore must use --exit-on-error');
    assert.ok(restoreCall.command.includes('--single-transaction'), 'pg_restore must use --single-transaction');

    const hashCall = calls.find((c) => commandLine(c.command).includes('tar -xf'));
    assert.match(commandLine(hashCall.command), /find \. -type f -print0/);
    assert.match(commandLine(hashCall.command), /xargs -0 -r sha256sum --/);
    assert.match(commandLine(hashCall.command), /set -o pipefail/);

    const teardownCalls = teardownCallsOf(calls);
    assert.equal(teardownCalls.length, 1, 'teardown must run exactly once');
    assert.ok(teardownCalls[0].command.includes(containerName));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill tears down the scratch container even when a step throws, and collects docker logs first', async () => {
  const { runRestoreDrill } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-drill-test-');
  try {
    const { plan, documentEntries } = writeFixtureBackup(stateDir);
    const documentHashStdout = documentEntries.map((e) => `${e.sha256}\t${e.bytes}\t${e.path}`).join('\n') + '\n';

    const { runCommand, calls } = makeDrillRecordingRunCommand({ documentHashStdout, failOn: 'pg_restore' });

    const ctx = {
      runCommand,
      stateDir,
      envFile: '/deploy/env/production.env',
      composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
      plan,
      sleep: async () => {}, // instant: no real 1s waits between readiness probes in tests
    };

    await assert.rejects(() => runRestoreDrill(ctx), /injected failure for.*pg_restore/);

    assertNeverTouchesLiveDb(calls);

    const failIndex = calls.findIndex((c) => commandLine(c.command).includes('pg_restore'));
    const logsIndex = calls.findIndex((c) => c.command[0] === 'docker' && c.command[1] === 'logs');
    const teardownIndex = calls.findIndex((c) => c.command.includes('rm') && c.command.includes('-f') && c.command.includes('-v'));

    assert.equal(logsCallsOf(calls).length, 1, 'docker logs must run exactly once on a failed drill');
    assert.equal(teardownCallsOf(calls).length, 1, 'teardown must still run after a mid-drill failure');
    assert.ok(failIndex < logsIndex, 'docker logs must be collected AFTER the failing step');
    assert.ok(logsIndex < teardownIndex, 'docker logs must be collected BEFORE teardown');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill fails on a row census mismatch, reports drift, collects logs, and still tears down', async () => {
  const { runRestoreDrill } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-drill-test-');
  try {
    const { plan, documentEntries } = writeFixtureBackup(stateDir);
    const documentHashStdout = documentEntries.map((e) => `${e.sha256}\t${e.bytes}\t${e.path}`).join('\n') + '\n';

    const { runCommand, calls } = makeDrillRecordingRunCommand({
      rowCensusStdout: 'Organisation=2\nUser=5\n',
      documentHashStdout,
    });

    const ctx = {
      runCommand,
      stateDir,
      envFile: '/deploy/env/production.env',
      composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
      plan,
      sleep: async () => {}, // instant: no real 1s waits between readiness probes in tests
    };

    await assert.rejects(() => runRestoreDrill(ctx), /row census mismatch.*Organisation expected=3 actual=2 drift=-1/s);

    assert.equal(logsCallsOf(calls).length, 1);
    assert.equal(teardownCallsOf(calls).length, 1, 'teardown must still run after a census mismatch');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill honours BLUEGREEN_DRILL_CENSUS_TOLERANCE from ctx.env', async () => {
  const { runRestoreDrill } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-drill-test-');
  try {
    const { plan, documentEntries } = writeFixtureBackup(stateDir);
    const documentHashStdout = documentEntries.map((e) => `${e.sha256}\t${e.bytes}\t${e.path}`).join('\n') + '\n';

    // Drift of +1 on Organisation: rejected at the default tolerance (0),
    // accepted once BLUEGREEN_DRILL_CENSUS_TOLERANCE=1 is set.
    const rowCensusStdout = 'Organisation=4\nUser=5\n';

    const strict = makeDrillRecordingRunCommand({ rowCensusStdout, documentHashStdout });
    await assert.rejects(
      () =>
        runRestoreDrill({
          runCommand: strict.runCommand,
          stateDir,
          envFile: '/deploy/env/production.env',
          composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
          plan,
          sleep: async () => {},
        }),
      /row census mismatch/,
    );

    const tolerant = makeDrillRecordingRunCommand({ rowCensusStdout, documentHashStdout });
    const result = await runRestoreDrill({
      runCommand: tolerant.runCommand,
      stateDir,
      envFile: '/deploy/env/production.env',
      composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
      plan,
      sleep: async () => {},
      env: { ...process.env, BLUEGREEN_DRILL_CENSUS_TOLERANCE: '1' },
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill fails when a restored document hash mismatches the manifest', async () => {
  const { runRestoreDrill } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-drill-test-');
  try {
    const { plan, documentEntries } = writeFixtureBackup(stateDir);
    const corrupted = [...documentEntries];
    corrupted[0] = { ...corrupted[0], sha256: 'flipped-byte-hash' };
    const documentHashStdout = corrupted.map((e) => `${e.sha256}\t${e.bytes}\t${e.path}`).join('\n') + '\n';

    const { runCommand, calls } = makeDrillRecordingRunCommand({ documentHashStdout });

    const ctx = {
      runCommand,
      stateDir,
      envFile: '/deploy/env/production.env',
      composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
      plan,
      sleep: async () => {}, // instant: no real 1s waits between readiness probes in tests
    };

    await assert.rejects(() => runRestoreDrill(ctx), /manifest verification failed/);

    assert.equal(logsCallsOf(calls).length, 1);
    assert.equal(teardownCallsOf(calls).length, 1, 'teardown must still run after a manifest verification failure');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill fails when a document is missing from the restored tar', async () => {
  const { runRestoreDrill } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-drill-test-');
  try {
    const { plan, documentEntries } = writeFixtureBackup(stateDir);
    const onlyFirst = [documentEntries[0]];
    const documentHashStdout = onlyFirst.map((e) => `${e.sha256}\t${e.bytes}\t${e.path}`).join('\n') + '\n';

    const { runCommand, calls } = makeDrillRecordingRunCommand({ documentHashStdout });

    const ctx = {
      runCommand,
      stateDir,
      envFile: '/deploy/env/production.env',
      composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
      plan,
      sleep: async () => {}, // instant: no real 1s waits between readiness probes in tests
    };

    await assert.rejects(() => runRestoreDrill(ctx), /manifest verification failed/);

    assert.equal(teardownCallsOf(calls).length, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill fails when an extra document appears in the restored tar', async () => {
  const { runRestoreDrill } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-drill-test-');
  try {
    const { plan, documentEntries } = writeFixtureBackup(stateDir);
    const withExtra = [...documentEntries, { path: 'org/unexpected.pdf', sha256: 'zzzz', bytes: 1 }];
    const documentHashStdout = withExtra.map((e) => `${e.sha256}\t${e.bytes}\t${e.path}`).join('\n') + '\n';

    const { runCommand, calls } = makeDrillRecordingRunCommand({ documentHashStdout });

    const ctx = {
      runCommand,
      stateDir,
      envFile: '/deploy/env/production.env',
      composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
      plan,
      sleep: async () => {}, // instant: no real 1s waits between readiness probes in tests
    };

    await assert.rejects(() => runRestoreDrill(ctx), /manifest verification failed/);

    assert.equal(teardownCallsOf(calls).length, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill refuses a manifest with no entries before touching docker at all', async () => {
  const { runRestoreDrill } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-drill-test-');
  try {
    const { plan } = writeFixtureBackup(stateDir);
    writeFileSync(
      plan.manifestFile,
      JSON.stringify({
        format: 'charitypilot-bluegreen-backup-manifest/v1',
        meta: { commit: 'deadbeef', activeColor: 'blue', createdAt: 'now', rowCensus: { Organisation: 3 } },
        entries: [],
      }),
    );

    const { runCommand, calls } = makeDrillRecordingRunCommand({});

    await assert.rejects(
      () =>
        runRestoreDrill({
          runCommand,
          stateDir,
          envFile: '/deploy/env/production.env',
          composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
          plan,
        }),
      /no entries/,
    );
    assert.equal(calls.length, 0, 'must never invoke docker for a manifest with no entries');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill refuses a manifest with an absent row census before touching docker at all', async () => {
  const { runRestoreDrill } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-drill-test-');
  try {
    const { plan, manifest } = writeFixtureBackup(stateDir);
    const { rowCensus: _dropped, ...restMeta } = manifest.meta;
    writeFileSync(plan.manifestFile, JSON.stringify({ ...manifest, meta: restMeta }));

    const { runCommand, calls } = makeDrillRecordingRunCommand({});

    await assert.rejects(
      () =>
        runRestoreDrill({
          runCommand,
          stateDir,
          envFile: '/deploy/env/production.env',
          composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
          plan,
        }),
      /empty or absent row census/,
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill refuses a manifest with an empty ({}) row census before touching docker at all', async () => {
  const { runRestoreDrill } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-drill-test-');
  try {
    const { plan, manifest } = writeFixtureBackup(stateDir);
    writeFileSync(plan.manifestFile, JSON.stringify({ ...manifest, meta: { ...manifest.meta, rowCensus: {} } }));

    const { runCommand, calls } = makeDrillRecordingRunCommand({});

    await assert.rejects(
      () =>
        runRestoreDrill({
          runCommand,
          stateDir,
          envFile: '/deploy/env/production.env',
          composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
          plan,
        }),
      /empty or absent row census/,
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill rejects a restored-db census that parses to zero tables (still tears down and logs)', async () => {
  const { runRestoreDrill } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-drill-test-');
  try {
    const { plan, documentEntries } = writeFixtureBackup(stateDir);
    const documentHashStdout = documentEntries.map((e) => `${e.sha256}\t${e.bytes}\t${e.path}`).join('\n') + '\n';

    const { runCommand, calls } = makeDrillRecordingRunCommand({ rowCensusStdout: '', documentHashStdout });

    const ctx = {
      runCommand,
      stateDir,
      envFile: '/deploy/env/production.env',
      composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
      plan,
      sleep: async () => {}, // instant: no real 1s waits between readiness probes in tests
    };

    await assert.rejects(() => runRestoreDrill(ctx), /zero tables/);

    assert.equal(logsCallsOf(calls).length, 1);
    assert.equal(teardownCallsOf(calls).length, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill rejects psql noise/error output from the restored db rather than treating it as empty', async () => {
  const { runRestoreDrill } = await loadBackupModule();
  const stateDir = makeTempDir('charitypilot-bluegreen-drill-test-');
  try {
    const { plan, documentEntries } = writeFixtureBackup(stateDir);
    const documentHashStdout = documentEntries.map((e) => `${e.sha256}\t${e.bytes}\t${e.path}`).join('\n') + '\n';

    const { runCommand, calls } = makeDrillRecordingRunCommand({
      rowCensusStdout: '(0 rows)\nERROR: permission denied\n',
      documentHashStdout,
    });

    const ctx = {
      runCommand,
      stateDir,
      envFile: '/deploy/env/production.env',
      composeArgs: ['-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen'],
      plan,
      sleep: async () => {}, // instant: no real 1s waits between readiness probes in tests
    };

    await assert.rejects(() => runRestoreDrill(ctx), /unparseable line/);

    assert.equal(teardownCallsOf(calls).length, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Digest-pinning: never retyped
// -----------------------------------------------------------------------------

test('backup.mjs imports the pinned postgres image and alpine archive image rather than retyping the digests', async () => {
  const backupSource = readFileSync(backupScriptPath, 'utf8');
  assert.match(backupSource, /import\s*\{\s*DEFAULT_POSTGRES_IMAGE\s*\}\s*from\s*['"]\.\.\/postgres-backup\.mjs['"]/);
  assert.match(backupSource, /import\s*\{\s*DOCUMENT_ARCHIVE_IMAGE\s*\}\s*from\s*['"]\.\.\/personal-server\.mjs['"]/);
  assert.doesNotMatch(backupSource, /sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c/);
  assert.doesNotMatch(backupSource, /sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc/);

  const postgresBackupModule = await import(pathToFileURL(join(scriptsDir, '..', 'postgres-backup.mjs')).href);
  const personalServerModule = await import(pathToFileURL(join(scriptsDir, '..', 'personal-server.mjs')).href);
  assert.equal(typeof postgresBackupModule.DEFAULT_POSTGRES_IMAGE, 'string');
  assert.equal(typeof personalServerModule.DOCUMENT_ARCHIVE_IMAGE, 'string');
});
