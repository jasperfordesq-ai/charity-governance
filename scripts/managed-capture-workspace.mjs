import {constants,lstatSync,realpathSync,mkdtempSync,closeSync,read} from 'node:fs';
import {open} from 'node:fs/promises';
import {resolve,join,relative,sep,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {openProtectedRegularFile,assertProtectedFileUnchanged} from './postgres-backup.mjs';
const MAX=70*1024*1024*1024,CHUNK=65536,repo=resolve(fileURLToPath(new URL('..',import.meta.url))),acl=fileURLToPath(new URL('./personal-server-windows-acl.ps1',import.meta.url));
const failure=()=>new Error('Managed capture workspace is unresolved; preserve partial artifacts without retry or admission');
const stamp=s=>[String(s.dev),String(s.ino),String(s.mode),String(s.uid)];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function name(value){if(typeof value!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/).test(value)||value.endsWith('.')||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value))throw failure();return value;}
function expected(raw){if(!raw||typeof raw.sha256!=='string'||!(/^[a-f0-9]{64}$/).test(raw.sha256)||!Number.isSafeInteger(raw.byteLength)||raw.byteLength<1||raw.byteLength>MAX)throw failure();return{sha256:raw.sha256,byteLength:raw.byteLength};}
function checkPath(path,kind){
 const s=lstatSync(path,{bigint:true});if(s.isSymbolicLink()||(kind==='Directory'?!s.isDirectory():!s.isFile()))throw failure();
 if(process.platform!=='win32'&&((Number(s.mode)&0o777)!==(kind==='Directory'?0o700:0o600)||Number(s.uid)!==process.getuid()))throw failure();return s;
}
/** Verify existing parent; apply only to new owned workspace/produced files. */
async function protection(path,kind,verifyOnly,signal){
 signal?.throwIfAborted();if(process.platform!=='win32'){checkPath(path,kind);return;}
 await new Promise((done,reject)=>{
  const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',acl,'-Path',path,'-Kind',kind,...(verifyOnly?['-VerifyOnly']:[])],
   {windowsHide:true,stdio:['ignore','pipe','pipe'],...(signal?{signal}:{})});
  let count=0;const timer=setTimeout(()=>child.kill(),30000);for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{count+=b.length;if(count>8192)child.kill();});
  child.on('error',()=>{clearTimeout(timer);reject(failure());});child.on('close',code=>{clearTimeout(timer);if(code!==0||count>8192||signal?.aborted)reject(failure());else done();});
 });signal?.throwIfAborted();checkPath(path,kind);
}
export async function createManagedCaptureWorkspace(parent,signal){
 try{
  if(typeof parent!=='string'||!isAbsolute(parent))throw failure();parent=resolve(parent);
  const canonical=realpathSync.native(parent),fold=v=>process.platform==='win32'?v.toLowerCase():v;
  if(fold(canonical)!==fold(parent))throw failure();
  const rel=relative(repo,parent);if(!(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)))throw failure();
  await protection(parent,'Directory',true,signal);const before=stamp(checkPath(parent,'Directory'));
  const root=mkdtempSync(join(parent,'capture-'));await protection(root,'Directory',false,signal);
  if(!same(before,stamp(checkPath(parent,'Directory'))))throw failure();
  return new CaptureWorkspace(root,parent,before,stamp(checkPath(root,'Directory')));
 }catch{throw failure();}
}
class CaptureWorkspace{
 #closed=false;#pins=new Map();#attempted=new Set();#streams=new Set();#root;#parent;#parentStamp;#rootStamp;
 constructor(root,parent,parentStamp,rootStamp){this.#root=root;this.#parent=parent;this.#parentStamp=parentStamp;this.#rootStamp=rootStamp;Object.freeze(this);}
 get root(){return this.#root;}
 #check(){if(this.#closed||!same(this.#parentStamp,stamp(checkPath(this.#parent,'Directory')))||!same(this.#rootStamp,stamp(checkPath(this.#root,'Directory')))
  ||!samePath(realpathSync.native(this.#root),this.#root)||!samePath(realpathSync.native(this.#parent),this.#parent))throw failure();}
 /** Tighten only an actual producer-created file in this fresh private root. */
 async pinProducedFile(filename,signal){
  let first,final;try{
   this.#check();filename=name(filename);const path=join(this.#root,filename);first=openProtectedRegularFile(path,'capture source');
   if(process.platform!=='win32')checkPath(path,'File');await protection(path,'File',false,signal);this.#check();
   final=openProtectedRegularFile(path,'capture source');
   if(!['dev','ino','size','mtimeNs'].every(k=>first.identity[k]===final.identity[k]))throw failure();
   const pin={...final.identity};this.#pins.set(filename,pin);return{byteLength:Number(pin.size)};
  }catch{throw failure();}finally{if(first)closeSync(first.fd);if(final)closeSync(final.fd);}
 }
 async openVerifiedSource(filename,raw,signal){
  let handle;try{
   this.#check();filename=name(filename);const want=expected(raw),pin=this.#pins.get(filename);if(!pin)throw failure();
   const path=join(this.#root,filename);await protection(this.#root,'Directory',true,signal);await protection(path,'File',true,signal);this.#check();
   handle=openProtectedRegularFile(path,'capture source');if(!same(pin,handle.identity)||Number(handle.identity.size)!==want.byteLength)throw failure();
   const owned=handle;handle=undefined;let settle,fail,done=false,started=false,closed=false;
   const closeOwned=()=>{if(!closed){closed=true;closeSync(owned.fd);}};
   const verified=new Promise((a,b)=>{settle=a;fail=b;});void verified.catch(()=>{});
   const self=this;
   const stream=Readable.from((async function*(){
    started=true;const hash=createHash('sha256');let position=0;
    try{
     while(position<want.byteLength){
      signal?.throwIfAborted();self.#check();const bytes=Buffer.alloc(Math.min(CHUNK,want.byteLength-position));
      const count=await new Promise((a,b)=>read(owned.fd,bytes,0,bytes.length,position,(error,count)=>error?b(error):a(count)));
      signal?.throwIfAborted();if(count<=0)throw failure();position+=count;hash.update(bytes.subarray(0,count));yield bytes.subarray(0,count);
     }
     if(hash.digest('hex')!==want.sha256)throw failure();assertProtectedFileUnchanged(owned,'after verified stream');
     await protection(self.#root,'Directory',true,signal);await protection(path,'File',true,signal);self.#check();
     assertProtectedFileUnchanged(owned,'after access verification');done=true;settle({...want,sourceIdentityMatched:true,actionAuthorized:false});
    }catch{fail(failure());throw failure();}finally{closeOwned();if(!done)fail(failure());}
   })());
   this.#streams.add(stream);stream.on('error',()=>{});
   const abort=()=>stream.destroy(failure());signal?.addEventListener('abort',abort,{once:true});
   stream.once('close',()=>{this.#streams.delete(stream);signal?.removeEventListener('abort',abort);if(!started)closeOwned();if(!done)fail(failure());});
   if(signal?.aborted)abort();return{stream,verified};
  }catch{if(handle)closeSync(handle.fd);throw failure();}
 }
 async createCiphertextDestination(filename,signal){
  let file;try{
   this.#check();filename=name(filename);if(this.#attempted.has(filename))throw failure();this.#attempted.add(filename);
   const path=join(this.#root,filename);file=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
   const owned=file;const initial=await owned.stat({bigint:true});await protection(path,'File',false,signal);this.#check();
   if(!same(stamp(initial),stamp(await owned.stat({bigint:true}))))throw failure();
   let bytes=0,digest,failed=false,completed=false;const hash=createHash('sha256');const self=this;
   const stream=new Writable({highWaterMark:CHUNK,autoDestroy:false,
    write(chunk,_encoding,cb){const copy=Buffer.from(chunk);(async()=>{
     try{self.#check();signal?.throwIfAborted();if(bytes+copy.length>MAX)throw failure();let offset=0;
      while(offset<copy.length){if(failed)throw failure();const r=await owned.write(copy,offset,copy.length-offset,bytes+offset);if(!r.bytesWritten)throw failure();offset+=r.bytesWritten;}
      bytes+=copy.length;hash.update(copy);cb();
     }catch{failed=true;cb(failure());}finally{copy.fill(0);}
    })();},
    final(cb){(async()=>{try{self.#check();signal?.throwIfAborted();await owned.sync();const s=await owned.stat({bigint:true});
     if(Number(s.size)!==bytes||failed)throw failure();digest=hash.digest('hex');await owned.close();cb();
    }catch{failed=true;await owned.close().catch(()=>{});cb(failure());}})();},
    destroy(_error,cb){failed=true;owned.close().then(()=>cb(_error),()=>cb(failure()));}
   });file=undefined;this.#streams.add(stream);stream.on('error',()=>{});
   const abort=()=>stream.destroy(failure());signal?.addEventListener('abort',abort,{once:true});
   stream.once('close',()=>{this.#streams.delete(stream);signal?.removeEventListener('abort',abort);});
   // A finished ciphertext stream remains tracked until complete or close.
   return{stream,complete:async raw=>{
    try{if(completed)throw failure();completed=true;const want=expected(raw);if(failed||!stream.writableFinished||digest!==want.sha256||bytes!==want.byteLength)throw failure();
     await self.pinProducedFile(filename,signal);self.#streams.delete(stream);signal?.removeEventListener('abort',abort);
     return{...want,streamHashMatched:true,actionAuthorized:false};
    }catch{throw failure();}
   }};
  }catch{if(file)await file.close().catch(()=>{});throw failure();}
 }
 async close(){if(this.#closed)return;this.#closed=true;const streams=[...this.#streams];for(const s of streams)s.destroy(failure());
  await Promise.allSettled(streams.map(s=>finished(s)));this.#streams.clear();}
}
