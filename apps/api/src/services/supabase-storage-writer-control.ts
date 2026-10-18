import {
  s3FeatureStageSchema,
  s3DisabledMetadataSchema,
} from './s3-feature-boundary-contract.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const failure = () => new Error('Supabase storage maintenance is unresolved');
const id = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,120}$/)
  .refine((v) => v === v.trim());
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase() && v === v.trim());
const configuration = z
  .object({
    installationId: id,
    projectRef: z
      .string()
      .regex(/^[a-z0-9]{20}$/)
      .length(20),
    bucket: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
      .refine((v) => v === v.trim()),
    organisationId: id,
    region: z.enum(['eu-central-1', 'eu-west-1']),
    captureKeyId: uuid,
    writerKeys: z
      .array(
        z
          .object({ id: uuid, type: z.enum(['secret', 'publishable']) })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .refine(
    (c) =>
      new Set([c.captureKeyId, ...c.writerKeys.map((k) => k.id)]).size ===
      c.writerKeys.length + 1,
  );
type Configuration = z.infer<typeof configuration>;
type Budget = { signal: AbortSignal; requests: number };
const keySchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(['legacy', 'secret', 'publishable']),
});
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Named credential-path primitive; activate only under the independent
 * installation one-attempt maintenance coordinator. No grant/create/reopen,
 * automatic retry, signed-capability revocation or global writer exclusion. */
export class SupabaseStorageWriterControl {
  private readonly config: Configuration;
  private attempted = false;
  private retirementAttempted = false;
  constructor(
    raw: unknown,
    private readonly token: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.config = configuration.parse(raw);
    this.config.writerKeys.sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    if (
      typeof token !== 'string' ||
      !/^[\x21-\x7e]{1,512}$/.test(token) ||
      token !== token.trim()
    )
      throw failure();
  }
  candidateCaptureScope() {
    return {installationId:this.config.installationId,projectRef:this.config.projectRef,
      bucket:this.config.bucket,captureKeyId:this.config.captureKeyId};
  }
  readProofScope() {
    return {
      installationId: this.config.installationId,
      projectRef: this.config.projectRef,
      captureKeyId: this.config.captureKeyId,
      secretWriterIds: this.config.writerKeys
        .filter((k) => k.type === 'secret')
        .map((k) => k.id),
    };
  }
  captureControlRetirementScope() {
    return { ...this.candidateCaptureScope(), storageConfigurationDigest: this.configurationDigest() };
  }
  configurationDigest(installationId = this.config.installationId) {
    if (id.parse(installationId) !== this.config.installationId)
      throw failure();
    return hash({
      format: 1,
      provider: 'SUPABASE_NAMED_STORAGE_PATHS_V1',
      ...this.config,
    });
  }
  private async work<T>(
    run: (budget: Budget) => Promise<T>,
    caller?: AbortSignal,
  ) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 180000);
    try {
      return await run({
        signal: caller
          ? AbortSignal.any([caller, controller.signal])
          : controller.signal,
        requests: 0,
      });
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  private async request(
    suffix: string,
    method: 'GET' | 'PATCH' | 'PUT' | 'DELETE',
    budget: Budget,
    body?: object,
  ) {
    if (++budget.requests > 128 || budget.signal.aborted) throw failure();
    const controller = new AbortController(),
      signal = AbortSignal.any([budget.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), 10000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      stop!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => {
        void reader?.cancel().catch(() => {});
        reject(failure());
      };
      signal.addEventListener('abort', stop, { once: true });
    });
    const run = async () => {
      const response = await this.transport(
        'https://api.supabase.com/v1/projects/' +
          this.config.projectRef +
          suffix,
        {
          method,
          redirect: 'error',
          signal,
          headers: {
            Authorization: 'Bearer ' + this.token,
            Accept: 'application/json',
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache, no-store',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      if (signal.aborted || response.status !== 200 || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      reader = response.body.getReader();
      const bytes = Buffer.alloc(1024 * 1024);
      let count = 0;
      try {
        const length = response.headers.get('content-length'),
          encoding = response.headers.get('content-encoding');
        if (
          (encoding && encoding !== 'identity') ||
          response.headers
            .get('content-type')
            ?.split(';')[0]
            .trim()
            .toLowerCase() !== 'application/json' ||
          (length !== null &&
            (!/^(0|[1-9][0-9]*)$/.test(length) ||
              Number(length) > bytes.length))
        )
          throw failure();
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          if (
            !(next.value instanceof Uint8Array) ||
            count + next.value.length > bytes.length
          )
            throw failure();
          bytes.set(next.value, count);
          count += next.value.length;
        }
        if (signal.aborted || (length !== null && count !== Number(length)))
          throw failure();
        return JSON.parse(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            bytes.subarray(0, count),
          ),
        ) as unknown;
      } finally {
        bytes.fill(0);
      }
    };
    try {
      signal.throwIfAborted();
      return await Promise.race([run(), cancelled]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      void reader?.cancel().catch(() => {});
      controller.abort();
    }
  }
  private async snapshot(budget: Budget) {
    const c = this.config;
    const project = z
      .object({
        ref: z.string(),
        organization_id: z.string(),
        region: z.string(),
        status: z.literal('ACTIVE_HEALTHY'),
      })
      .parse(await this.request('', 'GET', budget));
    if (
      project.ref !== c.projectRef ||
      project.organization_id !== c.organisationId ||
      project.region !== c.region
    )
      throw failure();
    const storage = z
      .object({
        features: z.object({ s3Protocol: z.object({ enabled: z.boolean() }) }),
      })
      .parse(await this.request('/config/storage', 'GET', budget));
    const legacy = z
      .object({ enabled: z.boolean() })
      .parse(await this.request('/api-keys/legacy', 'GET', budget));
    // Explicit reveal=false. Only IDs/types survive parsing; never return/log a
    // provider key, hash, name, description or unexpected secret-bearing field.
    const listed = z
      .array(keySchema)
      .max(100)
      .parse(await this.request('/api-keys?reveal=false', 'GET', budget));
    if (new Set(listed.map((k) => k.id)).size !== listed.length)
      throw failure();
    const keys = listed
      .filter((k) => k.type !== 'legacy')
      .map((k) => ({ id: uuid.parse(k.id), type: k.type }));
    keys.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      project,
      s3Enabled: storage.features.s3Protocol.enabled,
      legacyEnabled: legacy.enabled,
      keys,
    };
  }
  private expected(includeWriters: boolean) {
    return [
      { id: this.config.captureKeyId, type: 'secret' },
      ...(includeWriters ? this.config.writerKeys : []),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  private closed(
    state: Awaited<ReturnType<SupabaseStorageWriterControl['snapshot']>>,
  ) {
    if (
      state.s3Enabled ||
      state.legacyEnabled ||
      JSON.stringify(state.keys) !== JSON.stringify(this.expected(false))
    )
      throw failure();
  }
  private proof(
    state: Awaited<ReturnType<SupabaseStorageWriterControl['snapshot']>>,
  ) {
    const observedAt = new Date().toISOString();
    return {
      scope: 'SUPABASE_NAMED_STORAGE_PATHS_OBSERVATION' as const,
      observedAt,
      configurationDigest: this.configurationDigest(),
      observationDigest: hash({
        config: this.configurationDigest(),
        state,
        observedAt,
      }),
      configuredAccessPathsObservedClosed: true as const,
      retainedCaptureKeys: 1,
      wholeStorageQuiesced: false as const,
      controlPlaneWritersExcluded: false as const,
      dataPlaneRejectionVerified: false as const,
      signedCapabilitiesRevoked: false as const,
      inFlightWritesDrained: false as const,
      actionAuthorized: false as const,
    };
  }
  s3FeatureProofScope() {
    return {
      installationId: this.config.installationId,
      projectRef: this.config.projectRef,
      captureKeyId: this.config.captureKeyId,
      region: this.config.region,
    };
  }
  async observeS3Disabled(rawStage: unknown, caller?: AbortSignal) {
    const stage = s3FeatureStageSchema.parse(rawStage);
    return this.work(async (budget) => {
      const first = await this.snapshot(budget),
        second = await this.snapshot(budget);
      for (const state of [first, second]) {
        if (state.s3Enabled) throw failure();
        if (stage === 'POST_CLOSURE') this.closed(state);
        else if (
          JSON.stringify(state.keys) !== JSON.stringify(this.expected(true))
        )
          throw failure();
      }
      if (hash(first) !== hash(second)) throw failure();
      const observedAt = new Date().toISOString(),
        configurationDigest = this.configurationDigest(),
        stateSha256 = hash(first);
      return s3DisabledMetadataSchema.parse({
        scope: 'SUPABASE_S3_DISABLED_METADATA_V1',
        stage,
        configurationDigest,
        stateSha256,
        observationDigest: hash({
          stage,
          configurationDigest,
          stateSha256,
          observedAt,
        }),
        observedAt,
        s3ProtocolEnabled: false,
        configuredCredentialRegistryMatched: true,
        historicalNeverEnabledProven: false,
        controlPlaneWritersExcluded: false,
        providerReleaseAttested: false,
        actionAuthorized: false,
      });
    }, caller);
  }
  async observeClosed() {
    return this.work(async (budget) => {
      const first = await this.snapshot(budget);
      this.closed(first);
      const second = await this.snapshot(budget);
      this.closed(second);
      if (hash(first) !== hash(second)) throw failure();
      return this.proof(second);
    });
  }
  private retired(state: Awaited<ReturnType<SupabaseStorageWriterControl['snapshot']>>) {
    if (state.s3Enabled || state.legacyEnabled || state.keys.length !== 0) throw failure();
  }
  private retirementProof(state: Awaited<ReturnType<SupabaseStorageWriterControl['snapshot']>>) {
    const facts = { format: 1 as const, kind: 'SUPABASE_CAPTURE_CONTROL_RETIRED_V1' as const,
      ...this.captureControlRetirementScope(), observedAt: new Date().toISOString(), stateSha256: hash(state) };
    return { ...facts, observationDigest: hash(facts), listedModernKeysAbsent: true as const,
      legacyKeysDisabled: true as const, s3ProtocolDisabled: true as const, retainedCaptureKeys: 0 as const,
      dataPlaneRejectionVerified: false as const, controlPlaneWritersExcluded: false as const,
      signedCapabilitiesRevoked: false as const, inFlightWritesDrained: false as const,
      wholeStorageQuiesced: false as const, actionAuthorized: false as const };
  }
  /** Read-only absence observation. Never reconstructs the original DELETE ACK. */
  async observeCaptureControlRetired(caller?: AbortSignal) {
    return this.work(async budget => {
      const first = await this.snapshot(budget); this.retired(first);
      const second = await this.snapshot(budget); this.retired(second);
      if (hash(first) !== hash(second)) throw failure();
      return this.retirementProof(second);
    }, caller);
  }
  /** Internal one-attempt primitive. Requires the separate retirement policy's
   * original durable request ACK; existing KEEP_CAPTURE plans must not call it. */
  async retireCaptureControl(caller?: AbortSignal) {
    if (this.retirementAttempted) throw failure();
    this.retirementAttempted = true;
    return this.work(async budget => {
      const first = await this.snapshot(budget); this.closed(first);
      const second = await this.snapshot(budget); this.closed(second);
      if (hash(first) !== hash(second)) throw failure();
      const deleted = keySchema.parse(await this.request('/api-keys/' + this.config.captureKeyId + '?reveal=false', 'DELETE', budget));
      if (deleted.id !== this.config.captureKeyId || deleted.type !== 'secret') throw failure();
      const after = await this.snapshot(budget); this.retired(after);
      const checked = await this.snapshot(budget); this.retired(checked);
      if (hash(after) !== hash(checked)) throw failure();
      return this.retirementProof(checked);
    }, caller);
  }
  async close() {
    if (this.attempted) throw failure();
    this.attempted = true;
    return this.work(async (budget) => {
      const before = await this.snapshot(budget);
      if (
        JSON.stringify(before.keys) !== JSON.stringify(this.expected(true)) ||
        (!before.s3Enabled &&
          !before.legacyEnabled &&
          this.config.writerKeys.length === 0)
      )
        throw failure();
      if (before.s3Enabled) {
        await this.request('/config/storage', 'PATCH', budget, {
          features: { s3Protocol: { enabled: false } },
        });
        const checked = z
          .object({
            features: z.object({
              s3Protocol: z.object({ enabled: z.literal(false) }),
            }),
          })
          .parse(await this.request('/config/storage', 'GET', budget));
        if (checked.features.s3Protocol.enabled !== false) throw failure();
      }
      if (before.legacyEnabled)
        z.object({ enabled: z.literal(false) }).parse(
          await this.request('/api-keys/legacy?enabled=false', 'PUT', budget),
        );
      for (const key of this.config.writerKeys) {
        const deleted = keySchema.parse(
          await this.request(
            '/api-keys/' + key.id + '?reveal=false',
            'DELETE',
            budget,
          ),
        );
        if (deleted.id !== key.id || deleted.type !== key.type) throw failure();
      }
      const first = await this.snapshot(budget);
      this.closed(first);
      const second = await this.snapshot(budget);
      this.closed(second);
      if (hash(first) !== hash(second)) throw failure();
      return this.proof(second);
    });
  }
}
