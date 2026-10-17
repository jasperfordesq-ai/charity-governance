import { createHash, createPublicKey } from 'node:crypto';
import { z } from 'zod';
const failure = () =>
  new Error(
    'Supabase signing-key maintenance is unresolved; preserve the original attempt without retrying revocation',
  );
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const algorithm = z.enum(['ES256', 'RS256', 'HS256']);
const sha = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .length(64);
const reviewedKey = z
  .object({
    id: uuid,
    algorithm,
    fingerprint: sha.nullable(),
    disposition: z.enum([
      'RETAIN_CURRENT',
      'REVOKE_PREVIOUS',
      'ALREADY_REVOKED',
    ]),
  })
  .strict();
const configuration = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    projectRef: z
      .string()
      .regex(/^[a-z0-9]{20}$/)
      .length(20),
    organisationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    region: z.enum(['eu-west-1', 'eu-central-1']),
    keys: z.array(reviewedKey).min(2).max(32),
  })
  .strict()
  .refine((c) => {
    const current = c.keys.filter((k) => k.disposition === 'RETAIN_CURRENT'),
      fingerprints = c.keys.flatMap((k) =>
        k.fingerprint ? [k.fingerprint] : [],
      );
    return (
      new Set(c.keys.map((k) => k.id)).size === c.keys.length &&
      new Set(fingerprints).size === fingerprints.length &&
      current.length === 1 &&
      current[0].algorithm !== 'HS256' &&
      c.keys.some((k) => k.disposition === 'REVOKE_PREVIOUS') &&
      c.keys.every(
        (k) => (k.algorithm === 'HS256') === (k.fingerprint === null),
      )
    );
  });
const base64 = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((v) => Buffer.from(v, 'base64url').toString('base64url') === v);
const publicMetadata = {
  kid: z.string().min(1).max(128).optional(),
  alg: z.string().max(16).optional(),
  use: z.literal('sig').optional(),
  key_ops: z.array(z.literal('verify')).min(1).max(1).optional(),
  ext: z.boolean().optional(),
};
/** RFC7638 public-material fingerprint, never a private/symmetric key export. */
export function publicSigningKeyFingerprint(
  kind: unknown,
  raw: unknown,
): string | null {
  const a = algorithm.parse(kind);
  if (a === 'HS256') {
    if (raw !== null) throw failure();
    return null;
  }
  if (a === 'ES256') {
    const k = z
      .object({
        ...publicMetadata,
        kty: z.literal('EC'),
        crv: z.literal('P-256'),
        x: base64,
        y: base64,
      })
      .strict()
      .parse(raw);
    if (
      (k.alg !== undefined && k.alg !== a) ||
      Buffer.from(k.x, 'base64url').length !== 32 ||
      Buffer.from(k.y, 'base64url').length !== 32
    )
      throw failure();
    const actual = createPublicKey({ key: k, format: 'jwk' });
    if (
      actual.asymmetricKeyType !== 'ec' ||
      actual.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    )
      throw failure();
    return hash({ crv: k.crv, kty: k.kty, x: k.x, y: k.y });
  }
  const k = z
    .object({ ...publicMetadata, kty: z.literal('RSA'), e: base64, n: base64 })
    .strict()
    .parse(raw);
  if (k.alg !== undefined && k.alg !== a) throw failure();
  const actual = createPublicKey({ key: k, format: 'jwk' }),
    bits = actual.asymmetricKeyDetails?.modulusLength ?? 0;
  if (
    actual.asymmetricKeyType !== 'rsa' ||
    bits < 2048 ||
    bits > 4096 ||
    actual.asymmetricKeyDetails?.publicExponent !== 65537n
  )
    throw failure();
  return hash({ e: k.e, kty: k.kty, n: k.n });
}
const providerKey = z
  .object({
    id: uuid,
    algorithm,
    status: z.enum(['in_use', 'previously_used', 'revoked', 'standby']),
    public_jwk: z.unknown().refine((v) => v !== undefined),
    created_at: z.string().max(80).datetime({ offset: true }),
    updated_at: z.string().max(80).datetime({ offset: true }),
  })
  .strict();
type Budget = { signal: AbortSignal; requests: number };
type KeyState = {
  id: string;
  algorithm: z.infer<typeof algorithm>;
  fingerprint: string | null;
  status: z.infer<typeof providerKey>['status'];
};

/** Reviewed metadata-state revocation only. No key creation, promotion, deletion,
 * legacy-secret export, API-key rotation or automatic retry. The parent must
 * acquire a durable guard and retain capability evidence before activation. */
export class SupabaseSigningKeyControl {
  private readonly config: z.infer<typeof configuration>;
  private attempted = false;
  constructor(
    raw: unknown,
    private readonly token: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.config = configuration.parse(raw);
    this.config.keys.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (
      typeof token !== 'string' ||
      !token ||
      token.length > 4096 ||
      token !== token.trim() ||
      /[\x00-\x20\x7f]/.test(token)
    )
      throw failure();
  }
  configurationDigest(installationId = this.config.installationId) {
    if (installationId !== this.config.installationId) throw failure();
    return hash({
      format: 1,
      policy: 'REVOKE_REVIEWED_PREVIOUS_SIGNING_KEYS_V1',
      ...this.config,
    });
  }
  private async work<T>(run: (budget: Budget) => Promise<T>) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 180000);
    try {
      const result = await run({ signal: controller.signal, requests: 0 });
      controller.signal.throwIfAborted();
      return result;
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  private async request(
    suffix: string,
    method: 'GET' | 'PATCH',
    budget: Budget,
    body?: object,
  ) {
    if (++budget.requests > 128) throw failure();
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, budget.signal]),
      timer = setTimeout(() => controller.abort(), 10000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      stop!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => {
        void reader?.cancel().catch(() => {});
        reject(failure());
      };
      signal.addEventListener('abort', stop, { once: true });
    });
    const run = async () => {
      const response = await this.transport(
        'https://api.supabase.com/v1/projects/' +
          this.config.projectRef +
          suffix,
        {
          method,
          signal,
          redirect: 'error',
          headers: {
            Authorization: 'Bearer ' + this.token,
            Accept: 'application/json',
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache, no-store',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      if (signal.aborted || response.status !== 200 || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      reader = response.body.getReader();
      const bytes = Buffer.alloc(256 * 1024);
      let count = 0;
      try {
        const length = response.headers.get('content-length'),
          encoding = response.headers.get('content-encoding');
        if (
          (encoding && encoding !== 'identity') ||
          response.headers
            .get('content-type')
            ?.split(';')[0]
            .trim()
            .toLowerCase() !== 'application/json' ||
          (length !== null &&
            (!/^(0|[1-9][0-9]*)$/.test(length) ||
              Number(length) > bytes.length))
        )
          throw failure();
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          if (
            !(next.value instanceof Uint8Array) ||
            count + next.value.byteLength > bytes.length
          )
            throw failure();
          bytes.set(next.value, count);
          count += next.value.byteLength;
        }
        if (signal.aborted || (length !== null && Number(length) !== count))
          throw failure();
        return JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            bytes.subarray(0, count),
          ),
        ) as unknown;
      } finally {
        bytes.fill(0);
      }
    };
    try {
      signal.throwIfAborted();
      return await Promise.race([run(), cancelled]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      void reader?.cancel().catch(() => {});
      controller.abort();
    }
  }
  private projectRow(raw: unknown) {
    const p = z
        .object({
          ref: z.string(),
          organization_id: z.string(),
          region: z.string(),
          status: z.literal('ACTIVE_HEALTHY'),
        })
        .parse(raw),
      c = this.config;
    if (
      p.ref !== c.projectRef ||
      p.organization_id !== c.organisationId ||
      p.region !== c.region
    )
      throw failure();
  }
  private keyRow(raw: unknown): KeyState {
    const k = providerKey.parse(raw),
      fingerprint = publicSigningKeyFingerprint(k.algorithm, k.public_jwk);
    if (
      k.public_jwk !== null &&
      typeof k.public_jwk === 'object' &&
      'kid' in k.public_jwk &&
      k.public_jwk.kid !== k.id
    )
      throw failure();
    return { id: k.id, algorithm: k.algorithm, fingerprint, status: k.status };
  }
  private async snapshot(budget: Budget) {
    this.projectRow(await this.request('', 'GET', budget));
    const raw = z
      .object({ keys: z.array(z.unknown()).min(2).max(32) })
      .strict()
      .parse(await this.request('/config/auth/signing-keys', 'GET', budget));
    const keys = raw.keys
      .map((k) => this.keyRow(k))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (
      new Set(keys.map((k) => k.id)).size !== keys.length ||
      keys.length !== this.config.keys.length ||
      keys.some(
        (k, i) =>
          k.id !== this.config.keys[i].id ||
          k.algorithm !== this.config.keys[i].algorithm ||
          k.fingerprint !== this.config.keys[i].fingerprint,
      )
    )
      throw failure();
    return keys;
  }
  private assertStatuses(keys: KeyState[], closed: Set<string>) {
    if (
      keys.some(
        (k, i) =>
          k.status !==
          (this.config.keys[i].disposition === 'RETAIN_CURRENT'
            ? 'in_use'
            : this.config.keys[i].disposition === 'ALREADY_REVOKED' ||
                closed.has(k.id)
              ? 'revoked'
              : 'previously_used'),
      )
    )
      throw failure();
  }
  private async observe(budget: Budget) {
    const all = new Set(
        this.config.keys
          .filter((k) => k.disposition === 'REVOKE_PREVIOUS')
          .map((k) => k.id),
      ),
      first = await this.snapshot(budget);
    this.assertStatuses(first, all);
    const second = await this.snapshot(budget);
    this.assertStatuses(second, all);
    if (JSON.stringify(first) !== JSON.stringify(second)) throw failure();
    const core = {
      kind: 'SUPABASE_REVIEWED_SIGNING_KEYS_REVOKED_V1' as const,
      configurationDigest: this.configurationDigest(),
      observedAt: new Date().toISOString(),
      keys: second,
    };
    return {
      ...core,
      observationDigest: hash(core),
      configuredSigningKeysObservedRevoked: true as const,
      coverage: 'REVIEWED_MANAGEMENT_SIGNING_KEY_STATES_ONLY' as const,
      storageTokenIssuerVerified: false as const,
      signedCapabilitiesRevoked: false as const,
      inFlightWritesDrained: false as const,
      wholeStorageQuiesced: false as const,
      actionAuthorized: false as const,
    };
  }
  async revokeReviewed() {
    if (this.attempted) throw failure();
    this.attempted = true;
    return this.work(async (budget) => {
      const closed = new Set<string>();
      this.assertStatuses(await this.snapshot(budget), closed);
      for (const k of this.config.keys.filter(
        (k) => k.disposition === 'REVOKE_PREVIOUS',
      )) {
        const changed = this.keyRow(
          await this.request(
            '/config/auth/signing-keys/' + k.id,
            'PATCH',
            budget,
            { status: 'revoked' },
          ),
        );
        if (
          changed.id !== k.id ||
          changed.algorithm !== k.algorithm ||
          changed.fingerprint !== k.fingerprint ||
          changed.status !== 'revoked'
        )
          throw failure();
        closed.add(k.id);
        this.assertStatuses(await this.snapshot(budget), closed);
      }
      return this.observe(budget);
    });
  }
  async observeRevoked() {
    return this.work((budget) => this.observe(budget));
  }
}
