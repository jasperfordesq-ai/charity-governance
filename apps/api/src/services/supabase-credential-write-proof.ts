import { createHash } from 'node:crypto';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  credentialWriteBaselineSchema as baselineSchema,
  parseCredentialWriteBaseline,
  parseCredentialWriteObservation,
  credentialWriteObservationSchema,
} from './credential-write-evidence.js';

const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const failure = () =>
  new Error(
    'Supabase synthetic write proof is unresolved; preserve the original attempt and inspect without retrying mutations',
  );
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const sha = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .length(64);
const key = z.object({ id: uuid, sha256: sha }).strict();
const configuration = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    projectRef: z
      .string()
      .regex(/^[a-z0-9]{20}$/)
      .length(20),
    bucket: z.literal('charitypilot-recovery-write-probes'),
    maintenance: credentialReadMaintenanceBindingSchema,
    control: key,
    retired: z.array(key).min(1).max(50),
  })
  .strict()
  .refine(
    (c) =>
      new Set([c.control.id, ...c.retired.map((k) => k.id)]).size ===
        c.retired.length + 1 &&
      new Set([c.control.sha256, ...c.retired.map((k) => k.sha256)]).size ===
        c.retired.length + 1,
  );
const supplied = z
  .object({
    control: z.object({ id: uuid, secret: z.string() }).strict(),
    retired: z
      .array(z.object({ id: uuid, secret: z.string() }).strict())
      .min(1)
      .max(50),
  })
  .strict();
export const supabaseWriteRegistrySchema = configuration
  .innerType()
  .omit({ maintenance: true })
  .refine(
    (c) =>
      new Set([c.control.id, ...c.retired.map((k) => k.id)]).size ===
        c.retired.length + 1 &&
      new Set([c.control.sha256, ...c.retired.map((k) => k.sha256)]).size ===
        c.retired.length + 1,
  );
export { supplied as supabaseWriteCredentialsSchema };
export const syntheticWriteProbe =
  'CharityPilot synthetic recovery canary v1.\nNo personal data. Not a governance record.\n';
export const syntheticWriteUpdate = syntheticWriteProbe + 'Update proof v1.\n';
export function supabaseWriteRegistryDigest(raw: unknown) {
  const c = supabaseWriteRegistrySchema.parse(raw);
  c.retired.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hash(
    JSON.stringify({
      format: 1,
      policy: 'SYNTHETIC_STANDARD_WRITE_PROOF_V1',
      ...c,
      payloadSha256: hash(syntheticWriteProbe),
      updatePayloadSha256: hash(syntheticWriteUpdate),
    }),
  );
}
type Budget = { signal: AbortSignal; requests: number };

/** Active mutations in a dedicated synthetic bucket ONLY. This is not read-only
 * inspection, storage quiescence or authority to activate against a real project.
 * A durable coordinator must retain the baseline before revocation and guard
 * both phases; this component never retries, compensates or cleans up a failure. */
export class SupabaseCredentialWriteProof {
  private readonly config: z.infer<typeof configuration>;
  private readonly credentials: Map<string, string>;
  private baselineAttempted = false;
  private verificationAttempted = false;
  constructor(
    raw: unknown,
    secrets: unknown,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.config = configuration.parse(raw);
    this.config.retired.sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const values = supplied.parse(secrets),
      all = [values.control, ...values.retired];
    this.credentials = new Map(all.map((k) => [k.id, k.secret]));
    if (
      this.credentials.size !== all.length ||
      all.length !== this.config.retired.length + 1 ||
      values.control.id !== this.config.control.id
    )
      throw failure();
    for (const expected of [this.config.control, ...this.config.retired]) {
      const secret = this.credentials.get(expected.id);
      if (
        !secret ||
        !/^sb_secret_[A-Za-z0-9_-]{16,512}$/.test(secret) ||
        hash(secret) !== expected.sha256
      )
        throw failure();
    }
  }
  configurationDigest() {
    return supabaseWriteRegistryDigest({
      installationId: this.config.installationId,
      projectRef: this.config.projectRef,
      bucket: this.config.bucket,
      control: this.config.control,
      retired: this.config.retired,
    });
  }
  assertBaseline(raw: unknown) {
    const artifact = parseCredentialWriteBaseline(raw),
      baseline = baselineSchema.parse(JSON.parse(artifact.body));
    if (
      baseline.configurationDigest !== this.configurationDigest() ||
      JSON.stringify(baseline.maintenance) !==
        JSON.stringify(this.config.maintenance) ||
      JSON.stringify(baseline.credentialIds) !==
        JSON.stringify(this.config.retired.map((k) => k.id)) ||
      baseline.payloadSha256 !== hash(syntheticWriteProbe) ||
      baseline.updatePayloadSha256 !== hash(syntheticWriteUpdate) ||
      Date.parse(baseline.capturedAt) > Date.now() + 60000
    )
      throw failure();
    return artifact;
  }
  assertObservation(raw: unknown, baselineSha256: string) {
    const artifact = parseCredentialWriteObservation(raw),
      report = credentialWriteObservationSchema.parse(
        JSON.parse(artifact.body),
      );
    if (
      report.configurationDigest !== this.configurationDigest() ||
      report.baselineSha256 !== baselineSha256 ||
      JSON.stringify(report.refusals.map((v) => v.credentialId)) !==
        JSON.stringify(this.config.retired.map((k) => k.id))
    )
      throw failure();
    return artifact;
  }
  private path(id: string) {
    return (
      'charitypilot-recovery-write-probe/' +
      this.config.installationId +
      '/' +
      this.config.maintenance.attemptId +
      '/' +
      id +
      '.txt'
    );
  }
  private async work<T>(
    run: (budget: Budget) => Promise<T>,
    caller?: AbortSignal,
  ) {
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([caller, controller.signal])
        : controller.signal;
    const timer = setTimeout(() => controller.abort(), 3600000);
    try {
      signal.throwIfAborted();
      const result = await run({ signal, requests: 0 });
      signal.throwIfAborted();
      return result;
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  private async request(
    id: string,
    method: string,
    path: string,
    budget: Budget,
    payload?: string,
    read = false,
  ) {
    if (++budget.requests > 1600) throw failure();
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, budget.signal]),
      timer = setTimeout(() => controller.abort(), 10000);
    let stop!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(failure());
      signal.addEventListener('abort', stop, { once: true });
    });
    const run = async () => {
      const response = await this.transport(
        'https://' + this.config.projectRef + '.supabase.co/storage/v1/' + path,
        {
          method,
          redirect: 'error',
          signal,
          headers: {
            apikey: this.credentials.get(id)!,
            Accept: 'application/json, text/plain',
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache, no-store',
            ...(payload !== undefined
              ? {
                  'Content-Type':
                    method === 'DELETE' ? 'application/json' : 'text/plain',
                }
              : {}),
            ...(method === 'POST' ? { 'x-upsert': 'false' } : {}),
          },
          ...(payload !== undefined ? { body: payload } : {}),
        },
      );
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      if (!read || response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return { status: response.status, bytes: Buffer.alloc(0), mime: '' };
      }
      if (
        response.headers.has('content-encoding') &&
        response.headers.get('content-encoding') !== 'identity'
      ) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      const reader = response.body?.getReader();
      if (!reader) throw failure();
      const chunks: Uint8Array[] = [];
      let length = 0;
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        while (true) {
          const part = await reader.read();
          if (signal.aborted) throw failure();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 16384) throw failure();
          chunks.push(part.value);
        }
        const stated = response.headers.get('content-length');
        if (
          stated !== null &&
          (!/^\d+$/.test(stated) || Number(stated) !== length)
        )
          throw failure();
        return {
          status: response.status,
          bytes: Buffer.concat(chunks),
          mime:
            response.headers.get('content-type')?.split(';')[0].trim() ?? '',
        };
      } finally {
        signal.removeEventListener('abort', abort);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    };
    try {
      signal.throwIfAborted();
      return await Promise.race([run(), cancelled]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      controller.abort();
    }
  }
  private async bucket(budget: Budget) {
    const r = await this.request(
      this.config.control.id,
      'GET',
      'bucket/' + this.config.bucket,
      budget,
      undefined,
      true,
    );
    if (r.status !== 200 || r.mime !== 'application/json') throw failure();
    const v = z
      .object({ id: z.literal(this.config.bucket), public: z.literal(false) })
      .parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.bytes)),
      );
    if (v.public) throw failure();
  }
  private async object(id: string, budget: Budget, expected: string | null) {
    const r = await this.request(
      this.config.control.id,
      'GET',
      'object/' + this.config.bucket + '/' + this.path(id),
      budget,
      undefined,
      true,
    );
    if (expected === null) {
      if (r.status !== 404) throw failure();
    } else if (
      r.status !== 200 ||
      r.mime !== 'text/plain' ||
      !r.bytes.equals(Buffer.from(expected))
    )
      throw failure();
  }
  private mutate(
    id: string,
    target: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    budget: Budget,
  ) {
    const remove = operation === 'DELETE';
    return this.request(
      id,
      remove ? 'DELETE' : operation === 'CREATE' ? 'POST' : 'PUT',
      'object/' + this.config.bucket + (remove ? '' : '/' + this.path(target)),
      budget,
      remove
        ? JSON.stringify({ prefixes: [this.path(target)] })
        : operation === 'UPDATE'
          ? syntheticWriteUpdate
          : syntheticWriteProbe,
    );
  }
  private async success(
    id: string,
    target: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    budget: Budget,
  ) {
    const result = await this.mutate(id, target, operation, budget);
    if (result.status !== 200 && result.status !== 201 && result.status !== 204)
      throw failure();
    await this.object(
      target,
      budget,
      operation === 'DELETE'
        ? null
        : operation === 'UPDATE'
          ? syntheticWriteUpdate
          : syntheticWriteProbe,
    );
  }
  private async controlCycle(budget: Budget) {
    await this.bucket(budget);
    const id = this.config.control.id;
    await this.object(id, budget, null);
    for (const operation of ['CREATE', 'UPDATE', 'DELETE'] as const)
      await this.success(id, id, operation, budget);
    await this.bucket(budget);
  }
  async baseline(caller?: AbortSignal) {
    if (this.baselineAttempted) throw failure();
    this.baselineAttempted = true;
    return this.work(async (budget) => {
      for (const credential of this.config.retired) {
        await this.controlCycle(budget);
        await this.object(credential.id, budget, null);
        for (const operation of ['CREATE', 'UPDATE', 'DELETE'] as const)
          await this.success(credential.id, credential.id, operation, budget);
        await this.controlCycle(budget);
      }
      const value = baselineSchema.parse({
        format: 1,
        kind: 'SUPABASE_STANDARD_WRITE_BASELINE_V1',
        configurationDigest: this.configurationDigest(),
        maintenance: this.config.maintenance,
        capturedAt: new Date().toISOString(),
        credentialIds: this.config.retired.map((k) => k.id),
        payloadSha256: hash(syntheticWriteProbe),
        updatePayloadSha256: hash(syntheticWriteUpdate),
        operations: ['CREATE', 'UPDATE', 'DELETE'],
      });
      const body = JSON.stringify(value);
      return { body, sha256: hash(body), byteLength: Buffer.byteLength(body) };
    }, caller);
  }
  /** Current diagnostics only; never repairs probes or fabricates phase evidence. */
  async inspect(caller?: AbortSignal) {
    return this.work(async (budget) => {
      await this.bucket(budget);
      const probes: {
        credentialId: string;
        state: 'ABSENT' | 'INITIAL' | 'UPDATED' | 'UNEXPECTED';
      }[] = [];
      for (const credential of [this.config.control, ...this.config.retired]) {
        const response = await this.request(
          this.config.control.id,
          'GET',
          'object/' + this.config.bucket + '/' + this.path(credential.id),
          budget,
          undefined,
          true,
        );
        if (response.status !== 200 && response.status !== 404) throw failure();
        const state =
          response.status === 404
            ? 'ABSENT'
            : response.mime !== 'text/plain'
              ? 'UNEXPECTED'
              : response.bytes.equals(Buffer.from(syntheticWriteProbe))
                ? 'INITIAL'
                : response.bytes.equals(Buffer.from(syntheticWriteUpdate))
                  ? 'UPDATED'
                  : 'UNEXPECTED';
        probes.push({ credentialId: credential.id, state });
      }
      await this.bucket(budget);
      return {
        kind: 'SUPABASE_SYNTHETIC_WRITE_DIAGNOSTICS_V1' as const,
        configurationDigest: this.configurationDigest(),
        observedAt: new Date().toISOString(),
        probes,
        originalOutcomeReconstructed: false as const,
        wholeStorageQuiesced: false as const,
        actionAuthorized: false as const,
      };
    }, caller);
  }
  async verifyWriteRefusal(
    body: string,
    baselineSha256: string,
    caller?: AbortSignal,
  ) {
    if (this.verificationAttempted) throw failure();
    this.verificationAttempted = true;
    return this.work(async (budget) => {
      if (
        typeof body !== 'string' ||
        Buffer.byteLength(body) > 8192 ||
        !sha.safeParse(baselineSha256).success ||
        hash(body) !== baselineSha256
      )
        throw failure();
      this.assertBaseline({ body, sha256: baselineSha256 });
      const refusals: {
        credentialId: string;
        create: 401 | 403;
        update: 401 | 403;
        delete: 401 | 403;
      }[] = [];
      for (const credential of this.config.retired) {
        await this.controlCycle(budget);
        await this.object(credential.id, budget, null);
        const denied = async (operation: 'CREATE' | 'UPDATE' | 'DELETE') => {
          const r = await this.mutate(
            credential.id,
            credential.id,
            operation,
            budget,
          );
          if (r.status !== 401 && r.status !== 403) throw failure();
          return r.status as 401 | 403;
        };
        const create = await denied('CREATE');
        await this.object(credential.id, budget, null);
        await this.success(
          this.config.control.id,
          credential.id,
          'CREATE',
          budget,
        );
        const update = await denied('UPDATE');
        await this.object(credential.id, budget, syntheticWriteProbe);
        const remove = await denied('DELETE');
        await this.object(credential.id, budget, syntheticWriteProbe);
        await this.controlCycle(budget);
        refusals.push({
          credentialId: credential.id,
          create,
          update,
          delete: remove,
        });
      }
      const core = {
        kind: 'SUPABASE_STANDARD_WRITE_REFUSAL_V1' as const,
        configurationDigest: this.configurationDigest(),
        baselineSha256,
        observedAt: new Date().toISOString(),
        refusals,
      };
      return {
        ...core,
        observationDigest: hash(JSON.stringify(core)),
        standardWriteRefusalsObserved: true as const,
        coverage: 'EXPLICIT_MODERN_SECRET_STANDARD_WRITES_ONLY' as const,
        retainedSyntheticObjects: refusals.length,
        writeRejectionVerified: false as const,
        signedCapabilitiesRevoked: false as const,
        inFlightWritesDrained: false as const,
        wholeStorageQuiesced: false as const,
        actionAuthorized: false as const,
      };
    }, caller);
  }
}
