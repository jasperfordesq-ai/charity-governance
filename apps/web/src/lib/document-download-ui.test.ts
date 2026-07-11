import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflow = readFileSync(
  join(process.cwd(), 'src', 'app', '(dashboard)', 'documents', 'use-documents-workflow.ts'),
  'utf8',
);
const urlSecurity = readFileSync(join(process.cwd(), 'src', 'lib', 'url-security.ts'), 'utf8');

test('document downloads stay on the authenticated API and use a short-lived browser blob', () => {
  assert.match(workflow, /\/documents\/\$\{encodeURIComponent\(doc\.id\)\}\/download/);
  assert.match(workflow, /responseType: 'blob'/);
  assert.match(workflow, /URL\.createObjectURL\(data\)/);
  assert.match(workflow, /URL\.revokeObjectURL\(objectUrl\)/);
  assert.match(workflow, /DOCUMENT_OBJECT_URL_REVOKE_DELAY_MS = 30_000/);
  assert.match(workflow, /anchor\.download = documentDownloadFilename\(doc\)/);
  assert.doesNotMatch(workflow, /data\?\.url/);
  assert.doesNotMatch(workflow, /window\.open\(downloadUrl/);
});

test('isolated production download trust exposes the public runner marker to the Next client bundle', () => {
  assert.match(
    urlSecurity,
    /isIsolatedE2eProduction\(\{[\s\S]*NODE_ENV: process\.env\.NODE_ENV,[\s\S]*NEXT_PUBLIC_CHARITYPILOT_E2E_MODE: process\.env\.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE/,
  );
  assert.doesNotMatch(urlSecurity, /isIsolatedE2eProduction\(process\.env\)/);
});
