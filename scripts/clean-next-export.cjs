const fs = require('node:fs/promises');
const path = require('node:path');

const retryableCodes = new Set(['EBUSY', 'EMFILE', 'ENOTEMPTY', 'EPERM']);

function resolveNextDistDir() {
  const distDir = process.env.NEXT_DIST_DIR?.trim();
  if (!distDir) return '.next';

  if (/[\\/]/.test(distDir) || distDir === '.' || distDir === '..' || distDir.includes('..')) {
    throw new Error('NEXT_DIST_DIR must be a project-local directory name.');
  }

  return distDir;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeErrorMessage(error) {
  const code = typeof error?.code === 'string' ? error.code : 'ERROR';
  const syscall = typeof error?.syscall === 'string' ? ` during ${error.syscall}` : '';
  return `${code}${syscall}`;
}

async function removeWithRetries(target) {
  let lastError;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!retryableCodes.has(error?.code)) throw error;
      await delay(Math.min(25 * 2 ** attempt, 500));
    }
  }

  throw lastError;
}

async function removeGeneratedArtifact(target) {
  try {
    await removeWithRetries(target);
  } catch (error) {
    if (!retryableCodes.has(error?.code)) throw error;
    console.warn(`Deferred cleanup could not remove ${path.basename(target)}: ${sanitizeErrorMessage(error)}`);
  }
}

async function main() {
  const projectRoot = process.cwd();
  const distDir = path.resolve(projectRoot, resolveNextDistDir());
  const exportDir = path.resolve(distDir, 'export');
  const exportDetailPath = path.resolve(distDir, 'export-detail.json');
  const staleProxyPath = path.resolve(distDir, 'server', 'proxy.js');
  const staleProxyTracePath = path.resolve(distDir, 'server', 'proxy.js.nft.json');
  const relativeExportDir = path.relative(projectRoot, exportDir);
  const relativeExportDetailPath = path.relative(projectRoot, exportDetailPath);
  const relativeStaleProxyPath = path.relative(projectRoot, staleProxyPath);
  const relativeStaleProxyTracePath = path.relative(projectRoot, staleProxyTracePath);

  if (
    relativeExportDir.startsWith('..') ||
    relativeExportDetailPath.startsWith('..') ||
    relativeStaleProxyPath.startsWith('..') ||
    relativeStaleProxyTracePath.startsWith('..') ||
    path.isAbsolute(relativeExportDir) ||
    path.isAbsolute(relativeExportDetailPath) ||
    path.isAbsolute(relativeStaleProxyPath) ||
    path.isAbsolute(relativeStaleProxyTracePath) ||
    path.basename(exportDir) !== 'export'
  ) {
    throw new Error(`Refusing to clean unsafe Next export path: ${exportDir}`);
  }

  await removeGeneratedArtifact(exportDir);
  await removeGeneratedArtifact(exportDetailPath);
  await removeGeneratedArtifact(staleProxyPath);
  await removeGeneratedArtifact(staleProxyTracePath);
}

main().catch((error) => {
  console.error(`Next cleanup failed: ${sanitizeErrorMessage(error)}`);
  process.exit(1);
});
