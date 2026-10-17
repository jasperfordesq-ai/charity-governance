/** Fixture protocol policy only. Not AWS IAM, tenant authority or key custody. */
export function syntheticCustodyAllowed(role,payload){
 if(!payload||typeof payload!=='object'||Array.isArray(payload))return false;
 if(role==='owner')return ['open','sessions','stats','metadata','flag','sdk'].includes(payload.op);
 if(role!=='recovery')return false;
 if(['sessions','stats','metadata'].includes(payload.op))return true;
 if(payload.op!=='sdk'||!payload.request)return false;
 if(payload.service==='s3')return payload.request.method==='GET';
 if(payload.service==='kms')return ['TrentService.Decrypt','TrentService.VerifyMac'].includes(payload.request.headers?.['x-amz-target']);
 return false;
}
