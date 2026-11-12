param(
  [string]$SupabaseUrl = "",
  [string]$PublishableKey = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Fail([string]$Message) {
  Write-Host "[ERRORE] $Message" -ForegroundColor Red
  exit 1
}

Write-Host "Plateform - setup locale Windows" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js non trovato. Installa Node >= 24.13.0 e riapri PowerShell."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail "npm non trovato. Verifica l'installazione di Node.js."
}

$nodeVersionText = (& node -p "process.versions.node").Trim()
try { $nodeVersion = [version]$nodeVersionText } catch { Fail "Versione Node non leggibile: $nodeVersionText" }
$minimumNode = [version]"24.13.0"
if ($nodeVersion -lt $minimumNode) {
  Fail "Node $nodeVersionText non supportato. Plateform richiede Node >= 24.13.0."
}
Write-Host "[OK] Node $nodeVersionText" -ForegroundColor Green

Write-Host "Installazione pulita dipendenze dal package-lock.json..." -ForegroundColor Yellow
& npm ci
if ($LASTEXITCODE -ne 0) { Fail "npm ci non riuscito." }
Write-Host "[OK] Dipendenze installate" -ForegroundColor Green

$envPath = Join-Path $repo ".env.local"
$examplePath = Join-Path $repo ".env.example"
if (-not (Test-Path $envPath)) {
  Copy-Item $examplePath $envPath
  Write-Host "[OK] Creato .env.local da .env.example" -ForegroundColor Green
}

if (($SupabaseUrl -and -not $PublishableKey) -or ($PublishableKey -and -not $SupabaseUrl)) {
  Fail "Per la configurazione automatica passa insieme -SupabaseUrl e -PublishableKey."
}

if ($SupabaseUrl -and $PublishableKey) {
  try { $uri = [uri]$SupabaseUrl } catch { Fail "SupabaseUrl non è un URL valido." }
  if ($uri.Scheme -notin @("http", "https")) { Fail "SupabaseUrl deve usare http o https." }

  $content = Get-Content $envPath -Raw
  $content = [regex]::Replace($content, '(?m)^VITE_SUPABASE_URL=.*$', "VITE_SUPABASE_URL=$SupabaseUrl")
  $content = [regex]::Replace($content, '(?m)^VITE_SUPABASE_PUBLISHABLE_KEY=.*$', "VITE_SUPABASE_PUBLISHABLE_KEY=$PublishableKey")
  Set-Content -Path $envPath -Value $content -Encoding utf8
  Write-Host "[OK] Configurazione browser Supabase development impostata in .env.local" -ForegroundColor Green
}

$envText = Get-Content $envPath -Raw
$hasUrl = $envText -match '(?m)^VITE_SUPABASE_URL=\S+'
$hasKey = $envText -match '(?m)^VITE_SUPABASE_PUBLISHABLE_KEY=\S+'

if ($hasUrl -and $hasKey) {
  Write-Host "Esecuzione preflight..." -ForegroundColor Yellow
  & npm run local:preflight
  if ($LASTEXITCODE -ne 0) { Fail "Il preflight locale non è verde. Correggi i punti mostrati sopra." }
  Write-Host "[OK] Preflight locale verde" -ForegroundColor Green
  Write-Host "Setup completato. Puoi eseguire .\AVVIA_PLATEFORM_WINDOWS.cmd" -ForegroundColor Cyan
} else {
  Write-Host "" 
  Write-Host "Manca ancora la configurazione Supabase development in .env.local." -ForegroundColor Yellow
  Write-Host "Compila VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY, poi esegui:" -ForegroundColor Yellow
  Write-Host "  npm run local:preflight"
  Write-Host "  npm run local:verify"
}
