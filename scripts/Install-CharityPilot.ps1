[CmdletBinding()]
param(
    [string]$OwnerEmail,
    [string]$OwnerName,
    [string]$OrganisationName,
    [string]$Origin,
    [ValidateRange(1, 65535)]
    [int]$Port = 8080,
    [string]$StateRoot,
    [switch]$PreflightOnly,
    [switch]$DryRun,
    [switch]$ResumeFailed,
    [string]$RepairToGitRevision,
    [string]$RestoreRecoverySet,
    [string]$RecoveryKeyFile,
    [string]$SourceOrigin,
    [string]$Confirm,
    [string]$OwnerPasswordFile,
    [string]$ArchivePath,
    [string]$ExpectedArchiveSha256,
    [string]$ChecksumPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This installer supports Windows only. Use a supported Windows release with Docker Desktop running Linux containers.'
}
if ($PSVersionTable.PSVersion -lt [Version]'5.1.0') {
    throw 'PowerShell 5.1 or later is required.'
}
if ($PreflightOnly -and $DryRun) {
    throw '-PreflightOnly and -DryRun are separate modes; choose one.'
}
if (-not [string]::IsNullOrWhiteSpace($RepairToGitRevision)) {
    if (-not $ResumeFailed) {
        throw '-RepairToGitRevision is valid only with -ResumeFailed.'
    }
    if ($RepairToGitRevision -cnotmatch '^[0-9a-f]{40}$') {
        throw '-RepairToGitRevision must be the exact lowercase 40-character target commit SHA.'
    }
}

$replacementRestore = -not [string]::IsNullOrWhiteSpace($RestoreRecoverySet)
$restoreOnlyValues = @(
    @($RecoveryKeyFile, $SourceOrigin, $Confirm, $OwnerPasswordFile) |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
)
if (-not $replacementRestore -and $restoreOnlyValues.Count -gt 0) {
    throw '-RecoveryKeyFile, -SourceOrigin, -Confirm and -OwnerPasswordFile are valid only with -RestoreRecoverySet.'
}
if ($replacementRestore) {
    if ([string]::IsNullOrWhiteSpace($RecoveryKeyFile) -or [string]::IsNullOrWhiteSpace($SourceOrigin)) {
        throw 'Replacement-host restore requires -RecoveryKeyFile and -SourceOrigin.'
    }
    if (-not $PreflightOnly -and [string]::IsNullOrWhiteSpace($Confirm)) {
        throw 'Replacement-host restore requires the exact -Confirm value printed by a prior -PreflightOnly run.'
    }
    if (-not [string]::IsNullOrWhiteSpace($OwnerPasswordFile) -and [string]::IsNullOrWhiteSpace($OwnerEmail)) {
        throw '-OwnerEmail is required when -OwnerPasswordFile requests the optional real Owner acceptance proof.'
    }
    if (-not [string]::IsNullOrWhiteSpace($OwnerName) -or -not [string]::IsNullOrWhiteSpace($OrganisationName)) {
        throw '-OwnerName and -OrganisationName are fresh-install inputs and are not used for replacement-host restore.'
    }
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$preflightScript = Join-Path $PSScriptRoot 'personal-server-preflight.mjs'
$aclScript = Join-Path $PSScriptRoot 'personal-server-windows-acl.ps1'
$archiveVerifierScript = Join-Path $PSScriptRoot 'personal-server-release-archive.ps1'
$failedResumeSourceScript = Join-Path $PSScriptRoot 'personal-server-failed-resume-source.ps1'
. $failedResumeSourceScript

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is unavailable. CharityPilot needs it for the protected installation-location pointer.'
}

if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $StateRoot = Join-Path $env:LOCALAPPDATA 'CharityPilot\personal-server'
}
$StateRoot = [System.IO.Path]::GetFullPath($StateRoot)
$recoveryRoot = Join-Path $StateRoot 'recovery'
$statePath = Join-Path $StateRoot 'install-state.json'
$environmentPath = Join-Path $StateRoot '.env.personal-server'
$recoveryKeyPath = Join-Path $StateRoot 'recovery-key.hex'
$certificationFileName = if ($ResumeFailed) {
    'runtime-health-resume-{0}.json' -f [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')
}
else {
    'initial-runtime-health.json'
}
$certificationPath = Join-Path $StateRoot $certificationFileName
$locationPointerDirectory = Join-Path $env:LOCALAPPDATA 'CharityPilot'
$locationPointerPath = Join-Path $locationPointerDirectory 'personal-server-location.json'
$environmentVariableName = 'CHARITYPILOT_PERSONAL_SERVER_ENV_FILE'
$previousUserEnvironmentPath = [Environment]::GetEnvironmentVariable($environmentVariableName, 'User')

if ([string]::IsNullOrWhiteSpace($Origin)) {
    $Origin = "http://localhost:$Port"
}

function Confirm-ReleaseArchive {
    $archiveProvided = -not [string]::IsNullOrWhiteSpace($ArchivePath)
    $expectedProvided = -not [string]::IsNullOrWhiteSpace($ExpectedArchiveSha256)
    $checksumProvided = -not [string]::IsNullOrWhiteSpace($ChecksumPath)

    if (-not $archiveProvided -and ($expectedProvided -or $checksumProvided)) {
        throw '-ArchivePath is required when -ExpectedArchiveSha256 or -ChecksumPath is supplied.'
    }
    if ($archiveProvided -and -not ($expectedProvided -or $checksumProvided)) {
        throw 'A downloaded archive must be verified. Supply -ExpectedArchiveSha256 or its release -ChecksumPath.'
    }
    if (-not $archiveProvided) {
        return $null
    }

    $resolvedArchive = (Resolve-Path -LiteralPath $ArchivePath).Path
    $expected = if ($expectedProvided) { $ExpectedArchiveSha256.Trim().ToLowerInvariant() } else { $null }
    if ($expectedProvided -and $expected -notmatch '^[0-9a-f]{64}$') {
        throw '-ExpectedArchiveSha256 must be exactly 64 hexadecimal characters.'
    }

    if ($checksumProvided) {
        $resolvedChecksum = (Resolve-Path -LiteralPath $ChecksumPath).Path
        $checksumText = ([System.IO.File]::ReadAllText($resolvedChecksum)).Trim()
        if ($checksumText -notmatch '^([0-9A-Fa-f]{64})\s+\*?(.+)$') {
            throw 'The checksum sidecar is not in the expected SHA-256 format.'
        }
        $sidecarExpected = $Matches[1].ToLowerInvariant()
        $sidecarFile = [System.IO.Path]::GetFileName($Matches[2].Trim())
        if ($sidecarFile -cne [System.IO.Path]::GetFileName($resolvedArchive)) {
            throw 'The checksum sidecar names a different archive.'
        }
        if ($expectedProvided -and $expected -cne $sidecarExpected) {
            throw 'The expected SHA-256 and checksum sidecar disagree.'
        }
        $expected = $sidecarExpected
    }

    $actual = (Get-FileHash -LiteralPath $resolvedArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $expected) {
        throw 'Downloaded CharityPilot archive SHA-256 verification failed. Do not install this bundle.'
    }

    Write-Host "Verified downloaded release archive SHA-256: $actual"
    $script:verifiedArchivePath = $resolvedArchive
    return [ordered]@{
        file = [System.IO.Path]::GetFileName($resolvedArchive)
        sha256 = $actual
    }
}

function Confirm-InnerReleaseIdentity {
    param([object]$VerifiedArchive)

    $manifestPath = Join-Path $repositoryRoot 'personal-server-release.json'
    $manifestPresent = Test-Path -LiteralPath $manifestPath -PathType Leaf
    if (-not $manifestPresent) {
        if ($null -ne $VerifiedArchive) {
            throw 'An archive hash was supplied, but this extracted source has no personal-server-release.json identity. Ensure the ZIP and extracted folder are the same official release.'
        }
        return $null
    }
    if ($null -eq $VerifiedArchive) {
        throw 'This is a versioned release bundle. Retain its ZIP and verify it with -ArchivePath plus -ChecksumPath or -ExpectedArchiveSha256.'
    }

    try {
        $manifest = ([System.IO.File]::ReadAllText($manifestPath)) | ConvertFrom-Json
    }
    catch {
        throw 'personal-server-release.json is not valid JSON. Do not install this bundle.'
    }

    $format = Get-OptionalPropertyValue -InputObject $manifest -Name 'format'
    $tag = Get-OptionalPropertyValue -InputObject $manifest -Name 'tag'
    $commitSha = Get-OptionalPropertyValue -InputObject $manifest -Name 'commitSha'
    $commitTime = Get-OptionalPropertyValue -InputObject $manifest -Name 'commitTime'
    $profile = Get-OptionalPropertyValue -InputObject $manifest -Name 'profile'
    if ($format -cne 'charitypilot-personal-server-bundle/v1' -or
        $profile -cne 'personal-server' -or
        $tag -notmatch '^personal-v[0-9]+\.[0-9]+\.[0-9]+$' -or
        $commitSha -notmatch '^[0-9a-f]{40}$') {
        throw 'personal-server-release.json has an invalid format, tag, commit, or profile. Do not install this bundle.'
    }

    $parsedCommitTime = [DateTimeOffset]::MinValue
    $timeValid = [DateTimeOffset]::TryParse(
        [string]$commitTime,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$parsedCommitTime
    )
    if (-not $timeValid) {
        throw 'personal-server-release.json has an invalid commit timestamp. Do not install this bundle.'
    }

    $expectedArchiveName = "CharityPilot-$tag.zip"
    if ($VerifiedArchive.file -cne $expectedArchiveName) {
        throw "The verified ZIP filename does not match release identity $tag."
    }

    Write-Host "Verified inner release identity: $tag at commit $commitSha"
    return [ordered]@{
        format = $format
        tag = $tag
        commitSha = $commitSha
        commitTime = $parsedCommitTime.ToUniversalTime().ToString('o')
        profile = $profile
    }
}

function Confirm-ExtractedReleaseTree {
    param([object]$ReleaseIdentity)
    if ($null -eq $ReleaseIdentity) { return }
    & $archiveVerifierScript -ArchivePath $script:verifiedArchivePath -SourceRoot $repositoryRoot -Tag $ReleaseIdentity.tag | Out-Host
}

function Assert-OwnerInputs {
    if ([string]::IsNullOrWhiteSpace($OwnerEmail) -or
        [string]::IsNullOrWhiteSpace($OwnerName) -or
        [string]::IsNullOrWhiteSpace($OrganisationName)) {
        throw 'Real installation and -DryRun require -OwnerEmail, -OwnerName and -OrganisationName.'
    }
    if ($OwnerEmail -cne $OwnerEmail.Trim().ToLowerInvariant()) {
        throw '-OwnerEmail must be trimmed canonical lowercase.'
    }
}

function Get-OptionalPropertyValue {
    param(
        [object]$InputObject,
        [string]$Name
    )

    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Invoke-AclHelper {
    param(
        [string]$LiteralPath,
        [ValidateSet('Directory', 'File')]
        [string]$Kind,
        [switch]$VerifyOnly,
        [switch]$PlanOnly
    )

    & $aclScript -Path $LiteralPath -Kind $Kind -VerifyOnly:$VerifyOnly -DryRun:$PlanOnly
}

function Invoke-NpmCommand {
    param(
        [string[]]$Arguments,
        [string]$Phase
    )

    & $script:npmCommand @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "The supported CharityPilot operator command failed during $Phase. Review its output above."
    }
}

function Write-InstallState {
    $script:installState.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $json = $script:installState | ConvertTo-Json -Depth 8
    $temporaryPath = Join-Path $StateRoot ('.install-state-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -Force -LiteralPath $temporaryPath -Destination $statePath
        Invoke-AclHelper -LiteralPath $statePath -Kind File | Out-Host
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -Force -LiteralPath $temporaryPath
        }
    }
}

function New-RecoveryEncryptionKey {
    if (Test-Path -LiteralPath $recoveryKeyPath) {
        throw "Recovery encryption key already exists: $recoveryKeyPath"
    }
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }
    $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    $stream = [System.IO.File]::Open(
        $recoveryKeyPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try {
        $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
        try {
            $writer.WriteLine($hex)
            $writer.Flush()
            $stream.Flush($true)
        }
        finally {
            $writer.Dispose()
        }
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
    Invoke-AclHelper -LiteralPath $recoveryKeyPath -Kind File | Out-Host
}

function Resolve-RegularInputFile {
    param(
        [string]$LiteralPath,
        [string]$Label,
        [long]$MaximumBytes
    )
    $resolved = (Resolve-Path -LiteralPath $LiteralPath -ErrorAction Stop).Path
    $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -and
        -not (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -and
        $item.Length -gt 0 -and $item.Length -le $MaximumBytes) {
        return $resolved
    }
    throw "$Label must be a non-empty regular non-reparse file no larger than $MaximumBytes bytes."
}

function Resolve-RecoverySetDirectory {
    param([string]$LiteralPath)
    $resolved = (Resolve-Path -LiteralPath $LiteralPath -ErrorAction Stop).Path
    $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw '-RestoreRecoverySet must identify one real non-reparse recovery-set directory.'
    }
    return $resolved
}

function Copy-RecoveryEncryptionKey {
    param([string]$SourcePath)
    if (Test-Path -LiteralPath $recoveryKeyPath) {
        throw "Recovery encryption key already exists: $recoveryKeyPath"
    }
    $text = ([System.IO.File]::ReadAllText($SourcePath)).Trim()
    if ($text -notmatch '^[0-9A-Fa-f]{64}$') {
        throw 'The supplied recovery key must contain exactly 64 hexadecimal characters.'
    }
    $stream = [System.IO.File]::Open($recoveryKeyPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($text.ToLowerInvariant() + [Environment]::NewLine)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
    Invoke-AclHelper -LiteralPath $recoveryKeyPath -Kind File | Out-Host
}

function Write-LocationPointer {
    if (-not (Test-Path -LiteralPath $locationPointerDirectory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $locationPointerDirectory -ErrorAction Stop)
    }
    Invoke-AclHelper -LiteralPath $locationPointerDirectory -Kind Directory | Out-Host
    if (Test-Path -LiteralPath $locationPointerPath -PathType Leaf) {
        try { $existing = [System.IO.File]::ReadAllText($locationPointerPath) | ConvertFrom-Json }
        catch { throw 'The protected CharityPilot installation-location pointer is unreadable. Repair it deliberately before installing.' }
        if ($existing.format -cne 'charitypilot-personal-server-location/v1' -or
            [System.IO.Path]::GetFullPath([string]$existing.environmentPath) -cne $environmentPath -or
            [System.IO.Path]::GetFullPath([string]$existing.stateRoot) -cne $StateRoot) {
            throw 'A protected CharityPilot installation-location pointer already identifies a different installation.'
        }
        Invoke-AclHelper -LiteralPath $locationPointerPath -Kind File | Out-Host
        return $false
    }
    $value = [ordered]@{
        format = 'charitypilot-personal-server-location/v1'
        stateRoot = $StateRoot
        environmentPath = $environmentPath
        createdAt = [DateTimeOffset]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 4
    $stream = [System.IO.File]::Open($locationPointerPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($value + [Environment]::NewLine)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
    Invoke-AclHelper -LiteralPath $locationPointerPath -Kind File | Out-Host
    return $true
}

$script:resumeSourceAdvance = $null

function Read-And-ValidateFailedInstallState {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw '-ResumeFailed requires the original protected install-state.json.'
    }
    try { $state = [System.IO.File]::ReadAllText($statePath) | ConvertFrom-Json }
    catch { throw 'The failed installation state record is unreadable.' }
    if ($state.format -cne 'charitypilot-personal-server-install-state/v1' -or $state.phase -cne 'failed') {
        throw '-ResumeFailed requires an install-state.json whose phase is exactly failed.'
    }
    foreach ($binding in @(
        @('sourceRoot', $repositoryRoot),
        @('stateRoot', $StateRoot),
        @('recoveryRoot', $recoveryRoot),
        @('environmentPath', $environmentPath),
        @('recoveryKeyPath', $recoveryKeyPath)
    )) {
        $stored = Get-OptionalPropertyValue -InputObject $state -Name $binding[0]
        if ([string]::IsNullOrWhiteSpace([string]$stored) -or [System.IO.Path]::GetFullPath([string]$stored) -cne [System.IO.Path]::GetFullPath([string]$binding[1])) {
            throw "Failed-install state binding $($binding[0]) does not match this resume request."
        }
    }
    if ([string]$state.origin -cne $Origin -or [int]$state.port -ne $Port) {
        throw 'Failed-install origin or port does not match this resume request.'
    }
    if ($replacementRestore) {
        if ($state.installationMode -cne 'replacement-restore' -or
            [string]$state.restoreOperation.recoverySetPath -cne $resolvedRestoreRecoverySet -or
            [string]$state.restoreOperation.sourceOrigin -cne $SourceOrigin -or
            [string]$state.activeImageTag -cne [string]$replacementPlan.imageTag) {
            throw 'Failed replacement-host restore state does not match this exact recovery set, source origin, or image tag.'
        }
    }
    elseif ($state.installationMode -eq 'replacement-restore') {
        throw 'This failed state belongs to replacement-host restore; repeat the exact restore command, not fresh-install resume.'
    }
    if ((-not $replacementRestore -and -not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) -or
        -not (Test-Path -LiteralPath $recoveryKeyPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $recoveryRoot -PathType Container)) {
        throw 'Failed-install protected environment, recovery key, or recovery directory is missing.'
    }
    $storedRelease = Get-OptionalPropertyValue -InputObject $state.source -Name 'releaseIdentity'
    if ($null -ne $storedRelease) {
        if (-not [string]::IsNullOrWhiteSpace($RepairToGitRevision)) {
            throw '-RepairToGitRevision is never valid for a release installation.'
        }
        if ($null -eq $releaseIdentity) {
            throw 'A failed release installation requires the exact same verified release archive and checksum proof.'
        }
        if ($storedRelease.tag -cne $releaseIdentity.tag -or
            $storedRelease.commitSha -cne $releaseIdentity.commitSha -or
            $state.source.verifiedArchive.sha256 -cne $verifiedArchive.sha256) {
            throw 'Failed-install release identity does not match the same verified release archive.'
        }
    }
    elseif ($null -ne $releaseIdentity) {
        throw 'A failed clean-Git installation cannot be rebound to a release archive during resume.'
    }
    else {
        $script:resumeSourceAdvance = Resolve-CharityPilotFailedResumeSourceAdvance `
            -State $state `
            -CurrentSource $preflight.source `
            -RepairToGitRevision $RepairToGitRevision `
            -RecoveryRoot $recoveryRoot `
            -RepositoryRoot $repositoryRoot
        if ($null -ne $script:resumeSourceAdvance) {
            Write-Host "Verified failed-install source repair advance: $($script:resumeSourceAdvance.fromRevision) -> $($script:resumeSourceAdvance.toRevision)"
        }
    }
    return $state
}

$resolvedRestoreRecoverySet = $null
$resolvedRecoveryKeyInput = $null
$resolvedOwnerPasswordFile = $null
if ($replacementRestore) {
    $resolvedRestoreRecoverySet = Resolve-RecoverySetDirectory -LiteralPath $RestoreRecoverySet
    $resolvedRecoveryKeyInput = Resolve-RegularInputFile -LiteralPath $RecoveryKeyFile -Label 'Recovery key' -MaximumBytes 1024
    if (-not [string]::IsNullOrWhiteSpace($OwnerPasswordFile)) {
        $resolvedOwnerPasswordFile = Resolve-RegularInputFile -LiteralPath $OwnerPasswordFile -Label 'Owner password proof file' -MaximumBytes 1024
    }
}

$verifiedArchive = Confirm-ReleaseArchive
$releaseIdentity = Confirm-InnerReleaseIdentity -VerifiedArchive $verifiedArchive
Confirm-ExtractedReleaseTree -ReleaseIdentity $releaseIdentity

$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
$script:npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source

$preflightArguments = @(
    $preflightScript,
    "--origin=$Origin",
    "--port=$Port",
    "--state-root=$StateRoot",
    '--json'
)
if ($DryRun) { $preflightArguments += '--dry-run' }
if ($ResumeFailed) { $preflightArguments += '--resume-failed' }
elseif ($replacementRestore) { $preflightArguments += '--replacement-restore' }

$preflightOutput = (& $nodeCommand @preflightArguments | Out-String)
$preflightExit = $LASTEXITCODE
try {
    $preflight = $preflightOutput | ConvertFrom-Json
}
catch {
    throw 'The preflight did not return a valid report. Review any Node error shown above.'
}

Write-Host "CharityPilot Windows preflight: $($preflight.status.ToUpperInvariant())"
foreach ($check in $preflight.checks) {
    $label = if ($check.status -eq 'passed') { 'PASS' } else { 'FAIL' }
    Write-Host "[$label] $($check.id): $($check.summary)"
    if ($check.status -eq 'failed' -and $check.remediation) {
        Write-Host "       Fix: $($check.remediation)"
    }
}
foreach ($warning in $preflight.warnings) {
    Write-Warning "$($warning.id): $($warning.summary) $($warning.remediation)"
}
if ($preflightExit -ne 0 -or $preflight.status -ne 'passed') {
    throw 'Installation is blocked because one or more preflight checks failed. No installation state was created.'
}

$replacementPlan = $null
if ($replacementRestore) {
    $planArguments = @(
        (Join-Path $PSScriptRoot 'personal-server.mjs'),
        'bootstrap-restore-plan',
        "--recovery-set=$resolvedRestoreRecoverySet",
        "--source-origin=$SourceOrigin",
        "--origin=$Origin",
        "--port=$Port",
        "--encryption-key-file=$resolvedRecoveryKeyInput"
    )
    $planOutput = (& $nodeCommand @planArguments | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw 'Replacement-host recovery-set, key, origin, or exact source verification failed. No installation state was created.'
    }
    try { $replacementPlan = $planOutput | ConvertFrom-Json }
    catch { throw 'Replacement-host recovery plan did not return valid JSON. No installation state was created.' }
    if ($replacementPlan.format -cne 'charitypilot-personal-replacement-restore-plan/v1' -or
        [string]$replacementPlan.recoverySetPath -cne $resolvedRestoreRecoverySet -or
        [string]$replacementPlan.sourceOrigin -cne $SourceOrigin -or
        [string]$replacementPlan.targetOrigin -cne $Origin) {
        throw 'Replacement-host recovery plan does not match the requested path or origins.'
    }
    Write-Host "Verified replacement recovery set: $($replacementPlan.recoverySetId)"
    Write-Host "Required confirmation: $($replacementPlan.confirmation)"
    Write-Host 'The replacement will generate fresh database/JWT/readiness secrets and revoke every restored session.'
    if (-not $PreflightOnly -and $Confirm -cne [string]$replacementPlan.confirmation) {
        throw 'The supplied -Confirm value does not exactly match the authenticated replacement recovery plan. No installation state was created.'
    }
}

$resumeState = if ($ResumeFailed) { Read-And-ValidateFailedInstallState } else { $null }

if ($PreflightOnly) {
    Write-Host 'Preflight passed. No installation state was created.'
    exit 0
}

if (-not $ResumeFailed -and -not $replacementRestore) { Assert-OwnerInputs }

$initArguments = if ($replacementRestore) {
    $restoreArguments = @(
        'run', 'personal:server:bootstrap-restore', '--',
        "--recovery-set=$resolvedRestoreRecoverySet",
        "--source-origin=$SourceOrigin",
        "--origin=$Origin",
        "--port=$Port",
        "--confirm=$Confirm",
        "--encryption-key-file=$recoveryKeyPath"
    )
    if (-not [string]::IsNullOrWhiteSpace($OwnerEmail)) { $restoreArguments += "--owner-email=$OwnerEmail" }
    if ($null -ne $resolvedOwnerPasswordFile) { $restoreArguments += "--owner-password-file=$resolvedOwnerPasswordFile" }
    $restoreArguments
}
elseif ($ResumeFailed) {
    @('run', 'personal:server:resume-init', '--')
}
else {
    @(
        'run',
        'personal:server:init',
        '--',
        "--owner-email=$OwnerEmail",
        "--owner-name=$OwnerName",
        "--organisation-name=$OrganisationName",
        "--origin=$Origin",
        "--port=$Port"
    )
}

if ($DryRun) {
    Write-Host 'DRY RUN: the following ACL and initialization plan is read-only.'
    Invoke-AclHelper -LiteralPath $StateRoot -Kind Directory -PlanOnly | Out-Host
    Invoke-AclHelper -LiteralPath $recoveryRoot -Kind Directory -PlanOnly | Out-Host
    Invoke-AclHelper -LiteralPath $environmentPath -Kind File -PlanOnly | Out-Host
    Invoke-AclHelper -LiteralPath $recoveryKeyPath -Kind File -PlanOnly | Out-Host
    if ($replacementRestore) {
        Write-Host 'DRY RUN: authenticated recovery/source/origin binding passed; the real command would create protected state, rotate host secrets, run a disposable full-application rehearsal, create exact Compose targets, restore, revoke old sessions, and certify.'
    }
    else {
        $initArguments += '--dry-run'
        $previousProcessEnvironmentPath = $env:CHARITYPILOT_PERSONAL_SERVER_ENV_FILE
        $env:CHARITYPILOT_PERSONAL_SERVER_ENV_FILE = $environmentPath
        Push-Location $repositoryRoot
        try {
            Invoke-NpmCommand -Arguments $initArguments -Phase 'initialization dry run'
        }
        finally {
            Pop-Location
            $env:CHARITYPILOT_PERSONAL_SERVER_ENV_FILE = $previousProcessEnvironmentPath
        }
    }
    Write-Host 'Dry run complete. No directory, environment file, container, volume, network, image, database, organisation or account was created.'
    exit 0
}

$initializationStarted = $false
$installationStartedAt = [DateTimeOffset]::UtcNow.ToString('o')
$environmentPointerChanged = $false
$locationPointerCreated = $false
$tailscaleServeCreated = $false
$stateRootCreated = $false
$recoveryRootCreated = $false
$recoveryKeyCreated = $false

try {
    if ($ResumeFailed) {
        Invoke-AclHelper -LiteralPath $StateRoot -Kind Directory | Out-Host
        Invoke-AclHelper -LiteralPath $recoveryRoot -Kind Directory | Out-Host
        if (Test-Path -LiteralPath $environmentPath -PathType Leaf) {
            Invoke-AclHelper -LiteralPath $environmentPath -Kind File | Out-Host
        }
        Invoke-AclHelper -LiteralPath $recoveryKeyPath -Kind File | Out-Host
        [void](Write-LocationPointer)
        if (-not [string]::IsNullOrWhiteSpace($previousUserEnvironmentPath) -and
            [System.IO.Path]::GetFullPath($previousUserEnvironmentPath) -cne $environmentPath) {
            throw "The user environment already points to a different CharityPilot personal-server environment: $previousUserEnvironmentPath"
        }
        [Environment]::SetEnvironmentVariable($environmentVariableName, $environmentPath, 'User')
        $env:CHARITYPILOT_PERSONAL_SERVER_ENV_FILE = $environmentPath
        $environmentPointerChanged = $true
        $script:installState = $resumeState
        if ($null -ne $script:resumeSourceAdvance) {
            $existingSourceAdvances = Get-OptionalPropertyValue -InputObject $script:installState -Name 'failedResumeSourceAdvances'
            $sourceAdvanceHistory = @()
            if ($null -ne $existingSourceAdvances) {
                $sourceAdvanceHistory += @($existingSourceAdvances)
            }
            if ($sourceAdvanceHistory.Count -ge 32) {
                throw 'Failed-install source repair history exceeds its bounded safety limit.'
            }
            foreach ($priorSourceAdvance in $sourceAdvanceHistory) {
                if ($priorSourceAdvance.format -cne 'charitypilot-personal-server-failed-resume-source-advance/v1' -or
                    [string]$priorSourceAdvance.fromRevision -cnotmatch '^[0-9a-f]{40}$' -or
                    [string]$priorSourceAdvance.toRevision -cnotmatch '^[0-9a-f]{40}$') {
                    throw 'Failed-install source repair history is malformed.'
                }
            }
            $sourceAdvanceHistory += [pscustomobject]$script:resumeSourceAdvance
            $sourceAdvanceProperty = $script:installState.PSObject.Properties['failedResumeSourceAdvances']
            if ($null -eq $sourceAdvanceProperty) {
                $script:installState | Add-Member -MemberType NoteProperty -Name 'failedResumeSourceAdvances' -Value $sourceAdvanceHistory
            }
            else {
                $script:installState.failedResumeSourceAdvances = $sourceAdvanceHistory
            }
            $script:installState.source.kind = $preflight.source.kind
            $script:installState.source.revision = $preflight.source.revision
            $script:installState.source.branch = $preflight.source.branch
            $script:installState.source.canonicalRemote = $preflight.source.canonicalRemote
            $script:installState.source.canonicalTrackingRef = $preflight.source.canonicalTrackingRef
            $script:installState.source.originMasterRevision = $preflight.source.originMasterRevision
            Write-InstallState
            Write-Host 'Protected failed-install state now records the verified canonical descendant repair source.'
        }
    }
    else {
      if (-not (Test-Path -LiteralPath $StateRoot -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $StateRoot -ErrorAction Stop)
        $stateRootCreated = $true
      }
      if (-not (Test-Path -LiteralPath $recoveryRoot -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $recoveryRoot -ErrorAction Stop)
        $recoveryRootCreated = $true
      }
      Invoke-AclHelper -LiteralPath $StateRoot -Kind Directory | Out-Host
      Invoke-AclHelper -LiteralPath $recoveryRoot -Kind Directory | Out-Host
      $locationPointerCreated = Write-LocationPointer

      if (-not [string]::IsNullOrWhiteSpace($previousUserEnvironmentPath) -and
        [System.IO.Path]::GetFullPath($previousUserEnvironmentPath) -cne $environmentPath) {
        throw "The user environment already points to a different CharityPilot personal-server environment: $previousUserEnvironmentPath"
      }
      [Environment]::SetEnvironmentVariable($environmentVariableName, $environmentPath, 'User')
      $env:CHARITYPILOT_PERSONAL_SERVER_ENV_FILE = $environmentPath
      $environmentPointerChanged = $true
      if ($replacementRestore) {
        Copy-RecoveryEncryptionKey -SourcePath $resolvedRecoveryKeyInput
      }
      else {
        New-RecoveryEncryptionKey
      }
      $recoveryKeyCreated = $true

      $sourceRecord = [ordered]@{
        kind = $preflight.source.kind
        revision = Get-OptionalPropertyValue -InputObject $preflight.source -Name 'revision'
        fingerprint = Get-OptionalPropertyValue -InputObject $preflight.source -Name 'fingerprint'
        branch = Get-OptionalPropertyValue -InputObject $preflight.source -Name 'branch'
        canonicalRemote = Get-OptionalPropertyValue -InputObject $preflight.source -Name 'canonicalRemote'
        canonicalTrackingRef = Get-OptionalPropertyValue -InputObject $preflight.source -Name 'canonicalTrackingRef'
        originMasterRevision = Get-OptionalPropertyValue -InputObject $preflight.source -Name 'originMasterRevision'
        verifiedArchive = $verifiedArchive
        releaseIdentity = $releaseIdentity
      }
      $script:installState = [ordered]@{
        format = 'charitypilot-personal-server-install-state/v1'
         phase = 'initializing'
         installationMode = if ($replacementRestore) { 'replacement-restore' } else { 'fresh-install' }
        startedAt = $installationStartedAt
        updatedAt = $installationStartedAt
        sourceRoot = $repositoryRoot
        source = $sourceRecord
        activeImageTag = if ($null -ne $releaseIdentity) { [string]$releaseIdentity.tag } else { 'local' }
        origin = $Origin
        port = $Port
        stateRoot = $StateRoot
        recoveryRoot = $recoveryRoot
        environmentPath = $environmentPath
        recoveryKeyPath = $recoveryKeyPath
         locationPointerPath = $locationPointerPath
         restoreOperation = if ($replacementRestore) {
             [ordered]@{
                 recoverySetPath = $resolvedRestoreRecoverySet
                 recoverySetId = [string]$replacementPlan.recoverySetId
                 sourceOrigin = $SourceOrigin
                 targetOrigin = $Origin
                 confirmation = [string]$replacementPlan.confirmation
                 secretsRotated = @('POSTGRES_PASSWORD', 'JWT_SECRET', 'READINESS_API_KEY')
                 startedAt = $installationStartedAt
             }
         }
         else { $null }
      }
      if ($replacementRestore) { $script:installState.phase = 'restore-prepared' }
      Write-InstallState
    }

    Push-Location $repositoryRoot
    try {
        $initializationStarted = $true
        Invoke-NpmCommand -Arguments $initArguments -Phase 'one-time initialization'

        if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
            throw 'Initialization returned without creating the required private environment file.'
        }
        Invoke-AclHelper -LiteralPath $environmentPath -Kind File | Out-Host
        if ($replacementRestore) {
            try { $restoredState = [System.IO.File]::ReadAllText($statePath) | ConvertFrom-Json }
            catch { throw 'Replacement-host restore completed without a readable protected state record.' }
            if ($restoredState.format -cne 'charitypilot-personal-server-install-state/v1' -or
                $restoredState.installationMode -cne 'replacement-restore' -or
                $restoredState.phase -cne 'initialized-backup-pending' -or
                [string]$restoredState.restoredFrom.recoverySetId -cne [string]$replacementPlan.recoverySetId) {
                throw 'Replacement-host restore did not publish the expected protected post-cutover state.'
            }
            $script:installState = $restoredState
        }
        else {
            $script:installState.phase = 'initialized-backup-pending'
        }
        Write-InstallState

        Invoke-NpmCommand -Arguments @('run', 'personal:server:status') -Phase 'post-install health verification'
        if ($Origin.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) {
            $serveCheck = $preflight.checks | Where-Object { $_.id -eq 'access.tailscale-serve-safe' } | Select-Object -First 1
            $serveMode = Get-OptionalPropertyValue -InputObject (Get-OptionalPropertyValue -InputObject $serveCheck -Name 'details') -Name 'mode'
            if ($serveMode -eq 'empty') {
                $tailscale = (Get-Command tailscale.exe -ErrorAction Stop).Source
                & $tailscale serve --bg --https=443 "http://127.0.0.1:$Port"
                if ($LASTEXITCODE -ne 0) { throw 'Tailscale Serve could not create the exact private HTTPS proxy.' }
                $tailscaleServeCreated = $true
            }
            elseif ($serveMode -cne 'exact') {
                throw 'Tailscale Serve preflight state was not safely empty or exact.'
            }
        }
        Invoke-NpmCommand -Arguments @(
            'run', 'personal:server:backup', '--',
            "--output-dir=$recoveryRoot",
            "--encryption-key-file=$recoveryKeyPath"
        ) -Phase 'first encrypted recovery backup'

        $recoverySet = Get-ChildItem -LiteralPath $recoveryRoot -Directory -Force |
            Where-Object { -not $_.Name.StartsWith('.') } |
            Sort-Object -Property LastWriteTimeUtc, Name |
            Select-Object -Last 1
        if ($null -eq $recoverySet) {
            throw 'The first backup completed without publishing a recovery-set directory.'
        }
        Invoke-NpmCommand -Arguments @(
            'run', 'personal:server:rehearse-restore', '--',
            "--recovery-set=$($recoverySet.FullName)",
            "--encryption-key-file=$recoveryKeyPath"
        ) -Phase 'first full restore rehearsal'

        $certificationArguments = @(
            'run', 'personal:server:certify', '--',
            "--env-file=$environmentPath",
            "--report-file=$certificationPath"
        )
        if ($Origin.StartsWith('http://', [System.StringComparison]::OrdinalIgnoreCase)) {
            $certificationArguments += '--local-only'
        }
        Invoke-NpmCommand -Arguments $certificationArguments -Phase 'live runtime health attestation'
        Invoke-AclHelper -LiteralPath $certificationPath -Kind File | Out-Host
        $script:installState.runtimeHealthReportPath = $certificationPath

        Invoke-AclHelper -LiteralPath $StateRoot -Kind Directory -VerifyOnly | Out-Host
        Invoke-AclHelper -LiteralPath $recoveryRoot -Kind Directory -VerifyOnly | Out-Host
        Invoke-AclHelper -LiteralPath $environmentPath -Kind File -VerifyOnly | Out-Host
        Invoke-AclHelper -LiteralPath $recoveryKeyPath -Kind File -VerifyOnly | Out-Host
        Invoke-AclHelper -LiteralPath $certificationPath -Kind File -VerifyOnly | Out-Host
        Invoke-AclHelper -LiteralPath $locationPointerPath -Kind File -VerifyOnly | Out-Host
        $script:installState.phase = 'ready'
        $script:installState.restoreOperation = $null
        $script:installState.readyAt = [DateTimeOffset]::UtcNow.ToString('o')
        Write-InstallState
    }
    finally {
        Pop-Location
    }

    Write-Host ''
    Write-Host 'CharityPilot personal-server installation is READY.'
    Write-Host "Website: $Origin"
    Write-Host "Protected recovery root: $recoveryRoot"
    Write-Host "Protected recovery key: $recoveryKeyPath"
    Write-Host 'Copy the recovery key separately to an encrypted offline location; never store it beside copied recovery sets.'
    if ($replacementRestore) {
        Write-Host 'Replacement-host recovery generated fresh host secrets and revoked every pre-recovery application session. Existing account passwords were not reset.'
    }
    else {
        Write-Host 'Store the one-time Owner password printed by initialization in the Owner password manager now.'
    }
}
catch {
    $originalError = $_
    if (Test-Path -LiteralPath $environmentPath -PathType Leaf) {
        try {
            Invoke-AclHelper -LiteralPath $environmentPath -Kind File | Out-Host
        }
        catch {
            Write-Error 'CRITICAL: the private environment file ACL could not be enforced. Stop using this checkout and restrict access immediately.' -ErrorAction Continue
        }
    }
    if ($null -ne (Get-Variable -Name installState -Scope Script -ErrorAction SilentlyContinue)) {
        try {
            $failedFromPhase = if ($script:installState.phase -eq 'failed' -and
                -not [string]::IsNullOrWhiteSpace([string]$script:installState.failedFromPhase)) {
                [string]$script:installState.failedFromPhase
            }
            else { [string]$script:installState.phase }
            $script:installState.phase = 'failed'
            $script:installState.failedFromPhase = $failedFromPhase
            $script:installState.failedAt = [DateTimeOffset]::UtcNow.ToString('o')
            Write-InstallState
        }
        catch {
            Write-Error 'The protected installation state record could not be updated.' -ErrorAction Continue
        }
    }
    if ($initializationStarted) {
        try {
            Push-Location $repositoryRoot
            Invoke-NpmCommand -Arguments @('run', 'personal:server:stop') -Phase 'fail-closed shutdown'
        }
        catch {
            Write-Error 'The incomplete installation could not be stopped automatically. Run npm run personal:server:stop.' -ErrorAction Continue
        }
        finally {
            Pop-Location
        }
    }
    elseif ($environmentPointerChanged) {
        [Environment]::SetEnvironmentVariable($environmentVariableName, $previousUserEnvironmentPath, 'User')
        $env:CHARITYPILOT_PERSONAL_SERVER_ENV_FILE = $previousUserEnvironmentPath
    }
    if ($tailscaleServeCreated) {
        try {
            & tailscale.exe serve reset
            if ($LASTEXITCODE -ne 0) { throw 'tailscale serve reset failed' }
        }
        catch {
            Write-Error 'The installer-created Tailscale Serve proxy could not be reset after failure. Run tailscale serve reset after reviewing its status.' -ErrorAction Continue
        }
    }
    if (-not $initializationStarted -and $locationPointerCreated -and (Test-Path -LiteralPath $locationPointerPath -PathType Leaf)) {
        Remove-Item -Force -LiteralPath $locationPointerPath
    }
    if (-not $initializationStarted -and $null -eq (Get-Variable -Name installState -Scope Script -ErrorAction SilentlyContinue)) {
        if ($recoveryKeyCreated -and (Test-Path -LiteralPath $recoveryKeyPath -PathType Leaf)) {
            Remove-Item -Force -LiteralPath $recoveryKeyPath
        }
        if ($recoveryRootCreated -and (Test-Path -LiteralPath $recoveryRoot -PathType Container)) {
            Remove-Item -Force -Recurse -LiteralPath $recoveryRoot
        }
        if ($stateRootCreated -and (Test-Path -LiteralPath $StateRoot -PathType Container)) {
            Remove-Item -Force -Recurse -LiteralPath $StateRoot
        }
    }
    if ($initializationStarted) {
        Write-Warning 'The failed installation was preserved. After fixing the reported cause, rerun this same command with -ResumeFailed and the same source, StateRoot, Origin, Port, and archive verification arguments.'
    }
    throw $originalError
}
