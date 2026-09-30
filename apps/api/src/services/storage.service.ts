import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { AppError } from '../utils/errors.js';
import { isConfiguredSecret } from '../utils/env.js';
import {
  resolveProviderForOrganisation,
  type OrganisationStorageResolver,
  type ResolveProviderOptions,
} from './document-storage-resolution.js';

const STORAGE_UNAVAILABLE_MESSAGE = 'Document storage is temporarily unavailable. Please contact support.';
const STORAGE_OPERATION_FAILED_MESSAGE = 'Document storage operation failed. Please try again later.';
const LOCAL_STORAGE_DRIVER = 'local';
const SUPABASE_STORAGE_DRIVER = 'supabase';
const DEFAULT_LOCAL_STORAGE_DIR = '.charitypilot-local-storage/documents';
const MAX_DOCUMENT_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_STORAGE_UPLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_STORAGE_UPLOAD_TIMEOUT_MS = 30 * 60_000;
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

function uploadTimeoutMs(): number {
  const configured = Number(process.env.STORAGE_UPLOAD_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 100 && configured <= MAX_STORAGE_UPLOAD_TIMEOUT_MS
    ? configured
    : DEFAULT_STORAGE_UPLOAD_TIMEOUT_MS;
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
  /**
   * `resolver` is optional and defaults to null, which means "use the
   * deployment default for every organisation" — exactly the behaviour every
   * call site had before per-tenant storage existed. Do not make it required:
   * the health probe and the existing tests rely on the zero-argument form.
   */
  constructor(private readonly resolver: OrganisationStorageResolver | null = null) {}

  private async providerFor(
    organisationId: string,
    operation: NonNullable<ResolveProviderOptions['operation']>,
  ): Promise<string> {
    try {
      return await resolveProviderForOrganisation(organisationId, this.resolver, undefined, { operation });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(500, 'STORAGE_PROVIDER_RESOLUTION_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }
  }

  /**
   * The bytes this service can actually act on.
   *
   * `read` and `delete` resolve a provider without the registry's unknown and
   * alpha checks, deliberately: bytes that already exist must stay readable and
   * erasable even if the deployment would refuse to *choose* that provider
   * today (see `ResolveProviderOptions.operation`). That exemption is only safe
   * while this service refuses to guess. Treating "not local" as "Supabase"
   * would send a Confluence-backed organisation's erasure to the Supabase
   * bucket, where removing an object that was never there reports success — and
   * the deletion pipeline would record a *successful erasure of something never
   * erased*. A false erasure proof is worse than a failed erasure.
   *
   * So anything this service has no backend for fails loudly. The deletion
   * pipeline records the failure, retries it, dead-letters it and alerts an
   * operator; a provider-aware dispatcher routes such rows away from here
   * before they ever reach this guard.
   */
  private assertProviderServable(provider: string, code: string): void {
    if (provider === LOCAL_STORAGE_DRIVER || provider === SUPABASE_STORAGE_DRIVER) return;
    throw new AppError(500, code, STORAGE_OPERATION_FAILED_MESSAGE);
  }

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
    beforeWrite?: (prepared: { storagePath: string; provider: string }) => Promise<void>,
  ): Promise<{ storagePath: string; provider?: string }> {
    const sanitised = sanitiseFilename(filename);
    const storagePath = `${organisationId}/${Date.now()}-${randomUUID()}-${sanitised}`;
    const provider = await this.providerFor(organisationId, 'write');
    this.assertProviderServable(provider, 'STORAGE_UPLOAD_PROVIDER_UNSUPPORTED');
    // Fail before reserving an object key when the selected remote backend
    // cannot even be constructed from this deployment's configuration.
    const timeoutMs = uploadTimeoutMs();
    const supabase = provider === LOCAL_STORAGE_DRIVER ? null : getSupabaseClient({ operationTimeoutMs: timeoutMs });

    // The caller can durably reserve this exact key/provider before any bytes
    // are written. If reservation fails, there is no object to reconcile.
    await beforeWrite?.({ storagePath, provider });

    // Keep every provider write bounded well inside the one-hour reservation
    // reconciliation window. A stalled upload must not still be writing when
    // the cleanup worker considers its reserved path orphaned.
    if (provider === LOCAL_STORAGE_DRIVER) {
      const filePath = localFilePath(storagePath);
      await mkdir(dirname(filePath), { recursive: true });
      await withOperationTimeout(writeFile(filePath, buffer, { signal: AbortSignal.timeout(timeoutMs) }), timeoutMs);
      return { storagePath, provider };
    }

    try {
      const { error } = await withOperationTimeout(supabase!.storage
        .from(getBucketName())
        .upload(storagePath, buffer, { contentType: mimeType, upsert: false }), timeoutMs);
      if (!error) return { storagePath, provider };
    } catch {
      // A timeout or transport exception has the same externally safe result
      // as a provider error; the durable reservation handles uncertain bytes.
    }
    throw new AppError(500, 'STORAGE_UPLOAD_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
  }

  private async readLocalResolved(guardedPath: string): Promise<Buffer> {
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

  /**
   * DEPLOYMENT-SCOPED, like `isConfigured()` and `verifyBucket()`. It opens
   * with `assertLocalStorageEnabled()`, which asks whether the *deployment*
   * driver is local — the wrong question in a per-tenant world: for an
   * organisation pinned to local storage on a Supabase-default deployment this
   * throws 503 even though that organisation's bytes are on local disk.
   *
   * Do not call it from any per-tenant path. Those go through `downloadFile`,
   * which resolves the provider for the organisation and then uses
   * `readLocalResolved`. No production code calls this; it is retained because
   * the tenant-isolation tests exercise the guard through it.
   */
  async readLocalFile(organisationId: string, storagePath: string): Promise<Buffer> {
    this.assertLocalStorageEnabled();
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);
    return this.readLocalResolved(guardedPath);
  }

  async downloadFile(organisationId: string, storagePath: string, uploadedProvider?: string): Promise<Buffer> {
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);

    const readProvider = uploadedProvider ?? await this.providerFor(organisationId, 'read');
    if (readProvider === LOCAL_STORAGE_DRIVER) {
      return this.readLocalResolved(guardedPath);
    }
    // Before the try: the catch below rewrites everything it does not
    // recognise into STORAGE_DOWNLOAD_FAILED, which would disguise this.
    this.assertProviderServable(readProvider, 'STORAGE_DOWNLOAD_PROVIDER_UNSUPPORTED');

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

  /** Read-only custody check for a legacy Vault key. An unavailable provider
   * is an error, never evidence that its object is absent. */
  async inspectActiveObject(
    organisationId: string,
    storagePath: string,
    provider: 'local' | 'supabase',
  ): Promise<{ present: boolean; size: number | null }> {
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);
    if (provider === LOCAL_STORAGE_DRIVER) {
      try {
        const file = await withOperationTimeout(stat(localFilePath(guardedPath)), downloadTimeoutMs());
        if (!file.isFile()) throw new AppError(409, 'STORAGE_CUSTODY_NOT_FILE', 'Storage object is not a file');
        return { present: true, size: file.size };
      } catch (error) {
        if (isMissingFileError(error)) return { present: false, size: null };
        if (error instanceof AppError) throw error;
        throw new AppError(503, 'STORAGE_CUSTODY_CHECK_UNAVAILABLE', STORAGE_UNAVAILABLE_MESSAGE);
      }
    }

    const timeoutMs = downloadTimeoutMs();
    let result: { data: boolean; error: { status?: number } | null };
    try {
      result = await withOperationTimeout(
        getSupabaseClient({ operationTimeoutMs: timeoutMs }).storage.from(getBucketName()).exists(guardedPath),
        timeoutMs + 250,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'STORAGE_CUSTODY_CHECK_UNAVAILABLE', STORAGE_UNAVAILABLE_MESSAGE);
    }
    if (result.data === false && result.error?.status === 404) return { present: false, size: null };
    if (result.data !== true || result.error) {
      throw new AppError(503, 'STORAGE_CUSTODY_CHECK_UNAVAILABLE', STORAGE_UNAVAILABLE_MESSAGE);
    }
    const bytes = await this.downloadFile(organisationId, guardedPath, SUPABASE_STORAGE_DRIVER);
    return { present: true, size: bytes.length };
  }

  async deleteFile(
    organisationId: string,
    storagePath: string,
    signal?: AbortSignal,
    uploadedProvider?: string,
  ): Promise<Date> {
    const guardedPath = assertOrganisationStoragePath(organisationId, storagePath);

    if (signal?.aborted) {
      throw new AppError(500, 'STORAGE_DELETE_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }

    // A failed document create has an upload receipt with the exact provider
    // used for those bytes. Its cleanup must not follow a changed tenant
    // preference and accidentally verify absence at another provider.
    const provider = uploadedProvider ?? await this.providerFor(organisationId, 'delete');

    if (signal?.aborted) {
      throw new AppError(500, 'STORAGE_DELETE_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
    }

    if (provider === LOCAL_STORAGE_DRIVER) {
      const filePath = localFilePath(guardedPath);
      try {
        await withOperationTimeout(unlink(filePath), storageDeleteTimeoutMs());
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw new AppError(500, 'STORAGE_DELETE_FAILED', STORAGE_OPERATION_FAILED_MESSAGE);
        }
      }
      // A successful unlink call is not itself an absence check. Do not let
      // the outbox say PROCESSED if the active local path still exists.
      try {
        await withOperationTimeout(stat(filePath), storageDeleteTimeoutMs());
        throw new AppError(500, 'STORAGE_DELETE_UNVERIFIED', STORAGE_OPERATION_FAILED_MESSAGE);
      } catch (error) {
        if (!isMissingFileError(error)) {
          if (error instanceof AppError) throw error;
          throw new AppError(500, 'STORAGE_DELETE_UNVERIFIED', STORAGE_OPERATION_FAILED_MESSAGE);
        }
      }
      return new Date();
    }

    this.assertProviderServable(provider, 'STORAGE_DELETE_PROVIDER_UNSUPPORTED');

    const timeoutMs = storageDeleteTimeoutMs();
    const startedAt = Date.now();
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

    // The remove API can acknowledge a request before absence is observable.
    // A 400, transport failure or auth error must not be mistaken for "missing";
    // this SDK's exists() returns false with a 404 StorageError for an absent
    // active object. Versioned copies and backups need separate evidence.
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    let absence: { data: boolean; error: { status?: number } | null };
    try {
      absence = await withOperationTimeout(
        getSupabaseClient({ operationTimeoutMs: remainingMs, operationSignal: signal })
          .storage.from(getBucketName()).exists(guardedPath),
        remainingMs + 250,
      );
    } catch {
      throw new AppError(500, 'STORAGE_DELETE_UNVERIFIED', STORAGE_OPERATION_FAILED_MESSAGE);
    }
    if (absence.data !== false || absence.error?.status !== 404) {
      throw new AppError(500, 'STORAGE_DELETE_UNVERIFIED', STORAGE_OPERATION_FAILED_MESSAGE);
    }
    return new Date();
  }
}
