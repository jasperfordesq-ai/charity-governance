import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
export function createManagedWebBuildPin(env) {
  const hash = env.NEXT_PUBLIC_CHARITYPILOT_MANAGED_WEB_BINDING_SHA256,
    source = env.CHARITYPILOT_BUILD_COMMIT;
  if (!hash) return { format: 1, sourceSha: null, bindingSha256: null };
  if (!/^[a-f0-9]{64}$/.test(hash) || !/^[a-f0-9]{40}$/.test(source ?? ""))
    throw new Error(
      "Managed web image requires exact source and binding fingerprints",
    );
  return { format: 1, sourceSha: source, bindingSha256: hash };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const output = process.argv[2];
  if (!output) throw new Error("Managed web pin destination required");
  mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
  writeFileSync(
    output,
    JSON.stringify(createManagedWebBuildPin(process.env)) + "\n",
    { flag: "wx", mode: 0o444 },
  );
}
