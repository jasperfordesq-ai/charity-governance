import {spawnSync} from 'node:child_process';
import {DEFAULT_POSTGRES_IMAGE,PROOF_CLIENT_DATA_TMPFS,prepareLocalDockerCommand} from './postgres-backup.mjs';
let size=0;const chunks=[];
try{
 for await(const b of process.stdin){size+=b.length;if(size>2048)throw new Error();chunks.push(b);}
 const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!value||Object.keys(value).sort().join(',')!=='jobId,name'||typeof value.jobId!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/).test(value.jobId)
  ||typeof value.name!=='string'||!(/^charitypilot-source-snapshot-[0-9]+-[0-9]+-[a-f0-9]{8}$/).test(value.name))throw new Error();
 const run=args=>{const p=prepareLocalDockerCommand(['docker',...args],process.env);const r=spawnSync(p.command[0],p.command.slice(1),{env:p.environment,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:65536});if(r.status!==0||r.error)throw new Error();return r.stdout.trim();};
 run(['image','inspect',DEFAULT_POSTGRES_IMAGE,'--format','{{.Id}}']);
 const id=run(['run','--detach','--rm','--name',value.name,'--network','none','--read-only','--tmpfs',PROOF_CLIENT_DATA_TMPFS,
  '--label','charitypilot.restore-proof=true','--label','charitypilot.managed-proof-job='+value.jobId,
  '--label','charitypilot.proof-created-at-ms='+Date.now(),'--entrypoint','sh',DEFAULT_POSTGRES_IMAGE,'-eu','-c','sleep 120']);
 if(!/^[a-f0-9]{64}$/.test(id))throw new Error();process.stdout.write(JSON.stringify({containerId:id}));
 setTimeout(()=>process.exit(1),120000);
}catch{process.exitCode=1;}
