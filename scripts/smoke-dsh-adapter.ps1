param(
  [int]$Port = 33245,
  [string]$Profile = 'headless',
  [string]$Prompt = 'You are connected to mock-game. You must call game tools: first move to x=2,y=1, then collect the coin. Finally, report only the authoritative coin count and revision returned by the tools.'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$artifactRoot = Join-Path $repoRoot '.artifacts'
$patchPath = Join-Path $artifactRoot 'dsh-adapter-smoke.patch.yml'
$corePluginPath = Join-Path $repoRoot 'plugins/game-core/dist/index.js'
$transportPluginPath = Join-Path $repoRoot 'plugins/game-transport/dist/index.js'
$mockClientPath = Join-Path $repoRoot 'examples/mock-game/dist/client.js'

Push-Location $repoRoot
try {
  pnpm --filter @ai-native-game-harness/game-transport... --filter @ai-native-game-harness/mock-game... build | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "smoke build failed with exit code $LASTEXITCODE" }

  New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
  $corePluginUrl = [Uri]::new([IO.Path]::GetFullPath($corePluginPath)).AbsoluteUri
  $transportPluginUrl = [Uri]::new([IO.Path]::GetFullPath($transportPluginPath)).AbsoluteUri
  $patch = @"
- insert:
    - id: ai-native-game-core-smoke
      name: '$corePluginUrl'
    - id: ai-native-game-transport-smoke
      name: '$transportPluginUrl'
      config:
        enabled: true
        host: 127.0.0.1
        port: $Port
        path: /adapter
        requestTimeoutMs: 5000
        startupWaitForAdapterMs: 10000
- id: headless-runner
  inject:
    - headlessStartup
    - gameTransport
  config:
    task: !!js ctx.headlessStartup.task
"@
  [IO.File]::WriteAllText($patchPath, $patch, [Text.UTF8Encoding]::new($false))

  $previousAdapterUrl = $env:MOCK_ADAPTER_URL
  $env:MOCK_ADAPTER_URL = "ws://127.0.0.1:$Port/adapter"
  $client = Start-Process -FilePath node -ArgumentList $mockClientPath -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
  try {
    $result = @(pnpm exec dsh --profile $Profile --patch $patchPath $Prompt 2>&1)
    $exitCode = $LASTEXITCODE
    $result | ForEach-Object { Write-Output $_ }
    if ($exitCode -ne 0) { throw "DSH Adapter smoke failed with exit code $exitCode" }
    $rendered = $result -join "`n"
    $coinThenRevision = $rendered -match '(?is)coin.{0,80}\b1\b.{0,80}revision.{0,80}\b2\b'
    $revisionThenCoin = $rendered -match '(?is)revision.{0,80}\b2\b.{0,80}coin.{0,80}\b1\b'
    if (-not ($coinThenRevision -or $revisionThenCoin)) {
      throw 'DSH Adapter smoke did not report the authoritative coin count 1 and revision 2'
    }
  } finally {
    if ($client -and -not $client.HasExited) {
      Stop-Process -Id $client.Id -Force
    }
    $env:MOCK_ADAPTER_URL = $previousAdapterUrl
  }
} finally {
  Pop-Location
}
