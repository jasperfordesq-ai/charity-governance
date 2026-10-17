import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { DOCUMENT_BACKUP_KEY_ARN } from './document-byte-backup.js';

export const DATABASE_BACKUP_MAX_BYTES = 64 * 1024 * 1024 * 1024;
const MAGIC = Buffer.from('CHARITYPILOT_DATABASE_BYTES_V1\n');
const MAX_HEADER_BYTES = 16384;
const MAX_CHUNK_BYTES = 1024 * 1024;
const refused = () => new Error('Database byte backup unavailable');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    setId: z
      .string()
      .uuid()
      .refine((value) => value === value.toLowerCase()),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    databaseIdentitySha256: sha,
    sourceCaptureReportSha256: sha,
    databaseSha256: sha,
    byteLength: z.number().int().min(5).max(DATABASE_BACKUP_MAX_BYTES),
    keyArn: DOCUMENT_BACKUP_KEY_ARN,
  })
  .strict();
export type DatabaseBackupContext = z.infer<typeof scope>;
export function databaseBackupContext(raw: unknown): DatabaseBackupContext {
  try {
    return Object.freeze(scope.parse(raw));
  } catch {
    throw refused();
  }
}
export function databaseBackupArchiveBounds(raw: unknown) {
  const context = databaseBackupContext(raw);
  const base =
    context.byteLength +
    MAGIC.length +
    4 +
    Math.ceil(context.byteLength / MAX_CHUNK_BYTES) * 20;
  return { minimumBytes: base + 1, maximumBytes: base + MAX_HEADER_BYTES };
}
export interface DatabaseBackupKeys {
  generate(
    context: DatabaseBackupContext,
  ): Promise<{ key: Buffer; keyArn: string; wrappedKey: string }>;
  unwrap(
    wrappedKey: string,
    context: DatabaseBackupContext,
  ): Promise<{ key: Buffer; keyArn: string }>;
}
const base64 = (min: number, max: number) =>
  z
    .string()
    .max(4 * Math.ceil(max / 3))
    .refine((value) => {
      const bytes = Buffer.from(value, 'base64');
      return (
        bytes.length >= min &&
        bytes.length <= max &&
        bytes.toString('base64') === value
      );
    });
const headerSchema = z
  .object({
    format: z.literal(1),
    context: scope,
    wrappedKey: base64(1, 6144),
    noncePrefix: base64(8, 8),
    chunkBytes: z.literal(MAX_CHUNK_BYTES),
  })
  .strict();
type Material = { key: Buffer; keyArn: string };
function ownedKey(material: Material, context: DatabaseBackupContext) {
  if (
    !Buffer.isBuffer(material?.key) ||
    material.key.length !== 32 ||
    material.keyArn !== context.keyArn
  )
    throw refused();
  return material.key;
}
function clear(material: Material | undefined) {
  if (Buffer.isBuffer(material?.key)) material.key.fill(0);
}
function chunk(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length > MAX_CHUNK_BYTES)
    throw refused();
  return value;
}
function dumpMagic() {
  const prefix = Buffer.alloc(5);
  let have = 0;
  return {
    observe(bytes: Buffer) {
      const count = Math.min(5 - have, bytes.length);
      bytes.copy(prefix, have, 0, count);
      have += count;
      if (have === 5 && !prefix.equals(Buffer.from('PGDMP'))) throw refused();
    },
    complete() {
      if (have !== 5) throw refused();
    },
  };
}
function frameBinding(
  prefix: Buffer,
  noncePrefix: Buffer,
  ordinal: number,
  bytes: number,
) {
  const sequence = Buffer.alloc(4),
    length = Buffer.alloc(4);
  sequence.writeUInt32BE(ordinal);
  length.writeUInt32BE(bytes);
  return {
    nonce: Buffer.concat([noncePrefix, sequence]),
    length,
    aad: Buffer.concat([prefix, sequence, length]),
  };
}
/** Source and destination are owned one-shot streams. The destination must be
 * isolated quarantine, never a live database/file or public object. A failed
 * operation destroys streams; its caller must discard any partial destination. */
function transfer(
  source: Readable,
  destination: Writable,
  caller?: AbortSignal,
) {
  const controller = new AbortController();
  const deadline = performance.now() + 45 * 60 * 1000;
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(45 * 60 * 1000),
    ...(caller ? [caller] : []),
  ]);
  // These streams can fail while awaiting the key provider, before pipeline
  // installs its own error handlers. Owned streams are terminal, not reused.
  const onError = () => controller.abort();
  source.on('error', onError);
  destination.on('error', onError);
  const stop = () => {
    source.destroy();
    destination.destroy();
  };
  signal.addEventListener('abort', stop, { once: true });
  return {
    signal,
    check() {
      if (performance.now() >= deadline) controller.abort();
      if (signal.aborted || source.errored || destination.errored)
        throw refused();
    },
    close() {
      signal.removeEventListener('abort', stop);
      source.destroy();
      if (!destination.writableFinished) destination.destroy();
    },
  };
}
export async function sealDatabaseByteBackup(
  raw: unknown,
  source: Readable,
  destination: Writable,
  keys: DatabaseBackupKeys,
  signal?: AbortSignal,
) {
  const io = transfer(source, destination, signal);
  let material: Awaited<ReturnType<DatabaseBackupKeys['generate']>> | undefined;
  try {
    io.check();
    const context = databaseBackupContext(raw);
    material = await keys.generate(context);
    io.check();
    const key = ownedKey(material, context),
      noncePrefix = randomBytes(8);
    const header = headerSchema.parse({
      format: 1,
      context,
      wrappedKey: material.wrappedKey,
      noncePrefix: noncePrefix.toString('base64'),
      chunkBytes: MAX_CHUNK_BYTES,
    });
    const headerBytes = Buffer.from(JSON.stringify(header));
    if (headerBytes.length > MAX_HEADER_BYTES) throw refused();
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.length);
    const prefix = Buffer.concat([MAGIC, length, headerBytes]);
    const plaintext = createHash('sha256'),
      archive = createHash('sha256'),
      magic = dumpMagic();
    let count = 0,
      archiveBytes = 0;
    const record = (part: Buffer) => {
      archive.update(part);
      archiveBytes += part.length;
      return part;
    };
    const encode = async function* () {
      const frame = Buffer.alloc(MAX_CHUNK_BYTES);
      let used = 0,
        ordinal = 0;
      const encryptFrame = () => {
        const bytes = frame.subarray(0, used),
          binding = frameBinding(prefix, noncePrefix, ordinal++, used);
        magic.observe(bytes);
        plaintext.update(bytes);
        const cipher = createCipheriv('aes-256-gcm', key, binding.nonce, {
          authTagLength: 16,
        });
        cipher.setAAD(binding.aad);
        const encoded = [
          binding.length,
          cipher.update(bytes),
          cipher.final(),
          cipher.getAuthTag(),
        ];
        frame.fill(0);
        used = 0;
        return encoded;
      };
      try {
        yield record(prefix);
        for await (const rawChunk of source) {
          io.check();
          const bytes = Buffer.from(chunk(rawChunk));
          try {
            count += bytes.length;
            if (count > context.byteLength) throw refused();
            let offset = 0;
            while (offset < bytes.length) {
              const copied = Math.min(
                frame.length - used,
                bytes.length - offset,
              );
              bytes.copy(frame, used, offset, offset + copied);
              offset += copied;
              used += copied;
              if (used === frame.length) {
                for (const part of encryptFrame()) yield record(part);
              }
            }
          } finally {
            bytes.fill(0);
          }
        }
        if (used) {
          for (const part of encryptFrame()) yield record(part);
        }
        magic.complete();
        if (
          count !== context.byteLength ||
          plaintext.digest('hex') !== context.databaseSha256
        )
          throw refused();
      } finally {
        frame.fill(0);
      }
    };
    await pipeline(
      Readable.from(encode(), { objectMode: false }),
      destination,
      { signal: io.signal },
    );
    io.check();
    return {
      sha256: archive.digest('hex'),
      byteLength: archiveBytes,
      databaseSha256: context.databaseSha256,
    };
  } catch {
    throw refused();
  } finally {
    clear(material);
    io.close();
  }
}

class ArchiveReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  readonly hash = createHash('sha256');
  count = 0;
  constructor(
    source: Readable,
    private readonly maximumBytes: number,
    private readonly check: () => void,
  ) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  async take(maximum: number): Promise<Buffer> {
    while (!this.pending.length) {
      this.check();
      const next = await this.iterator.next();
      if (next.done) throw refused();
      this.pending = Buffer.from(chunk(next.value));
      this.count += this.pending.length;
      if (this.count > this.maximumBytes) throw refused();
      this.hash.update(this.pending);
    }
    const result = this.pending.subarray(0, maximum);
    this.pending = this.pending.subarray(result.length);
    return result;
  }
  async exact(bytes: number) {
    const result = Buffer.alloc(bytes);
    let count = 0;
    while (count < bytes) {
      const part = await this.take(bytes - count);
      part.copy(result, count);
      count += part.length;
    }
    return result;
  }
  async end() {
    if (this.pending.length) throw refused();
    for (;;) {
      this.check();
      const next = await this.iterator.next();
      if (next.done) return;
      if (chunk(next.value).length) throw refused();
    }
  }
}
async function archiveHeader(
  context: DatabaseBackupContext,
  reader: ArchiveReader,
) {
  const magic = await reader.exact(MAGIC.length),
    length = await reader.exact(4);
  if (!magic.equals(MAGIC)) throw refused();
  const headerLength = length.readUInt32BE();
  if (headerLength < 1 || headerLength > MAX_HEADER_BYTES) throw refused();
  const encoded = await reader.exact(headerLength);
  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(encoded);
  const header = headerSchema.parse(JSON.parse(text));
  if (
    JSON.stringify(header) !== text ||
    JSON.stringify(header.context) !== JSON.stringify(context)
  )
    throw refused();
  return { header, prefix: Buffer.concat([magic, length, encoded]) };
}
/** Framing/scope and trusted external whole-archive digest only. No KMS unwrap,
 * GCM verification, source-capture authentication or restoration permission.
 * The encoded source must come from a successful sealer or trusted manifest. */
export async function inspectDatabaseByteBackupArchive(
  raw: unknown,
  source: Readable,
  destination: Writable,
  expectedSha256: string,
  expectedByteLength: number,
  signal?: AbortSignal,
) {
  const io = transfer(source, destination, signal);
  try {
    io.check();
    const context = databaseBackupContext(raw),
      bounds = databaseBackupArchiveBounds(context);
    sha.parse(expectedSha256);
    if (
      !Number.isSafeInteger(expectedByteLength) ||
      expectedByteLength < bounds.minimumBytes ||
      expectedByteLength > bounds.maximumBytes
    )
      throw refused();
    const reader = new ArchiveReader(source, expectedByteLength, io.check),
      { prefix } = await archiveHeader(context, reader);
    if (
      prefix.length +
        context.byteLength +
        Math.ceil(context.byteLength / MAX_CHUNK_BYTES) * 20 !==
      expectedByteLength
    )
      throw refused();
    const inspect = async function* () {
      yield prefix;
      let remaining = context.byteLength;
      while (remaining) {
        io.check();
        const length = await reader.exact(4),
          size = length.readUInt32BE();
        if (size !== Math.min(MAX_CHUNK_BYTES, remaining)) throw refused();
        yield length;
        yield await reader.exact(size);
        yield await reader.exact(16);
        remaining -= size;
      }
      await reader.end();
      if (
        reader.count !== expectedByteLength ||
        reader.hash.digest('hex') !== expectedSha256
      )
        throw refused();
    };
    await pipeline(
      Readable.from(inspect(), { objectMode: false }),
      destination,
      { signal: io.signal },
    );
    io.check();
    return {
      sha256: expectedSha256,
      byteLength: expectedByteLength,
      databaseSha256: context.databaseSha256,
    };
  } catch {
    throw refused();
  } finally {
    io.close();
  }
}
/** Streams plaintext only into an owned isolated quarantine sink. Success needs
 * the trusted external archive SHA, exact header scope, GCM authentication and
 * plaintext SHA/length/custom-dump signature. Never pass it a live restore pipe. */
export async function openDatabaseByteBackupToQuarantine(
  raw: unknown,
  source: Readable,
  destination: Writable,
  expectedSha256: string,
  keys: DatabaseBackupKeys,
  signal?: AbortSignal,
) {
  const io = transfer(source, destination, signal);
  let material: Material | undefined;
  try {
    io.check();
    const context = databaseBackupContext(raw);
    sha.parse(expectedSha256);
    const reader = new ArchiveReader(
      source,
      databaseBackupArchiveBounds(context).maximumBytes,
      io.check,
    );
    const { header, prefix } = await archiveHeader(context, reader);
    material = await keys.unwrap(header.wrappedKey, context);
    io.check();
    const key = ownedKey(material, context),
      noncePrefix = Buffer.from(header.noncePrefix, 'base64');
    const plaintext = createHash('sha256'),
      signature = dumpMagic();
    let count = 0;
    const decode = async function* () {
      let remaining = context.byteLength,
        ordinal = 0;
      while (remaining) {
        io.check();
        const size = (await reader.exact(4)).readUInt32BE();
        if (size !== Math.min(MAX_CHUNK_BYTES, remaining)) throw refused();
        const encrypted = await reader.exact(size),
          tag = await reader.exact(16);
        const binding = frameBinding(prefix, noncePrefix, ordinal++, size);
        const decipher = createDecipheriv('aes-256-gcm', key, binding.nonce, {
          authTagLength: 16,
        });
        decipher.setAAD(binding.aad);
        decipher.setAuthTag(tag);
        const cleartext = decipher.update(encrypted);
        try {
          decipher.final();
        } catch {
          cleartext.fill(0);
          throw refused();
        }
        remaining -= size;
        count += cleartext.length;
        signature.observe(cleartext);
        plaintext.update(cleartext);
        yield cleartext;
      }
      await reader.end();
      if (reader.hash.digest('hex') !== expectedSha256) throw refused();
      signature.complete();
      if (
        count !== context.byteLength ||
        plaintext.digest('hex') !== context.databaseSha256
      ) {
        throw refused();
      }
    };
    await pipeline(
      Readable.from(decode(), { objectMode: false }),
      destination,
      { signal: io.signal },
    );
    io.check();
    return {
      databaseSha256: context.databaseSha256,
      byteLength: count,
      archiveSha256: expectedSha256,
    };
  } catch {
    throw refused();
  } finally {
    clear(material);
    io.close();
  }
}
