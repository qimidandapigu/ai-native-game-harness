[CmdletBinding()]
param(
    [ValidateSet('stardew', 'dst', 'oni', 'auto')]
    [string]$Game = 'stardew',

    [ValidateRange(1, 1440)]
    [int]$DurationMinutes = 60,

    [ValidateRange(0, 86400)]
    [int]$DurationSeconds = 0,

    [ValidateRange(1, 300)]
    [int]$SampleIntervalSeconds = 30,

    [ValidateRange(1, 65535)]
    [int]$GatewayPort = 33145,

    [string]$OutputDirectory,

    [switch]$SkipResilienceChecks,
    [switch]$SkipGatewayRequirement,
    [switch]$SkipGameRequirement,

    [int[]]$AdditionalProcessId = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot '.artifacts\stability-lite'
}

$startedAt = Get-Date
$runId = $startedAt.ToString('yyyyMMdd-HHmmss') + "-$Game"
$runDirectory = Join-Path $OutputDirectory $runId
$metricsPath = Join-Path $runDirectory 'process-metrics.csv'
$eventsPath = Join-Path $runDirectory 'events.jsonl'
$checksPath = Join-Path $runDirectory 'resilience-checks.log'
$summaryPath = Join-Path $runDirectory 'summary.json'
$reportPath = Join-Path $runDirectory 'REPORT.txt'
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
'"Timestamp","Role","Name","ProcessId","CpuPercent","WorkingSetMB","PrivateMemoryMB","HandleCount","ThreadCount","GatewayListening","GatewayEstablishedConnections"' | Set-Content -LiteralPath $metricsPath -Encoding UTF8
'' | Set-Content -LiteralPath $checksPath -Encoding UTF8

function Write-RunEvent {
    param(
        [Parameter(Mandatory = $true)][string]$Type,
        [Parameter(Mandatory = $true)][hashtable]$Detail
    )

    $record = [ordered]@{
        schemaVersion = 1
        at = (Get-Date).ToUniversalTime().ToString('o')
        type = $Type
        detail = $Detail
    }
    Add-Content -LiteralPath $eventsPath -Value ($record | ConvertTo-Json -Compress -Depth 8) -Encoding UTF8
}

function Invoke-ExistingCheck {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $pnpm) {
        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    }
    if ($null -eq $pnpm) {
        return [pscustomobject]@{ name = $Name; passed = $false; exitCode = -1; detail = 'pnpm was not found on PATH' }
    }

    Add-Content -LiteralPath $checksPath -Value "`r`n=== $Name ===" -Encoding UTF8
    Push-Location $repoRoot
    try {
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = & $pnpm.Source @Arguments 2>&1
            $exitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        $output | ForEach-Object {
            Add-Content -LiteralPath $checksPath -Value ([string]$_) -Encoding UTF8
            Write-Host $_
        }
        return [pscustomobject]@{
            name = $Name
            passed = ($exitCode -eq 0)
            exitCode = $exitCode
            detail = if ($exitCode -eq 0) { 'existing repository test passed' } else { "existing repository test failed with exit code $exitCode" }
        }
    }
    finally {
        Pop-Location
    }
}

function Get-GatewaySnapshot {
    $connections = @(Get-NetTCPConnection -LocalPort $GatewayPort -ErrorAction SilentlyContinue)
    $listener = $connections | Where-Object State -eq 'Listen' | Select-Object -First 1
    return [pscustomobject]@{
        listening = ($null -ne $listener)
        ownerProcessId = if ($null -eq $listener) { 0 } else { [int]$listener.OwningProcess }
        establishedConnections = @($connections | Where-Object State -eq 'Established').Count
    }
}

function Get-ProcessRole {
    param(
        [Parameter(Mandatory = $true)]$CimProcess,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$RelatedProcessIds
    )

    $name = [IO.Path]::GetFileNameWithoutExtension([string]$CimProcess.Name).ToLowerInvariant()
    $commandLine = [string]$CimProcess.CommandLine
    $processIdValue = [int]$CimProcess.ProcessId

    if ($name -in @('stardewmoddingapi', 'stardew valley', 'stardewvalley')) {
        if ($Game -in @('stardew', 'auto')) { return 'game' }
        return $null
    }
    if ($name -in @('dontstarve_steam', 'dontstarve_steam_x64')) {
        if ($Game -in @('dst', 'auto')) { return 'game' }
        return $null
    }
    if ($name -eq 'oxygennotincluded') {
        if ($Game -in @('oni', 'auto')) { return 'game' }
        return $null
    }
    if ($name -eq 'chesterai') { return 'adapter' }
    if ($name -eq 'xtymediahost') { return 'media' }
    if ($name -eq 'ai native game harness') { return 'desktop' }
    if ($name -eq 'electron' -and $commandLine -match 'ai-native-game-harness|apps[\\/]desktop') { return 'desktop' }
    if ($name -eq 'node' -and ($RelatedProcessIds.Contains($processIdValue) -or $commandLine -match 'deepseek|dsh|ai-native-game-harness')) { return 'dsh-runtime' }
    if ($RelatedProcessIds.Contains($processIdValue)) { return 'harness-related' }
    if ($AdditionalProcessId -contains $processIdValue) { return 'additional' }
    return $null
}

function Get-RelatedProcessIds {
    param(
        [Parameter(Mandatory = $true)][object[]]$CimProcesses,
        [Parameter(Mandatory = $true)][int]$GatewayOwnerProcessId
    )

    $ids = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($additionalId in $AdditionalProcessId) {
        if ($additionalId -gt 0) { [void]$ids.Add($additionalId) }
    }
    if ($GatewayOwnerProcessId -le 0) { return ,$ids }

    [void]$ids.Add($GatewayOwnerProcessId)
    $current = $GatewayOwnerProcessId
    for ($depth = 0; $depth -lt 2; $depth++) {
        $row = $CimProcesses | Where-Object { [int]$_.ProcessId -eq $current } | Select-Object -First 1
        if ($null -eq $row -or [int]$row.ParentProcessId -le 0) { break }
        $current = [int]$row.ParentProcessId
        [void]$ids.Add($current)
    }

    for ($depth = 0; $depth -lt 3; $depth++) {
        $parents = @($ids)
        foreach ($row in $CimProcesses) {
            if ($parents -contains [int]$row.ParentProcessId) {
                [void]$ids.Add([int]$row.ProcessId)
            }
        }
    }
    return ,$ids
}

$resilienceResults = @()
if (-not $SkipResilienceChecks) {
    Write-Host 'Running existing reconnect and diagnostic checks...'
    $resilienceResults += Invoke-ExistingCheck -Name 'Build existing platform resilience dependencies' -Arguments @(
        '--filter', '@ai-native-game-harness/platform-tests...', 'build'
    )
    $resilienceResults += Invoke-ExistingCheck -Name 'Adapter disconnect and reconnect' -Arguments @(
        '--filter', '@ai-native-game-harness/platform-tests', 'exec', 'vitest', 'run', 'platform.test.ts',
        '-t', 'runs remote observe, action, events and reconnect over WebSocket'
    )
    $resilienceResults += Invoke-ExistingCheck -Name 'Failure diagnostics classification' -Arguments @(
        '--filter', '@ai-native-game-harness/integration-tests', 'exec', 'vitest', 'run', 'diagnostics.test.ts'
    )
    if ($Game -eq 'oni') {
        $resilienceResults += Invoke-ExistingCheck -Name 'Build existing ONI resilience dependencies' -Arguments @(
            '--filter', '@qimidandapigu/oni-adapter...', 'build'
        )
        $resilienceResults += Invoke-ExistingCheck -Name 'ONI timeout, rejection and bridge reconnect' -Arguments @(
            '--filter', '@qimidandapigu/oni-adapter', 'exec', 'vitest', 'run', 'adapter.test.ts',
            '-t', 'rejects stale revisions, unavailable actions, bridge rejection, and timeout deterministically|reports fake bridge disconnect and reconnect without launching ONI'
        )
    }
}

$plannedSeconds = if ($DurationSeconds -gt 0) { $DurationSeconds } else { $DurationMinutes * 60 }
$deadline = $startedAt.AddSeconds($plannedSeconds)
$cpuState = @{}
$roleSamples = [System.Collections.Generic.List[object]]::new()
$lastRolePids = @{}
$roleChanges = @{}
$sampleCount = 0
$gatewayHealthySamples = 0
$gatewayEstablishedSamples = 0
$seenGame = $false
$lastGatewayListening = $null

Write-RunEvent -Type 'run.started' -Detail @{
    runId = $runId
    game = $Game
    plannedSeconds = $plannedSeconds
    sampleIntervalSeconds = $SampleIntervalSeconds
    gatewayPort = $GatewayPort
}

Write-Host "Collecting local stability data for $plannedSeconds seconds."
Write-Host "Output: $runDirectory"

while ((Get-Date) -lt $deadline) {
    $sampleAt = Get-Date
    $gateway = Get-GatewaySnapshot
    $sampleCount++
    if ($gateway.listening) { $gatewayHealthySamples++ }
    if ($gateway.establishedConnections -gt 0) { $gatewayEstablishedSamples++ }

    if ($null -eq $lastGatewayListening -or $lastGatewayListening -ne $gateway.listening) {
        Write-RunEvent -Type 'gateway.state' -Detail @{
            listening = $gateway.listening
            ownerProcessId = $gateway.ownerProcessId
            establishedConnections = $gateway.establishedConnections
        }
        $lastGatewayListening = $gateway.listening
    }

    $cimProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $relatedIds = Get-RelatedProcessIds -CimProcesses $cimProcesses -GatewayOwnerProcessId $gateway.ownerProcessId
    $sampleRows = [System.Collections.Generic.List[object]]::new()

    foreach ($cimProcess in $cimProcesses) {
        $role = Get-ProcessRole -CimProcess $cimProcess -RelatedProcessIds $relatedIds
        if ($null -eq $role) { continue }
        $processIdValue = [int]$cimProcess.ProcessId
        try {
            $process = Get-Process -Id $processIdValue -ErrorAction Stop
            $cpuSeconds = if ($null -eq $process.CPU) { 0.0 } else { [double]$process.CPU }
            $cpuPercent = 0.0
            if ($cpuState.ContainsKey($processIdValue)) {
                $previous = $cpuState[$processIdValue]
                $elapsed = ($sampleAt - $previous.at).TotalSeconds
                if ($elapsed -gt 0) {
                    $cpuPercent = (($cpuSeconds - $previous.cpuSeconds) / $elapsed / [Environment]::ProcessorCount) * 100
                    if ($cpuPercent -lt 0) { $cpuPercent = 0 }
                }
            }
            $cpuState[$processIdValue] = [pscustomobject]@{ at = $sampleAt; cpuSeconds = $cpuSeconds }

            $row = [pscustomobject][ordered]@{
                Timestamp = $sampleAt.ToUniversalTime().ToString('o')
                Role = $role
                Name = [string]$process.ProcessName
                ProcessId = $processIdValue
                CpuPercent = [Math]::Round($cpuPercent, 2)
                WorkingSetMB = [Math]::Round($process.WorkingSet64 / 1MB, 2)
                PrivateMemoryMB = [Math]::Round($process.PrivateMemorySize64 / 1MB, 2)
                HandleCount = $process.HandleCount
                ThreadCount = $process.Threads.Count
                GatewayListening = $gateway.listening
                GatewayEstablishedConnections = $gateway.establishedConnections
            }
            $sampleRows.Add($row)
            $row | Export-Csv -LiteralPath $metricsPath -Append -NoTypeInformation -Encoding UTF8
            if ($role -eq 'game') { $seenGame = $true }
        }
        catch {
            Write-RunEvent -Type 'process.sample-failed' -Detail @{ processId = $processIdValue; message = $_.Exception.Message }
        }
    }

    foreach ($group in ($sampleRows | Group-Object Role)) {
        $workingSet = ($group.Group | Measure-Object WorkingSetMB -Sum).Sum
        $privateMemory = ($group.Group | Measure-Object PrivateMemoryMB -Sum).Sum
        $handles = ($group.Group | Measure-Object HandleCount -Sum).Sum
        $roleSamples.Add([pscustomobject]@{
            Timestamp = $sampleAt
            Role = $group.Name
            WorkingSetMB = [double]$workingSet
            PrivateMemoryMB = [double]$privateMemory
            HandleCount = [int]$handles
        })

        $currentPids = (($group.Group | Select-Object -ExpandProperty ProcessId | Sort-Object) -join ',')
        if ($lastRolePids.ContainsKey($group.Name) -and $lastRolePids[$group.Name] -ne $currentPids) {
            if (-not $roleChanges.ContainsKey($group.Name)) { $roleChanges[$group.Name] = 0 }
            $roleChanges[$group.Name]++
            Write-RunEvent -Type 'process-set.changed' -Detail @{ role = $group.Name; before = $lastRolePids[$group.Name]; after = $currentPids }
        }
        $lastRolePids[$group.Name] = $currentPids
    }

    $remaining = ($deadline - (Get-Date)).TotalSeconds
    if ($remaining -le 0) { break }
    Start-Sleep -Seconds ([Math]::Min($SampleIntervalSeconds, [Math]::Ceiling($remaining)))
}

$endedAt = Get-Date
$roleSummary = @()
foreach ($group in ($roleSamples | Group-Object Role)) {
    $ordered = @($group.Group | Sort-Object Timestamp)
    $first = $ordered[0]
    $last = $ordered[-1]
    $peakWorkingSet = ($ordered | Measure-Object WorkingSetMB -Maximum).Maximum
    $roleSummary += [pscustomobject][ordered]@{
        role = $group.Name
        samples = $ordered.Count
        firstWorkingSetMB = [Math]::Round($first.WorkingSetMB, 2)
        lastWorkingSetMB = [Math]::Round($last.WorkingSetMB, 2)
        growthMB = [Math]::Round($last.WorkingSetMB - $first.WorkingSetMB, 2)
        peakWorkingSetMB = [Math]::Round([double]$peakWorkingSet, 2)
        peakHandleCount = [int](($ordered | Measure-Object HandleCount -Maximum).Maximum)
        processSetChanges = if ($roleChanges.ContainsKey($group.Name)) { [int]$roleChanges[$group.Name] } else { 0 }
    }
}

$issues = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$failedChecks = @($resilienceResults | Where-Object { -not $_.passed })
if ($failedChecks.Count -gt 0) { $issues.Add('One or more existing resilience checks failed.') }
if (-not $SkipGatewayRequirement) {
    if ($gatewayHealthySamples -eq 0) { $issues.Add("Gateway port $GatewayPort was never observed listening.") }
    elseif (-not [bool]$lastGatewayListening) { $issues.Add("Gateway port $GatewayPort was not listening at the end of the run.") }
    if ($gatewayEstablishedSamples -eq 0) { $issues.Add('No established Adapter connection was observed.') }
}
if (-not $SkipGameRequirement -and -not $seenGame) { $issues.Add("No process for the selected game '$Game' was observed.") }

foreach ($role in $roleSummary) {
    $growthLimit = [Math]::Max(256, $role.firstWorkingSetMB * 0.5)
    if ($role.samples -ge 5 -and $role.growthMB -gt $growthLimit) {
        $warnings.Add("$($role.role) working set grew by $($role.growthMB) MB; inspect the CSV before release.")
    }
}

$verdict = if ($issues.Count -gt 0) { 'failed' } elseif ($warnings.Count -gt 0) { 'warning' } else { 'passed' }
$availability = if ($sampleCount -eq 0) { 0 } else { [Math]::Round(($gatewayHealthySamples / $sampleCount) * 100, 2) }
$summary = [ordered]@{
    schemaVersion = 1
    runId = $runId
    game = $Game
    startedAt = $startedAt.ToUniversalTime().ToString('o')
    endedAt = $endedAt.ToUniversalTime().ToString('o')
    durationSeconds = [Math]::Round(($endedAt - $startedAt).TotalSeconds, 2)
    verdict = $verdict
    sampling = [ordered]@{
        samples = $sampleCount
        intervalSeconds = $SampleIntervalSeconds
        gatewayPort = $GatewayPort
        gatewayAvailabilityPercent = $availability
        samplesWithAdapterConnection = $gatewayEstablishedSamples
        selectedGameSeen = $seenGame
    }
    resilienceChecks = @($resilienceResults)
    processes = @($roleSummary)
    issues = @($issues)
    warnings = @($warnings)
    evidence = [ordered]@{
        metrics = $metricsPath
        events = $eventsPath
        resilienceChecks = $checksPath
    }
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

$reportLines = @(
    'AI Native Game Harness - Lightweight Stability Report',
    "Run: $runId",
    "Game: $Game",
    "Verdict: $verdict",
    "Gateway availability: $availability%",
    "Samples with Adapter connection: $gatewayEstablishedSamples / $sampleCount",
    "Selected game seen: $seenGame",
    '',
    'Process summary:'
)
foreach ($role in $roleSummary) {
    $reportLines += "- $($role.role): first $($role.firstWorkingSetMB) MB, last $($role.lastWorkingSetMB) MB, peak $($role.peakWorkingSetMB) MB, growth $($role.growthMB) MB, process-set changes $($role.processSetChanges)"
}
$reportLines += ''
$reportLines += 'Issues:'
if ($issues.Count -eq 0) { $reportLines += '- none' } else { $reportLines += @($issues | ForEach-Object { "- $_" }) }
$reportLines += 'Warnings:'
if ($warnings.Count -eq 0) { $reportLines += '- none' } else { $reportLines += @($warnings | ForEach-Object { "- $_" }) }
$reportLines += ''
$reportLines += "Full JSON: $summaryPath"
$reportLines | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-RunEvent -Type 'run.completed' -Detail @{ verdict = $verdict; summary = $summaryPath }
Write-Host "Completed: $verdict"
Write-Host "Report: $reportPath"

if ($verdict -eq 'failed') { exit 1 }
exit 0
