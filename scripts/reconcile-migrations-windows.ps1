# Plateform Development migration history recovery.
# Default: read-only diagnosis. -Apply adds only missing remote migrations.
# Refuse historic SQL divergence: never replace previously recovered local files.
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$projectRef = 'abdxvlykasqmknexxhjo'
$fingerprint = 'ae79b608e86dfe6c7ca8dd93c88170cdd4dc38dd6324ccb3391342b135a59f41'
$root = Split-Path -Parent $PSScriptRoot

Push-Location $root
try {
    $client = Get-Command 'psql.exe' -ErrorAction SilentlyContinue
    if (-not $client) {
        $client = Get-ChildItem -Path "$env:ProgramFiles\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
            Sort-Object -Property FullName -Descending |
            Select-Object -First 1
    }
    if (-not $client) {
        throw 'psql.exe non trovato. Installa PostgreSQL Command Line Tools.'
    }
    $psqlPath = if ($client.Source) { $client.Source } else { $client.FullName }

    $secure = Read-Host 'Incolla la URI PostgreSQL di plateform-development (input nascosto)' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $connection = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $uri = [Uri]$connection
        # Direct: db.<project>.supabase.co, username postgres.
        # Session pooler: <region>.pooler.supabase.com, username postgres.<project>.
        $validScheme = $uri.Scheme -in @('postgres', 'postgresql')
        $validPath = $uri.AbsolutePath -eq '/postgres'
        $direct = ($uri.Host -ieq "db.$projectRef.supabase.co") -and ($uri.UserInfo -match '^postgres:')
        $pooler = ($uri.Host -match '^[a-z0-9-]+\.pooler\.supabase\.com$') -and ($uri.UserInfo -match ('^postgres\.' + [regex]::Escape($projectRef) + ':'))
        if (-not ($validScheme -and $validPath -and ($direct -or $pooler))) {
            throw 'URI non appartenente al progetto Plateform Development. Operazione annullata.'
        }
        $env:SUPABASE_DB_URL = $connection
        $env:PSQL_BIN = $psqlPath
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $connection = $null
        $secure.Dispose()
    }

    $mode = if ($Apply) { '--write' } else { '--dry-run' }
    $arguments = @(
        'scripts/reconcile-migrations.mjs', $mode,
        '--expected-remote-count', '457',
        '--expected-inventory-sha256', $fingerprint
    )
    & node @arguments
    $exitCode = $LASTEXITCODE
    # Dry run exits 2 for expected local/remote SQL discrepancies.
    if ($exitCode -ne 0 -and -not ((-not $Apply) -and ($exitCode -eq 2))) {
        throw "Recupero interrotto (codice $exitCode). Verifica la connessione o l'inventario."
    }

    if ($Apply -and $exitCode -eq 0) {
        & npm run check:migrations
        if ($LASTEXITCODE -ne 0) {
            throw 'Verifica del manifest fallita dopo il recupero. Conserva il backup.'
        }
        Write-Host 'Storico SQL recuperato e manifest verificato. Controlla git status.'
    } else {
        Write-Host 'Diagnosi completata. Nessun file SQL modificato.'
    }
} finally {
    Remove-Item Env:\SUPABASE_DB_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\PSQL_BIN -ErrorAction SilentlyContinue
    Pop-Location
}
