$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $projectRoot 'dist'
$buildDirectory = Join-Path $distRoot 'player-build'
$releaseDirectory = Join-Path $distRoot 'dont-starve-ai-mod-player'
$zipPath = Join-Path $distRoot 'dont-starve-ai-mod-player.zip'
$jinglingAnimationPath = Join-Path $projectRoot 'game-mod\anim\jingling.zip'
$modInfo = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'game-mod\modinfo.lua')
$versionMatch = [regex]::Match($modInfo, '(?m)^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"')
if (-not $versionMatch.Success) {
    throw 'Could not read the release version from game-mod\modinfo.lua.'
}
$releaseAssetPath = Join-Path $distRoot "dsh-xiaotangyuan-game-dont-starve-$($versionMatch.Groups[1].Value).zip"

if (-not (Test-Path -LiteralPath $jinglingAnimationPath -PathType Leaf)) {
    throw 'Missing compiled Jingling animation: game-mod\anim\jingling.zip. Compile game-mod\anim_source\jingling\jingling.scml with the Klei SCML compiler before building.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$animationArchive = [System.IO.Compression.ZipFile]::OpenRead($jinglingAnimationPath)
try {
    $animationEntries = @($animationArchive.Entries | ForEach-Object { $_.FullName })
} finally {
    $animationArchive.Dispose()
}
$requiredAnimationEntries = @('anim.bin', 'build.bin')
$missingAnimationEntries = @($requiredAnimationEntries | Where-Object { $_ -notin $animationEntries })
if ($missingAnimationEntries.Count -gt 0) {
    throw "Invalid Jingling animation archive; missing: $($missingAnimationEntries -join ', ')."
}

function Reset-DistDirectory([string]$Path) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $allowedRoot = [System.IO.Path]::GetFullPath($distRoot) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to reset a directory outside dist: $fullPath"
    }
    if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
}

Reset-DistDirectory $buildDirectory
Reset-DistDirectory $releaseDirectory

$buildScript = Join-Path $PSScriptRoot 'build-launcher.ps1'
& $buildScript -OutputDirectory $buildDirectory
if ($LASTEXITCODE -ne 0) {
    throw 'Player launcher build failed.'
}

Copy-Item -LiteralPath (Join-Path $buildDirectory 'ChesterAI.exe') `
    -Destination (Join-Path $releaseDirectory '安装切斯特AI.exe') -Force
Copy-Item -LiteralPath (Join-Path $buildDirectory '.env.example') `
    -Destination (Join-Path $releaseDirectory '.env.example') -Force
Compress-Archive -Path (Join-Path $releaseDirectory '*') `
    -DestinationPath $zipPath -CompressionLevel Optimal -Force
Copy-Item -LiteralPath $zipPath -Destination $releaseAssetPath -Force
Write-Host "Built player package: $zipPath"
Write-Host "Built Harness release asset: $releaseAssetPath"
