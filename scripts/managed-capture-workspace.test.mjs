import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync,symlinkSync,readdirSync,readlinkSync,renameSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {finished} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {createManagedCaptureWorkspace} from './managed-capture-workspace.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),acl=fileURLToPath(new URL('./personal-server-windows-acl.ps1',import.meta.url));
function parent(){
 const dir=mkdtempSync(join(tmpdir(),'charitypilot-workspace-test-'));
 if(process.platform==='win32'){const r=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',acl,'-Path',dir,'-Kind','Directory'],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);}
 else chmodSync(dir,0o700);return dir;
}
function cleanup(dir){assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('charitypilot-workspace-test-'));rmSync(dir,{recursive:true,force:true});}
async function setup(){const directory=parent(),workspace=await createManagedCaptureWorkspace(directory);return{directory,workspace};}
async function consume(r){const b=[];for await(const v of r.stream){assert.ok(v.length<=65536);b.push(v);}return Buffer.concat(b);}
test('verified source and ciphertext spool use bounded owned streams, strict hashes and private files',async()=>{
 const {directory,workspace:w}=await setup(),data=Buffer.alloc(180000,5);
 try{
  writeFileSync(join(w.root,'source.dump'),data,{mode:0o600});await w.pinProducedFile('source.dump');
  const input=await w.openVerifiedSource('source.dump',{sha256:hash(data),byteLength:data.length});
  assert.deepEqual(await consume(input),data);assert.equal((await input.verified).sourceIdentityMatched,true);
  const out=await w.createCiphertextDestination('database.ciphertext');out.stream.end(data);await finished(out.stream);
  const expected={sha256:hash(data),byteLength:data.length};assert.equal((await out.complete(expected)).streamHashMatched,true);
  const saved=await w.openVerifiedSource('database.ciphertext',expected);assert.deepEqual(await consume(saved),data);await saved.verified;
  await assert.rejects(out.complete(expected));await assert.rejects(w.createCiphertextDestination('database.ciphertext'));
  assert.ok(existsSync(join(w.root,'database.ciphertext')));
 }finally{await w.close();cleanup(directory);}
});
test('source substitution and mid-stream mutation cannot produce verified receipts',async()=>{
 const {directory,workspace:w}=await setup(),data=Buffer.alloc(180000,7),path=join(w.root,'source.dump');
 try{
  writeFileSync(path,data,{mode:0o600});await w.pinProducedFile('source.dump');
  const r=await w.openVerifiedSource('source.dump',{sha256:hash(data),byteLength:data.length});
  const it=r.stream[Symbol.asyncIterator]();await it.next();const changed=Buffer.from(data);changed[changed.length-1]=1;writeFileSync(path,changed);
  await assert.rejects(async()=>{while(!(await it.next()).done){}});await assert.rejects(r.verified);
  await assert.rejects(w.openVerifiedSource('source.dump',{sha256:hash(data),byteLength:data.length}));
 }finally{await w.close();cleanup(directory);}
});
test('unconsumed source closes on workspace cancellation and retains source for quarantine',async()=>{
 const {directory,workspace:w}=await setup(),path=join(w.root,'source.dump'),data=Buffer.from('source');
 try{
  writeFileSync(path,data,{mode:0o600});await w.pinProducedFile('source.dump');const r=await w.openVerifiedSource('source.dump',{sha256:hash(data),byteLength:data.length});
  await w.close();await assert.rejects(r.verified);assert.equal(readFileSync(path).toString(),'source');
  if(process.platform==='linux'){const targets=readdirSync('/proc/self/fd').flatMap(n=>{try{return[readlinkSync('/proc/self/fd/'+n)];}catch{return[];}});assert.ok(!targets.includes(path));}
 }finally{await w.close();cleanup(directory);}
});
test('aborted ciphertext and failed completion retain partial artifact and refuse replacement',async()=>{
 const {directory,workspace:w}=await setup(),controller=new AbortController();
 try{
  const out=await w.createCiphertextDestination('database.ciphertext',controller.signal);out.stream.write(Buffer.alloc(70000,2));controller.abort();
  await assert.rejects(finished(out.stream));await assert.rejects(out.complete({sha256:hash(Buffer.alloc(70000,2)),byteLength:70000}));
  assert.ok(existsSync(join(w.root,'database.ciphertext')));await assert.rejects(w.createCiphertextDestination('database.ciphertext'));
  for(const invalid of ['../outside','NUL','CON.dump','safe.','/outside'])await assert.rejects(w.createCiphertextDestination(invalid));
 }finally{await w.close();cleanup(directory);}
});
test('wrong output hash and incorrect source length refuse without a valid receipt',async()=>{
 const {directory,workspace:w}=await setup(),data=Buffer.from('ciphertext');
 try{
  const out=await w.createCiphertextDestination('database.ciphertext');out.stream.end(data);await finished(out.stream);
  await assert.rejects(out.complete({sha256:'0'.repeat(64),byteLength:data.length}));
  await assert.rejects(out.complete({sha256:hash(data),byteLength:data.length}));
  writeFileSync(join(w.root,'source.dump'),data,{mode:0o600});await w.pinProducedFile('source.dump');
  await assert.rejects(w.openVerifiedSource('source.dump',{sha256:hash(data),byteLength:data.length+1}));
 }finally{await w.close();cleanup(directory);}
});
test('symlink source refuses before reading its target',{skip:process.platform==='win32'?'Windows symbolic-link privilege is not assumed':false},async()=>{
 const {directory,workspace:w}=await setup(),target=join(directory,'target');
 try{writeFileSync(target,'outside',{mode:0o600});symlinkSync(target,join(w.root,'source.dump'));await assert.rejects(w.pinProducedFile('source.dump'));assert.equal(readFileSync(target).toString(),'outside');}
 finally{await w.close();cleanup(directory);}
});
test('workspace must stay outside source checkout and reject relative parents',async()=>{
 await assert.rejects(createManagedCaptureWorkspace('.'));
 await assert.rejects(createManagedCaptureWorkspace(fileURLToPath(new URL('..',import.meta.url))));
});

test('directory substitution cannot redirect a source or ciphertext operation',async()=>{
 const {directory,workspace:w}=await setup(),moved=join(directory,'moved');
 try{
  writeFileSync(join(w.root,'source.dump'),'source',{mode:0o600});await w.pinProducedFile('source.dump');
  renameSync(w.root,moved);mkdirSync(w.root,{mode:0o700});
  await assert.rejects(w.openVerifiedSource('source.dump',{sha256:hash(Buffer.from('source')),byteLength:6}));
  await assert.rejects(w.createCiphertextDestination('database.ciphertext'));
  assert.equal(readFileSync(join(moved,'source.dump')).toString(),'source');assert.ok(!existsSync(join(w.root,'database.ciphertext')));
 }finally{await w.close();cleanup(directory);}
});
test('a protected checkout child beginning with two dots is still inside the checkout',async()=>{
 const repo=resolve(fileURLToPath(new URL('..',import.meta.url))),directory=mkdtempSync(join(repo,'..spool-boundary-'));
 try{
  if(process.platform==='win32'){
   const r=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',acl,'-Path',directory,'-Kind','Directory'],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);
  }
  await assert.rejects(createManagedCaptureWorkspace(directory));
 }finally{assert.equal(dirname(resolve(directory)),repo);assert.ok(basename(directory).startsWith('..spool-boundary-'));rmSync(directory,{recursive:true,force:true});}
});
