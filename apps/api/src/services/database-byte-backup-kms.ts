import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';
import { DOCUMENT_BACKUP_KEY_ARN } from './document-byte-backup.js';
import {
  databaseBackupContext,
  type DatabaseBackupContext,
  type DatabaseBackupKeys,
} from './database-byte-backup.js';

type KeyResponse = {
  Plaintext?: Uint8Array;
  CiphertextBlob?: Uint8Array;
  KeyId?: string;
  EncryptionAlgorithm?: string;
};
const clear = (value: KeyResponse | undefined) => {
  if (value?.Plaintext instanceof Uint8Array) value.Plaintext.fill(0);
};
const refused = () => new Error('Database backup key unavailable');
/** Dedicated purpose, exact key and explicit credentials. A client override is
 * a trusted synthetic transport boundary, not an operator endpoint setting. */
export class KmsDatabaseBackupKeys implements DatabaseBackupKeys {
  private readonly keyArn: string;
  private readonly client: KMSClient;
  constructor(
    keyArn: string,
    credentials: NonNullable<KMSClientConfig['credentials']>,
    client?: KMSClient,
  ) {
    this.keyArn = DOCUMENT_BACKUP_KEY_ARN.parse(keyArn);
    if (!credentials) throw refused();
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
  private context(raw: DatabaseBackupContext) {
    const c = databaseBackupContext(raw);
    if (c.keyArn !== this.keyArn) throw refused();
    return {
      purpose: 'charitypilot-database-byte-backup-v1',
      installationId: c.installationId,
      setId: c.setId,
      sourceSha: c.sourceSha,
      databaseSha256: c.databaseSha256,
      databaseIdentitySha256: c.databaseIdentitySha256,
      sourceCaptureReportSha256: c.sourceCaptureReportSha256,
      byteLength: String(c.byteLength),
    };
  }
  private async request(
    command: GenerateDataKeyCommand | DecryptCommand,
  ): Promise<KeyResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(refused());
      }, 15000);
    });
    try {
      const pending = (
        command instanceof GenerateDataKeyCommand
          ? this.client.send(command, { abortSignal: controller.signal })
          : this.client.send(command, { abortSignal: controller.signal })
      ).then((response) => {
        if (controller.signal.aborted) {
          clear(response);
          throw refused();
        }
        return response;
      });
      return await Promise.race([pending, timeout]);
    } catch {
      throw refused();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async generate(raw: DatabaseBackupContext) {
    let response: KeyResponse | undefined;
    try {
      response = await this.request(
        new GenerateDataKeyCommand({
          KeyId: this.keyArn,
          KeySpec: 'AES_256',
          EncryptionContext: this.context(raw),
        }),
      );
      if (
        response.KeyId !== this.keyArn ||
        !(response.Plaintext instanceof Uint8Array) ||
        response.Plaintext.byteLength !== 32 ||
        !(response.CiphertextBlob instanceof Uint8Array) ||
        response.CiphertextBlob.byteLength < 1 ||
        response.CiphertextBlob.byteLength > 6144
      )
        throw refused();
      return {
        key: Buffer.from(response.Plaintext),
        keyArn: this.keyArn,
        wrappedKey: Buffer.from(response.CiphertextBlob).toString('base64'),
      };
    } catch {
      throw refused();
    } finally {
      clear(response);
    }
  }
  async unwrap(wrappedKey: string, raw: DatabaseBackupContext) {
    let response: KeyResponse | undefined;
    try {
      if (typeof wrappedKey !== 'string' || wrappedKey.length > 8192)
        throw refused();
      const blob = Buffer.from(wrappedKey, 'base64');
      if (
        !blob.length ||
        blob.length > 6144 ||
        blob.toString('base64') !== wrappedKey
      )
        throw refused();
      response = await this.request(
        new DecryptCommand({
          KeyId: this.keyArn,
          CiphertextBlob: blob,
          EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          EncryptionContext: this.context(raw),
        }),
      );
      if (
        response.KeyId !== this.keyArn ||
        response.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT' ||
        !(response.Plaintext instanceof Uint8Array) ||
        response.Plaintext.byteLength !== 32
      )
        throw refused();
      return { key: Buffer.from(response.Plaintext), keyArn: this.keyArn };
    } catch {
      throw refused();
    } finally {
      clear(response);
    }
  }
}
