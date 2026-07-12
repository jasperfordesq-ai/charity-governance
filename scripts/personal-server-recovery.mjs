import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const ENCRYPTED_ARTIFACT_MAGIC = Buffer.from('CPPSENC2', 'ascii');
const ENCRYPTED_ARTIFACT_FORMAT = 'charitypilot-personal-server-aes-256-gcm/v2';
const NON_ENCRYPTED_ARTIFACT_FORMAT = 'none';
const MANIFEST_AUTHENTICATION_FORMAT = 'charitypilot-personal-server-manifest-hmac-sha256/v1';
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const IO_BUFFER_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROOF_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1_000_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_METADATA_BYTES = 1024 * 1024;
const RECOVERY_STAGING_PREFIX = 'charitypilot-personal-recovery-';
const SAFE_RECOVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256RecoveryFile(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function regularFile(path, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symbolic-link file`);
  }
  if (status.size <= 0 || status.size > maximumBytes) {
    throw new Error(`${label} has an invalid byte size`);
  }
  return status;
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function readExactly(fd, buffer, offset, length, position) {
  let total = 0;
  while (total < length) {
    const count = readSync(fd, buffer, offset + total, length - total, position + total);
    if (count === 0) throw new Error('Recovery artifact ended unexpectedly');
    total += count;
  }
}

function protectedOutput(path, callback) {
  const partial = `${path}.partial`;
  const fd = openSync(
    partial,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    callback(fd);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(partial, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(partial, path);
}

export function loadPersonalServerEncryptionKey(keyFile) {
  if (typeof keyFile !== 'string' || !isAbsolute(keyFile)) {
    throw new Error('Encryption key file must be an explicit absolute path');
  }
  regularFile(keyFile, 'Encryption key file', 256);
  const text = readFileSync(keyFile, 'utf8');
  if (!/^[a-f0-9]{64}\r?\n?$/u.test(text)) {
    throw new Error('Encryption key file must contain exactly 64 lowercase hexadecimal characters and an optional final newline');
  }
  const key = Buffer.from(text.trim(), 'hex');
  return { key, keySha256: sha256Buffer(key) };
}

function artifactAdditionalData(aadContext) {
  if (typeof aadContext !== 'string' || !/^[A-Za-z0-9._:-]{3,256}$/u.test(aadContext)) {
    throw new Error('Recovery artifact authenticated context is invalid');
  }
  return Buffer.concat([ENCRYPTED_ARTIFACT_MAGIC, Buffer.from([0]), Buffer.from(aadContext, 'utf8')]);
}

export function hmacPersonalServerRecoveryManifest(manifestPath, key) {
  regularFile(manifestPath, 'Recovery manifest', MAX_MANIFEST_BYTES);
  const hmac = createHmac('sha256', key);
  const fd = openSync(manifestPath, 'r');
  const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hmac.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hmac.digest('hex');
}

export function encryptPersonalServerArtifact({
  inputPath,
  outputPath,
  key,
  aadContext,
  randomBytesImpl = randomBytes,
}) {
  const input = regularFile(inputPath, 'Plaintext recovery artifact');
  if (existsSync(outputPath)) throw new Error('Encrypted recovery artifact output already exists');
  const nonce = randomBytesImpl(GCM_NONCE_BYTES);
  if (!Buffer.isBuffer(nonce) || nonce.length !== GCM_NONCE_BYTES) {
    throw new Error('Encryption nonce generator returned an invalid value');
  }
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(artifactAdditionalData(aadContext));
  const sourceFd = openSync(inputPath, 'r');
  try {
    protectedOutput(outputPath, (outputFd) => {
      writeAll(outputFd, ENCRYPTED_ARTIFACT_MAGIC);
      writeAll(outputFd, nonce);
      const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
      while (true) {
        const count = readSync(sourceFd, buffer, 0, buffer.length, null);
        if (count === 0) break;
        writeAll(outputFd, cipher.update(buffer.subarray(0, count)));
      }
      writeAll(outputFd, cipher.final());
      writeAll(outputFd, cipher.getAuthTag());
    });
  } finally {
    closeSync(sourceFd);
  }
  const encrypted = statSync(outputPath);
  if (encrypted.size !== input.size + ENCRYPTED_ARTIFACT_MAGIC.length + GCM_NONCE_BYTES + GCM_TAG_BYTES) {
    rmSync(outputPath, { force: true });
    throw new Error('Encrypted recovery artifact byte size is inconsistent');
  }
  return {
    format: ENCRYPTED_ARTIFACT_FORMAT,
    bytes: encrypted.size,
    sha256: sha256RecoveryFile(outputPath),
    plaintextBytes: input.size,
    plaintextSha256: sha256RecoveryFile(inputPath),
  };
}

export function decryptPersonalServerArtifact({ inputPath, outputPath, key, aadContext }) {
  const input = regularFile(inputPath, 'Encrypted recovery artifact');
  const overhead = ENCRYPTED_ARTIFACT_MAGIC.length + GCM_NONCE_BYTES + GCM_TAG_BYTES;
  if (input.size <= overhead) throw new Error('Encrypted recovery artifact is truncated');
  if (existsSync(outputPath)) throw new Error('Decrypted recovery artifact output already exists');

  const sourceFd = openSync(inputPath, 'r');
  try {
    const magic = Buffer.alloc(ENCRYPTED_ARTIFACT_MAGIC.length);
    readExactly(sourceFd, magic, 0, magic.length, 0);
    if (!magic.equals(ENCRYPTED_ARTIFACT_MAGIC)) throw new Error('Encrypted recovery artifact format is not recognised');
    const nonce = Buffer.alloc(GCM_NONCE_BYTES);
    readExactly(sourceFd, nonce, 0, nonce.length, magic.length);
    const tag = Buffer.alloc(GCM_TAG_BYTES);
    readExactly(sourceFd, tag, 0, tag.length, input.size - tag.length);

    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(artifactAdditionalData(aadContext));
    decipher.setAuthTag(tag);
    const ciphertextStart = magic.length + nonce.length;
    const ciphertextBytes = input.size - overhead;
    protectedOutput(outputPath, (outputFd) => {
      const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
      let consumed = 0;
      while (consumed < ciphertextBytes) {
        const wanted = Math.min(buffer.length, ciphertextBytes - consumed);
        readExactly(sourceFd, buffer, 0, wanted, ciphertextStart + consumed);
        writeAll(outputFd, decipher.update(buffer.subarray(0, wanted)));
        consumed += wanted;
      }
      writeAll(outputFd, decipher.final());
    });
  } catch (error) {
    rmSync(outputPath, { force: true });
    throw new Error(`Encrypted recovery artifact authentication failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    closeSync(sourceFd);
  }
  return {
    bytes: statSync(outputPath).size,
    sha256: sha256RecoveryFile(outputPath),
  };
}

function decodeTarField(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const bytes = nul >= 0 ? field.subarray(0, nul) : field;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd();
  } catch {
    throw new Error(`Document archive ${label} is not valid UTF-8`);
  }
}

function tarOctal(header, offset, length, label) {
  const value = decodeTarField(header, offset, length, label).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error(`Document archive ${label} is not canonical octal`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Document archive ${label} is outside safe bounds`);
  return parsed;
}

function tarChecksum(header) {
  let total = 0;
  for (let index = 0; index < header.length; index += 1) {
    total += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return total;
}

function safeArchivePath(rawName) {
  let name = rawName;
  while (name.startsWith('./')) name = name.slice(2);
  name = name.replace(/\/$/u, '');
  if (!name) return '';
  if (
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes(':') ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new Error('Document archive contains an unsafe path');
  }
  const segments = name.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' '))) {
    throw new Error('Document archive contains an unsafe path segment');
  }
  return segments.join('/');
}

function decodeTarMetadata(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Document archive ${label} is not valid UTF-8`);
  }
}

function paxPath(bytes) {
  const text = decodeTarMetadata(bytes, 'PAX metadata');
  let offset = 0;
  let path;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space < 0 || !/^\d+$/u.test(text.slice(offset, space))) throw new Error('Document archive PAX record length is invalid');
    const length = Number(text.slice(offset, space));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > text.length) {
      throw new Error('Document archive PAX record exceeds its metadata payload');
    }
    const record = text.slice(space + 1, offset + length);
    if (!record.endsWith('\n')) throw new Error('Document archive PAX record is not newline terminated');
    const separator = record.indexOf('=');
    if (separator <= 0) throw new Error('Document archive PAX record is malformed');
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1, -1);
    if (key === 'path') {
      if (path !== undefined) throw new Error('Document archive PAX metadata repeats path');
      path = value;
    }
    offset += length;
  }
  return path;
}

function ensureDirectoryTree(root, relativePath) {
  if (!relativePath) return;
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const status = lstatSync(current);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error('Document extraction encountered a substituted directory');
    }
  }
}

function outputPathWithin(root, relativePath) {
  const output = resolve(root, ...relativePath.split('/'));
  const relation = relative(root, output);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('Document archive path escaped the extraction root');
  }
  return output;
}

export function inspectPersonalServerDocumentArchive(archivePath, { extractTo } = {}) {
  const archive = regularFile(archivePath, 'Document archive', MAX_ARCHIVE_BYTES);
  if (archive.size % 512 !== 0) throw new Error('Document archive is not aligned to 512-byte records');
  if (extractTo !== undefined) {
    if (!isAbsolute(extractTo)) throw new Error('Document extraction root must be absolute');
    if (existsSync(extractTo)) throw new Error('Document extraction root must not already exist');
    mkdirSync(extractTo, { recursive: false, mode: 0o700 });
    const status = lstatSync(extractTo);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Document extraction root is unsafe');
  }

  const fd = openSync(archivePath, 'r');
  const header = Buffer.alloc(512);
  const paths = new Set();
  const files = [];
  let position = 0;
  let entries = 0;
  let totalFileBytes = 0;
  let zeroBlocks = 0;
  let pendingExtendedPath;
  try {
    while (position < archive.size) {
      readExactly(fd, header, 0, header.length, position);
      position += header.length;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        continue;
      }
      if (zeroBlocks > 0) throw new Error('Document archive contains data after its end marker');
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) throw new Error('Document archive contains too many entries');
      const expectedChecksum = tarOctal(header, 148, 8, 'checksum');
      if (tarChecksum(header) !== expectedChecksum) throw new Error('Document archive header checksum is invalid');
      const type = String.fromCharCode(header[156] || 0x30);
      const size = tarOctal(header, 124, 12, 'entry size');
      const padded = Math.ceil(size / 512) * 512;
      if (position + padded > archive.size) throw new Error('Document archive entry exceeds the archive boundary');
      if (['L', 'x'].includes(type)) {
        if (pendingExtendedPath !== undefined) throw new Error('Document archive contains stacked path metadata');
        if (size <= 0 || size > MAX_ARCHIVE_METADATA_BYTES) throw new Error('Document archive path metadata has an invalid size');
        const metadata = Buffer.alloc(size);
        readExactly(fd, metadata, 0, size, position);
        if (type === 'L') {
          const nul = metadata.indexOf(0);
          const value = decodeTarMetadata(nul >= 0 ? metadata.subarray(0, nul) : metadata, 'GNU long path').replace(/\n$/u, '');
          pendingExtendedPath = value;
        } else {
          pendingExtendedPath = paxPath(metadata);
        }
        position += padded;
        continue;
      }
      if (!['0', '5'].includes(type)) {
        throw new Error(`Document archive entry type ${JSON.stringify(type)} is forbidden`);
      }
      const name = decodeTarField(header, 0, 100, 'name');
      const prefix = decodeTarField(header, 345, 155, 'prefix');
      const relativePath = safeArchivePath(pendingExtendedPath ?? (prefix ? `${prefix}/${name}` : name));
      pendingExtendedPath = undefined;
      if (type === '5' && size !== 0) throw new Error('Document archive directory entry has content');
      if (relativePath && paths.has(relativePath)) throw new Error('Document archive contains a duplicate path');
      if (relativePath) paths.add(relativePath);

      if (type === '5') {
        if (extractTo && relativePath) ensureDirectoryTree(extractTo, relativePath);
      } else {
        if (!relativePath) throw new Error('Document archive contains a nameless file');
        totalFileBytes += size;
        if (!Number.isSafeInteger(totalFileBytes) || totalFileBytes > MAX_ARCHIVE_BYTES) {
          throw new Error('Document archive expanded bytes exceed the safety limit');
        }
        const hash = createHash('sha256');
        let outputFd;
        if (extractTo) {
          ensureDirectoryTree(extractTo, dirname(relativePath).replaceAll('\\', '/').replace(/^\.$/u, ''));
          const outputPath = outputPathWithin(extractTo, relativePath);
          outputFd = openSync(
            outputPath,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
            0o600,
          );
        }
        try {
          const buffer = Buffer.allocUnsafe(Math.min(IO_BUFFER_BYTES, Math.max(size, 1)));
          let consumed = 0;
          while (consumed < size) {
            const wanted = Math.min(buffer.length, size - consumed);
            readExactly(fd, buffer, 0, wanted, position + consumed);
            const chunk = buffer.subarray(0, wanted);
            hash.update(chunk);
            if (outputFd !== undefined) writeAll(outputFd, chunk);
            consumed += wanted;
          }
          if (outputFd !== undefined) fsyncSync(outputFd);
        } finally {
          if (outputFd !== undefined) closeSync(outputFd);
        }
        files.push({ path: relativePath, bytes: size, sha256: hash.digest('hex') });
      }
      position += padded;
      if (position > archive.size) throw new Error('Document archive entry exceeds the archive boundary');
    }
  } catch (error) {
    if (extractTo) rmSync(extractTo, { recursive: true, force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
  if (zeroBlocks < 2) {
    if (extractTo) rmSync(extractTo, { recursive: true, force: true });
    throw new Error('Document archive is missing its two-block end marker');
  }
  if (pendingExtendedPath !== undefined) {
    if (extractTo) rmSync(extractTo, { recursive: true, force: true });
    throw new Error('Document archive ends with unused path metadata');
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    archiveBytes: archive.size,
    fileCount: files.length,
    totalFileBytes,
    inventorySha256: sha256Buffer(Buffer.from(JSON.stringify(files), 'utf8')),
    files,
  };
}

function safeArtifactPath(recoverySetPath, fileName, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  if (typeof fileName !== 'string' || basename(fileName) !== fileName || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u.test(fileName)) {
    throw new Error(`${label} file name is unsafe`);
  }
  const path = join(recoverySetPath, fileName);
  regularFile(path, label, maximumBytes);
  return path;
}

function verifyArtifactDescriptor(recoverySetPath, descriptor, label) {
  if (!descriptor || typeof descriptor !== 'object') throw new Error(`${label} descriptor is missing`);
  const path = safeArtifactPath(recoverySetPath, descriptor.file, label);
  const status = statSync(path);
  if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes !== status.size) throw new Error(`${label} byte size does not match its manifest`);
  if (!SHA256.test(descriptor.sha256) || sha256RecoveryFile(path) !== descriptor.sha256) throw new Error(`${label} SHA-256 does not match its manifest`);
  if (!Number.isSafeInteger(descriptor.plaintextBytes) || descriptor.plaintextBytes <= 0) throw new Error(`${label} plaintext byte size is invalid`);
  if (!SHA256.test(descriptor.plaintextSha256)) throw new Error(`${label} plaintext SHA-256 is invalid`);
  const encryption = descriptor.encryption;
  if (!encryption || ![NON_ENCRYPTED_ARTIFACT_FORMAT, ENCRYPTED_ARTIFACT_FORMAT].includes(encryption.format)) {
    throw new Error(`${label} encryption descriptor is invalid`);
  }
  if (encryption.format === ENCRYPTED_ARTIFACT_FORMAT && !SHA256.test(encryption.keySha256 ?? '')) {
    throw new Error(`${label} encryption key fingerprint is invalid`);
  }
  return { path, status, descriptor, encryption };
}

function materializeArtifact(artifact, stagingDirectory, keyRecord, label, recoverySetId) {
  if (artifact.encryption.format === NON_ENCRYPTED_ARTIFACT_FORMAT) {
    if (
      artifact.descriptor.bytes !== artifact.descriptor.plaintextBytes ||
      artifact.descriptor.sha256 !== artifact.descriptor.plaintextSha256
    ) {
      throw new Error(`${label} plaintext descriptor is inconsistent`);
    }
    return artifact.path;
  }
  if (!keyRecord) throw new Error(`${label} requires --encryption-key-file`);
  if (artifact.encryption.keySha256 !== keyRecord.keySha256) throw new Error(`${label} encryption key fingerprint does not match`);
  const outputPath = join(stagingDirectory, `${label.replaceAll(' ', '-')}.plaintext`);
  const result = decryptPersonalServerArtifact({
    inputPath: artifact.path,
    outputPath,
    key: keyRecord.key,
    aadContext: `${recoverySetId}:${label}`,
  });
  if (result.bytes !== artifact.descriptor.plaintextBytes || result.sha256 !== artifact.descriptor.plaintextSha256) {
    rmSync(outputPath, { force: true });
    throw new Error(`${label} decrypted content does not match its manifest`);
  }
  return outputPath;
}

function parseJsonFile(path, label, maximumBytes) {
  regularFile(path, label, maximumBytes);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function validateDatabaseProof(proof, manifest, descriptor) {
  if (
    proof?.format !== 'charitypilot-postgres-restore-proof/v2' ||
    proof.ok !== true ||
    proof.recoverySetId !== manifest.recoverySetId ||
    proof.sourceIdentityBindingMatched !== true ||
    proof.sourceReadOnlyVerified !== true ||
    proof.restoreTarget?.cleanupVerified !== true ||
    proof.restoreTarget?.productionOverwritten !== false ||
    proof.comparison?.mismatchCount !== 0 ||
    proof.comparison?.rowFingerprintsMatched !== true ||
    proof.comparison?.databaseFingerprintMatched !== true ||
    proof.dump?.sha256 !== descriptor.plaintextSha256 ||
    Number(proof.dump?.bytes) !== descriptor.plaintextBytes ||
    proof.source?.databaseFingerprintSha256 !== descriptor.contentFingerprintSha256
  ) {
    throw new Error('Database restore proof does not bind a complete matching source and isolated restore');
  }
}

function validateApplicationIdentity(value) {
  if (
    value?.format !== 'charitypilot-personal-server-application-identity/v1' ||
    !/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(value?.imageTag ?? '') ||
    !value?.images || typeof value.images !== 'object' || Array.isArray(value.images)
  ) throw new Error('Recovery application identity is invalid');
  for (const role of ['api', 'migrations', 'web']) {
    const image = value.images[role];
    if (
      image?.name !== `charitypilot-personal-server-${role === 'migrations' ? 'migrations' : role}:${value.imageTag}` ||
      !/^sha256:[a-f0-9]{64}$/u.test(image?.id ?? '')
    ) throw new Error(`Recovery ${role} image identity is invalid`);
  }
  const source = value.source;
  if (
    !source || typeof source !== 'object' ||
    !['release-bundle', 'clean-git', 'unmanaged-local'].includes(source.kind) ||
    (source.kind === 'release-bundle' && (!/^personal-v\d+\.\d+\.\d+$/u.test(source.tag ?? '') || !/^[a-f0-9]{40}$/u.test(source.commitSha ?? ''))) ||
    (source.kind === 'clean-git' && !/^[a-f0-9]{40}$/u.test(source.commitSha ?? ''))
  ) throw new Error('Recovery source identity is invalid');
}

export function verifyPersonalServerRecoverySet({
  recoverySetPath,
  expectedProject,
  expectedOrigin,
  encryptionKeyFile,
  extractDocuments = true,
  materialize = true,
}) {
  const resolvedSet = resolve(recoverySetPath);
  const setStatus = lstatSync(resolvedSet);
  if (!setStatus.isDirectory() || setStatus.isSymbolicLink()) throw new Error('Recovery set must be a real non-symbolic-link directory');
  const manifestPath = safeArtifactPath(resolvedSet, 'manifest.json', 'Recovery manifest', MAX_MANIFEST_BYTES);
  const manifestHashPath = safeArtifactPath(resolvedSet, 'manifest.sha256', 'Recovery manifest checksum', 1024);
  const hashLine = readFileSync(manifestHashPath, 'utf8');
  const match = /^([a-f0-9]{64})  manifest\.json\r?\n?$/u.exec(hashLine);
  if (!match || sha256RecoveryFile(manifestPath) !== match[1]) throw new Error('Recovery manifest checksum is invalid');
  const manifest = parseJsonFile(manifestPath, 'Recovery manifest', MAX_MANIFEST_BYTES);
  if (
    manifest.format !== 'charitypilot-personal-server-backup/v2' ||
    manifest.project !== expectedProject ||
    !SAFE_RECOVERY_ID.test(manifest.recoverySetId ?? '') ||
    manifest.origin !== expectedOrigin ||
    manifest.writersQuiesced !== true
  ) {
    throw new Error('Recovery manifest identity does not match this personal server');
  }
  validateApplicationIdentity(manifest.application);
  if (basename(resolvedSet) !== manifest.recoverySetId) {
    throw new Error('Recovery-set directory name does not match its authenticated recovery-set ID');
  }
  const database = verifyArtifactDescriptor(resolvedSet, manifest.database, 'Database artifact');
  const documents = verifyArtifactDescriptor(resolvedSet, manifest.documents, 'Document artifact');
  const proofDescriptor = manifest.database.restoreProof;
  if (!proofDescriptor || typeof proofDescriptor !== 'object') throw new Error('Database restore proof descriptor is missing');
  const proofPath = safeArtifactPath(resolvedSet, proofDescriptor.file, 'Database restore proof', MAX_PROOF_BYTES);
  if (
    statSync(proofPath).size !== proofDescriptor.bytes ||
    !SHA256.test(proofDescriptor.sha256 ?? '') ||
    sha256RecoveryFile(proofPath) !== proofDescriptor.sha256
  ) {
    throw new Error('Database restore proof does not match its manifest');
  }
  const proof = parseJsonFile(proofPath, 'Database restore proof', MAX_PROOF_BYTES);
  validateDatabaseProof(proof, manifest, database.descriptor);

  const keyRecord = encryptionKeyFile ? loadPersonalServerEncryptionKey(encryptionKeyFile) : undefined;
  const encryptedArtifacts = [database, documents].filter(({ encryption }) => encryption.format === ENCRYPTED_ARTIFACT_FORMAT);
  if (encryptedArtifacts.length !== 0 && encryptedArtifacts.length !== 2) {
    throw new Error('Recovery set must not mix encrypted and plaintext primary artifacts');
  }
  if (encryptedArtifacts.length === 2) {
    if (!keyRecord) throw new Error('Encrypted recovery set requires --encryption-key-file');
    const authentication = manifest.authentication;
    if (
      authentication?.format !== MANIFEST_AUTHENTICATION_FORMAT ||
      authentication?.file !== 'manifest.hmac-sha256' ||
      authentication?.keySha256 !== keyRecord.keySha256
    ) {
      throw new Error('Recovery manifest authentication descriptor is invalid');
    }
    const authenticationPath = safeArtifactPath(resolvedSet, authentication.file, 'Recovery manifest authentication', 1024);
    const authenticationText = readFileSync(authenticationPath, 'utf8');
    const authenticationMatch = /^([a-f0-9]{64})  manifest\.json\r?\n?$/u.exec(authenticationText);
    const expectedAuthentication = hmacPersonalServerRecoveryManifest(manifestPath, keyRecord.key);
    if (
      !authenticationMatch ||
      !timingSafeEqual(Buffer.from(authenticationMatch[1], 'hex'), Buffer.from(expectedAuthentication, 'hex'))
    ) {
      throw new Error('Recovery manifest authentication failed');
    }
  }
  for (const [label, artifact] of [['Database artifact', database], ['Document artifact', documents]]) {
    if (artifact.encryption.format === ENCRYPTED_ARTIFACT_FORMAT) {
      if (!keyRecord) throw new Error(`${label} requires --encryption-key-file`);
      if (artifact.encryption.keySha256 !== keyRecord.keySha256) {
        throw new Error(`${label} encryption key fingerprint does not match`);
      }
    }
  }
  if (!materialize) {
    return {
      recoverySetPath: resolvedSet,
      manifest,
      databaseProof: proof,
      materialized: false,
    };
  }

  const stagingDirectory = mkdtempSync(join(tmpdir(), RECOVERY_STAGING_PREFIX));
  let complete = false;
  try {
    const databasePath = materializeArtifact(database, stagingDirectory, keyRecord, 'database', manifest.recoverySetId);
    const documentArchivePath = materializeArtifact(documents, stagingDirectory, keyRecord, 'documents', manifest.recoverySetId);
    const documentsPath = join(stagingDirectory, 'documents');
    const documentInventory = inspectPersonalServerDocumentArchive(
      documentArchivePath,
      extractDocuments ? { extractTo: documentsPath } : {},
    );
    if (
      documentInventory.fileCount !== documents.descriptor.fileCount ||
      documentInventory.totalFileBytes !== documents.descriptor.totalFileBytes ||
      documentInventory.inventorySha256 !== documents.descriptor.inventorySha256
    ) {
      throw new Error('Document archive inventory does not match its manifest');
    }
    complete = true;
    return {
      recoverySetPath: resolvedSet,
      stagingDirectory,
      manifest,
      databaseProof: proof,
      databasePath,
      documentArchivePath,
      documentsPath: extractDocuments ? documentsPath : undefined,
      documentInventory,
    };
  } finally {
    if (!complete) cleanupPersonalServerRecoveryStaging(stagingDirectory);
  }
}

export function cleanupPersonalServerRecoveryStaging(path) {
  if (!path) return;
  const resolved = resolve(path);
  const tempRoot = resolve(tmpdir());
  const relation = relative(tempRoot, resolved);
  if (
    !basename(resolved).startsWith(RECOVERY_STAGING_PREFIX) ||
    !relation ||
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new Error('Refusing to remove a recovery staging path outside the operating-system temporary directory');
  }
  rmSync(resolved, { recursive: true, force: true });
}

export const personalServerRecoveryFormats = Object.freeze({
  encryptedArtifact: ENCRYPTED_ARTIFACT_FORMAT,
  manifestAuthentication: MANIFEST_AUTHENTICATION_FORMAT,
  plaintextArtifact: NON_ENCRYPTED_ARTIFACT_FORMAT,
});
