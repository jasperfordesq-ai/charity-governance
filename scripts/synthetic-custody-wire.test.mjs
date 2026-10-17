import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {callSyntheticCustody,readSyntheticCustodyDescriptor} from './synthetic-custody-wire.mjs';
test('synthetic transport rejects non-loopback endpoints and invalid capabilities before connection',async()=>{
 const base={kind:'SYNTHETIC_CUSTODY_PROCESS_V1',endpoint:'http://127.0.0.1:12345/',capability:'a'.repeat(64)};
 for(const change of [{endpoint:'https://s3.eu-west-1.amazonaws.com/'},{endpoint:'http://localhost:12345/'},{endpoint:'http://127.0.0.1:99999/'},{endpoint:'http://127.0.0.1:12345/other'},{capability:'real-credential-not-accepted'},{kind:'PROVIDER'}])await assert.rejects(callSyntheticCustody({...base,...change},{op:'stats'}));
 for(const path of ['/tmp/session.json','/tmp/charitypilot-synthetic-custody-abcdef/../session.json'])assert.throws(()=>readSyntheticCustodyDescriptor(path));
});
test('successful local response has no cache fallback after refusal or service loss',async()=>{
 let refuse=false;const server=createServer((req,res)=>{req.resume();assert.equal(req.headers['x-charitypilot-synthetic-capability'],'a'.repeat(64));res.writeHead(refuse?409:200,{'content-type':'application/json'});res.end(JSON.stringify({ok:!refuse,value:{readOnly:true}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const descriptor={kind:'SYNTHETIC_CUSTODY_PROCESS_V1',endpoint:'http://127.0.0.1:'+server.address().port+'/',capability:'a'.repeat(64)};
 try{assert.deepEqual(await callSyntheticCustody(descriptor,{op:'stats'}),{readOnly:true});refuse=true;await assert.rejects(callSyntheticCustody(descriptor,{op:'stats'}));}finally{await new Promise(r=>server.close(r));}
 await assert.rejects(callSyntheticCustody(descriptor,{op:'stats'}));
});
