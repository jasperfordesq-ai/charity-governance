import { writeFileSync } from 'node:fs';
const sourceSha = process.env.CHARITYPILOT_BUILD_COMMIT;
const bindingSha256 = process.env.CHARITYPILOT_MANAGED_GATEWAY_BINDING_SHA256;
if (
  !/^[a-f0-9]{40}$/.test(sourceSha ?? '') ||
  !/^[a-f0-9]{64}$/.test(bindingSha256 ?? '')
) {
  console.error(
    'Managed gateway build requires exact source and binding fingerprints',
  );
  process.exit(1);
}
writeFileSync(
  new URL('./build.json', import.meta.url),
  JSON.stringify({ sourceSha, bindingSha256 }) + '\n',
  { flag: 'wx', mode: 0o444 },
);
