import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, 'scripts', 'bluegreen-nightly-backup.sh');
const script = readFileSync(scriptPath, 'utf8');

test('nightly wrapper: strict mode, LF line endings, and it calls the engine backup subcommand with the VM env file', () => {
  assert.doesNotMatch(script, /\r/, 'must be LF-only (runs under Linux cron)');
  assert.match(script, /^set -euo pipefail$/m);
  assert.match(script, /npm run --silent bluegreen:backup -- --env-file "\$ENV_FILE"/);
  assert.match(script, /ENV_FILE="\$REPO_DIR\/\.bluegreen\/private-vm\.env"/);
  assert.match(script, /REPO_DIR="\$HOME\/charity-governance"/);
});

test('nightly wrapper: --install-cron replaces BOTH the appliance entry and any previous copy of itself', () => {
  assert.match(script, /grep -v 'charitypilot-backup\.sh'/);
  assert.match(script, /grep -v 'bluegreen-nightly-backup\.sh'/);
  assert.match(script, /^ {6}echo "30 3 \* \* \* \$HOME\/bin\/bluegreen-nightly-backup\.sh >\/dev\/null 2>&1" \) \| crontab -$/m);
});

test('nightly wrapper: parses under bash -n when bash is available', () => {
  const result = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
});
