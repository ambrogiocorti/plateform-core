# Read-only by default. Never executes migrations against the database.
# Connection details are entered privately in the PowerShell process.
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$projectRef = 'abdxvlykasqmknexxhjo' # plateform-development, never Production
$fingerprint = '988224616fc43432904246360f87c7e637d4a64444dd2af2b0d60aa498f62b43'
$root = Split-Path -Parent $PSScriptRoot

Push-Location $root
try {
    $client = Get-Command 'psql.exe' -ErrorAction SilentlyContinue
    if (-not $client) {
        $client = Get-ChildItem "$env:ProgramFiles\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
    }
    if (-not $client) {
        throw 'PostgreSQL psql.exe non trovato. Installa PostgreSQL Command Line Tools, poi riprova.'
    }
    $psqlPath = if ($client.Source) { $client.Source } else { $client.FullName }

    $secure = Read-Host 'Incolla la URI PostgreSQL di plateform-development (input nascosto)' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $connection = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $uri = [Uri]$connection
        # Direct Supabase PostgreSQL uses db.<project-ref>.supabase.co,
        # while session poolers use <region>.pooler.supabase.com.
        # Validate the exact project ref for BOTH connection formats.
        $direct = $uri.Host -ieq "db.$projectRef.supabase.co" -and
            $uri.UserInfo -match '^postgres:'
        $pooler = $uri.Host -match '^[a-z0-9-]+\.pooler\.supabase\.com
        $env:SUPABASE_DB_URL = $connection
        $env:PSQL_BIN = $psqlPath
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $connection = $null
        $secure.Dispose()
    }

    $mode = if ($Apply) { '--write' } else { '--dry-run' }
    $arguments = @('scripts/reconcile-migrations.mjs', $mode,
        '--expected-remote-count', '456',
        '--expected-inventory-sha256', $fingerprint)
    if ($Apply) { $arguments += '--adopt-remote-with-backup' }

    & node @arguments
    $exit = $LASTEXITCODE
    # A dry run returns 2 when it correctly discovers missing/divergent SQL.
    if ($exit -ne 0 -and -not (-not $Apply -and $exit -eq 2)) {
        throw "Il recupero e' stato interrotto (exit code $exit). Non modificare manualmente gli SQL."
    }
    if ($Apply -and $exit -eq 0) {
        & npm run check:migrations
        if ($LASTEXITCODE -ne 0) {
            throw 'Verifica post-recupero fallita. Conserva il backup e non pubblicare.'
        }
        Write-Host 'Storico SQL recuperato e manifest verificato. Controlla git status prima del commit.'
    } elseif (-not $Apply) {
        Write-Host 'Diagnosi completata. Per adottare SQL remoto con backup, ripeti con -Apply.'
    }
} finally {
    Remove-Item Env:\SUPABASE_DB_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\PSQL_BIN -ErrorAction SilentlyContinue
    Pop-Location
}
 -and
            $uri.UserInfo -match "^postgres\.$($projectRef):"
        if ($uri.Scheme -notin @('postgres', 'postgresql') -or
            $uri.AbsolutePath -ne '/postgres' -or
            -not ($direct -or $pooler)) {
            throw 'La connessione non sembra appartenere a plateform-development. Operazione annullata.'
        }
        $env:SUPABASE_DB_URL = $connection
        $env:PSQL_BIN = $psqlPath
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $connection = $null
        $secure.Dispose()
    }

    $mode = if ($Apply) { '--write' } else { '--dry-run' }
    $arguments = @('scripts/reconcile-migrations.mjs', $mode,
        '--expected-remote-count', '456',
        '--expected-inventory-sha256', $fingerprint)
    if ($Apply) { $arguments += '--adopt-remote-with-backup' }

    & node @arguments
    $exit = $LASTEXITCODE
    # A dry run returns 2 when it correctly discovers missing/divergent SQL.
    if ($exit -ne 0 -and -not (-not $Apply -and $exit -eq 2)) {
        throw "Il recupero e' stato interrotto (exit code $exit). Non modificare manualmente gli SQL."
    }
    if ($Apply -and $exit -eq 0) {
        & npm run check:migrations
        if ($LASTEXITCODE -ne 0) {
            throw 'Verifica post-recupero fallita. Conserva il backup e non pubblicare.'
        }
        Write-Host 'Storico SQL recuperato e manifest verificato. Controlla git status prima del commit.'
    } elseif (-not $Apply) {
        Write-Host 'Diagnosi completata. Per adottare SQL remoto con backup, ripeti con -Apply.'
    }
} finally {
    Remove-Item Env:\SUPABASE_DB_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\PSQL_BIN -ErrorAction SilentlyContinue
    Pop-Location
}
