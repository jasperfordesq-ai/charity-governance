/** Disposable provider-process fault injection only, not a recovery operation. */
export const syntheticEpochAckLossModes=Object.freeze(['ENTRY_PUT_ACK','ENTRY_READ_ACK','HEAD_PUT_ACK','HEAD_READ_ACK']);
export function matchesSyntheticEpochAckLoss(mode,config,request){
 if(!syntheticEpochAckLossModes.includes(mode)||config.installationId!=='synthetic-native-epochs')return false;
 const kind=mode.startsWith('ENTRY_')?'entries':'heads',method=mode.includes('_PUT_')?'PUT':'GET';
 return request.method===method&&request.path===`/managed-maintenance/${config.installationId}/recovery-epochs/${kind}/00002.json`
  &&(method==='PUT'||typeof request.query?.versionId==='string'&&request.query.versionId.length>0);
}
