import { createClient } from '@supabase/supabase-js';
import { AppError } from '../utils/errors.js';
import { isConfiguredSecret } from '../utils/env.js';

function getBucketName(): string {
  return process.env.SUPABASE_STORAGE_BUCKET ?? 'documents';
}

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!isConfiguredSecret(url) || !isConfiguredSecret(serviceRoleKey)) {
    throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'Supabase storage is not configured');
  }

  return createClient(url, serviceRoleKey);
}

function sanitiseFilename(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function assertOrganisationStoragePath(organisationId: string, storagePath: string): string {
  const normalisedPath = storagePath.replace(/\\/g, '/');
  const expectedPrefix = `${organisationId}/`;

  if (
    normalisedPath !== storagePath ||
    normalisedPath.includes('..') ||
    !normalisedPath.startsWith(expectedPrefix) ||
    normalisedPath.length <= expectedPrefix.length
  ) {
    throw new AppError(403, 'STORAGE_PATH_FORBIDDEN', 'Storage path does not belong to this organisation');
  }

  return normalisedPath;
}

export class StorageService {
  isConfigured(): boolean {
    return (
      isConfiguredSecret(process.env.SUPABASE_URL) &&
      isConfiguredSecret(process.env.SUPABASE_SERVICE_ROLE_KEY) &&
      isConfiguredSecret(process.env.SUPABASE_STORAGE_BUCKET)
    );
  }

  async verifyBucket(): Promise<boolean> {
    if (!this.isConfigured()) return false;

    try {
      const { data, error } = await getSupabaseClient().storage.getBucket(getBucketName());
      return !error && Boolean(data);
    } catch {
      return false;
    }
  }

  async uploadFile(
    organisationId: string,
    filename: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ storagePath: string }> {
    const sanitised = sanitiseFilename(filename);
    const storagePath = `${organisationId}/${Date.now()}-${sanitised}`;
    const supabase = getSupabaseClient();

    const { error } = await supabase.storage
      .from(getBucketName())
      .upload(storagePath, buffer, { contentType: mimeType, upsert: false });

    if (error) {
      throw new AppError(500, 'STORAGE_UPLOAD_FAILED', `Failed to upload file: ${error.message}`);
    }

    return { storagePath };
  }

  async getSignedUrl(organisationId: string, storagePath: string, expiresIn: number = 3600): Promise<string> {
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);
    const { data, error } = await getSupabaseClient().storage
      .from(getBucketName())
      .createSignedUrl(guardedPath, expiresIn);

    if (error || !data?.signedUrl) {
      throw new AppError(500, 'STORAGE_SIGNED_URL_FAILED', `Failed to generate signed URL: ${error?.message ?? 'unknown error'}`);
    }

    return data.signedUrl;
  }

  async deleteFile(organisationId: string, storagePath: string): Promise<void> {
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);
    const { error } = await getSupabaseClient().storage.from(getBucketName()).remove([guardedPath]);

    if (error) {
      throw new AppError(500, 'STORAGE_DELETE_FAILED', `Failed to delete file: ${error.message}`);
    }
  }
}
