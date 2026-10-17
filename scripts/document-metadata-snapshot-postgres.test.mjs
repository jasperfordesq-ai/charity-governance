import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  DEFAULT_POSTGRES_IMAGE,
  DOCUMENT_METADATA_SNAPSHOT_SQL,
  spawnLocalDockerCommand,
} from './postgres-backup.mjs';
import {
  canonicalDocumentIdentitySha256,
  canonicalMetadataBindingSha256,
  canonicalObjectKeySha256,
  canonicalDocumentMetadataRowsSha256,
} from '../packages/shared/runtime/document-recovery-inventory.mjs';

const rows = [
  {
    id: 'second',
    organisationId: 'tenant-b',
    fileUrl: 'private/quote"-é-😀-\n\\file',
    fileSize: 0,
    mimeType: 'application/pdf',
  },
  {
    id: 'first',
    organisationId: 'tenant-a',
    fileUrl: 'private/other',
    fileSize: 1024,
    mimeType: 'text/plain',
  },
];
const projection = (values) =>
  canonicalDocumentMetadataRowsSha256(
    values.map((row) => ({
      documentIdentitySha256: canonicalDocumentIdentitySha256(row.id),
      metadataBindingSha256: canonicalMetadataBindingSha256(row),
      objectKeySha256: canonicalObjectKeySha256(row.fileUrl),
      fileSize: row.fileSize,
    })),
  );
const literal = (text) => "'" + text.replaceAll("'", "''") + "'";
const encoded = (text) => Buffer.from(text).toString('base64');

test(
  'real PostgreSQL snapshot projection matches JS across tenants, escaping, concurrent updates and empty inventory',
  { timeout: 120000 },
  () => {
    const name = 'cp-metadata-snapshot-' + randomUUID();
    const setup = `CREATE TABLE public."Document"(id text PRIMARY KEY,"organisationId" text,"fileUrl" text,"fileSize" integer,"mimeType" text);
INSERT INTO public."Document" VALUES ${rows.map((r) => `(${literal(r.id)},${literal(r.organisationId)},${literal(r.fileUrl)},${r.fileSize},${literal(r.mimeType)})`).join(',')};`;
    const observe = `set -eu
psql -h /tmp -d postgres -qAt -v ON_ERROR_STOP=1 -f /tmp/change.sql >/dev/null
psql -h /tmp -d postgres -qAt -v ON_ERROR_STOP=1 -v snapshot="$CP_METADATA_SNAPSHOT" -f /tmp/projection.sql
sed '/^SET TRANSACTION SNAPSHOT /d' /tmp/projection.sql > /tmp/current.sql
psql -h /tmp -d postgres -qAt -v ON_ERROR_STOP=1 -f /tmp/current.sql
psql -h /tmp -d postgres -qAt -v ON_ERROR_STOP=1 -c 'DELETE FROM public."Document"' >/dev/null
psql -h /tmp -d postgres -qAt -v ON_ERROR_STOP=1 -f /tmp/current.sql
psql -h /tmp -d postgres -qAt -v ON_ERROR_STOP=1 -f /tmp/invalid.sql >/dev/null
if psql -h /tmp -d postgres -qAt -v ON_ERROR_STOP=1 -f /tmp/current.sql >/tmp/refused.log 2>&1; then exit 1; fi
printf 'REFUSED\n'
`;
    const holder = String.raw`\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot() AS exported_snapshot \gset
\setenv CP_METADATA_SNAPSHOT :exported_snapshot
\! sh /tmp/observe.sh
COMMIT;
`;
    const change = `UPDATE public."Document" SET "fileUrl"='private/changed' WHERE id='first';`;
    const invalid = `INSERT INTO public."Document" VALUES ('invalid','tenant','private/missing-size',NULL,'text/plain');`;
    const program = `set -eu
initdb -D /tmp/data --no-locale --encoding=UTF8 --auth=trust >/dev/null
pg_ctl -D /tmp/data -o "-c listen_addresses='' -c unix_socket_directories=/tmp" -l /tmp/server.log -w start >/dev/null
trap 'pg_ctl -D /tmp/data -m immediate stop >/dev/null' EXIT
printf '%s' '${encoded(setup)}' | base64 -d > /tmp/setup.sql
printf '%s' '${encoded(DOCUMENT_METADATA_SNAPSHOT_SQL)}' | base64 -d > /tmp/projection.sql
printf '%s' '${encoded(observe)}' | base64 -d > /tmp/observe.sh
printf '%s' '${encoded(change)}' | base64 -d > /tmp/change.sql
printf '%s' '${encoded(invalid)}' | base64 -d > /tmp/invalid.sql
printf '%s' '${encoded(holder)}' | base64 -d > /tmp/holder.sql
psql -h /tmp -d postgres -qAt -v ON_ERROR_STOP=1 -f /tmp/setup.sql >/dev/null
psql -h /tmp -d postgres -qAt -v ON_ERROR_STOP=1 -f /tmp/holder.sql
`;
    try {
      const result = spawnLocalDockerCommand(
        [
          'docker',
          'run',
          '--rm',
          '--name',
          name,
          '--network=none',
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
          program,
        ],
        process.env,
        { timeout: 90000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(result.status, 0, result.stderr?.toString());
      assert.deepEqual(result.stdout.toString().trim().split(/\r?\n/), [
        projection(rows),
        projection(
          rows.map((row) =>
            row.id === 'first' ? { ...row, fileUrl: 'private/changed' } : row,
          ),
        ),
        projection([]),
        'REFUSED',
      ]);
      assert.equal(projection(rows), projection([...rows].reverse()));
      assert.throws(() => projection([rows[0], rows[0]]), /invalid row/);
    } finally {
      spawnLocalDockerCommand(['docker', 'rm', '--force', name], process.env, {
        timeout: 30000,
        maxBuffer: 65536,
      });
    }
  },
);
