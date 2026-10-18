import {PrismaClient} from '@prisma/client';
import {toStrictPrismaTlsUrl} from '@charitypilot/shared/prisma-database-url';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {ManagedDatabaseWriterFence,managedDatabaseWriterFenceConfigurationSchema} from '../services/managed-database-writer-fence.js';

const input=z.object({format:z.literal(1),databaseUrl:z.string().min(1).max(8192),
 configuration:managedDatabaseWriterFenceConfigurationSchema,
 expectedConfigurationDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const refusal='Managed database preflight refused; no maintenance actions authorised';

export async function readManagedDatabasePreflightInput(source:AsyncIterable<Uint8Array|string>){
 const chunks:Buffer[]=[];let size=0,body:Buffer|undefined;
 try{
  for await(const value of source){const chunk=Buffer.from(value);chunks.push(chunk);size+=chunk.length;if(size>16384)throw new Error();}
  body=Buffer.concat(chunks);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)) as unknown;
 }catch{throw new Error(refusal);}finally{body?.fill(0);for(const chunk of chunks)chunk.fill(0);}
}

/** Internal dependency seam, never selectable through CLI input. Only the
 * explicitly supplied URL is used; no application environment or migrations. */
export async function preflightManagedDatabase(raw:unknown,createClient:(url:string)=>PrismaClient=
 url=>new PrismaClient({datasources:{db:{url}},log:[]})){
 let client:PrismaClient|undefined;
 try{
  const c=input.parse(raw);toStrictPrismaTlsUrl(c.databaseUrl); // Validate original bytes before URL normalisation.
  const url=new URL(c.databaseUrl);
  if(decodeURIComponent(url.username)!==c.configuration.maintenance.name||decodeURIComponent(url.pathname.slice(1))!==c.configuration.database)throw new Error();
  if(!url.searchParams.has('connect_timeout'))url.searchParams.set('connect_timeout','10');
  const transport=toStrictPrismaTlsUrl(url.href);
  // Bind the reviewed principal registry before connecting anywhere.
  const registry=new ManagedDatabaseWriterFence(undefined as never,c.configuration);
  if(registry.configurationDigest()!==c.expectedConfigurationDigest)throw new Error();
  client=createClient(transport);
  const result=await new ManagedDatabaseWriterFence(client,c.configuration).observeCompatibility();
  await client.$disconnect();client=undefined;
  return {format:1,kind:'MANAGED_DATABASE_PREFLIGHT_DIAGNOSTIC_V1',configurationDigest:result.configurationDigest,
   observationDigest:result.observationDigest,observedAt:result.observedAt,
   status:result.requiredCataloguePredicatesObserved?'CATALOGUE_PREREQUISITES_OBSERVED':'MISSING_CATALOGUE_PRIVILEGES',
   missingPredicates:result.missingPredicates,passwordStateReadVerified:result.passwordStateReadVerified,
   grantsChanged:false,rolesChanged:false,sessionsTerminated:false,runningToolReleaseVerified:false,
   providerMutationCapabilityVerified:false,directEndpointVerified:false,ongoingPermissionVerified:false,
   allWritersInventoried:false,wholeBackendQuiesced:false,executionAuthorized:false,actionAuthorized:false};
 }catch{
  try{await client?.$disconnect();}catch{/* Keep provider details private. */}
  throw new Error(refusal);
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==3||process.argv[2]!=='--stdin')throw new Error();
  const result=await preflightManagedDatabase(await readManagedDatabasePreflightInput(process.stdin));
  process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.status==='CATALOGUE_PREREQUISITES_OBSERVED'?0:2;
 }catch{process.stderr.write(refusal+'\n');process.exitCode=1;}
}
