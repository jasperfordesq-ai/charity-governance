import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { validateLocalDockerEndpoint } from './personal-server-docker-boundary.mjs';
import { PURGE_RESTORE_SNAPSHOT_SQL } from './purge-restore-reconciliation.mjs';

const image = 'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const password = 'synthetic-byte-authority-proof';
const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
const requireSuccess = (result, label) => {
  assert.equal(
    result.status,
    0,
    `${label}: ${(result.stderr || result.stdout || result.error?.message || 'unknown').slice(-1600)}`,
  );
  return result.stdout.trim();
};

test(
  'current document byte authority composes through real disposable PostgreSQL',
  { timeout: 240_000 },
  async () => {
    const context = run('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker}}']);
    const endpoint = JSON.parse(requireSuccess(context, 'Docker context'));
    validateLocalDockerEndpoint(
      { endpoint: endpoint.Host, skipTlsVerify: endpoint.SkipTLSVerify },
      process.env,
    );
    const docker = (args, options) => run('docker', ['--host', endpoint.Host, ...args], options);
    const name = `charitypilot-byte-authority-${randomUUID()}`;
    const database = `charitypilot_byte_authority_${randomUUID().replaceAll('-', '')}`;
    const id = requireSuccess(
      docker([
        'run',
        '--detach',
        '--network',
        'bridge',
        '--name',
        name,
        '--tmpfs',
        '/var/lib/postgresql/data',
        '--publish',
        '127.0.0.1::5432',
        '--env',
        `POSTGRES_PASSWORD=${password}`,
        '--env',
        `POSTGRES_DB=${database}`,
        image,
      ]),
      'start disposable PostgreSQL',
    );
    try {
      assert.match(id, /^[a-f0-9]{64}$/);
      let ready = false;
      for (let i = 0; i < 80; i += 1) {
        if (
          docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], {
            timeout: 5_000,
          }).status === 0
        ) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(ready, 'disposable PostgreSQL did not become ready');
      const published = requireSuccess(
        docker(['port', name, '5432/tcp']),
        'disposable loopback port',
      );
      const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(published);
      assert.ok(match, 'disposable PostgreSQL must publish on IPv4 loopback only');
      const port = Number(match[1]);
      assert.ok(port > 0 && port < 65536);
      const env = {
        ...process.env,
        DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`,
        CHARITYPILOT_SYNTHETIC_BYTE_PROOF: '1',
      };
      requireSuccess(
        run(
          process.execPath,
          [
            'node_modules/prisma/build/index.js',
            'migrate',
            'deploy',
            '--schema',
            'apps/api/prisma/schema.prisma',
          ],
          { env },
        ),
        'apply all Prisma migrations',
      );
      const grants = readFileSync('scripts/bluegreen/runtime-role-grants.psql', 'utf8');
      requireSuccess(docker(['exec', name, 'psql', '-U', 'postgres', '-d', database,
        '-c', 'GRANT EXECUTE ON FUNCTION public."DocumentByteExecutionLease_claim"(text,text), public."DocumentByteProviderAttempt_start"(text,text), public."DocumentByteProviderObservation_recordAbsent"(text,text,timestamp with time zone) TO PUBLIC']),
      'simulate ACL-free backup restore defaults');
      requireSuccess(docker(['exec', '-i', '-e', 'CHARITYPILOT_RUNTIME_ROLE=cp_fixture',
        '-e', 'CHARITYPILOT_RUNTIME_PASSWORD=synthetic-only', name,
        'psql', '-U', 'postgres', '-d', database], { input: grants }),
      'restrict disposable runtime role');
      requireSuccess(docker(['exec', name, 'psql', '-U', 'postgres', '-d', database,
        '-c', 'GRANT INSERT ON public."DocumentByteProviderAttempt" TO cp_fixture']),
      'simulate unsafe existing provider-attempt grant');
      const unsafeReconcile = docker(['exec', '-i', '-e', 'CHARITYPILOT_RUNTIME_ROLE=cp_fixture',
        '-e', 'CHARITYPILOT_RUNTIME_PASSWORD=synthetic-only', name,
        'psql', '-U', 'postgres', '-d', database], { input: grants });
      assert.notEqual(unsafeReconcile.status, 0,
        'grant reconciliation must refuse an elevated existing provider-attempt role');
      assert.match(unsafeReconcile.stderr, /unsafe existing runtime role/);
      assert.equal(requireSuccess(docker(['exec', name, 'psql', '-U', 'postgres',
        '-d', database, '-tA', '-c', `SELECT has_table_privilege('cp_fixture',
          'public."DocumentByteProviderAttempt"','INSERT')`]),
      'check failed reconciliation preserved the unsafe grant'), 't');
      requireSuccess(docker(['exec', name, 'psql', '-U', 'postgres', '-d', database,
        '-c', 'REVOKE INSERT ON public."DocumentByteProviderAttempt" FROM cp_fixture']),
      'remove synthetic unsafe grant');
      const privileges = requireSuccess(docker(['exec', name, 'psql', '-U', 'postgres',
        '-d', database, '-tA', '-c', `SELECT has_table_privilege('cp_fixture',
          'public."DocumentBytePermitCandidateBinding"','INSERT'),
          has_table_privilege('cp_fixture',
          'public."DocumentBytePermitCandidateBinding"','SELECT'),
          has_table_privilege('cp_fixture',
          'public."DocumentByteExecutionLease"','UPDATE'),
          has_table_privilege('cp_fixture',
          'public."DocumentByteProviderAttempt"','SELECT'),
          has_table_privilege('cp_fixture',
          'public."DocumentByteProviderAttempt"','INSERT,UPDATE,DELETE'),
          has_function_privilege('cp_fixture',
          'public."DocumentByteExecutionLease_claim"(text,text)','EXECUTE'),
          has_function_privilege('cp_fixture',
          'public."DocumentByteProviderAttempt_start"(text,text)','EXECUTE'),
          has_table_privilege('cp_fixture',
          'public."DocumentByteProviderObservation"','SELECT'),
          has_table_privilege('cp_fixture',
          'public."DocumentByteProviderObservation"','INSERT,UPDATE,DELETE'),
          has_function_privilege('cp_fixture',
          'public."DocumentByteProviderObservation_recordAbsent"(text,text,timestamp with time zone)','EXECUTE'),
          EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid =
            'public."DocumentByteExecutionLease_claim"(text,text)'::regprocedure)) acl
            WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'),
          EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid =
            'public."DocumentByteProviderAttempt_start"(text,text)'::regprocedure)) acl
            WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'),
          EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid =
            'public."DocumentByteProviderObservation_recordAbsent"(text,text,timestamp with time zone)'::regprocedure)) acl
            WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE');`]),
      'read disposable runtime privileges');
      assert.equal(privileges, 'f|t|f|t|f|t|t|t|f|t|f|f|f');
      requireSuccess(
        run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json'], {
          env,
        }),
        'build API for real PostgreSQL proof',
      );
      const output = requireSuccess(
        run(process.execPath, ['scripts/document-byte-authority-postgres-proof.mjs'], { env }),
        'composed projection',
      );
      assert.match(
        output,
        /current-authority-real-postgres-composition=verified; protected-worker-skip=verified; cleanup-alias-fence=verified; upload-intent-fence=verified; publication-upload-intent-service=verified; publication-page-intent-service=verified; copy-evidence-digest=stable; post-claim-local-authority=verified; provider-start-marker=verified; provider-start-race=one-winner; provider-unknown-facts=verified; post-start-ordinary-retry-refused=verified; provider-absence-observation=verified; post-observation-fence=unchanged/u,
      );
      const snapshot = JSON.parse(requireSuccess(docker(['exec', name, 'psql', '-U',
        'postgres', '-d', database, '-tA', '-c', PURGE_RESTORE_SNAPSHOT_SQL]),
      'capture format-7 disposable restore inventory'));
      assert.equal(snapshot.format, 7);
      assert.equal(snapshot.tables.DocumentBytePermitCandidateBinding.length, 1);
      assert.equal(snapshot.tables.DocumentByteExecutionLease.length, 1);
      assert.equal(snapshot.tables.DocumentByteProviderAttempt.length, 1);
      assert.equal(snapshot.tables.DocumentByteProviderObservation.length, 1);
    } finally {
      assert.equal(
        requireSuccess(
          docker(['inspect', '--format', '{{.Id}}', name]),
          'identify disposable PostgreSQL',
        ),
        id,
      );
      requireSuccess(docker(['rm', '--force', '--volumes', name]), 'remove disposable PostgreSQL');
      assert.equal(
        requireSuccess(
          docker(['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']),
          'check disposable PostgreSQL residue',
        ),
        '',
      );
    }
  },
);
