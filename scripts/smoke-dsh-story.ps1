param(
  [int]$Port = 33246,
  [string]$Profile = 'headless'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$artifactRoot = Join-Path $repoRoot '.artifacts/dsh-story-smoke'
$stateRoot = Join-Path $artifactRoot 'story'
$gamePackRoot = Join-Path $artifactRoot 'game-packs'
$installedPackRoot = Join-Path $gamePackRoot 'mock-story-smoke'
$sourcePackRoot = Join-Path $repoRoot 'examples/mock-game/story-pack'
$patchPath = Join-Path $artifactRoot 'story.patch.yml'
$storyFile = Join-Path $stateRoot 'story-state-v1.json'
$corePluginPath = Join-Path $repoRoot 'plugins/game-core/dist/index.js'
$transportPluginPath = Join-Path $repoRoot 'plugins/game-transport/dist/index.js'
$storyPluginPath = Join-Path $repoRoot 'plugins/dsh-story-generator/dist/index.js'
$mockClientPath = Join-Path $repoRoot 'examples/mock-game/dist/client.js'

function Assert-SafeGeneratedRoot([string]$Path) {
  $resolvedArtifact = [IO.Path]::GetFullPath($artifactRoot)
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedArtifact + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe story smoke path: $resolvedPath"
  }
}

function Invoke-StoryDsh([string]$Prompt) {
  $result = @(pnpm exec dsh --profile $Profile --patch $patchPath $Prompt 2>&1)
  $exitCode = $LASTEXITCODE
  $result | ForEach-Object { Write-Host $_ }
  if ($exitCode -ne 0) { throw "DSH Story smoke failed with exit code $exitCode" }
  return $result -join "`n"
}

function Require-StoryState {
  if (-not (Test-Path -LiteralPath $storyFile -PathType Leaf)) {
    throw "Story Runtime did not persist $storyFile"
  }
  $document = Get-Content -Raw -Encoding UTF8 -LiteralPath $storyFile | ConvertFrom-Json
  $state = @($document.states) | Where-Object { $_.gameId -eq 'mock-game' -and $_.saveId -eq 'demo-save' } | Select-Object -First 1
  if ($null -eq $state) { throw 'Story Store does not contain mock-game / demo-save' }
  return [PSCustomObject]@{ Document = $document; State = $state }
}

Push-Location $repoRoot
try {
  pnpm --filter @ai-native-game-harness/dsh-story-generator... --filter @ai-native-game-harness/game-transport... --filter @ai-native-game-harness/mock-game... build | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "story smoke build failed with exit code $LASTEXITCODE" }

  Assert-SafeGeneratedRoot $stateRoot
  Assert-SafeGeneratedRoot $gamePackRoot
  foreach ($generatedRoot in @($stateRoot, $gamePackRoot)) {
    if (Test-Path -LiteralPath $generatedRoot) {
      Remove-Item -LiteralPath $generatedRoot -Recurse -Force
    }
  }
  New-Item -ItemType Directory -Force -Path $artifactRoot, $installedPackRoot | Out-Null
  Copy-Item -Path (Join-Path $sourcePackRoot '*') -Destination $installedPackRoot -Recurse -Force

  $corePluginUrl = [Uri]::new([IO.Path]::GetFullPath($corePluginPath)).AbsoluteUri
  $transportPluginUrl = [Uri]::new([IO.Path]::GetFullPath($transportPluginPath)).AbsoluteUri
  $storyPluginUrl = [Uri]::new([IO.Path]::GetFullPath($storyPluginPath)).AbsoluteUri
  $yamlStateRoot = ([IO.Path]::GetFullPath($stateRoot)).Replace("'", "''")
  $yamlGamePackRoot = ([IO.Path]::GetFullPath($gamePackRoot)).Replace("'", "''")
  $patch = @"
- insert:
    - id: ai-native-game-core-story-smoke
      name: '$corePluginUrl'
    - id: ai-native-game-transport-story-smoke
      name: '$transportPluginUrl'
      config:
        enabled: true
        host: 127.0.0.1
        port: $Port
        path: /adapter
        requestTimeoutMs: 5000
        startupWaitForAdapterMs: 15000
    - id: ai-native-game-story-smoke
      name: '$storyPluginUrl'
      config:
        dataRoot: '$yamlStateRoot'
        gamePackRoot: '$yamlGamePackRoot'
        productSnapshotOutput: false
- id: headless-runner
  inject:
    - headlessStartup
    - gameTransport
    - gameStory
  config:
    task: !!js ctx.headlessStartup.task
"@
  [IO.File]::WriteAllText($patchPath, $patch, [Text.UTF8Encoding]::new($false))

  $previousAdapterUrl = $env:MOCK_ADAPTER_URL
  $env:MOCK_ADAPTER_URL = "ws://127.0.0.1:$Port/adapter"
  $client = Start-Process -FilePath node -ArgumentList $mockClientPath -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
  try {
    $firstPrompt = @'
This is the required AI Native Game Harness dynamic-story smoke test. Use the tools; do not merely describe what you would do.
1. Call game_story_context exactly once.
2. If needsGeneration is true, create exactly one original StoryBeat-v1 and submit it through game_story_propose. Use id "story-smoke-coin". Its completion must be {"path":"coin.collected","operator":"eq","value":true}; capabilityHints must be ["game.move","game.collect"]. Generate the title, premise, goal, characterMotivation, and nextDirections yourself from the narrative policy and current observation.
3. Only after the proposal is accepted, call the Mock Game action tools to move to x=2,y=1 and then collect the coin.
4. Call game_story_context again so Story Runtime can show the Adapter-proven result.
5. Finish with the exact public marker STORY_SMOKE_COMPLETED and report the authoritative coin count, observation revision, beat id and history outcome.
'@
    $firstOutput = Invoke-StoryDsh $firstPrompt
    if ($firstOutput -notmatch 'STORY_SMOKE_COMPLETED') {
      throw 'DSH Agent did not emit the STORY_SMOKE_COMPLETED marker'
    }

    $persisted = Require-StoryState
    $completed = @($persisted.State.history) | Where-Object { $_.beat.id -eq 'story-smoke-coin' -and $_.outcome -eq 'completed' } | Select-Object -First 1
    if ($null -eq $completed) { throw 'Story Runtime did not record story-smoke-coin as completed' }
    if ($completed.evidence.observationRevision -ne 2 -or $completed.evidence.actualValue -ne $true) {
      throw "Story completion lacks authoritative revision 2 / true evidence: $($completed.evidence | ConvertTo-Json -Compress)"
    }
    $accepted = @($persisted.Document.generationAttempts) | Where-Object { $_.accepted -eq $true -and $_.proposedBeatIds -contains 'story-smoke-coin' } | Select-Object -First 1
    if ($null -eq $accepted) { throw 'Story Store does not contain an accepted model generation attempt' }

    $secondPrompt = @'
This is the persistence half of the dynamic-story smoke test. Call game_story_context exactly once. Do not propose a new beat and do not call any game action. Read the existing immutable history for mock-game / demo-save. Finish with the exact public marker STORY_SMOKE_RESTORED and report the stored beat id and outcome.
'@
    $secondOutput = Invoke-StoryDsh $secondPrompt
    if ($secondOutput -notmatch 'STORY_SMOKE_RESTORED' -or $secondOutput -notmatch 'story-smoke-coin' -or $secondOutput -notmatch '(?i)completed') {
      throw 'Restarted DSH Agent did not read the persisted completed story history'
    }
    $restored = Require-StoryState
    $restoredCompleted = @(@($restored.State.history) | Where-Object { $_.beat.id -eq 'story-smoke-coin' -and $_.outcome -eq 'completed' })
    if ($restoredCompleted.Count -ne 1) { throw 'Restart changed or duplicated immutable story history' }

    [PSCustomObject]@{
      ok = $true
      gameId = $restored.State.gameId
      saveId = $restored.State.saveId
      beatId = 'story-smoke-coin'
      outcome = 'completed'
      observationRevision = $restoredCompleted[0].evidence.observationRevision
      acceptedGenerationAttempts = @($restored.Document.generationAttempts | Where-Object accepted).Count
      restoredAfterRestart = $true
    } | ConvertTo-Json -Compress | Write-Output
  } finally {
    if ($client -and -not $client.HasExited) {
      Stop-Process -Id $client.Id -Force
    }
    $env:MOCK_ADAPTER_URL = $previousAdapterUrl
  }
} finally {
  Pop-Location
}
