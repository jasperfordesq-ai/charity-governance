import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inspectManagedDaemonRequests,prepareLocalDockerCommand,DEFAULT_POSTGRES_IMAGE} from './postgres-backup.mjs';
const refuse=()=>new Error('Original storage observation unavailable or changed; preserve scope without cleanup');
const hash=v=>createHash('sha256').update(v).digest('hex');
function docker(args){
 const p=prepareLocalDockerCommand(['docker',...args],process.env),r=spawnSync(p.command[0],p.command.slice(1),{env:p.environment,encoding:'utf8',timeout:15000,maxBuffer:65536});
 if(r.error||r.status!==0)throw refuse();return r.stdout;
}
function tmpfsOptions(value){
 if(typeof value!=='string')return null;const parts=value.split(',').map(v=>v==='size=1048576'?'size=1m':v==='size=4294967296'?'size=4g':v);
 if(new Set(parts).size!==parts.length)return null;return parts.sort().join(',');
}
export function compareOriginalProofMounts(plan,view,jobId){
 if(!plan||plan.image!==DEFAULT_POSTGRES_IMAGE||!Array.isArray(plan.mounts)||!view||view.image!==plan.image||!Array.isArray(view.mounts)||view.mounts.length>16)return'MOUNT_MISMATCH';
 if(plan.format!==2)return'PLAN_DETAIL_INSUFFICIENT';
 const actual=new Map(),tmpfs=view.tmpfs??{};
 if(typeof tmpfs!=='object'||Array.isArray(tmpfs))return'MOUNT_MISMATCH';
 for(const [target,options] of Object.entries(tmpfs))actual.set(target,{type:'tmpfs',readOnly:false,options});
 for(const mount of view.mounts){
  if(typeof mount?.Destination!=='string')return'MOUNT_MISMATCH';
  if(mount.Type==='tmpfs'&&actual.get(mount.Destination)?.type==='tmpfs'){if(mount.RW!==true)return'MOUNT_MISMATCH';continue;}
  if(actual.has(mount.Destination)||!['bind','tmpfs','volume'].includes(mount.Type)||typeof mount.RW!=='boolean')return'MOUNT_MISMATCH';
  actual.set(mount.Destination,{type:mount.Type,readOnly:!mount.RW,source:mount.Source});
 }
 if(actual.size!==plan.mounts.length)return'MOUNT_MISMATCH';
 for(const expected of plan.mounts){
  const seen=actual.get(expected.target);if(!seen||seen.type!==expected.type||seen.readOnly!==expected.readOnly)return'MOUNT_MISMATCH';
  if(expected.type==='bind'&&(typeof seen.source!=='string'||hash('CHARITYPILOT_PROOF_BIND_SOURCE_V1\n'+jobId+'\n'+seen.source)!==expected.sourceDigest))return'MOUNT_MISMATCH';
  if(expected.type==='tmpfs'&&(tmpfsOptions(seen.options)===null||tmpfsOptions(seen.options)!==tmpfsOptions(expected.tmpfsOptions)))return'MOUNT_MISMATCH';
 }
 return'ORIGINAL_PLAN_MATCHES_CURRENT_MOUNTS';
}
/** Bounded read-only metadata correlation. Names/labels never grant ownership,
 * and stable lists do not account for pending requests or historical storage. */
export function inspectOriginalProofStorage(scope,{run=docker,readRequests=inspectManagedDaemonRequests}={}){
 const requests=readRequests(scope),jobId=scope?.jobId;
 if(requests.jobId!==jobId||typeof jobId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(jobId))throw refuse();
 const base={format:1,kind:'MANAGED_ORIGINAL_STORAGE_OBSERVATION_V1',jobId,requestState:requests.state,
  pendingDaemonRequestsAccountedFor:false,historicalVolumesAccountedFor:false,completeResourceInventory:false,cleanupAuthorized:false,executionAuthorized:false,actionAuthorized:false};
 if(!requests.declaredImageVolumesCovered)return{...base,state:'ORIGINAL_PLANS_NOT_RECORDED',containers:[],volumes:[]};
 const read=args=>{try{const body=run(args);if(typeof body!=='string'||body.length>65536)throw refuse();return body;}catch{throw refuse();}};
 const list=(args,pattern,maximum)=>{
  const body=read(args).trim(),values=body?body.split(/\r?\n/):[];
  if(values.length>maximum||new Set(values).size!==values.length||values.some(v=>!pattern.test(v)))throw refuse();return values.sort();
 };
 const containerArgs=['ps','-a','--no-trunc','--filter','label=charitypilot.restore-proof=true','--filter','label=charitypilot.managed-proof-job='+jobId,'--format','{{.ID}}'];
 const volumeArgs=['volume','ls','--format','{{.Name}}'],idPattern=/^[a-f0-9]{64}$/,volumePattern=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
 const containerIds=list(containerArgs,idPattern,64),volumeNames=list(volumeArgs,volumePattern,128),containers=[],volumes=[];
 const plans=requests.plannedContainers;if(!Array.isArray(plans)||plans.length>64||new Set(plans.map(p=>p.target)).size!==plans.length)throw refuse();
 const matched=new Set(),format='{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"proofLabel":{{json (index .Config.Labels "charitypilot.restore-proof")}},"jobId":{{json (index .Config.Labels "charitypilot.managed-proof-job")}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}}}';
 for(const id of containerIds){
  let v;try{v=JSON.parse(read(['inspect','--type','container','--format',format,id]));}catch{throw refuse();}
  if(!v||v.id!==id||v.jobId!==jobId||v.proofLabel!=='true'||typeof v.name!=='string'||!/^\/charitypilot-[A-Za-z0-9-]+$/.test(v.name))throw refuse();
  const original=plans.find(p=>'/'+p.target===v.name);if(original)matched.add(original.target);
  containers.push({id,target:v.name.slice(1),state:original?compareOriginalProofMounts(original.storagePlan,v,jobId):'UNPLANNED_JOB_CONTAINER'});
 }
 for(const plan of plans)if(!matched.has(plan.target))containers.push({id:null,target:plan.target,state:'NOT_LISTED_AT_BOUNDARY'});
 const volumeFormat='{"name":{{json .Name}},"driver":{{json .Driver}},"jobId":{{json (index .Labels "charitypilot.managed-proof-job")}}}';
 for(const name of volumeNames){
  let v;try{v=JSON.parse(read(['volume','inspect','--format',volumeFormat,name]));}catch{throw refuse();}
  if(v?.name!==name||typeof v.driver!=='string'||!/^[A-Za-z0-9_.-]{1,64}$/.test(v.driver))throw refuse();
  const args=['ps','-a','--no-trunc','--filter','volume='+name,'--format','{{.ID}}'],users=list(args,idPattern,128);
  if(JSON.stringify(users)!==JSON.stringify(list(args,idPattern,128)))throw refuse();
  volumes.push({name,driver:v.driver,attachmentState:users.length?'ATTACHMENTS_OBSERVED':'NO_ATTACHMENTS_OBSERVED',containerIds:users,
   attribution:v.jobId===jobId?'JOB_LABEL_ONLY_UNVERIFIED':'UNATTRIBUTED',cleanupAuthorized:false});
 }
 if(JSON.stringify(containerIds)!==JSON.stringify(list(containerArgs,idPattern,64))||JSON.stringify(volumeNames)!==JSON.stringify(list(volumeArgs,volumePattern,128)))throw refuse();
 return{...base,state:'BOUNDED_CURRENT_METADATA_OBSERVED',containers,volumes};
}
