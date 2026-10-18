import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {prepareOutcomeCustodyLaunch,launchOriginalOutcomeCustody} from './managed-outcome-custody-launcher.mjs';
function input(){const root=join('/tmp','charitypilot-outcome-custody-ABC123');return{format:1,kind:'MANAGED_OUTCOME_CUSTODIAN_INPUT_V1',
 jobId:randomUUID(),receiverId:randomUUID(),sourceSha:'1'.repeat(40),claim:{path:join('/tmp','charitypilot-outcome-claim-ABC123','claim.sock'),capability:'2'.repeat(64)},
 endpoint:{root,path:join(root,'outcome.sock'),device:1,inode:2,capability:'3'.repeat(64)},ticket:{syntheticPrivateValue:'private-stdin-marker'}};}
test('private ticket remains on stdin and ambient provider/loader credentials are excluded',()=>{
 const raw=input(),v=prepareOutcomeCustodyLaunch(raw,{PATH:'/fixed-bin',HOME:'/fixed-home',AWS_SECRET_ACCESS_KEY:'synthetic-secret',NODE_OPTIONS:'--import arbitrary',LD_PRELOAD:'arbitrary',DATABASE_URL:'private-db'});
 assert.deepEqual(JSON.parse(v.input.toString()),raw);assert.deepEqual(v.environment,{PATH:'/fixed-bin',HOME:'/fixed-home'});
 assert.equal(JSON.stringify(v.args).includes('private-stdin-marker'),false);assert.equal(JSON.stringify(v.args).includes('synthetic-secret'),false);
 assert.equal(v.args.at(-1),'--stdin');assert.match(v.args.at(-2),/managed-outcome-custodian\.mjs$/);
 assert.ok(v.args.includes('--property=KillMode=control-group'));assert.ok(v.args.includes('--property=NoNewPrivileges=yes'));
 v.input.fill(0);
});
test('arbitrary command/provider selectors and changed receiver scope refuse launch preparation',()=>{
 const raw=input();for(const change of [{command:'arbitrary'},{providerUrl:'https://arbitrary.invalid'},{receiverId:raw.jobId},{sourceSha:'HEAD'},{claim:{...raw.claim,path:'/tmp/other.sock'}}])assert.throws(()=>prepareOutcomeCustodyLaunch({...raw,...change}));
});
test('aborted or unsupported launch refuses before consuming the original transfer',async()=>{
 let taken=0;await assert.rejects(launchOriginalOutcomeCustody({signal:AbortSignal.abort(),transfer:{take(){taken++;},claim(){},abandon(){}}}));assert.equal(taken,0);
});
