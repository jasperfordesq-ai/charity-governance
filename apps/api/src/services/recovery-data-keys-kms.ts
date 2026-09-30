import { DecryptCommand, GenerateDataKeyCommand, KMSClient, type KMSClientConfig } from '@aws-sdk/client-kms';
import { z } from 'zod';
import { validateRecoveryEnvelopeContext, type RecoveryDataKeys, type RecoveryEnvelopeContext } from './recovery-preparation-envelope.js';

const arn = z.string().regex(/^arn:aws:kms:eu-west-1:[0-9]{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
type KeyResponse = { Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array; KeyId?: string; EncryptionAlgorithm?: string };
const clear = (response: KeyResponse | undefined) => { if (response?.Plaintext instanceof Uint8Array) response.Plaintext.fill(0); };

/** Bounded provider adapter only. Provisioning, key policy and independently
 * recoverable custody must be verified separately. Injected client is a trusted
 * transport-test boundary; no default credentials or ambient endpoint is used. */
export class KmsRecoveryDataKeys implements RecoveryDataKeys {
  private readonly keyArn: string;
  private readonly client: KMSClient;
  constructor(keyArn: string, credentials: NonNullable<KMSClientConfig['credentials']>, client?: KMSClient) {
    this.keyArn = arn.parse(keyArn);
    if (!credentials) throw new Error('Explicit recovery KMS credentials are required');
    this.client = client ?? new KMSClient({ region: 'eu-west-1', credentials,
      endpoint: 'https://kms.eu-west-1.amazonaws.com', maxAttempts: 1,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 15000, throwOnRequestTimeout: true } });
  }

  private context(raw: RecoveryEnvelopeContext) {
    const value = validateRecoveryEnvelopeContext(raw);
    if (value.keyId !== this.keyArn) throw new Error('Recovery KMS key binding mismatch');
    // These values are non-secret routing metadata and can appear in provider
    // audit logs. Never add reasons, complaint narrative or actor names here.
    return { purpose: 'charitypilot-complaint-recovery-v1', installationId: value.installationId,
      organisationId: value.organisationId, operationId: value.operationId,
      writerEpoch: String(value.writerEpoch), sourceRevision: value.sourceRevision };
  }

  private async request(command: GenerateDataKeyCommand | DecryptCommand): Promise<KeyResponse> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Recovery KMS deadline exceeded')); }, 15000);
    });
    try {
      const pending = command instanceof GenerateDataKeyCommand
        ? this.client.send(command, { abortSignal: controller.signal })
        : this.client.send(command, { abortSignal: controller.signal });
      const guarded = pending.then(response => {
        if (controller.signal.aborted) { clear(response); throw new Error('Recovery KMS late response'); }
        return response;
      });
      return await Promise.race([guarded, expired]);
    } catch { throw new Error('Recovery KMS operation unavailable'); }
    finally { clearTimeout(timer!); controller.abort(); }
  }

  async generate(context: RecoveryEnvelopeContext) {
    let response: KeyResponse | undefined;
    try {
      response = await this.request(new GenerateDataKeyCommand({ KeyId: this.keyArn,
        KeySpec: 'AES_256', EncryptionContext: this.context(context) }));
      if (response.KeyId !== this.keyArn || !(response.Plaintext instanceof Uint8Array) || response.Plaintext.byteLength !== 32
        || !(response.CiphertextBlob instanceof Uint8Array) || response.CiphertextBlob.byteLength < 1 || response.CiphertextBlob.byteLength > 6144) {
        throw new Error('Invalid generated key');
      }
      return { key: Buffer.from(response.Plaintext), keyId: this.keyArn,
        wrappedKey: Buffer.from(response.CiphertextBlob).toString('base64') };
    } catch { throw new Error('Recovery data key could not be generated'); }
    finally { clear(response); }
  }

  async unwrap(wrappedKey: string, context: RecoveryEnvelopeContext) {
    let response: KeyResponse | undefined;
    try {
      if (typeof wrappedKey !== 'string' || wrappedKey.length > 8192) throw new Error('Invalid wrapped key');
      const blob = Buffer.from(wrappedKey, 'base64');
      if (!blob.length || blob.length > 6144 || blob.toString('base64') !== wrappedKey) throw new Error('Invalid wrapped key');
      response = await this.request(new DecryptCommand({ KeyId: this.keyArn, CiphertextBlob: blob,
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT', EncryptionContext: this.context(context) }));
      if (response.KeyId !== this.keyArn || response.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT'
        || !(response.Plaintext instanceof Uint8Array) || response.Plaintext.byteLength !== 32) throw new Error('Invalid unwrapped key');
      return { key: Buffer.from(response.Plaintext), keyId: this.keyArn };
    } catch { throw new Error('Recovery data key could not be unwrapped'); }
    finally { clear(response); }
  }
}
