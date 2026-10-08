$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Fail([string]$Message) {
  Write-Host "[ERRORE] $Message" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path (Join-Path $repo ".env.local"))) {
  Fail ".env.local non trovato. Esegui prima SETUP_LOCALE_WINDOWS.cmd."
}
if (-not (Test-Path (Join-Path $repo "node_modules"))) {
  Fail "node_modules non trovato. Esegui prima SETUP_LOCALE_WINDOWS.cmd o npm ci."
}

Write-Host "Controllo preflight..." -ForegroundColor Yellow
& npm run local:preflight
if ($LASTEXITCODE -ne 0) { Fail "Preflight non verde: Plateform non verrà avviata." }

$publicCommand = "Set-Location -LiteralPath '$repo'; npm run dev:public"
$staffCommand = "Set-Location -LiteralPath '$repo'; npm run dev:staff"

Start-Process powershell.exe -ArgumentList @('-NoExit','-ExecutionPolicy','Bypass','-Command',$publicCommand) | Out-Null
Start-Process powershell.exe -ArgumentList @('-NoExit','-ExecutionPolicy','Bypass','-Command',$staffCommand) | Out-Null

Start-Sleep -Seconds 3
Start-Process "http://localhost:5173" | Out-Null
Start-Process "http://localhost:5174" | Out-Null

Write-Host "Plateform avviata:" -ForegroundColor Green
Write-Host "  Pubblico: http://localhost:5173"
Write-Host "  Staff:    http://localhost:5174"
Write-Host "Chiudi i due terminali npm per arrestare i server locali."
