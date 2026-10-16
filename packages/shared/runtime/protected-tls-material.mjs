import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const applicationRoot = resolve(
  dirname(fileURLToPath(import.meta.url)), '../../..',
);
const refused = () => new Error('Protected TLS material refused');
export function readBoundedRegularDescriptor(fd, limit) {
  const before = fstatSync(fd),
    bytes = Buffer.alloc(limit + 1);
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > limit
  )
    throw refused();
  let length = 0;
  while (length < bytes.length) {
    const size = readSync(fd, bytes, length, bytes.length - length, length);
    if (!size) break;
    length += size;
  }
  const after = fstatSync(fd);
  if (
    length > limit ||
    length !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  )
    throw refused();
  return bytes.subarray(0, length).toString('utf8');
}
export function readProtectedTlsMaterial(directory, filenames) {
  let directoryFd;
  try {
    if (
      process.platform !== 'linux' ||
      typeof directory !== 'string' ||
      directory === '/app' || directory.startsWith('/app/') ||
      directory === applicationRoot ||
      directory.startsWith(applicationRoot + '/') ||
      !isAbsolute(directory) ||
      resolve(directory) !== directory ||
      realpathSync(directory) !== directory
    )
      throw refused();
    const uid = process.getuid(),
      before = lstatSync(directory);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.uid !== uid ||
      (before.mode & 0o777) !== 0o700
    )
      throw refused();
    directoryFd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(directoryFd);
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.uid !== uid ||
      (opened.mode & 0o777) !== 0o700
    )
      throw refused();
    const result = Object.create(null);
    for (const name of filenames) {
      if (
        typeof name !== 'string' ||
        !/^[a-z][a-z0-9-]{0,40}\.(?:pem|key)$/.test(name) ||
        Object.hasOwn(result, name)
      )
        throw refused();
      const fd = openSync(
        join('/proc/self/fd', String(directoryFd), name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = fstatSync(fd);
        if (info.uid !== uid || (info.mode & 0o777) !== 0o400) throw refused();
        result[name] = readBoundedRegularDescriptor(fd, 16384);
      } finally {
        closeSync(fd);
      }
    }
    return result;
  } catch {
    throw refused();
  } finally {
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}
