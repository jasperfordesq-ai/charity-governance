Set-StrictMode -Version 2.0

function Get-CharityPilotOptionalPropertyValue {
    param(
        [object]$InputObject,
        [string]$Name
    )

    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Resolve-CharityPilotFailedResumeSourceAdvance {
    param(
        [Parameter(Mandatory = $true)]
        [object]$State,
        [Parameter(Mandatory = $true)]
        [object]$CurrentSource,
        [string]$RepairToGitRevision,
        [Parameter(Mandatory = $true)]
        [string]$RecoveryRoot,
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot,
        [scriptblock]$AncestorCheck
    )

    $recordedSource = Get-CharityPilotOptionalPropertyValue -InputObject $State -Name 'source'
    $recordedKind = [string](Get-CharityPilotOptionalPropertyValue -InputObject $recordedSource -Name 'kind')
    $recordedRevision = [string](Get-CharityPilotOptionalPropertyValue -InputObject $recordedSource -Name 'revision')
    $recordedBranch = [string](Get-CharityPilotOptionalPropertyValue -InputObject $recordedSource -Name 'branch')
    $recordedCanonicalRemote = Get-CharityPilotOptionalPropertyValue -InputObject $recordedSource -Name 'canonicalRemote'
    $recordedCanonicalTrackingRef = Get-CharityPilotOptionalPropertyValue -InputObject $recordedSource -Name 'canonicalTrackingRef'
    $recordedOriginMasterRevision = [string](Get-CharityPilotOptionalPropertyValue -InputObject $recordedSource -Name 'originMasterRevision')
    $recordedArchive = Get-CharityPilotOptionalPropertyValue -InputObject $recordedSource -Name 'verifiedArchive'
    $recordedRelease = Get-CharityPilotOptionalPropertyValue -InputObject $recordedSource -Name 'releaseIdentity'
    if ($recordedKind -cne 'git' -or
        $recordedRevision -cnotmatch '^[0-9a-f]{40}$' -or
        $recordedBranch -cne 'master' -or
        $recordedCanonicalRemote -ne $true -or
        $recordedCanonicalTrackingRef -ne $true -or
        $recordedOriginMasterRevision -cne $recordedRevision -or
        $null -ne $recordedArchive -or
        $null -ne $recordedRelease) {
        throw 'Failed-install Git identity is not a complete canonical clean-master binding.'
    }

    $currentKind = [string](Get-CharityPilotOptionalPropertyValue -InputObject $CurrentSource -Name 'kind')
    $currentRevision = [string](Get-CharityPilotOptionalPropertyValue -InputObject $CurrentSource -Name 'revision')
    $currentBranch = [string](Get-CharityPilotOptionalPropertyValue -InputObject $CurrentSource -Name 'branch')
    $currentCanonicalRemote = Get-CharityPilotOptionalPropertyValue -InputObject $CurrentSource -Name 'canonicalRemote'
    $currentCanonicalTrackingRef = Get-CharityPilotOptionalPropertyValue -InputObject $CurrentSource -Name 'canonicalTrackingRef'
    $currentOriginMasterRevision = [string](Get-CharityPilotOptionalPropertyValue -InputObject $CurrentSource -Name 'originMasterRevision')
    $currentClean = Get-CharityPilotOptionalPropertyValue -InputObject $CurrentSource -Name 'clean'
    if ($currentKind -cne 'git' -or
        $currentRevision -cnotmatch '^[0-9a-f]{40}$' -or
        $currentBranch -cne 'master' -or
        $currentCanonicalRemote -ne $true -or
        $currentCanonicalTrackingRef -ne $true -or
        $currentOriginMasterRevision -cne $currentRevision -or
        $currentClean -ne $true) {
        throw 'Failed-install resume requires the current source to be clean canonical master at its already-fetched origin/master.'
    }

    if ($currentRevision -ceq $recordedRevision) {
        if (-not [string]::IsNullOrWhiteSpace($RepairToGitRevision)) {
            throw '-RepairToGitRevision is not valid because the current source still equals the recorded failed revision.'
        }
        return $null
    }

    if ($State.installationMode -cne 'fresh-install' -or
        [string]$State.activeImageTag -cne 'local' -or
        [string]$State.failedFromPhase -cne 'initializing') {
        throw 'Only a failed unreleased clean-Git fresh install from the initializing phase may advance to a repaired canonical descendant.'
    }
    $publishedRecoverySets = @(
        Get-ChildItem -LiteralPath $RecoveryRoot -Directory -Force |
            Where-Object { -not $_.Name.StartsWith('.') }
    )
    if ($publishedRecoverySets.Count -ne 0) {
        throw 'A failed install with a published recovery set must remain on its exact recorded source.'
    }
    if ([string]::IsNullOrWhiteSpace($RepairToGitRevision)) {
        throw "Canonical source changed after failure. Repeat with -RepairToGitRevision $currentRevision only after reviewing that repair commit."
    }
    if ($RepairToGitRevision -cne $currentRevision) {
        throw '-RepairToGitRevision must exactly equal current clean canonical origin/master.'
    }

    if ($null -eq $AncestorCheck) {
        $gitCommand = (Get-Command git.exe -ErrorAction Stop).Source
        & $gitCommand -C $RepositoryRoot merge-base --is-ancestor $recordedRevision $currentRevision | Out-Null
        $isAncestor = $LASTEXITCODE -eq 0
    }
    else {
        $isAncestor = & $AncestorCheck $recordedRevision $currentRevision $RepositoryRoot
    }
    if ($isAncestor -ne $true) {
        throw 'Failed-install source repair is allowed only when current canonical master is a strict descendant of the recorded failed revision.'
    }

    return [ordered]@{
        format = 'charitypilot-personal-server-failed-resume-source-advance/v1'
        fromRevision = $recordedRevision
        toRevision = $currentRevision
        verifiedAt = [DateTimeOffset]::UtcNow.ToString('o')
    }
}
