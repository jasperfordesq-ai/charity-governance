import { createClient } from '@supabase/supabase-js';
import { AppError } from '../utils/errors.js';

const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
);

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'documents';

function sanitiseFilename(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export class StorageService {
  async uploadFile(
    organisationId: string,
    filename: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ fileUrl: string; storagePath: string }> {
    const sanitised = sanitiseFilename(filename);
    const storagePath = `${organisationId}/${Date.now()}-${sanitised}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, buffer, { contentType: mimeType, upsert: false });

    if (error) {
      throw new AppError(500, 'STORAGE_UPLOAD_FAILED', `Failed to upload file: ${error.message}`);
    }

    const { data: publicData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    const fileUrl = publicData.publicUrl;

    return { fileUrl, storagePath };
  }

  async getSignedUrl(storagePath: string, expiresIn: number = 3600): Promise<string> {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, expiresIn);

    if (error || !data?.signedUrl) {
      throw new AppError(500, 'STORAGE_SIGNED_URL_FAILED', `Failed to generate signed URL: ${error?.message ?? 'unknown error'}`);
    }

    return data.signedUrl;
  }

  async deleteFile(storagePath: string): Promise<void> {
    const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);

    if (error) {
      throw new AppError(500, 'STORAGE_DELETE_FAILED', `Failed to delete file: ${error.message}`);
    }
  }
}
