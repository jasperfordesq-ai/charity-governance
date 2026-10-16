import type { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { createApplicationPrismaClient } from '../utils/application-prisma-client.js';
import { parseProductionRuntimeRoleTarget, verifyProductionRuntimeDatabaseRole } from '../services/production-runtime-database-role.js';

const refusal='Runtime database role probe failed.';

export async function readRuntimeRoleProbeInput(source: AsyncIterable<Uint8Array|string>): Promise<unknown> {
  try {
    const chunks: Buffer[]=[];
    let length=0;
    for await(const chunk of source) {
      const bytes=Buffer.from(chunk);length+=bytes.length;
      if(length>4096) throw new Error();
      chunks.push(bytes);
    }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  } catch {throw new Error(refusal);}
}

export async function runRuntimeRoleProbe(raw: unknown,{
  createClient=()=>createApplicationPrismaClient(),verify=verifyProductionRuntimeDatabaseRole,
}: {createClient?:()=>Promise<PrismaClient>;verify?:typeof verifyProductionRuntimeDatabaseRole}={}) {
  let client: PrismaClient|undefined;
  try {
    const target=parseProductionRuntimeRoleTarget(raw);
    client=await createClient();
    const result=await verify(client,target);
    if(result.verified!==true||result.phase!==target.phase) throw new Error();
    await client.$disconnect();client=undefined;
    return {schemaVersion:1 as const,verified:true as const,phase:target.phase};
  } catch {
    try {await client?.$disconnect();} catch { /* Preserve fixed refusal. */ }
    throw new Error(refusal);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  (async()=>{
    try {
      const result=await runRuntimeRoleProbe(await readRuntimeRoleProbeInput(process.stdin));
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch {
      process.stderr.write(`${refusal}\n`);process.exitCode=1;
    }
  })();
}
