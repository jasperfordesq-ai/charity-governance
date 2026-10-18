import { constants, lstatSync, fstatSync, realpathSync, mkdirSync, openSync,
  writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { isAbsolute, resolve, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const refused = () => new Error('Bootstrap journal refused; preserve existing state');
const identity = stat => [stat.dev, stat.ino, stat.uid, stat.mode].join('|');
const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** New operation only. No reopening, retry, history repair or resource adoption. */
export function openBootstrapJournal(parent, bootstrapId) {
  let parentFd, operationFd;
  try {
    if (process.platform !== 'linux' || process.getuid() === 0 || typeof parent !== 'string'
      || !isAbsolute(parent) || realpathSync(parent) !== parent || resolve(parent) !== parent
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(bootstrapId)) throw refused();
    const rel = relative(repository, parent);
    if (!(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))) throw refused();
    const directory = path => {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & 0o777) !== 0o700) throw refused();
      return stat;
    };
    const before = directory(parent);
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (identity(fstatSync(parentFd)) !== identity(before)) throw refused();
    const operation = join(parent, bootstrapId), anchored = '/proc/self/fd/' + parentFd + '/' + bootstrapId;
    // EEXIST is terminal even for an empty operation. Never reuse its intents.
    mkdirSync(anchored, { mode: 0o700 }); fsyncSync(parentFd);
    operationFd = openSync(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const operationIdentity = identity(directory(operation));
    const check = () => {
      if (realpathSync(parent) !== parent || identity(directory(parent)) !== identity(before)
        || identity(fstatSync(parentFd)) !== identity(before) || realpathSync(operation) !== operation
        || identity(directory(operation)) !== operationIdentity
        || identity(fstatSync(operationFd)) !== operationIdentity) throw refused();
    };
    check(); let closed = false;
    const close = () => {
      if (closed) return; closed = true;
      closeSync(operationFd); closeSync(parentFd);
    };
    return Object.freeze({ check: () => { if (closed) throw refused(); check(); },
      append: (name, record) => {
        if (closed || !/^(?:operation|complete|[0-3]-(?:intent|response))\.json$/.test(name)) throw refused();
        check(); const body = JSON.stringify(record) + '\n';
        if (Buffer.byteLength(body) > 16384) throw refused();
        const fd = openSync('/proc/self/fd/' + operationFd + '/' + name,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw refused();
          writeFileSync(fd, body, 'utf8'); fsyncSync(fd);
          fsyncSync(operationFd); check();
          const after = fstatSync(fd), named = lstatSync('/proc/self/fd/' + operationFd + '/' + name);
          if (after.nlink !== 1 || after.size !== Buffer.byteLength(body)
            || identity(after) !== identity(stat) || identity(named) !== identity(after)
            || !named.isFile() || named.isSymbolicLink()) throw refused();
        } finally { closeSync(fd); }
      }, close });
  } catch {
    if (operationFd !== undefined) closeSync(operationFd);
    if (parentFd !== undefined) closeSync(parentFd);
    throw refused();
  }
}
