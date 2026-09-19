import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Reading a file to upload, and writing one that was downloaded.
 *
 * An upload is a channel INTO the charity's records, and onward to wherever
 * documents are mirrored. A download is personal data leaving the machine the
 * API runs behind. Neither is available unless the operator names a directory
 * for it, and nothing outside that directory can be read or written, however
 * the path is spelled.
 */

/** Mirrors the API's allowlist. A drift test keeps the two the same. */
export const UPLOAD_MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

/** The API's own ceiling. Checked here so a too-large file fails before it is read. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Names never traversed into, whatever the root is.
 *
 * An operator who points the upload root at a project directory should not
 * find that an agent can read the credentials in its `.git` config or the
 * contents of `node_modules` by asking for a document.
 */
const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules', '.ssh', '.env']);

export class FileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileAccessError';
  }
}

/**
 * Resolves a path inside a root, refusing anything that escapes it.
 *
 * Containment is decided after resolving symbolic links on both sides, because
 * a link inside the root pointing outside it would otherwise pass a check made
 * on the spelling alone.
 */
export function resolveInsideRoot(root: string, requested: string): string {
  const realRoot = (() => {
    try {
      return realpathSync(root);
    } catch {
      throw new FileAccessError(
        `The configured directory does not exist: ${root}. Create it, or point the `
          + 'connector at one that does.',
      );
    }
  })();

  const candidate = isAbsolute(requested) ? requested : join(realRoot, requested);

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new FileAccessError(`No such file: ${requested}`);
  }

  const within = relative(realRoot, real);
  if (within === '' || within.startsWith('..') || isAbsolute(within)) {
    throw new FileAccessError(
      `${requested} is outside the directory this connector may use (${realRoot}). `
        + 'Nothing was read.',
    );
  }

  for (const segment of within.split(sep)) {
    if (FORBIDDEN_SEGMENTS.has(segment) || segment.startsWith('.')) {
      throw new FileAccessError(
        `${requested} goes through "${segment}", which this connector never reads.`,
      );
    }
  }

  return real;
}

export interface UploadableFile {
  path: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
}

export function readUploadable(root: string, requested: string): UploadableFile {
  const path = resolveInsideRoot(root, requested);

  const stats = statSync(path);
  if (!stats.isFile()) {
    throw new FileAccessError(`${requested} is not a file.`);
  }
  if (stats.size > UPLOAD_MAX_BYTES) {
    throw new FileAccessError(
      `${requested} is ${Math.round(stats.size / 1024 / 1024)} MB. CharityPilot accepts `
        + `files up to ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`,
    );
  }

  const extension = extname(path).toLowerCase();
  const mimeType = UPLOAD_MIME_BY_EXTENSION[extension];
  if (!mimeType) {
    throw new FileAccessError(
      `CharityPilot does not accept ${extension || 'files with no extension'}. `
        + `It accepts: ${Object.keys(UPLOAD_MIME_BY_EXTENSION).join(', ')}.`,
    );
  }

  return { path, name: basename(path), mimeType, bytes: readFileSync(path) };
}

/**
 * Writes a downloaded document, owner-only, under the directory the operator
 * named.
 *
 * The file name is taken from the record rather than from anything a caller
 * supplies, and is reduced to a single safe segment, so a document called
 * "../../id_rsa" lands as a file called "id_rsa" inside the directory and
 * nowhere else.
 */
export function writeDownload(
  directory: string,
  suggestedName: string,
  bytes: Buffer,
): { path: string; sha256: string } {
  mkdirSync(directory, { recursive: true });
  const realDirectory = realpathSync(directory);

  const safeName =
    basename(suggestedName).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'document';
  const path = resolve(realDirectory, safeName);

  // Belt and braces: basename cannot escape, but the check costs nothing and
  // the consequence of being wrong is a file written wherever a caller likes.
  const within = relative(realDirectory, path);
  if (within.startsWith('..') || isAbsolute(within)) {
    throw new FileAccessError('The document name could not be made safe to write.');
  }

  writeFileSync(path, bytes, { mode: 0o600 });
  try {
    // `mode` applies only on creation, so an existing file keeps its old
    // permissions without this.
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX mode; the file inherits the user's access control.
  }

  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
}
