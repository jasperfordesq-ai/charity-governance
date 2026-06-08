const fs = require('node:fs');
const path = require('node:path');

const originalRm = fs.promises.rm.bind(fs.promises);
const originalUnlink = fs.promises.unlink.bind(fs.promises);
const originalRename = fs.promises.rename.bind(fs.promises);
const originalCopyFile = fs.promises.copyFile.bind(fs.promises);
const retryableCodes = new Set(['EBUSY', 'EMFILE', 'ENOTEMPTY', 'EPERM']);
const maxAttempts = Number.parseInt(process.env.NEXT_BUILD_RM_RETRY_ATTEMPTS ?? '60', 10);
const maxDelayMs = Number.parseInt(process.env.NEXT_BUILD_RM_RETRY_MAX_DELAY_MS ?? '500', 10);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt) {
  return Math.min(25 * 2 ** attempt, maxDelayMs);
}

function isNextExportCleanup(target, options) {
  const normalized = path.normalize(String(target));
  const parts = normalized.split(path.sep);
  const exportIndex = parts.length - 1;
  const distDir = parts[exportIndex - 1] ?? '';

  return (
    options?.recursive === true &&
    options?.force === true &&
    parts[exportIndex] === 'export' &&
    (distDir === '.next' || distDir.startsWith('.next-build'))
  );
}

function isNextExportDetail(target) {
  const normalized = path.normalize(String(target));
  const parts = normalized.split(path.sep);
  const fileIndex = parts.length - 1;
  const distDir = parts[fileIndex - 1] ?? '';

  return (
    parts[fileIndex] === 'export-detail.json' &&
    (distDir === '.next' || distDir.startsWith('.next-build'))
  );
}

function isNextProxyArtifactRename(source, destination) {
  const normalizedSource = path.normalize(String(source));
  const normalizedDestination = path.normalize(String(destination));
  const sourceParts = normalizedSource.split(path.sep);
  const destinationParts = normalizedDestination.split(path.sep);
  const sourceFile = sourceParts.at(-1);
  const destinationFile = destinationParts.at(-1);
  const sourceParent = sourceParts.at(-2);
  const destinationParent = destinationParts.at(-2);
  const sourceDistDir = sourceParts.at(-3) ?? '';
  const destinationDistDir = destinationParts.at(-3) ?? '';

  return (
    sourceParent === 'server' &&
    destinationParent === 'server' &&
    sourceDistDir === destinationDistDir &&
    (sourceDistDir === '.next' || sourceDistDir.startsWith('.next-build')) &&
    (
      (sourceFile === 'proxy.js' && destinationFile === 'middleware.js') ||
      (sourceFile === 'proxy.js.nft.json' && destinationFile === 'middleware.js.nft.json')
    )
  );
}

fs.promises.rm = async function retryingRm(target, options) {
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await originalRm(target, options);
    } catch (error) {
      lastError = error;

      if (!retryableCodes.has(error?.code)) {
        throw error;
      }

      await delay(retryDelay(attempt));
    }
  }

  if (retryableCodes.has(lastError?.code) && isNextExportCleanup(target, options)) {
    return undefined;
  }

  throw lastError;
};

fs.promises.unlink = async function retryingUnlink(target) {
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await originalUnlink(target);
    } catch (error) {
      lastError = error;

      if (!retryableCodes.has(error?.code)) {
        throw error;
      }

      await delay(retryDelay(attempt));
    }
  }

  if (retryableCodes.has(lastError?.code) && isNextExportDetail(target)) {
    return undefined;
  }

  throw lastError;
};

fs.promises.rename = async function retryingRename(source, destination) {
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await originalRename(source, destination);
    } catch (error) {
      lastError = error;

      if (!retryableCodes.has(error?.code)) {
        throw error;
      }

      await delay(retryDelay(attempt));
    }
  }

  if (retryableCodes.has(lastError?.code) && isNextProxyArtifactRename(source, destination)) {
    await originalCopyFile(source, destination);
    try {
      await originalUnlink(source);
    } catch (error) {
      if (!retryableCodes.has(error?.code)) throw error;
    }
    return undefined;
  }

  throw lastError;
};
