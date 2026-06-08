import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

const generatedPathParts = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
]);

const secretDetectors = [
  {
    id: 'stripe-secret-key',
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9_]{12,}\b/g,
  },
  {
    id: 'stripe-webhook-secret',
    pattern: /\bwhsec_[A-Za-z0-9_]{8,}\b/g,
  },
  {
    id: 'resend-api-key',
    pattern: /\bre_[A-Za-z0-9_]{8,}\b/g,
  },
  {
    id: 'github-token',
    pattern: /\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    id: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'jwt-token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
];

const sastDetectors = [
  {
    id: 'dangerous-eval',
    pattern: /\beval\s*\(/g,
  },
  {
    id: 'dangerous-function-constructor',
    pattern: /\bnew\s+Function\s*\(/g,
  },
  {
    id: 'prisma-raw-unsafe',
    pattern: /\.\$(?:queryRawUnsafe|executeRawUnsafe)\s*\(/g,
  },
  {
    id: 'tls-verification-disabled',
    pattern: /\brejectUnauthorized\s*:\s*false\b|\bNODE_TLS_REJECT_UNAUTHORIZED\b/g,
  },
  {
    id: 'jwt-ignore-expiration',
    pattern: /\bignoreExpiration\s*:\s*true\b/g,
  },
];

function usage() {
  return 'Usage: node scripts/security-scan.mjs <secrets|sast|scan> [--path <path>...]\n';
}

function parseArgs(argv) {
  const [mode = 'scan', ...rest] = argv;
  const paths = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--path') {
      const next = rest[index + 1];
      if (!next) {
        throw new Error('--path requires a value');
      }
      paths.push(next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--path=')) {
      paths.push(arg.slice('--path='.length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!['secrets', 'sast', 'scan'].includes(mode)) {
    throw new Error(`Unknown scan mode: ${mode}`);
  }

  return { mode, paths };
}

function normalizePath(path) {
  return path.split(sep).join('/');
}

function isGeneratedPath(path, options = {}) {
  const normalized = normalizePath(path);
  const parts = normalized.split('/');
  const fileName = parts.at(-1) ?? '';

  if (options.skipLocalEnvFiles && /^\.env(?:$|[.-])/.test(fileName) && !fileName.endsWith('.example')) {
    return true;
  }

  return parts.some((part) => (
    generatedPathParts.has(part) ||
    part.startsWith('.codex-') ||
    part.startsWith('.next-build') ||
    part === '.charitypilot-backups'
  ));
}

function isLikelyBinary(content) {
  return content.includes('\u0000');
}

function collectFilesUnder(targetPath, displayRoot, options = {}) {
  const stats = statSync(targetPath);
  if (stats.isFile()) {
    return [{
      absolutePath: targetPath,
      displayPath: normalizePath(relative(displayRoot, targetPath)) || normalizePath(targetPath),
    }];
  }

  if (!stats.isDirectory()) return [];

  return readdirSync(targetPath, { withFileTypes: true }).flatMap((entry) => {
    const childPath = join(targetPath, entry.name);
    const relativePath = relative(displayRoot, childPath);
    if (isGeneratedPath(relativePath, options)) return [];
    if (entry.isDirectory()) return collectFilesUnder(childPath, displayRoot, options);
    if (!entry.isFile()) return [];
    return [{
      absolutePath: childPath,
      displayPath: normalizePath(relative(displayRoot, childPath)),
    }];
  });
}

function trackedRepoFiles({ scanRoot = repoRoot, stderr = (message) => process.stderr.write(message), processEnv = process.env } = {}) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: scanRoot,
    encoding: 'utf8',
    env: processEnv,
  });

  if (result.status !== 0) {
    const reason = result.stderr?.trim() || result.error?.message || `exit status ${result.status}`;
    stderr(`git ls-files unavailable (${reason}); scanning working tree fallback.\n`);
    return collectFilesUnder(scanRoot, scanRoot, { skipLocalEnvFiles: true });
  }

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .filter((path) => !isGeneratedPath(path))
    .map((path) => ({
      absolutePath: join(scanRoot, path),
      displayPath: normalizePath(path),
    }))
    .filter(({ absolutePath }) => existsSync(absolutePath));
}

function targetFiles(paths, context = {}) {
  const scanRoot = context.scanRoot ?? repoRoot;
  if (paths.length === 0) return trackedRepoFiles({ ...context, scanRoot });

  return paths.flatMap((path) => {
    const resolvedPath = resolve(scanRoot, path);
    if (!existsSync(resolvedPath)) {
      throw new Error(`scan path does not exist: ${path}`);
    }
    const displayRoot = statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath);
    return collectFilesUnder(resolvedPath, displayRoot);
  });
}

function readTextFile(file) {
  const content = readFileSync(file.absolutePath, 'utf8');
  if (isLikelyBinary(content)) return null;
  return content;
}

function lineNumberForIndex(content, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function isTestOrFixtureFile(path) {
  return (
    /\.test\.(?:ts|tsx|js|mjs)$/.test(path) ||
    path.includes('/src/tests/') ||
    path.includes('/__fixtures__/')
  );
}

function isAllowedSecret({ value, file }) {
  if (value.includes('...')) return true;
  if (isTestOrFixtureFile(file)) return true;

  if (/^(?:sk_(?:live|test)|whsec|re)_configuredSecret$/.test(value)) return true;
  if (/^(?:sk_(?:live|test)|whsec|re)_ci_[A-Za-z0-9_]+$/.test(value)) return true;
  if (/^ci-[A-Za-z0-9-]+$/.test(value)) return true;

  if (file === '.env.example' || file === '.env.production.example') return true;
  if (file === 'apps/web/.env.local.example') return true;
  if (file === 'compose.local.yml') return true;
  if (file === 'scripts/check-production.mjs') return true;
  if (file === '.github/workflows/ci.yml' || file === '.github/workflows/release-images.yml') {
    return /(?:_ci_|ci-|GITHUB_TOKEN|example|charitypilot_ci)/.test(value);
  }

  return false;
}

function scanSecrets(files) {
  const findings = [];

  for (const file of files) {
    const content = readTextFile(file);
    if (content === null) continue;

    for (const detector of secretDetectors) {
      detector.pattern.lastIndex = 0;
      for (const match of content.matchAll(detector.pattern)) {
        const value = match[0];
        if (isAllowedSecret({ value, file: file.displayPath })) continue;

        findings.push({
          detector: detector.id,
          file: file.displayPath,
          line: lineNumberForIndex(content, match.index ?? 0),
        });
      }
    }
  }

  return findings;
}

function shouldSkipSastFile(path) {
  return isTestOrFixtureFile(path) || path.endsWith('.d.ts');
}

function scanSast(files) {
  const findings = [];

  for (const file of files) {
    if (shouldSkipSastFile(file.displayPath)) continue;

    const content = readTextFile(file);
    if (content === null) continue;

    for (const detector of sastDetectors) {
      detector.pattern.lastIndex = 0;
      for (const match of content.matchAll(detector.pattern)) {
        findings.push({
          detector: detector.id,
          file: file.displayPath,
          line: lineNumberForIndex(content, match.index ?? 0),
        });
      }
    }

    if (file.displayPath.startsWith('apps/') && /(?:from\s+['"]node:child_process['"]|require\(['"]node:child_process['"]\))/.test(content)) {
      findings.push({
        detector: 'app-runtime-child-process',
        file: file.displayPath,
        line: lineNumberForIndex(content, content.search(/node:child_process/)),
      });
    }
  }

  return findings;
}

function printFindings(label, findings, stderr = (message) => process.stderr.write(message)) {
  if (findings.length === 0) return;
  stderr(`${label} failed: ${findings.length} finding(s)\n`);
  for (const finding of findings) {
    stderr(`- ${finding.detector} ${finding.file}:${finding.line}\n`);
  }
}

function result(status, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

export function runSecurityScanFromArgs(args = process.argv.slice(2), {
  processEnv = process.env,
  scanRoot = repoRoot,
} = {}) {
  let stdout = '';
  let stderr = '';
  const writeStdout = (message) => {
    stdout += message;
  };
  const writeStderr = (message) => {
    stderr += message;
  };

  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, '', `${usage()}${error.message}\n`);
  }

  let files;
  try {
    files = targetFiles(options.paths, { scanRoot, stderr: writeStderr, processEnv });
  } catch (error) {
    return result(1, '', `Security scan failed: ${error.message}\n`);
  }

  let failed = false;

  if (options.mode === 'secrets' || options.mode === 'scan') {
    const findings = scanSecrets(files);
    if (findings.length > 0) {
      printFindings('Secret scan', findings, writeStderr);
      failed = true;
    } else {
      writeStdout(`Secret scan passed: scanned ${files.length} file(s).\n`);
    }
  }

  if (options.mode === 'sast' || options.mode === 'scan') {
    const findings = scanSast(files);
    if (findings.length > 0) {
      printFindings('SAST scan', findings, writeStderr);
      failed = true;
    } else {
      writeStdout(`SAST scan passed: scanned ${files.length} file(s).\n`);
    }
  }

  return result(failed ? 1 : 0, stdout, stderr);
}

function main() {
  const scanResult = runSecurityScanFromArgs();
  if (scanResult.stdout) process.stdout.write(scanResult.stdout);
  if (scanResult.stderr) process.stderr.write(scanResult.stderr);
  process.exit(scanResult.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
