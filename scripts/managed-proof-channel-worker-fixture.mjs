import {writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
const chunks=[];let size=0;
try{
 for await(const b of process.stdin){size+=b.length;if(size>16384)throw new Error();chunks.push(Buffer.from(b));}
 const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(Object.keys(value).sort().join(',')!=='args,jobId,snapshot'||!Array.isArray(value.args)||value.args.length!==2||value.args[0]!=='prove-restore'||!['success','hold'].includes(value.args[1])||!process.env.CHARITYPILOT_SYNTHETIC_CHANNEL_SOCKET)throw new Error();
 writeFileSync(join(dirname(process.env.CHARITYPILOT_SYNTHETIC_CHANNEL_SOCKET),'worker.ready.json'),JSON.stringify({jobId:value.jobId,pid:process.pid}),{flag:'wx',mode:0o600});
 if(value.args[1]==='success')process.stdout.write(JSON.stringify({format:1,kind:'MANAGED_IMPORTED_PROOF_WORKER_V1',ok:true}));
 else setInterval(()=>{},1000);
}catch{process.exitCode=1;}finally{for(const b of chunks)b.fill(0);}
