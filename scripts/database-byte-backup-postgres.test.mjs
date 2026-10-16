import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  createWriteStream,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KMSClient } from '@aws-sdk/client-kms';
import {
  sealDatabaseByteBackup,
  openDatabaseByteBackupToQuarantine,
} from '../apps/api/src/services/database-byte-backup.ts';
import { KmsDatabaseBackupKeys } from '../apps/api/src/services/database-byte-backup-kms.ts';
import {
  DEFAULT_POSTGRES_IMAGE,
  spawnLocalDockerCommand,
  openProtectedRegularFile,
  assertProtectedFileUnchanged,
} from './postgres-backup.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const keyArn =
  'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-4222-8222-222222222222';
const root = fileURLToPath(new URL('..', import.meta.url));
const sourceProgram = `set -eu
initdb -D /tmp/data --no-locale --encoding=UTF8 --auth=trust >/dev/null
pg_ctl -D /tmp/data -o "-c listen_addresses='' -c unix_socket_directories=/tmp" -l /tmp/server.log -w start >/dev/null
trap 'pg_ctl -D /tmp/data -m immediate stop >/dev/null' EXIT
psql -h /tmp -d postgres -v ON_ERROR_STOP=1 -c "CREATE TABLE synthetic_records(id text PRIMARY KEY, body jsonb NOT NULL); INSERT INTO synthetic_records VALUES ('first', '{\\\"scope\\\":\\\"synthetic private backup\\\"}');" >/dev/null
pg_dump -h /tmp -d postgres --format=custom --no-owner --no-privileges
`;
function heldSource(handle) {
  return Readable.from(
    (function* () {
      let position = 0;
      for (;;) {
        const bytes = Buffer.alloc(65536),
          count = readSync(handle.fd, bytes, 0, bytes.length, position);
        if (!count) return;
        position += count;
        yield bytes.subarray(0, count);
      }
    })(),
  );
}
test(
  'real PostgreSQL dump survives signed KMS streaming archive and isolated restore',
  { timeout: 180000 },
  async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'charitypilot-database-byte-proof-'),
    );
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(
      basename(directory).startsWith('charitypilot-database-byte-proof-'),
    );
    const handles = [],
      clients = [],
      keys = new Map();
    let expectedDumpBytes;
    let sourcePath,
      databaseSha256,
      databaseIdentitySha256,
      sourceCaptureReportSha256,
      setId;
    let requests = 0;
    const proofPath = process.env.CHARITYPILOT_DATABASE_BACKUP_PROOF_REPORT;
    try {
      if (process.env.CI === 'true')
        assert.ok(proofPath, 'CI must use its full source-bound restore proof');
      if (proofPath) {
        const reportHandle = openProtectedRegularFile(
          proofPath,
          'source capture report',
        );
        handles.push(reportHandle);
        const reportStatus = lstatSync(proofPath);
        assert.ok(
          reportStatus.isFile() &&
            !reportStatus.isSymbolicLink() &&
            reportStatus.size <= 32 * 1024 * 1024,
        );
        const reportBytes = Number(reportHandle.identity.size);
        assert.ok(
          Number.isSafeInteger(reportBytes) &&
            reportBytes > 0 &&
            reportBytes <= 32 * 1024 * 1024,
        );
        const bytes = Buffer.alloc(reportBytes);
        let copied = 0;
        while (copied < bytes.length) {
          const count = readSync(
            reportHandle.fd,
            bytes,
            copied,
            Math.min(65536, bytes.length - copied),
            copied,
          );
          assert.ok(count > 0, 'source capture report truncated during read');
          copied += count;
        }
        assert.equal(
          readSync(reportHandle.fd, Buffer.alloc(1), 0, 1, bytes.length),
          0,
          'source capture report grew during read',
        );
        const report = JSON.parse(bytes);
        assertProtectedFileUnchanged(
          reportHandle,
          'after source capture report read',
        );
        assert.equal(report.format, 'charitypilot-postgres-restore-proof/v2');
        assert.equal(report.ok, true);
        assert.equal(report.sourceReadOnlyVerified, true);
        assert.equal(report.sourceIdentityBindingMatched, true);
        assert.equal(
          report.sourceDatabaseIdentitySha256,
          process.env.CHARITYPILOT_SOURCE_IDENTITY_SHA256,
        );
        assert.equal(
          report.helperImplementation.commitSha,
          process.env.GITHUB_SHA,
        );
        assert.equal(report.helperImplementation.sourceMatchesCommit, true);
        assert.equal(report.dump.unchangedDuringProof, true);
        assert.match(report.dump.bytes, /^[1-9][0-9]*$/);
        expectedDumpBytes = Number(report.dump.bytes);
        assert.equal(report.comparison.mismatchCount, 0);
        assert.match(
          report.dump.fileName,
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
        );
        sourcePath = join(dirname(resolve(proofPath)), report.dump.fileName);
        databaseSha256 = report.dump.sha256;
        databaseIdentitySha256 = report.sourceDatabaseIdentitySha256;
        sourceCaptureReportSha256 = hash(bytes);
        // A new archive set references this existing capture exercise by its
        // report digest. It does not claim to recreate the exercise's identifier.
        setId = randomUUID();
      } else {
        // Local synthetic source only. CI uses the full source-bound restore proof.
        const name = 'charitypilot-database-byte-' + randomUUID();
        let result;
        try {
          result = spawnLocalDockerCommand(
            [
              'docker',
              'run',
              '--rm',
              '--name',
              name,
              '--network',
              'none',
              '--read-only',
              '--user',
              'postgres',
              '--cap-drop=ALL',
              '--security-opt=no-new-privileges',
              '--tmpfs',
              '/tmp:rw,nosuid,size=256m,mode=1777',
              '--entrypoint',
              'sh',
              DEFAULT_POSTGRES_IMAGE,
              '-c',
              sourceProgram,
            ],
            process.env,
            { timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
          );
          assert.equal(
            result.status,
            0,
            result.stderr?.toString() || 'synthetic PostgreSQL dump failed',
          );
        } finally {
          const cleanup = spawnLocalDockerCommand(
            ['docker', 'rm', '--force', name],
            process.env,
            { encoding: 'utf8', timeout: 30000 },
          );
          assert.ok(
            cleanup.status === 0 || /No such container/i.test(cleanup.stderr),
          );
        }
        assert.ok(result.stdout.subarray(0, 5).equals(Buffer.from('PGDMP')));
        sourcePath = join(directory, 'synthetic-source.dump');
        writeFileSync(sourcePath, result.stdout, { flag: 'wx', mode: 0o600 });
        databaseSha256 = hash(result.stdout);
        databaseIdentitySha256 = hash('isolated synthetic PostgreSQL fixture');
        sourceCaptureReportSha256 = hash(sourceProgram + '\n' + databaseSha256);
        setId = randomUUID();
      }
      const original = openProtectedRegularFile(sourcePath);
      handles.push(original);
      if (proofPath)
        assert.equal(Number(original.identity.size), expectedDumpBytes);
      const scope = {
        installationId: 'synthetic-database-proof',
        setId,
        sourceSha: process.env.GITHUB_SHA || 'a'.repeat(40),
        databaseIdentitySha256,
        sourceCaptureReportSha256,
        databaseSha256,
        byteLength: Number(original.identity.size),
        keyArn,
      };
      const client = () => {
        const sdk = new KMSClient({
          region: 'eu-west-1',
          endpoint: 'https://kms.eu-west-1.amazonaws.com',
          credentials,
          maxAttempts: 1,
          requestHandler: {
            async handle(request) {
              assert.equal(request.hostname, 'kms.eu-west-1.amazonaws.com');
              assert.equal(request.protocol, 'https:');
              assert.match(request.headers.authorization, /AWS4-HMAC-SHA256/);
              const body = JSON.parse(
                typeof request.body === 'string'
                  ? request.body
                  : new TextDecoder().decode(request.body),
              );
              assert.equal(body.KeyId, keyArn);
              assert.equal(
                body.EncryptionContext.purpose,
                'charitypilot-database-byte-backup-v1',
              );
              assert.equal(
                body.EncryptionContext.sourceCaptureReportSha256,
                sourceCaptureReportSha256,
              );
              assert.equal(
                body.EncryptionContext.databaseSha256,
                databaseSha256,
              );
              requests++;
              let key, wrapped;
              if (
                request.headers['x-amz-target'].endsWith('.GenerateDataKey')
              ) {
                assert.equal(body.KeySpec, 'AES_256');
                key = randomBytes(32);
                wrapped = Buffer.from(randomUUID()).toString('base64');
                keys.set(wrapped, { key, context: body.EncryptionContext });
              } else {
                assert.equal(body.EncryptionAlgorithm, 'SYMMETRIC_DEFAULT');
                const record = keys.get(body.CiphertextBlob);
                assert.ok(record);
                assert.deepEqual(body.EncryptionContext, record.context);
                key = record.key;
              }
              return {
                response: {
                  statusCode: 200,
                  headers: { 'content-type': 'application/x-amz-json-1.1' },
                  body: Readable.from([
                    JSON.stringify({
                      KeyId: keyArn,
                      Plaintext: key.toString('base64'),
                      ...(wrapped
                        ? { CiphertextBlob: wrapped }
                        : { EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' }),
                    }),
                  ]),
                },
              };
            },
          },
        });
        clients.push(sdk);
        return sdk;
      };
      const encryptedPath = join(directory, 'database.encrypted');
      const sealed = await sealDatabaseByteBackup(
        scope,
        heldSource(original),
        createWriteStream(encryptedPath, { flags: 'wx', mode: 0o600 }),
        new KmsDatabaseBackupKeys(keyArn, credentials, client()),
      );
      assertProtectedFileUnchanged(original, 'after encrypted capture');
      if (!proofPath) {
        // The source container has exited. Remove only this fixture's own dump;
        // never remove the caller-supplied full source-bound CI artifact.
        closeSync(original.fd);
        handles.splice(handles.indexOf(original), 1);
        rmSync(sourcePath);
      }
      const encrypted = openProtectedRegularFile(encryptedPath);
      handles.push(encrypted);
      const restoredPath = join(directory, 'quarantine-restored.dump');
      const restored = await openDatabaseByteBackupToQuarantine(
        scope,
        heldSource(encrypted),
        createWriteStream(restoredPath, { flags: 'wx', mode: 0o600 }),
        sealed.sha256,
        new KmsDatabaseBackupKeys(keyArn, credentials, client()),
      );
      assertProtectedFileUnchanged(encrypted, 'after quarantined restoration');
      assert.equal(restored.databaseSha256, databaseSha256);
      assert.equal(requests, 2);
      if (proofPath) {
        const args = [
          'scripts/postgres-backup.mjs',
          'verify-restore',
          '--dump-file=' + restoredPath,
          '--expect-operational-sentinel',
        ];
        const verification = spawnSync(process.execPath, args, {
          cwd: root,
          env: process.env,
          encoding: 'utf8',
          timeout: 120000,
          maxBuffer: 512 * 1024,
        });
        assert.equal(
          verification.status,
          0,
          'isolated restored PostgreSQL verification refused: ' +
            verification.stderr,
        );
      } else {
        const name = 'charitypilot-database-byte-restore-' + randomUUID();
        const restoreProgram =
          sourceProgram.slice(0, sourceProgram.indexOf('psql -h')) +
          'pg_restore -h /tmp -d postgres --no-owner --no-privileges --exit-on-error\n' +
          "psql -h /tmp -d postgres -Atq -v ON_ERROR_STOP=1 -c \"SELECT id || ':' || (body->>'scope') FROM synthetic_records\"\n";
        try {
          const verification = spawnLocalDockerCommand(
            [
              'docker',
              'run',
              '--rm',
              '--interactive',
              '--name',
              name,
              '--network',
              'none',
              '--read-only',
              '--user',
              'postgres',
              '--cap-drop=ALL',
              '--security-opt=no-new-privileges',
              '--tmpfs',
              '/tmp:rw,nosuid,size=256m,mode=1777',
              '--entrypoint',
              'sh',
              DEFAULT_POSTGRES_IMAGE,
              '-c',
              restoreProgram,
            ],
            process.env,
            {
              input: readFileSync(restoredPath),
              encoding: 'utf8',
              timeout: 120000,
              maxBuffer: 512 * 1024,
            },
          );
          assert.equal(
            verification.status,
            0,
            verification.stderr || 'synthetic restored PostgreSQL refused',
          );
          assert.equal(
            verification.stdout.trim(),
            'first:synthetic private backup',
          );
        } finally {
          const cleanup = spawnLocalDockerCommand(
            ['docker', 'rm', '--force', name],
            process.env,
            { encoding: 'utf8', timeout: 30000 },
          );
          assert.ok(
            cleanup.status === 0 || /No such container/i.test(cleanup.stderr),
          );
        }
      }
      process.stdout.write(
        proofPath
          ? 'Full source-bound CI dump encrypted, authenticated and restored with operational sentinels.\n'
          : 'Synthetic native PostgreSQL dump encrypted, authenticated and restored; this is not the full source-bound CI proof.\n',
      );
    } finally {
      for (const handle of handles) closeSync(handle.fd);
      for (const client of clients) client.destroy();
      for (const record of keys.values()) record.key.fill(0);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
