export const CHUNK_LOAD_RELOAD_STORAGE_KEY = 'charitypilot:chunk-load-reload-attempted';

export type ChunkLoadReloadStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const RECOVERABLE_CHUNK_ERROR_PATTERNS = [
  /chunkloaderror/i,
  /loading chunk[\s\S]*failed/i,
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
];

function readStringProperty(value: Record<string, unknown>, key: string): string {
  const property = value[key];

  return typeof property === 'string' ? property : '';
}

function describeError(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return [error.name, error.message, error.stack].filter(Boolean).join(' ');
  }

  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;

    return [
      readStringProperty(record, 'name'),
      readStringProperty(record, 'message'),
      readStringProperty(record, 'stack'),
      readStringProperty(record, 'type'),
    ]
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

export function isRecoverableChunkLoadError(error: unknown): boolean {
  const description = describeError(error);

  return RECOVERABLE_CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(description));
}

export function shouldAttemptChunkLoadReload(error: unknown, storage: ChunkLoadReloadStorage): boolean {
  if (!isRecoverableChunkLoadError(error)) {
    return false;
  }

  try {
    if (storage.getItem(CHUNK_LOAD_RELOAD_STORAGE_KEY) === 'true') {
      return false;
    }

    storage.setItem(CHUNK_LOAD_RELOAD_STORAGE_KEY, 'true');
    return true;
  } catch {
    return false;
  }
}

export function clearChunkLoadReloadAttempt(storage: ChunkLoadReloadStorage): void {
  try {
    storage.removeItem(CHUNK_LOAD_RELOAD_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in hardened browser modes.
  }
}
