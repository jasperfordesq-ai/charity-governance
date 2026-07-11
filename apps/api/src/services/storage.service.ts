import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { AppError } from '../utils/errors.js';
import { isConfiguredSecret } from '../utils/env.js';

const STORAGE_UNAVAILABLE_MESSAGE = 'Document storage is temporarily unavailable. Please contact support.';
const STORAGE_OPERATION_FAILED_MESSAGE = 'Document storage operation failed. Please try again later.';
const LOCAL_STORAGE_DRIVER = 'local';
const DEFAULT_LOCAL_STORAGE_DIR = '.charitypilot-local-storage/documents';
const MAX_DOCUMENT_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_STORAGE_DOWNLOAD_TIMEOUT_MS = 10_000;
const DEFAULT_STORAGE_DELETE_TIMEOUT_MS = 5_000;
const MAX_STORAGE_DELETE_TIMEOUT_MS = 8_000;

function getBucketName(): string {
  return process.env.SUPABASE_STORAGE_BUCKET ?? 'documents';
}

function isLocalStorageDriver(): boolean {
  return process.env.DOCUMENT_STORAGE_DRIVER === LOCAL_STORAGE_DRIVER;
}

function getLocalStorageRoot(): string {
  return resolve(process.env.LOCAL_FILE_STORAGE_DIR ?? DEFAULT_LOCAL_STORAGE_DIR);
}

function readinessTimeoutMs(): number {
  const configured = Number(process.env.STORAGE_READINESS_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : 3000;
}

function downloadTimeoutMs(): number {
  const configured = Number(process.env.STORAGE_DOWNLOAD_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 100 && configured <= 60_000
    ? configured
    : DEFAULT_STORAGE_DOWNLOAD_TIMEOUT_MS;
}

export function storageDeleteTimeoutMs(): number {
  const configured = Number(process.env.STORAGE_DELETE_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 100 && configured <= MAX_STORAGE_DELETE_TIMEOUT_MS
    ? configured
    : DEFAULT_STORAGE_DELETE_TIMEOUT_MS;
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

function timedFetch(timeoutMs: number, operationSignal?: AbortSignal): typeof fetch {
  return (input, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signals = [timeoutSignal, ...(init.signal ? [init.signal] : []), ...(operationSignal ? [operationSignal] : [])];
    const signal = signals.length === 1 ? timeoutSignal : AbortSignal.any(signals);
    return globalThis.fetch(input, { ...init, signal });
  };
}

async function withOperationTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('storage operation timed out')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getSupabaseClient(options: { operationTimeoutMs?: number; operationSignal?: AbortSignal } = {}) {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!isConfiguredSecret(url) || !isConfiguredSecret(serviceRoleKey)) {
    throw new AppError(503, 'STORAGE_NOT_CONFIGURED', STORAGE_UNAVAILABLE_MESSAGE);
  }

  return createClient(
    url,
    serviceRoleKey,
    options.operationTimeoutMs
      ? { global: { fetch: timedFetch(options.operationTimeoutMs, options.operationSignal) } }
      : undefined,
  );
}

function sanitiseFilename(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export function assertOrganisationStoragePath(organisationId: string, storagePath: string): string {
  const normalisedPath = storagePath.replace(/\\/g, '/');
  const expectedPrefix = `${organisationId}/`;
  const segments = normalisedPath.split('/');

  if (
    normalisedPath !== storagePath ||
    normalisedPath.length > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(normalisedPath) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
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
  assertLocalStorageEnabled(): void {
    if (!isLocalStorageDriver()) {
      throw new AppError(503, 'STORAGE_NOT_CONFIGURED', STORAGE_UNAVAILABLE_MESSAGE);
    }
  }

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
    const storagePath = `${organisationId}/${Date.now()}-${randomUUID()}-${sanitised}`;

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

  async readLocalFile(organisationId: string, storagePath: string): Promise<Buffer> {
    this.assertLocalStorageEnabled();
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);
    try {
      const filePath = localFilePath(guardedPath);
      const file = await stat(filePath);
      if (file.size > MAX_DOCUMENT_DOWNLOAD_BYTES) {
        throw new AppError(500, 'STORAGE_DOWNLOAD_TOO_LARGE', STORAGE_OPERATION_FAILED_MESSAGE);
      }
      return await readFile(filePath);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isMissingFileError(error)) {
        throw new AppError(404, 'STORAGE_FILE_NOT_FOUND', 'Document file not found in local storage');
      }
      throw new AppError(500, 'STORAGE_READ_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }
  }

  async downloadFile(organisationId: string, storagePath: string): Promise<Buffer> {
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);

    if (isLocalStorageDriver()) {
      return this.readLocalFile(organisationId, guardedPath);
    }

    const timeoutMs = downloadTimeoutMs();
    try {
      const { data, error } = await withOperationTimeout(
        getSupabaseClient({ operationTimeoutMs: timeoutMs }).storage
          .from(getBucketName())
          .download(guardedPath),
        timeoutMs,
      );
      if (error || !data) {
        throw new AppError(500, 'STORAGE_DOWNLOAD_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
      }
      if (data.size > MAX_DOCUMENT_DOWNLOAD_BYTES) {
        throw new AppError(500, 'STORAGE_DOWNLOAD_TOO_LARGE', STORAGE_OPERATION_FAILED_MESSAGE);
      }
      return Buffer.from(await withOperationTimeout(data.arrayBuffer(), timeoutMs));
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'STORAGE_NOT_CONFIGURED' || error.code === 'STORAGE_DOWNLOAD_TOO_LARGE')
      ) {
        throw error;
      }
      throw new AppError(500, 'STORAGE_DOWNLOAD_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }
  }

  async deleteFile(organisationId: string, storagePath: string, signal?: AbortSignal): Promise<void> {
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);

    if (signal?.aborted) {
      throw new AppError(500, 'STORAGE_DELETE_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }

    if (isLocalStorageDriver()) {
      try {
        await withOperationTimeout(unlink(localFilePath(guardedPath)), storageDeleteTimeoutMs());
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw new AppError(500, 'STORAGE_DELETE_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
        }
      }
      return;
    }

    const timeoutMs = storageDeleteTimeoutMs();
    const { error } = await withOperationTimeout(
      getSupabaseClient({ operationTimeoutMs: timeoutMs, operationSignal: signal })
        .storage
        .from(getBucketName())
        .remove([guardedPath]),
      timeoutMs + 250,
    );

    if (error) {
      throw new AppError(500, 'STORAGE_DELETE_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }
  }
}
