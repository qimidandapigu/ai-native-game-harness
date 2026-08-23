param(
  [string]$SourceRoot,
  [string]$ProfileName = 'ai-native-game-harness-integration'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'integrations/xiaotangyuan/manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
  $SourceRoot = Join-Path $repoRoot 'plugins/xiaotangyuan-game'
}
$pluginRoot = [IO.Path]::GetFullPath($SourceRoot)
$packagePath = Join-Path $pluginRoot 'package.json'
$entryPath = Join-Path $pluginRoot 'dist/index.js'
$mediaProject = Join-Path $repoRoot 'apps/windows-media-host/XtyMediaHost.csproj'
$mediaOutput = Join-Path $pluginRoot 'media/windows-x64'
$mediaEntry = Join-Path $mediaOutput 'XtyMediaHost.exe'

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
  throw "XiaoTangYuan plugin package was not found: $packagePath"
}
$pluginPackage = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
if ($pluginPackage.name -ne $manifest.packageName) {
  throw "Unexpected package name: $($pluginPackage.name)"
}
if ($pluginPackage.version -ne $manifest.development.expectedVersion) {
  throw "Expected source version $($manifest.development.expectedVersion), found $($pluginPackage.version)"
}

if (-not (Test-Path -LiteralPath $mediaProject -PathType Leaf)) {
  throw "XiaoTangYuan media host project was not found: $mediaProject"
}

New-Item -ItemType Directory -Force -Path $mediaOutput | Out-Null
dotnet publish $mediaProject -c Release -r win-x64 --self-contained true -o $mediaOutput | Out-Host
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $mediaEntry -PathType Leaf)) {
  throw "XiaoTangYuan media host build failed: $mediaEntry"
}

Push-Location $pluginRoot
try {
  pnpm run build | Out-Host
} finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
  throw "XiaoTangYuan plugin build failed: $entryPath"
}

$artifactRoot = Join-Path $repoRoot '.artifacts/xiaotangyuan'
$profileHome = Join-Path $artifactRoot 'dsh-home'
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

Push-Location $pluginRoot
try {
  pnpm pack --pack-destination $artifactRoot | Out-Host
} finally {
  Pop-Location
}

$archiveName = "qimidandapigu-dsh-xiaotangyuan-game-$($pluginPackage.version).tgz"
$archivePath = Join-Path $artifactRoot $archiveName
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
  throw "Plugin archive was not produced: $archivePath"
}

$previousDshHome = $env:DSH_HOME
try {
  $env:DSH_HOME = $profileHome
  Push-Location $repoRoot
  try {
    pnpm exec dsh plugin --profile $ProfileName add $archivePath | Out-Host
    pnpm exec dsh plugin --profile $ProfileName list --depth 0 | Out-Host
    pnpm exec dsh --profile $ProfileName --patch $manifest.smokePatch --dump-config | Out-Null
  } finally {
    Pop-Location
  }
} finally {
  $env:DSH_HOME = $previousDshHome
}

[PSCustomObject]@{
  package = $pluginPackage.name
  version = $pluginPackage.version
  archive = $archivePath
  profile = $ProfileName
  profileHome = $profileHome
  dsh = $manifest.compatibility.dsh
} | ConvertTo-Json
