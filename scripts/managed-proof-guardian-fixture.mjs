import {fileURLToPath} from 'node:url';
import {isAbsolute,basename,dirname} from 'node:path';
import {writeFileSync,linkSync,unlinkSync} from 'node:fs';
import {runManagedProofGuardian} from './managed-proof-guardian.mjs';
const receipt=process.env.CHARITYPILOT_SYNTHETIC_GUARDIAN_RECEIPT;
if(typeof receipt!=='string'||!isAbsolute(receipt)||basename(receipt)!=='guardian-result.json'||!/^capture-[A-Za-z0-9]{6}$/.test(basename(dirname(receipt))))throw new Error('Synthetic receipt path refused');
await runManagedProofGuardian({workerPath:fileURLToPath(new URL('./managed-proof-docker-fixture.mjs',import.meta.url)),onTerminal:value=>{
 const pending=receipt+'.pending';writeFileSync(pending,JSON.stringify(value),{flag:'wx',mode:0o600});linkSync(pending,receipt);unlinkSync(pending);
}});
