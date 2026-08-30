param(
  [string]$SourceRoot,
  [string]$ProfileName = 'web'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'integrations/xiaotangyuan/manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
  $SourceRoot = Join-Path $repoRoot 'plugins/xiaotangyuan-game'
}
$pluginRoot = [IO.Path]::GetFullPath($SourceRoot)
$workRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $manifest.workOrchestrator.source))
$oniRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $manifest.oniAdapter.source))
$packagePath = Join-Path $pluginRoot 'package.json'
$workPackagePath = Join-Path $workRoot 'package.json'
$oniPackagePath = Join-Path $oniRoot 'package.json'
$entryPath = Join-Path $pluginRoot 'dist/index.js'
$workEntryPath = Join-Path $workRoot 'dist/index.js'
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
$workPackage = Get-Content -Raw -LiteralPath $workPackagePath | ConvertFrom-Json
if ($workPackage.name -ne $manifest.workOrchestrator.packageName) {
  throw "Unexpected Work Orchestrator package name: $($workPackage.name)"
}
if ($workPackage.version -ne $manifest.workOrchestrator.expectedVersion) {
  throw "Expected Work Orchestrator version $($manifest.workOrchestrator.expectedVersion), found $($workPackage.version)"
}
$oniPackage = Get-Content -Raw -LiteralPath $oniPackagePath | ConvertFrom-Json
if ($oniPackage.name -ne $manifest.oniAdapter.packageName) {
  throw "Unexpected ONI Adapter package name: $($oniPackage.name)"
}
if ($oniPackage.version -ne $manifest.oniAdapter.expectedVersion) {
  throw "Expected ONI Adapter version $($manifest.oniAdapter.expectedVersion), found $($oniPackage.version)"
}

if (-not (Test-Path -LiteralPath $mediaProject -PathType Leaf)) {
  throw "XiaoTangYuan media host project was not found: $mediaProject"
}

New-Item -ItemType Directory -Force -Path $mediaOutput | Out-Null
dotnet publish $mediaProject -c Release -r win-x64 --self-contained true -o $mediaOutput | Out-Host
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $mediaEntry -PathType Leaf)) {
  throw "XiaoTangYuan media host build failed: $mediaEntry"
}

Push-Location $workRoot
try {
  pnpm run build | Out-Host
} finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $workEntryPath -PathType Leaf)) {
  throw "Work Orchestrator plugin build failed: $workEntryPath"
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
$runtimeRoot = Join-Path $artifactRoot 'desktop-runtime'
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

Push-Location $pluginRoot
try {
  pnpm pack --pack-destination $artifactRoot | Out-Host
} finally {
  Pop-Location
}

Push-Location $workRoot
try {
  pnpm pack --pack-destination $artifactRoot | Out-Host
} finally {
  Pop-Location
}

$workArchiveName = "qimidandapigu-dsh-work-orchestrator-$($workPackage.version).tgz"
$workArchivePath = Join-Path $artifactRoot $workArchiveName
if (-not (Test-Path -LiteralPath $workArchivePath -PathType Leaf)) {
  throw "Work Orchestrator archive was not produced: $workArchivePath"
}

$archiveName = "qimidandapigu-dsh-xiaotangyuan-game-$($pluginPackage.version).tgz"
$archivePath = Join-Path $artifactRoot $archiveName
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
  throw "Plugin archive was not produced: $archivePath"
}

Push-Location $oniRoot
try {
  # ONI ships the private Adapter Protocol reference packages inside its tgz.
  # pnpm requires hoisted packing for bundledDependencies even though the
  # workspace itself deliberately uses the isolated linker.
  pnpm --config.node-linker=hoisted pack --pack-destination $artifactRoot | Out-Host
} finally {
  Pop-Location
}
$oniArchiveName = "qimidandapigu-oni-adapter-$($oniPackage.version).tgz"
$oniArchivePath = Join-Path $artifactRoot $oniArchiveName
if (-not (Test-Path -LiteralPath $oniArchivePath -PathType Leaf)) {
  throw "ONI Adapter archive was not produced: $oniArchivePath"
}

$smokeScript = Join-Path $repoRoot 'scripts/smoke-xiaotangyuan-runtime.mjs'
$smokePatchPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $manifest.smokePatch))
if (-not (Test-Path -LiteralPath $smokeScript -PathType Leaf)) {
  throw "XiaoTangYuan Runtime smoke script was not found: $smokeScript"
}

$resolvedArtifactRoot = [IO.Path]::GetFullPath($artifactRoot)
foreach ($generatedPath in @($profileHome, $runtimeRoot)) {
  $resolvedGeneratedPath = [IO.Path]::GetFullPath($generatedPath)
  if (-not $resolvedGeneratedPath.StartsWith($resolvedArtifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe generated integration path: $resolvedGeneratedPath"
  }
  if (Test-Path -LiteralPath $resolvedGeneratedPath) {
    Remove-Item -LiteralPath $resolvedGeneratedPath -Recurse -Force
  }
}

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$runtimePackage = [ordered]@{
  name = '@ai-native-game-harness/xiaotangyuan-smoke-runtime'
  version = '0.1.0'
  private = $true
  dependencies = [ordered]@{
    '@deepseek-ai/dsh' = $manifest.compatibility.desktopDsh
  }
}
[IO.File]::WriteAllText(
  (Join-Path $runtimeRoot 'package.json'),
  ($runtimePackage | ConvertTo-Json -Depth 10),
  [Text.UTF8Encoding]::new($false)
)
Push-Location $runtimeRoot
try {
  pnpm --ignore-workspace --config.node-linker=hoisted install --prod --ignore-scripts | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Built-in desktop DSH installation failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
$dshBin = Join-Path $runtimeRoot 'node_modules/@deepseek-ai/dsh/lib/bin.js'
if (-not (Test-Path -LiteralPath $dshBin -PathType Leaf)) {
  throw "Built-in desktop DSH entry was not found: $dshBin"
}

$previousDshHome = $env:DSH_HOME
try {
  $env:DSH_HOME = $profileHome
  Push-Location $repoRoot
  try {
    node $dshBin plugin --profile $ProfileName add $workArchivePath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Work Orchestrator installation failed with exit code $LASTEXITCODE" }
    node $dshBin plugin --profile $ProfileName add $archivePath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Plugin installation failed with exit code $LASTEXITCODE" }
    node $dshBin plugin --profile $ProfileName add $oniArchivePath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "ONI Adapter installation failed with exit code $LASTEXITCODE" }
    node $dshBin plugin --profile $ProfileName list --depth 0 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Plugin listing failed with exit code $LASTEXITCODE" }
    node $dshBin --profile $ProfileName --patch $manifest.smokePatch --dump-config | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Composed config validation failed with exit code $LASTEXITCODE" }
    node $smokeScript `
      --repo-root $repoRoot `
      --dsh-bin $dshBin `
      --dsh-home $profileHome `
      --profile $ProfileName `
      --patch $smokePatchPath `
      --gateway-port 0 | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw "XiaoTangYuan desktop Runtime smoke failed with exit code $LASTEXITCODE"
    }
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
  workOrchestrator = $workArchivePath
  oniAdapter = $oniArchivePath
  profile = $ProfileName
  profileHome = $profileHome
  dsh = $manifest.compatibility.desktopDsh
} | ConvertTo-Json
