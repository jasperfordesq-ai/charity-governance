import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SupabaseRecoveryCapture } from './supabase-recovery-capture.js';
import {
  credentialReadBaselineSchema as baselineSchema,
  parseCredentialReadBaselineArtifact,
  parseCredentialReadObservationArtifact,
  credentialReadObservationSchema,
  credentialReadMaintenanceBindingSchema,
} from './credential-read-evidence.js';

const failure = () => new Error('Supabase credential read proof is unresolved');
const sha = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .length(64);
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase() && v === v.trim());
const key = z.object({ id: uuid, sha256: sha }).strict();
const configSchema = z
  .object({
    installationId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,120}$/)
      .refine((v) => v === v.trim()),
    projectRef: z
      .string()
      .regex(/^[a-z0-9]{20}$/)
      .length(20),
    bucket: z.literal('charitypilot-recovery-canaries'),
    canary: z
      .object({
        fileUrl: z.string().min(1).max(2048),
        bytes: z.number().int().min(1).max(1024),
        sha256: sha,
      })
      .strict(),
    control: key,
    retired: z.array(key).min(1).max(50),
  })
  .strict()
  .refine(
    (c) =>
      new Set([c.control.id, ...c.retired.map((k) => k.id)]).size ===
        c.retired.length + 1 &&
      new Set([c.control.sha256, ...c.retired.map((k) => k.sha256)]).size ===
        c.retired.length + 1 &&
      c.canary.fileUrl.startsWith(
        'charitypilot-recovery-canary/' + c.installationId + '/',
      ) &&
      c.canary.fileUrl.split('/').length <= 32 &&
      c.canary.fileUrl
        .split('/')
        .every(
          (s) =>
            s &&
            s !== '.' &&
            s !== '..' &&
            s.length <= 255 &&
            !/[\x00-\x1f\x7f%\\]/.test(s),
        ),
  );
const suppliedSchema = z
  .object({
    control: z.object({ id: uuid, secret: z.string() }).strict(),
    retired: z
      .array(z.object({ id: uuid, secret: z.string() }).strict())
      .min(1)
      .max(50),
  })
  .strict();
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Explicit secret-key GET evidence only. The caller must independently retain
 * and authenticate the baseline SHA before revoking credentials. This internal
 * component does not provide that custody, revoke a key, or prove write denial. */
export class SupabaseCredentialReadProof {
  private readonly config: z.infer<typeof configSchema>;
  private readonly credentials: Map<string, string>;
  private readonly readers: Map<string, SupabaseRecoveryCapture>;
  constructor(
    raw: unknown,
    secrets: unknown,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.config = configSchema.parse(raw);
    this.config.retired.sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const supplied = suppliedSchema.parse(secrets),
      records = [supplied.control, ...supplied.retired];
    this.credentials = new Map(records.map((k) => [k.id, k.secret]));
    this.readers = new Map();
    if (
      this.credentials.size !== records.length ||
      records.length !== this.config.retired.length + 1 ||
      supplied.control.id !== this.config.control.id
    )
      throw failure();
    for (const expected of [this.config.control, ...this.config.retired]) {
      const value = this.credentials.get(expected.id);
      if (
        !value ||
        !/^sb_secret_[A-Za-z0-9_-]{16,512}$/.test(value) ||
        value !== value.trim() ||
        hash(value) !== expected.sha256
      )
        throw failure();
      this.readers.set(
        expected.id,
        new SupabaseRecoveryCapture(
          {
            installationId: this.config.installationId,
            projectRef: this.config.projectRef,
            bucket: this.config.bucket,
          },
          value,
          transport,
        ),
      );
    }
  }
  configurationDigest(installationId = this.config.installationId) {
    if (installationId !== this.config.installationId) throw failure();
    return hash(
      JSON.stringify({
        format: 1,
        protocol: 'SUPABASE_CREDENTIAL_READ_PROOF_V1',
        ...this.config,
      }),
    );
  }
  assertStorageScope(raw: unknown) {
    const scope = z
      .object({
        installationId: z.string(),
        projectRef: z.string(),
        captureKeyId: uuid,
        secretWriterIds: z.array(uuid).max(50),
      })
      .strict()
      .parse(raw);
    if (
      scope.installationId !== this.config.installationId ||
      scope.projectRef !== this.config.projectRef ||
      scope.captureKeyId !== this.config.control.id ||
      JSON.stringify([...scope.secretWriterIds].sort()) !==
        JSON.stringify(this.config.retired.map((k) => k.id))
    )
      throw failure();
  }
  assertBaseline(raw: unknown, expectedBinding?: unknown) {
    const artifact = parseCredentialReadBaselineArtifact(raw),
      value = baselineSchema.parse(JSON.parse(artifact.body));
    if (
      value.configurationDigest !== this.configurationDigest() ||
      value.credentialCount !== this.config.retired.length + 1 ||
      value.canarySha256 !== this.config.canary.sha256 ||
      value.byteLength !== this.config.canary.bytes
    )
      throw failure();
    if (
      expectedBinding !== undefined &&
      JSON.stringify(value.maintenance) !==
        JSON.stringify(
          credentialReadMaintenanceBindingSchema.parse(expectedBinding),
        )
    )
      throw failure();
    return artifact;
  }
  assertObservation(raw: unknown, baselineSha256: string) {
    const artifact = parseCredentialReadObservationArtifact(raw),
      value = credentialReadObservationSchema.parse(JSON.parse(artifact.body));
    if (
      value.configurationDigest !== this.configurationDigest() ||
      value.baselineSha256 !== baselineSha256 ||
      JSON.stringify(value.refusals.map((r) => r.credentialId)) !==
        JSON.stringify(this.config.retired.map((k) => k.id))
    )
      throw failure();
    return artifact;
  }
  private async work<T>(
    run: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ) {
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([caller, controller.signal])
        : controller.signal;
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      signal.throwIfAborted();
      const result = await run(signal);
      signal.throwIfAborted();
      return result;
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  private read(id: string, signal: AbortSignal) {
    return this.readers.get(id)!.readRecoveryCanary(this.config.canary, signal);
  }
  async baseline(caller?: AbortSignal, rawBinding?: unknown) {
    return this.work(async (signal) => {
      const maintenance =
        rawBinding === undefined
          ? undefined
          : credentialReadMaintenanceBindingSchema.parse(rawBinding);
      await this.read(this.config.control.id, signal);
      for (const credential of this.config.retired)
        await this.read(credential.id, signal);
      await this.read(this.config.control.id, signal);
      const body = JSON.stringify(
        baselineSchema.parse({
          format: 1,
          kind: 'SUPABASE_CREDENTIAL_READ_BASELINE_V1',
          configurationDigest: this.configurationDigest(),
          credentialCount: this.config.retired.length + 1,
          capturedAt: new Date().toISOString(),
          canarySha256: this.config.canary.sha256,
          byteLength: this.config.canary.bytes,
          ...(maintenance ? { maintenance } : {}),
        }),
      );
      return { body, sha256: hash(body), byteLength: Buffer.byteLength(body) };
    }, caller);
  }
  private async denied(id: string, caller: AbortSignal) {
    const controller = new AbortController(),
      signal = AbortSignal.any([caller, controller.signal]);
    const timer = setTimeout(() => controller.abort(), 10000);
    let stop!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(failure());
      signal.addEventListener('abort', stop, { once: true });
    });
    const run = async () => {
      const c = this.config,
        path = c.canary.fileUrl.split('/').map(encodeURIComponent).join('/');
      const response = await this.transport(
        `https://${c.projectRef}.supabase.co/storage/v1/object/${c.bucket}/${path}`,
        {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: {
            apikey: this.credentials.get(id)!,
            Accept: 'text/plain',
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache, no-store',
          },
        },
      );
      // Error bodies can contain private provider material. Never parse/log them.
      void response.body?.cancel().catch(() => {});
      if (
        signal.aborted ||
        (response.status !== 401 && response.status !== 403)
      )
        throw failure();
      return response.status as 401 | 403;
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
  async verifyReadRefusal(
    body: string,
    expectedBaselineSha256: string,
    caller?: AbortSignal,
  ) {
    return this.work(async (signal) => {
      if (
        typeof body !== 'string' ||
        Buffer.byteLength(body) > 4096 ||
        !sha.safeParse(expectedBaselineSha256).success ||
        hash(body) !== expectedBaselineSha256
      )
        throw failure();
      const baseline = baselineSchema.parse(JSON.parse(body));
      if (
        JSON.stringify(baseline) !== body ||
        baseline.configurationDigest !== this.configurationDigest() ||
        baseline.credentialCount !== this.config.retired.length + 1 ||
        baseline.canarySha256 !== this.config.canary.sha256 ||
        baseline.byteLength !== this.config.canary.bytes ||
        Date.parse(baseline.capturedAt) > Date.now() + 60000
      )
        throw failure();
      const refusals: { credentialId: string; status: 401 | 403 }[] = [];
      for (const credential of this.config.retired) {
        await this.read(this.config.control.id, signal);
        const status = await this.denied(credential.id, signal);
        await this.read(this.config.control.id, signal);
        refusals.push({ credentialId: credential.id, status });
      }
      const observation = {
        kind: 'SUPABASE_CREDENTIAL_READ_REFUSAL_V1' as const,
        configurationDigest: this.configurationDigest(),
        baselineSha256: expectedBaselineSha256,
        observedAt: new Date().toISOString(),
        refusals,
      };
      return {
        ...observation,
        observationDigest: hash(JSON.stringify(observation)),
        credentialReadRefusalsObserved: true as const,
        coverage: 'EXPLICIT_MODERN_SECRET_READS_ONLY' as const,
        writeRejectionVerified: false as const,
        signedCapabilitiesRevoked: false as const,
        inFlightWritesDrained: false as const,
        wholeStorageQuiesced: false as const,
        actionAuthorized: false as const,
      };
    }, caller);
  }
}
