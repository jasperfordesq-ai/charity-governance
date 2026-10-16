import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {prepareConfluenceExecutionLedgerV2,CONFLUENCE_EXECUTION_LEDGER_V2_TABLES as tables} from './confluence-execution-ledger-v2.js';
import {CONFLUENCE_COPY_LEDGER_MAX_BYTES} from './confluence-copy-ledger-snapshot.js';
import type {RecoveryEnvelopeContext} from './recovery-preparation-envelope.js';
import type {readPublishedConfluenceExecutionV2} from './confluence-execution-v2-prefix.js';
type Published=Pick<Awaited<ReturnType<typeof readPublishedConfluenceExecutionV2>>,
 'body'|'archiveAtObservedHead'|'archivePrefixVerified'|'entryGeneration'|'entryDigest'|'envelopeDigest'|'revision'>;
type Table=typeof tables[number];
const order:readonly Table[]=[tables[0],tables[2],tables[3],tables[1],tables[4],tables[5],tables[6],tables[7],tables[8],tables[9],tables[10]];
const row=z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),organisationId:z.string().regex(/^[A-Za-z0-9_-]{1,120}$/)}).passthrough();
const localSchema=z.record(z.array(row).max(10000));
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
function canonical(raw:unknown):string {
 const visit=(value:unknown):unknown=>Array.isArray(value)?value.map(visit):value!==null&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a===b?0:1).map(([k,v])=>[k,visit(v)])):value;
 return JSON.stringify(visit(raw));
}
/** Pure proposal only. Observation flags are not authentication. The coordinator
 * must obtain this archive through the fresh authenticated V2 reader. Local
 * subsets may lack parents, but every retained row must exactly match original
 * authenticated evidence. No overwrite, deletion or invented record follows. */
export function buildConfluenceExecutionV2ReconciliationPlan(context:RecoveryEnvelopeContext,archive:Published,rawLocalTables:unknown) {
 if(archive.archiveAtObservedHead!==true||archive.archivePrefixVerified!==true||!Number.isSafeInteger(archive.entryGeneration)
  ||archive.entryGeneration<1||archive.entryGeneration>10000||!/^[a-f0-9]{64}$/.test(archive.entryDigest)
  ||!/^[a-f0-9]{64}$/.test(archive.envelopeDigest)||typeof archive.revision!=='string'||!/^[\x21-\x7e]{1,1024}$/.test(archive.revision))throw new Error('Invalid V2 archive observation');
 const remote=prepareConfluenceExecutionLedgerV2(JSON.parse(archive.body),context);
 if(remote.body!==archive.body)throw new Error('Noncanonical V2 archive');
 const wire=JSON.stringify(rawLocalTables);if(Buffer.byteLength(wire,'utf8')>CONFLUENCE_COPY_LEDGER_MAX_BYTES)throw new Error('Local V2 rows exceed capacity');
 const local=localSchema.parse(JSON.parse(wire));
 if(Object.keys(local).length!==tables.length||tables.some(name=>!Object.hasOwn(local,name)))throw new Error('Incomplete or unsupported V2 local groups');
 const inserts:Array<{table:Table;record:Record<string,unknown>}>=[];let matchingRecords=0;
 for(const name of order) {
  local[name]!.sort((a,b)=>a.id<b.id?-1:a.id===b.id?0:1);
  const expected=new Map(remote.ledger.tables[name]!.map(value=>[value.id,value])),seen=new Set<string>();
  for(const value of local[name]!) {
   if(value.organisationId!==context.organisationId||seen.has(value.id)||!isDeepStrictEqual(value,expected.get(value.id)))throw new Error('Later or contradictory V2 local evidence requires reconciliation');
   seen.add(value.id);matchingRecords++;
  }
  const missing=[...expected.values()].filter(value=>!seen.has(value.id));
  missing.sort((a,b)=>name===tables[5]&&a.factsRevision!==b.factsRevision?Number(a.factsRevision)-Number(b.factsRevision):a.id<b.id?-1:a.id===b.id?0:1);
  for(const record of missing)inserts.push({table:name,record});
 }
 const candidate={format:2,scope:'CONFLUENCE_ELEVEN_TABLE_EXECUTION_LEDGER_ONLY' as const,installationId:context.installationId,
  organisationId:context.organisationId,archiveBodyDigest:hash(archive.body),envelopeDigest:archive.envelopeDigest,
  head:{generation:archive.entryGeneration,digest:archive.entryDigest,revision:archive.revision},localRowsDigest:hash(canonical(local)),matchingRecords,inserts};
 return{...candidate,candidateDigest:hash(canonical(candidate)),requiresReplay:inserts.length>0,actionAuthorized:false as const,
  currentHistoryVerified:false as const,reopeningAuthorised:false as const,transportStateReconciled:false as const,independentlyPreserved:false as const};
}
