# GBrain 写入协议

## 目录

- [概览](#概览)
- [真实 CLI 命令契约（0.42.57.0 实测）](#真实-cli-命令契约042570-实测)
- [页面写入与幂等](#页面写入与幂等)
- [Timeline 写入与幂等](#timeline-写入与幂等)
- [关系创建与幂等](#关系创建与幂等)
- [检索验证](#检索验证)
- [健康检查](#健康检查)
- [统计](#统计)
- [失败处理](#失败处理)

## 概览

本协议定义 apply-scenario.ts 与 GBrain 交互的唯一方式。**所有命令以真实 GBrain 0.42.57.0 实测输出为准**，禁止使用臆想的命令（如 write / capture / get_page / put_page，均不存在）。

## 真实 CLI 命令契约（0.42.57.0 实测）

| 操作 | 命令 | 输出 | 说明 |
|------|------|------|------|
| 写页面 | `gbrain put <slug>` | 文本 "Wrote ..." | **内容从 stdin 读入**，frontmatter（slug/type/title/tags）写在内容里 |
| 读页面 | `gbrain get <slug>` | 纯文本（frontmatter + 正文） | 不存在 `--json` 选项；不存在返回结构化字段 |
| 列页面 | `gbrain list [--type T] [--json]` | 文本表格：`slug\ttype\tdate\ttitle` | 即使加 `--json` 输出也是文本表格，按行解析 |
| 建关系 | `gbrain link <from> <to> [--link-type T] [--link-source S]` | 文本 | 位置参数 from/to；**无 context/note 参数** |
| 查关系 | `gbrain graph-query <slug> [--type T] [--depth N] [--direction in\|out\|both]` | 文本边列表 | |
| 加时间线 | `gbrain timeline-add <slug> <date> <text>` | 文本 | 位置参数 |
| 关键词检索 | `gbrain search <query> [--json]` | 文本 | 用于写入后检索验证 |
| 统计 | `gbrain stats` | 文本键值（Pages/Chunks/... + By type） | 解析文本行 |
| 标签 | `gbrain tag <slug> <tag>` / `gbrain untag` | 文本 | |

**禁止使用的臆想命令**：`gbrain write`、`gbrain capture`、`gbrain get_page`、`gbrain put_page`、`gbrain query --no-expand`（这些在早期闭门造车版本中出现，真实 CLI 均不存在）。

**PowerShell 下写入页面**（stdin 重定向在 cmd 与 PowerShell 语法不同）：

```powershell
# PowerShell 正确写法（管道）
Get-Content page.md -Raw | gbrain put cbs/scenarios/site/scenario
# cmd 正确写法（重定向）
gbrain put cbs/scenarios/site/scenario < page.md
```

脚本实现方式（apply-scenario.ts）：写入临时文件后用 shell 管道/重定向执行，避免命令行参数长度限制与转义问题。

## 页面写入与幂等

1. 写入前 `gbrain get <slug>` 检查页面是否存在
2. 已存在：对回读文本计算 normalized SHA-256，与计划 `content_sha256` 比对
   - 一致 -> 标记 `reused`，跳过写入
   - 不一致 -> 执行更新：临时文件 + `gbrain put <slug> < tmpfile`（PowerShell: `Get-Content tmpfile | gbrain put <slug>`）
3. 不存在 -> 执行创建（同样走 put）
4. 写入后回读验证：`gbrain get <slug>` 比对内容 hash，记录 `expected_content_sha256` 与 `readback_content_sha256`
5. extend 模式的页面：先 `get` 读取已有内容，按增量合入策略生成新内容（见 SKILL.md extend 流程），再 put 覆盖

## Timeline 写入与幂等

1. 写入前 `gbrain get <slug>` 读取页面文本
2. 检查 `idempotency_marker` 是否已存在于文本中
   - 已存在 -> `reused` 跳过
   - 不存在 -> `gbrain timeline-add <slug> <date> <含marker的文本>`，写入后回读验证 marker 出现
3. marker 格式：`cbs-scenario|<sha256(slug|sorted_cases).slice(0,16)>`，同一场景+同一用例集合产生同一 marker

## 关系创建与幂等

1. 创建前 `gbrain graph-query <from_slug> --type <link_type>` 查询已有边
2. 目标 slug 已在结果中 -> `reused` 跳过
3. 不存在 -> `gbrain link <from> <to> --link-type <T>`
4. 回读 `graph-query` 验证精确三元组（from + to + type）

## 检索验证

写入后用 `gbrain search <关键词>` 验证页面可被检索（关键词取场景名/标题）。检索验证失败记 warning（非阻断），因为嵌入索引可能异步。

## 健康检查

写入完成后自动执行（全部非阻断，记 warning）：

- **死链检测**：对计划中每条关系的目标 slug 执行 `gbrain get`，不存在记 dead link
- **孤儿检测**：对每个新写入场景页执行 `graph-query --direction out`，无出边记 orphan
- **标签一致性**：回读页面文本确认含 `cbs` 或 `cbs-scenario` 标签

## 统计

写入完成后执行 `gbrain stats` 解析文本输出（Pages/Chunks/Links/Tags/Timeline + By type），写入报告便于人工核对页面数量变化。

## 失败处理

- 任何 gbrain 命令返回非零退出码 -> 立即停止，输出部分报告，不自动重试
- `runtime_policy`：`apply_attempts_per_user_authorization=1`、`on_failure=stop-and-report`、`agent_may_retry_automatically=false`
