# 强制 UTF-8 输出，避免 bun stderr 中文在 PowerShell 控制台乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
# lookup-field-info.ps1 - 接口字段按需查询（Windows PowerShell 5.1 兼容）
# 渐进加载：AI 只在需要时查询单接口/单字段/关键词，禁止全量读取 interface-fields.json
param(
    [Parameter(Mandatory=$true)][string]$FieldsFile,
    [Parameter(Mandatory=$false)][string]$Interface = "",
    [Parameter(Mandatory=$false)][string]$Field = "",
    [Parameter(Mandatory=$false)][string]$Search = "",
    [Parameter(Mandatory=$false)][switch]$List,
    [Parameter(Mandatory=$false)][string]$BunExe = "bun"
)
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$argList = @("run", (Join-Path $ScriptDir "lookup-field-info.ts"), "--fields-file", $FieldsFile)
if ($Interface -ne "") { $argList += @("--interface", $Interface) }
if ($Field -ne "") { $argList += @("--field", $Field) }
if ($Search -ne "") { $argList += @("--search", $Search) }
if ($List) { $argList += "--list" }
& $BunExe @argList
if ($LASTEXITCODE -ne 0) { Write-Error "字段查询失败 (exit=$LASTEXITCODE)"; exit $LASTEXITCODE }
