import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'build-identity-test-secret';

const [{ default: Fastify }, { buildIdentity, isNewerRelease }, { healthRoutes }, { signAccessToken }] =
  await Promise.all([
    import('fastify'),
    import('../utils/build-identity.js'),
    import('../routes/health/index.js'),
    import('../utils/jwt.js'),
  ]);

const authorization = `Bearer ${signAccessToken({
  userId: 'u1',
  organisationId: 'org-1',
  role: 'ADMIN',
  sessionId: 'sess-1',
})}`;

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorate('prisma', {} as never);
  await app.register(healthRoutes, { prefix: '/api/v1/health' });
  return app;
}

test('the build knows its own version', () => {
  // Read from the package manifest rather than kept in a constant beside it,
  // because a constant is a second place to remember to change.
  assert.match(buildIdentity().version ?? '', /^\d+\.\d+\.\d+/);
});

test('health says nothing about the build to a caller with no credential', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
    assert.equal(
      response.json().build,
      undefined,
      'a version is a free hint to anyone scanning for one',
    );
  } finally {
    await app.close();
  }
});

test('health says nothing about the build to an invented credential either', async () => {
  const app = await buildApp();
  try {
    for (const invented of ['Bearer not-a-token', 'Bearer a.b.c', 'Basic abcdef']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { authorization: invented },
      });
      assert.equal(response.json().build, undefined, `"${invented}" must learn nothing`);
    }
  } finally {
    await app.close();
  }
});

test('health tells a signed-in caller which build it is', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { authorization },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().build.version, buildIdentity().version);
  } finally {
    await app.close();
  }
});

test('the health check still answers, credential or not', async () => {
  // Whatever else changes here, a readiness probe with no credential must
  // keep getting its two hundred.
  const app = await buildApp();
  try {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/health' });
    const signedIn = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { authorization },
    });

    assert.equal(anonymous.statusCode, 200);
    assert.equal(signedIn.statusCode, 200);
    assert.equal(anonymous.json().status, 'ok');
    assert.equal(signedIn.json().status, 'ok');
  } finally {
    await app.close();
  }
});

test('one release is newer than another by the three numbers', () => {
  assert.equal(isNewerRelease('0.2.0', '0.1.9'), true);
  assert.equal(isNewerRelease('1.0.0', '0.9.9'), true);
  assert.equal(isNewerRelease('0.1.10', '0.1.9'), true, 'ten is after nine, not before it');
  assert.equal(isNewerRelease('0.1.0', '0.1.0'), false);
  assert.equal(isNewerRelease('0.1.0', '0.2.0'), false);
});

test('an unreadable version produces no answer rather than a wrong one', () => {
  for (const [left, right] of [
    [null, '0.1.0'],
    ['0.1.0', null],
    ['nightly', '0.1.0'],
    ['0.1.0', 'nightly'],
  ] as const) {
    assert.equal(isNewerRelease(left, right), false, `${left} vs ${right}`);
  }
});

const identityUrl=new URL('../utils/build-identity.js',import.meta.url).href;
function isolatedBuildIdentity(values: Record<string,string>, route=false) {
  const env={...process.env};
  delete env.CHARITYPILOT_BUILD_REVISION;delete env.CHARITYPILOT_BUILD_COMMIT;
  Object.assign(env,values);
  const code=route?
    `import Fastify from 'fastify';
     import {healthRoutes} from ${JSON.stringify(new URL('../routes/health/index.js',import.meta.url).href)};
     import {signAccessToken} from ${JSON.stringify(new URL('../utils/jwt.js',import.meta.url).href)};
     const app=Fastify({logger:false});app.decorate('prisma',{});
     await app.register(healthRoutes,{prefix:'/api/v1/health'});
     try {const token=signAccessToken({userId:'synthetic-user',organisationId:'synthetic-org',role:'ADMIN',sessionId:'synthetic-session'});
       const signed=await app.inject({method:'GET',url:'/api/v1/health',headers:{authorization:'Bearer '+token}});
       const anonymous=await app.inject({method:'GET',url:'/api/v1/health'});
       process.stdout.write(JSON.stringify({revision:signed.json().build.revision,anonymousBuild:anonymous.json().build??null}));
     }finally{await app.close();}`
    :`import {buildIdentity} from ${JSON.stringify(identityUrl)};process.stdout.write(JSON.stringify(buildIdentity()));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{env,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}

for(const [label,values,expected] of [
  ['explicit revision wins',{CHARITYPILOT_BUILD_REVISION:' explicit-release ',CHARITYPILOT_BUILD_COMMIT:'a'.repeat(40)},'explicit-release'],
  ['image commit fills missing revision',{CHARITYPILOT_BUILD_COMMIT:'a'.repeat(40)},'a'.repeat(40)],
  ['image commit fills blank revision',{CHARITYPILOT_BUILD_REVISION:'  ',CHARITYPILOT_BUILD_COMMIT:' aaaaaaa '},'aaaaaaa'],
  ['missing stamps stay unknown',{},null],
  ['blank stamps stay unknown',{CHARITYPILOT_BUILD_REVISION:' ',CHARITYPILOT_BUILD_COMMIT:' '},null],
] as const) {
  test('build identity '+label,()=>{assert.equal(isolatedBuildIdentity(values).revision,expected);});
}

test('image-only build stamp reaches signed health without anonymous disclosure',()=>{
  const result=isolatedBuildIdentity({CHARITYPILOT_BUILD_COMMIT:'a'.repeat(40),JWT_SECRET:'synthetic-build-identity-secret'},true);
  assert.equal(result.revision,'a'.repeat(40));assert.equal(result.anonymousBuild,null);
});
