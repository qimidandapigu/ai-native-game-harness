param(
  [string]$SourceRoot,
  [string]$ProfileName = 'ai-native-game-harness-integration'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'integrations/xiaotangyuan/manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
  $SourceRoot = Join-Path (Split-Path -Parent $repoRoot) 'dsh-xiaotangyuan-game/apps/harness-plugin'
}
$pluginRoot = [IO.Path]::GetFullPath($SourceRoot)
$packagePath = Join-Path $pluginRoot 'package.json'
$entryPath = Join-Path $pluginRoot 'dist/index.js'

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
  throw "XiaoTangYuan plugin package was not found: $packagePath"
}
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
  throw "Built plugin entry was not found: $entryPath. Build dsh-xiaotangyuan-game first."
}

$pluginPackage = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
if ($pluginPackage.name -ne $manifest.packageName) {
  throw "Unexpected package name: $($pluginPackage.name)"
}
if ($pluginPackage.version -ne $manifest.development.expectedVersion) {
  throw "Expected source version $($manifest.development.expectedVersion), found $($pluginPackage.version)"
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
