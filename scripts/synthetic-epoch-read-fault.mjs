import assert from 'node:assert/strict';
/** Synthetic provider-view faults only. Stored bytes and ETags stay unchanged. */
export const syntheticEpochReadFaultModes=Object.freeze(['ROLLBACK_TO_HEAD_1','HEAD_2_PHYSICAL_VERSION_DRIFT','HEAD_LIST_DRIFT']);
export function applySyntheticEpochReadFault(fault,config,request,headers,bytes){
 if(config.installationId!=='synthetic-native-epochs'||!syntheticEpochReadFaultModes.includes(fault.mode)||request.method!=='GET')return{headers,bytes};
 const prefix=`managed-maintenance/${config.installationId}/recovery-epochs/heads/`;
 if(request.query?.['list-type']==='2'&&request.query.prefix===prefix){
  fault.listReads++;
  if(fault.mode==='ROLLBACK_TO_HEAD_1'||fault.mode==='HEAD_LIST_DRIFT'&&fault.listReads>=2){
   let removed=0;const original=bytes.toString('utf8'),count=/<KeyCount>(\d+)<\/KeyCount>/.exec(original);assert.ok(count);
   const filtered=original.replace(/<Contents>[\s\S]*?<\/Contents>/g,row=>{if(!row.includes(`<Key>${prefix}00002.json</Key>`))return row;removed++;return'';});assert.equal(removed,1);
   fault.applied++;return{headers,bytes:Buffer.from(filtered.replace(/<KeyCount>\d+<\/KeyCount>/,`<KeyCount>${Number(count[1])-1}</KeyCount>`))};
  }
 }
 if(request.path==='/'+prefix+'00002.json'&&!request.query?.versionId){
  fault.currentReads++;
  if(fault.mode==='HEAD_2_PHYSICAL_VERSION_DRIFT'&&fault.currentReads>=2){
   assert.equal(typeof headers['x-amz-version-id'],'string');fault.applied++;return{headers:{...headers,'x-amz-version-id':headers['x-amz-version-id']+'-physical-drift'},bytes};
  }
 }
 return{headers,bytes};
}
