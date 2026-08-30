param(
  [switch]$ForceMediaHost
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$artifactRoot = Join-Path $repoRoot '.artifacts/xiaotangyuan'
$manifestPath = Join-Path $repoRoot 'integrations/xiaotangyuan/manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

function Get-Sha256Hex([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules') -PathType Container)) {
  throw 'Workspace dependencies are missing. Run pnpm install --frozen-lockfile once before desktop:dev:prepare.'
}

$mediaProjectRoot = Join-Path $repoRoot 'apps/windows-media-host'
$mediaProject = Join-Path $mediaProjectRoot 'XtyMediaHost.csproj'
$mediaOutput = Join-Path $repoRoot 'plugins/xiaotangyuan-game/media/windows-x64'
$mediaEntry = Join-Path $mediaOutput 'XtyMediaHost.exe'
$mediaSources = Get-ChildItem -LiteralPath $mediaProjectRoot -Recurse -File |
  Where-Object { $_.Extension -in '.cs', '.csproj', '.props', '.targets' }
$mediaOutdated = $ForceMediaHost -or -not (Test-Path -LiteralPath $mediaEntry -PathType Leaf)
if (-not $mediaOutdated -and $mediaSources.Count -gt 0) {
  $latestSourceWrite = ($mediaSources | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
  $mediaOutdated = $latestSourceWrite -gt (Get-Item -LiteralPath $mediaEntry).LastWriteTimeUtc
}

if ($mediaOutdated) {
  New-Item -ItemType Directory -Force -Path $mediaOutput | Out-Null
  dotnet publish $mediaProject -c Release -r win-x64 --self-contained true -o $mediaOutput | Out-Host
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $mediaEntry -PathType Leaf)) {
    throw "Desktop media host build failed: $mediaEntry"
  }
} else {
  Write-Host 'Desktop media host is unchanged; reusing the existing development binary.'
}

Push-Location $repoRoot
try {
  pnpm --filter '@ai-native-game-harness/game-transport...' build | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Game transport development build failed.' }
  pnpm --filter $manifest.workOrchestrator.packageName build | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Work Orchestrator development build failed.' }
  pnpm --filter $manifest.packageName build | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'XiaoTangYuan development build failed.' }
  pnpm --filter '@ai-native-game-harness/game-learning-binding' build | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Game learning development build failed.' }
  pnpm --filter '@ai-native-game-harness/dsh-story-generator...' build | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Story generator development build failed.' }
  pnpm --filter $manifest.oniAdapter.packageName build | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'ONI Adapter development build failed.' }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
$packages = @(
  @{ Root = (Join-Path $repoRoot $manifest.workOrchestrator.source); Name = "qimidandapigu-dsh-work-orchestrator-$($manifest.workOrchestrator.expectedVersion).tgz"; Hoisted = $false },
  @{ Root = (Join-Path $repoRoot $manifest.development.defaultSource); Name = "qimidandapigu-dsh-xiaotangyuan-game-$($manifest.development.expectedVersion).tgz"; Hoisted = $false },
  @{ Root = (Join-Path $repoRoot $manifest.oniAdapter.source); Name = "qimidandapigu-oni-adapter-$($manifest.oniAdapter.expectedVersion).tgz"; Hoisted = $true }
)

foreach ($package in $packages) {
  Push-Location $package.Root
  try {
    if ($package.Hoisted) {
      pnpm --config.node-linker=hoisted pack --pack-destination $artifactRoot | Out-Host
    } else {
      pnpm pack --pack-destination $artifactRoot | Out-Host
    }
    if ($LASTEXITCODE -ne 0) { throw "Development plugin pack failed: $($package.Root)" }
  } finally {
    Pop-Location
  }
  $archivePath = Join-Path $artifactRoot $package.Name
  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    throw "Development plugin archive was not produced: $archivePath"
  }
}

$devUserData = Join-Path $repoRoot '.artifacts/desktop-dev-user-data'
$devDshHome = Join-Path $devUserData 'dsh-home'
$dshBin = Join-Path $repoRoot 'node_modules/@deepseek-ai/dsh/lib/bin.js'
if (-not (Test-Path -LiteralPath $dshBin -PathType Leaf)) {
  throw "Workspace DSH entry was not found: $dshBin"
}

$previousDshHome = $env:DSH_HOME
try {
  $env:DSH_HOME = $devDshHome
  foreach ($package in $packages) {
    $archivePath = Join-Path $artifactRoot $package.Name
    node --expose-internals $dshBin plugin --profile web add $archivePath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Development profile plugin update failed: $archivePath" }
  }
} finally {
  $env:DSH_HOME = $previousDshHome
}

$pluginArchive = Join-Path $artifactRoot $packages[1].Name
$workArchive = Join-Path $artifactRoot $packages[0].Name
$oniArchive = Join-Path $artifactRoot $packages[2].Name
$pluginFingerprint = "$($manifest.development.expectedVersion):$(Get-Sha256Hex $pluginArchive)"
$workFingerprint = "$($manifest.workOrchestrator.expectedVersion):$(Get-Sha256Hex $workArchive)"
$oniFingerprint = "$($manifest.oniAdapter.expectedVersion):$(Get-Sha256Hex $oniArchive)"
$stateRoot = Join-Path $devUserData 'runtime-state'
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
[IO.File]::WriteAllText(
  (Join-Path $stateRoot 'xiaotangyuan.version'),
  "$pluginFingerprint;work=$workFingerprint;oni=$oniFingerprint`n",
  [Text.UTF8Encoding]::new($false)
)

[PSCustomObject]@{
  mode = 'source-development'
  artifacts = $artifactRoot
  profile = $devDshHome
  mediaHostRebuilt = $mediaOutdated
  next = 'pnpm desktop:dev'
} | ConvertTo-Json
