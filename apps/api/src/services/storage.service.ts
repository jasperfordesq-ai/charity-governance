import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { AppError } from '../utils/errors.js';
import { isConfiguredSecret } from '../utils/env.js';

const STORAGE_UNAVAILABLE_MESSAGE = 'Document storage is temporarily unavailable. Please contact support.';
const STORAGE_OPERATION_FAILED_MESSAGE = 'Document storage operation failed. Please try again later.';
const LOCAL_STORAGE_DRIVER = 'local';
const DEFAULT_LOCAL_STORAGE_DIR = '.charitypilot-local-storage/documents';
const LOCAL_DOWNLOAD_ROUTE = '/api/v1/documents/_local-download';

function getBucketName(): string {
  return process.env.SUPABASE_STORAGE_BUCKET ?? 'documents';
}

function isLocalStorageDriver(): boolean {
  return process.env.DOCUMENT_STORAGE_DRIVER === LOCAL_STORAGE_DRIVER;
}

function getLocalStorageRoot(): string {
  return resolve(process.env.LOCAL_FILE_STORAGE_DIR ?? DEFAULT_LOCAL_STORAGE_DIR);
}

function getPublicApiOrigin(): string {
  const configured = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  const fallback = `http://localhost:${process.env.PORT ?? '3002'}`;

  try {
    return new URL(configured ?? fallback).origin;
  } catch {
    return new URL(fallback).origin;
  }
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

function localFilePath(storagePath: string): string {
  const root = getLocalStorageRoot();
  const filePath = resolve(root, storagePath);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;

  if (filePath !== root && !filePath.startsWith(rootPrefix)) {
    throw new AppError(403, 'STORAGE_PATH_FORBIDDEN', 'Storage path does not belong to local storage');
  }

  return filePath;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

export class StorageService {
  isConfigured(): boolean {
    if (isLocalStorageDriver()) return true;

    return (
      isConfiguredSecret(process.env.SUPABASE_URL) &&
      isConfiguredSecret(process.env.SUPABASE_SERVICE_ROLE_KEY) &&
      isConfiguredSecret(process.env.SUPABASE_STORAGE_BUCKET)
    );
  }

  async verifyBucket(): Promise<boolean> {
    if (isLocalStorageDriver()) {
      try {
        await mkdir(getLocalStorageRoot(), { recursive: true });
        return true;
      } catch {
        return false;
      }
    }

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

    if (isLocalStorageDriver()) {
      const filePath = localFilePath(storagePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, buffer);
      return { storagePath };
    }

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

    if (isLocalStorageDriver()) {
      const url = new URL(LOCAL_DOWNLOAD_ROUTE, getPublicApiOrigin());
      url.searchParams.set('path', guardedPath);
      return url.toString();
    }

    const { data, error } = await getSupabaseClient().storage
      .from(getBucketName())
      .createSignedUrl(guardedPath, expiresIn);

    if (error || !data?.signedUrl) {
      throw new AppError(500, 'STORAGE_SIGNED_URL_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }

    return data.signedUrl;
  }

  async readLocalFile(organisationId: string, storagePath: string): Promise<Buffer> {
    if (!isLocalStorageDriver()) {
      throw new AppError(503, 'STORAGE_NOT_CONFIGURED', STORAGE_UNAVAILABLE_MESSAGE);
    }

    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);
    try {
      return await readFile(localFilePath(guardedPath));
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new AppError(404, 'STORAGE_FILE_NOT_FOUND', 'Document file not found in local storage');
      }
      throw new AppError(500, 'STORAGE_READ_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }
  }

  async deleteFile(organisationId: string, storagePath: string): Promise<void> {
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);

    if (isLocalStorageDriver()) {
      try {
        await unlink(localFilePath(guardedPath));
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw new AppError(500, 'STORAGE_DELETE_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
        }
      }
      return;
    }

    const { error } = await getSupabaseClient().storage.from(getBucketName()).remove([guardedPath]);

    if (error) {
      throw new AppError(500, 'STORAGE_DELETE_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }
  }
}
