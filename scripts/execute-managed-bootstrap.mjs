import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { compileBootstrapPlan } from './managed-bootstrap-plan.mjs';
import { exact } from '../deploy/managed-bootstrap/binding.mjs';
import { openBootstrapJournal } from './managed-bootstrap-journal.mjs';

const refused = () => new Error('Bootstrap creation unresolved; preserve journal and do not retry');
export const bootstrapPlanDigest = plan => createHash('sha256')
  .update('CHARITYPILOT_MANAGED_BOOTSTRAP_CREATION_PLAN_V1\n' + JSON.stringify(plan)).digest('hex');
export const bootstrapConfirmation = (id, digest) => 'CREATE FOUR SYNTHETIC BOOTSTRAP SERVICES ' + id + ' ' + digest;

function prepare(raw) {
  raw = structuredClone(raw);
  exact(raw, ['format', 'configuration', 'expectedPlanSha256', 'token', 'confirmation']);
  const plan = compileBootstrapPlan(raw.configuration), digest = bootstrapPlanDigest(plan);
  if (raw.format !== 1 || raw.expectedPlanSha256 !== digest
    || typeof raw.token !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(raw.token)
    || raw.confirmation !== bootstrapConfirmation(raw.configuration.binding.bootstrapId, digest)) throw refused();
  return { raw, plan, digest };
}

/** Internal test seam only. The CLI always opens the protected original journal
 * and uses fixed-origin fetch; no transport/endpoint/retry overrides are accepted. */
export async function createBootstrapServices(input, { journal, transport = fetch, requestTimeoutMs = 5000, signal } = {}) {
  let stage = 'INPUT', acknowledged = 0, pendingRole = null;
  try {
    const { raw, plan, digest } = prepare(input);
    if (!journal || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 5000) throw refused();
    const deadline = performance.now() + 90000, ids = new Set(), deployments = new Set();
    const check = () => {
      signal?.throwIfAborted(); journal.check();
      if (performance.now() >= deadline || Date.now() >= Date.parse(plan.expiresAt)) throw refused();
    };
    check(); stage = 'OPERATION';
    journal.append('operation.json', { format: 1, kind: 'BOOTSTRAP_CREATION_OPERATION_V1',
      bootstrapId: raw.configuration.binding.bootstrapId, planSha256: digest, sourceSha: plan.sourceSha,
      expiresAt: plan.expiresAt, configuration: raw.configuration, applicationReady: false });
    for (const [index, request] of plan.requests.entries()) {
      check(); stage = 'INTENT'; pendingRole = request.role;
      journal.append(index + '-intent.json', { format: 1, planSha256: digest, role: request.role,
        request: { method: request.method, url: request.url, body: request.body },
        createdAt: new Date().toISOString(), dispatchMayHaveOccurred: true });
      check(); stage = 'CREATE';
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let response, reader, cancelling = false, abort;
      const dispose = () => {
        if (reader && !cancelling) { cancelling = true; void reader.cancel().catch(() => {}); }
        else if (!reader && response) void response.body?.cancel().catch(() => {});
      };
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(requestTimeoutMs, Math.floor(deadline - performance.now()))));
      let result;
      const operation = (async () => {
        try {
          combined.throwIfAborted();
          response = await transport('https://api.render.com/v1/services', { method: 'POST', redirect: 'error',
            headers: { Authorization: 'Bearer ' + raw.token, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(request.body), signal: combined });
          combined.throwIfAborted();
          if (response.redirected || response.status !== 201 || !response.body) throw refused();
          reader = response.body.getReader(); const chunks = []; let size = 0;
          for (;;) {
            const next = await reader.read(); combined.throwIfAborted(); if (next.done) break;
            size += next.value.length; if (size > 65536) throw refused(); chunks.push(next.value);
          }
          const bytes = Buffer.concat(chunks, size);
          try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
          finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
        } finally { dispose(); }
      })();
      try {
        result = await Promise.race([operation, new Promise((_, reject) => {
          abort = () => reject(refused()); combined.addEventListener('abort', abort, { once: true });
          if (combined.aborted) abort();
        })]);
      } finally {
        clearTimeout(timer); if (abort) combined.removeEventListener('abort', abort);
        if (combined.aborted) dispose();
      }
      // Preserve a received response even if expiry just elapsed; it never
      // authorises the next request. Re-check expiry/cancellation before dispatch.
      journal.check(); stage = 'RESPONSE';
      const service = result?.service, details = service?.serviceDetails;
      const identityMatches = service && typeof service.id === 'string' && /^srv-[a-z0-9]{20}$/.test(service.id)
        && typeof result.deployId === 'string' && /^dep-[a-z0-9]{20}$/.test(result.deployId)
        && service.ownerId === request.body.ownerId && service.environmentId === request.body.environmentId
        && service.type === request.body.type && service.name === request.body.name
        && service.imagePath === request.body.image.imagePath && service.autoDeployTrigger === 'off'
        && details?.runtime === 'image' && details.region === 'frankfurt' && details.plan === '1c-2g'
        && details.numInstances === 1 && !ids.has(service.id) && !deployments.has(result.deployId);
      // Persist only an allowlist, never a raw service response/deploy-hook URL.
      const observedId = typeof service?.id === 'string' && /^srv-[a-z0-9]{20}$/.test(service.id) ? service.id : null;
      const observedDeployId = typeof result?.deployId === 'string' && /^dep-[a-z0-9]{20}$/.test(result.deployId) ? result.deployId : null;
      journal.append(index + '-response.json', { format: 1, planSha256: digest, role: request.role,
        receivedAt: new Date().toISOString(), serviceId: observedId, deployId: observedDeployId,
        requestedIdentityMatched: Boolean(identityMatches), originalResponseObserved: true,
        applicationReady: false, cleanupAuthorized: false });
      if (!identityMatches) throw refused();
      ids.add(service.id); deployments.add(result.deployId); acknowledged++; pendingRole = null;
    }
    check(); stage = 'COMPLETE';
    journal.append('complete.json', { format: 1, planSha256: digest, acknowledgedServices: acknowledged,
      applicationReady: false, providerCompatibilityVerified: false, cleanupAuthorized: false });
    return { format: 1, status: 'CREATION_RESPONSES_RECORDED', acknowledgedServices: acknowledged,
      planSha256: digest, applicationReady: false, providerCompatibilityVerified: false, cleanupAuthorized: false };
  } catch {
    const error = refused(); error.report = { format: 1, status: 'UNRESOLVED', stage,
      acknowledgedServices: acknowledged, pendingRole, applicationReady: false, retryAuthorized: false,
      cleanupAuthorized: false }; throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let journal;
  try {
    const review = process.argv.length === 3 && process.argv[2] === '--review';
    if (!review && (process.argv.length !== 4 || process.argv[2] !== '--execute')) throw refused();
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > (review ? 8192 : 16384)) throw refused(); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks); let raw;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
    finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
    if (review) {
      const plan = compileBootstrapPlan(raw), digest = bootstrapPlanDigest(plan);
      console.log(JSON.stringify({ expectedPlanSha256: digest,
        confirmation: bootstrapConfirmation(raw.binding.bootstrapId, digest),
        humanReviewVerified: false, executionAuthorized: false }));
    } else {
      prepare(raw);
      journal = openBootstrapJournal(process.argv[3], raw.configuration.binding.bootstrapId);
      console.log(JSON.stringify(await createBootstrapServices(raw, { journal })));
    }
  } catch (error) {
    if (error.report) console.error(JSON.stringify(error.report));
    console.error('Bootstrap creation unresolved; preserve journal and do not retry'); process.exitCode = 1;
  } finally { journal?.close(); }
}
