import {request} from 'node:http';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const limit=32*1024*1024;
const failure=()=>new Error('Synthetic custody transport unavailable; no cached fallback');
export function readSyntheticCustodyDescriptor(path){
 const root=dirname(path);if(dirname(root)!==resolve(tmpdir())||!/^charitypilot-synthetic-custody-[A-Za-z0-9]{6}$/.test(basename(root))||basename(path)!=='session.json'||realpathSync(root)!==root)throw failure();
 for(const [p,mode] of [[root,0o700],[path,0o600]]){const s=lstatSync(p);if(s.isSymbolicLink()||(p===root?!s.isDirectory():!s.isFile()||s.size>4096)||(process.platform!=='win32'&&(s.uid!==process.getuid()||(s.mode&0o777)!==mode)))throw failure();}
 const bytes=readFileSync(path);if(bytes.length>4096)throw failure();const value=JSON.parse(bytes.toString('utf8'));validate(value);return value;
}
function validate(v){const match=typeof v?.endpoint==='string'?/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/$/.exec(v.endpoint):null;if(!v||v.kind!=='SYNTHETIC_CUSTODY_PROCESS_V1'||!match||Number(match[1])>65535||typeof v.capability!=='string'||!/^[a-f0-9]{64}$/.test(v.capability))throw failure();}
export async function callSyntheticCustody(descriptor,payload){
 validate(descriptor);const body=Buffer.from(JSON.stringify(payload));if(body.length>limit)throw failure();
 return new Promise((yes,no)=>{
  const r=request(descriptor.endpoint,{method:'POST',agent:false,headers:{'content-type':'application/json','content-length':body.length,'x-charitypilot-synthetic-capability':descriptor.capability},timeout:10000},response=>{
   const chunks=[];let size=0;response.on('data',b=>{size+=b.length;if(size>limit)response.destroy(failure());else chunks.push(b);});
   response.on('error',()=>no(failure()));response.on('end',()=>{try{if(response.statusCode!==200)throw failure();const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(v.ok!==true)throw failure();yes(v.value);}catch{no(failure());}});
  });r.on('error',()=>no(failure()));r.on('timeout',()=>r.destroy(failure()));r.end(body);
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv.length!==3||process.argv[2]!=='--rpc')throw failure();const chunks=[];let size=0;for await(const b of process.stdin){size+=b.length;if(size>limit)throw failure();chunks.push(b);}const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));process.stdout.write(JSON.stringify(await callSyntheticCustody(v.descriptor,v.payload)));}
 catch{process.stderr.write(failure().message+'\n');process.exitCode=1;}
}
