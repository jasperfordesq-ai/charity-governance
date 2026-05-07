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

  async getSignedUrl(storagePath: string, expiresIn: number = 3600): Promise<string> {
    const { data, error } = await getSupabaseClient().storage
      .from(getBucketName())
      .createSignedUrl(storagePath, expiresIn);

    if (error || !data?.signedUrl) {
      throw new AppError(500, 'STORAGE_SIGNED_URL_FAILED', `Failed to generate signed URL: ${error?.message ?? 'unknown error'}`);
    }

    return data.signedUrl;
  }

  async deleteFile(storagePath: string): Promise<void> {
    const { error } = await getSupabaseClient().storage.from(getBucketName()).remove([storagePath]);

    if (error) {
      throw new AppError(500, 'STORAGE_DELETE_FAILED', `Failed to delete file: ${error.message}`);
    }
  }
}
