# SardarJi Visa Scheduler — GitHub se download + Chrome mein load/reload
# Double-click ya: powershell -ExecutionPolicy Bypass -File reload-sardarji.ps1

$ErrorActionPreference = 'Stop'

$RepoUrl   = 'https://github.com/SatnamSinghToor/SardarJi-Visa-Scheduler.git'
$InstallDir = $PSScriptRoot
$Chrome    = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $Chrome)) {
  $Chrome = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
}

function Write-Step([string]$msg) {
  Write-Host ''
  Write-Host ">> $msg" -ForegroundColor Cyan
}

Write-Step 'GitHub se SardarJi download ho raha hai...'

if (Test-Path (Join-Path $InstallDir '.git')) {
  Push-Location $InstallDir
  git fetch origin main
  git reset --hard origin/main
  Pop-Location
  Write-Host '   Latest code sync ho gaya (origin/main).' -ForegroundColor Green
} else {
  $parent = Split-Path $InstallDir -Parent
  $name   = Split-Path $InstallDir -Leaf
  if (Test-Path $InstallDir) {
    Remove-Item $InstallDir -Recurse -Force
  }
  git clone --depth 1 $RepoUrl (Join-Path $parent $name)
  Write-Host '   Fresh clone complete.' -ForegroundColor Green
}

$manifest = Join-Path $InstallDir 'manifest.json'
if (-not (Test-Path $manifest)) {
  Write-Host 'ERROR: manifest.json nahi mila — galat folder?' -ForegroundColor Red
  exit 1
}

$version = (Get-Content $manifest -Raw | Select-String '"version"\s*:\s*"([^"]+)"').Matches.Groups[1].Value
Write-Host "   Version: $version" -ForegroundColor Green
Write-Host "   Folder:  $InstallDir" -ForegroundColor DarkGray

Write-Step 'Chrome khol raha hoon...'

# Extensions page — pehli baar "Load unpacked" yahi folder choose karo.
Start-Process $Chrome 'chrome://extensions/'

Start-Sleep -Seconds 2

# Naya instance: extension load (pehli install ke liye helpful).
$chromeArgs = @(
  "--load-extension=`"$InstallDir`""
  'chrome://extensions/'
)
Start-Process $Chrome $chromeArgs

Write-Host ''
Write-Host '=== SardarJi load kaise karein ===' -ForegroundColor Yellow
Write-Host 'Pehli baar:'
Write-Host '  1. chrome://extensions par Developer mode ON karo'
Write-Host '  2. "Load unpacked" -> ye folder select karo:'
Write-Host "     $InstallDir"
Write-Host ''
Write-Host 'Har baar update ke baad:'
Write-Host '  -> SardarJi card par RELOAD button dabao'
Write-Host ''
Write-Host 'Done. GitHub se latest code ready hai.' -ForegroundColor Green