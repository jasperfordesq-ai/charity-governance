import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const statusScriptPath = join(scriptsDir, 'production-launch-evidence-status.mjs');
const templateScriptPath = join(scriptsDir, 'generate-production-launch-evidence-template.mjs');

async function loadStatusRunner() {
  assert.ok(existsSync(statusScriptPath), 'production launch evidence status script must exist');
  const module = await import(pathToFileURL(statusScriptPath).href);
  assert.equal(typeof module.runProductionLaunchEvidenceStatusFromArgs, 'function');
  return module;
}

async function launchEvidenceTemplate() {
  const module = await import(pathToFileURL(templateScriptPath).href);
  return JSON.parse(module.renderProductionLaunchEvidenceTemplate());
}

function writeEvidenceFile(evidence) {
  const tempDir = mkdtempSync(join(tmpdir(), 'charitypilot-launch-status-'));
  const evidencePath = join(tempDir, 'production-launch-evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  return { tempDir, evidencePath };
}

test('production launch evidence status reports pending template progress without approving launch', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();
  const evidence = await launchEvidenceTemplate();
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceStatusFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /CharityPilot production launch evidence status/);
    assert.match(result.stdout, /Evidence statuses complete: no/);
    assert.match(result.stdout, /Checklist checks complete: 0 \/ 87 \(0% complete\)/);
    assert.match(result.stdout, /Final approval roles approved: 0 \/ 5 \(0% complete\)/);
    assert.match(result.stdout, /releaseGate: 0 \/ 20 complete/);
    assert.match(result.stdout, /approvedForLaunch: false/);
    assert.match(result.stdout, /finalSignoff: pending/);
    assert.match(result.stdout, /Release binding: Launch evidence is not bound to a concrete release artifact identity/);
    assert.match(result.stdout, /Final approval roles still pending:/);
    assert.match(result.stdout, /engineering: pending/);
    assert.match(result.stdout, /legalCompliance: pending/);
    assert.match(result.stdout, /Next incomplete checks:/);
    assert.match(result.stdout, /releaseGate\.npm-ci/);
    assert.match(result.stdout, /evidence hints: npm ci; exit 0/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence status counts completed checks and keeps final approval separate', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();
  const evidence = await launchEvidenceTemplate();
  evidence.areas.releaseGate.checks['npm-ci'].status = 'complete';
  evidence.areas.releaseGate.checks['npm-ci'].evidence = [
    {
      type: 'command-output',
      reference: 'https://evidence.charitypilot.ie/launch/release/npm-ci',
      description: 'npm ci completed on the release build machine with exit 0.',
      capturedAt: '2026-07-06T12:00:00.000Z',
    },
  ];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceStatusFromArgs(['--evidence-file', evidencePath]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Checklist checks complete: 1 \/ 87 \(1\.1% complete\)/);
    assert.match(result.stdout, /Final approval roles approved: 0 \/ 5 \(0% complete\)/);
    assert.match(result.stdout, /releaseGate: 1 \/ 20 complete/);
    assert.match(result.stdout, /finalSignoff: pending/);
    assert.match(result.stdout, /releaseGate\.db-generate/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence status renders non-secret JSON for automation', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();
  const evidence = await launchEvidenceTemplate();
  evidence.areas.releaseGate.checks['npm-ci'].status = 'complete';
  evidence.finalSignoff.approvals.engineering.status = 'approved';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceStatusFromArgs(['--json', '--evidence-file', evidencePath]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.evidenceStatusesComplete, false);
    assert.equal(payload.approvedForLaunch, false);
    assert.equal(payload.completedChecks, 1);
    assert.equal(payload.releaseBinding.complete, false);
    assert.ok(payload.releaseBinding.missingFields.includes('release.commitSha'));
    assert.ok(payload.releaseBinding.missingFields.includes('release.workflowRunUrl'));
    assert.ok(payload.releaseBinding.missingFields.includes('release.imageDigestManifest.apiImage'));
    assert.equal(payload.totalChecks, 87);
    assert.equal(payload.approvedFinalSignoffRoles, 0);
    assert.equal(payload.totalFinalSignoffRoles, 5);
    assert.deepEqual(payload.percentages, {
      evidenceChecks: 1.1,
      finalSignoffs: 0,
    });
    assert.equal(payload.incompleteCheckCount, 86);
    assert.deepEqual(
      payload.pendingFinalSignoffRoles.map((role) => role.id),
      ['engineering', 'operations', 'security', 'legalCompliance', 'business'],
    );
    assert.equal(payload.pendingFinalSignoffRoles[0].status, 'approved_missing_release_commit');
    assert.match(payload.nextIncompleteChecks[0], /^releaseGate\.db-generate/);
    assert.equal(payload.nextIncompleteCheckDetails[0].path, 'releaseGate.db-generate');
    assert.deepEqual(payload.nextIncompleteCheckDetails[0].requiredEvidenceHints, [
      'npm run db:generate -w @charitypilot/api',
      'exit 0',
    ]);
    assert.equal(payload.areas.find((area) => area.id === 'releaseGate').completed, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence status exposes a grouped work queue for every incomplete area', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();
  const evidence = await launchEvidenceTemplate();
  evidence.areas.releaseGate.checks['npm-ci'].status = 'complete';
  evidence.areas.releaseGate.checks['db-generate'].status = 'complete';
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceStatusFromArgs(['--json', '--evidence-file', evidencePath]);

    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.ok(Array.isArray(payload.workQueueByArea));
    assert.equal(payload.workQueueByArea[0].id, 'releaseGate');
    assert.equal(payload.workQueueByArea[0].remaining, 18);
    assert.equal(payload.workQueueByArea[0].total, 20);
    assert.equal(payload.workQueueByArea[0].status, 'pending');
    assert.equal(payload.workQueueByArea[0].checks[0].path, 'releaseGate.prisma-validate');
    const checkProduction = payload.workQueueByArea[0].checks.find((check) => check.path === 'releaseGate.check-production');
    assert.ok(checkProduction);
    assert.deepEqual(checkProduction.requiredEvidenceHints, [
      'npm run check:production -- --production-env-file=.env.production',
      'Production preflight passed',
    ]);
    assert.ok(payload.workQueueByArea.some((area) => area.id === 'browserQa' && area.remaining === 7));
    assert.equal(
      payload.workQueueByArea.reduce((total, area) => total + area.remaining, 0),
      payload.incompleteCheckCount,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence status does not count unbound final approval roles', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();
  const evidence = await launchEvidenceTemplate();
  evidence.release.commitSha = 'b'.repeat(40);
  evidence.finalSignoff.approvals.engineering.status = 'approved';
  evidence.finalSignoff.approvals.engineering.evidence = [
    {
      type: 'approval',
      reference: 'https://evidence.charitypilot.ie/launch/final-signoff/engineering',
      description: 'Engineering owner launch approval',
      capturedAt: '2026-07-06T12:00:00.000Z',
    },
  ];
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceStatusFromArgs(['--json', '--evidence-file', evidencePath]);

    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.approvedFinalSignoffRoles, 0);
    assert.equal(payload.percentages.finalSignoffs, 0);
    assert.ok(
      payload.pendingFinalSignoffRoles.some(
        (role) => role.id === 'engineering' && role.status === 'approved_missing_release_commit',
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence status recognises the published migration image repository', async () => {
  const { releaseBindingStatus } = await loadStatusRunner();
  const digest = 'a'.repeat(64);
  const evidence = {
    release: {
      commitSha: 'b'.repeat(40),
      workflowRunUrl: 'https://github.com/jasperfordesq-ai/charity-governance/actions/runs/123456789',
      workflowFile: '.github/workflows/release-images.yml',
      gitRef: 'refs/heads/master',
      imageDigestManifest: {
        apiImage: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${digest}`,
        webImage: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${digest}`,
        migrationImage: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${digest}`,
        webBuildNextPublicApiUrl: 'https://api.charitypilot.ie',
        webBuildNextPublicSupabaseUrl: 'https://configured-project.supabase.co',
      },
    },
  };

  const pluralStatus = releaseBindingStatus(evidence);
  assert.equal(pluralStatus.complete, true);
  assert.deepEqual(pluralStatus.missingFields, []);

  evidence.release.imageDigestManifest.migrationImage =
    `ghcr.io/jasperfordesq-ai/charity-governance-migration@sha256:${digest}`;
  const singularStatus = releaseBindingStatus(evidence);
  assert.equal(singularStatus.complete, false);
  assert.ok(singularStatus.missingFields.includes('release.imageDigestManifest.migrationImage'));
});

test('production launch evidence status falls back to current hints for older ledgers', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();
  const evidence = {
    approvedForLaunch: false,
    finalSignoff: { status: 'pending', approvals: {} },
    areas: {
      releaseGate: {
        status: 'pending',
        checks: {
          'npm-ci': {
            status: 'pending',
            evidence: [],
          },
        },
      },
    },
  };
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceStatusFromArgs(['--json', '--evidence-file', evidencePath]);

    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.nextIncompleteCheckDetails[0].path, 'releaseGate.npm-ci');
    assert.deepEqual(payload.nextIncompleteCheckDetails[0].requiredEvidenceHints, ['npm ci', 'exit 0']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence status merges current hints into stale stored ledger hints', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();
  const evidence = {
    approvedForLaunch: false,
    finalSignoff: { status: 'pending', approvals: {} },
    areas: {
      browserQa: {
        status: 'pending',
        checks: {
          'browser-qa-completed': {
            status: 'pending',
            requiredEvidenceHints: [
              'E2E_DEPLOYED_QA=true',
              'E2E_WEB_URL=https://app.charitypilot.ie',
              'E2E_API_URL=https://api.charitypilot.ie',
              'npm run test:e2e:responsive',
            ],
            evidence: [],
          },
          'critical-flows-covered': {
            status: 'pending',
            requiredEvidenceHints: [
              'docs/production-browser-qa.md',
              'routes: /, /features, /pricing, /blog, /blog/[slug], /privacy, /terms, /login, /register, /forgot-password, /reset-password, /verify-email, /accept-invite, /dashboard, /compliance, /compliance/[principleId], /documents, /deadlines, /board, /registers, /regulator, /organisation, /team, /billing, /export',
              'zero critical or high-severity browser QA defects',
            ],
            evidence: [],
          },
        },
      },
    },
  };
  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceStatusFromArgs(['--json', '--evidence-file', evidencePath]);

    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    const browserQa = payload.workQueueByArea.find((area) => area.id === 'browserQa');
    const browserQaCompleted = browserQa.checks.find((check) => check.path === 'browserQa.browser-qa-completed');
    assert.deepEqual(browserQaCompleted.requiredEvidenceHints.slice(0, 4), [
      'E2E_DEPLOYED_QA=true',
      'E2E_WEB_URL=https://app.charitypilot.ie',
      'E2E_API_URL=https://api.charitypilot.ie',
      'npm run test:e2e:responsive',
    ]);
    assert.ok(
      browserQaCompleted.requiredEvidenceHints.includes('npm run check:production:browser-qa-env'),
      'stale stored browser QA hints must be enriched with the current deployed-env preflight command',
    );
    assert.ok(
      browserQaCompleted.requiredEvidenceHints.includes('Deployed browser QA environment preflight passed'),
      'stale stored browser QA hints must be enriched with the current preflight success marker',
    );
    const criticalFlows = browserQa.checks.find((check) => check.path === 'browserQa.critical-flows-covered');
    assert.ok(
      criticalFlows.requiredEvidenceHints.some((hint) =>
        hint.includes('routes: /, /about, /features, /pricing'),
      ),
      'current launch route inventory must be present',
    );
    assert.ok(
      !criticalFlows.requiredEvidenceHints.some((hint) =>
        hint.includes('routes: /, /features, /pricing'),
      ),
      'stale stored launch route inventory must be replaced by the current default route inventory',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence status complete flag requires area statuses', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();
  const evidence = await launchEvidenceTemplate();
  evidence.release.commitSha = 'b'.repeat(40);
  evidence.approvedForLaunch = true;
  evidence.finalSignoff.status = 'approved';

  for (const area of Object.values(evidence.areas)) {
    area.status = 'complete';
    for (const check of Object.values(area.checks)) {
      check.status = 'complete';
    }
  }
  for (const [roleId, approval] of Object.entries(evidence.finalSignoff.approvals)) {
    approval.status = 'approved';
    approval.evidence = [
      {
        type: 'approval',
        reference: `https://evidence.charitypilot.ie/launch/final-signoff/${roleId}`,
        description: `${approval.owner.replace('REPLACE_WITH_', '').replaceAll('_', ' ')} launch approval for release ${evidence.release.commitSha}`,
        capturedAt: '2026-07-06T12:00:00.000Z',
      },
    ];
  }
  evidence.areas.releaseGate.status = 'pending';

  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceStatusFromArgs(['--json', '--evidence-file', evidencePath]);

    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.completedChecks, 87);
    assert.equal(payload.approvedFinalSignoffRoles, 5);
    assert.equal(payload.evidenceStatusesComplete, false);
    assert.equal(payload.areas.find((area) => area.id === 'releaseGate').status, 'pending');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence status complete flag requires release binding', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();
  const evidence = await launchEvidenceTemplate();
  evidence.release.commitSha = 'b'.repeat(40);
  evidence.approvedForLaunch = true;
  evidence.finalSignoff.status = 'approved';

  for (const area of Object.values(evidence.areas)) {
    area.status = 'complete';
    for (const check of Object.values(area.checks)) {
      check.status = 'complete';
    }
  }
  for (const [roleId, approval] of Object.entries(evidence.finalSignoff.approvals)) {
    approval.status = 'approved';
    approval.evidence = [
      {
        type: 'approval',
        reference: `https://evidence.charitypilot.ie/launch/final-signoff/${roleId}`,
        description: `${roleId} launch approval for release ${evidence.release.commitSha}`,
        capturedAt: '2026-07-06T12:00:00.000Z',
      },
    ];
  }

  const { tempDir, evidencePath } = writeEvidenceFile(evidence);

  try {
    const result = runProductionLaunchEvidenceStatusFromArgs(['--json', '--evidence-file', evidencePath]);

    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.completedChecks, 87);
    assert.equal(payload.approvedFinalSignoffRoles, 5);
    assert.equal(payload.releaseBinding.complete, false);
    assert.equal(payload.evidenceStatusesComplete, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production launch evidence status fails closed when evidence file is missing', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();

  const result = runProductionLaunchEvidenceStatusFromArgs([
    '--evidence-file',
    join(tmpdir(), 'missing-production-launch-evidence.json'),
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /evidence file not found/);
});

test('production launch evidence status redacts token-bearing evidence paths', async () => {
  const { runProductionLaunchEvidenceStatusFromArgs } = await loadStatusRunner();

  const result = runProductionLaunchEvidenceStatusFromArgs([
    '--evidence-file',
    join(tmpdir(), 'missing-production-launch-evidence.json?token=secret-token&GITHUB_TOKEN=ghp_secretToken'),
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /token=\[redacted\]/);
  assert.match(result.stderr, /GITHUB_TOKEN=\[redacted\]/);
  assert.doesNotMatch(result.stderr, /secret-token|ghp_secretToken/);
});
