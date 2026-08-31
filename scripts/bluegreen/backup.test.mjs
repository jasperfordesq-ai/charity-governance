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

test('compareRowCensus matches identical censuses and flags a mismatch with expected/actual', async () => {
  const { compareRowCensus } = await loadBackupModule();

  const clean = compareRowCensus({ Organisation: 3, User: 5 }, { Organisation: 3, User: 5 });
  assert.deepEqual(clean, { ok: true, mismatches: [] });

  const dirty = compareRowCensus({ Organisation: 3, User: 5 }, { Organisation: 2, User: 5 });
  assert.equal(dirty.ok, false);
  assert.deepEqual(dirty.mismatches, [{ table: 'Organisation', expected: 3, actual: 2 }]);

  const missingOnActualSide = compareRowCensus({ Organisation: 3 }, {});
  assert.equal(missingOnActualSide.ok, false);
  assert.deepEqual(missingOnActualSide.mismatches, [{ table: 'Organisation', expected: 3, actual: null }]);

  const extraOnActualSide = compareRowCensus({}, { Organisation: 3 });
  assert.equal(extraOnActualSide.ok, false);
  assert.deepEqual(extraOnActualSide.mismatches, [{ table: 'Organisation', expected: null, actual: 3 }]);
});

// -----------------------------------------------------------------------------
// runBackup — through an injected recording runCommand (no real docker)
// -----------------------------------------------------------------------------

function commandLine(command) {
  return command.join(' ');
}

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

test('runBackup pg_dumps -Fc against the compose db service and redirects into the plan dump file', async () => {
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

    const dumpCall = calls.find((c) => commandLine(c.command).includes('pg_dump'));
    assert.ok(dumpCall, 'pg_dump command must be recorded');
    assert.ok(dumpCall.command.includes('-Fc'), 'pg_dump must use -Fc');
    assert.ok(dumpCall.command.includes('db'), 'pg_dump must target the compose db service');
    assert.ok(dumpCall.command.includes('docker'));
    assert.ok(dumpCall.command.includes('compose'));
    assert.ok(dumpCall.command.includes('exec'));
    assert.equal(dumpCall.options.outputFile, plan.dumpFile, 'pg_dump stdout must redirect into the plan dump file');
    assert.equal(dumpCall.options.env.BLUEGREEN_ENV_FILE, ctx.envFile);

    assert.equal(readFileSync(plan.dumpFile).toString(), dumpBytes.toString());
    assert.equal(readFileSync(plan.documentsTar).toString(), tarBytes.toString());

    const expectedDumpSha256 = sha256Hex(dumpBytes);
    const dumpEntry = manifest.entries.find((e) => e.path === 'database.dump');
    assert.ok(dumpEntry, 'manifest must record the dump artifact');
    assert.equal(dumpEntry.sha256, expectedDumpSha256);
    assert.equal(dumpEntry.bytes, dumpBytes.length);

    assert.deepEqual(
      manifest.entries.filter((e) => e.path !== 'database.dump').map((e) => e.path).sort(),
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
      censusStdout: '',
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

// -----------------------------------------------------------------------------
// runRestoreDrill — through an injected recording runCommand (no real docker)
// -----------------------------------------------------------------------------

function writeFixtureBackup(stateDir) {
  const dumpBytes = Buffer.from('fixture-dump-bytes-for-drill');
  const documentEntries = [
    { path: 'org/doc.pdf', sha256: 'aaaa1111', bytes: 10 },
    { path: 'org/sub/other.pdf', sha256: 'bbbb2222', bytes: 20 },
  ];
  const dumpEntry = { path: 'database.dump', sha256: sha256Hex(dumpBytes), bytes: dumpBytes.length };
  const now = new Date('2026-08-31T09:00:00.000Z');

  const plan = {
    dir: join(stateDir, 'backups', '2026-08-31T09-00-00-000Z'),
    dumpFile: join(stateDir, 'backups', '2026-08-31T09-00-00-000Z', 'database.dump'),
    documentsTar: join(stateDir, 'backups', '2026-08-31T09-00-00-000Z', 'documents.tar'),
    manifestFile: join(stateDir, 'backups', '2026-08-31T09-00-00-000Z', 'manifest.json'),
  };
  mkdirSync(plan.dir, { recursive: true });
  writeFileSync(plan.dumpFile, dumpBytes);
  writeFileSync(plan.documentsTar, Buffer.from('fixture-tar-bytes'));

  const manifest = {
    format: 'charitypilot-bluegreen-backup-manifest/v1',
    meta: { commit: 'deadbeef', activeColor: 'blue', createdAt: now.toISOString(), rowCensus: { Organisation: 3, User: 5 } },
    entries: [dumpEntry, ...documentEntries],
  };
  writeFileSync(plan.manifestFile, JSON.stringify(manifest, null, 2));

  return { plan, manifest, documentEntries, dumpEntry };
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

    if (command.includes('run') && command.includes('-d')) {
      return { stdout: '' }; // start container
    }
    if (line.includes('pg_isready')) {
      return { stdout: '' };
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
    assert.ok(!command.includes('compose'), `drill command must never use docker compose: ${commandLine(command)}`);
    assert.ok(!command.includes('db'), `drill command must never target the live db service: ${commandLine(command)}`);
    assert.ok(!commandLine(command).includes('compose.bluegreen.yml'), 'drill command must never reference the bluegreen compose file');
  }
}

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
    };

    const result = await runRestoreDrill(ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(result.rowCensus, { Organisation: 3, User: 5 });
    assert.deepEqual(result.manifestVerification, { ok: true, missing: [], mismatched: [], extra: [] });

    assertNeverTouchesLiveDb(calls);

    const startCall = calls.find((c) => c.command.includes('run') && c.command.includes('-d'));
    assert.ok(startCall, 'must start a scratch container');
    const nameIndex = startCall.command.indexOf('--name');
    const containerName = startCall.command[nameIndex + 1];
    assert.match(containerName, /^charitypilot-bluegreen-drill-/);

    const teardownCalls = calls.filter((c) => c.command.includes('rm') && c.command.includes('-f') && c.command.includes('-v'));
    assert.equal(teardownCalls.length, 1, 'teardown must run exactly once');
    assert.ok(teardownCalls[0].command.includes(containerName));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill tears down the scratch container even when a step throws', async () => {
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
    };

    await assert.rejects(() => runRestoreDrill(ctx), /injected failure for.*pg_restore/);

    assertNeverTouchesLiveDb(calls);
    const teardownCalls = calls.filter((c) => c.command.includes('rm') && c.command.includes('-f') && c.command.includes('-v'));
    assert.equal(teardownCalls.length, 1, 'teardown must still run after a mid-drill failure');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runRestoreDrill fails on a row census mismatch and still tears down', async () => {
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
    };

    await assert.rejects(() => runRestoreDrill(ctx), /row census mismatch/);

    const teardownCalls = calls.filter((c) => c.command.includes('rm') && c.command.includes('-f') && c.command.includes('-v'));
    assert.equal(teardownCalls.length, 1, 'teardown must still run after a census mismatch');
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
    };

    await assert.rejects(() => runRestoreDrill(ctx), /manifest verification failed/);

    const teardownCalls = calls.filter((c) => c.command.includes('rm') && c.command.includes('-f') && c.command.includes('-v'));
    assert.equal(teardownCalls.length, 1, 'teardown must still run after a manifest verification failure');
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
    };

    await assert.rejects(() => runRestoreDrill(ctx), /manifest verification failed/);

    const teardownCalls = calls.filter((c) => c.command.includes('rm') && c.command.includes('-f') && c.command.includes('-v'));
    assert.equal(teardownCalls.length, 1);
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
    };

    await assert.rejects(() => runRestoreDrill(ctx), /manifest verification failed/);

    const teardownCalls = calls.filter((c) => c.command.includes('rm') && c.command.includes('-f') && c.command.includes('-v'));
    assert.equal(teardownCalls.length, 1);
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
