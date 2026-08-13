# 强制 UTF-8 输出，避免 bun stderr 中文在 PowerShell 控制台乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $DryRunPlanPath,

    [Parameter(Mandatory = $true)]
    [string] $OutPlan
)

$ErrorActionPreference = 'Stop'

$bun = Get-Command bun -ErrorAction Stop
$authorizer = Join-Path $PSScriptRoot 'authorize-scenario-plan.ts'
if (-not (Test-Path -LiteralPath $authorizer -PathType Leaf)) {
    throw "Authorizer not found: $authorizer"
}

$resolvedDryRun = Resolve-Path -LiteralPath $DryRunPlanPath -ErrorAction Stop
$absoluteOut = [System.IO.Path]::GetFullPath($OutPlan)
$outDirectory = Split-Path -Parent $absoluteOut
if ($outDirectory -and -not (Test-Path -LiteralPath $outDirectory)) {
    New-Item -ItemType Directory -Path $outDirectory -Force | Out-Null
}
if (Test-Path -LiteralPath $absoluteOut -PathType Leaf) {
    Remove-Item -LiteralPath $absoluteOut -Force
}

$arguments = @(
    $authorizer,
    '--plan', $resolvedDryRun.Path,
    '--out', $absoluteOut
)

& $bun.Source @arguments
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    $outputState = if (Test-Path -LiteralPath $absoluteOut -PathType Leaf) { "partial_output=$absoluteOut" } else { 'no_authorized_plan_generated' }
    [Console]::Error.WriteLine("CBS_SCENARIO_AUTHORIZATION_STOPPED exit=$exitCode $outputState. STOP; do not regenerate or continue to apply.")
    exit $exitCode
}
if (-not (Test-Path -LiteralPath $absoluteOut -PathType Leaf)) {
    [Console]::Error.WriteLine('CBS_SCENARIO_AUTHORIZATION_OUTPUT_MISSING. STOP; do not continue to apply.')
    exit 2
}

Write-Output $absoluteOut
