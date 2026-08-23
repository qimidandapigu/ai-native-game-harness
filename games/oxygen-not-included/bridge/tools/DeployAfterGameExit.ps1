param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$ModsJson,
    [Parameter(Mandatory = $true)][string]$ReadmePath,
    [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = 'Stop'
$process = Get-Process OxygenNotIncluded -ErrorAction SilentlyContinue
if ($null -ne $process) {
    $process | Wait-Process
}

$files = @('DoubaoAI.ONI.dll', 'DoubaoAI.ONI.pdb', 'mod.yaml', 'mod_info.yaml', 'config.template.json')
$lastError = $null
for ($attempt = 1; $attempt -le 30; $attempt++) {
    try {
        Start-Sleep -Milliseconds 500
        foreach ($name in $files) {
            Copy-Item -LiteralPath (Join-Path $SourceDir $name) -Destination (Join-Path $InstallDir $name) -Force
        }
        Copy-Item -LiteralPath $ReadmePath -Destination (Join-Path $InstallDir 'README.md') -Force
        $lastError = $null
        break
    }
    catch {
        $lastError = $_.Exception.Message
    }
}

if ($null -ne $lastError) {
    [System.IO.File]::WriteAllText($LogPath, "FAILED: $lastError", (New-Object System.Text.UTF8Encoding($false)))
    exit 1
}

if (Test-Path -LiteralPath $ModsJson) {
    $data = Get-Content -Raw -Encoding UTF8 -LiteralPath $ModsJson | ConvertFrom-Json
    $entry = $data.mods | Where-Object {
        $_.staticID -eq 'qimidandapigu.DoubaoAI.ONI' -or $_.label.id -eq 'DoubaoAI'
    } | Select-Object -First 1
    if ($null -ne $entry) {
        $entry.enabled = $true
        [System.IO.File]::WriteAllText($ModsJson, ($data | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
    }
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $InstallDir 'DoubaoAI.ONI.dll')).Hash
[System.IO.File]::WriteAllText($LogPath, "SUCCESS $([DateTime]::Now.ToString('s')) $hash", (New-Object System.Text.UTF8Encoding($false)))
