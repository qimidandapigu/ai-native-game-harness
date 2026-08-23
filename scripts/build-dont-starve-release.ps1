$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Join-Path $repositoryRoot 'games\dont-starve-together'
$buildScript = Join-Path $projectRoot 'scripts\build-player-package.ps1'
$manifestPath = Join-Path $repositoryRoot 'distribution\dont-starve-together-v1.json'
$venvPython = Join-Path $projectRoot '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    $pythonLauncher = (Get-Command py -ErrorAction Stop).Source
    & $pythonLauncher -3 -m venv (Join-Path $projectRoot '.venv')
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not create the Don''t Starve virtual environment.'
    }
}

& $venvPython -m pip install --disable-pip-version-check -e $projectRoot
if ($LASTEXITCODE -ne 0) {
    throw 'Could not install Don''t Starve build dependencies.'
}

& $buildScript
if ($LASTEXITCODE -ne 0) {
    throw 'Don''t Starve player package build failed.'
}

$modInfo = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'game-mod\modinfo.lua')
$versionMatch = [regex]::Match($modInfo, '(?m)^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"')
if (-not $versionMatch.Success) {
    throw 'Could not read the Don''t Starve release version.'
}
$version = $versionMatch.Groups[1].Value
$assetName = "dsh-xiaotangyuan-game-dont-starve-$version.zip"
$assetPath = Join-Path $projectRoot "dist\$assetName"
if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf)) {
    throw "Missing built Don''t Starve asset: $assetPath"
}

$asset = Get-Item -LiteralPath $assetPath
$sha256Algorithm = [System.Security.Cryptography.SHA256]::Create()
$assetStream = [System.IO.File]::OpenRead($assetPath)
try {
    $sha256Bytes = $sha256Algorithm.ComputeHash($assetStream)
    $sha256 = ([System.BitConverter]::ToString($sha256Bytes) -replace '-', '').ToLowerInvariant()
} finally {
    $assetStream.Dispose()
    $sha256Algorithm.Dispose()
}
$schema = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($schema.schemaVersion -ne 1) {
    throw "Unsupported Don't Starve manifest schema: $($schema.schemaVersion)"
}
$json = @"
{
  "schemaVersion": 1,
  "tag": "dont-starve-v$version",
  "version": "$version",
  "archive": {
    "name": "$assetName",
    "url": "https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/dont-starve-v$version/$assetName",
    "size": $($asset.Length),
    "sha256": "$sha256"
  }
}
"@
[System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

Write-Host "Updated Don't Starve manifest: $manifestPath"
Write-Host "Asset size: $($asset.Length)"
Write-Host "Asset SHA-256: $sha256"
