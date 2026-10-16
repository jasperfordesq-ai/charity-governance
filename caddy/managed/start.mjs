import { readFile, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { gatewayConfiguration, gatewayRuntimeBinding } from './config.mjs';
import { readGatewayTlsMaterial } from './tls.mjs';

let directory, file;
const materialFiles = [];
let stage = 'build-pin';
async function cleanup() {
  if (file) await unlink(file).catch(() => {});
  for (const item of materialFiles) await unlink(item).catch(() => {});
  if (directory) await rmdir(directory).catch(() => {});
}
try {
  const build = JSON.parse(
    await readFile(new URL('./build.json', import.meta.url), 'utf8'),
  );
  stage = 'binding';
  const binding = gatewayRuntimeBinding(process.env, build);
  stage = 'protected-material';
  const material = readGatewayTlsMaterial(
    process.env.CHARITYPILOT_MANAGED_GATEWAY_TLS_DIRECTORY,
    binding.record,
  );
  stage = 'temporary-directory';
  directory = await mkdtemp(join('/tmp', 'charitypilot-gateway-'));
  for (const [name, bytes] of Object.entries(material)) {
    const path = join(directory, name);
    materialFiles.push(path);
    await writeFile(path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o400 });
  }
  const config = gatewayConfiguration(process.env, build, directory);
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
