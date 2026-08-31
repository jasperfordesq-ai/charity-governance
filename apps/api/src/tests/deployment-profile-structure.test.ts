import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Only the appliance LIFECYCLE may key on isPersonalServerDeployment().
// Behavioural code keys on a capability axis in utils/deployment-profile.ts.
// Adding a file here means you are writing appliance-lifecycle code — say
// why in the commit message.
const ALLOWED = new Set([
  'utils/personal-server.ts',
  'utils/personal-server-env.ts',
  'utils/deployment-profile.ts',
  'jobs/initialize-personal-server.ts',
  'jobs/personal-server-account.ts',
  'services/password-recovery.service.ts', // audit labels describe the appliance operator flow — deliberate
]);

const SRC = path.join(process.cwd(), 'src');

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) return [];
      return [full];
    }),
  );
  return files.flat();
}

test('only allowlisted appliance-lifecycle files reference isPersonalServerDeployment', async () => {
  const files = await sourceFiles(SRC);
  const offenders: string[] = [];

  for (const file of files) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    if (ALLOWED.has(relative)) continue;

    const source = await readFile(file, 'utf8');
    if (source.includes('isPersonalServerDeployment')) offenders.push(relative);
  }

  assert.deepEqual(
    offenders,
    [],
    `unexpected consumers of isPersonalServerDeployment (add to ALLOWED with a reason, or re-key onto the capability axis): ${offenders.join(', ')}`,
  );
});

test('no route or service file outside the allowlist references CHARITYPILOT_DEPLOYMENT_MODE directly', async () => {
  const dirs = [path.join(SRC, 'routes'), path.join(SRC, 'services')];
  const offenders: string[] = [];

  for (const dir of dirs) {
    const files = await sourceFiles(dir);
    for (const file of files) {
      const relative = path.relative(SRC, file).split(path.sep).join('/');
      if (ALLOWED.has(relative)) continue;

      const source = await readFile(file, 'utf8');
      if (source.includes('CHARITYPILOT_DEPLOYMENT_MODE')) offenders.push(relative);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `unexpected direct reference(s) to CHARITYPILOT_DEPLOYMENT_MODE outside the lifecycle allowlist (behavioural code must key on the capability axis instead): ${offenders.join(', ')}`,
  );
});
