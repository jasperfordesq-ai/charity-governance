import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installerPath = resolve(root, 'scripts/Install-CharityPilot.ps1');
const aclPath = resolve(root, 'scripts/personal-server-windows-acl.ps1');
const archiveVerifierPath = resolve(root, 'scripts/personal-server-release-archive.ps1');
const updaterPath = resolve(root, 'scripts/Update-CharityPilot.ps1');
const dockerBoundaryPath = resolve(root, 'scripts/personal-server-windows-docker-boundary.ps1');
const failedResumeSourcePath = resolve(root, 'scripts/personal-server-failed-resume-source.ps1');
const installer = await import('node:fs').then(({ readFileSync }) => readFileSync(installerPath, 'utf8'));
const acl = await import('node:fs').then(({ readFileSync }) => readFileSync(aclPath, 'utf8'));
const archiveVerifier = await import('node:fs').then(({ readFileSync }) => readFileSync(archiveVerifierPath, 'utf8'));
const updater = await import('node:fs').then(({ readFileSync }) => readFileSync(updaterPath, 'utf8'));
const dockerBoundary = await import('node:fs').then(({ readFileSync }) => readFileSync(dockerBoundaryPath, 'utf8'));
const failedResumeSource = readFileSync(failedResumeSourcePath, 'utf8');

test('Windows installer is checkout-independent and uses the supported wrappers', () => {
  assert.match(installer, /\$PSScriptRoot/u);
  assert.doesNotMatch(installer, /C:\\platforms\\htdocs/iu);
  assert.match(installer, /personal-server-preflight\.mjs/u);
  assert.match(installer, /personal-server-release-archive\.ps1/u);
  assert.match(installer, /personal:server:init/u);
  assert.match(installer, /personal:server:status/u);
  assert.match(installer, /personal:server:backup/u);
  assert.match(installer, /personal:server:stop/u);
  assert.match(installer, /& \$aclScript -Path \$LiteralPath -Kind \$Kind -VerifyOnly:\$VerifyOnly -DryRun:\$PlanOnly/u);
  assert.doesNotMatch(installer, /& \$aclScript @arguments/u);
  assert.doesNotMatch(installer, /docker\s+(?:compose\s+)?(?:rm|volume\s+rm|system\s+prune)/iu);
});

test('installer supports no-write preflight and dry-run paths before state creation', () => {
  assert.match(
    installer,
    /\$restoreOnlyValues\s*=\s*@\(\s*@\(\$RecoveryKeyFile,\s*\$SourceOrigin,\s*\$Confirm,\s*\$OwnerPasswordFile\)\s*\|\s*Where-Object[\s\S]*?\n\)/u,
    'PowerShell 5.1 must materialize an empty restore-only pipeline as an array before reading Count',
  );
  const preflightIndex = installer.indexOf("$preflightOutput =");
  const preflightOnlyIndex = installer.indexOf('if ($PreflightOnly)');
  const dryRunIndex = installer.indexOf('if ($DryRun)', preflightIndex + 1);
  const stateCreateIndex = installer.indexOf("New-Item -ItemType Directory -Path $StateRoot");
  assert.ok(preflightIndex > -1);
  assert.ok(preflightOnlyIndex > preflightIndex && preflightOnlyIndex < stateCreateIndex);
  assert.ok(dryRunIndex > preflightIndex && dryRunIndex < stateCreateIndex);
  assert.match(installer, /No installation state was created/u);
  assert.match(installer, /No directory, environment file, container, volume, networks, image, database, organisation or account was created/u);
});

test('durable state is external, non-secret, phased and backup-gated', () => {
  assert.match(installer, /LOCALAPPDATA/u);
  assert.match(installer, /CharityPilot\\personal-server/u);
  assert.match(installer, /install-state\.json/u);
  assert.match(installer, /recoveryRoot/u);
  assert.match(installer, /charitypilot-personal-server-install-state\/v1/u);
  assert.match(installer, /phase = 'initializing'/u);
  assert.match(installer, /activeImageTag = if \(\$null -ne \$releaseIdentity\)/u);
  assert.match(installer, /canonicalTrackingRef/u);
  assert.match(installer, /originMasterRevision/u);
  assert.match(installer, /initialized-backup-pending/u);
  assert.match(installer, /phase = 'ready'/u);
  assert.match(installer, /runtime-health-resume-/u);
  assert.match(installer, /runtimeHealthReportPath/u);
  assert.match(installer, /if \(\$stateRootCreated[\s\S]+Remove-Item -Force -Recurse -LiteralPath \$StateRoot/u);
  assert.doesNotMatch(installer, /installState[^\n]*(?:OwnerEmail|OwnerName|OrganisationName)/u);

  const initialized = installer.indexOf("$script:installState.phase = 'initialized-backup-pending'");
  const status = installer.indexOf("@('run', 'personal:server:status')");
  const backup = installer.indexOf("'run', 'personal:server:backup'");
  const rehearsal = installer.indexOf("'run', 'personal:server:rehearse-restore'");
  const runtimeHealth = installer.indexOf("'run', 'personal:server:certify'");
  const ready = installer.indexOf("$script:installState.phase = 'ready'");
  assert.ok(
    initialized > -1 &&
      initialized < status &&
      status < backup &&
      backup < rehearsal &&
      rehearsal < runtimeHealth &&
      runtimeHealth < ready,
  );
});

test('failed clean-Git install can adopt only a verified canonical descendant repair before resume', () => {
  assert.match(failedResumeSource, /recordedRevision -cnotmatch '\^\[0-9a-f\]\{40\}\$'/u);
  assert.match(failedResumeSource, /recordedBranch -cne 'master'/u);
  assert.match(failedResumeSource, /currentOriginMasterRevision -cne \$currentRevision/u);
  assert.match(failedResumeSource, /currentClean -ne \$true/u);
  assert.match(failedResumeSource, /\$State\.installationMode -cne 'fresh-install'/u);
  assert.match(failedResumeSource, /\[string\]\$State\.activeImageTag -cne 'local'/u);
  assert.match(failedResumeSource, /\$null -ne \$recordedArchive/u);
  assert.match(failedResumeSource, /repairableFailedPhases = @\('initializing', 'initialized-backup-pending'\)/u);
  assert.match(failedResumeSource, /\$repairableFailedPhases -cnotcontains \$failedFromPhase/u);
  assert.match(failedResumeSource, /published recovery set must remain on its exact recorded source/u);
  assert.match(failedResumeSource, /incomplete recovery directories must remain on its exact recorded source/u);
  assert.match(installer, /RepairToGitRevision/u);
  assert.match(installer, /RepairToGitRevision is never valid for a release installation/u);
  assert.match(failedResumeSource, /\$RepairToGitRevision -cne \$currentRevision/u);
  assert.match(failedResumeSource, /merge-base --is-ancestor \$recordedRevision \$currentRevision/u);
  assert.match(installer, /failedResumeSourceAdvances/u);
  assert.match(installer, /source repair history exceeds its bounded safety limit/u);
  assert.match(failedResumeSource, /charitypilot-personal-server-failed-resume-source-advance\/v1/u);
  assert.doesNotMatch(`${installer}\n${failedResumeSource}`, /git(?:\.exe)?\s+(?:pull|fetch)/iu);

  const sourceAdvanceWrite = installer.indexOf('Protected failed-install state now records the verified canonical descendant repair source.');
  const resumeInvocation = installer.indexOf('Invoke-NpmCommand -Arguments $initArguments', sourceAdvanceWrite);
  assert.ok(sourceAdvanceWrite > -1 && sourceAdvanceWrite < resumeInvocation);

  const resumeValidation = installer.indexOf('$resumeState = if ($ResumeFailed)');
  const preflightOnlyExit = installer.indexOf("Write-Host 'Preflight passed. No installation state was created.'");
  assert.ok(resumeValidation > -1 && resumeValidation < preflightOnlyExit);
});

test('failed-install source repair helper executes descendant and rejection cases', { skip: process.platform !== 'win32' }, () => {
  const fromRevision = 'a'.repeat(40);
  const toRevision = 'b'.repeat(40);
  const baseState = {
    phase: 'failed',
    installationMode: 'fresh-install',
    activeImageTag: 'local',
    failedFromPhase: 'initializing',
    source: {
      kind: 'git',
      revision: fromRevision,
      branch: 'master',
      canonicalRemote: true,
      canonicalTrackingRef: true,
      originMasterRevision: fromRevision,
      verifiedArchive: null,
      releaseIdentity: null,
    },
  };
  const baseCurrent = {
    kind: 'git',
    revision: toRevision,
    branch: 'master',
    canonicalRemote: true,
    canonicalTrackingRef: true,
    originMasterRevision: toRevision,
    clean: true,
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const invoke = ({
    state = baseState,
    current = baseCurrent,
    target = toRevision,
    ancestor = true,
    publishedSet = false,
    incompleteSet = false,
  } = {}) => {
    const directory = mkdtempSync(join(tmpdir(), 'charitypilot-failed-resume-source-'));
    const statePath = join(directory, 'state.json');
    const currentPath = join(directory, 'current.json');
    const recoveryRoot = join(directory, 'recovery');
    mkdirSync(recoveryRoot, { recursive: true });
    if (publishedSet) mkdirSync(join(recoveryRoot, 'published-set'), { recursive: true });
    if (incompleteSet) mkdirSync(join(recoveryRoot, '.interrupted.incomplete'), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(currentPath, JSON.stringify(current));
    const command = [
      `. ${psQuote(failedResumeSourcePath)}`,
      `$state = Get-Content -LiteralPath ${psQuote(statePath)} -Raw | ConvertFrom-Json`,
      `$current = Get-Content -LiteralPath ${psQuote(currentPath)} -Raw | ConvertFrom-Json`,
      `$ancestorCheck = { param($from, $to, $root) ${ancestor ? '$true' : '$false'} }`,
      'try {',
      `  $result = Resolve-CharityPilotFailedResumeSourceAdvance -State $state -CurrentSource $current -RepairToGitRevision ${psQuote(target)} -RecoveryRoot ${psQuote(recoveryRoot)} -RepositoryRoot ${psQuote(root)} -AncestorCheck $ancestorCheck`,
      "  if ($null -eq $result) { Write-Output 'EXACT' } else { $result | ConvertTo-Json -Compress }",
      '  exit 0',
      '} catch {',
      '  [Console]::Error.WriteLine($_.Exception.Message)',
      '  exit 1',
      '}',
    ].join('; ');
    try {
      return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        encoding: 'utf8',
        windowsHide: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  const accepted = invoke();
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const advance = JSON.parse(accepted.stdout.trim());
  assert.equal(advance.fromRevision, fromRevision);
  assert.equal(advance.toRevision, toRevision);
  assert.equal(advance.failedFromPhase, 'initializing');

  const postInitialization = invoke({
    state: { ...baseState, failedFromPhase: 'initialized-backup-pending' },
  });
  assert.equal(postInitialization.status, 0, postInitialization.stderr || postInitialization.stdout);
  assert.equal(JSON.parse(postInitialization.stdout.trim()).failedFromPhase, 'initialized-backup-pending');

  const exactCurrent = { ...baseCurrent, revision: fromRevision, originMasterRevision: fromRevision };
  const exact = invoke({ current: exactCurrent, target: '' });
  assert.equal(exact.status, 0, exact.stderr || exact.stdout);
  assert.equal(exact.stdout.trim(), 'EXACT');

  assert.notEqual(invoke({ ancestor: false }).status, 0);
  assert.notEqual(invoke({ target: '' }).status, 0);
  assert.notEqual(invoke({ target: 'c'.repeat(40) }).status, 0);
  assert.notEqual(invoke({ current: { ...baseCurrent, clean: false } }).status, 0);
  assert.notEqual(invoke({ current: { ...baseCurrent, canonicalRemote: false } }).status, 0);
  assert.notEqual(invoke({ current: { ...baseCurrent, canonicalTrackingRef: false } }).status, 0);
  assert.notEqual(invoke({ current: { ...baseCurrent, branch: 'repair' } }).status, 0);
  assert.notEqual(invoke({ state: { ...baseState, installationMode: 'replacement-restore' } }).status, 0);
  assert.notEqual(invoke({ state: { ...baseState, activeImageTag: 'personal-v1.0.0' } }).status, 0);
  assert.notEqual(invoke({ state: { ...baseState, phase: 'ready' } }).status, 0);
  assert.notEqual(invoke({ state: { ...baseState, failedFromPhase: 'ready' } }).status, 0);
  assert.notEqual(invoke({ state: { ...baseState, source: { ...clone(baseState.source), verifiedArchive: { sha256: 'x' } } } }).status, 0);
  assert.notEqual(invoke({ state: { ...baseState, source: { ...clone(baseState.source), releaseIdentity: { tag: 'personal-v1.0.0' } } } }).status, 0);
  assert.notEqual(invoke({ state: { ...baseState, source: { ...clone(baseState.source), revision: fromRevision.toUpperCase(), originMasterRevision: fromRevision.toUpperCase() } } }).status, 0);
  assert.notEqual(invoke({ current: { ...baseCurrent, revision: toRevision.toUpperCase(), originMasterRevision: toRevision.toUpperCase() } }).status, 0);
  assert.notEqual(invoke({ publishedSet: true }).status, 0);
  assert.notEqual(invoke({ incompleteSet: true }).status, 0);
  assert.notEqual(invoke({ current: exactCurrent, target: fromRevision }).status, 0);
});

test('replacement-host installer verifies before writing, rotates secrets, and never invokes the initializer', () => {
  assert.match(installer, /RestoreRecoverySet/u);
  assert.match(installer, /bootstrap-restore-plan/u);
  assert.match(installer, /personal:server:bootstrap-restore/u);
  assert.match(installer, /replacement-restore/u);
  assert.match(installer, /restore-prepared/u);
  assert.match(installer, /POSTGRES_PASSWORD.*JWT_SECRET.*READINESS_API_KEY/su);
  const planIndex = installer.indexOf("'bootstrap-restore-plan'");
  const stateCreateIndex = installer.indexOf('New-Item -ItemType Directory -Path $StateRoot');
  assert.ok(planIndex > -1 && planIndex < stateCreateIndex);
  const restoreBranch = installer.slice(installer.indexOf('$initArguments = if ($replacementRestore)'), installer.indexOf('elseif ($ResumeFailed)'));
  assert.doesNotMatch(restoreBranch, /personal:server:init/u);
  assert.doesNotMatch(restoreBranch, /personal:server:resume-init/u);
  const invokeIndex = installer.indexOf('Invoke-NpmCommand -Arguments $initArguments');
  const reloadIndex = installer.indexOf('$restoredState = [System.IO.File]::ReadAllText($statePath)', invokeIndex);
  const writeIndex = installer.indexOf('Write-InstallState', reloadIndex);
  assert.ok(invokeIndex > -1 && reloadIndex > invokeIndex && writeIndex > reloadIndex);
});

test('downloaded ZIP verification accepts an expected hash or exact release checksum sidecar', () => {
  assert.match(installer, /ArchivePath/u);
  assert.match(installer, /ExpectedArchiveSha256/u);
  assert.match(installer, /ChecksumPath/u);
  assert.match(installer, /Get-FileHash[^\n]+SHA256/u);
  assert.match(installer, /exactly 64 hexadecimal characters/u);
  assert.match(installer, /sidecar names a different archive/u);
  assert.match(installer, /Do not install this bundle/u);
  assert.match(installer, /personal-server-release\.json/u);
  assert.match(installer, /charitypilot-personal-server-bundle\/v1/u);
  assert.match(installer, /releaseIdentity/u);
  assert.match(installer, /verified ZIP filename does not match release identity/u);
});

test('ACL helper protects inheritance and allows only operator SID plus LOCAL SYSTEM', () => {
  assert.match(acl, /SetAccessRuleProtection\(\$true, \$false\)/u);
  assert.match(acl, /WindowsIdentity\]::GetCurrent\(\)\.User/u);
  assert.match(acl, /S-1-5-18/u);
  assert.match(acl, /Set-Acl -LiteralPath/u);
  assert.match(acl, /AreAccessRulesProtected/u);
  assert.match(acl, /expected exactly two explicit access rules/u);
  assert.match(acl, /ReparsePoint/u);
  assert.doesNotMatch(acl, /icacls|cmd\.exe/iu);
});

test('release archive verifier binds every extracted entry and rejects links or extras', () => {
  assert.match(archiveVerifier, /ZipFile\]::OpenRead/u);
  assert.match(archiveVerifier, /Get-StreamSha256/u);
  assert.match(archiveVerifier, /ReparsePoint/u);
  assert.match(archiveVerifier, /entry absent from the verified archive/u);
  assert.match(archiveVerifier, /does not contain every entry/u);
});

test('Windows updater requires a verified new bundle and delegates version-bound update', () => {
  assert.match(updater, /personal-server-release-archive\.ps1/u);
  assert.match(updater, /Get-FileHash/u);
  assert.match(updater, /pending-update\.json/u);
  assert.match(updater, /\[switch\]\$ResumePending/u);
  assert.match(updater, /-ResumePending requires the original protected pending-update\.json/u);
  assert.match(updater, /personal:server:update[\s\S]+--resume-pending/u);
  assert.match(updater, /pendingReceipt\.phase -notin @\('prepared', 'pre-cutover'\)/u);
  assert.match(updater, /personal:server:update/u);
  assert.match(updater, /previous source remains available for rollback/u);
  assert.match(updater, /Get-SafeCanonicalDirectoryPath/u);
  assert.match(updater, /StringComparison\]::OrdinalIgnoreCase/u);
  assert.match(updater, /ReparsePoint/u);
  assert.match(updater, /Node satisfying \$nodeEngine is required/u);
  assert.match(updater, /personal-server-windows-docker-boundary\.ps1/u);
  assert.match(updater, /Assert-CharityPilotLocalDockerBoundary/u);
  assert.ok(updater.indexOf('Assert-CharityPilotLocalDockerBoundary') < updater.indexOf('if ($PreflightOnly)'));
  assert.ok(updater.indexOf('Assert-CharityPilotLocalDockerBoundary') < updater.indexOf("FileMode]::CreateNew"));
  assert.match(updater, /activeImageTag/u);
  assert.match(updater, /status', '--porcelain=v1', '--untracked-files=all/u);
  assert.match(updater, /'rev-parse', 'HEAD'/u);
  assert.match(updater, /'branch', '--show-current'/u);
  assert.match(updater, /'remote', 'get-url', 'origin'/u);
  assert.match(updater, /refs\/remotes\/origin\/master\^\{commit\}/u);
  assert.match(updater, /'cat-file', '-e'/u);
  assert.match(updater, /'merge-base', '--is-ancestor'/u);
  assert.match(updater, /personal:server:rollback -- --dry-run/u);
  assert.doesNotMatch(updater, /git\s+(?:pull|fetch)|docker\s+system\s+prune/iu);
  assert.match(dockerBoundary, /DOCKER_DEFAULT_PLATFORM/u);
  assert.match(dockerBoundary, /DOCKER_CONFIG/u);
  assert.match(dockerBoundary, /BUILDKIT_\.\+/u);
  assert.match(dockerBoundary, /BUILDX_\.\+/u);
});

test('PowerShell installer and helpers parse without syntax errors', { skip: process.platform !== 'win32' }, () => {
  for (const scriptPath of [installerPath, updaterPath, aclPath, archiveVerifierPath, failedResumeSourcePath, dockerBoundaryPath]) {
    const escaped = scriptPath.replaceAll("'", "''");
    const command = `$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors); if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`;
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test('release archive verifier proves an exact Windows extraction and rejects tampering', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'charitypilot-release-archive-'));
  const source = join(directory, 'CharityPilot-personal-v1.2.3');
  const nested = join(source, 'scripts');
  const archive = join(directory, 'CharityPilot-personal-v1.2.3.zip');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(source, 'README.md'), 'trusted release\n');
  writeFileSync(join(nested, 'install.ps1'), 'Write-Host trusted\n');
  const invoke = () => spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', archiveVerifierPath,
    '-ArchivePath', archive, '-SourceRoot', source, '-Tag', 'personal-v1.2.3',
  ], { encoding: 'utf8', windowsHide: true });
  try {
    const escapedSource = source.replaceAll("'", "''");
    const escapedArchive = archive.replaceAll("'", "''");
    const zipped = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -LiteralPath '${escapedSource}' -DestinationPath '${escapedArchive}'`],
    { encoding: 'utf8', windowsHide: true });
    assert.equal(zipped.status, 0, zipped.stderr || zipped.stdout);
    const valid = invoke();
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    writeFileSync(join(source, 'README.md'), 'tampered\n');
    const tampered = invoke();
    assert.notEqual(tampered.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ACL application is idempotent, verifiable and dry-run does not create targets', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'charitypilot-installer-acl-'));
  const file = join(directory, 'private.env');
  const absent = join(tmpdir(), `charitypilot-installer-acl-absent-${process.pid}`);
  writeFileSync(file, 'test only');
  rmSync(absent, { recursive: true, force: true });

  const invoke = (args) => spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    aclPath,
    ...args,
  ], { encoding: 'utf8', windowsHide: true });

  try {
    for (const args of [
      ['-Path', directory, '-Kind', 'Directory'],
      ['-Path', directory, '-Kind', 'Directory'],
      ['-Path', directory, '-Kind', 'Directory', '-VerifyOnly'],
      ['-Path', file, '-Kind', 'File'],
      ['-Path', file, '-Kind', 'File'],
      ['-Path', file, '-Kind', 'File', '-VerifyOnly'],
      ['-Path', absent, '-Kind', 'Directory', '-DryRun'],
    ]) {
      const result = invoke(args);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    assert.equal(existsSync(absent), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(absent, { recursive: true, force: true });
  }
});
