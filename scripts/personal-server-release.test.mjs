import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(root, '.github/workflows/personal-server-release.yml'), 'utf8');
const ciWorkflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const e2eWorkflow = readFileSync(resolve(root, '.github/workflows/e2e.yml'), 'utf8');

test('personal releases are immutable annotated tags on current canonical master', () => {
  assert.match(workflow, /tags:\s*\n\s*- 'personal-v\*'/u);
  assert.match(workflow, /personal-vMAJOR\.MINOR\.PATCH/u);
  assert.match(workflow, /\^personal-v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/u);
  assert.match(workflow, /git cat-file -t/u);
  assert.match(workflow, /annotated tag/u);
  assert.match(workflow, /GITHUB_SHA.*git rev-parse refs\/remotes\/canonical\/master/u);
  assert.match(workflow, /refs\/remotes\/canonical\/master/u);
  assert.match(workflow, /git status --porcelain=v1 --untracked-files=all/u);
});

test('personal release packaging is source-bound and independently checksummed', () => {
  assert.match(workflow, /git archive --format=zip/u);
  assert.match(workflow, /--add-virtual-file="\$\{base\}\/personal-server-release\.json:/u);
  assert.match(workflow, /charitypilot-personal-server-bundle\/v1/u);
  assert.match(workflow, /"\$\{GITHUB_SHA\}"/u);
  assert.match(workflow, /sha256sum/u);
  assert.match(workflow, /charitypilot-personal-server-release\/v1/u);
  assert.match(workflow, /commitSha/u);
  assert.match(workflow, /archiveSha256/u);
  assert.match(workflow, /trackedFileCount/u);
  assert.match(workflow, /scripts\/Install-CharityPilot\.ps1/u);
});

test('personal release publication refuses replacement and uses pinned first-party actions', () => {
  assert.match(workflow, /actions\/checkout@[a-f0-9]{40}/u);
  assert.match(workflow, /actions\/setup-node@[a-f0-9]{40}/u);
  assert.match(workflow, /actions\/attest-build-provenance@[a-f0-9]{40}/u);
  assert.match(workflow, /actions\/download-artifact@[a-f0-9]{40}/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /attestations: write/u);
  assert.match(workflow, /subject-path:/u);
  assert.match(workflow, /gh release view/u);
  assert.match(workflow, /refusing to replace immutable assets/u);
  assert.match(workflow, /gh release create/u);
  assert.match(workflow, /--draft/u);
  assert.match(workflow, /gh release edit/u);
  assert.match(workflow, /assets_verified=false/u);
  assert.match(workflow, /Draft release asset digests did not become verifiable[\s\S]+cleanup_failed_release/u);
  assert.match(workflow, /\.immutable == true/u);
  assert.match(workflow, /immutable-releases/u);
  assert.match(workflow, /PERSONAL_RELEASE_ADMIN_READ_TOKEN/u);
  assert.match(workflow, /environment:\s*personal-server-release/u);
  assert.match(workflow, /current canonical master commit/u);
  assert.match(workflow, /bypass_actors/u);
  assert.match(workflow, /cleanup_armed=true/u);
  assert.match(workflow, /Published release did not become immutable[\s\S]+cleanup_failed_release/u);
  assert.match(workflow, /\.immutable == false/u);
  assert.match(workflow, /refs\/tags\/personal-v\*/u);
  assert.match(workflow, /git\/ref\/tags\/\$\{GITHUB_REF_NAME\}/u);
  assert.match(workflow, /git\/tags\/\$\{tag_sha\}/u);
  assert.match(workflow, /git\/ref\/heads\/master/u);
  assert.match(workflow, /--verify-tag/u);
  assert.match(workflow, /contents: write/u);
});

test('personal release runs profile contracts and source scanning before publication', () => {
  assert.match(workflow, /ci:\s*[\s\S]*uses: \.\/\.github\/workflows\/ci\.yml/u);
  assert.match(workflow, /e2e:\s*[\s\S]*uses: \.\/\.github\/workflows\/e2e\.yml/u);
  assert.match(workflow, /windows-verify:/u);
  assert.match(workflow, /windows-verify:\s*[\s\S]*needs:\s*\n\s*- verify/u);
  assert.match(workflow, /Verify and extract exact candidate on Windows/u);
  assert.match(workflow, /CANDIDATE_ROOT/u);
  assert.match(workflow, /personal-server-release-archive\.ps1/u);
  assert.match(workflow, /Update-CharityPilot\.ps1/u);
  assert.match(workflow, /npm run test:personal-server/u);
  assert.match(workflow, /needs:\s*\n\s*- ci\s*\n\s*- e2e\s*\n\s*- verify\s*\n\s*- windows-verify/u);
  assert.match(workflow, /persist-credentials: false/u);
  const testsIndex = workflow.indexOf('npm run test:personal-server');
  const candidateIndex = workflow.indexOf('Upload verified release candidate');
  const releaseIndex = workflow.indexOf('gh release create');
  assert.ok(testsIndex > -1 && testsIndex < releaseIndex);
  assert.ok(candidateIndex > -1 && candidateIndex < releaseIndex);
});

test('reusable release gates pin the exact runtime and do not persist checkout credentials', () => {
  for (const value of [ciWorkflow, e2eWorkflow]) {
    assert.match(value, /workflow_call:/u);
    assert.match(value, /22\.23\.1/u);
    assert.match(value, /11\.11\.0/u);
    assert.match(value, /persist-credentials: false/u);
    assert.match(value, /npm install --global npm@/u);
    assert.match(value, /node --version/u);
    assert.match(value, /npm --version/u);
  }
});
