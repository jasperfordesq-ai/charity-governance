import { pathToFileURL } from 'node:url';
import { bootstrapBinding, exact, roles } from '../deploy/managed-bootstrap/binding.mjs';

const refused = () => new Error('Managed bootstrap plan refused; no provider action authorised');
/** Pure request compiler. It never publishes an image or calls the provider. */
export function compileBootstrapPlan(raw, now = Date.now()) {
  try {
    exact(raw, ['format', 'binding', 'image']);
    if (raw.format !== 1) throw refused();
    const binding = bootstrapBinding(raw.binding, now), record = binding.record;
    exact(raw.image, ['url', 'sourceSha', 'bindingSha256', 'platform']);
    const image = { ...raw.image };
    if (typeof image.url !== 'string' || image.url.length > 512
      || !/^ghcr\.io\/jasperfordesq-ai\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/.test(image.url)
      || image.url.endsWith('sha256:' + '0'.repeat(64)) || image.sourceSha !== record.sourceSha
      || image.bindingSha256 !== binding.sha256 || image.platform !== 'linux/amd64') throw refused();
    const requests = roles.map(role => {
      const port = { gateway: '10000', web: '3003', api: '3002' }[role];
      const environment = { NODE_ENV: 'production', CHARITYPILOT_BUILD_COMMIT: record.sourceSha,
        CHARITYPILOT_MANAGED_BOOTSTRAP_BINDING: binding.json, CHARITYPILOT_MANAGED_BOOTSTRAP_ROLE: role,
        ...(port ? { PORT: port } : {}) };
      return { role, method: 'POST', url: 'https://api.render.com/v1/services', body: {
        type: ({ gateway: 'web_service', web: 'private_service', api: 'private_service', scheduler: 'background_worker' })[role],
        name: record.names[role], ownerId: record.ownerId, environmentId: record.environmentId,
        image: { ownerId: record.ownerId, imagePath: image.url }, autoDeployTrigger: 'off',
        envVars: Object.entries(environment).map(([key, value]) => ({ key, value })),
        serviceDetails: { runtime: 'image', region: record.region, plan: '1c-2g', numInstances: 1,
          maxShutdownDelaySeconds: 60, previews: { generation: 'off' },
          ...(role === 'gateway' ? { healthCheckPath: '/bootstrap-health' } : {}) },
      } };
    });
    return { format: 1, kind: 'MANAGED_IDENTITY_BOOTSTRAP_REVIEW_V1', sourceSha: record.sourceSha,
      bindingSha256: binding.sha256, expiresAt: record.expiresAt,
      build: { dockerfile: 'deploy/managed-bootstrap/Dockerfile', platform: 'linux/amd64',
        args: { CHARITYPILOT_BUILD_COMMIT: record.sourceSha, CHARITYPILOT_MANAGED_BOOTSTRAP_BINDING_SHA256: binding.sha256 } },
      requests, applyAuthorized: false, executionAuthorized: false, providerCompatibilityVerified: false,
      imageProvenanceVerified: false, serviceIdentitiesVerified: false, applicationReady: false,
      billingStopGuaranteed: false };
  } catch { throw refused(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--stdin') throw refused();
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 8192) throw refused();
      chunks.push(chunk);
    }
    const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    process.stdout.write(JSON.stringify(compileBootstrapPlan(JSON.parse(raw))) + '\n');
  } catch { console.error('Managed bootstrap plan refused; no provider action authorised'); process.exitCode = 1; }
}
