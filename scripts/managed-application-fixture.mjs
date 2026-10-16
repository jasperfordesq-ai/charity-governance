import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toStrictPrismaTlsUrl } from '../packages/shared/runtime/prisma-database-url.mjs';

const postgresImage =
  'postgres@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const secret = () => randomBytes(32).toString('hex');
const environment = (values) =>
  Object.entries(values).flatMap(([name, value]) => [
    '--env',
    name + '=' + value,
  ]);
const hardening = [
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--tmpfs',
  '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
];
const seedSource = String.raw`
import bcrypt from 'bcryptjs';import {createHash} from 'node:crypto';
import {createApplicationPrismaClient} from './dist/utils/application-prisma-client.js';
const db=await createApplicationPrismaClient();
try{
 const result=await db.$transaction(async tx=>{
  const first=await tx.organisation.create({data:{name:'Synthetic managed first'}});
  const second=await tx.organisation.create({data:{name:'Synthetic managed second'}});
  for(const organisationId of [first.id,second.id])await tx.subscription.create({data:{organisationId,plan:'COMPLETE',status:'ACTIVE'}});
  const passwordHash=await bcrypt.hash(process.env.SYNTHETIC_PASSWORD,12);
  const member=await tx.user.create({data:{organisationId:first.id,email:'managed-member@example.invalid',name:'Synthetic Member',role:'MEMBER',passwordHash,emailVerified:true}});
  await tx.user.create({data:{organisationId:second.id,email:'managed-other@example.invalid',name:'Synthetic Other Member',role:'MEMBER',passwordHash,emailVerified:true}});
  const owner=await tx.user.create({data:{organisationId:first.id,email:'managed-owner@example.invalid',name:'Synthetic Owner',role:'OWNER',passwordHash,emailVerified:true}});
  await tx.user.create({data:{organisationId:second.id,email:'managed-other-owner@example.invalid',name:'Synthetic Other Owner',role:'OWNER',passwordHash,emailVerified:true}});
  const document=(organisationId,name,file)=>({organisationId,name,category:'OTHER',fileUrl:organisationId+'/'+file,fileSize:Buffer.byteLength(process.env.SYNTHETIC_BYTES),mimeType:'text/plain',storageProvider:'local',lifecycleStatus:'CURRENT',owner:'Synthetic fixture'});
  const visible=await tx.document.create({data:{...document(first.id,'Synthetic reviewed public record','reviewed.txt'),visibility:'MEMBER_VISIBLE',contentAccessClass:'MEMBER_SUITABLE',memberReviewedSha256:createHash('sha256').update(process.env.SYNTHETIC_BYTES).digest('hex')}});
  const restricted=await tx.document.create({data:{...document(first.id,'Synthetic restricted record','restricted.txt'),lifecycleStatus:'DRAFT'}});
  const foreign=await tx.document.create({data:{...document(second.id,'Synthetic other charity record','foreign.txt'),visibility:'MEMBER_VISIBLE',contentAccessClass:'MEMBER_SUITABLE',memberReviewedSha256:createHash('sha256').update(process.env.SYNTHETIC_BYTES).digest('hex')}});
  return {organisation:first.id,member:member.id,owner:owner.id,visible:visible.id,restricted:restricted.id,foreign:foreign.id,path:visible.fileUrl,foreignPath:foreign.fileUrl};
 });process.stdout.write(JSON.stringify(result));
}finally{await db.$disconnect();}`;

/** Uses only the caller's freshly verified/pinned Docker endpoint and owned
 * fixture inventory. No production data, external provider or real authority. */
export async function proveManagedApplication({
  docker,
  root,
  id,
  internal,
  containers,
  volumes,
  extraImages,
  f,
  request,
  base,
  host,
}) {
  const record = f.binding.record,
    apiImage = id + ':application',
    migrationImage = id + ':migration';
  console.info(
    'Managed application proof: building normal API and migration images',
  );
  docker([
    'build',
    '--file',
    'apps/api/Dockerfile',
    '--target',
    'runner',
    '--build-arg',
    'CHARITYPILOT_BUILD_COMMIT=' + record.sourceSha,
    '--build-arg',
    'CHARITYPILOT_MANAGED_API_PEER_BINDING_SHA256=' + f.binding.sha256,
    '--tag',
    apiImage,
    '.',
  ]);
  extraImages.push(apiImage);
  docker([
    'build',
    '--file',
    'apps/api/Dockerfile',
    '--target',
    'migration-runner',
    '--tag',
    migrationImage,
    '.',
  ]);
  extraImages.push(migrationImage);
  const secretsVolume = id + '-api-secrets',
    caVolume = id + '-database-ca';
  for (const name of [secretsVolume, caVolume]) {
    docker(['volume', 'create', name]);
    volumes.push(name);
  }
  const bundle = {
    format: 1,
    service: 'api',
    meshSha256: f.binding.sha256,
    issuerCertPem: f.issuer,
    serverCertPem: f.api.cert,
    serverKeyPem: f.api.key,
  };
  docker(
    [
      'run',
      '--rm',
      '--interactive',
      '--network',
      'none',
      ...hardening,
      '--user',
      '0:1000',
      '--mount',
      'type=volume,source=' + secretsVolume + ',target=/out-api',
      '--mount',
      'type=volume,source=' + caVolume + ',target=/out-ca',
      '--entrypoint',
      'node',
      apiImage,
      '-e',
      String.raw`const fs=require('node:fs');let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',p=>raw+=p);process.stdin.on('end',()=>{const v=JSON.parse(raw);fs.writeFileSync('/out-api/charitypilot-api-tls.json',JSON.stringify(v.bundle)+'\n',{flag:'wx',mode:0o440});for(const path of ['/out-api/database-ca.pem','/out-ca/database-ca.pem'])fs.writeFileSync(path,v.issuer,{flag:'wx',mode:0o440});});`,
    ],
    JSON.stringify({ bundle, issuer: f.issuer }),
  );
  const uid = docker([
    'run',
    '--rm',
    '--network',
    'none',
    ...hardening,
    '--entrypoint',
    'id',
    postgresImage,
    '-u',
    'postgres',
  ]);
  const gid = docker([
    'run',
    '--rm',
    '--network',
    'none',
    ...hardening,
    '--entrypoint',
    'id',
    postgresImage,
    '-g',
    'postgres',
  ]);
  assert.match(uid, /^[1-9][0-9]{0,5}$/);
  assert.match(gid, /^[1-9][0-9]{0,5}$/);
  const database = id + '-database',
    databaseHost = 'charitypilot-managed-database',
    ownerPassword = secret(),
    runtimePassword = secret();
  docker([
    'run',
    '--detach',
    '--name',
    database,
    '--network',
    internal,
    '--network-alias',
    databaseHost,
    '--user',
    uid + ':' + gid,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    ...['/tmp', '/var/lib/postgresql/data', '/var/run/postgresql'].flatMap(
      (path) => [
        '--tmpfs',
        path + ':rw,nosuid,size=192m,uid=' + uid + ',gid=' + gid + ',mode=0700',
      ],
    ),
    ...environment({
      POSTGRES_PASSWORD: ownerPassword,
      POSTGRES_DB: 'charitypilot',
      POSTGRES_HOST_AUTH_METHOD: 'scram-sha-256',
      POSTGRES_INITDB_ARGS: '--auth-host=scram-sha-256 --auth-local=trust',
    }),
    '--entrypoint',
    'sh',
    postgresImage,
    '-eu',
    '-c',
    'while [ ! -f /tmp/ready ]; do sleep 0.1; done; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.pem -c ssl_key_file=/tmp/server.key',
  ]);
  containers.push(database);
  for (const [file, bytes] of [
    ['server.pem', f.database.cert],
    ['server.key', f.database.key],
  ])
    docker(
      [
        'exec',
        '--interactive',
        database,
        'sh',
        '-eu',
        '-c',
        'umask 077; cat > /tmp/' + file,
      ],
      bytes,
    );
  docker(['exec', database, 'touch', '/tmp/ready']);
  // Only fixture-local unix-socket maintenance uses trust. Every application,
  // migration and role-probe connection uses real verified TLS and SCRAM.
  const query = (sql) =>
    docker(
      [
        'exec',
        '--interactive',
        database,
        'psql',
        '-X',
        '-Atq',
        '-U',
        'postgres',
        '-d',
        'charitypilot',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      sql,
    );
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      docker([
        'exec',
        database,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
        '-d',
        'charitypilot',
      ]);
      break;
    } catch {}
    if (attempt === 149)
      throw new Error('Synthetic TLS database readiness failed');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const caMount = [
    '--mount',
    'type=volume,source=' + caVolume + ',target=/run/charitypilot,readonly',
  ];
  const databaseUrl = (role, password, certificatePath) =>
    'postgresql://' +
    role +
    ':' +
    password +
    '@' +
    databaseHost +
    ':5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write&sslrootcert=' +
    encodeURIComponent(certificatePath) +
    '&connect_timeout=3';
  const runtimeUrl = databaseUrl(
    'cp_runtime',
    runtimePassword,
    '/run/charitypilot/database-ca.pem',
  );
  console.info(
    'Managed application proof: applying source migrations over verified TLS',
  );
  docker([
    'run',
    '--rm',
    '--network',
    internal,
    ...hardening,
    ...caMount,
    ...environment({
      DATABASE_URL: toStrictPrismaTlsUrl(
        databaseUrl(
          'postgres',
          ownerPassword,
          '/run/charitypilot/database-ca.pem',
        ),
      ),
    }),
    migrationImage,
  ]);
  const expectedMigrations = readdirSync(
    join(root, 'apps/api/prisma/migrations'),
    { withFileTypes: true },
  ).filter((entry) => entry.isDirectory()).length;
  assert.equal(
    query(
      'SELECT count(*) FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    ),
    String(expectedMigrations),
  );
  docker(
    [
      'exec',
      '--interactive',
      '--env',
      'CHARITYPILOT_RUNTIME_PASSWORD=' + runtimePassword,
      database,
      'psql',
      '-X',
      '-q',
      '-U',
      'postgres',
      '-d',
      'charitypilot',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    "\\getenv runtime_password CHARITYPILOT_RUNTIME_PASSWORD\nCREATE ROLE cp_runtime LOGIN PASSWORD :'runtime_password' NOINHERIT;",
  );
  docker(
    [
      'exec',
      '--interactive',
      '--env',
      'CHARITYPILOT_RUNTIME_ROLE=cp_runtime',
      '--env',
      'CHARITYPILOT_RUNTIME_PASSWORD=' + runtimePassword,
      database,
      'psql',
      '-X',
      '-q',
      '-U',
      'postgres',
      '-d',
      'charitypilot',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    readFileSync(
      join(root, 'scripts/bluegreen/runtime-role-grants.psql'),
      'utf8',
    ),
  );
  const jobs = (code, values = {}, input) =>
    docker(
      [
        'run',
        '--rm',
        '--interactive',
        '--network',
        internal,
        ...hardening,
        ...caMount,
        ...environment({
          DATABASE_URL: runtimeUrl,
          NODE_ENV: 'production',
          CHARITYPILOT_DEPLOYMENT_MODE: 'production',
          ...values,
        }),
        '--entrypoint',
        'node',
        apiImage,
        ...code,
      ],
      input,
    );
  assert.deepEqual(
    JSON.parse(
      jobs(
        ['dist/jobs/verify-runtime-database-role.js'],
        {},
        JSON.stringify({
          runtimeRole: 'cp_runtime',
          maintenanceRole: 'postgres',
          database: 'charitypilot',
          phase: 'after-migration',
        }),
      ),
    ),
    { schemaVersion: 1, verified: true, phase: 'after-migration' },
  );
  const password = secret(),
    bytes = 'Synthetic reviewed managed application bytes\n';
  const seeded = JSON.parse(
    jobs(['--input-type=module', '-e', seedSource], {
      SYNTHETIC_PASSWORD: password,
      SYNTHETIC_BYTES: bytes,
    }),
  );
  const api = id + '-application',
    readiness = secret();
  console.info(
    'Managed application proof: starting default production API command',
  );
  docker([
    'run',
    '--detach',
    '--name',
    api,
    '--network',
    internal,
    '--network-alias',
    new URL(record.apiOrigin).hostname,
    ...hardening,
    '--tmpfs',
    '/data/documents:rw,noexec,nosuid,size=16m,uid=1000,gid=1000,mode=0700',
    '--mount',
    'type=volume,source=' + secretsVolume + ',target=/etc/secrets,readonly',
    ...environment({
      NODE_ENV: 'production',
      PORT: '3002',
      CHARITYPILOT_DEPLOYMENT_MODE: 'production',
      CHARITYPILOT_TENANCY: 'multi',
      CHARITYPILOT_REGISTRATION: 'closed',
      CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
      CHARITYPILOT_BILLING: 'none',
      CHARITYPILOT_PRIVILEGED_MFA_MODE: 'required',
      CHARITYPILOT_ERROR_ALERTS: 'none',
      CHARITYPILOT_MANAGED_PROVIDER: 'render',
      CHARITYPILOT_MANAGED_TLS_DELIVERY: 'render-secret-file-v1',
      CHARITYPILOT_MANAGED_API_PEER_BINDING: f.binding.json,
      CHARITYPILOT_BUILD_COMMIT: record.sourceSha,
      RENDER_SERVICE_TYPE: 'pserv',
      RENDER_SERVICE_ID: record.apiServiceId,
      DATABASE_URL: databaseUrl(
        'cp_runtime',
        runtimePassword,
        '/etc/secrets/database-ca.pem',
      ),
      JWT_SECRET: secret(),
      OWNER_JWT_SECRET: secret(),
      AUTH_RECOVERY_SECRET: secret(),
      INTEGRATION_ENCRYPTION_KEY: secret(),
      READINESS_API_KEY: readiness,
      JWT_EXPIRES_IN: '15m',
      REFRESH_TOKEN_TTL_DAYS: '14',
      FRONTEND_URL: record.publicOrigin,
      NEXT_PUBLIC_API_URL: record.publicOrigin,
      CHARITYPILOT_CANONICAL_WEB_ORIGIN: record.publicOrigin,
      CHARITYPILOT_CANONICAL_API_ORIGIN: record.publicOrigin,
      DOCUMENT_STORAGE_DRIVER: 'local',
      LOCAL_FILE_STORAGE_DIR: '/data/documents',
    }),
    apiImage,
  ]);
  containers.push(api);
  const inspected = JSON.parse(docker(['inspect', api]))[0];
  assert.deepEqual(inspected.Config.Cmd, ['node', 'dist/start.js']);
  assert.equal(inspected.Config.User, 'node');
  assert.equal(
    Object.keys(inspected.NetworkSettings.Ports ?? {}).filter(
      (port) => inspected.NetworkSettings.Ports[port],
    ).length,
    0,
  );
  const headers = { host };
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request(base + '/api/v1/health', { headers });
    if (response.status === 200) {
      ready = true;
      break;
    }
    if (!JSON.parse(docker(['inspect', api]))[0].State.Running)
      throw new Error(
        'Normal managed API startup failed: ' + docker(['logs', api]),
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Normal production API did not become healthy');
  assert.equal(
    (await request(base + '/api/v1/health/readiness', { headers })).status,
    401,
  );
  const readyResponse = await request(base + '/api/v1/health/readiness', {
    headers: { ...headers, 'x-charitypilot-readiness-key': readiness },
  });
  assert.equal(
    readyResponse.status,
    200,
    'Normal readiness rejected the valid capability',
  );
  const readinessBody = await readyResponse.json();
  assert.equal(readinessBody.status, 'ready');
  assert.equal(readinessBody.buildCommit, record.sourceSha);
  assert.equal(readinessBody.checks.database, true);
  assert.equal(readinessBody.checks.authRecoveryControlReady, true);
  docker(
    [
      'exec',
      '--interactive',
      api,
      'node',
      '-e',
      "const fs=require('node:fs'),path=require('node:path');let raw='';process.stdin.on('data',p=>raw+=p);process.stdin.on('end',()=>{const v=JSON.parse(raw);for(const name of v.paths){const file='/data/documents/'+name;fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,v.bytes,{flag:'wx',mode:0o400});}});",
    ],
    JSON.stringify({ paths: [seeded.path, seeded.foreignPath], bytes }),
  );
  async function login(email) {
    const response = await request(base + '/api/v1/auth/login', {
      method: 'POST',
      headers: {
        ...headers,
        origin: record.publicOrigin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200, 'Normal synthetic login refused');
    const cookie = response.headers
      .get('set-cookie')
      ?.match(/charitypilot_access=([^;,\s]+)/)?.[0];
    assert.ok(cookie, 'Login did not issue an access cookie');
    return { cookie, body: await response.json() };
  }
  const member = await login('managed-member@example.invalid');
  assert.equal(
    (
      await request(base + '/api/v1/auth/me', {
        headers: { ...headers, cookie: member.cookie },
      })
    ).status,
    200,
  );
  const listing = await request(base + '/api/v1/documents', {
    headers: { ...headers, cookie: member.cookie },
  });
  assert.equal(listing.status, 200);
  const listingBody = await listing.text();
  assert.ok(listingBody.includes(seeded.visible));
  assert.ok(!listingBody.includes(seeded.restricted));
  assert.ok(!listingBody.includes(seeded.foreign));
  const download = await request(
    base + '/api/v1/documents/' + seeded.visible + '/download',
    { headers: { ...headers, cookie: member.cookie } },
  );
  assert.equal(download.status, 200);
  assert.equal(await download.text(), bytes);
  for (const doc of [seeded.restricted, seeded.foreign])
    assert.equal(
      (
        await request(base + '/api/v1/documents/' + doc + '/download', {
          headers: { ...headers, cookie: member.cookie },
        })
      ).status,
      404,
    );
  const page = await request(base + '/documents', {
    headers: { ...headers, cookie: member.cookie },
  });
  assert.equal(
    page.status,
    200,
    'Compiled Next could not validate the actual production session',
  );
  const other = await login('managed-other@example.invalid');
  assert.equal(
    (
      await request(
        base + '/api/v1/documents/' + seeded.foreign + '/download',
        { headers: { ...headers, cookie: other.cookie } },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        base + '/api/v1/documents/' + seeded.visible + '/download',
        { headers: { ...headers, cookie: other.cookie } },
      )
    ).status,
    404,
  );
  const owner = await login('managed-owner@example.invalid');
  assert.equal(owner.body.mfaEnrolmentRequired, true);
  const deniedOwner = await request(base + '/api/v1/documents', {
    headers: { ...headers, cookie: owner.cookie },
  });
  assert.equal(deniedOwner.status, 403);
  assert.equal(
    (await deniedOwner.json()).code,
    'PRIVILEGED_MFA_ENROLMENT_REQUIRED',
  );
  const ownerPage = await request(base + '/documents', {
    headers: { ...headers, cookie: owner.cookie },
  });
  assert.ok([302, 307].includes(ownerPage.status));
  assert.equal(
    ownerPage.headers.get('location'),
    record.publicOrigin + '/security-data',
  );
  assert.equal(
    query(
      "SELECT count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a USING(pid) WHERE a.usename='cp_runtime' AND s.ssl",
    ),
    query("SELECT count(*) FROM pg_stat_activity WHERE usename='cp_runtime'"),
  );
  assert.doesNotMatch(docker(['logs', api]), new RegExp(readiness));
  console.info(
    'Managed application proof: normal startup, role/TLS, readiness, tenant/Member bytes, privileged MFA and compiled Next session PASS (' +
      expectedMigrations +
      ' migrations)',
  );
  docker(['stop', '--time', '5', api]);
  assert.equal(JSON.parse(docker(['inspect', api]))[0].State.ExitCode, 0);
  docker(['network', 'disconnect', internal, api]);
}
