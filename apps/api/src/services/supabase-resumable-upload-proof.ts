import {resumableLocationPinSchema,assertResumableLocation} from './resumable-location-contract.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
const hash = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase());
const time = z
  .string()
  .datetime()
  .refine((v) => new Date(v).toISOString() === v);
const key = z.object({ id: uuid, sha256: sha }).strict();
const configSchema = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    projectRef: z.string().regex(/^[a-z0-9]{20}$/),
    bucket: z.literal('charitypilot-recovery-resumable-probes'),
    maintenance: credentialReadMaintenanceBindingSchema,
    providerRelease: z
      .object({
        sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
        imageDigest: sha,
      })
      .strict(),
    uploadIdFormat: z.enum(['PATH_V1', 'FILE_VERSION_V1']),
    control: key,
    retired: key,
  })
  .strict()
  .refine((v) => v.control.id !== v.retired.id);
export {resumableLocationPinSchema} from './resumable-location-contract.js';
const baselineSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal('SUPABASE_RESUMABLE_BASELINE_V1'),
    configurationDigest: sha,
    maintenance: credentialReadMaintenanceBindingSchema,
    credentialId: uuid,
    reference: uuid,
    locationSha256: sha,
    locationPin: resumableLocationPinSchema,
    capturedAt: time,
    expiresAt: time,
    offset: z.literal(6291456),
    uploadLength: z.literal(6291457),
    prefixSha256: sha,
  })
  .strict()
  .refine((v) => v.reference === v.locationPin.reference);
const prefix = Buffer.alloc(6 * 1024 * 1024, 0x43),
  tail = Buffer.from('P');
const failure = () =>
  new Error(
    'Resumable-upload proof is unresolved; preserve the original attempt and incomplete synthetic upload without retrying mutations',
  );
type Budget = { signal: AbortSignal; requests: number };
type Slot = 'old' | 'control-before' | 'control-after';
export type RetainResumableLocation = (
  value: { location: string; sha256: string },
  signal: AbortSignal,
) => Promise<{
  reference: string;
  locationSha256: string;
  pin: z.infer<typeof resumableLocationPinSchema>;
}>;

/** Active ONE-credential TUS probe in fixed synthetic paths. No parent dispatch,
 * encrypted location store, cleanup, signed-TUS/S3 or global/in-flight proof. */
export class SupabaseResumableUploadProof {
  private readonly config: z.infer<typeof configSchema>;
  private readonly secrets: { control: string; retired: string };
  private baselineAttempted = false;
  private verificationAttempted = false;
  constructor(
    raw: unknown,
    rawSecrets: unknown,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.config = configSchema.parse(raw);
    const supplied = z
      .object({
        control: z.object({ id: uuid, secret: z.string() }).strict(),
        retired: z.object({ id: uuid, secret: z.string() }).strict(),
      })
      .strict()
      .parse(rawSecrets);
    for (const name of ['control', 'retired'] as const) {
      const k = supplied[name];
      if (
        k.id !== this.config[name].id ||
        !/^sb_secret_[A-Za-z0-9_-]{16,512}$/.test(k.secret) ||
        hash(k.secret) !== this.config[name].sha256
      )
        throw failure();
    }
    this.secrets = {
      control: supplied.control.secret,
      retired: supplied.retired.secret,
    };
  }
  configurationDigest() {
    const { maintenance, ...registry } = this.config;
    return hash(
      JSON.stringify({
        format: 1,
        policy: 'ONE_ORIGINAL_TUS_SESSION_V1',
        ...registry,
        prefixSha256: hash(prefix),
        tailSha256: hash(tail),
      }),
    );
  }
  private origin() {
    return 'https://' + this.config.projectRef + '.storage.supabase.co';
  }
  private object(slot: Slot) {
    return (
      'charitypilot-recovery-resumable-probe/' +
      this.config.installationId +
      '/' +
      this.config.maintenance.attemptId +
      '/' +
      slot +
      '.txt'
    );
  }
  private endpoint() {
    return this.origin() + '/storage/v1/upload/resumable';
  }
  private location(raw:unknown,slot:Slot){
    return assertResumableLocation(raw,{installationId:this.config.installationId,projectRef:this.config.projectRef,attemptId:this.config.maintenance.attemptId,uploadIdFormat:this.config.uploadIdFormat},slot);
  }
  private async work<T>(run: (b: Budget) => Promise<T>, caller?: AbortSignal) {
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([caller, controller.signal])
        : controller.signal,
      timer = setTimeout(() => controller.abort(), 180000);
    let stop!: () => void;
    const cancelled = new Promise<never>((_r, reject) => {
      stop = () => reject(failure());
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      signal.throwIfAborted();
      const result = await Promise.race([
        run({ signal, requests: 0 }),
        cancelled,
      ]);
      signal.throwIfAborted();
      return result;
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      controller.abort();
    }
  }
  private async request(
    method: 'GET' | 'HEAD' | 'POST' | 'PATCH',
    url: string,
    credential: 'control' | 'retired',
    budget: Budget,
    headers: Record<string, string> = {},
    body?: Buffer,
  ) {
    if (++budget.requests > 32 || new URL(url).origin !== this.origin())
      throw failure();
    const controller = new AbortController(),
      signal = AbortSignal.any([budget.signal, controller.signal]),
      timer = setTimeout(() => controller.abort(), 15000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      stop!: () => void;
    const cancelled = new Promise<never>((_r, reject) => {
      stop = () => {
        void reader?.cancel().catch(() => {});
        reject(failure());
      };
      signal.addEventListener('abort', stop, { once: true });
    });
    const run = async () => {
      const response = await this.transport(url, {
        method,
        redirect: 'error',
        signal,
        headers: {
          apikey: this.secrets[credential],
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache, no-store',
          ...headers,
        },
        ...(body ? { body: new Uint8Array(body) } : {}),
      });
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      const date = Date.parse(response.headers.get('date') ?? '');
      if (!Number.isFinite(date) || Math.abs(Date.now() - date) > 60000) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      const bytes: Buffer[] = [];
      let count = 0;
      try {
        const length = response.headers.get('content-length'),
          encoding = response.headers.get('content-encoding');
        if (
          (encoding && encoding !== 'identity') ||
          (length !== null &&
            (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 32768))
        )
          throw failure();
        if (response.body) {
          reader = response.body.getReader();
          for (;;) {
            signal.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            if (
              !(part.value instanceof Uint8Array) ||
              count + part.value.byteLength > 32768
            )
              throw failure();
            bytes.push(Buffer.from(part.value));
            count += part.value.byteLength;
          }
        }
        if (
          signal.aborted ||
          (method !== 'HEAD' && length !== null && count !== Number(length))
        )
          throw failure();
        return {
          status: response.status,
          headers: response.headers,
          bytes: Buffer.concat(bytes),
          date,
        };
      } finally {
        void reader?.cancel().catch(() => {});
        for (const b of bytes) b.fill(0);
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
  private protocol(r: { headers: Headers }) {
    if (r.headers.get('tus-resumable') !== '1.0.0') throw failure();
  }
  private integer(value: string | null) {
    if (
      value === null ||
      !/^(0|[1-9][0-9]*)$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw failure();
    return Number(value);
  }
  private expiry(r: { headers: Headers; date: number }) {
    const raw = r.headers.get('upload-expires'),
      v = Date.parse(raw ?? '');
    if (
      !Number.isFinite(v) ||
      new Date(v).toUTCString() !== raw ||
      v < r.date + 60000 ||
      v > r.date + 86400000
    )
      throw failure();
    return new Date(v).toISOString();
  }
  private async create(
    slot: Slot,
    credential: 'control' | 'retired',
    length: number,
    b: Budget,
  ) {
    const metadata = Object.entries({
      bucketName: this.config.bucket,
      objectName: this.object(slot),
      contentType: 'text/plain',
      cacheControl: '0',
    })
      .map(([k, v]) => k + ' ' + Buffer.from(v).toString('base64'))
      .join(',');
    const r = await this.request('POST', this.endpoint(), credential, b, {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(length),
      'Upload-Metadata': metadata,
      'x-upsert': 'false',
    });
    try {
      if (r.status !== 201) throw failure();
      this.protocol(r);
      if (
        r.headers.has('upload-offset') &&
        this.integer(r.headers.get('upload-offset')) !== 0
      )
        throw failure();
      return {
        location: this.location(r.headers.get('location'), slot),
        expiresAt: slot === 'old' ? this.expiry(r) : null,
      };
    } finally {
      r.bytes.fill(0);
    }
  }
  private async state(
    location: string,
    length: number,
    offset: number,
    b: Budget,
    expiresAt?: string,
  ) {
    const r = await this.request('HEAD', location, 'control', b, {
      'Tus-Resumable': '1.0.0',
    });
    try {
      if (![200, 204].includes(r.status)) throw failure();
      this.protocol(r);
      if (
        this.integer(r.headers.get('upload-length')) !== length ||
        this.integer(r.headers.get('upload-offset')) !== offset
      )
        throw failure();
      if (expiresAt && this.expiry(r) !== expiresAt) throw failure();
    } finally {
      r.bytes.fill(0);
    }
  }
  private async patch(
    location: string,
    credential: 'control' | 'retired',
    offset: number,
    body: Buffer,
    b: Budget,
    expectedOffset?: number,
  ) {
    const r = await this.request(
      'PATCH',
      location,
      credential,
      b,
      {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      body,
    );
    try {
      if (expectedOffset !== undefined) {
        if (r.status !== 204) throw failure();
        this.protocol(r);
        if (this.integer(r.headers.get('upload-offset')) !== expectedOffset)
          throw failure();
      }
      return {
        status: r.status,
        providerObservedAt: new Date(r.date).toISOString(),
      };
    } finally {
      r.bytes.fill(0);
    }
  }
  private async objectState(slot: Slot, completed: boolean, b: Budget) {
    const r = await this.request(
      'GET',
      this.origin() +
        '/storage/v1/object/' +
        this.config.bucket +
        '/' +
        this.object(slot),
      'control',
      b,
    );
    try {
      if (
        completed ? r.status !== 200 || !r.bytes.equals(tail) : r.status !== 404
      )
        throw failure();
    } finally {
      r.bytes.fill(0);
    }
  }
  private async positive(slot: 'control-before' | 'control-after', b: Budget) {
    await this.objectState(slot, false, b);
    const s = await this.create(slot, 'control', 1, b);
    await this.patch(s.location, 'control', 0, tail, b, 1);
    await this.state(s.location, 1, 1, b);
    await this.objectState(slot, true, b);
  }
  private async bucket(b: Budget) {
    const r = await this.request(
      'GET',
      this.origin() + '/storage/v1/bucket/' + this.config.bucket,
      'control',
      b,
    );
    try {
      const v = JSON.parse(r.bytes.toString('utf8'));
      if (r.status !== 200 || v.id !== this.config.bucket || v.public !== false)
        throw failure();
    } finally {
      r.bytes.fill(0);
    }
  }
  assertBaseline(raw: unknown, expectedCustodyDigest: string) {
    const a = z
      .object({
        body: z.string().min(1).max(8192),
        sha256: sha,
        byteLength: z.number().int().positive().optional(),
      })
      .strict()
      .parse(raw);
    if (
      Buffer.byteLength(a.body) > 8192 ||
      hash(a.body) !== a.sha256 ||
      (a.byteLength !== undefined && a.byteLength !== Buffer.byteLength(a.body))
    )
      throw failure();
    const v = baselineSchema.parse(JSON.parse(a.body));
    if (
      JSON.stringify(v) !== a.body ||
      v.configurationDigest !== this.configurationDigest() ||
      JSON.stringify(v.maintenance) !==
        JSON.stringify(this.config.maintenance) ||
      v.credentialId !== this.config.retired.id ||
      v.locationPin.custodyDigest !== sha.parse(expectedCustodyDigest) ||
      v.prefixSha256 !== hash(prefix) ||
      Date.parse(v.capturedAt) > Date.now() + 60000 ||
      Date.parse(v.expiresAt) < Date.parse(v.capturedAt) + 60000
    )
      throw failure();
    return { body: a.body, sha256: a.sha256 };
  }
  async baseline(
    retain: RetainResumableLocation,
    expectedCustodyDigest: string,
    caller?: AbortSignal,
  ) {
    if (this.baselineAttempted) throw failure();
    this.baselineAttempted = true;
    return this.work(async (b) => {
      sha.parse(expectedCustodyDigest);
      if (typeof retain !== 'function') throw failure();
      await this.bucket(b);
      await this.objectState('old', false, b);
      const s = await this.create('old', 'retired', prefix.length + 1, b),
        saved = await retain(
          { location: s.location, sha256: hash(s.location) },
          b.signal,
        );
      b.signal.throwIfAborted();
      const pin = resumableLocationPinSchema.parse(saved.pin);
      if (
        pin.reference !== saved.reference ||
        pin.custodyDigest !== expectedCustodyDigest ||
        saved.locationSha256 !== hash(s.location)
      )
        throw failure();
      await this.state(s.location, prefix.length + 1, 0, b, s.expiresAt!);
      await this.patch(s.location, 'retired', 0, prefix, b, prefix.length);
      await this.state(
        s.location,
        prefix.length + 1,
        prefix.length,
        b,
        s.expiresAt!,
      );
      await this.objectState('old', false, b);
      const body = JSON.stringify(
        baselineSchema.parse({
          format: 1,
          kind: 'SUPABASE_RESUMABLE_BASELINE_V1',
          configurationDigest: this.configurationDigest(),
          maintenance: this.config.maintenance,
          credentialId: this.config.retired.id,
          reference: saved.reference,
          locationSha256: hash(s.location),
          locationPin: pin,
          capturedAt: new Date().toISOString(),
          expiresAt: s.expiresAt,
          offset: prefix.length,
          uploadLength: prefix.length + 1,
          prefixSha256: hash(prefix),
        }),
      );
      return this.assertBaseline(
        { body, sha256: hash(body) },
        expectedCustodyDigest,
      );
    }, caller);
  }
  async verifyRefusal(
    raw: unknown,
    expectedCustodyDigest: string,
    secret: unknown,
    caller?: AbortSignal,
  ) {
    if (this.verificationAttempted) throw failure();
    this.verificationAttempted = true;
    return this.work(async (b) => {
      const a = this.assertBaseline(raw, expectedCustodyDigest),
        saved = baselineSchema.parse(JSON.parse(a.body)),
        s = z
          .object({ reference: uuid, location: z.string().max(2048) })
          .strict()
          .parse(secret),
        location = this.location(s.location, 'old');
      if (
        s.reference !== saved.reference ||
        hash(location) !== saved.locationSha256 ||
        Date.now() + 60000 > Date.parse(saved.expiresAt)
      )
        throw failure();
      await this.bucket(b);
      await this.state(
        location,
        saved.uploadLength,
        saved.offset,
        b,
        saved.expiresAt,
      );
      await this.objectState('old', false, b);
      await this.positive('control-before', b);
      const refusal = await this.patch(
        location,
        'retired',
        saved.offset,
        tail,
        b,
      );
      if (
        ![401, 403].includes(refusal.status) ||
        Date.parse(refusal.providerObservedAt) + 60000 >
          Date.parse(saved.expiresAt)
      )
        throw failure();
      await this.state(
        location,
        saved.uploadLength,
        saved.offset,
        b,
        saved.expiresAt,
      );
      await this.objectState('old', false, b);
      await this.positive('control-after', b);
      const core = {
        kind: 'SUPABASE_RESUMABLE_REFUSAL_V1' as const,
        configurationDigest: this.configurationDigest(),
        baselineSha256: a.sha256,
        locationPinSha256: saved.locationPin.sha256,
        credentialId: this.config.retired.id,
        observedAt: new Date().toISOString(),
        refusalStatus: refusal.status,
        providerObservedAt: refusal.providerObservedAt,
      };
      return {
        ...core,
        observationDigest: hash(JSON.stringify(core)),
        testedResumablePatchRefusalObserved: true as const,
        coverage: 'ONE_REVIEWED_MODERN_SECRET_TUS_SESSION_ONLY' as const,
        resumableSessionsRevoked: false as const,
        signedResumableVerified: false as const,
        inFlightWritesDrained: false as const,
        providerReleaseAttested: false as const,
        wholeStorageQuiesced: false as const,
        actionAuthorized: false as const,
      };
    }, caller);
  }
}
