# 强制 UTF-8 输出，避免 bun stderr 中文在 PowerShell 控制台乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
<#
.SYNOPSIS
CBS 分析草稿校验器 - Phase 1 Step 3

.DESCRIPTION
校验 AI 生成的 analysis-draft.json（四层分析真实性门禁），生成可执行的场景计划。

.PARAMETER Draft
AI 生成的 analysis-draft.json 路径

.PARAMETER CaseData
extract-case-data 生成的 case-data.json 路径

.PARAMETER AnalysisNotes
AI 生成的 analysis-notes.md 路径（分析证据链，必填）

.PARAMETER OutPlan
输出计划文件路径

.PARAMETER OutReport
输出校验报告路径

.EXAMPLE
.\validate-analysis.ps1 -Draft ".\out\analysis-draft.json" -CaseData ".\out\case-data.json" -AnalysisNotes ".\out\analysis-notes.md" -OutPlan ".\out\scenario-plan.json" -OutReport ".\out\validation-report.md"
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$Draft,

    [Parameter(Mandatory=$true)]
    [string]$CaseData,

    [Parameter(Mandatory=$true)]
    [string]$AnalysisNotes,

    [Parameter(Mandatory=$true)]
    [string]$OutPlan,

    [Parameter(Mandatory=$true)]
    [string]$OutReport
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tsScript = Join-Path $scriptDir "validate-analysis.ts"

& bun $tsScript --draft $Draft --case-data $CaseData --analysis-notes $AnalysisNotes --out-plan $OutPlan --out-report $OutReport
if ($LASTEXITCODE -ne 0) {
    Write-Error "validate-analysis.ts failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}
