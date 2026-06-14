param(
    [string]$JavaHome = "",
    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceRoot = Join-Path $Root "src"
$BuildRoot = Join-Path $Root "build"
if (-not $OutDir) {
    $OutDir = Join-Path $Root "dist"
}
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

    throw "$Name was not found. Install a JDK and make sure javac and jar are available, or pass -JavaHome."
}

$Javac = Resolve-Tool -Name "javac" -JavaHomeValue $JavaHome
$Jar = Resolve-Tool -Name "jar" -JavaHomeValue $JavaHome

Remove-Item -LiteralPath $BuildRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ClassesDir | Out-Null
New-Item -ItemType Directory -Force $OutDir | Out-Null

$Sources = Get-ChildItem -LiteralPath $SourceRoot -Recurse -Filter *.java | ForEach-Object { $_.FullName }
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
