import {
  GenerateMacCommand,
  VerifyMacCommand,
  KMSClient,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';
import { DOCUMENT_BACKUP_KEY_ARN } from './document-byte-backup.js';

const refused = () => new Error('Backup manifest authentication unavailable');
/** Explicit independent HMAC key. Injected clients are a trusted test boundary;
 * there is no caller-selected endpoint, ambient credentials or key discovery. */
export class KmsBackupManifestMac {
  private readonly keyArn: string;
  private readonly client: KMSClient;
  constructor(
    keyArn: string,
    private readonly purpose:
      | 'DOCUMENT_BACKUP_INDEX_V1'
      | 'ARCHIVED_RECOVERY_SET_V1',
    credentials: NonNullable<KMSClientConfig['credentials']>,
    client?: KMSClient,
  ) {
    this.keyArn = DOCUMENT_BACKUP_KEY_ARN.parse(keyArn);
    if (
      !credentials ||
      !['DOCUMENT_BACKUP_INDEX_V1', 'ARCHIVED_RECOVERY_SET_V1'].includes(
        purpose,
      )
    )
      throw refused();
    this.client =
      client ??
      new KMSClient({
        region: 'eu-west-1',
        endpoint: 'https://kms.eu-west-1.amazonaws.com',
        credentials,
        maxAttempts: 1,
        requestHandler: {
          connectionTimeout: 5000,
          requestTimeout: 15000,
          throwOnRequestTimeout: true,
        },
      });
  }
  private message(keyArn: string, message: Buffer) {
    const prefix = 'CHARITYPILOT_' + this.purpose + '\n';
    const snapshot =
      Buffer.isBuffer(message) && message.length <= 256
        ? Buffer.from(message)
        : undefined;
    if (
      keyArn !== this.keyArn ||
      !snapshot ||
      snapshot.length !== Buffer.byteLength(prefix) + 64 ||
      !snapshot.toString('utf8').startsWith(prefix) ||
      !/^[a-f0-9]{64}$/.test(snapshot.toString('utf8').slice(prefix.length))
    )
      throw refused();
    return snapshot;
  }
  private async request<T>(
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(refused());
          }, 15000);
        }),
      ]);
    } catch {
      throw refused();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async generate(keyArn: string, message: Buffer) {
    const body = this.message(keyArn, message);
    const response = await this.request((signal) =>
      this.client.send(
        new GenerateMacCommand({
          KeyId: this.keyArn,
          MacAlgorithm: 'HMAC_SHA_256',
          Message: body,
        }),
        { abortSignal: signal },
      ),
    );
    if (
      response.KeyId !== this.keyArn ||
      response.MacAlgorithm !== 'HMAC_SHA_256' ||
      !(response.Mac instanceof Uint8Array) ||
      response.Mac.length !== 32
    )
      throw refused();
    return { keyArn: this.keyArn, mac: Buffer.from(response.Mac) };
  }
  async verify(keyArn: string, message: Buffer, mac: Buffer) {
    const body = this.message(keyArn, message);
    if (!Buffer.isBuffer(mac) || mac.length !== 32) throw refused();
    const tag = Buffer.from(mac);
    const response = await this.request((signal) =>
      this.client.send(
        new VerifyMacCommand({
          KeyId: this.keyArn,
          MacAlgorithm: 'HMAC_SHA_256',
          Message: body,
          Mac: tag,
        }),
        { abortSignal: signal },
      ),
    );
    if (
      response.KeyId !== this.keyArn ||
      response.MacAlgorithm !== 'HMAC_SHA_256' ||
      response.MacValid !== true
    )
      throw refused();
    return { keyArn: this.keyArn, valid: true };
  }
}
