import {PrismaClient} from '@prisma/client';
import {toStrictPrismaTlsUrl} from '@charitypilot/shared/prisma-database-url';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {ManagedStorageDatabaseInventory,managedStorageDatabaseInventoryConfigurationSchema} from '../services/managed-storage-database-inventory.js';
import {readManagedDatabasePreflightInput} from './preflight-managed-database.js';

const input=z.object({format:z.literal(1),databaseUrl:z.string().min(1).max(8192),
 configuration:managedStorageDatabaseInventoryConfigurationSchema,
 expectedConfigurationDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const refusal='Managed capture preflight refused; no capture or maintenance actions authorised';

/** Explicit reviewed target only. No ambient database, privilege-window locks, role changes,
 * migrations, capture callback, provider action or reopening is available. */
export async function preflightManagedCaptureWindow(raw:unknown,createClient:(url:string)=>PrismaClient=
 url=>new PrismaClient({datasources:{db:{url}},log:[]})){
 let client:PrismaClient|undefined;
 try{
  const c=input.parse(raw);toStrictPrismaTlsUrl(c.databaseUrl);
  const url=new URL(c.databaseUrl);
  if(decodeURIComponent(url.username)!==c.configuration.observer.name||decodeURIComponent(url.pathname.slice(1))!==c.configuration.database)throw new Error();
  const registry=new ManagedStorageDatabaseInventory(undefined as never,c.configuration);
  if(registry.configurationDigest()!==c.expectedConfigurationDigest)throw new Error();
  if(!url.searchParams.has('connect_timeout'))url.searchParams.set('connect_timeout','10');
  client=createClient(toStrictPrismaTlsUrl(url.href));
  const result=await new ManagedStorageDatabaseInventory(client,c.configuration).observeCaptureWindowCompatibility();
  await client.$disconnect();client=undefined;
  return{format:1,kind:'MANAGED_CAPTURE_PREFLIGHT_DIAGNOSTIC_V1' as const,
   configurationDigest:result.configurationDigest,observationDigest:result.observationDigest,
   observedAt:result.observedAt,status:result.status,
   missingCatalogueLockAclPredicates:result.missingCatalogueLockAclPredicates,
   catalogueLockAclPredicatesObserved:result.catalogueLockAclPredicatesObserved,
   scope:result.scope,catalogueLocksAcquired:false,privilegeWindowHeld:false,
   grantsChanged:false,rolesChanged:false,sessionsTerminated:false,captureActivated:false,
   providerCompatibilityVerified:false,directEndpointVerified:false,runningToolReleaseVerified:false,
   allWritersInventoried:false,wholeBackendQuiesced:false,executionAuthorized:false,actionAuthorized:false};
 }catch{
  try{await client?.$disconnect();}catch{/* Provider detail remains private. */}
  throw new Error(refusal);
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==3||process.argv[2]!=='--stdin')throw new Error();
  const result=await preflightManagedCaptureWindow(await readManagedDatabasePreflightInput(process.stdin));
  process.stdout.write(JSON.stringify(result)+'\n');
  process.exitCode=result.status==='ACL_PREDICATES_PRESENT'?0:2;
 }catch{process.stderr.write(refusal+'\n');process.exitCode=1;}
}
