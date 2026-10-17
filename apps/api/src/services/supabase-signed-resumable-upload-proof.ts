import { z } from 'zod';
import {
  BoundedStorageProbeTransport,
  type StorageProbeBudget as Budget,
} from './bounded-storage-probe-transport.js';
import { credentialReadMaintenanceBindingSchema } from './credential-read-evidence.js';
import {
  StorageSignedUploadIssuer,
  storageSignedUploadIssuerSchema,
} from './storage-signed-upload-issuer.js';
import {
  assertSignedResumableLocation,
  assertSignedResumablePair,
  parseSignedResumableBaseline,
  signedResumableBaselineSchema,
  signedResumableCredentialPinSchema,
  signedTusHash as hash,
} from './signed-resumable-upload-contract.js';
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase());
const key = z.object({ id: uuid, sha256: sha }).strict();
const configuration = z
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
    gateway: key,
    previousIssuer: storageSignedUploadIssuerSchema,
    currentIssuer: storageSignedUploadIssuerSchema,
  })
  .strict()
  .refine(
    (v) =>
      v.control.id !== v.gateway.id &&
      v.previousIssuer.providerKeyId !== v.currentIssuer.providerKeyId &&
      v.previousIssuer.fingerprint !== v.currentIssuer.fingerprint &&
      v.previousIssuer.tokenKid !== v.currentIssuer.tokenKid,
  );
export const supabaseSignedResumableRegistrySchema=configuration.innerType().omit({maintenance:true}).refine(v=>v.control.id!==v.gateway.id&&v.previousIssuer.providerKeyId!==v.currentIssuer.providerKeyId&&v.previousIssuer.fingerprint!==v.currentIssuer.fingerprint&&v.previousIssuer.tokenKid!==v.currentIssuer.tokenKid);
type Slot = 'old' | 'control-before' | 'control-after';
type Pin = z.infer<typeof signedResumableCredentialPinSchema>;
export type RetainSignedResumableCredential = (
  value: {
    token: string;
    location: string;
    tokenSha256: string;
    locationSha256: string;
  },
  signal: AbortSignal,
) => Promise<Pin>;
const prefix = Buffer.alloc(6291456, 0x43),
  tail = Buffer.from('P');
const failure = () =>
  new Error(
    'Signed resumable proof is unresolved; preserve the original attempt without retry or cleanup',
  );
/** One original signed TUS capability. No key mutation, custody implementation,
 * publication, parent dispatch, cleanup or global capability-closure claim. */
export class SupabaseSignedResumableUploadProof {
  private readonly config: z.infer<typeof configuration>;
  private readonly http: BoundedStorageProbeTransport;
  private readonly control: string;
  private readonly gateway: string;
  private readonly previous: StorageSignedUploadIssuer;
  private readonly current: StorageSignedUploadIssuer;
  private baselineAttempted = false;
  private verificationAttempted = false;
  constructor(raw: unknown, secrets: unknown, transport: typeof fetch = fetch) {
    this.config = configuration.parse(raw);
    const supplied = z
      .object({
        control: z.object({ id: uuid, secret: z.string() }).strict(),
        gateway: z.object({ id: uuid, secret: z.string() }).strict(),
      })
      .strict()
      .parse(secrets);
    if (
      supplied.control.id !== this.config.control.id ||
      supplied.gateway.id !== this.config.gateway.id ||
      !/^sb_secret_[A-Za-z0-9_-]{16,512}$/.test(supplied.control.secret) ||
      !/^sb_publishable_[A-Za-z0-9_-]{16,512}$/.test(supplied.gateway.secret) ||
      hash(supplied.control.secret) !== this.config.control.sha256 ||
      hash(supplied.gateway.secret) !== this.config.gateway.sha256
    )
      throw failure();
    this.control = supplied.control.secret;
    this.gateway = supplied.gateway.secret;
    this.previous = new StorageSignedUploadIssuer(this.config.previousIssuer);
    this.current = new StorageSignedUploadIssuer(this.config.currentIssuer);
    this.http = new BoundedStorageProbeTransport(this.origin(), transport);
  }
  configurationDigest() {
    const { maintenance, ...registry } = this.config;
    return hash(
      JSON.stringify({
        format: 1,
        policy: 'ONE_ORIGINAL_SIGNED_TUS_WITH_COMBINED_CUSTODY_V1',
        ...registry,
        prefixSha256: hash(prefix),
        tailSha256: hash(tail),
      }),
    );
  }
  private origin() {
    return 'https://' + this.config.projectRef + '.storage.supabase.co';
  }
  private endpoint() {
    return this.origin() + '/storage/v1/upload/resumable/sign';
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
  private fullPath(slot: Slot) {
    return this.config.bucket + '/' + this.object(slot);
  }
  private scope() {
    return {
      installationId: this.config.installationId,
      projectRef: this.config.projectRef,
      attemptId: this.config.maintenance.attemptId,
      uploadIdFormat: this.config.uploadIdFormat,
    };
  }
  private location(raw: unknown, slot: Slot) {
    return assertSignedResumableLocation(raw, this.scope(), slot);
  }
  private async request(
    method: 'GET' | 'HEAD' | 'POST' | 'PATCH',
    url: string,
    b: Budget,
    headers: Record<string, string> = {},
    body?: Buffer,
  ) {
    return this.http.request(
      method,
      url,
      b,
      { apikey: this.control, ...headers },
      body,
    );
  }
  private protocol(r: { headers: Headers }) {
    if (r.headers.get('tus-resumable') !== '1.0.0') throw failure();
  }
  private integer(raw: string | null) {
    if (
      raw === null ||
      !/^(0|[1-9][0-9]*)$/.test(raw) ||
      !Number.isSafeInteger(Number(raw))
    )
      throw failure();
    return Number(raw);
  }
  private expiry(r: { headers: Headers; date: number }) {
    const text = r.headers.get('upload-expires'),
      n = Date.parse(text ?? '');
    if (
      !Number.isFinite(n) ||
      new Date(n).toUTCString() !== text ||
      n < r.date + 60000 ||
      n > r.date + 86400000
    )
      throw failure();
    return new Date(n).toISOString();
  }
  private async bucket(b: Budget) {
    const r = await this.request(
      'GET',
      this.origin() + '/storage/v1/bucket/' + this.config.bucket,
      b,
    );
    try {
      const v = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(r.bytes),
      );
      if (r.status !== 200 || v.id !== this.config.bucket || v.public !== false)
        throw failure();
    } finally {
      r.bytes.fill(0);
    }
  }
  private async objectState(slot: Slot, completed: boolean, b: Budget) {
    const r = await this.request(
      'GET',
      this.origin() + '/storage/v1/object/' + this.fullPath(slot),
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
  private async issue(
    slot: Slot,
    issuer: StorageSignedUploadIssuer,
    b: Budget,
  ) {
    const r = await this.request(
      'POST',
      this.origin() + '/storage/v1/object/upload/sign/' + this.fullPath(slot),
      b,
      { 'Content-Type': 'application/json', 'x-upsert': 'true' },
      Buffer.from('{}'),
    );
    try {
      if (
        r.status !== 200 ||
        r.headers.get('content-type')?.split(';')[0] !== 'application/json'
      )
        throw failure();
      const v = z
        .object({
          url: z.string().min(1).max(12288),
          token: z.string().max(8192).optional(),
        })
        .strict()
        .parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.bytes)),
        );
      const start = '/object/upload/sign/' + this.fullPath(slot) + '?token=';
      if (!v.url.startsWith(start)) throw failure();
      const token = decodeURIComponent(v.url.slice(start.length));
      if (
        v.url !== start + encodeURIComponent(token) ||
        (v.token !== undefined && v.token !== token)
      )
        throw failure();
      return { token, proof: issuer.verify(token, this.fullPath(slot)) };
    } finally {
      r.bytes.fill(0);
    }
  }
  private async create(
    slot: Slot,
    token: string,
    issuer: StorageSignedUploadIssuer,
    length: number,
    b: Budget,
  ) {
    issuer.verify(token, this.fullPath(slot));
    const metadata = Object.entries({
      bucketName: this.config.bucket,
      objectName: this.object(slot),
      contentType: 'text/plain',
      cacheControl: '0',
    })
      .map(([k, v]) => k + ' ' + Buffer.from(v).toString('base64'))
      .join(',');
    const r = await this.request('POST', this.endpoint(), b, {
      apikey: this.gateway,
      'x-signature': token,
      'x-upsert': 'true',
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(length),
      'Upload-Metadata': metadata,
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
    slot: Slot,
    length: number,
    offset: number,
    b: Budget,
    expiresAt?: string,
  ) {
    this.location(location, slot);
    // Inspect the SAME decoded upload through its ordinary HEAD alias. Signed HEAD
    // authenticates the signature before HEAD's public branch in reviewed upstream.
    const unsigned = location.replace('/resumable/sign/', '/resumable/');
    const r = await this.request('HEAD', unsigned, b, {
      'Tus-Resumable': '1.0.0',
    });
    try {
      if (![200, 204].includes(r.status)) throw failure();
      this.protocol(r);
      if (
        this.integer(r.headers.get('upload-length')) !== length ||
        this.integer(r.headers.get('upload-offset')) !== offset ||
        (expiresAt && this.expiry(r) !== expiresAt)
      )
        throw failure();
    } finally {
      r.bytes.fill(0);
    }
  }
  private async patch(
    location: string,
    slot: Slot,
    token: string,
    issuer: StorageSignedUploadIssuer,
    offset: number,
    bytes: Buffer,
    b: Budget,
    expectedOffset?: number,
  ) {
    this.location(location, slot);
    const proof = issuer.verify(token, this.fullPath(slot));
    const r = await this.request(
      'PATCH',
      location,
      b,
      {
        apikey: this.gateway,
        'x-signature': token,
        'x-upsert': 'true',
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      bytes,
    );
    if (Date.parse(proof.expiresAt) < r.date + 60000) {
      r.bytes.fill(0);
      throw failure();
    }
    if (expectedOffset !== undefined) {
      try {
        if (r.status !== 204) throw failure();
        this.protocol(r);
        if (this.integer(r.headers.get('upload-offset')) !== expectedOffset)
          throw failure();
      } finally {
        r.bytes.fill(0);
      }
    }
    return r;
  }
  private async positive(slot: 'control-before' | 'control-after', b: Budget) {
    await this.objectState(slot, false, b);
    const issued = await this.issue(slot, this.current, b),
      s = await this.create(slot, issued.token, this.current, 1, b);
    await this.patch(
      s.location,
      slot,
      issued.token,
      this.current,
      0,
      tail,
      b,
      1,
    );
    await this.state(s.location, slot, 1, 1, b);
    await this.objectState(slot, true, b);
  }
  assertBaseline(raw: unknown, custodyDigest: string) {
    const { artifact, value: v } = parseSignedResumableBaseline(raw),
      issuer = this.previous.identity();
    if (
      v.configurationDigest !== this.configurationDigest() ||
      JSON.stringify(v.maintenance) !==
        JSON.stringify(this.config.maintenance) ||
      v.credentialPin.custodyDigest !== sha.parse(custodyDigest) ||
      v.tokenProof.issuerFingerprint !== issuer.fingerprint ||
      v.tokenProof.providerKeyId !== issuer.providerKeyId ||
      v.tokenProof.tokenKid !== issuer.tokenKid ||
      Date.parse(v.capturedAt) > Date.now() + 60000
    )
      throw failure();
    return artifact;
  }
  async baseline(
    retain: RetainSignedResumableCredential,
    custodyDigest: string,
    caller?: AbortSignal,
  ) {
    if (this.baselineAttempted) throw failure();
    this.baselineAttempted = true;
    return this.http
      .work(async (b) => {
        sha.parse(custodyDigest);
        if (typeof retain !== 'function') throw failure();
        await this.bucket(b);
        await this.objectState('old', false, b);
        const issued = await this.issue('old', this.previous, b),
          s = await this.create(
            'old',
            issued.token,
            this.previous,
            prefix.length + 1,
            b,
          );
        const pin = signedResumableCredentialPinSchema.parse(
          await retain(
            {
              token: issued.token,
              location: s.location,
              tokenSha256: issued.proof.tokenSha256,
              locationSha256: hash(s.location),
            },
            b.signal,
          ),
        );
        b.signal.throwIfAborted();
        if (
          pin.custodyDigest !== custodyDigest ||
          pin.tokenSha256 !== issued.proof.tokenSha256 ||
          pin.locationSha256 !== hash(s.location)
        )
          throw failure();
        await this.state(
          s.location,
          'old',
          prefix.length + 1,
          0,
          b,
          s.expiresAt!,
        );
        await this.patch(
          s.location,
          'old',
          issued.token,
          this.previous,
          0,
          prefix,
          b,
          prefix.length,
        );
        await this.state(
          s.location,
          'old',
          prefix.length + 1,
          prefix.length,
          b,
          s.expiresAt!,
        );
        await this.objectState('old', false, b);
        const body = JSON.stringify(
          signedResumableBaselineSchema.parse({
            format: 1,
            kind: 'SUPABASE_SIGNED_RESUMABLE_BASELINE_V1',
            configurationDigest: this.configurationDigest(),
            maintenance: this.config.maintenance,
            credentialPin: pin,
            tokenProof: issued.proof,
            capturedAt: new Date().toISOString(),
            expiresAt: s.expiresAt,
            offset: prefix.length,
            uploadLength: prefix.length + 1,
            prefixSha256: hash(prefix),
          }),
        );
        return this.assertBaseline({ body, sha256: hash(body) }, custodyDigest);
      }, caller)
      .catch(() => {
        throw failure();
      });
  }
  async verifyRefusal(
    raw: unknown,
    custodyDigest: string,
    secret: unknown,
    caller?: AbortSignal,
  ) {
    if (this.verificationAttempted) throw failure();
    this.verificationAttempted = true;
    return this.http
      .work(async (b) => {
        const a = this.assertBaseline(raw, custodyDigest),
          saved = parseSignedResumableBaseline(a).value,
          s = z
            .object({
              reference: uuid,
              token: z.string().min(1).max(8192),
              location: z.string().min(1).max(2048),
            })
            .strict()
            .parse(secret);
        this.location(s.location, 'old');
        const proof = this.previous.verify(s.token, this.fullPath('old'));
        if (
          s.reference !== saved.credentialPin.reference ||
          hash(s.location) !== saved.credentialPin.locationSha256 ||
          JSON.stringify(proof) !== JSON.stringify(saved.tokenProof) ||
          Date.now() + 60000 > Date.parse(saved.expiresAt)
        )
          throw failure();
        await this.bucket(b);
        await this.state(
          s.location,
          'old',
          saved.uploadLength,
          saved.offset,
          b,
          saved.expiresAt,
        );
        await this.objectState('old', false, b);
        await this.positive('control-before', b);
        const r = await this.patch(
          s.location,
          'old',
          s.token,
          this.previous,
          saved.offset,
          tail,
          b,
        );
        let refusalCode: string;
        try {
          if (![400, 401, 403].includes(r.status)) throw failure();
          const text = new TextDecoder('utf-8', { fatal: true }).decode(
              r.bytes,
            ),
            mime = r.headers.get('content-type')?.split(';')[0];
          if (mime === 'application/json') {
            const v = z
              .object({
                code: z.enum([
                  'InvalidJWT',
                  'InvalidSignature',
                  'SignatureDoesNotMatch',
                  'AccessDenied',
                ]),
              })
              .parse(JSON.parse(text));
            if (
              r.status === 400 &&
              !['InvalidJWT', 'InvalidSignature'].includes(v.code)
            )
              throw failure();
            refusalCode = v.code;
          } else {
            const allowed: Record<string, string> = {
              'invalid signature': 'InvalidSignature',
              'Invalid signature': 'InvalidSignature',
              'Invalid JWT': 'InvalidJWT',
              'Signature does not match': 'SignatureDoesNotMatch',
              'Access denied': 'AccessDenied',
            };
            if (
              !['text/plain', undefined].includes(mime) ||
              !Object.hasOwn(allowed, text)
            )
              throw failure();
            refusalCode = allowed[text];
            if (
              r.status === 400 &&
              !['InvalidJWT', 'InvalidSignature'].includes(refusalCode)
            )
              throw failure();
          }
          if (r.date + 60000 > Date.parse(saved.expiresAt)) throw failure();
        } finally {
          r.bytes.fill(0);
        }
        await this.state(
          s.location,
          'old',
          saved.uploadLength,
          saved.offset,
          b,
          saved.expiresAt,
        );
        await this.objectState('old', false, b);
        await this.positive('control-after', b);
        const core = {
          kind: 'SUPABASE_SIGNED_RESUMABLE_REFUSAL_V1' as const,
          configurationDigest: this.configurationDigest(),
          baselineSha256: a.sha256,
          credentialPinSha256: saved.credentialPin.sha256,
          tokenSha256: proof.tokenSha256,
          locationSha256: saved.credentialPin.locationSha256,
          issuerFingerprint: proof.issuerFingerprint,
          observedAt: new Date().toISOString(),
          providerObservedAt: new Date(r.date).toISOString(),
          refusalStatus: r.status,
          refusalCode,
        };
        return assertSignedResumablePair(a, {
          ...core,
          observationDigest: hash(JSON.stringify(core)),
          testedSignedResumablePatchRefusalObserved: true as const,
          coverage: 'ONE_ORIGINAL_REVIEWED_SIGNED_TUS_CAPABILITY_ONLY' as const,
          resumableSessionsRevoked: false as const,
          signedCapabilitiesRevoked: false as const,
          storageTokenIssuerVerified: false as const,
          providerReleaseAttested: false as const,
          inFlightWritesDrained: false as const,
          wholeStorageQuiesced: false as const,
          actionAuthorized: false as const,
        });
      }, caller)
      .catch(() => {
        throw failure();
      });
  }
}
