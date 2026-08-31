param(
  [switch]$SkipChecks,
  [switch]$SkipStartupSmoke,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$demoRoot = Join-Path $repoRoot '.artifacts/game-demo'
$mediaEntry = Join-Path $repoRoot 'plugins/xiaotangyuan-game/media/windows-x64/XtyMediaHost.exe'
$voiceScriptBase64 = '5ryU56S66K+t5Y+lIDHvvJrmmI7lpKnopoHmsYfmiqXvvIzluK7miJHlh4blpIfkuIDkuKogQUkg5aaC5L2V5pS55Y+Y5ri45oiPIOeahCBIVE1M77yM5YWI6K+06K+05L2g55qE5oCd6Lev44CCDQrmvJTnpLror63lj6UgMu+8mui/meS4qiBIVE1MIOWBmuWIsOWTquS6hu+8nw0K5ryU56S66K+t5Y+lIDPvvJrnrKzkuozpg6jliIbmoYjkvovkuI3lpJ/nnJ/lrp7vvIzor7fmjaLmiJDkuInkuKrnnJ/lrp7muLjmiI/ooYzkuJrmoYjkvovjgIINCua8lOekuuivreWPpSA077ya5oCd6Lev5a+55LqG77yM6K+355Sf5oiQIEhUTUwg5bm25omT5byA57uZ5oiR55yL44CCDQo='

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )
  & $Command @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
}

Push-Location $repoRoot
try {
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules') -PathType Container)) {
    Invoke-CheckedCommand -Command 'pnpm' -Arguments @('install', '--frozen-lockfile') -FailureMessage 'pnpm install failed.'
  }

  if (-not (Test-Path -LiteralPath $mediaEntry -PathType Leaf)) {
    $resourcesRoot = Join-Path $env:LOCALAPPDATA 'Programs/@ai-native-game-harnessdesktop/resources'
    $installedMedia = Get-ChildItem -LiteralPath $resourcesRoot -Recurse -Filter XtyMediaHost.exe -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $installedMedia) {
      New-Item -ItemType Directory -Force -Path (Split-Path $mediaEntry -Parent) | Out-Null
      Copy-Item -LiteralPath $installedMedia.FullName -Destination $mediaEntry -Force
      (Get-Item -LiteralPath $mediaEntry).LastWriteTimeUtc = [DateTime]::UtcNow
    } else {
      $dotnetSdks = & dotnet --list-sdks 2>$null
      if ($LASTEXITCODE -ne 0 -or -not $dotnetSdks) {
        throw 'XtyMediaHost.exe is unavailable and .NET SDK was not found. Install the game Desktop or .NET 8 SDK first.'
      }
    }
  }

  if (-not $SkipChecks) {
    Invoke-CheckedCommand -Command 'pnpm' -Arguments @('--filter', '@ai-native-game-harness/mock-game...', 'build') -FailureMessage 'Mock Game build failed.'
    Invoke-CheckedCommand -Command 'pnpm' -Arguments @('--filter', '@qimidandapigu/dsh-work-orchestrator', 'run', 'check') -FailureMessage 'Work Orchestrator check failed.'
    Invoke-CheckedCommand -Command 'pnpm' -Arguments @('--filter', '@qimidandapigu/dsh-xiaotangyuan-game', 'run', 'check') -FailureMessage 'XiaoTangYuan check failed.'
    Invoke-CheckedCommand -Command 'pnpm' -Arguments @('--filter', '@ai-native-game-harness/integration-tests', 'exec', 'vitest', 'run', 'dual-session-e2e.test.ts') -FailureMessage 'Dual Session E2E failed.'
  }

  Invoke-CheckedCommand -Command 'powershell' -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repoRoot 'scripts/prepare-desktop-dev.ps1')) -FailureMessage 'Desktop development preparation failed.'

  if (-not $SkipStartupSmoke) {
    Invoke-CheckedCommand -Command 'node' -Arguments @((Join-Path $repoRoot 'scripts/smoke-desktop-startup.mjs'), '--skip-prepare') -FailureMessage 'Desktop startup smoke failed.'
  }

  New-Item -ItemType Directory -Force -Path $demoRoot | Out-Null
  $demoUserData = Join-Path $demoRoot ('user-data-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
  $preparedUserData = Join-Path $repoRoot '.artifacts/desktop-dev-user-data'
  $preparedDshHome = Join-Path $preparedUserData 'dsh-home'
  $preparedRuntimeState = Join-Path $preparedUserData 'runtime-state'
  if (-not (Test-Path -LiteralPath $preparedDshHome) -or -not (Test-Path -LiteralPath $preparedRuntimeState)) {
    throw 'Prepared Desktop profile is incomplete.'
  }

  $demoDshHome = Join-Path $demoUserData 'dsh-home'
  New-Item -ItemType Directory -Force -Path $demoDshHome | Out-Null
  Get-ChildItem -LiteralPath $preparedDshHome -Force |
    Where-Object { $_.Name -notin @('storages', 'profiles') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $demoDshHome -Recurse -Force }
  $demoProfiles = Join-Path $demoDshHome 'profiles'
  New-Item -ItemType Directory -Force -Path $demoProfiles | Out-Null
  Get-ChildItem -LiteralPath (Join-Path $preparedDshHome 'profiles') -Force |
    Where-Object { $_.Name -ne 'node_modules' } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $demoProfiles -Recurse -Force }
  Copy-Item -LiteralPath $preparedRuntimeState -Destination $demoUserData -Recurse -Force

  $voiceScriptPath = Join-Path $demoRoot 'VOICE_SCRIPT.txt'
  [IO.File]::WriteAllBytes($voiceScriptPath, [Convert]::FromBase64String($voiceScriptBase64))

  if (-not $NoLaunch) {
    if (Get-NetTCPConnection -LocalPort 33145 -State Listen -ErrorAction SilentlyContinue) {
      throw 'Port 33145 is already in use. Close the running game Desktop before starting the isolated demo.'
    }
    $desktopDirectory = Join-Path $repoRoot 'apps/desktop'
    if ($env:AI_GAME_HARNESS_ELECTRON -and (Test-Path -LiteralPath $env:AI_GAME_HARNESS_ELECTRON -PathType Leaf)) {
      $previousDev = $env:AI_GAME_HARNESS_DEV
      $previousUserData = $env:AI_GAME_HARNESS_DEV_USER_DATA
      try {
        $env:AI_GAME_HARNESS_DEV = '1'
        $env:AI_GAME_HARNESS_DEV_USER_DATA = $demoUserData
        Start-Process -FilePath $env:AI_GAME_HARNESS_ELECTRON -ArgumentList @('.') -WorkingDirectory $desktopDirectory -WindowStyle Hidden
      } finally {
        $env:AI_GAME_HARNESS_DEV = $previousDev
        $env:AI_GAME_HARNESS_DEV_USER_DATA = $previousUserData
      }
    } else {
      $escapedUserData = $demoUserData.Replace("'", "''")
      $launchCommand = "`$env:AI_GAME_HARNESS_DEV='1'; `$env:AI_GAME_HARNESS_DEV_USER_DATA='$escapedUserData'; pnpm --filter '@ai-native-game-harness/desktop' dev"
      Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', $launchCommand) -WorkingDirectory $repoRoot -WindowStyle Hidden
    }
  }

  [PSCustomObject]@{
    ready = $true
    desktopLaunched = -not $NoLaunch
    desktopProfile = $demoUserData
    voiceScript = $voiceScriptPath
    next = if ($NoLaunch) { 'Preparation complete; Desktop was not launched.' } else { 'Start Stardew Valley, load a save, press V, and read the four lines in VOICE_SCRIPT.txt.' }
  } | ConvertTo-Json
} finally {
  Pop-Location
}
