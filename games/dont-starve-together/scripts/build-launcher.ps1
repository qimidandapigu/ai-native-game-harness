param(
    [string]$OutputDirectory = 'dist'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
$outputPath = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory
} else {
    Join-Path $projectRoot $OutputDirectory
}

if (-not (Test-Path -LiteralPath $python)) {
    throw 'Create the local virtual environment first: python -m venv .venv'
}

& $python -m pip install --disable-pip-version-check 'pyinstaller>=6.0,<7'
if ($LASTEXITCODE -ne 0) {
    throw 'PyInstaller installation failed.'
}

Push-Location $projectRoot
try {
    & $python -m PyInstaller `
        --noconfirm `
        --clean `
        --onefile `
        --console `
        --name ChesterAI `
        --distpath $outputPath `
        --paths src `
        --add-data 'game-mod;game-mod' `
        --hidden-import win32gui `
        --hidden-import win32process `
        --hidden-import win32con `
        --hidden-import websocket `
        scripts\launcher_entry.py
    if ($LASTEXITCODE -ne 0) {
        throw 'ChesterAI.exe build failed.'
    }

    Copy-Item -LiteralPath '.env.example' -Destination (Join-Path $outputPath '.env.example') -Force
    Write-Host "Built launcher: $(Join-Path $outputPath 'ChesterAI.exe')"
}
finally {
    Pop-Location
}
