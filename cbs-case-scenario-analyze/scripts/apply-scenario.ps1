# 强制 UTF-8 输出，避免 bun stderr 中文在 PowerShell 控制台乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Plan,

    [Parameter(Mandatory = $true)]
    [string] $OutReport,

    [Parameter(Mandatory = $false)]
    [string] $OutResult,

    [Parameter(Mandatory = $false)]
    [string] $GbrainExecutable = 'gbrain'
)

$ErrorActionPreference = 'Stop'

$bun = Get-Command bun -ErrorAction Stop
$applier = Join-Path $PSScriptRoot 'apply-scenario.ts'
if (-not (Test-Path -LiteralPath $applier -PathType Leaf)) {
    throw "Applier not found: $applier"
}

$resolvedPlan = Resolve-Path -LiteralPath $Plan -ErrorAction Stop
$absoluteOutReport = [System.IO.Path]::GetFullPath($OutReport)
$reportDirectory = Split-Path -Parent $absoluteOutReport
if ($reportDirectory -and -not (Test-Path -LiteralPath $reportDirectory)) {
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
}

$arguments = @(
    $applier,
    '--plan', $resolvedPlan.Path,
    '--out-report', $absoluteOutReport,
    '--gbrain', $GbrainExecutable
)

if ($OutResult) {
    $absoluteOutResult = [System.IO.Path]::GetFullPath($OutResult)
    $resultDirectory = Split-Path -Parent $absoluteOutResult
    if ($resultDirectory -and -not (Test-Path -LiteralPath $resultDirectory)) {
        New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
    }
    $arguments += @('--out-result', $absoluteOutResult)
}

& $bun.Source @arguments
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    $outputState = if (Test-Path -LiteralPath $absoluteOutReport -PathType Leaf) { "partial_output=$absoluteOutReport" } else { 'no_report_generated' }
    [Console]::Error.WriteLine("CBS_SCENARIO_APPLY_STOPPED exit=$exitCode $outputState. STOP; do not modify Skill or auto-retry.")
    exit $exitCode
}

if (-not (Test-Path -LiteralPath $absoluteOutReport -PathType Leaf)) {
    [Console]::Error.WriteLine('CBS_SCENARIO_APPLY_OUTPUT_MISSING. Check errors above.')
    exit 2
}

Write-Output $absoluteOutReport
