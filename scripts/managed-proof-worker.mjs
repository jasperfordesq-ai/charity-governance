import {runImportedSnapshotRestoreProof} from './postgres-backup.mjs';
let bytes=0;const chunks=[];
try{
 for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>16384)throw new Error();chunks.push(chunk);}
 const body=Buffer.concat(chunks);let input;
 try{input=JSON.parse(body.toString('utf8'));}finally{body.fill(0);for(const b of chunks)b.fill(0);}
 if(!input||Object.keys(input).sort().join(',')!=='args,jobId,snapshot'||typeof input.jobId!=='string')throw new Error();
 const r=await runImportedSnapshotRestoreProof(input.args,input.snapshot,process.env,input.jobId);
 if(r.status!==0){process.stderr.write(String(r.stderr??'').slice(0,4096));throw new Error();}
 process.stdout.write(JSON.stringify({format:1,kind:'MANAGED_IMPORTED_PROOF_WORKER_V1',ok:true}));
}catch{process.exitCode=1;}
