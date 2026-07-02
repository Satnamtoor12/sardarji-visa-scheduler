# One-time setup: register SardarJi native updater with Chrome (Windows).
# Run: powershell -ExecutionPolicy Bypass -File native-host\install.ps1

$ErrorActionPreference = 'Stop'

$HostDir   = $PSScriptRoot
$RepoRoot  = (Resolve-Path (Join-Path $HostDir '..')).Path
$BatPath   = Join-Path $HostDir 'host.bat'
$Manifest  = Join-Path $HostDir 'com.sardarji.updater.json'
$Installed = Join-Path $HostDir 'com.sardarji.updater.installed.json'

if (-not (Test-Path $BatPath)) {
  Write-Host 'ERROR: host.bat not found.' -ForegroundColor Red
  exit 1
}

$batForJson = $BatPath -replace '\\', '\\'
$json = @"
{
  "name": "com.sardarji.updater",
  "description": "SardarJi Visa Scheduler — sync extension files from GitHub",
  "path": "$BatPath",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://jonocdekbjneapljhkeijonmdkkekjcm/"
  ]
}
"@

Set-Content -Path $Installed -Value $json -Encoding UTF8

$regKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.sardarji.updater'
New-Item -Path $regKey -Force | Out-Null
Set-ItemProperty -Path $regKey -Name '(default)' -Value $Installed

Write-Host ''
Write-Host 'SardarJi native updater installed!' -ForegroundColor Green
Write-Host "  Repo:     $RepoRoot"
Write-Host "  Registry: $regKey"
Write-Host "  Manifest: $Installed"
Write-Host ''
Write-Host 'Ab icon click par extension GitHub se khud update hogi.' -ForegroundColor Cyan
Write-Host 'Pehli baar: chrome://extensions -> SardarJi -> Reload' -ForegroundColor Yellow