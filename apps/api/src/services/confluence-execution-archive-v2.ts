import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sealIntegrationSecret,openIntegrationSecret } from './integration-crypto.js';
import { prepareConfluenceExecutionLedgerV2 } from './confluence-execution-ledger-v2.js';
import { CONFLUENCE_COPY_LEDGER_MAX_BYTES } from './confluence-copy-ledger-snapshot.js';
import { validateRecoveryEnvelopeContext,type RecoveryEnvelopeContext,type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { validateRecoveryControl } from './recovery-operation-reservation.js';
export const CONFLUENCE_EXECUTION_ARCHIVE_V2_MAX_ENVELOPE_BYTES=192*1024*1024;
const MAX_ENVELOPE=CONFLUENCE_EXECUTION_ARCHIVE_V2_MAX_ENVELOPE_BYTES;
const base64=(max:number)=>z.string().min(1).max(max).refine(value=>Buffer.from(value,'base64').toString('base64')===value);
const bindingSchema=z.object({context:z.unknown().transform(validateRecoveryEnvelopeContext),
 observedControl:z.unknown().transform(validateRecoveryControl)}).strict().refine(value=>
 value.context.installationId===value.observedControl.installationId&&value.context.organisationId===value.observedControl.organisationId
 &&value.context.writerEpoch===value.observedControl.writerEpoch&&value.observedControl.activeOperation===null&&value.observedControl.generation<10000);
export type ConfluenceExecutionArchiveV2Binding={context:RecoveryEnvelopeContext;observedControl:unknown};
const schema=z.object({format:z.literal(2),kind:z.literal('CONFLUENCE_EXECUTION_LEDGER_ARCHIVE_V2'),binding:bindingSchema,
 wrappedKey:base64(8192),sealed:z.object({generation:z.number().int().positive().max(2147483647),
  iv:base64(16).refine(value=>Buffer.from(value,'base64').length===12),
  tag:base64(24).refine(value=>Buffer.from(value,'base64').length===16),
  ciphertext:base64(Math.ceil(CONFLUENCE_COPY_LEDGER_MAX_BYTES/3)*4)}).strict()}).strict();
const noAuthority={actionAuthorized:false as const,currentHistoryVerified:false as const,reopeningAuthorised:false as const,
 independentlyPreserved:false as const,transportStateReconciled:false as const};
const hash=(body:string)=>createHash('sha256').update(body,'utf8').digest('hex');
function inspect(envelope:string) {
 if(typeof envelope!=='string'||Buffer.byteLength(envelope,'utf8')>MAX_ENVELOPE)throw new Error();
 const value=schema.parse(JSON.parse(envelope));
 if(JSON.stringify(value)!==envelope||value.sealed.generation!==value.binding.context.writerEpoch)throw new Error();
 return value;
}
function requireBody(body:string,binding:z.infer<typeof bindingSchema>) {
 if(typeof body!=='string'||Buffer.byteLength(body,'utf8')>CONFLUENCE_COPY_LEDGER_MAX_BYTES
  ||prepareConfluenceExecutionLedgerV2(JSON.parse(body),binding.context).body!==body)throw new Error();
}
function aad(binding:z.infer<typeof bindingSchema>,wrappedKey:string) {
 return{organisationId:binding.context.organisationId,provider:'charitypilot-confluence-execution-ledger-v2',
  kind:JSON.stringify({format:2,kind:'CONFLUENCE_EXECUTION_LEDGER_ARCHIVE_V2',binding,wrappedKey})};
}
/** Codec only. Declared predecessor/source/key context is not independent
 * current authority. Returned body/envelope are confidential; never log them. */
export async function sealConfluenceExecutionArchiveV2(body:string,raw:ConfluenceExecutionArchiveV2Binding,keys:RecoveryDataKeys) {
 let key:Buffer|undefined;
 try {
  const binding=bindingSchema.parse(raw);requireBody(body,binding);
  const generated=await keys.generate(binding.context);key=generated.key;
  if(!Buffer.isBuffer(key)||key.length!==32||generated.keyId!==binding.context.keyId)throw new Error();
  const wrappedKey=base64(8192).parse(generated.wrappedKey);
  const sealed=sealIntegrationSecret(body,key,binding.context.writerEpoch,aad(binding,wrappedKey));
  const envelope=JSON.stringify(schema.parse({format:2,kind:'CONFLUENCE_EXECUTION_LEDGER_ARCHIVE_V2',binding,wrappedKey,sealed}));inspect(envelope);
  return{envelope,digest:hash(envelope),...noAuthority};
 }catch{throw new Error('Confluence execution archive V2 could not be encrypted');}
 finally{if(Buffer.isBuffer(key))key.fill(0);}
}
export async function openConfluenceExecutionArchiveV2(envelope:string,raw:ConfluenceExecutionArchiveV2Binding,keys:Pick<RecoveryDataKeys,'unwrap'>) {
 let key:Buffer|undefined;
 try {
  const binding=bindingSchema.parse(raw),value=inspect(envelope);
  if(JSON.stringify(value.binding)!==JSON.stringify(binding))throw new Error();
  const unwrapped=await keys.unwrap(value.wrappedKey,binding.context);key=unwrapped.key;
  if(!Buffer.isBuffer(key)||key.length!==32||unwrapped.keyId!==binding.context.keyId)throw new Error();
  const body=openIntegrationSecret(value.sealed,key,aad(binding,value.wrappedKey));requireBody(body,binding);
  return{body,...noAuthority};
 }catch{throw new Error('Confluence execution archive V2 could not be decrypted');}
 finally{if(Buffer.isBuffer(key))key.fill(0);}
}
/** Deliberately different from the V1 adapter. No production provider adapter
 * is activated here. The implementation must isolate tenant/installation/epoch. */
export interface ConfluenceExecutionArchiveV2Objects {
 readExecutionLedgerV2(context:RecoveryEnvelopeContext):Promise<string|null>;
 createExecutionLedgerV2(context:RecoveryEnvelopeContext,envelope:string):Promise<boolean>;
}
/** Pre-publication only; a future caller must durably save exact original and
 * candidate before IO and authenticate publication state. Flags are not proof.
 * This helper never generates/reseals a retry. Published reads use the separate
 * expected-digest reader, which cannot recreate a missing object. */
export async function preservePreparedConfluenceExecutionArchiveV2(
 original:{body:string;digest:string;binding:ConfluenceExecutionArchiveV2Binding},candidate:{envelope:string;digest:string},
 keys:Pick<RecoveryDataKeys,'unwrap'>,store:ConfluenceExecutionArchiveV2Objects) {
 try {
  const binding=bindingSchema.parse(original.binding);requireBody(original.body,binding);
  if(original.digest!==hash(original.body)||!/^[a-f0-9]{64}$/.test(candidate.digest)||candidate.digest!==hash(candidate.envelope)
   ||(await openConfluenceExecutionArchiveV2(candidate.envelope,binding,keys)).body!==original.body)throw new Error();
  let saved=await store.readExecutionLedgerV2(binding.context),replayed=saved!==null;
  if(saved===null){const created=await store.createExecutionLedgerV2(binding.context,candidate.envelope);
   if(typeof created!=='boolean')throw new Error();replayed=!created;saved=await store.readExecutionLedgerV2(binding.context);}
  if(saved!==candidate.envelope)throw new Error();
  return{digest:candidate.digest,replayed,archiveReadbackVerified:true as const,...noAuthority};
 }catch{throw new Error('Prepared Confluence execution archive V2 is unresolved; preserve the exact original candidate');}
}
/** Expected digest must come from separately authenticated current evidence.
 * This reader supplies no such authentication and has no create capability. */
export async function readConfluenceExecutionArchiveV2(expectedDigest:string,raw:ConfluenceExecutionArchiveV2Binding,
 keys:Pick<RecoveryDataKeys,'unwrap'>,store:Pick<ConfluenceExecutionArchiveV2Objects,'readExecutionLedgerV2'>) {
 try {
  const binding=bindingSchema.parse(raw);if(!/^[a-f0-9]{64}$/.test(expectedDigest))throw new Error();
  const envelope=await store.readExecutionLedgerV2(binding.context);
  if(envelope===null||hash(envelope)!==expectedDigest)throw new Error();
  return await openConfluenceExecutionArchiveV2(envelope,binding,keys);
 }catch{throw new Error('Expected Confluence execution archive V2 is missing or invalid');}
}
