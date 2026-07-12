import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const installer = await import('node:fs').then(({ readFileSync }) => readFileSync(installerPath, 'utf8'));
const acl = await import('node:fs').then(({ readFileSync }) => readFileSync(aclPath, 'utf8'));
const archiveVerifier = await import('node:fs').then(({ readFileSync }) => readFileSync(archiveVerifierPath, 'utf8'));
const updater = await import('node:fs').then(({ readFileSync }) => readFileSync(updaterPath, 'utf8'));

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
  assert.match(installer, /No directory, environment file, container, volume, network, image, database, organisation or account was created/u);
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
});

test('PowerShell installer and helpers parse without syntax errors', { skip: process.platform !== 'win32' }, () => {
  for (const scriptPath of [installerPath, updaterPath, aclPath, archiveVerifierPath]) {
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
