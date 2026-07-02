# SardarJi native messaging host — git sync from GitHub on icon click.
# Protocol: 4-byte little-endian length + UTF-8 JSON (stdin/stdout only).

$ErrorActionPreference = 'Stop'

function Read-Message {
  $stdin = [Console]::OpenStandardInput()
  $lenBuf = New-Object byte[] 4
  $read = $stdin.Read($lenBuf, 0, 4)
  if ($read -lt 4) { return $null }
  $len = [BitConverter]::ToInt32($lenBuf, 0)
  if ($len -le 0 -or $len -gt 1048576) { return $null }
  $buf = New-Object byte[] $len
  $offset = 0
  while ($offset -lt $len) {
    $n = $stdin.Read($buf, $offset, $len - $offset)
    if ($n -le 0) { break }
    $offset += $n
  }
  return [System.Text.Encoding]::UTF8.GetString($buf, 0, $offset) | ConvertFrom-Json
}

function Write-Message([object]$obj) {
  $json = ($obj | ConvertTo-Json -Compress -Depth 4)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $len = [BitConverter]::GetBytes([int32]$bytes.Length)
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($len, 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
}

function Get-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$ExtensionId = 'jonocdekbjneapljhkeijonmdkkekjcm'

function Get-ChromeExtensionLoadPath {
  $userData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  if (-not (Test-Path $userData)) { return $null }
  foreach ($profile in Get-ChildItem $userData -Directory) {
    $secPath = Join-Path $profile.FullName 'Secure Preferences'
    if (-not (Test-Path $secPath)) { continue }
    try {
      $prefs = Get-Content $secPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $settings = $prefs.extensions.settings
      if (-not $settings) { continue }
      foreach ($prop in $settings.PSObject.Properties) {
        if ($prop.Name -ne $ExtensionId) { continue }
        $loadPath = [string]$prop.Value.path
        if ($loadPath -and (Test-Path (Join-Path $loadPath 'manifest.json'))) {
          return $loadPath
        }
      }
    } catch { }
  }
  return $null
}

function Sync-RepoToChromeLoadPath([string]$Repo) {
  $dest = Get-ChromeExtensionLoadPath
  if (-not $dest) { return $false }
  $repoNorm = (Resolve-Path $Repo).Path
  $destNorm = (Resolve-Path $dest).Path
  if ($repoNorm -eq $destNorm) { return $false }

  $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  & $robocopy $repoNorm $destNorm /E /XD .git /XF com.sardarji.updater.installed.json `
    /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  $code = $LASTEXITCODE
  return ($code -ge 1 -and $code -le 7)
}

try {
  $msg = Read-Message
  if (-not $msg) {
    Write-Message @{ success = $false; error = 'No message' }
    exit 0
  }

  if ($msg.action -eq 'ping') {
    Write-Message @{ success = $true; message = 'ok' }
    exit 0
  }

  if ($msg.action -ne 'update') {
    Write-Message @{ success = $false; error = 'Unknown action' }
    exit 0
  }

  $repo = Get-RepoRoot
  Push-Location $repo

  $before = ''
  try { $before = (git rev-parse HEAD 2>$null).Trim() } catch { $before = '' }

  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  git fetch origin main 2>&1 | Out-Null
  git reset --hard origin/main 2>&1 | Out-Null
  $ErrorActionPreference = $prevEap

  $after = (git rev-parse HEAD).Trim()
  $gitChanged = ($before -ne $after)
  $copyChanged = Sync-RepoToChromeLoadPath $repo
  $changed = $gitChanged -or $copyChanged

  $version = '0.0.0'
  $manifestPath = Join-Path $repo 'manifest.json'
  if (Test-Path $manifestPath) {
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.version) { $version = [string]$manifest.version }
  }

  Pop-Location

  Write-Message @{
    success = $true
    changed = $changed
    version = $version
    commit  = $after
    message = if ($gitChanged) { "Updated to v$version" } elseif ($copyChanged) { "Synced files to Chrome load folder (v$version)" } else { 'Already up to date' }
  }
}
catch {
  Write-Message @{ success = $false; error = $_.Exception.Message }
}