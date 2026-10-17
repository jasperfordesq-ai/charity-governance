import {spawnSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {S3Client} from '@aws-sdk/client-s3';
import {KMSClient} from '@aws-sdk/client-kms';
import {config as defaults,credentials} from '../apps/api/dist/tests/fixtures/archived-custody.js';
import {callSyntheticCustody,readSyntheticCustodyDescriptor} from './synthetic-custody-wire.mjs';
const wire=fileURLToPath(new URL('./synthetic-custody-wire.mjs',import.meta.url));
function sync(descriptor,payload){
 const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
 const r=spawnSync(process.execPath,[wire,'--rpc'],{input:JSON.stringify({descriptor,payload}),encoding:'utf8',env,timeout:15000,maxBuffer:16*1024*1024,windowsHide:true});
 if(r.status!==0||r.error)throw new Error('Synthetic custody original response unavailable');return JSON.parse(r.stdout);
}
async function requestBody(body){
 if(body===undefined||body===null)return null;
 if(typeof body==='string'||Buffer.isBuffer(body)||ArrayBuffer.isView(body))return Buffer.from(body).toString('base64');
 const chunks=[];let size=0;for await(const b of body){size+=b.length;if(size>16*1024*1024)throw new Error('Synthetic request too large');chunks.push(Buffer.from(b));}return Buffer.concat(chunks).toString('base64');
}
export function connectSyntheticCustody(descriptor,id,config){
 const handler=service=>({async handle(request){
  const encoded={hostname:request.hostname,protocol:request.protocol,headers:request.headers,method:request.method,path:request.path,query:request.query,body:await requestBody(request.body)};
  const r=await callSyntheticCustody(descriptor,{op:'sdk',id,service,request:encoded});
  return{response:{statusCode:r.statusCode,headers:r.headers,body:Readable.from([Buffer.from(r.body,'base64')])}};
 },destroy(){}});
 const b={sessionId:id,bindControl:controlSessionId=>sync(descriptor,{op:'bindControl',id,controlSessionId}),s3:()=>new S3Client({region:'eu-west-1',endpoint:'https://s3.eu-west-1.amazonaws.com',credentials,maxAttempts:1,requestHandler:handler('s3')}),
  kms:()=>new KMSClient({region:'eu-west-1',endpoint:'https://kms.eu-west-1.amazonaws.com',credentials,maxAttempts:1,requestHandler:handler('kms')}),close(){}};
 for(const name of ['reads','writes','generates'])Object.defineProperty(b,name,{get:()=>sync(descriptor,{op:'stats',id})[name]});
 Object.defineProperty(b,'objects',{get:()=>new Map(sync(descriptor,{op:'metadata',id}))});
 for(const name of ['loseRoot','losePrepared','loseCommonRequestRead','loseCommonReportRead','loseJobRequestRead','loseJobObservationRead','loseJobServiceRead','loseDaemonHeaderRead','loseDaemonIntentRead'])Object.defineProperty(b,name,{set:value=>{sync(descriptor,{op:'flag',id,name,value});}});
 return Object.freeze(b);
}
/** Explicit synthetic source selector only; never real provider configuration. */
export function openSyntheticCustodyProcess(installationId,path){
 if(process.env.CHARITYPILOT_TEST_CONTAINED_SOURCE!=='1')throw new Error('Synthetic contained source required');
 const descriptor=readSyntheticCustodyDescriptor(path),config={...defaults,installationId},opened=sync(descriptor,{op:'open',config});
 return connectSyntheticCustody(descriptor,opened.id,config);
}
