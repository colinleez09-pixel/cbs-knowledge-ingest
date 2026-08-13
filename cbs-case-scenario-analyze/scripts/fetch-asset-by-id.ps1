# 强制 UTF-8 输出，避免 bun stderr 中文在 PowerShell 控制台乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
<#
.SYNOPSIS
测试步骤资产导出器 - 通过测试资产平台 API 按资产 ID 获取资产 JSON

.DESCRIPTION
按 test_export_api.py 契约调用资产导出 API：先登录获取 token（satoken），再按资产 ID 列表导出资产 JSON。
API 不可用时应回退使用 GBrain 资产页的 source_path 本地路径。

.PARAMETER AssetId
单个资产 ID（UUID）

.PARAMETER AssetIds
多个资产 ID（逗号分隔）

.PARAMETER ApiUrl
API 基础地址，默认 http://localhost:5000

.PARAMETER User
登录用户名（默认 l30026488）

.PARAMETER Password
登录密码（默认 lz909321*）

.PARAMETER Token
已有 token（提供时跳过登录）

.PARAMETER Out
输出 JSON 文件路径

.EXAMPLE
.\fetch-asset-by-id.ps1 -AssetId "6fb88e27-b395-4046-b80c-26fbc17c9cec" -ApiUrl "http://localhost:5000" -Out ".\asset.json"
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$AssetId,

    [Parameter(Mandatory=$false)]
    [string]$AssetIds,

    [Parameter(Mandatory=$false)]
    [string]$ApiUrl = "http://localhost:5000",

    [Parameter(Mandatory=$false)]
    [string]$User = "l30026488",

    [Parameter(Mandatory=$false)]
    [string]$Password = "lz909321*",

    [Parameter(Mandatory=$false)]
    [string]$Token,

    [Parameter(Mandatory=$true)]
    [string]$Out
)

$ErrorActionPreference = "Stop"

if (-not $AssetId -and -not $AssetIds) {
    Write-Error "必须指定 -AssetId 或 -AssetIds 之一"
    exit 2
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tsScript = Join-Path $scriptDir "fetch-asset-by-id.ts"

$args = @($tsScript, "--api-url", $ApiUrl, "--out", $Out)
if ($AssetId) { $args += @("--asset-id", $AssetId) }
if ($AssetIds) { $args += @("--asset-ids", $AssetIds) }
if ($Token) { $args += @("--token", $Token) } else { $args += @("--user", $User, "--password", $Password) }

& bun @args
if ($LASTEXITCODE -ne 0) {
    Write-Error "fetch-asset-by-id.ts failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}
