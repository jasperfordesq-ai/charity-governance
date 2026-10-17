import {fileURLToPath} from 'node:url';
import {superviseManagedProofGuardian} from './managed-proof-runner.mjs';
const chunks=[];let size=0;
try{
 for await(const b of process.stdin){size+=b.length;if(size>2048)throw new Error();chunks.push(b);}
 await superviseManagedProofGuardian({input:Buffer.concat(chunks),env:process.env,timeoutMs:45000},
  {guardianPath:fileURLToPath(new URL('./managed-proof-guardian-fixture.mjs',import.meta.url))});
}catch{process.exitCode=1;}
