import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createManagedApiBuildPin(environment) {
  const hash = environment.CHARITYPILOT_MANAGED_API_PEER_BINDING_SHA256;
  const source = environment.CHARITYPILOT_BUILD_COMMIT;
  if (!hash) return { format: 1, sourceSha: null, bindingSha256: null };
  if (!/^[a-f0-9]{64}$/.test(hash) || !/^[a-f0-9]{40}$/.test(source ?? '')) {
    throw new Error(
      'Managed API image requires exact source and binding fingerprints',
    );
  }
  return { format: 1, sourceSha: source, bindingSha256: hash };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const output = process.argv[2];
  if (!output) throw new Error('Managed API build-pin destination is required');
  const pin = createManagedApiBuildPin(process.env);
  mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
  writeFileSync(output, JSON.stringify(pin) + '\n', {
    flag: 'wx',
    mode: 0o444,
  });
}
