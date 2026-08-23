param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$AppArguments
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
$sourceDirectory = Join-Path $projectRoot 'src'

if (-not (Test-Path -LiteralPath $python)) {
    throw "Python virtual environment not found: $python`nRun this first: py -3.11 -m venv .venv"
}

if (-not (Test-Path -LiteralPath $sourceDirectory)) {
    throw "Source directory not found: $sourceDirectory"
}

$env:PYTHONPATH = if ($env:PYTHONPATH) {
    "$sourceDirectory;$env:PYTHONPATH"
} else {
    $sourceDirectory
}

Push-Location $projectRoot
try {
    Write-Host 'Starting Chester AI...' -ForegroundColor Green
    Write-Host 'In game: hold V to talk, release V to send, Shift+V to retry, and Ctrl+C to stop.'
    & $python -m dont_starve_ai_mod @AppArguments
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
