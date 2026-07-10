export type ComplianceAutosavePhase =
  | 'idle'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'error'
  | 'conflict';

export type ComplianceRevisionConflict = {
  expectedRevision: number;
  currentRevision: number;
};

export type ComplianceAutosaveResult = {
  revision: number;
};

export type ComplianceAutosaveFlushOutcome =
  | { status: 'saved'; revision: number }
  | { status: 'error'; revision: number }
  | { status: 'conflict'; revision: number; conflict: ComplianceRevisionConflict }
  | { status: 'disposed'; revision: number };

export type ComplianceAutosaveSnapshot<T> = {
  phase: ComplianceAutosavePhase;
  revision: number;
  localGeneration: number;
  durableGeneration: number;
  hasQueuedSave: boolean;
  hasInFlightSave: boolean;
  localDraft: T | null;
  conflict: ComplianceRevisionConflict | null;
};

type QueuedSave<T> = {
  generation: number;
  data: T;
};

type InFlightSave<T> = QueuedSave<T> & {
  expectedRevision: number;
};

type QueueOptions<T> = {
  initialRevision: number;
  save: (data: T, expectedRevision: number) => Promise<ComplianceAutosaveResult>;
  parseConflict: (error: unknown) => ComplianceRevisionConflict | null;
  onStateChange?: (snapshot: ComplianceAutosaveSnapshot<T>) => void;
  onError?: (error: unknown) => void;
};

type FlushWaiter = (outcome: ComplianceAutosaveFlushOutcome) => void;

function validRevision(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * A framework-free, per-record autosave coordinator.
 *
 * It deliberately permits only one request at a time. Edits made while a save
 * is active replace the queued full-record draft, so the active response can
 * never clear or report durability for a newer local generation.
 */
export class ComplianceAutosaveQueue<T> {
  private revision: number;
  private phase: ComplianceAutosavePhase = 'idle';
  private localGeneration = 0;
  private durableGeneration = 0;
  private queued: QueuedSave<T> | null = null;
  private inFlight: InFlightSave<T> | null = null;
  private failed: InFlightSave<T> | null = null;
  private conflict: ComplianceRevisionConflict | null = null;
  private disposed = false;
  private readonly waiters = new Set<FlushWaiter>();

  constructor(private readonly options: QueueOptions<T>) {
    if (!validRevision(options.initialRevision)) {
      throw new Error('Compliance autosave initial revision must be a non-negative integer');
    }
    this.revision = options.initialRevision;
  }

  getSnapshot(): ComplianceAutosaveSnapshot<T> {
    return {
      phase: this.phase,
      revision: this.revision,
      localGeneration: this.localGeneration,
      durableGeneration: this.durableGeneration,
      hasQueuedSave: this.queued !== null,
      hasInFlightSave: this.inFlight !== null,
      localDraft: this.queued?.data ?? this.failed?.data ?? this.inFlight?.data ?? null,
      conflict: this.conflict,
    };
  }

  hasUnsettledChanges(): boolean {
    return (
      !this.disposed &&
      (this.queued !== null ||
        this.inFlight !== null ||
        this.failed !== null ||
        this.phase === 'dirty' ||
        this.phase === 'error' ||
        this.phase === 'conflict')
    );
  }

  enqueue(data: T): number {
    if (this.disposed) return this.localGeneration;

    const generation = ++this.localGeneration;
    this.queued = { generation, data };

    // A conflict is intentionally sticky. Further edits remain in the local
    // draft, but no request may overwrite the newer server revision until the
    // user explicitly reconciles it.
    if (this.phase !== 'conflict' && this.phase !== 'error') {
      this.phase = this.inFlight ? 'saving' : 'dirty';
    }

    this.emit();
    return generation;
  }

  flush(): Promise<ComplianceAutosaveFlushOutcome> {
    if (this.disposed) {
      return Promise.resolve({ status: 'disposed', revision: this.revision });
    }
    if (this.phase === 'conflict' && this.conflict) {
      return Promise.resolve({ status: 'conflict', revision: this.revision, conflict: this.conflict });
    }
    if (this.phase === 'error') {
      return Promise.resolve({ status: 'error', revision: this.revision });
    }
    if (!this.queued && !this.inFlight) {
      return Promise.resolve({ status: 'saved', revision: this.revision });
    }

    const outcome = new Promise<ComplianceAutosaveFlushOutcome>((resolve) => {
      this.waiters.add(resolve);
    });
    this.drain();
    return outcome;
  }

  retry(): Promise<ComplianceAutosaveFlushOutcome> {
    if (this.disposed) {
      return Promise.resolve({ status: 'disposed', revision: this.revision });
    }
    if (this.phase === 'conflict' && this.conflict) {
      return Promise.resolve({ status: 'conflict', revision: this.revision, conflict: this.conflict });
    }
    if (this.phase === 'error') {
      const failed = this.failed;
      if (!failed) {
        this.phase = this.queued ? 'dirty' : 'idle';
        this.emit();
        return this.flush();
      }

      this.failed = null;
      this.inFlight = failed;
      this.phase = 'saving';
      this.emit();
      const outcome = new Promise<ComplianceAutosaveFlushOutcome>((resolve) => {
        this.waiters.add(resolve);
      });
      this.performSave(failed);
      return outcome;
    }
    return this.flush();
  }

  discardQueuedChanges(): void {
    if (this.disposed) return;

    this.queued = null;
    this.failed = null;
    this.conflict = null;
    this.phase = this.inFlight ? 'saving' : this.durableGeneration > 0 ? 'saved' : 'idle';
    this.emit();

    if (!this.inFlight) {
      this.settleWaiters({ status: 'saved', revision: this.revision });
    }
  }

  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.queued = null;
    this.failed = null;
    this.conflict = null;
    this.settleWaiters({ status: 'disposed', revision: this.revision });
  }

  private drain(): void {
    if (
      this.disposed ||
      this.inFlight ||
      this.failed ||
      !this.queued ||
      this.phase === 'conflict' ||
      this.phase === 'error'
    ) {
      return;
    }

    const next = this.queued;
    this.queued = null;
    const request: InFlightSave<T> = {
      ...next,
      expectedRevision: this.revision,
    };
    this.inFlight = request;
    this.phase = 'saving';
    this.emit();

    this.performSave(request);
  }

  private performSave(request: InFlightSave<T>): void {
    let result: Promise<ComplianceAutosaveResult>;
    try {
      result = this.options.save(request.data, request.expectedRevision);
    } catch (error) {
      this.handleFailure(request, error);
      return;
    }
    void result.then(
      (saveResult) => this.handleSuccess(request, saveResult),
      (error: unknown) => this.handleFailure(request, error),
    );
  }

  private handleSuccess(request: InFlightSave<T>, result: ComplianceAutosaveResult): void {
    if (this.disposed || this.inFlight !== request) return;
    // The API intentionally returns the current revision for an exact no-op or
    // an idempotent replay. That request is durable even though no revision was
    // incremented; only a revision moving backwards is invalid.
    if (!validRevision(result.revision) || result.revision < request.expectedRevision) {
      this.handleFailure(request, new Error('Compliance autosave returned an invalid revision'));
      return;
    }

    this.inFlight = null;
    this.revision = result.revision;
    this.durableGeneration = Math.max(this.durableGeneration, request.generation);
    this.failed = null;

    if (this.queued) {
      // The response only acknowledged request.generation. A newer draft is
      // still pending, so never emit Saved for the older generation.
      this.phase = 'dirty';
      this.emit();
      this.drain();
      return;
    }

    this.phase = 'saved';
    this.emit();
    this.settleWaiters({ status: 'saved', revision: this.revision });
  }

  private handleFailure(request: InFlightSave<T>, error: unknown): void {
    if (this.disposed || this.inFlight !== request) return;

    this.inFlight = null;
    const conflict = this.options.parseConflict(error);
    if (conflict) {
      if (!this.queued || this.queued.generation < request.generation) {
        this.queued = { generation: request.generation, data: request.data };
      }
      this.failed = null;
      this.conflict = conflict;
      this.phase = 'conflict';
      this.emit();
      this.settleWaiters({ status: 'conflict', revision: this.revision, conflict });
      return;
    }

    // Keep the exact uncertain request ahead of any newer coalesced draft.
    // Retrying it with the same expected revision lets the API recognise an
    // already-committed identical result before the queue advances the draft.
    this.failed = request;
    this.options.onError?.(error);
    this.phase = 'error';
    this.emit();
    this.settleWaiters({ status: 'error', revision: this.revision });
  }

  private emit(): void {
    if (!this.disposed) {
      this.options.onStateChange?.(this.getSnapshot());
    }
  }

  private settleWaiters(outcome: ComplianceAutosaveFlushOutcome): void {
    for (const resolve of this.waiters) resolve(outcome);
    this.waiters.clear();
  }
}
