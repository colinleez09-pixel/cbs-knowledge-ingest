# 强制 UTF-8 输出，避免 bun stderr 中文在 PowerShell 控制台乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
# init-analysis-draft.ps1 - Phase 1 Step 1.5 骨架生成（Windows PowerShell 5.1 兼容）
# 从 case-data.json 生成 AI 填空三件套：analysis-draft.json / analysis-notes.md / page-<slug>.md 骨架
param(
    [Parameter(Mandatory=$true)][string]$CaseData,
    [Parameter(Mandatory=$false)][string]$OutDir = "",
    [Parameter(Mandatory=$false)][string]$BunExe = "bun"
)
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$argList = @("run", (Join-Path $ScriptDir "init-analysis-draft.ts"), "--case-data", $CaseData)
if ($OutDir -ne "") { $argList += @("--out-dir", $OutDir) }
& $BunExe @argList
if ($LASTEXITCODE -ne 0) { Write-Error "骨架生成失败 (exit=$LASTEXITCODE)"; exit $LASTEXITCODE }
