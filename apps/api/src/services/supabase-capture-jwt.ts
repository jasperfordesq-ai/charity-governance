import {createHash,createPublicKey,type JsonWebKey} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {z} from 'zod';
const failure=()=>new Error('Supabase capture JWT is unresolved');
const encoded=z.string().regex(/^[A-Za-z0-9_-]+$/);
const kid=z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const publicKey=z.discriminatedUnion('alg',[
 z.object({alg:z.literal('ES256'),kid,kty:z.literal('EC'),crv:z.literal('P-256'),x:encoded.length(43),y:encoded.length(43),use:z.literal('sig')}).strict(),
 z.object({alg:z.literal('RS256'),kid,kty:z.literal('RSA'),n:encoded.min(342).max(684),e:z.literal('AQAB'),use:z.literal('sig')}).strict(),
]);
const role=z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).refine(v=>!['anon','authenticated','service_role','authenticator','postgres'].includes(v)&&!v.startsWith('pg_')&&!v.startsWith('supabase_'));
const uuid=z.string().uuid().refine(v=>v===v.toLowerCase());
export const supabaseCaptureJwtConfiguration=z.object({kind:z.literal('SUPABASE_CAPTURE_CUSTOM_ROLE_JWT_V1'),
 sqlRole:z.object({name:role,oid:z.string().regex(/^[1-9][0-9]{0,9}$/).refine(v=>Number(v)<=4294967295)}).strict(),
 subject:uuid,verificationKey:publicKey}).strict();
const numericDate=z.number().int().safe().nonnegative();
const payload=z.object({iss:z.string(),aud:z.literal('authenticated'),sub:uuid,role,iat:numericDate,nbf:numericDate.optional(),exp:numericDate}).strict();
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
function decoded(segment:string){
 if(!/^[A-Za-z0-9_-]+$/.test(segment))throw failure();const bytes=Buffer.from(segment,'base64url');
 if(bytes.toString('base64url')!==segment||bytes.length>4096)throw failure();
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),value=JSON.parse(text);
 // Minimal canonical JSON prevents duplicate fields and decoder disagreements.
 if(JSON.stringify(value)!==text)throw failure();return value;
}
/** Supplied public-key trust only, not hosted key status or SQL privilege proof.
 * There is no signer, JWKS lookup, key URL, refresh token or ambient credential. */
export class SupabaseCaptureJwt {
 readonly #token:string;
 readonly #claims:z.infer<typeof payload>;
 readonly #config:z.infer<typeof supabaseCaptureJwtConfiguration>;
 readonly #deadline:number;
 constructor(raw:unknown,token:string,projectRef:string){
  try{
   this.#config=supabaseCaptureJwtConfiguration.parse(raw);
   if(!/^[a-z0-9]{20}$/.test(projectRef)||typeof token!=='string'||Buffer.byteLength(token)>8192||token!==token.trim())throw failure();
   const parts=token.split('.');if(parts.length!==3||!parts[2]||!/^[A-Za-z0-9_-]+$/.test(parts[2])||Buffer.from(parts[2],'base64url').toString('base64url')!==parts[2])throw failure();
   const header=z.object({alg:z.enum(['ES256','RS256']),typ:z.literal('JWT'),kid}).strict().parse(decoded(parts[0]));
   const key=this.#config.verificationKey;
   if(header.alg!==key.alg||header.kid!==key.kid)throw failure();
   const object=createPublicKey({key:key as JsonWebKey,format:'jwk'});
   if(key.alg==='RS256'&&(object.asymmetricKeyType!=='rsa'||!object.asymmetricKeyDetails?.modulusLength||object.asymmetricKeyDetails.modulusLength<2048||object.asymmetricKeyDetails.modulusLength>4096))throw failure();
   if(key.alg==='ES256'&&(object.asymmetricKeyType!=='ec'||object.asymmetricKeyDetails?.namedCurve!=='prime256v1'))throw failure();
   const claims=payload.parse(decoded(parts[1])),issuer=`https://${projectRef}.supabase.co/auth/v1`;
   jwt.verify(token,object,{algorithms:[key.alg],issuer,audience:'authenticated',clockTolerance:0,maxAge:600});
   const now=Math.floor(Date.now()/1000);
   if(claims.iss!==issuer||claims.sub!==this.#config.subject||claims.role!==this.#config.sqlRole.name
    ||claims.iat>now||claims.exp<=now||claims.exp<=claims.iat||claims.exp-claims.iat>600||claims.nbf!==undefined&&(claims.nbf<claims.iat||claims.nbf>now))throw failure();
   this.#claims=Object.freeze(claims);this.#token=token;this.#deadline=performance.now()+Math.max(0,claims.exp*1000-Date.now());
  }catch{throw failure();}
 }
 assertActive(){
  const now=Date.now();if(now<this.#claims.iat*1000||now>=this.#claims.exp*1000||performance.now()>=this.#deadline)throw failure();
 }
 remainingMs(){this.assertActive();return Math.max(1,Math.floor(Math.min(this.#claims.exp*1000-Date.now(),this.#deadline-performance.now())));}
 headers(){this.assertActive();return{Authorization:'Bearer '+this.#token};}
 evidence(){
  this.assertActive();return{format:1,kind:'SUPABASE_CAPTURE_JWT_VERIFICATION_V1' as const,algorithm:this.#config.verificationKey.alg,keyId:this.#config.verificationKey.kid,
   verificationKeySha256:hash(JSON.stringify(this.#config.verificationKey)),sqlRole:{...this.#config.sqlRole},subject:this.#config.subject,
   issuedAt:this.#claims.iat,expiresAt:this.#claims.exp,signatureVerified:true as const,configuredClaimsMatched:true as const,
   sqlRoleOidDeclared:true as const,sqlRoleOidVerified:false as const,providerKeyCurrentVerified:false as const,providerSqlRoleVerified:false as const,privilegeIntervalHeld:false as const};
 }
}
