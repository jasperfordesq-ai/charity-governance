import { createHash } from 'node:crypto';
import { z } from 'zod';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  signedUploadCredentialPinSchema,
  type SignedUploadCredentialPin,
} from './signed-upload-credential-contract.js';
import { signedUploadBaselineSchema as baselineSchema, parseSignedUploadBaseline } from './signed-upload-evidence-contract.js';
import {
  StorageSignedUploadIssuer,
  storageSignedUploadIssuerSchema,
} from './storage-signed-upload-issuer.js';
import {
  syntheticWriteProbe,
  syntheticWriteUpdate,
} from './supabase-credential-write-proof.js';
const failure = () =>
  new Error(
    'Supabase signed-upload proof is unresolved; preserve the original attempt without retrying mutations',
  );
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const sha = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .length(64),
  uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase());
const record = z.object({ id: uuid, sha256: sha }).strict();
const configurationObject = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    projectRef: z
      .string()
      .regex(/^[a-z0-9]{20}$/)
      .length(20),
    bucket: z.literal('charitypilot-recovery-signed-probes'),
    maintenance: credentialReadMaintenanceBindingSchema,
    providerRelease: z
      .object({
        sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
        imageDigest: sha,
      })
      .strict(),
    control: record,
    gateway: record,
    previousIssuer: storageSignedUploadIssuerSchema,
    currentIssuer: storageSignedUploadIssuerSchema,
  })
  .strict();
const configuration = configurationObject
  .refine(
    (c) =>
      c.control.id !== c.gateway.id &&
      c.previousIssuer.fingerprint !== c.currentIssuer.fingerprint &&
      c.previousIssuer.providerKeyId !== c.currentIssuer.providerKeyId &&
      c.previousIssuer.tokenKid !== c.currentIssuer.tokenKid,
  );
export const supabaseSignedUploadRegistrySchema = configurationObject.omit({maintenance:true})
  .refine(
    (c) =>
      c.control.id !== c.gateway.id &&
      c.previousIssuer.fingerprint !== c.currentIssuer.fingerprint &&
      c.previousIssuer.providerKeyId !== c.currentIssuer.providerKeyId &&
      c.previousIssuer.tokenKid !== c.currentIssuer.tokenKid,
  );
const credential = z
  .object({ reference: uuid, token: z.string().min(1).max(8192) })
  .strict();
export type RetainSignedUploadCredential = (
  value: { token: string; sha256: string },
  signal: AbortSignal,
) => Promise<{
  reference: string;
  tokenSha256: string;
  pin: SignedUploadCredentialPin;
}>;
type Budget = { signal: AbortSignal; requests: number };

/** Active probes in fixed synthetic paths only. Secrets go to an explicit
 * custody callback, never the baseline/report. No provider key mutation,
 * automatic cleanup, parent dispatch, publication or global quiescence proof. */
export class SupabaseSignedUploadProof {
  private readonly config: z.infer<typeof configuration>;
  private readonly control: string;
  private readonly gateway: string;
  private readonly previous: StorageSignedUploadIssuer;
  private readonly current: StorageSignedUploadIssuer;
  private baselineAttempted = false;
  private verificationAttempted = false;
  constructor(
    raw: unknown,
    secrets: unknown,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.config = configuration.parse(raw);
    const key = z.object({ id: uuid, secret: z.string() }).strict(),
      s = z.object({ control: key, gateway: key }).strict().parse(secrets);
    if (
      s.control.id !== this.config.control.id ||
      s.gateway.id !== this.config.gateway.id ||
      !/^sb_secret_[A-Za-z0-9_-]{16,512}$/.test(s.control.secret) ||
      !/^sb_publishable_[A-Za-z0-9_-]{16,512}$/.test(s.gateway.secret) ||
      hash(s.control.secret) !== this.config.control.sha256 ||
      hash(s.gateway.secret) !== this.config.gateway.sha256
    )
      throw failure();
    this.control = s.control.secret;
    this.gateway = s.gateway.secret;
    this.previous = new StorageSignedUploadIssuer(this.config.previousIssuer);
    this.current = new StorageSignedUploadIssuer(this.config.currentIssuer);
  }
  configurationDigest() {
    return hash(
      JSON.stringify({
        format: 1,
        policy: 'ONE_SCOPED_SIGNED_UPLOAD_WITH_CUSTODY_PIN_V2',
        installationId: this.config.installationId,
        projectRef: this.config.projectRef,
        bucket: this.config.bucket,
        providerRelease: this.config.providerRelease,
        control: this.config.control,
        gateway: this.config.gateway,
        previousIssuer: this.previous.identity(),
        currentIssuer: this.current.identity(),
        initialPayloadSha256: hash(syntheticWriteProbe),
        updatePayloadSha256: hash(syntheticWriteUpdate),
      }),
    );
  }
  private path(which: 'old' | 'control') {
    return (
      'charitypilot-recovery-signed-probe/' +
      this.config.installationId +
      '/' +
      this.config.maintenance.attemptId +
      '/' +
      which +
      '.txt'
    );
  }
  private fullPath(which: 'old' | 'control') {
    return this.config.bucket + '/' + this.path(which);
  }
  private async work<T>(
    run: (budget: Budget) => Promise<T>,
    caller?: AbortSignal,
  ) {
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
    method: 'GET' | 'POST' | 'PUT',
    suffix: string,
    budget: Budget,
    payload?: string,
    signed = false,
    upsert = false,
  ) {
    if (++budget.requests > 64) throw failure();
    const controller = new AbortController(),
      signal = AbortSignal.any([budget.signal, controller.signal]),
      timer = setTimeout(() => controller.abort(), 10000);
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
      const response = await this.transport(
        'https://' +
          this.config.projectRef +
          '.supabase.co/storage/v1/' +
          suffix,
        {
          method,
          signal,
          redirect: 'error',
          headers: {
            apikey: signed ? this.gateway : this.control,
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache, no-store',
            ...(payload === undefined
              ? {}
              : {
                  'Content-Type':
                    suffix.includes('upload/sign/') && method === 'POST'
                      ? 'application/json'
                      : 'text/plain',
                }),
            ...(method === 'POST' || signed
              ? { 'x-upsert': String(upsert) }
              : {}),
          },
          ...(payload === undefined ? {} : { body: payload }),
        },
      );
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      const date = Date.parse(response.headers.get('date') ?? '');
      if (!Number.isFinite(date) || Math.abs(Date.now() - date) > 60000) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      if (!response.body)
        return {
          status: response.status,
          bytes: Buffer.alloc(0),
          mime: '',
          serverDate: new Date(date).toISOString(),
        };
      reader = response.body.getReader();
      const bytes = Buffer.alloc(32768);
      let count = 0;
      try {
        const length = response.headers.get('content-length'),
          encoding = response.headers.get('content-encoding');
        if (
          (encoding && encoding !== 'identity') ||
          (length !== null &&
            (!/^(0|[1-9][0-9]*)$/.test(length) ||
              Number(length) > bytes.length))
        )
          throw failure();
        for (;;) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          if (
            !(part.value instanceof Uint8Array) ||
            count + part.value.byteLength > bytes.length
          )
            throw failure();
          bytes.set(part.value, count);
          count += part.value.byteLength;
        }
        if (signal.aborted || (length !== null && Number(length) !== count))
          throw failure();
        return {
          status: response.status,
          bytes: Buffer.from(bytes.subarray(0, count)),
          mime:
            response.headers
              .get('content-type')
              ?.split(';')[0]
              .trim()
              .toLowerCase() ?? '',
          serverDate: new Date(date).toISOString(),
        };
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
  private async bucket(budget: Budget) {
    const r = await this.request('GET', 'bucket/' + this.config.bucket, budget);
    try {
      if (r.status !== 200 || r.mime !== 'application/json') throw failure();
      z.object({
        id: z.literal(this.config.bucket),
        public: z.literal(false),
      }).parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.bytes)),
      );
    } finally {
      r.bytes.fill(0);
    }
  }
  private async read(
    which: 'old' | 'control',
    expected: string | null,
    budget: Budget,
  ) {
    const r = await this.request(
      'GET',
      'object/' + this.fullPath(which),
      budget,
    );
    try {
      if (expected === null) {
        if (r.status !== 404) throw failure();
      } else if (
        r.status !== 200 ||
        r.mime !== 'text/plain' ||
        !r.bytes.equals(Buffer.from(expected))
      )
        throw failure();
    } finally {
      r.bytes.fill(0);
    }
  }
  private async write(
    which: 'old' | 'control',
    create: boolean,
    budget: Budget,
  ) {
    const r = await this.request(
      create ? 'POST' : 'PUT',
      'object/' + this.fullPath(which),
      budget,
      syntheticWriteProbe,
    );
    try {
      if (r.status !== 200 && r.status !== 201) throw failure();
    } finally {
      r.bytes.fill(0);
    }
    await this.read(which, syntheticWriteProbe, budget);
  }
  private async issue(
    which: 'old' | 'control',
    issuer: StorageSignedUploadIssuer,
    budget: Budget,
  ) {
    const r = await this.request(
      'POST',
      'object/upload/sign/' + this.fullPath(which),
      budget,
      '{}',
      false,
      true,
    );
    try {
      if (r.status !== 200 || r.mime !== 'application/json') throw failure();
      const value = z
        .object({
          url: z.string().min(1).max(12288),
          token: z.string().max(8192).optional(),
        })
        .strict()
        .parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.bytes)),
        );
      if (!value.url.startsWith('/object/upload/sign/')) throw failure();
      const url = new URL(
          value.url,
          'https://' + this.config.projectRef + '.supabase.co',
        ),
        token = url.searchParams.get('token');
      if (
        url.pathname !== '/object/upload/sign/' + this.fullPath(which) ||
        url.hash ||
        [...url.searchParams.keys()].length !== 1 ||
        !token ||
        (value.token !== undefined && value.token !== token)
      )
        throw failure();
      return { token, proof: issuer.verify(token, this.fullPath(which)) };
    } finally {
      r.bytes.fill(0);
    }
  }
  private async signedPut(
    which: 'old' | 'control',
    token: string,
    issuer: StorageSignedUploadIssuer,
    budget: Budget,
  ) {
    const proof = issuer.verify(token, this.fullPath(which));
    const r = await this.request(
      'PUT',
      'object/upload/sign/' +
        this.fullPath(which) +
        '?token=' +
        encodeURIComponent(token),
      budget,
      syntheticWriteUpdate,
      true,
      true,
    );
    if (Date.parse(proof.expiresAt) < Date.parse(r.serverDate) + 60000) {
      r.bytes.fill(0);
      throw failure();
    }
    return r;
  }
  private async positive(token: string, budget: Budget) {
    const r = await this.signedPut('control', token, this.current, budget);
    try {
      if (r.status !== 200 && r.status !== 201) throw failure();
    } finally {
      r.bytes.fill(0);
    }
    await this.read('control', syntheticWriteUpdate, budget);
    await this.write('control', false, budget);
  }
  /** Pure saved-evidence checks only; no token decryption, signature test or I/O. */
  assertBaseline(raw: unknown, expectedCustodyDigest: string) {
    const artifact = parseSignedUploadBaseline(raw),
      b = baselineSchema.parse(JSON.parse(artifact.body)),
      issuer = this.previous.identity();
    if (
      !sha.safeParse(expectedCustodyDigest).success ||
      b.credentialPin.custodyDigest !== expectedCustodyDigest ||
      b.configurationDigest !== this.configurationDigest() ||
      JSON.stringify(b.maintenance) !== JSON.stringify(this.config.maintenance) ||
      b.tokenProof.providerKeyId !== issuer.providerKeyId ||
      b.tokenProof.tokenKid !== issuer.tokenKid ||
      b.tokenProof.issuerFingerprint !== issuer.fingerprint ||
      b.initialPayloadSha256 !== hash(syntheticWriteProbe) ||
      b.updatePayloadSha256 !== hash(syntheticWriteUpdate) ||
      Date.parse(b.capturedAt) > Date.now() + 60000
    ) throw failure();
    return artifact;
  }
  async baseline(retain: RetainSignedUploadCredential, caller?: AbortSignal) {
    if (this.baselineAttempted) throw failure();
    this.baselineAttempted = true;
    return this.work(async (budget) => {
      await this.bucket(budget);
      await this.read('old', null, budget);
      await this.write('old', true, budget);
      const issued = await this.issue('old', this.previous, budget);
      const retained = z
        .object({
          reference: uuid,
          tokenSha256: sha,
          pin: signedUploadCredentialPinSchema,
        })
        .strict()
        .parse(
          await retain(
            { token: issued.token, sha256: issued.proof.tokenSha256 },
            budget.signal,
          ),
        );
      budget.signal.throwIfAborted();
      if (
        retained.tokenSha256 !== issued.proof.tokenSha256 ||
        retained.pin.tokenSha256 !== issued.proof.tokenSha256 ||
        retained.pin.reference !== retained.reference
      )
        throw failure();
      const r = await this.signedPut(
        'old',
        issued.token,
        this.previous,
        budget,
      );
      try {
        if (r.status !== 200 && r.status !== 201) throw failure();
      } finally {
        r.bytes.fill(0);
      }
      await this.read('old', syntheticWriteUpdate, budget);
      await this.write('old', false, budget);
      await this.bucket(budget);
      const body = JSON.stringify(
        baselineSchema.parse({
          format: 2,
          kind: 'SUPABASE_SIGNED_UPLOAD_BASELINE_V2',
          configurationDigest: this.configurationDigest(),
          maintenance: this.config.maintenance,
          credentialReference: retained.reference,
          credentialPin: retained.pin,
          tokenProof: issued.proof,
          capturedAt: new Date().toISOString(),
          initialPayloadSha256: hash(syntheticWriteProbe),
          updatePayloadSha256: hash(syntheticWriteUpdate),
        }),
      );
      return { body, sha256: hash(body), byteLength: Buffer.byteLength(body) };
    }, caller);
  }
  async verifyRefusal(
    body: string,
    baselineSha256: string,
    secret: unknown,
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
      const baseline = baselineSchema.parse(JSON.parse(body)),
        saved = credential.parse(secret),
        proof = this.previous.verify(saved.token, this.fullPath('old'));
      if (
        JSON.stringify(baseline) !== body ||
        baseline.configurationDigest !== this.configurationDigest() ||
        JSON.stringify(baseline.maintenance) !==
          JSON.stringify(this.config.maintenance) ||
        baseline.credentialReference !== saved.reference ||
        JSON.stringify(proof) !== JSON.stringify(baseline.tokenProof) ||
        Date.parse(baseline.capturedAt) > Date.now() + 60000 ||
        Date.parse(baseline.capturedAt) < Date.parse(proof.issuedAt) ||
        baseline.initialPayloadSha256 !== hash(syntheticWriteProbe) ||
        baseline.updatePayloadSha256 !== hash(syntheticWriteUpdate)
      )
        throw failure();
      await this.bucket(budget);
      await this.read('old', syntheticWriteProbe, budget);
      await this.read('control', null, budget);
      await this.write('control', true, budget);
      const current = await this.issue('control', this.current, budget);
      await this.positive(current.token, budget);
      const r = await this.signedPut('old', saved.token, this.previous, budget);
      let code: string;
      try {
        if (
          ![400, 401, 403].includes(r.status) ||
          r.mime !== 'application/json'
        )
          throw failure();
        const error = z
          .object({
            code: z.enum([
              'InvalidJWT',
              'InvalidSignature',
              'SignatureDoesNotMatch',
              'AccessDenied',
            ]),
          })
          .parse(
            JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(r.bytes),
            ),
          );
        if (
          r.status === 400 &&
          !['InvalidJWT', 'InvalidSignature'].includes(error.code)
        )
          throw failure();
        code = error.code;
      } finally {
        r.bytes.fill(0);
      }
      await this.read('old', syntheticWriteProbe, budget);
      await this.positive(current.token, budget);
      await this.bucket(budget);
      const core = {
        kind: 'SUPABASE_SIGNED_UPLOAD_REFUSAL_V1' as const,
        configurationDigest: this.configurationDigest(),
        baselineSha256,
        credentialPinSha256: baseline.credentialPin.sha256,
        tokenSha256: proof.tokenSha256,
        issuerFingerprint: proof.issuerFingerprint,
        observedAt: new Date().toISOString(),
        refusalStatus: r.status,
        refusalCode: code,
        providerObservedAt: r.serverDate,
      };
      return {
        ...core,
        observationDigest: hash(JSON.stringify(core)),
        testedSignedUploadRefusalObserved: true as const,
        issuedTokenSignatureMatched: true as const,
        coverage: 'ONE_REVIEWED_SYNTHETIC_SIGNED_UPLOAD_ONLY' as const,
        storageTokenIssuerVerified: false as const,
        managementKeyAssociationVerified: false as const,
        providerReleaseAttested: false as const,
        signedCapabilitiesRevoked: false as const,
        inFlightWritesDrained: false as const,
        wholeStorageQuiesced: false as const,
        actionAuthorized: false as const,
      };
    }, caller);
  }
  async inspect(caller?: AbortSignal) {
    return this.work(async (budget) => {
      await this.bucket(budget);
      const states: Record<string, string> = {};
      for (const which of ['old', 'control'] as const) {
        const r = await this.request(
          'GET',
          'object/' + this.fullPath(which),
          budget,
        );
        try {
          if (r.status !== 200 && r.status !== 404) throw failure();
          states[which] =
            r.status === 404
              ? 'ABSENT'
              : r.mime !== 'text/plain'
                ? 'UNEXPECTED'
                : r.bytes.equals(Buffer.from(syntheticWriteProbe))
                  ? 'INITIAL'
                  : r.bytes.equals(Buffer.from(syntheticWriteUpdate))
                    ? 'UPDATED'
                    : 'UNEXPECTED';
        } finally {
          r.bytes.fill(0);
        }
      }
      await this.bucket(budget);
      return {
        kind: 'SUPABASE_SIGNED_PROBE_DIAGNOSTICS_V1' as const,
        configurationDigest: this.configurationDigest(),
        observedAt: new Date().toISOString(),
        states,
        originalOutcomeReconstructed: false as const,
        wholeStorageQuiesced: false as const,
        actionAuthorized: false as const,
      };
    }, caller);
  }
}
