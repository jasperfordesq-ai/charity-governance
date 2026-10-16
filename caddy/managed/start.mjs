import { readFile, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { gatewayConfiguration } from './config.mjs';

let directory, file;
let stage = 'build-pin';
async function cleanup() {
  if (file) await unlink(file).catch(() => {});
  if (directory) await rmdir(directory).catch(() => {});
}
try {
  const build = JSON.parse(
    await readFile(new URL('./build.json', import.meta.url), 'utf8'),
  );
  stage = 'binding';
  const config = gatewayConfiguration(process.env, build);
  stage = 'temporary-directory';
  directory = await mkdtemp(join(tmpdir(), 'charitypilot-gateway-'));
  stage = 'temporary-file';
  file = join(directory, 'Caddyfile');
  await writeFile(file, config, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  stage = 'caddy-process';
  const child = spawn(
    'caddy',
    ['run', '--config', file, '--adapter', 'caddyfile'],
    { stdio: 'inherit' },
  );
  const terminate = () => child.kill('SIGTERM');
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  child.once('error', async () => {
    console.error('Managed gateway process failed');
    await cleanup();
    process.exitCode = 1;
  });
  child.once('exit', async (code, signal) => {
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', interrupt);
    await cleanup();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  await cleanup();
  const code =
    typeof error?.code === 'string' && /^[A-Z_]{1,32}$/.test(error.code)
      ? ':' + error.code
      : '';
  console.error('Managed gateway startup refused (' + stage + code + ')');
  process.exitCode = 1;
}
