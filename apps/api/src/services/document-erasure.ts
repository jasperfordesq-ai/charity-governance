/**
 * Provider-keyed erasure dispatch for the document-deletion pipeline.
 *
 * The pipeline exists so that erasure is *provable*: a row is only marked
 * PROCESSED once the bytes it names are gone. A single hardcoded deleter could
 * only ever prove that for one backend, so deletion is dispatched on the
 * provider the row was stamped with when it was enqueued.
 *
 * A provider with no registered eraser is not a transient failure. This
 * deployment cannot erase those bytes at all, and the caller dead-letters the
 * row rather than retrying — see `PROVIDER_NOT_ERASABLE` in document.service.ts.
 */

export type ErasureTarget = {
  organisationId: string;
  /**
   * The Supabase object path. Meaningful only for providers that address their
   * objects that way; any other provider must read `targetRef` instead and must
   * never fall back to this field.
   */
  storagePath: string;
  targetRef: unknown | null;
};

export type Eraser = (target: ErasureTarget, signal?: AbortSignal) => Promise<void>;

export type ErasureDispatcher = (provider: string) => Eraser | undefined;

export function createSupabaseEraser(
  deleteFile: (organisationId: string, storagePath: string, signal?: AbortSignal) => Promise<void>,
): Eraser {
  return (target, signal) => deleteFile(target.organisationId, target.storagePath, signal);
}

export function createErasureDispatcher(erasers: Record<string, Eraser>): ErasureDispatcher {
  return (provider) =>
    // A bare `erasers[provider]` lookup resolves Object.prototype members, so a
    // row stamped 'constructor' or 'toString' would hand the worker a function
    // that is not an eraser, and the pipeline would report a deletion it never
    // performed. Only own properties count as registered erasers.
    Object.prototype.hasOwnProperty.call(erasers, provider) ? erasers[provider] : undefined;
}
