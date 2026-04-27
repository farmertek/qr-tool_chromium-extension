param(
    [switch]$Debug
)

$ErrorActionPreference = 'Stop'

$rootPath = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $rootPath

function Ensure-Command {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$InstallHint
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Command '$Name' was not found. $InstallHint"
    }
}

Ensure-Command -Name 'wasm-pack' -InstallHint 'Install from https://rustwasm.github.io/wasm-pack/installer/'
Ensure-Command -Name 'npm' -InstallHint 'Install Node.js LTS from https://nodejs.org/'

$vendorSource = Join-Path $rootPath 'node_modules\i18next\dist\esm\i18next.js'
if (-not (Test-Path $vendorSource)) {
    Write-Host 'Installing Node dependencies (i18next)...'
    npm install
    if ($LASTEXITCODE -ne 0) {
        throw 'npm install failed.'
    }
}

$wasmOutputDir = Join-Path $rootPath 'extension\wasm'
if (Test-Path $wasmOutputDir) {
    Remove-Item $wasmOutputDir -Recurse -Force
}

$wasmPackArgs = @(
    'build',
    './wasm_qr',
    '--target',
    'web',
    '--out-dir',
    '../extension/wasm',
    '--out-name',
    'wasm_qr'
)

if (-not $Debug) {
    $wasmPackArgs += '--release'
}

Write-Host 'Building Rust WebAssembly package...'
& wasm-pack @wasmPackArgs
if ($LASTEXITCODE -ne 0) {
    throw 'wasm-pack build failed.'
}

$vendorDir = Join-Path $rootPath 'extension\vendor'
New-Item -Path $vendorDir -ItemType Directory -Force | Out-Null

Write-Host 'Copying i18next runtime into extension package...'
Copy-Item $vendorSource (Join-Path $vendorDir 'i18next.js') -Force

Write-Host ''
Write-Host 'Build completed.'
Write-Host "Load unpacked extension from: $(Join-Path $rootPath 'extension')"
