import { createHash } from 'node:crypto';
import { z } from 'zod';
import {SupabaseCaptureJwt,supabaseCaptureJwtConfiguration} from './supabase-capture-jwt.js';
import {ManagedStorageDatabaseInventory} from './managed-storage-database-inventory.js';

const failure = () => new Error('Supabase recovery capture is unresolved');
const configSchema = z
  .object({
    installationId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,120}$/)
      .refine((v) => v === v.trim()),
    projectRef: z
      .string()
      .regex(/^[a-z0-9]{20}$/)
      .length(20),
    credential: z
      .object({
        id: z
          .string()
          .uuid()
          .refine((v) => v === v.toLowerCase()),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    bucket: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
      .refine((v) => v === v.trim()),
  })
  .strict();
const jwtConfigSchema=configSchema.extend({authentication:supabaseCaptureJwtConfiguration}).strict();
const captureConfiguration=z.union([configSchema,jwtConfigSchema]);
const timestamp = z.string().max(64).datetime({ offset: true });
const fileSchema = z.object({
  name: z.string(),
  id: z.string().uuid(),
  created_at: timestamp,
  updated_at: timestamp,
  metadata: z.object({
    size: z
      .number()
      .int()
      .min(0)
      .max(10 * 1024 * 1024),
    mimetype: z.string().min(1).max(255),
  }),
});
const folderSchema = z.object({
  name: z.string(),
  id: z.null(),
  created_at: z.null(),
  updated_at: z.null(),
  metadata: z.null(),
});
const hash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
export type CapturedSupabaseFile = Readonly<{
  fileUrl: string;
  id: string;
  bytes: number;
  mimeType: string;
  createdAt: string;
  updatedAt: string;
}>;
type Budget = { requests: number; signal: AbortSignal };
type Inventory = {
  files: CapturedSupabaseFile[];
  folders: string[];
  digest: string;
};

/** Read-only candidate capture. Stable repeated reads are not a global writer
 * fence, unfiltered credential authority, exact provider version or restore
 * admission. No application route/job activates this internal component. */
export class SupabaseRecoveryCapture {
  private readonly config: z.infer<typeof captureConfiguration>;
  readonly #secret:string;
  readonly #jwt:SupabaseCaptureJwt|undefined;
  private readonly origin: string;
  constructor(
    raw: unknown,
    secret: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.config = captureConfiguration.parse(raw);
    this.#secret=secret;
    if(typeof secret!=='string'||Buffer.byteLength(secret)>8192||secret!==secret.trim()||hash(secret)!==this.config.credential.sha256)throw failure();
    if('authentication' in this.config){
      try{this.#jwt=new SupabaseCaptureJwt(this.config.authentication,secret,this.config.projectRef);}catch{throw failure();}
    }else if(!/^sb_secret_[A-Za-z0-9_-]{16,512}$/.test(secret))throw failure();
    this.origin = `https://${this.config.projectRef}.supabase.co`;
  }
  assertStorageScope(raw: unknown) {
    // Legacy modern-key registry cannot authorise the new JWT role lane.
    if(this.#jwt)throw failure();
    const scope=z.object({installationId:configSchema.shape.installationId,projectRef:configSchema.shape.projectRef,
      bucket:configSchema.shape.bucket,captureKeyId:z.string().uuid()}).strict().parse(raw);
    if(scope.installationId!==this.config.installationId||scope.projectRef!==this.config.projectRef
      ||scope.bucket!==this.config.bucket||scope.captureKeyId!==this.config.credential.id)throw failure();
  }
  configurationDigest() {
    return hash(
      JSON.stringify({
        format: this.#jwt?3:2,
        provider: this.#jwt?'SUPABASE_PRIVATE_CAPTURE_CUSTOM_ROLE_JWT_V3':'SUPABASE_PRIVATE_CAPTURE_CREDENTIAL_BOUND_V2',
        ...this.config,
      }),
    );
  }
  assertConfiguredReadRoleScope(raw:unknown){
    try{
      const value=z.object({installationId:configSchema.shape.installationId,projectRef:configSchema.shape.projectRef,bucket:configSchema.shape.bucket,
        subject:z.string().uuid(),sqlRole:z.object({name:z.string(),oid:z.string()}).strict()}).strict().parse(raw);
      if(!this.#jwt||!('authentication' in this.config)||value.installationId!==this.config.installationId
        ||value.projectRef!==this.config.projectRef||value.bucket!==this.config.bucket
        ||value.subject!==this.config.authentication.subject||value.sqlRole.name!==this.config.authentication.sqlRole.name
        ||value.sqlRole.oid!==this.config.authentication.sqlRole.oid)throw failure();
    }catch{throw failure();}
  }
  readRoleRemainingMs(){if(!this.#jwt)throw failure();return this.#jwt.remainingMs();}
  private timeout(maximum:number){return this.#jwt?Math.min(maximum,this.#jwt.remainingMs()):maximum;}
  private segment(raw: string) {
    if (
      !raw ||
      raw.length > 255 ||
      raw === '.' ||
      raw === '..' ||
      /[\x00-\x1f\x7f/\\%]/.test(raw)
    )
      throw failure();
    // Refuse unpaired UTF-16 rather than silently replacing a storage key.
    encodeURIComponent(raw);
    return raw;
  }
  private async request(
    path: string,
    body: object | undefined,
    maximum: number,
    budget: Budget,
    exactBytes?: number,
    mimeType?: string,
  ): Promise<Buffer> {
    if (++budget.requests > 30000 || budget.signal.aborted) throw failure();
    this.#jwt?.assertActive();
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, budget.signal]);
    const timer = setTimeout(() => controller.abort(), this.timeout(15000));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stop!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => {
        void reader?.cancel().catch(() => {});
        reject(failure());
      };
      signal.addEventListener('abort', stop, { once: true });
    });
    const run = async () => {
      const response = await this.transport(
        this.origin + '/storage/v1' + path,
        {
          method: body === undefined ? 'GET' : 'POST',
          redirect: 'error',
          signal,
          headers: {
            ...(this.#jwt?this.#jwt.headers():{apikey:this.#secret}),
            Accept: mimeType ?? 'application/json',
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache, no-store',
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      this.#jwt?.assertActive();
      if (signal.aborted || response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      if (response.body) reader = response.body.getReader();
      const encoding = response.headers.get('content-encoding');
      const length = response.headers.get('content-length');
      const contentType = response.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase();
      if (
        (encoding && encoding !== 'identity') ||
        contentType !==
          (mimeType ?? 'application/json').split(';')[0].trim().toLowerCase() ||
        (length !== null &&
          (!/^(0|[1-9][0-9]*)$/.test(length) ||
            !Number.isSafeInteger(Number(length)) ||
            Number(length) > maximum ||
            (exactBytes !== undefined && Number(length) !== exactBytes)))
      )
        throw failure();
      if (!reader) {
        if (exactBytes === 0 && length === '0') return Buffer.alloc(0);
        throw failure();
      }
      const stream = reader;
      const bytes = Buffer.alloc(maximum);
      let count = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const chunk = await stream.read();
          if (chunk.done) break;
          if (
            !(chunk.value instanceof Uint8Array) ||
            count + chunk.value.byteLength > maximum
          )
            throw failure();
          bytes.set(chunk.value, count);
          count += chunk.value.byteLength;
        }
        if (
          signal.aborted ||
          (exactBytes !== undefined && count !== exactBytes) ||
          (length !== null && count !== Number(length))
        )
          throw failure();
        this.#jwt?.assertActive();return Buffer.from(bytes.subarray(0, count));
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
  private async json(path: string, body: object | undefined, budget: Budget) {
    const bytes = await this.request(path, body, 1024 * 1024, budget);
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ),
      ) as unknown;
    } finally {
      bytes.fill(0);
    }
  }
  private async inventory(budget: Budget): Promise<Inventory> {
    const bucket = encodeURIComponent(this.config.bucket);
    const details = z
      .object({ id: z.string(), public: z.literal(false) })
      .parse(await this.json('/bucket/' + bucket, undefined, budget));
    if (details.id !== this.config.bucket) throw failure();
    const queue = [''],
      files: CapturedSupabaseFile[] = [],
      folders: string[] = [];
    const seenPaths = new Set<string>(),
      seenIds = new Set<string>();
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const prefix = queue[cursor];
      for (let offset = 0; ; offset += 100) {
        const rows = z
          .array(z.unknown())
          .max(100)
          .parse(
            await this.json(
              '/object/list/' + bucket,
              {
                prefix,
                limit: 100,
                offset,
                sortBy: { column: 'name', order: 'asc' },
              },
              budget,
            ),
          );
        for (const raw of rows) {
          const row = z.union([folderSchema, fileSchema]).parse(raw),
            name = this.segment(row.name);
          const path = prefix ? prefix + '/' + name : name;
          if (
            path.length > 2048 ||
            path.split('/').length > 32 ||
            seenPaths.has(path)
          )
            throw failure();
          seenPaths.add(path);
          if (row.id === null) {
            folders.push(path);
            queue.push(path);
            if (folders.length > 5000) throw failure();
          } else {
            if (seenIds.has(row.id) || files.length >= 5000) throw failure();
            seenIds.add(row.id);
            files.push(
              Object.freeze({
                fileUrl: path,
                id: row.id,
                bytes: row.metadata.size,
                mimeType: row.metadata.mimetype,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
              }),
            );
          }
        }
        // A full page always requires the next page, including exactly100 rows.
        if (rows.length < 100) break;
      }
    }
    files.sort((a, b) =>
      a.fileUrl < b.fileUrl ? -1 : a.fileUrl > b.fileUrl ? 1 : 0,
    );
    folders.sort();
    return { files, folders, digest: hash(JSON.stringify({ files, folders })) };
  }
  private download(file: CapturedSupabaseFile, budget: Budget) {
    const key = file.fileUrl
      .split('/')
      .map((segment) => encodeURIComponent(this.segment(segment)))
      .join('/');
    return this.request(
      '/object/' + encodeURIComponent(this.config.bucket) + '/' + key,
      undefined,
      file.bytes,
      budget,
      file.bytes,
      file.mimeType,
    );
  }
  /** Exact configured JWT/SQL role join, held only while this capture executes.
   * Does not attest hosted token acceptance or complete provider visibility. */
  async captureWithSqlRoleWindow(inventory:ManagedStorageDatabaseInventory,visit:Parameters<SupabaseRecoveryCapture['capture']>[0],options:unknown,caller?:AbortSignal){
    try{
      if(!this.#jwt||!('authentication' in this.config)||!(inventory instanceof ManagedStorageDatabaseInventory))throw failure();
      const role=this.config.authentication.sqlRole;this.#jwt.assertActive();
      const guarded=await inventory.runCaptureRoleWindow(async(boundary,signal)=>{
        if(boundary.capture.name!==role.name||boundary.capture.oid!==role.oid)throw failure();
        this.#jwt!.assertActive();return this.capture(visit,signal);
      },options,caller);
      this.#jwt.assertActive();
      return{kind:'SUPABASE_SQL_ROLE_WINDOW_CANDIDATE_V1' as const,captured:guarded.value,sqlPrivilegeWindow:guarded.evidence,
        configuredJwtSqlRoleMatched:true as const,providerTokenRoleVerified:false as const,
        unfilteredBucketVisibilityVerified:false as const,wholeBackendQuiesced:false as const,actionAuthorized:false as const};
    }catch{throw failure();}
  }
  /** Read only a pre-existing, separately approved synthetic canary. This does
   * not create one or substitute a governance document as a credential probe. */
  async readRecoveryCanary(raw: unknown, caller?: AbortSignal) {
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([caller, controller.signal])
        : controller.signal;
    const timer = setTimeout(() => controller.abort(), this.timeout(30000)),
      budget = { signal, requests: 0 };
    try {
      const value = z
        .object({
          fileUrl: z.string().min(1).max(2048),
          bytes: z.number().int().min(1).max(1024),
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .length(64),
        })
        .strict()
        .parse(raw);
      if (
        this.config.bucket !== 'charitypilot-recovery-canaries' ||
        !value.fileUrl.startsWith(
          'charitypilot-recovery-canary/' + this.config.installationId + '/',
        ) ||
        value.fileUrl.split('/').length > 32
      )
        throw failure();
      const key = value.fileUrl
        .split('/')
        .map((segment) => encodeURIComponent(this.segment(segment)))
        .join('/');
      const bucket = z
        .object({ id: z.string(), public: z.literal(false) })
        .parse(
          await this.json('/bucket/' + this.config.bucket, undefined, budget),
        );
      if (bucket.id !== this.config.bucket) throw failure();
      const bytes = await this.request(
        '/object/' + this.config.bucket + '/' + key,
        undefined,
        value.bytes,
        budget,
        value.bytes,
        'text/plain',
      );
      try {
        if (hash(bytes) !== value.sha256 || signal.aborted) throw failure();
      } finally {
        bytes.fill(0);
      }
      this.#jwt?.assertActive();return {
        kind: 'RECOVERY_CANARY_READ_MATCH' as const,
        sha256: value.sha256,
        bytes: value.bytes,
      };
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async capture(
    visit: (
      file: CapturedSupabaseFile,
      bytes: Buffer,
      sha256: string,
      signal: AbortSignal,
    ) => Promise<void>,
    caller?: AbortSignal,
  ) {
    const controller = new AbortController(),
      signal = caller
        ? AbortSignal.any([controller.signal, caller])
        : controller.signal;
    const timer = setTimeout(() => controller.abort(), this.timeout(60 * 60 * 1000)),
      budget = { requests: 0, signal };
    try {
      signal.throwIfAborted();this.#jwt?.assertActive();
      const startedAt = new Date().toISOString(),
        first = await this.inventory(budget);
      const objects: { fileUrl: string; bytes: number; sha256: string }[] = [];
      for (const file of first.files) {
        const bytes = await this.download(file, budget);
        try {
          const sha256 = hash(bytes);
          let stop!: () => void;
          const cancelled = new Promise<never>((_resolve, reject) => {
            stop = () => {
              bytes.fill(0);
              reject(failure());
            };
            signal.addEventListener('abort', stop, { once: true });
          });
          try {
            signal.throwIfAborted();
            await Promise.race([visit(file, bytes, sha256, signal), cancelled]);
          } finally {
            signal.removeEventListener('abort', stop);
          }
          signal.throwIfAborted();
          if (hash(bytes) !== sha256) throw failure();
          objects.push({ fileUrl: file.fileUrl, bytes: bytes.length, sha256 });
        } finally {
          bytes.fill(0);
        }
      }
      if ((await this.inventory(budget)).digest !== first.digest)
        throw failure();
      for (let i = 0; i < first.files.length; i++) {
        const bytes = await this.download(first.files[i], budget);
        try {
          if (hash(bytes) !== objects[i].sha256) throw failure();
        } finally {
          bytes.fill(0);
        }
      }
      if (
        (await this.inventory(budget)).digest !== first.digest ||
        signal.aborted
      )
        throw failure();
      this.#jwt?.assertActive();
      return {
        kind: this.#jwt?'SUPABASE_READ_ROLE_CANDIDATE_CAPTURE_V1' as const:'SUPABASE_CANDIDATE_CAPTURE' as const,
        restoreMode: 'QUARANTINE_ONLY' as const,
        captureConsistency: 'EXTERNAL_VERIFICATION_REQUIRED' as const,
        visibility: 'SUPPLIED_CREDENTIAL_VIEW_ONLY' as const,
        credentialId: this.config.credential.id,
        credentialSha256: this.config.credential.sha256,
        captureRequestMode: 'READ_OPERATIONS_ONLY' as const,
        credentialCapability: this.#jwt?'ASYMMETRIC_CUSTOM_ROLE_JWT' as const:'PRIVILEGED_MODERN_SERVER_KEY' as const,
        ...(this.#jwt?{jwtVerification:this.#jwt.evidence()}:{}),
        credentialHashMatched: true as const,
        credentialIdentityVerified: false as const,
        credentialPrivilegeVerified: false as const,
        credentialWriteAuthorityExcluded: false as const,
        wholeStorageQuiesced: false as const,
        actionAuthorized: false as const,
        configurationDigest: this.configurationDigest(),
        inventoryDigest: first.digest,
        startedAt,
        observedAt: new Date().toISOString(),
        objects,
        files: first.files,
      };
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
