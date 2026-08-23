$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localPython = Join-Path $projectRoot '.venv\Scripts\python.exe'

if (Test-Path -LiteralPath $localPython -PathType Leaf) {
    $python = $localPython
    $pythonPrefix = @()
} else {
    $python = (Get-Command py -ErrorAction Stop).Source
    $pythonPrefix = @('-3')
}

$previousPythonPath = $env:PYTHONPATH
$env:PYTHONPATH = Join-Path $projectRoot 'src'
Push-Location $projectRoot
try {
    & $python @pythonPrefix -m unittest discover -s tests -v
    if ($LASTEXITCODE -ne 0) {
        throw 'Don''t Starve unit tests failed.'
    }
    & $python @pythonPrefix -m compileall -q src tests
    if ($LASTEXITCODE -ne 0) {
        throw 'Don''t Starve Python bytecode compilation failed.'
    }
} finally {
    Pop-Location
    $env:PYTHONPATH = $previousPythonPath
}
