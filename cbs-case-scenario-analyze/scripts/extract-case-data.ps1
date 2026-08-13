# 强制 UTF-8 输出，避免 bun stderr 中文在 PowerShell 控制台乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
<#
.SYNOPSIS
CBS 用例数据提取器 - Phase 1 Step 1

.DESCRIPTION
从历史用例 JSON 提取结构化中间数据，加载测试步骤资产（本地目录/API/GBrain source_path 三级），
执行脚本化指纹匹配与参数 Delta 计算，输出到时间戳工作目录。

.PARAMETER CaseDirectory
历史用例 JSON 文件所在目录（与 CaseFile 二选一）

.PARAMETER CaseFile
单个历史用例 JSON 文件路径

.PARAMETER InterfaceDoc
接口字段定义文档 MD 路径（可选）

.PARAMETER CommonStructureDoc
公共结构定义文档 MD 路径（可选）

.PARAMETER StepAssetsDir
测试步骤资产 JSON 目录（可选；提供时优先于 GBrain source_path）

.PARAMETER AssetApiUrl
测试资产平台导出 API 地址（可选，预留；API 不可用时回退 source_path）

.PARAMETER OutDir
输出目录（可选；默认在用例目录下创建 cbs-scenario-analyze-<timestamp> 子目录）

.PARAMETER Gbrain
GBrain CLI 命令名（默认 gbrain）

.EXAMPLE
.\extract-case-data.ps1 -CaseDirectory "D:\cbs_cases\his_cases" -StepAssetsDir "D:\cbs_assets\step-assets" -InterfaceDoc "D:\cbs_docs\接口.md"
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$CaseDirectory,

    [Parameter(Mandatory=$false)]
    [string]$CaseFile,

    [Parameter(Mandatory=$false)]
    [string]$InterfaceDoc,

    [Parameter(Mandatory=$false)]
    [string]$CommonStructureDoc,

    [Parameter(Mandatory=$false)]
    [string]$StepAssetsDir,

    [Parameter(Mandatory=$false)]
    [string]$AssetApiUrl,

    [Parameter(Mandatory=$false)]
    [string]$OutDir,

    [Parameter(Mandatory=$false)]
    [string]$Gbrain = "gbrain"
)

$ErrorActionPreference = "Stop"

if (-not $CaseDirectory -and -not $CaseFile) {
    Write-Error "必须指定 -CaseDirectory 或 -CaseFile 之一"
    exit 2
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tsScript = Join-Path $scriptDir "extract-case-data.ts"

$args = @($tsScript, "--gbrain", $Gbrain)
if ($CaseDirectory) { $args += @("--case-dir", $CaseDirectory) }
if ($CaseFile) { $args += @("--case-file", $CaseFile) }
if ($InterfaceDoc) { $args += @("--interface-doc", $InterfaceDoc) }
if ($CommonStructureDoc) { $args += @("--common-structure-doc", $CommonStructureDoc) }
if ($StepAssetsDir) { $args += @("--step-assets-dir", $StepAssetsDir) }
if ($AssetApiUrl) { $args += @("--asset-api-url", $AssetApiUrl) }
if ($OutDir) { $args += @("--out-dir", $OutDir) }

& bun @args
if ($LASTEXITCODE -ne 0) {
    Write-Error "extract-case-data.ts failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}
