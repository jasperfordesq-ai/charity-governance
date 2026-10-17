/** Bounded explicit-origin storage probe transport. No retry or ambient auth. */
export type StorageProbeBudget = { signal: AbortSignal; requests: number };
type Budget = StorageProbeBudget;
const failure = () =>
  new Error(
    'Storage capability probe is unresolved; preserve the original attempt',
  );
export class BoundedStorageProbeTransport {
  constructor(
    private readonly origin: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    const u = new URL(origin);
    if (
      u.origin !== origin ||
      u.protocol !== 'https:' ||
      u.username ||
      u.password
    )
      throw failure();
  }
  async work<T>(run: (b: Budget) => Promise<T>, caller?: AbortSignal) {
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([caller, controller.signal])
        : controller.signal,
      timer = setTimeout(() => controller.abort(), 180000);
    let stop!: () => void;
    const cancelled = new Promise<never>((_r, reject) => {
      stop = () => reject(failure());
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      signal.throwIfAborted();
      const result = await Promise.race([
        run({ signal, requests: 0 }),
        cancelled,
      ]);
      signal.throwIfAborted();
      return result;
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      controller.abort();
    }
  }
  async request(
    method: 'GET' | 'HEAD' | 'POST' | 'PATCH',
    url: string,
    budget: Budget,
    headers: Record<string, string> = {},
    body?: Buffer,
  ) {
    if (++budget.requests > 32 || new URL(url).origin !== this.origin)
      throw failure();
    const controller = new AbortController(),
      signal = AbortSignal.any([budget.signal, controller.signal]),
      timer = setTimeout(() => controller.abort(), 15000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      stop!: () => void;
    const cancelled = new Promise<never>((_r, reject) => {
      stop = () => {
        void reader?.cancel().catch(() => {});
        reject(failure());
      };
      signal.addEventListener('abort', stop, { once: true });
    });
    const run = async () => {
      const response = await this.transport(url, {
        method,
        redirect: 'error',
        signal,
        headers: {
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache, no-store',
          ...headers,
        },
        ...(body ? { body: new Uint8Array(body) } : {}),
      });
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      const date = Date.parse(response.headers.get('date') ?? '');
      if (!Number.isFinite(date) || Math.abs(Date.now() - date) > 60000) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      const bytes: Buffer[] = [];
      let count = 0;
      try {
        const length = response.headers.get('content-length'),
          encoding = response.headers.get('content-encoding');
        if (
          (encoding && encoding !== 'identity') ||
          (length !== null &&
            (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 32768))
        )
          throw failure();
        if (response.body) {
          reader = response.body.getReader();
          for (;;) {
            signal.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            if (
              !(part.value instanceof Uint8Array) ||
              count + part.value.byteLength > 32768
            )
              throw failure();
            bytes.push(Buffer.from(part.value));
            count += part.value.byteLength;
          }
        }
        if (
          signal.aborted ||
          (method !== 'HEAD' && length !== null && count !== Number(length))
        )
          throw failure();
        return {
          status: response.status,
          headers: response.headers,
          bytes: Buffer.concat(bytes),
          date,
        };
      } finally {
        void reader?.cancel().catch(() => {});
        for (const b of bytes) b.fill(0);
      }
    };
    try {
      signal.throwIfAborted();
      return await Promise.race([run(), cancelled]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      controller.abort();
    }
  }
}
