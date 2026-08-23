param(
    [Parameter(Mandatory = $true)][string]$StardewMaster,
    [Parameter(Mandatory = $true)][string]$DstMaster,
    [Parameter(Mandatory = $true)][string]$OniMaster
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$pngCodec = [System.Drawing.Imaging.ImageFormat]::Png

function New-ArgbBitmap([int]$width, [int]$height) {
    return [System.Drawing.Bitmap]::new(
        $width,
        $height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
}

function Get-VisibleBounds([System.Drawing.Bitmap]$image, [System.Drawing.Rectangle]$region) {
    $columnCounts = [int[]]::new($region.Width)
    $rowCounts = [int[]]::new($region.Height)
    for ($y = $region.Top; $y -lt $region.Bottom; $y++) {
        for ($x = $region.Left; $x -lt $region.Right; $x++) {
            if ($image.GetPixel($x, $y).A -gt 16) {
                $columnCounts[$x - $region.Left]++
                $rowCounts[$y - $region.Top]++
            }
        }
    }

    # Generated references can contain isolated colored specks. The pet itself is
    # the largest continuous run of populated rows/columns, so ignore detached runs.
    $xRun = Get-LargestPopulatedRun $columnCounts
    $yRun = Get-LargestPopulatedRun $rowCounts
    if ($null -eq $xRun -or $null -eq $yRun) {
        throw "No visible pixels found in region $region"
    }
    return [System.Drawing.Rectangle]::new(
        $region.Left + $xRun.Start,
        $region.Top + $yRun.Start,
        $xRun.Length,
        $yRun.Length
    )
}

function Get-LargestPopulatedRun([int[]]$counts) {
    $bestStart = -1
    $bestLength = 0
    $runStart = -1
    for ($index = 0; $index -le $counts.Length; $index++) {
        $populated = $index -lt $counts.Length -and $counts[$index] -gt 2
        if ($populated -and $runStart -lt 0) {
            $runStart = $index
        }
        if (-not $populated -and $runStart -ge 0) {
            $length = $index - $runStart
            if ($length -gt $bestLength) {
                $bestStart = $runStart
                $bestLength = $length
            }
            $runStart = -1
        }
    }
    if ($bestStart -lt 0) { return $null }
    return [pscustomobject]@{ Start = $bestStart; Length = $bestLength }
}

function Get-Quadrants([System.Drawing.Bitmap]$image) {
    $halfW = [int]($image.Width / 2)
    $halfH = [int]($image.Height / 2)
    return @{
        Front = Get-VisibleBounds $image ([System.Drawing.Rectangle]::new(0, 0, $halfW, $halfH))
        Back  = Get-VisibleBounds $image ([System.Drawing.Rectangle]::new($halfW, 0, $image.Width - $halfW, $halfH))
        Left  = Get-VisibleBounds $image ([System.Drawing.Rectangle]::new(0, $halfH, $halfW, $image.Height - $halfH))
        Right = Get-VisibleBounds $image ([System.Drawing.Rectangle]::new($halfW, $halfH, $image.Width - $halfW, $image.Height - $halfH))
    }
}

function Draw-Fitted(
    [System.Drawing.Graphics]$graphics,
    [System.Drawing.Bitmap]$source,
    [System.Drawing.Rectangle]$sourceRect,
    [System.Drawing.Rectangle]$targetRect,
    [bool]$nearest = $false
) {
    $scale = [Math]::Min($targetRect.Width / $sourceRect.Width, $targetRect.Height / $sourceRect.Height)
    $width = [Math]::Max(1, [int][Math]::Round($sourceRect.Width * $scale))
    $height = [Math]::Max(1, [int][Math]::Round($sourceRect.Height * $scale))
    $x = $targetRect.X + [int](($targetRect.Width - $width) / 2)
    $y = $targetRect.Bottom - $height
    if ($nearest) {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    } else {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    }
    $graphics.DrawImage(
        $source,
        [System.Drawing.Rectangle]::new($x, $y, $width, $height),
        $sourceRect,
        [System.Drawing.GraphicsUnit]::Pixel
    )
}

function Save-Bitmap([System.Drawing.Bitmap]$bitmap, [string]$path) {
    $directory = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory | Out-Null
    }
    $bitmap.Save($path, $pngCodec)
}

function Remove-ConnectedNeutralBackground([System.Drawing.Bitmap]$source) {
    $result = New-ArgbBitmap $source.Width $source.Height
    $graphics = [System.Drawing.Graphics]::FromImage($result)
    try { $graphics.DrawImageUnscaled($source, 0, 0) } finally { $graphics.Dispose() }

    $width = $result.Width
    $height = $result.Height
    $visited = [bool[]]::new($width * $height)
    $queue = [System.Collections.Generic.Queue[int]]::new()
    for ($x = 0; $x -lt $width; $x++) {
        $queue.Enqueue($x)
        $queue.Enqueue(($height - 1) * $width + $x)
    }
    for ($y = 1; $y -lt $height - 1; $y++) {
        $queue.Enqueue($y * $width)
        $queue.Enqueue($y * $width + $width - 1)
    }

    while ($queue.Count -gt 0) {
        $index = $queue.Dequeue()
        if ($visited[$index]) { continue }
        $visited[$index] = $true
        $x = $index % $width
        $y = [int][Math]::Floor($index / [double]$width)
        $color = $result.GetPixel($x, $y)
        $maximum = [Math]::Max($color.R, [Math]::Max($color.G, $color.B))
        $minimum = [Math]::Min($color.R, [Math]::Min($color.G, $color.B))
        # The supplied Stardew sheet has an opaque neutral-black canvas. Only
        # flood-fill neutral dark pixels connected to the outer canvas, keeping
        # the enclosed black eyes and mouth intact.
        if ($maximum -gt 80 -or $maximum - $minimum -gt 8) { continue }

        $result.SetPixel($x, $y, [System.Drawing.Color]::Transparent)
        if ($x -gt 0) { $queue.Enqueue($index - 1) }
        if ($x + 1 -lt $width) { $queue.Enqueue($index + 1) }
        if ($y -gt 0) { $queue.Enqueue($index - $width) }
        if ($y + 1 -lt $height) { $queue.Enqueue($index + $width) }
    }
    return $result
}

function Write-FourFrameStrip(
    [string]$masterPath,
    [string]$stripPath,
    [string]$iconPath,
    [bool]$nearest,
    [int]$frameSize = 32,
    [int]$iconSize = 16,
    [bool]$removeNeutralBackground = $false
) {
    $loaded = [System.Drawing.Bitmap]::new($masterPath)
    $source = if ($removeNeutralBackground) { Remove-ConnectedNeutralBackground $loaded } else { $loaded }
    if ($source -ne $loaded) { $loaded.Dispose() }
    try {
        $views = Get-Quadrants $source
        # Companion content uses DRUL: front/down, right, back/up, left.
        $order = @('Front', 'Right', 'Back', 'Left')
        $strip = New-ArgbBitmap ($frameSize * 4) $frameSize
        try {
            $g = [System.Drawing.Graphics]::FromImage($strip)
            try {
                $g.Clear([System.Drawing.Color]::Transparent)
                $padding = if ($frameSize -le 32) { 1 } else { 8 }
                $contentSize = $frameSize - $padding * 2
                for ($index = 0; $index -lt $order.Count; $index++) {
                    Draw-Fitted $g $source $views[$order[$index]] ([System.Drawing.Rectangle]::new($index * $frameSize + $padding, $padding, $contentSize, $contentSize)) $nearest
                }
            } finally { $g.Dispose() }
            Save-Bitmap $strip $stripPath
        } finally { $strip.Dispose() }

        $icon = New-ArgbBitmap $iconSize $iconSize
        try {
            $g = [System.Drawing.Graphics]::FromImage($icon)
            try {
                $g.Clear([System.Drawing.Color]::Transparent)
                $iconPadding = if ($iconSize -le 16) { 1 } else { 2 }
                Draw-Fitted $g $source $views.Front ([System.Drawing.Rectangle]::new($iconPadding, $iconPadding, $iconSize - $iconPadding * 2, $iconSize - $iconPadding * 2)) $nearest
            } finally { $g.Dispose() }
            Save-Bitmap $icon $iconPath
        } finally { $icon.Dispose() }
    } finally { $source.Dispose() }
}

function Normalize-StardewFrontMouth([string]$stripPath) {
    $source = [System.Drawing.Bitmap]::new($stripPath)
    try {
        $result = [System.Drawing.Bitmap]::new($source)
        try {
            # A two-pixel feature cannot sit on the 15.5 frame centre without
            # explicit pixel placement. Normalize the directly rendered result
            # to a centred, even-colour 2x1 mouth at x=15..16.
            $faceColor = $result.GetPixel(13, 19)
            $mouthColor = $result.GetPixel(14, 19)
            $result.SetPixel(14, 19, $faceColor)
            $result.SetPixel(15, 19, $mouthColor)
            $result.SetPixel(16, 19, $mouthColor)
            $temporary = "$stripPath.normalized.png"
            Save-Bitmap $result $temporary
        } finally { $result.Dispose() }
    } finally { $source.Dispose() }
    Move-Item -LiteralPath "$stripPath.normalized.png" -Destination $stripPath -Force
}

function Write-DstAssets([string]$masterPath) {
    $source = [System.Drawing.Bitmap]::new($masterPath)
    try {
        $views = Get-Quadrants $source
        $sourceDir = Join-Path $repoRoot 'games/dont-starve-together/game-mod/anim_source/jingling'
        foreach ($name in @('Front', 'Back', 'Left', 'Right')) {
            $frame = New-ArgbBitmap 222 444
            try {
                $g = [System.Drawing.Graphics]::FromImage($frame)
                try {
                    $g.Clear([System.Drawing.Color]::Transparent)
                    # Align the source's own ground shadow with the SCML pivot
                    # (8% above the bottom of the 444px canvas).
                    Draw-Fitted $g $source $views[$name] ([System.Drawing.Rectangle]::new(4, 194, 214, 214)) $false
                } finally { $g.Dispose() }
                Save-Bitmap $frame (Join-Path $sourceDir ("jingling_{0}.png" -f $name.ToLowerInvariant()))
                if ($name -eq 'Front') {
                    Save-Bitmap $frame (Join-Path $sourceDir 'jingling_blink.png')
                }
            } finally { $frame.Dispose() }
        }

        $imagesDir = Join-Path $repoRoot 'games/dont-starve-together/game-mod/images'
        Copy-Item -LiteralPath $masterPath -Destination (Join-Path $imagesDir 'jingling.png') -Force

        $sheet = New-ArgbBitmap 888 222
        try {
            $g = [System.Drawing.Graphics]::FromImage($sheet)
            try {
                $g.Clear([System.Drawing.Color]::Transparent)
                $order = @('Front', 'Right', 'Back', 'Left')
                for ($index = 0; $index -lt $order.Count; $index++) {
                    $framePath = Join-Path $sourceDir ("jingling_{0}.png" -f $order[$index].ToLowerInvariant())
                    $previewFrame = [System.Drawing.Bitmap]::new($framePath)
                    try {
                        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                        $g.DrawImage(
                            $previewFrame,
                            [System.Drawing.Rectangle]::new($index * 222, 0, 222, 222),
                            [System.Drawing.Rectangle]::new(0, 190, 222, 222),
                            [System.Drawing.GraphicsUnit]::Pixel
                        )
                    } finally { $previewFrame.Dispose() }
                }
            } finally { $g.Dispose() }
            Save-Bitmap $sheet (Join-Path $imagesDir 'jingling-sprite-sheet.png')

            $chroma = New-ArgbBitmap 888 222
            try {
                $g = [System.Drawing.Graphics]::FromImage($chroma)
                try {
                    $g.Clear([System.Drawing.Color]::FromArgb(0, 255, 0))
                    $g.DrawImageUnscaled($sheet, 0, 0)
                } finally { $g.Dispose() }
                Save-Bitmap $chroma (Join-Path $imagesDir 'jingling-sprite-sheet-chroma.png')
            } finally { $chroma.Dispose() }
        } finally { $sheet.Dispose() }

        $face = New-ArgbBitmap 150 125
        try {
            $g = [System.Drawing.Graphics]::FromImage($face)
            try {
                $g.Clear([System.Drawing.Color]::Transparent)
                Draw-Fitted $g $source $views.Front ([System.Drawing.Rectangle]::new(2, 2, 146, 121)) $false
            } finally { $g.Dispose() }
            Save-Bitmap $face (Join-Path $imagesDir 'jingling-face-reference.png')
        } finally { $face.Dispose() }
    } finally { $source.Dispose() }
}

$stardewStrip = Join-Path $repoRoot 'games/stardew-valley/content-pack/XiaoTangYuanCompanion/assets/xiaotangyuan_companion.png'
$stardewIcon = Join-Path $repoRoot 'games/stardew-valley/content-pack/XiaoTangYuanCompanion/assets/xiaotangyuan_icon.png'
Write-FourFrameStrip $StardewMaster $stardewStrip $stardewIcon $true 32 16 $true
Normalize-StardewFrontMouth $stardewStrip

Write-DstAssets $DstMaster

$oniStrip = Join-Path $repoRoot 'games/oxygen-not-included/bridge/assets/doubao_companion.png'
$oniIcon = Join-Path $repoRoot 'games/oxygen-not-included/bridge/assets/doubao_t.png'
Write-FourFrameStrip $OniMaster $oniStrip $oniIcon $false 512 128 $false

Write-Host 'Companion assets rendered successfully.'
