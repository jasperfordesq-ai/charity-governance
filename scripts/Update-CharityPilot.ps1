[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,
    [string]$ExpectedArchiveSha256,
    [string]$ChecksumPath,
    [string]$StateRoot,
    [switch]$ResumePending,
    [switch]$PreflightOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') { throw 'The supported personal-server updater runs on Windows only.' }
if ($PSVersionTable.PSVersion -lt [Version]'5.1.0') { throw 'PowerShell 5.1 or later is required.' }
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA is unavailable.' }

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$archiveVerifier = Join-Path $PSScriptRoot 'personal-server-release-archive.ps1'
$aclHelper = Join-Path $PSScriptRoot 'personal-server-windows-acl.ps1'
$pointerPath = Join-Path $env:LOCALAPPDATA 'CharityPilot\personal-server-location.json'

function Get-PropertyValue {
    param([object]$InputObject, [string]$Name)
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-VersionTuple {
    param([string]$Tag)
    if ($Tag -notmatch '^personal-v([0-9]+)\.([0-9]+)\.([0-9]+)$') { return $null }
    return @([int64]$Matches[1], [int64]$Matches[2], [int64]$Matches[3])
}

function Compare-VersionTuple {
    param([object[]]$Left, [object[]]$Right)
    for ($index = 0; $index -lt 3; $index += 1) {
        if ($Left[$index] -lt $Right[$index]) { return -1 }
        if ($Left[$index] -gt $Right[$index]) { return 1 }
    }
    return 0
}

function Get-SafeCanonicalDirectoryPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "Expected a source directory: $Path" }
    $cursor = $item
    while ($null -ne $cursor) {
        if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Source directory paths cannot contain reparse points: $Path"
        }
        $cursor = $cursor.Parent
    }
    return [System.IO.Path]::GetFullPath($resolved)
}

function Test-CanonicalGitRemote {
    param([string]$Remote)
    if ([string]::IsNullOrWhiteSpace($Remote)) { return $false }
    $normalized = $Remote.Trim().TrimEnd('/')
    if ($normalized.EndsWith('.git', [System.StringComparison]::Ordinal)) {
        $normalized = $normalized.Substring(0, $normalized.Length - 4)
    }
    return $normalized -ceq 'https://github.com/jasperfordesq-ai/charity-governance'
}

function Invoke-GitCapture {
    param(
        [Parameter(Mandatory = $true)][string]$Git,
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )
    $output = (& $Git -C $SourceRoot @Arguments 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
    return $output
}

$repositoryRoot = Get-SafeCanonicalDirectoryPath -Path $repositoryRoot

if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) {
        throw 'The protected installation-location pointer is missing. Supply the exact -StateRoot only after investigating.'
    }
    try { $pointer = [System.IO.File]::ReadAllText($pointerPath) | ConvertFrom-Json }
    catch { throw 'The protected installation-location pointer is unreadable.' }
    if ($pointer.format -cne 'charitypilot-personal-server-location/v1') { throw 'The installation-location pointer identity is invalid.' }
    $StateRoot = [string]$pointer.stateRoot
}
$StateRoot = [System.IO.Path]::GetFullPath($StateRoot)
$environmentPath = Join-Path $StateRoot '.env.personal-server'
$statePath = Join-Path $StateRoot 'install-state.json'
$receiptPath = Join-Path $StateRoot 'pending-update.json'
$recoveryKeyPath = Join-Path $StateRoot 'recovery-key.hex'

foreach ($required in @($environmentPath, $statePath, $recoveryKeyPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required protected installation file is missing: $required" }
}

$resolvedArchive = (Resolve-Path -LiteralPath $ArchivePath).Path
$expectedProvided = -not [string]::IsNullOrWhiteSpace($ExpectedArchiveSha256)
$checksumProvided = -not [string]::IsNullOrWhiteSpace($ChecksumPath)
if (-not $expectedProvided -and -not $checksumProvided) {
    throw 'Supply -ExpectedArchiveSha256 or the official -ChecksumPath.'
}
$expected = if ($expectedProvided) { $ExpectedArchiveSha256.Trim().ToLowerInvariant() } else { $null }
if ($expectedProvided -and $expected -notmatch '^[a-f0-9]{64}$') { throw 'Expected archive SHA-256 is invalid.' }
if ($checksumProvided) {
    $checksumText = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $ChecksumPath).Path).Trim()
    if ($checksumText -notmatch '^([A-Fa-f0-9]{64})\s+\*?(.+)$') { throw 'Checksum sidecar format is invalid.' }
    if ([System.IO.Path]::GetFileName($Matches[2].Trim()) -cne [System.IO.Path]::GetFileName($resolvedArchive)) {
        throw 'Checksum sidecar names a different archive.'
    }
    $sidecarHash = $Matches[1].ToLowerInvariant()
    if ($expectedProvided -and $sidecarHash -cne $expected) { throw 'Expected hash and checksum sidecar disagree.' }
    $expected = $sidecarHash
}
$actual = (Get-FileHash -LiteralPath $resolvedArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -cne $expected) { throw 'Target release archive SHA-256 verification failed.' }

$identityPath = Join-Path $repositoryRoot 'personal-server-release.json'
try { $identity = [System.IO.File]::ReadAllText($identityPath) | ConvertFrom-Json }
catch { throw 'Target source is not an official personal-server release bundle.' }
if ($identity.format -cne 'charitypilot-personal-server-bundle/v1' -or
    $identity.profile -cne 'personal-server' -or
    [string]$identity.tag -notmatch '^personal-v[0-9]+\.[0-9]+\.[0-9]+$' -or
    [string]$identity.commitSha -notmatch '^[a-f0-9]{40}$' -or
    [System.IO.Path]::GetFileName($resolvedArchive) -cne "CharityPilot-$($identity.tag).zip") {
    throw 'Target release inner identity is invalid or does not match the verified ZIP.'
}
& $archiveVerifier -ArchivePath $resolvedArchive -SourceRoot $repositoryRoot -Tag ([string]$identity.tag) | Out-Host

try { $installState = [System.IO.File]::ReadAllText($statePath) | ConvertFrom-Json }
catch { throw 'Protected install-state.json is unreadable.' }
if ($installState.format -cne 'charitypilot-personal-server-install-state/v1' -or $installState.phase -cne 'ready') {
    throw 'Only a ready personal-server installation can be updated.'
}
$currentSourceRoot = Get-SafeCanonicalDirectoryPath -Path ([string]$installState.sourceRoot)
if ([string]::Equals($currentSourceRoot, $repositoryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Extract the target release to a new directory so the previous source remains available for rollback.'
}
if (-not (Test-Path -LiteralPath (Join-Path $currentSourceRoot 'compose.personal-server.yml') -PathType Leaf)) {
    throw 'The currently installed source required for rollback is missing.'
}

$environmentText = [System.IO.File]::ReadAllText($environmentPath)
$imageTagMatches = [regex]::Matches($environmentText, '(?m)^CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG=([a-z0-9][a-z0-9_.-]{0,63})$')
if ($imageTagMatches.Count -ne 1) { throw 'Protected environment active image tag is invalid.' }
$currentImageTag = $imageTagMatches[0].Groups[1].Value
$recordedActiveImageTag = [string](Get-PropertyValue -InputObject $installState -Name 'activeImageTag')
if ($recordedActiveImageTag -cne $currentImageTag) {
    throw 'Protected installation state active image tag does not match the protected environment.'
}
$currentReleaseTag = [string](Get-PropertyValue -InputObject (Get-PropertyValue -InputObject $installState.source -Name 'releaseIdentity') -Name 'tag')
$currentVersion = Get-VersionTuple -Tag $currentReleaseTag
$targetVersion = Get-VersionTuple -Tag ([string]$identity.tag)
if ($null -ne $currentVersion -and (Compare-VersionTuple -Left $targetVersion -Right $currentVersion) -le 0) {
    throw 'The target release must be newer than the installed release.'
}

if ([string]::IsNullOrWhiteSpace($currentReleaseTag)) {
    $sourceKind = [string](Get-PropertyValue -InputObject $installState.source -Name 'kind')
    $recordedRevision = [string](Get-PropertyValue -InputObject $installState.source -Name 'revision')
    $recordedBranch = [string](Get-PropertyValue -InputObject $installState.source -Name 'branch')
    $recordedCanonicalRemote = Get-PropertyValue -InputObject $installState.source -Name 'canonicalRemote'
    if ($currentImageTag -cne 'local' -or
        $sourceKind -notin @('git', 'clean-git') -or
        $recordedRevision -notmatch '^[a-f0-9]{40}$' -or
        $recordedBranch -cne 'master' -or
        $recordedCanonicalRemote -ne $true) {
        throw 'First official release adoption requires the recorded canonical clean-Git installation identity.'
    }
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $workingTree = Invoke-GitCapture -Git $git -SourceRoot $currentSourceRoot -Arguments @(
        'status', '--porcelain=v1', '--untracked-files=all'
    ) -FailureMessage 'Could not verify the installed Git working tree.'
    $liveRevision = Invoke-GitCapture -Git $git -SourceRoot $currentSourceRoot -Arguments @(
        'rev-parse', 'HEAD'
    ) -FailureMessage 'Could not verify the installed Git revision.'
    $liveBranch = Invoke-GitCapture -Git $git -SourceRoot $currentSourceRoot -Arguments @(
        'branch', '--show-current'
    ) -FailureMessage 'Could not verify the installed Git branch.'
    $liveRemote = Invoke-GitCapture -Git $git -SourceRoot $currentSourceRoot -Arguments @(
        'remote', 'get-url', 'origin'
    ) -FailureMessage 'Could not verify the installed Git origin.'
    $originMasterRevision = Invoke-GitCapture -Git $git -SourceRoot $currentSourceRoot -Arguments @(
        'rev-parse', '--verify', 'refs/remotes/origin/master^{commit}'
    ) -FailureMessage 'The installed Git source has no fetched canonical origin/master commit.'
    if (-not [string]::IsNullOrEmpty($workingTree) -or
        $liveRevision -cne $recordedRevision -or
        $liveBranch -cne $recordedBranch -or
        -not (Test-CanonicalGitRemote -Remote $liveRemote) -or
        $originMasterRevision -cne $recordedRevision) {
        throw 'Installed clean-Git source is dirty, changed, or no longer the exact fetched canonical origin/master commit.'
    }
    $targetCommit = [string]$identity.commitSha
    [void](Invoke-GitCapture -Git $git -SourceRoot $currentSourceRoot -Arguments @(
        'cat-file', '-e', "$targetCommit^{commit}"
    ) -FailureMessage 'The target release commit is not present in the installed canonical Git object database.')
    [void](Invoke-GitCapture -Git $git -SourceRoot $currentSourceRoot -Arguments @(
        'merge-base', '--is-ancestor', $recordedRevision, $targetCommit
    ) -FailureMessage 'The target release commit does not descend from the recorded installed commit.')
    Write-Host "Verified first official release ancestry from clean Git commit $recordedRevision."
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$packageMetadata = [System.IO.File]::ReadAllText((Join-Path $repositoryRoot 'package.json')) | ConvertFrom-Json
$declaredNpm = ($packageMetadata.packageManager -replace '^npm@', '')
$nodeEngine = [string]$packageMetadata.engines.node
$actualNode = (& $node --version | Out-String).Trim().TrimStart('v')
$parsedNode = $null
if ($LASTEXITCODE -ne 0 -or $nodeEngine -notmatch '^>=\s*([0-9]+\.[0-9]+\.[0-9]+)$' -or
    -not [Version]::TryParse($actualNode, [ref]$parsedNode) -or
    $parsedNode -lt [Version]$Matches[1]) {
    throw "Node satisfying $nodeEngine is required."
}
$actualNpm = (& $npm --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $actualNpm -cne $declaredNpm) { throw "npm $declaredNpm is required." }
$dockerOs = (& docker version --format '{{.Server.Os}}' | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $dockerOs -cne 'linux') { throw 'Docker Desktop must be running Linux containers.' }

Write-Host "Verified version-bound update: $currentImageTag -> $($identity.tag)"
Write-Host "Current rollback source: $currentSourceRoot"
Write-Host "Target source: $repositoryRoot"
$pendingExists = Test-Path -LiteralPath $receiptPath -PathType Leaf
if ($ResumePending -and -not $pendingExists) {
    throw '-ResumePending requires the original protected pending-update.json.'
}
if (-not $ResumePending -and $pendingExists) {
    throw 'A pending update receipt already exists. Rerun this exact verified updater with -ResumePending only after reviewing the recorded phase.'
}
if ($ResumePending) {
    & $aclHelper -Path $receiptPath -Kind File -VerifyOnly | Out-Host
    try { $pendingReceipt = [System.IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json }
    catch { throw 'The protected pending update receipt is unreadable.' }
    if ($pendingReceipt.format -cne 'charitypilot-personal-server-update-receipt/v1' -or
        [string]$pendingReceipt.phase -notin @('prepared', 'pre-cutover') -or
        [string]$pendingReceipt.current.imageTag -cne $currentImageTag -or
        -not [string]::Equals(
            (Get-SafeCanonicalDirectoryPath -Path ([string]$pendingReceipt.current.sourceRoot)),
            $currentSourceRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        -not [string]::Equals(
            (Get-SafeCanonicalDirectoryPath -Path ([string]$pendingReceipt.target.sourceRoot)),
            $repositoryRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        [string]$pendingReceipt.target.tag -cne [string]$identity.tag -or
        [string]$pendingReceipt.target.commitSha -cne [string]$identity.commitSha -or
        [string]$pendingReceipt.target.archiveFile -cne [System.IO.Path]::GetFileName($resolvedArchive) -or
        [string]$pendingReceipt.target.archiveSha256 -cne $actual) {
        throw 'The pending update receipt does not bind this exact current installation and verified target bundle.'
    }
}

if ($PreflightOnly) {
    $mode = if ($ResumePending) { 'Pending-update resume preflight' } else { 'Update preflight' }
    Write-Host "$mode passed. No receipt, image, backup, container, database, or state was changed."
    exit 0
}

if (-not $ResumePending) {
    $receipt = [ordered]@{
        format = 'charitypilot-personal-server-update-receipt/v1'
        phase = 'prepared'
        createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        current = [ordered]@{ imageTag = $currentImageTag; sourceRoot = $currentSourceRoot }
        target = [ordered]@{
            sourceRoot = $repositoryRoot
            tag = [string]$identity.tag
            commitSha = [string]$identity.commitSha
            archiveFile = [System.IO.Path]::GetFileName($resolvedArchive)
            archiveSha256 = $actual
        }
    }
    $receiptJson = $receipt | ConvertTo-Json -Depth 8
    $stream = [System.IO.File]::Open($receiptPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($receiptJson + [Environment]::NewLine)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
    & $aclHelper -Path $receiptPath -Kind File | Out-Host
}

$previousProcessPointer = $env:CHARITYPILOT_PERSONAL_SERVER_ENV_FILE
$env:CHARITYPILOT_PERSONAL_SERVER_ENV_FILE = $environmentPath
Push-Location $repositoryRoot
try {
    $updateArguments = @('run', 'personal:server:update', '--', "--update-receipt=$receiptPath")
    if ($ResumePending) { $updateArguments += '--resume-pending' }
    & $npm @updateArguments
    if ($LASTEXITCODE -ne 0) { throw 'Version-bound update failed. The pending receipt and automatic recovery evidence were preserved.' }
}
finally {
    Pop-Location
    $env:CHARITYPILOT_PERSONAL_SERVER_ENV_FILE = $previousProcessPointer
}

$completedState = [System.IO.File]::ReadAllText($statePath) | ConvertFrom-Json
if ($completedState.phase -cne 'ready' -or $completedState.source.releaseIdentity.tag -cne $identity.tag) {
    throw 'Update command returned without committing the exact target release state.'
}
Write-Host "CharityPilot is running release $($identity.tag)."
Write-Host 'Keep the previous source directory and pre-update recovery set until the rollback window has passed.'
Write-Host 'Run npm run personal:server:rollback -- --dry-run to print the exact non-mutating rollback confirmation before any rollback.'
