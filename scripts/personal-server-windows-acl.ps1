[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Directory', 'File')]
    [string]$Kind,

    [switch]$VerifyOnly,

    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'The CharityPilot ACL helper can run only on Windows NTFS storage.'
}

if ($VerifyOnly -and $DryRun) {
    throw '-VerifyOnly and -DryRun cannot be used together.'
}

$fullPath = [System.IO.Path]::GetFullPath($Path)
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$allowedSidValues = @($currentSid.Value, $systemSid.Value)

function Assert-SafeTarget {
    param(
        [string]$LiteralPath,
        [string]$ExpectedKind,
        [bool]$MayBeAbsent
    )

    if (-not (Test-Path -LiteralPath $LiteralPath)) {
        if ($MayBeAbsent) {
            return
        }
        throw "ACL target does not exist: $LiteralPath"
    }

    $item = Get-Item -Force -LiteralPath $LiteralPath
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to change ACLs through a reparse point: $LiteralPath"
    }
    if ($ExpectedKind -eq 'Directory' -and -not $item.PSIsContainer) {
        throw "Expected an ACL directory target: $LiteralPath"
    }
    if ($ExpectedKind -eq 'File' -and $item.PSIsContainer) {
        throw "Expected an ACL file target: $LiteralPath"
    }
}

function New-OwnerOnlyAcl {
    param([string]$TargetKind)

    if ($TargetKind -eq 'Directory') {
        $security = New-Object System.Security.AccessControl.DirectorySecurity
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        foreach ($sid in @($currentSid, $systemSid)) {
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $sid,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [System.Security.AccessControl.PropagationFlags]::None,
                [System.Security.AccessControl.AccessControlType]::Allow
            )
            [void]$security.AddAccessRule($rule)
        }
    }
    else {
        $security = New-Object System.Security.AccessControl.FileSecurity
        foreach ($sid in @($currentSid, $systemSid)) {
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $sid,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                [System.Security.AccessControl.AccessControlType]::Allow
            )
            [void]$security.AddAccessRule($rule)
        }
    }

    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($currentSid)
    return $security
}

function Assert-OwnerOnlyAcl {
    param(
        [string]$LiteralPath,
        [string]$TargetKind
    )

    $acl = Get-Acl -LiteralPath $LiteralPath
    $ownerAccount = New-Object System.Security.Principal.NTAccount($acl.Owner)
    $ownerSid = $ownerAccount.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -ne $currentSid.Value) {
        throw "ACL verification failed: current operator is not the owner of $LiteralPath"
    }
    if (-not $acl.AreAccessRulesProtected) {
        throw "ACL verification failed: inherited permissions remain enabled on $LiteralPath"
    }

    $rules = @($acl.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
    ))
    if ($rules.Count -ne 2) {
        throw "ACL verification failed: expected exactly two explicit access rules on $LiteralPath"
    }

    foreach ($rule in $rules) {
        if ($rule.IsInherited) {
            throw "ACL verification failed: an inherited rule remains on $LiteralPath"
        }
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            throw "ACL verification failed: a non-Allow rule remains on $LiteralPath"
        }
        if ($allowedSidValues -notcontains $rule.IdentityReference.Value) {
            throw "ACL verification failed: an unexpected identity can access $LiteralPath"
        }
        $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
        if (($rule.FileSystemRights -band $fullControl) -ne $fullControl) {
            throw "ACL verification failed: an expected identity lacks FullControl on $LiteralPath"
        }
        if ($TargetKind -eq 'Directory') {
            $requiredInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
                [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
            if (($rule.InheritanceFlags -band $requiredInheritance) -ne $requiredInheritance) {
                throw "ACL verification failed: child inheritance is incomplete on $LiteralPath"
            }
        }
        elseif ($rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) {
            throw "ACL verification failed: a file rule unexpectedly has inheritance flags on $LiteralPath"
        }
    }

    foreach ($sidValue in $allowedSidValues) {
        if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq $sidValue })) {
            throw "ACL verification failed: an expected protected identity is missing on $LiteralPath"
        }
    }
}

Assert-SafeTarget -LiteralPath $fullPath -ExpectedKind $Kind -MayBeAbsent $DryRun.IsPresent

if ($DryRun) {
    Write-Output "DRY RUN: would replace inherited access on $fullPath with FullControl for only the current operator SID and LOCAL SYSTEM."
    exit 0
}

if (-not $VerifyOnly) {
    $alreadyCompliant = $false
    try {
        Assert-OwnerOnlyAcl -LiteralPath $fullPath -TargetKind $Kind
        $alreadyCompliant = $true
    }
    catch {
        # Replacement below is required. Do not treat a non-compliant ACL as a
        # soft warning: Set-Acl and the final verification must both succeed.
    }

    if (-not $alreadyCompliant) {
        $ownerOnlyAcl = New-OwnerOnlyAcl -TargetKind $Kind
        Set-Acl -LiteralPath $fullPath -AclObject $ownerOnlyAcl
    }
}

Assert-OwnerOnlyAcl -LiteralPath $fullPath -TargetKind $Kind
Write-Output "Verified protected owner-only ACL: $fullPath"
