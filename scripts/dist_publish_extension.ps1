param(
    [switch]$SkipBuild,
    [switch]$DebugBuild,
    [switch]$SkipUpload,
    [switch]$SkipPublish,

    [string]$ExtensionId = $env:CWS_EXTENSION_ID,
    [string]$AccessToken = $env:CWS_ACCESS_TOKEN,

    [ValidateSet("default", "trustedTesters")]
    [string]$PublishTarget = "default"
)

$ErrorActionPreference = "Stop"

function Ensure-Path {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Description not found: $Path"
    }
}

$rootPath = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $rootPath

$buildScriptPath = Join-Path $rootPath "scripts\build_extension.ps1"
$extensionPath = Join-Path $rootPath "extension"
$manifestPath = Join-Path $extensionPath "manifest.json"

Ensure-Path -Path $buildScriptPath -Description "Build script"
Ensure-Path -Path $extensionPath -Description "Extension directory"
Ensure-Path -Path $manifestPath -Description "Manifest file"

if (-not $SkipBuild) {
    Write-Host "[dist-publish] Building extension package assets..."
    if ($DebugBuild) {
        & $buildScriptPath -Debug
    }
    else {
        & $buildScriptPath
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Extension build failed."
    }
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "manifest.json is missing a valid version value."
}

$distVersionDir = Join-Path $rootPath (Join-Path "dist" $version)
New-Item -Path $distVersionDir -ItemType Directory -Force | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$zipName = "qr-tool_chromium-extension-v$version-$timestamp.zip"
$zipPath = Join-Path $distVersionDir $zipName
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

Write-Host "[dist-publish] Packaging extension from '$extensionPath'..."
Compress-Archive -Path (Join-Path $extensionPath "*") -DestinationPath $zipPath -CompressionLevel Optimal -Force
Write-Host "[dist-publish] Package created: $zipPath"

if ($SkipUpload) {
    Write-Host "[dist-publish] SkipUpload enabled. Packaging completed without Chrome Web Store upload."
    return
}

if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
    throw "Missing ExtensionId. Pass -ExtensionId or set CWS_EXTENSION_ID environment variable."
}

if ([string]::IsNullOrWhiteSpace($AccessToken)) {
    throw "Missing AccessToken. Pass -AccessToken or set CWS_ACCESS_TOKEN environment variable."
}

$headers = @{
    Authorization = "Bearer $AccessToken"
    "x-goog-api-version" = "2"
}

$uploadUri = "https://www.googleapis.com/upload/chromewebstore/v1.1/items/$ExtensionId"
Write-Host "[dist-publish] Uploading package to Chrome Web Store API..."
$uploadResponse = Invoke-RestMethod -Method Put -Uri $uploadUri -Headers $headers -InFile $zipPath -ContentType "application/zip"
Write-Host "[dist-publish] Upload response:"
$uploadResponse | ConvertTo-Json -Depth 10 | Write-Host

if ($null -ne $uploadResponse.itemError -and $uploadResponse.itemError.Count -gt 0) {
    $errorJson = $uploadResponse.itemError | ConvertTo-Json -Depth 10
    throw "Chrome Web Store upload returned itemError: $errorJson"
}

$uploadState = [string]$uploadResponse.uploadState
if (-not [string]::IsNullOrWhiteSpace($uploadState) -and $uploadState -ne "SUCCESS") {
    throw "Chrome Web Store upload state is '$uploadState' (expected 'SUCCESS')."
}

if ($SkipPublish) {
    Write-Host "[dist-publish] SkipPublish enabled. Upload completed without publish step."
    return
}

$publishUri = "https://www.googleapis.com/chromewebstore/v1.1/items/$ExtensionId/publish?publishTarget=$PublishTarget"
Write-Host "[dist-publish] Publishing extension (target: $PublishTarget)..."
$publishResponse = Invoke-RestMethod -Method Post -Uri $publishUri -Headers $headers
Write-Host "[dist-publish] Publish response:"
$publishResponse | ConvertTo-Json -Depth 10 | Write-Host

if ($null -ne $publishResponse.itemError -and $publishResponse.itemError.Count -gt 0) {
    $errorJson = $publishResponse.itemError | ConvertTo-Json -Depth 10
    throw "Chrome Web Store publish returned itemError: $errorJson"
}

$status = [string]$publishResponse.status
if (-not [string]::IsNullOrWhiteSpace($status) -and $status -ne "OK") {
    throw "Chrome Web Store publish status is '$status' (expected 'OK')."
}

Write-Host "[dist-publish] Done. Release package: $zipPath"
