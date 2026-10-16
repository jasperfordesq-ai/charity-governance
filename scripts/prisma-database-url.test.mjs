import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toStrictPrismaTlsUrl } from '../packages/shared/runtime/prisma-database-url.mjs';

const canonical='postgresql://cp_runtime:synthetic-password@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write';
test('Prisma transport explicitly requires TLS and strict certificate/hostname checks',()=>{
  const result=new URL(toStrictPrismaTlsUrl(canonical));
  assert.equal(result.searchParams.get('sslmode'),'require');
  assert.equal(result.searchParams.get('sslaccept'),'strict');
  assert.equal(result.searchParams.get('target_session_attrs'),'read-write');
  assert.equal(result.username,'cp_runtime');
  assert.equal(result.password,'synthetic-password');
  assert.equal(result.hostname,'db.charitypilot.ie');
  assert.equal(new URL(canonical).searchParams.get('sslmode'),'verify-full');
});
test('an explicit canonical root CA becomes the proven Prisma certificate input',()=>{
  const result=new URL(toStrictPrismaTlsUrl(canonical+'&sslrootcert=%2Fprotected%2Froot.pem'));
  assert.equal(result.searchParams.get('sslcert'),'/protected/root.pem');
  assert.equal(result.searchParams.has('sslrootcert'),false);
});
for(const suffix of ['&sslaccept=accept_invalid_certs','&sslcert=/unreviewed.pem','&host=/socket',
  '&sslmode=prefer','&sslrootcert=relative.pem','&options=-c%20role%3Downer','&connect_timeout=0',
  '&application_name=bad%0Aname','#']) {
  test(`Prisma translation refuses unreviewed connection input ${suffix.split('=')[0]}`,()=>{
    assert.throws(()=>toStrictPrismaTlsUrl(canonical+suffix),error=>{
      assert.equal(error.message,'A canonical verified-TLS database URL is required for Prisma transport.');
      assert.equal(error.cause,undefined);return true;
    });
  });
}
for(const value of [canonical.replace('verify-full','require'),canonical.replace('read-write','any'),
  canonical.replace('cp_runtime','bad%0Arole'),'',null]) {
  test('Prisma transport never converts a weaker or incomplete canonical contract',()=>{
    assert.throws(()=>toStrictPrismaTlsUrl(value));
  });
}
