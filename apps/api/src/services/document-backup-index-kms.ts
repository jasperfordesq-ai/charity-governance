import { type KMSClient, type KMSClientConfig } from '@aws-sdk/client-kms';
import type { DocumentBackupIndexMac } from './document-backup-index.js';
import { KmsBackupManifestMac } from './backup-manifest-kms.js';

export class KmsDocumentBackupIndexMac
  extends KmsBackupManifestMac
  implements DocumentBackupIndexMac
{
  constructor(
    keyArn: string,
    credentials: NonNullable<KMSClientConfig['credentials']>,
    client?: KMSClient,
  ) {
    super(keyArn, 'DOCUMENT_BACKUP_INDEX_V1', credentials, client);
  }
}
