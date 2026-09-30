import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerCopyReviewRoutes } from '../routes/copy-review.js';

test('copy review routes separate Owner approval, Admin preservation and privileged browser writes',async()=>{
  for(const prefix of ['', '/complaints'] as const) for(const role of ['OWNER','ADMIN','MEMBER'] as const)
  for(const clientKind of ['WEB','MCP_CONNECTOR'] as const) for(const accessLevel of ['ADMIN','WRITE','READ'] as const) {
    const app=Fastify();let calls=0;
    app.addHook('onRequest',async req=>{req.user={userId:'actor',organisationId:'org',role} as any;req.authSession={clientKind,accessLevel} as any;});
    const invoke=async()=>{calls++;return {};};
    registerCopyReviewRoutes(app,prefix,{list:invoke,review:invoke,hold:invoke} as any,{list:invoke,create:invoke,withdraw:invoke} as any);
    try {
      const cases=[
        ['GET','/purge-authorizations/auth/copy-authorities',{},true],
        ['POST','/purge-authorizations/auth/copy-authorities',{},true],
        ['GET','/purge-authorizations/auth/copy-holds',{},false],
        ['POST','/purge-authorizations/auth/copy-holds',{},false],
        ['GET','/copy-policy-revisions',{},false],
        ['POST','/copy-policy-revisions',{state:'DRAFT'},false],
        ['POST','/copy-policy-revisions',{state:'APPROVED'},true],
        ['POST','/copy-policy-revisions/policy/withdraw',{},true],
      ] as const;
      for(const [method,path,payload,owner] of cases) {
        const allowed=clientKind==='WEB'&&role!=='MEMBER'&&(!owner||role==='OWNER')&&(method==='GET'||accessLevel==='ADMIN');
        const before=calls;const response=await app.inject({method,url:prefix+path,...(method==='POST'?{payload}:{})});
        assert.equal(response.statusCode,allowed?(method==='POST'?201:200):403,`${prefix}/${role}/${clientKind}/${accessLevel}/${path}`);
        assert.equal(calls-before,allowed?1:0);
      }
    } finally {await app.close();}
  }
});
