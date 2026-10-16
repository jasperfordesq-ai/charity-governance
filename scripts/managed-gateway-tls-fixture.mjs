import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { X509Certificate, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createManagedServiceMeshBinding } from '../packages/shared/runtime/managed-service-mesh.mjs';

export function gatewayTlsFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'charitypilot-gateway-tls-'));
  const cleanup = () => {
    const target = resolve(directory);
    assert.ok(
      target.startsWith(resolve(tmpdir()) + sep) &&
        basename(target).startsWith('charitypilot-gateway-tls-'),
    );
    rmSync(target, { recursive: true, force: true });
  };
  try {
    const openssl =
      process.platform === 'win32'
        ? 'C:/Program Files/Git/usr/bin/openssl.exe'
        : 'openssl';
    const run = (args) => {
      const r = spawnSync(openssl, args, { encoding: 'utf8', timeout: 15000 });
      assert.equal(
        r.status,
        0,
        'synthetic gateway certificate generation failed',
      );
    };
    for (const name of ['issuer', 'foreign'])
      run([
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(directory, name + '.key'),
        '-out',
        join(directory, name + '.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=' + name,
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
      ]);
    const leaf = (name, dns, purpose, issuer, serial) => {
      const key = join(directory, name + '.key'),
        csr = join(directory, name + '.csr'),
        cert = join(directory, name + '.pem'),
        ext = join(directory, name + '.ext');
      run([
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        csr,
        '-subj',
        '/CN=' + name,
      ]);
      writeFileSync(
        ext,
        'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=' +
          purpose +
          '\nsubjectAltName=DNS:' +
          dns +
          '\n',
      );
      run([
        'x509',
        '-req',
        '-in',
        csr,
        '-CA',
        join(directory, issuer + '.pem'),
        '-CAkey',
        join(directory, issuer + '.key'),
        '-set_serial',
        String(serial),
        '-days',
        '1',
        '-extfile',
        ext,
        '-out',
        cert,
      ]);
      return {
        cert: readFileSync(cert, 'utf8'),
        key: readFileSync(key, 'utf8'),
      };
    };
    const api = leaf(
        'api',
        'charitypilot-review-api-ab12',
        'serverAuth',
        'issuer',
        1,
      ),
      web = leaf(
        'web',
        'charitypilot-review-web-cd34',
        'serverAuth',
        'issuer',
        2,
      );
    const gateway = leaf('gateway', 'gateway', 'clientAuth', 'issuer', 3),
      webClient = leaf('web-client', 'web-client', 'clientAuth', 'issuer', 4);
    const foreign = leaf(
      'rogue-api',
      'charitypilot-review-api-ab12',
      'serverAuth',
      'foreign',
      5,
    );
    const issuer = readFileSync(join(directory, 'issuer.pem'), 'utf8'),
      fingerprint = (pem) =>
        createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
    const binding = createManagedServiceMeshBinding({
      format: 2,
      provider: 'render',
      region: 'frankfurt',
      installationId: 'synthetic',
      ownerId: 'tea-synthetic',
      environmentId: 'env-synthetic',
      sourceSha: '1'.repeat(40),
      publicOrigin: 'https://managed.charitypilot.test',
      gatewayServiceId: 'srv-' + 'a'.repeat(20),
      webServiceId: 'srv-' + 'b'.repeat(20),
      apiServiceId: 'srv-' + 'c'.repeat(20),
      schedulerServiceId: 'srv-' + 'd'.repeat(20),
      apiServiceName: 'charitypilot-review-api',
      apiOrigin: 'https://charitypilot-review-api-ab12:3002',
      webServiceName: 'charitypilot-review-web',
      webOrigin: 'https://charitypilot-review-web-cd34:3003',
      issuerCertSha256: fingerprint(issuer),
      apiCertSha256: fingerprint(api.cert),
      webCertSha256: fingerprint(web.cert),
      gatewayClientCertSha256: fingerprint(gateway.cert),
      webClientCertSha256: fingerprint(webClient.cert),
    });
    return { binding, issuer, api, web, gateway, foreign, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Private fixture input only. No real credentials, provider calls or user files.
export const provisionMaterial = String.raw`
const fs=require('node:fs');let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>raw+=part);process.stdin.on('end',()=>{const data=JSON.parse(raw);for(const [directory,files] of Object.entries(data.directories)){fs.mkdirSync(directory,{recursive:true,mode:0o700});for(const [name,bytes] of Object.entries(files))fs.writeFileSync(directory+'/'+name,bytes,{flag:'wx',mode:0o400});}fs.writeFileSync('/run/charitypilot/ready','ready',{flag:'wx',mode:0o400});});`;
export const provisionPin = String.raw`
const fs=require('node:fs');let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>raw+=part);process.stdin.on('end',()=>fs.writeFileSync('/opt/charitypilot/managed-api-build.json',JSON.stringify(JSON.parse(raw))+'\n',{flag:'wx',mode:0o444}));`;
export const gatewayWait = String.raw`
const fs=require('node:fs/promises');(async()=>{while(true){try{await fs.access('/run/charitypilot/ready');break;}catch{await new Promise(r=>setTimeout(r,50));}}await import('/app/caddy/managed/start.mjs');})().catch(()=>process.exit(1));`;
export const backendSource = String.raw`
import fs from 'node:fs/promises';import https from 'node:https';import {createHash} from 'node:crypto';
while(true){try{await fs.access('/run/charitypilot/ready');break;}catch{await new Promise(r=>setTimeout(r,50));}}
const {loadManagedApiRuntime}=await import('/app/apps/api/dist/services/managed-api-runtime.js');
const {managedApiPeerRole}=await import('/app/apps/api/dist/services/managed-api-peer-transport.js');
const app=loadManagedApiRuntime();const ingress=new WeakMap();app.server.prependListener('request',req=>ingress.set(req,{...req.headers}));
app.all('/*',async req=>({port:3002,url:req.url,headers:req.headers,ingressHeaders:ingress.get(req.raw),body:req.body??'',role:managedApiPeerRole(req),protocol:req.raw.socket.getProtocol()}));
await app.listen({host:'0.0.0.0',port:3002});
const r=JSON.parse(process.env.CHARITYPILOT_MANAGED_API_PEER_BINDING),folder='/run/charitypilot/web';
const options={key:await fs.readFile(folder+'/server.key'),cert:await fs.readFile(folder+'/server.pem'),ca:await fs.readFile(folder+'/issuer.pem'),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'};
const web=https.createServer(options,async(req,res)=>{const peer=req.socket.getPeerX509Certificate();if(!req.socket.authorized||!peer||createHash('sha256').update(peer.raw).digest('hex')!==r.gatewayClientCertSha256){res.writeHead(403);res.end();return;}let body='';for await(const part of req)body+=part;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({port:3003,url:req.url,headers:req.headers,ingressHeaders:req.headers,body,role:'gateway',protocol:req.socket.getProtocol()}));});
web.listen(3003,'0.0.0.0',()=>console.log('BACKEND_TLS_READY'));process.once('SIGTERM',async()=>{await app.close();web.close(()=>process.exit(0));});`;
export const rogueSource = String.raw`
import fs from 'node:fs/promises';import https from 'node:https';while(true){try{await fs.access('/run/charitypilot/ready');break;}catch{await new Promise(r=>setTimeout(r,50));}}
https.createServer({key:await fs.readFile('/run/charitypilot/rogue/server.key'),cert:await fs.readFile('/run/charitypilot/rogue/server.pem')},(q,s)=>{console.log('UNTRUSTED_HANDLER_REACHED');s.end('rogue');}).listen(3002,'0.0.0.0',()=>console.log('ROGUE_TLS_READY'));`;
