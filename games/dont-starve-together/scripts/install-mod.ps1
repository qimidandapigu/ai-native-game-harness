param(
    [string]$GameDir = $env:DST_GAME_DIR
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'game-mod'

function Find-DstGameDirectory {
    $steamRoots = @()
    $steamKey = Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue
    if ($steamKey.SteamPath) {
        $steamRoots += $steamKey.SteamPath
    }
    $steamRoots += @(
        'C:\Program Files (x86)\Steam',
        'C:\Program Files\Steam',
        'D:\SteamLibrary',
        'E:\Steam',
        'F:\SteamLibrary'
    )

    $libraries = @($steamRoots)
    foreach ($root in $steamRoots | Select-Object -Unique) {
        $vdf = Join-Path $root 'steamapps\libraryfolders.vdf'
        if (Test-Path -LiteralPath $vdf) {
            $text = Get-Content -Raw -LiteralPath $vdf
            foreach ($match in [regex]::Matches($text, '"path"\s+"([^"]+)"')) {
                $libraries += $match.Groups[1].Value.Replace('\\', '\')
            }
        }
    }

    foreach ($library in $libraries | Select-Object -Unique) {
        $candidate = Join-Path $library "steamapps\common\Don't Starve Together"
        if (Test-Path -LiteralPath (Join-Path $candidate 'data\databundles\scripts.zip')) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

if (-not $GameDir) {
    $GameDir = Find-DstGameDirectory
}
if (-not $GameDir -or -not (Test-Path -LiteralPath $GameDir)) {
    throw 'Could not locate Don''t Starve Together. Pass -GameDir or set DST_GAME_DIR.'
}

$destination = Join-Path $GameDir 'mods\dont-starve-ai-mod'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'modinfo.lua') -Destination $destination -Force
Copy-Item -LiteralPath (Join-Path $source 'modmain.lua') -Destination $destination -Force

Write-Host "Installed Don't Starve AI Mod to: $destination"
Write-Host "Enable it from the in-game Mods menu before entering a world."
