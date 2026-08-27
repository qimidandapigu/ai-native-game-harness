param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'integrations/xiaotangyuan/manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$archiveName = "qimidandapigu-dsh-xiaotangyuan-game-$($manifest.development.expectedVersion).tgz"
$archivePath = Join-Path $repoRoot ".artifacts/xiaotangyuan/$archiveName"
$oniArchiveName = "qimidandapigu-oni-adapter-$($manifest.oniAdapter.expectedVersion).tgz"
$oniArchivePath = Join-Path $repoRoot ".artifacts/xiaotangyuan/$oniArchiveName"
$runtimeRoot = Join-Path $repoRoot '.artifacts/desktop-runtime'
$appRoot = Join-Path $repoRoot '.artifacts/desktop-app'
$sourceRoot = Join-Path $repoRoot 'apps/desktop/src'
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot '.artifacts'))

if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
  throw "Desktop plugin archive was not found: $archivePath"
}
if (-not (Test-Path -LiteralPath $oniArchivePath -PathType Leaf)) {
  throw "Desktop ONI Adapter archive was not found: $oniArchivePath"
}

foreach ($generatedRoot in @($runtimeRoot, $appRoot)) {
  $resolvedGeneratedRoot = [IO.Path]::GetFullPath($generatedRoot)
  if (-not $resolvedGeneratedRoot.StartsWith($artifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe generated desktop path: $resolvedGeneratedRoot"
  }
  if (Test-Path -LiteralPath $resolvedGeneratedRoot) {
    node (Join-Path $PSScriptRoot 'clean-generated-desktop.mjs') $resolvedGeneratedRoot
    if ($LASTEXITCODE -ne 0) { throw "generated desktop cleanup failed with exit code $LASTEXITCODE" }
  }
}

Push-Location $repoRoot
try {
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  $runtimePackage = [ordered]@{
    name = '@ai-native-game-harness/desktop-runtime'
    version = '0.1.0'
    private = $true
    dependencies = [ordered]@{
      '@deepseek-ai/dsh' = $manifest.compatibility.desktopDsh
    }
  }
  $runtimePackagePath = Join-Path $runtimeRoot 'package.json'
  [IO.File]::WriteAllText($runtimePackagePath, ($runtimePackage | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))

  Push-Location $runtimeRoot
  try {
    pnpm --ignore-workspace --config.node-linker=hoisted install --prod --ignore-scripts | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "runtime DSH installation failed with exit code $LASTEXITCODE" }

    pnpm --ignore-workspace --config.node-linker=hoisted add --prod --save-exact --ignore-scripts $archivePath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "runtime plugin installation failed with exit code $LASTEXITCODE" }

    pnpm --ignore-workspace --config.node-linker=hoisted add --prod --save-exact --ignore-scripts $oniArchivePath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "runtime ONI Adapter installation failed with exit code $LASTEXITCODE" }

    node (Join-Path $PSScriptRoot 'patch-desktop-dsh-runtime.mjs') $runtimeRoot | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "runtime compatibility patch failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
} finally {
  Pop-Location
}

$runtimeModules = Join-Path $runtimeRoot 'node_modules'
$runtimeScopeRoot = Join-Path $runtimeModules '@ai-native-game-harness'
New-Item -ItemType Directory -Force -Path $runtimeScopeRoot | Out-Null
$runtimePackages = @(
  @{ Name = 'adapter-protocol'; Source = (Join-Path $repoRoot 'packages/adapter-protocol') },
  @{ Name = 'adapter-websocket'; Source = (Join-Path $repoRoot 'packages/adapter-websocket') },
  @{ Name = 'harness-core'; Source = (Join-Path $repoRoot 'packages/harness-core') },
  @{ Name = 'game-pack'; Source = (Join-Path $repoRoot 'packages/game-pack') },
  @{ Name = 'story-runtime'; Source = (Join-Path $repoRoot 'packages/story-runtime') },
  @{ Name = 'dsh-binding'; Source = (Join-Path $repoRoot 'packages/dsh-binding') },
  @{ Name = 'bridge-contract'; Source = (Join-Path $repoRoot 'contracts/bridge-v1') },
  @{ Name = 'game-core'; Source = (Join-Path $repoRoot 'plugins/game-core') },
  @{ Name = 'game-transport'; Source = (Join-Path $repoRoot 'plugins/game-transport') },
  @{ Name = 'game-learning-binding'; Source = (Join-Path $repoRoot 'plugins/game-learning-binding') },
  @{ Name = 'dsh-story-generator'; Source = (Join-Path $repoRoot 'plugins/dsh-story-generator') }
)
foreach ($runtimePackageEntry in $runtimePackages) {
  $runtimePackageTarget = Join-Path $runtimeScopeRoot $runtimePackageEntry.Name
  New-Item -ItemType Directory -Force -Path $runtimePackageTarget | Out-Null
  Copy-Item -LiteralPath (Join-Path $runtimePackageEntry.Source 'package.json') -Destination $runtimePackageTarget -Force
  Copy-Item -LiteralPath (Join-Path $runtimePackageEntry.Source 'dist') -Destination $runtimePackageTarget -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
Copy-Item -LiteralPath $sourceRoot -Destination $appRoot -Recurse -Force

$appModules = Join-Path $appRoot 'node_modules'
$scopeRoot = Join-Path $appModules '@ai-native-game-harness'
New-Item -ItemType Directory -Force -Path $scopeRoot | Out-Null

foreach ($packageName in @('adapter-protocol', 'adapter-websocket', 'harness-core', 'game-pack')) {
  $packageRoot = Join-Path $repoRoot "packages/$packageName"
  $packageTarget = Join-Path $scopeRoot $packageName
  New-Item -ItemType Directory -Force -Path $packageTarget | Out-Null
  Copy-Item -LiteralPath (Join-Path $packageRoot 'package.json') -Destination $packageTarget -Force
  Copy-Item -LiteralPath (Join-Path $packageRoot 'dist') -Destination $packageTarget -Recurse -Force
}

$webSocketSource = Join-Path $repoRoot 'packages/adapter-websocket/node_modules/ws'
if (-not (Test-Path -LiteralPath $webSocketSource -PathType Container)) {
  throw "Desktop WebSocket dependency was not found: $webSocketSource"
}
Copy-Item -LiteralPath $webSocketSource -Destination (Join-Path $appModules 'ws') -Recurse -Force

$stagePackage = [ordered]@{
  name = '@ai-native-game-harness/desktop'
  version = '0.1.0'
  private = $true
  description = 'Windows game edition of AI Native Game Harness.'
  author = 'qimidandapigu'
  license = 'MIT'
  type = 'module'
  main = 'src/main.mjs'
  dependencies = [ordered]@{
    '@ai-native-game-harness/adapter-websocket' = '0.1.0'
    '@ai-native-game-harness/game-pack' = '0.1.0'
    '@ai-native-game-harness/harness-core' = '0.1.0'
    'ws' = '8.21.3'
  }
}
[IO.File]::WriteAllText((Join-Path $appRoot 'package.json'), ($stagePackage | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

[PSCustomObject]@{
  app = $appRoot
  runtime = $runtimeRoot
  plugin = $archivePath
  oniAdapter = $oniArchivePath
  dsh = $manifest.compatibility.desktopDsh
} | ConvertTo-Json
