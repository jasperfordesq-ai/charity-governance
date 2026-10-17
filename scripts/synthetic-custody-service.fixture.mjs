import {createServer} from 'node:http';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import assert from 'node:assert/strict';
import {backend,config as defaults} from '../apps/api/dist/tests/fixtures/archived-custody.js';
import {syntheticCustodyAllowed} from './synthetic-custody-policy.mjs';
if(!process.connected||process.argv.length!==2)throw new Error('Synthetic custody owner required');
const capability=randomBytes(32).toString('hex'),recoveryCapability=randomBytes(32).toString('hex'),sessions=new Map(),limit=32*1024*1024;
const flags=['loseRoot','losePrepared','loseCommonRequestRead','loseCommonReportRead','loseJobRequestRead','loseJobObservationRead','loseJobServiceRead'];
async function bounded(stream){const chunks=[];let size=0;for await(const b of stream){size+=b.length;if(size>16*1024*1024)throw new Error();chunks.push(Buffer.from(b));}return Buffer.concat(chunks);}
async function dispatch(v,role){
 assert.equal(syntheticCustodyAllowed(role,v),true);
 if(v.op==='open'){
  assert.ok(sessions.size<32);assert.match(v.config.installationId,/^[A-Za-z0-9_.-]{1,120}$/);assert.deepEqual({...v.config,installationId:defaults.installationId},defaults);
  const id=randomUUID(),b=backend(v.config);sessions.set(id,{b,config:v.config,s3:b.s3(),kms:b.kms(),macKeys:new Set()});return{id};
 }
 if(v.op==='sessions')return[...sessions].map(([id,s])=>({id,config:s.config}));
 const s=sessions.get(v.id);assert.ok(s);
 if(v.op==='stats')return{reads:s.b.reads,writes:s.b.writes,generates:s.b.generates};
 if(v.op==='metadata')return[...s.b.objects].map(([k,o])=>[k,{version:o.version,checksum:o.checksum,type:o.type,contentType:o.contentType,byteLength:o.body.length}]);
 if(v.op==='flag'){assert.ok(flags.includes(v.name));assert.equal(typeof v.value,'boolean');s.b[v.name]=v.value;return true;}
 assert.equal(v.op,'sdk');assert.ok(['s3','kms'].includes(v.service));const r=v.request;
 assert.equal(r.protocol,'https:');assert.match(r.headers.authorization,/^AWS4-HMAC-SHA256 Credential=synthetic\//);assert.equal(r.headers['x-amz-security-token'],undefined);
 assert.ok(v.service==='kms'?r.hostname==='kms.eu-west-1.amazonaws.com':[s.config.bucket+'.s3.eu-west-1.amazonaws.com','s3.eu-west-1.amazonaws.com'].includes(r.hostname));
 const kmsInput=v.service==='kms'?JSON.parse(Buffer.from(r.body,'base64').toString('utf8')):null;
 if(role==='recovery'&&v.service==='kms'){
  if(r.headers['x-amz-target']==='TrentService.Decrypt')assert.equal(kmsInput.KeyId,s.config.dataKeyArn);
  else{assert.ok([s.config.indexMacKeyArn,s.config.rootMacKeyArn].includes(kmsInput.KeyId));assert.equal(s.macKeys.has(kmsInput.KeyId),true);}
 }
 const handler=await s[v.service].config.requestHandler,result=await handler.handle({...r,body:r.body===null?undefined:Buffer.from(r.body,'base64')});
 if(v.service==='kms'&&r.headers['x-amz-target']==='TrentService.GenerateMac'&&result.response.statusCode===200)s.macKeys.add(kmsInput.KeyId);
 const bytes=await bounded(result.response.body);return{statusCode:result.response.statusCode,headers:result.response.headers,body:bytes.toString('base64')};
}
const server=createServer(async(req,res)=>{
 try{
  const supplied=req.headers['x-charitypilot-synthetic-capability'];if(req.method!=='POST'||typeof supplied!=='string'||supplied.length!==capability.length)throw new Error();
  const role=timingSafeEqual(Buffer.from(supplied),Buffer.from(capability))?'owner':timingSafeEqual(Buffer.from(supplied),Buffer.from(recoveryCapability))?'recovery':null;if(!role)throw new Error();
  const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>limit)throw new Error();chunks.push(b);}const value=await dispatch(JSON.parse(Buffer.concat(chunks).toString('utf8')),role),body=JSON.stringify({ok:true,value});if(Buffer.byteLength(body)>limit)throw new Error();res.writeHead(200,{'content-type':'application/json'});res.end(body);
 }catch{res.writeHead(409,{'content-type':'application/json'});res.end('{"ok":false}');}
});
let stopping=false;
function stop(){if(stopping)return;stopping=true;server.close();for(const s of sessions.values()){s.s3.destroy();s.kms.destroy();s.b.close();}if(process.connected)process.disconnect();}
process.once('disconnect',stop);process.on('message',v=>{if(v?.kind==='STOP_SYNTHETIC_CUSTODY_V1')stop();});
await new Promise(r=>server.listen(0,'127.0.0.1',r));process.send({kind:'SYNTHETIC_CUSTODY_PROCESS_V1',endpoint:'http://127.0.0.1:'+server.address().port+'/',capability,recoveryCapability});
