function Assert-CharityPilotLocalDockerBoundary {
    [CmdletBinding()]
    param()

    foreach ($entry in Get-ChildItem Env:) {
        if ($entry.Name -match '^(DOCKER_HOST|DOCKER_TLS|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|DOCKER_API_VERSION|DOCKER_BUILDKIT|DOCKER_DEFAULT_PLATFORM|DOCKER_CONFIG|BUILDKIT_.+|BUILDX_.+)$' -and
            -not [string]::IsNullOrWhiteSpace([string]$entry.Value)) {
            throw 'Clear Docker daemon, API, config and builder environment overrides before using the personal-server profile.'
        }
    }

    $endpointResult = (& docker context inspect --format '{{.Endpoints.docker.Host}}|{{.Endpoints.docker.SkipTLSVerify}}' 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the effective Docker context.' }
    $endpointParts = @($endpointResult -split '\|', 2)
    if ($endpointParts.Count -ne 2) { throw 'Docker context inspection returned an invalid endpoint identity.' }
    $endpoint = $endpointParts[0].Trim()
    $skipTlsVerify = $endpointParts[1].Trim()
    $localEndpoints = @(
        'npipe:////./pipe/dockerDesktopLinuxEngine',
        'npipe:////./pipe/docker_engine'
    )
    if (-not ($localEndpoints -contains $endpoint) -or $skipTlsVerify -cne 'false') {
        throw 'The effective Docker endpoint is not the local Windows Docker Desktop named pipe.'
    }

    $previousContext = $env:DOCKER_CONTEXT
    $previousHost = $env:DOCKER_HOST
    try {
        Remove-Item Env:DOCKER_CONTEXT -ErrorAction SilentlyContinue
        $env:DOCKER_HOST = $endpoint
        $info = (& docker info --format '{{.OperatingSystem}}|{{.OSType}}' 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $info -cne 'Docker Desktop|linux') {
            throw 'The verified local Docker endpoint is not Docker Desktop in Linux-container mode.'
        }
        $versionText = (& docker version --format '{{.Server.Version}}|{{.Server.APIVersion}}' 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Could not read the local Docker Engine version.' }
        $versionParts = @($versionText -split '\|', 2)
        $engineVersion = $null
        $apiVersion = $null
        if ($versionParts.Count -ne 2 -or
            -not [Version]::TryParse($versionParts[0], [ref]$engineVersion) -or
            -not [Version]::TryParse($versionParts[1], [ref]$apiVersion) -or
            $engineVersion -lt [Version]'28.0.0' -or
            $apiVersion -lt [Version]'1.48') {
            throw 'Docker Engine 28.0.0 / API 1.48 or later is required.'
        }
        $composeText = (& docker compose version --short 2>$null | Out-String).Trim().TrimStart('v')
        $composeVersion = $null
        if ($LASTEXITCODE -ne 0 -or
            -not [Version]::TryParse($composeText, [ref]$composeVersion) -or
            $composeVersion -lt [Version]'2.33.1') {
            throw 'Docker Compose 2.33.1 or later is required.'
        }
        $buildHelp = (& docker compose build --help 2>$null | Out-String)
        if ($LASTEXITCODE -ne 0 -or $buildHelp -notmatch '(?m)^\s+--builder\s') {
            throw 'Docker Compose does not expose the required explicit builder control.'
        }
    }
    finally {
        if ($null -eq $previousHost) { Remove-Item Env:DOCKER_HOST -ErrorAction SilentlyContinue }
        else { $env:DOCKER_HOST = $previousHost }
        if ($null -eq $previousContext) { Remove-Item Env:DOCKER_CONTEXT -ErrorAction SilentlyContinue }
        else { $env:DOCKER_CONTEXT = $previousContext }
    }

    return [pscustomobject]@{
        endpoint = $endpoint
        engineVersion = $engineVersion.ToString()
        apiVersion = $apiVersion.ToString()
        composeVersion = $composeVersion.ToString()
    }
}
