param(
    [string]$JavaHome = "",
    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceRoot = Join-Path $Root "src"
if (-not $OutDir) {
    $OutDir = Join-Path $Root "dist"
}
$BuildRoot = Join-Path $OutDir "build"
$ClassesDir = Join-Path $BuildRoot "classes"
$ManifestPath = Join-Path $BuildRoot "MANIFEST.MF"
$JarPath = Join-Path $OutDir "catvod-runtime-bridge.jar"

function Resolve-Tool {
    param(
        [string]$Name,
        [string]$JavaHomeValue
    )

    if ($JavaHomeValue) {
        $Candidate = Join-Path $JavaHomeValue ("bin\" + $Name + ".exe")
        if (Test-Path -LiteralPath $Candidate) {
            return $Candidate
        }
    }

    $Command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($Command) {
        return $Command.Source
    }

    $CommonRoots = @(
        "C:\Program Files\Microsoft",
        "C:\Program Files\Java",
        "C:\Program Files\Eclipse Adoptium",
        "C:\Program Files\Zulu"
    )
    foreach ($RootPath in $CommonRoots) {
        if (-not (Test-Path -LiteralPath $RootPath)) {
            continue
        }
        $Candidate = Get-ChildItem -LiteralPath $RootPath -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "jdk|openjdk|temurin|zulu" } |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName ("bin\" + $Name + ".exe") } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
        if ($Candidate) {
            return $Candidate
        }
    }

    throw "$Name was not found. Install a JDK and make sure javac and jar are available, or pass -JavaHome."
}

$Javac = Resolve-Tool -Name "javac" -JavaHomeValue $JavaHome
$Jar = Resolve-Tool -Name "jar" -JavaHomeValue $JavaHome

Remove-Item -LiteralPath $BuildRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ClassesDir | Out-Null
New-Item -ItemType Directory -Force $OutDir | Out-Null

$Sources = @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -Filter *.java | ForEach-Object { $_.FullName })
if (-not $Sources -or $Sources.Count -eq 0) {
    throw "No Java sources found under $SourceRoot"
}

& $Javac -encoding UTF-8 -d $ClassesDir @Sources
if ($LASTEXITCODE -ne 0) {
    throw "javac failed with exit code $LASTEXITCODE"
}

@"
Manifest-Version: 1.0
Main-Class: com.dongguatv.bridge.CatvodRuntimeBridge

"@ | Set-Content -LiteralPath $ManifestPath -Encoding ASCII

& $Jar cfm $JarPath $ManifestPath -C $ClassesDir .
if ($LASTEXITCODE -ne 0) {
    throw "jar failed with exit code $LASTEXITCODE"
}

Write-Host "Built $JarPath"
