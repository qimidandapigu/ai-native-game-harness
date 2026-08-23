param(
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$bridgeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $bridgeRoot '..\..\..'))
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot '.release\oni'))
if (-not $releaseRoot.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to package outside the repository.'
}

$versionLine = Get-Content -LiteralPath (Join-Path $bridgeRoot 'mod_info.yaml') |
    Where-Object { $_ -match '^version:\s*' } |
    Select-Object -First 1
if ($null -eq $versionLine -or $versionLine -notmatch '^version:\s*["'']?([^\s"'']+)') {
    throw 'Unable to read ONI version from mod_info.yaml.'
}
$version = $Matches[1]
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Invalid ONI release version: $version"
}

dotnet build (Join-Path $bridgeRoot 'DoubaoAI.ONI.csproj') -c $Configuration
if ($LASTEXITCODE -ne 0) { throw 'ONI Bridge build failed.' }

$outputRoot = Join-Path $bridgeRoot "bin\$Configuration\netstandard2.1"
$stageRoot = Join-Path $releaseRoot 'stage'
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stageRoot | Out-Null

$files = @('DoubaoAI.ONI.dll', 'mod.yaml', 'mod_info.yaml', 'config.template.json', 'README.md')
foreach ($name in $files) {
    $source = if ($name -eq 'DoubaoAI.ONI.dll') { Join-Path $outputRoot $name } else { Join-Path $bridgeRoot $name }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing ONI package file: $source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $stageRoot $name)
}

$assetsSource = Join-Path $bridgeRoot 'assets'
if (Test-Path -LiteralPath $assetsSource -PathType Container) {
    Copy-Item -LiteralPath $assetsSource -Destination (Join-Path $stageRoot 'assets') -Recurse
}

$assetName = "dsh-xiaotangyuan-game-oni-$version.zip"
$assetPath = Join-Path $releaseRoot $assetName
if (Test-Path -LiteralPath $assetPath) { Remove-Item -LiteralPath $assetPath -Force }
Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $assetPath -CompressionLevel Optimal

$asset = Get-Item -LiteralPath $assetPath
$sha = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($assetPath)
try {
    $sha256 = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
}
finally {
    $stream.Dispose()
    $sha.Dispose()
}
$assetUrl = "https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/oni-v$version/$assetName"
$manifestJson = @"
{
  "schemaVersion": 1,
  "tag": "oni-v$version",
  "version": "$version",
  "archive": {
    "name": "$assetName",
    "url": "$assetUrl",
    "size": $($asset.Length),
    "sha256": "$sha256"
  }
}
"@
$manifestPath = Join-Path $repoRoot 'distribution\oxygen-not-included-v1.json'
[System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifestJson + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
)
Remove-Item -LiteralPath $stageRoot -Recurse -Force

Write-Host "ONI package: $assetPath"
Write-Host "Manifest: $manifestPath"
Write-Host "SHA-256: $sha256"
