[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^personal-v[0-9]+\.[0-9]+\.[0-9]+$')]
    [string]$Tag
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-StreamSha256 {
    param([System.IO.Stream]$Stream)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

$resolvedArchive = (Resolve-Path -LiteralPath $ArchivePath).Path
$resolvedSource = (Resolve-Path -LiteralPath $SourceRoot).Path.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
)
if (-not (Test-Path -LiteralPath $resolvedArchive -PathType Leaf)) {
    throw 'The verified release archive is not a regular file.'
}
if (-not (Test-Path -LiteralPath $resolvedSource -PathType Container)) {
    throw 'The extracted release source root is not a directory.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$expectedPrefix = "CharityPilot-$Tag/"
$sourcePrefix = $resolvedSource + [System.IO.Path]::DirectorySeparatorChar
$expectedEntries = @{}
$archive = [System.IO.Compression.ZipFile]::OpenRead($resolvedArchive)
try {
    foreach ($entry in $archive.Entries) {
        $rawName = $entry.FullName
        $name = $rawName.Replace('\', '/')
        if ([string]::IsNullOrWhiteSpace($name) -or -not $name.StartsWith($expectedPrefix, [System.StringComparison]::Ordinal)) {
            throw "Release archive contains an entry outside its exact top-level directory: $rawName"
        }
        $relative = $name.Substring($expectedPrefix.Length)
        if ([string]::IsNullOrEmpty($relative)) { continue }
        $isDirectory = $relative.EndsWith('/', [System.StringComparison]::Ordinal)
        $relative = $relative.TrimEnd('/')
        if ([string]::IsNullOrEmpty($relative)) { continue }
        $segments = $relative.Split('/')
        if ($segments | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -eq '.' -or $_ -eq '..' }) {
            throw "Release archive contains an unsafe path: $name"
        }

        $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
        if ($unixType -eq 0xA000) { throw "Release archive contains a symbolic link: $name" }
        if (-not $isDirectory -and $unixType -ne 0 -and $unixType -ne 0x8000) {
            throw "Release archive contains a non-regular entry: $name"
        }

        $key = $relative.ToLowerInvariant()
        if ($expectedEntries.ContainsKey($key)) { throw "Release archive contains a duplicate path: $relative" }
        $expectedEntries[$key] = if ($isDirectory) { 'directory' } else { 'file' }

        $parent = [System.IO.Path]::GetDirectoryName($relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
        while (-not [string]::IsNullOrEmpty($parent)) {
            $parentKey = $parent.Replace([System.IO.Path]::DirectorySeparatorChar, '/').ToLowerInvariant()
            if (-not $expectedEntries.ContainsKey($parentKey)) { $expectedEntries[$parentKey] = 'directory' }
            $parent = [System.IO.Path]::GetDirectoryName($parent)
        }

        if ($isDirectory) { continue }
        $localPath = $resolvedSource
        foreach ($segment in $segments) { $localPath = Join-Path $localPath $segment }
        $localPath = [System.IO.Path]::GetFullPath($localPath)
        if (-not $localPath.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Release archive path escapes the extracted source root: $name"
        }
        $item = Get-Item -Force -LiteralPath $localPath
        if ($item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "Extracted release path is not a regular non-link file: $relative"
        }
        if ($item.Length -ne $entry.Length) { throw "Extracted release file size differs from the verified archive: $relative" }
        $entryStream = $entry.Open()
        try { $archiveHash = Get-StreamSha256 -Stream $entryStream }
        finally { $entryStream.Dispose() }
        $localStream = [System.IO.File]::Open($localPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        try { $localHash = Get-StreamSha256 -Stream $localStream }
        finally { $localStream.Dispose() }
        if ($archiveHash -cne $localHash) { throw "Extracted release file differs from the verified archive: $relative" }
    }
}
finally {
    $archive.Dispose()
}

$seen = @{}
foreach ($item in Get-ChildItem -Force -Recurse -LiteralPath $resolvedSource) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Extracted release contains a reparse point: $($item.FullName)"
    }
    $relative = $item.FullName.Substring($sourcePrefix.Length).Replace([System.IO.Path]::DirectorySeparatorChar, '/')
    $key = $relative.ToLowerInvariant()
    $kind = if ($item.PSIsContainer) { 'directory' } else { 'file' }
    if (-not $expectedEntries.ContainsKey($key) -or $expectedEntries[$key] -cne $kind) {
        throw "Extracted release contains an entry absent from the verified archive: $relative"
    }
    $seen[$key] = $kind
}
if ($seen.Count -ne $expectedEntries.Count) {
    throw 'Extracted release does not contain every entry from the verified archive.'
}

Write-Output "Verified extracted release tree against $([System.IO.Path]::GetFileName($resolvedArchive)): $($seen.Count) entries."
