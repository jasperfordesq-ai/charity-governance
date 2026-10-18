import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {RenderMaintenanceControl,renderMaintenanceConfigurationSchema} from '../services/render-maintenance-control.js';

const input=z.object({format:z.literal(1),registry:renderMaintenanceConfigurationSchema,
 expectedConfigurationDigest:z.string().regex(/^[a-f0-9]{64}$/),token:z.string().regex(/^[\x21-\x7e]{1,512}$/)}).strict();
const refusal='Managed Render inspection refused; no provider action authorised';

/** Explicit read-only HTTP transport. CLI input cannot select a dependency. */
export async function inspectManagedRender(raw:unknown,transport:typeof fetch=fetch){
 try{
  const c=input.parse(raw),provider=new RenderMaintenanceControl(c.registry,c.token,transport);
  if(provider.configurationDigest()!==c.expectedConfigurationDigest)throw new Error();
  return await provider.observeConfiguration();
 }catch{throw new Error(refusal);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const chunks:Buffer[]=[];let size=0,body:Buffer|undefined;
 try{
  if(process.argv.length!==3||process.argv[2]!=='--stdin')throw new Error();
  for await(const value of process.stdin){const chunk=Buffer.from(value);chunks.push(chunk);size+=chunk.length;if(size>16384)throw new Error();}
  body=Buffer.concat(chunks);
  const result=await inspectManagedRender(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)));
  process.stdout.write(JSON.stringify(result)+'\n');
 }catch{process.stderr.write(refusal+'\n');process.exitCode=1;}
 finally{body?.fill(0);for(const chunk of chunks)chunk.fill(0);}
}
