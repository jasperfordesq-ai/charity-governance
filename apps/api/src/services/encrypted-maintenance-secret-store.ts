import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { Readable } from 'node:stream';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  type S3ClientConfig,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';
import { z } from 'zod';

const failure = () =>
  new Error(
    'Encrypted maintenance secret custody is unresolved; preserve the original attempt without retrying retention',
  );
const hash = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');
const base64 = z
  .string()
  .min(1)
  .max(16384)
  .refine((v) => Buffer.from(v, 'base64').toString('base64') === v);
export type MaintenanceSecretPin = {
  kind: string;
  reference: string;
  custodyDigest: string;
  versionId: string;
  sha256: string;
  byteLength: number;
};
export type MaintenanceSecretStorage = {
  installationId: string;
  bucket: string;
  accountId: string;
  dataKeyArn: string;
  storageKeyArn: string;
};
/** Trusted source-defined policy only; never accept policy callbacks from API/job data. */
export type MaintenanceSecretPolicy<C, P extends MaintenanceSecretPin> = {
  envelopeKind: string;
  objectKey: string;
  custodyDigest: string;
  parseContext: (raw: unknown) => C;
  assertContext: (c: C) => void;
  kmsContext: (c: C) => Record<string, string>;
  plaintextBytes: (c: C) => number;
  validatePlaintext: (bytes: Buffer, c: C) => void;
  parsePin: (raw: unknown) => P;
  makePin: (
    c: C,
    stored: { versionId: string; sha256: string; byteLength: number },
  ) => P;
};
type KeyResponse = {
  Plaintext?: Uint8Array;
  CiphertextBlob?: Uint8Array;
  KeyId?: string;
  EncryptionAlgorithm?: string;
};
const clear = (r: KeyResponse | undefined) => {
  if (r?.Plaintext instanceof Uint8Array) r.Plaintext.fill(0);
};

/** Shared bounded AES-GCM/KMS/exact-version transport, not an authority source. */
export class EncryptedMaintenanceSecretStore<
  C,
  P extends MaintenanceSecretPin,
> {
  private readonly config: MaintenanceSecretStorage;
  private readonly storage: S3Client;
  private readonly keys: KMSClient;
  private readonly envelopeSchema;
  private attempted = false;
  constructor(
    config: MaintenanceSecretStorage,
    private readonly policy: MaintenanceSecretPolicy<C, P>,
    storageCredentials: NonNullable<S3ClientConfig['credentials']>,
    kmsCredentials: NonNullable<KMSClientConfig['credentials']>,
    clients?: { storage?: S3Client; kms?: KMSClient },
  ) {
    this.config = { ...config };
    this.envelopeSchema = z
      .object({
        format: z.literal(1),
        kind: z.literal(policy.envelopeKind),
        context: z.unknown(),
        wrappedKey: base64,
        iv: base64,
        tag: base64,
        ciphertext: base64,
      })
      .strict();
    if (!storageCredentials || !kmsCredentials) throw failure();
    const handler = {
      connectionTimeout: 5000,
      requestTimeout: 15000,
      throwOnRequestTimeout: true,
    };
    this.storage =
      clients?.storage ??
      new S3Client({
        region: 'eu-west-1',
        endpoint: 'https://s3.eu-west-1.amazonaws.com',
        credentials: storageCredentials,
        maxAttempts: 1,
        followRegionRedirects: false,
        requestHandler: handler,
      });
    this.keys =
      clients?.kms ??
      new KMSClient({
        region: 'eu-west-1',
        endpoint: 'https://kms.eu-west-1.amazonaws.com',
        credentials: kmsCredentials,
        maxAttempts: 1,
        requestHandler: handler,
      });
  }
  private parseEnvelope(raw: unknown) {
    const e = this.envelopeSchema.parse(raw);
    return { ...e, context: this.policy.parseContext(e.context) };
  }
  private request() {
    return {
      Bucket: this.config.bucket,
      ExpectedBucketOwner: this.config.accountId,
      Key: this.policy.objectKey,
    };
  }
  private async work<T>(
    run: (signal: AbortSignal) => Promise<T>,
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
      const result = await Promise.race([run(signal), cancelled]);
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
  private async kms(
    command: GenerateDataKeyCommand | DecryptCommand,
    caller: AbortSignal,
  ): Promise<KeyResponse> {
    const controller = new AbortController(),
      signal = AbortSignal.any([caller, controller.signal]),
      timer = setTimeout(() => controller.abort(), 15000);
    let stop!: () => void;
    const cancelled = new Promise<never>((_r, reject) => {
      stop = () => reject(failure());
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      signal.throwIfAborted();
      const pending = (
        command instanceof GenerateDataKeyCommand
          ? this.keys.send(command, { abortSignal: signal })
          : this.keys.send(command, { abortSignal: signal })
      ).then((response) => {
        if (signal.aborted) {
          clear(response);
          throw failure();
        }
        return response;
      });
      return await Promise.race([pending, cancelled]);
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      controller.abort();
    }
  }
  private sendStorage(
    command: GetObjectCommand,
    signal: AbortSignal,
  ): Promise<GetObjectCommandOutput>;
  private sendStorage(
    command: PutObjectCommand,
    signal: AbortSignal,
  ): Promise<PutObjectCommandOutput>;
  private async sendStorage(
    command: GetObjectCommand | PutObjectCommand,
    signal: AbortSignal,
  ) {
    let stop!: () => void;
    const cancelled = new Promise<never>((_r, reject) => {
      stop = () => reject(failure());
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      signal.throwIfAborted();
      const pending = (
        command instanceof GetObjectCommand
          ? this.storage.send(command, { abortSignal: signal })
          : this.storage.send(command, { abortSignal: signal })
      ).then((response) => {
        if (signal.aborted) {
          if ('Body' in response && response.Body instanceof Readable)
            response.Body.destroy();
          throw failure();
        }
        return response;
      });
      return await Promise.race([pending, cancelled]);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
  private async generated(c: C, signal: AbortSignal) {
    let r: KeyResponse | undefined;
    try {
      r = await this.kms(
        new GenerateDataKeyCommand({
          KeyId: this.config.dataKeyArn,
          KeySpec: 'AES_256',
          EncryptionContext: this.policy.kmsContext(c),
        }),
        signal,
      );
      if (
        r.KeyId !== this.config.dataKeyArn ||
        !(r.Plaintext instanceof Uint8Array) ||
        r.Plaintext.byteLength !== 32 ||
        !(r.CiphertextBlob instanceof Uint8Array) ||
        r.CiphertextBlob.byteLength < 1 ||
        r.CiphertextBlob.byteLength > 6144
      )
        throw failure();
      return {
        key: Buffer.from(r.Plaintext),
        wrappedKey: Buffer.from(r.CiphertextBlob).toString('base64'),
      };
    } finally {
      clear(r);
    }
  }
  private async unwrapped(wrappedKey: string, c: C, signal: AbortSignal) {
    const bytes = Buffer.from(wrappedKey, 'base64');
    if (
      !bytes.length ||
      bytes.length > 6144 ||
      bytes.toString('base64') !== wrappedKey
    )
      throw failure();
    let r: KeyResponse | undefined;
    try {
      r = await this.kms(
        new DecryptCommand({
          KeyId: this.config.dataKeyArn,
          CiphertextBlob: bytes,
          EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          EncryptionContext: this.policy.kmsContext(c),
        }),
        signal,
      );
      if (
        r.KeyId !== this.config.dataKeyArn ||
        r.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT' ||
        !(r.Plaintext instanceof Uint8Array) ||
        r.Plaintext.byteLength !== 32
      )
        throw failure();
      return Buffer.from(r.Plaintext);
    } finally {
      clear(r);
    }
  }
  private metadata(
    r: {
      VersionId?: string;
      ServerSideEncryption?: string;
      SSEKMSKeyId?: string;
    },
    version?: string,
  ) {
    return Boolean(
      r.VersionId &&
      r.VersionId !== 'null' &&
      r.ServerSideEncryption === 'aws:kms' &&
      r.SSEKMSKeyId === this.config.storageKeyArn &&
      (version === undefined || r.VersionId === version),
    );
  }
  private async stored(rawPin: unknown | undefined, caller: AbortSignal) {
    const pin = rawPin === undefined ? undefined : this.policy.parsePin(rawPin);
    if (pin && pin.custodyDigest !== this.policy.custodyDigest) throw failure();
    const controller = new AbortController(),
      signal = AbortSignal.any([caller, controller.signal]),
      timer = setTimeout(() => controller.abort(), 15000);
    let stream: Readable | undefined;
    const abort = () => stream?.destroy(failure());
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const response = await this.sendStorage(
        new GetObjectCommand({
          ...this.request(),
          ...(pin ? { VersionId: pin.versionId } : {}),
          ChecksumMode: 'ENABLED',
        }),
        signal,
      );
      if (response.Body instanceof Readable) stream = response.Body;
      if (
        signal.aborted ||
        !stream ||
        response.DeleteMarker ||
        !this.metadata(response, pin?.versionId) ||
        !Number.isInteger(response.ContentLength) ||
        response.ContentLength! < 1 ||
        response.ContentLength! > 32768 ||
        (pin && response.ContentLength !== pin.byteLength)
      )
        throw failure();
      const chunks: Buffer[] = [];
      let count = 0;
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) throw failure();
        count += chunk.byteLength;
        if (count > 32768) throw failure();
        chunks.push(Buffer.from(chunk));
      }
      if (signal.aborted || count !== response.ContentLength) throw failure();
      const body = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      if (pin && hash(body) !== pin.sha256) throw failure();
      const e = this.parseEnvelope(JSON.parse(body));
      if (JSON.stringify(e) !== body) throw failure();
      this.policy.assertContext(e.context);
      if (
        Buffer.from(e.iv, 'base64').length !== 12 ||
        Buffer.from(e.tag, 'base64').length !== 16 ||
        Buffer.from(e.ciphertext, 'base64').length !==
          this.policy.plaintextBytes(e.context)
      )
        throw failure();
      const observed = this.policy.makePin(e.context, {
        versionId: response.VersionId!,
        sha256: hash(body),
        byteLength: count,
      });
      if (pin && JSON.stringify(pin) !== JSON.stringify(observed))
        throw failure();
      return { envelope: e, pin: observed };
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      stream?.destroy();
      controller.abort();
    }
  }
  private async opened(rawPin: unknown | undefined, signal: AbortSignal) {
    const stored = await this.stored(rawPin, signal),
      e = stored.envelope;
    let key: Buffer | undefined,
      partial: Buffer | undefined,
      plaintext: Buffer | undefined;
    try {
      key = await this.unwrapped(e.wrappedKey, e.context, signal);
      signal.throwIfAborted();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(e.iv, 'base64'),
        { authTagLength: 16 },
      );
      decipher.setAAD(Buffer.from(JSON.stringify(e.context)));
      decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
      partial = decipher.update(Buffer.from(e.ciphertext, 'base64'));
      const final = decipher.final();
      try {
        plaintext = Buffer.concat([partial, final]);
      } finally {
        final.fill(0);
      }
      this.policy.validatePlaintext(plaintext, e.context);
      const verified = plaintext;
      plaintext = undefined;
      return { bytes: verified, pin: stored.pin };
    } finally {
      key?.fill(0);
      partial?.fill(0);
      plaintext?.fill(0);
    }
  }

  async retain(rawContext: unknown, input: Buffer, caller?: AbortSignal) {
    if (this.attempted) throw failure();
    this.attempted = true;
    return this.work(async (signal) => {
      const c = this.policy.parseContext(rawContext);
      this.policy.assertContext(c);
      const plain = Buffer.from(input);
      let material: { key: Buffer; wrappedKey: string } | undefined;
      const abort = () => {
        plain.fill(0);
        material?.key.fill(0);
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        this.policy.validatePlaintext(plain, c);
        material = await this.generated(c, signal);
        signal.throwIfAborted();
        const iv = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', material!.key, iv, {
            authTagLength: 16,
          });
        cipher.setAAD(Buffer.from(JSON.stringify(c)));
        const ciphertext = Buffer.concat([
            cipher.update(plain),
            cipher.final(),
          ]),
          body = JSON.stringify(
            this.parseEnvelope({
              format: 1,
              kind: this.policy.envelopeKind,
              context: c,
              wrappedKey: material!.wrappedKey,
              iv: iv.toString('base64'),
              tag: cipher.getAuthTag().toString('base64'),
              ciphertext: ciphertext.toString('base64'),
            }),
          );
        if (Buffer.byteLength(body) > 32768) throw failure();
        material!.key.fill(0);
        const controller = new AbortController(),
          combined = AbortSignal.any([signal, controller.signal]),
          timer = setTimeout(() => controller.abort(), 15000);
        let response: PutObjectCommandOutput;
        try {
          combined.throwIfAborted();
          response = await this.sendStorage(
            new PutObjectCommand({
              ...this.request(),
              IfNoneMatch: '*',
              Body: body,
              ContentType: 'application/json',
              ServerSideEncryption: 'aws:kms',
              SSEKMSKeyId: this.config.storageKeyArn,
              ChecksumSHA256: createHash('sha256')
                .update(body)
                .digest('base64'),
            }),
            combined,
          );
          if (combined.aborted || !this.metadata(response)) throw failure();
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
        const pin = this.policy.makePin(c, {
          versionId: response.VersionId!,
          sha256: hash(body),
          byteLength: Buffer.byteLength(body),
        });
        const retained = await this.opened(pin, signal);
        try {
          if (!retained.bytes.equals(plain)) throw failure();
        } finally {
          retained.bytes.fill(0);
        }
        return pin;
      } finally {
        signal.removeEventListener('abort', abort);
        plain?.fill(0);
        material?.key.fill(0);
      }
    }, caller);
  }

  async withSecret<T>(
    rawPin: unknown | undefined,
    consumer: (
      opened: { bytes: Buffer; pin: P },
      signal: AbortSignal,
    ) => Promise<T>,
    caller?: AbortSignal,
  ) {
    return this.work(async (signal) => {
      const opened = await this.opened(rawPin, signal),
        abort = () => opened.bytes.fill(0);
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        return await consumer(opened, signal);
      } finally {
        signal.removeEventListener('abort', abort);
        opened.bytes.fill(0);
      }
    }, caller);
  }
}
