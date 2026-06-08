import { createClient } from '@supabase/supabase-js';
import { AppError } from '../utils/errors.js';
import { isConfiguredSecret } from '../utils/env.js';

const STORAGE_UNAVAILABLE_MESSAGE = 'Document storage is temporarily unavailable. Please contact support.';
const STORAGE_OPERATION_FAILED_MESSAGE = 'Document storage operation failed. Please try again later.';

function getBucketName(): string {
  return process.env.SUPABASE_STORAGE_BUCKET ?? 'documents';
}

function readinessTimeoutMs(): number {
  const configured = Number(process.env.STORAGE_READINESS_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : 3000;
}

export async function withReadinessTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!isConfiguredSecret(url) || !isConfiguredSecret(serviceRoleKey)) {
    throw new AppError(503, 'STORAGE_NOT_CONFIGURED', STORAGE_UNAVAILABLE_MESSAGE);
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
      const result = await withReadinessTimeout(
        getSupabaseClient().storage.getBucket(getBucketName()),
        readinessTimeoutMs(),
      );
      return Boolean(result && !result.error && result.data?.public === false);
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
      throw new AppError(500, 'STORAGE_UPLOAD_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }

    return { storagePath };
  }

  async getSignedUrl(organisationId: string, storagePath: string, expiresIn: number = 3600): Promise<string> {
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);
    const { data, error } = await getSupabaseClient().storage
      .from(getBucketName())
      .createSignedUrl(guardedPath, expiresIn);

    if (error || !data?.signedUrl) {
      throw new AppError(500, 'STORAGE_SIGNED_URL_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }

    return data.signedUrl;
  }

  async deleteFile(organisationId: string, storagePath: string): Promise<void> {
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);
    const { error } = await getSupabaseClient().storage.from(getBucketName()).remove([guardedPath]);

    if (error) {
      throw new AppError(500, 'STORAGE_DELETE_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }
  }
}
