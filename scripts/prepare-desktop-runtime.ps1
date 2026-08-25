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

New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
Copy-Item -LiteralPath $sourceRoot -Destination $appRoot -Recurse -Force

$stagePackage = [ordered]@{
  name = '@ai-native-game-harness/desktop'
  version = '0.1.0'
  private = $true
  description = 'Windows game edition of AI Native Game Harness.'
  author = 'qimidandapigu'
  license = 'MIT'
  type = 'module'
  main = 'src/main.mjs'
}
[IO.File]::WriteAllText((Join-Path $appRoot 'package.json'), ($stagePackage | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

[PSCustomObject]@{
  app = $appRoot
  runtime = $runtimeRoot
  plugin = $archivePath
  oniAdapter = $oniArchivePath
  dsh = $manifest.compatibility.desktopDsh
} | ConvertTo-Json
