import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Synthetic configuration only. Privileged operations and Windows ACL evidence
// must never be inferred from these content-validation fixtures.
export function productionRuntimeEnvFixtures(after) {
  const directory = mkdtempSync(join(tmpdir(), 'charitypilot-runtime-env-fixtures-'));
  let next = 0;
  after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('charitypilot-runtime-env-fixtures-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return values => {
    const runtimeFile = join(directory, `runtime-${++next}.env`);
    const runtimeValues = Object.fromEntries(Object.entries(values).filter(([key]) =>
      !/^(?:CHARITYPILOT_PRODUCTION_|CHARITYPILOT_(?:API_IMAGE|WEB_IMAGE|MIGRATION_IMAGE|DATABASE_COMPATIBILITY|WEB_BUILD_))/u.test(key)));
    runtimeValues.DATABASE_URL = String(values.DATABASE_URL).replace('user:pass@', 'cp_runtime:runtime-only-password@');
    const encode = entries => `${entries.map(([key, value]) => `${key}=${key === 'CHARITYPILOT_PRODUCTION_APP_ENV_FILE' ? `'${value}'` : value}`).join('\n')}\n`;
    writeFileSync(runtimeFile, encode(Object.entries(runtimeValues)), { mode: 0o600 });
    return encode(Object.entries({ ...values, CHARITYPILOT_PRODUCTION_APP_ENV_FILE: runtimeFile }));
  };
}
