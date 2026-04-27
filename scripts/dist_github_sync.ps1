param(
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl,

    [string]$Branch = "main",

    [string]$CommitMessage,

    [switch]$Force,

    [switch]$DryRun,

    [switch]$KeepWorktree
)

$ErrorActionPreference = "Stop"

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

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [string]$WorkingDirectory,

        [switch]$CaptureOutput
    )

    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"

    try {
        if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
            Push-Location $WorkingDirectory
        }

        if ($CaptureOutput) {
            $output = (& git @Arguments 2>&1 | Out-String)
            $exitCode = $LASTEXITCODE
            if ($exitCode -ne 0) {
                throw "git $($Arguments -join ' ') failed with exit code $exitCode.`n$output"
            }
            return $output
        }

        & git @Arguments
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            throw "git $($Arguments -join ' ') failed with exit code $exitCode."
        }

        return $null
    }
    finally {
        if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
            Pop-Location
        }
        $ErrorActionPreference = $previousErrorAction
    }
}

function Sync-FilesToWorktree {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourcePath,

        [Parameter(Mandatory = $true)]
        [string]$DestinationPath
    )

    $excludeDirs = @(
        ".git",
        "node_modules",
        "dist",
        "plan",
        "wasm_qr\\target",
        "extension\\wasm"
    )

    $excludeFiles = @(
        "dist_build_cmd.txt",
        "*.log",
        ".env",
        ".env.*",
        "*.secret.json",
        "*.token",
        "extension\\vendor\\i18next.js"
    )

    $robocopyArgs = @(
        $SourcePath,
        $DestinationPath,
        "/MIR",
        "/R:2",
        "/W:1",
        "/NFL",
        "/NDL"
    )

    foreach ($dir in $excludeDirs) {
        $robocopyArgs += "/XD"
        $robocopyArgs += $dir
    }

    foreach ($file in $excludeFiles) {
        $robocopyArgs += "/XF"
        $robocopyArgs += $file
    }

    & robocopy @robocopyArgs
    $robocopyExitCode = $LASTEXITCODE
    if ($robocopyExitCode -gt 7) {
        throw "robocopy failed with exit code $robocopyExitCode"
    }
}

function Remove-SyncWorktreeIfNeeded {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [switch]$Keep
    )

    if ($Keep) {
        return
    }

    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

Ensure-Command -Name "git" -InstallHint "Install Git from https://git-scm.com/downloads"
Ensure-Command -Name "robocopy" -InstallHint "robocopy is required (available on modern Windows)."

$extensionRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$syncWorktree = Join-Path $extensionRoot "dist\_github_sync_worktree"

if (Test-Path -LiteralPath $syncWorktree) {
    Remove-Item -LiteralPath $syncWorktree -Recurse -Force
}
New-Item -Path $syncWorktree -ItemType Directory -Force | Out-Null

$cloned = $true
try {
    Write-Host "[dist-github-sync] Cloning branch '$Branch' from '$RepoUrl'..."
    Invoke-Git -Arguments @("clone", "--branch", $Branch, "--single-branch", $RepoUrl, $syncWorktree)
}
catch {
    $cloned = $false
    Write-Host "[dist-github-sync] Clone failed for branch '$Branch'. Fallback to initialize new local worktree."
    Write-Host "[dist-github-sync] Details: $($_.Exception.Message)"
}

if (-not $cloned) {
    if (Test-Path -LiteralPath (Join-Path $syncWorktree ".git")) {
        Remove-Item -LiteralPath (Join-Path $syncWorktree ".git") -Recurse -Force
    }

    Invoke-Git -Arguments @("init") -WorkingDirectory $syncWorktree
    Invoke-Git -Arguments @("checkout", "-B", $Branch) -WorkingDirectory $syncWorktree
    Invoke-Git -Arguments @("remote", "add", "origin", $RepoUrl) -WorkingDirectory $syncWorktree
}

if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
    $CommitMessage = "Sync chromium_ext at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
}

Write-Host "[dist-github-sync] Syncing '$extensionRoot' into temporary worktree..."
Sync-FilesToWorktree -SourcePath $extensionRoot -DestinationPath $syncWorktree

Invoke-Git -Arguments @("add", "-A") -WorkingDirectory $syncWorktree
$status = (Invoke-Git -Arguments @("status", "--porcelain") -WorkingDirectory $syncWorktree -CaptureOutput).Trim()
if ([string]::IsNullOrWhiteSpace($status)) {
    Write-Host "[dist-github-sync] No changes detected. Nothing to push."
    Remove-SyncWorktreeIfNeeded -Path $syncWorktree -Keep:$KeepWorktree
    return
}

if ($DryRun) {
    Write-Host "[dist-github-sync] DryRun change preview:"
    Write-Host $status
    Write-Host "[dist-github-sync] DryRun enabled. No commit and no push were performed."
    Remove-SyncWorktreeIfNeeded -Path $syncWorktree -Keep:$KeepWorktree
    return
}

Invoke-Git -Arguments @("commit", "-m", $CommitMessage) -WorkingDirectory $syncWorktree

if ($Force) {
    Write-Host "[dist-github-sync] Pushing to '$RepoUrl' branch '$Branch' with --force..."
    Invoke-Git -Arguments @("push", "--force", "origin", "HEAD:$Branch") -WorkingDirectory $syncWorktree
}
else {
    Write-Host "[dist-github-sync] Pushing to '$RepoUrl' branch '$Branch'..."
    Invoke-Git -Arguments @("push", "origin", "HEAD:$Branch") -WorkingDirectory $syncWorktree
}

Write-Host "[dist-github-sync] Done. Repository '$RepoUrl' now contains synchronized content from chromium_ext."
Remove-SyncWorktreeIfNeeded -Path $syncWorktree -Keep:$KeepWorktree
