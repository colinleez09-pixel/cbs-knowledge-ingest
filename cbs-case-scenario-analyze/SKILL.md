---
name: cbs-case-scenario-analyze
description: 分析 CBS 历史用例提取测试场景知识并入库 GBrain，脚本完成提取/字段级补丁/重建验证/骨架生成/门禁校验，AI 负责语义分析与证据标注；当用户需要分析历史用例提取场景、用例场景知识入库 GBrain 或按场景增量维护测试知识时使用
version: 2.0.3
mutating: true
---

# CBS 历史用例场景知识提取 (v2.0)

运行条件：Bun 1.3+、GBrain CLI 0.42.57.0+。前置依赖：已通过 `cbs-step-asset-ingest` 将测试步骤资产入库到 GBrain，或可访问测试资产平台 API。

## 任务目标

- 本 Skill 用于：分析 CBS 5G 计费系统历史测试用例 JSON，提取测试场景模式知识，与 GBrain 测试步骤资产进行字段级匹配，计算字段级补丁（FieldPatch），执行重建验证，生成结构化知识页写入 GBrain。
- 触发条件：用户需要分析历史用例提取场景、场景知识入库 GBrain、按场景增量维护测试知识。

## 前置准备

- 依赖：Bun 1.3+（运行 TypeScript 脚本）；GBrain CLI（入库写入）
- 输入：历史用例 JSON（单个或批量）、接口文档 MD（可选）、公共结构文档 MD（可选）
- 资产来源：测试资产平台 API（优先）或本地资产目录（兜底）

## 执行流程

**严格按以下步骤顺序执行，不要跳步、不要回退、不要猜测。** 每个步骤必须在前一步成功完成后才能执行。dry-run 模式在 Step 5 结束后停止，不执行 Step 6-7。

### Step 1: 提取用例数据

**动作**：运行脚本，解析历史用例 JSON，构建字段树、变量图、脚本补丁、多维匹配。

```
bun scripts/extract-case-data.ts \
  --cases <case-dir-or-file> \
  --asset-ids <id1,id2,...> \
  --asset-api-url <url> --asset-api-user <user> --asset-api-pass <pass> \
  [--interface-doc <doc.md>] [--common-structure <doc.md>] \
  --out <output-dir>
```

**关键**：`--asset-ids` 和 `--asset-api-url/user/pass` 是获取步骤资产的核心参数。脚本会直接用这些 ID 调用 API 获取资产 JSON，不依赖 GBrain。API 地址默认 `http://localhost:5000`。

**输出**：`<output-dir>/case-data.json`（含 `step_assets[].full_json` 完整资产数据）

### Step 2: 确认资产获取结果

**动作**：检查 case-data.json 中 `step_assets` 是否包含 `full_json`。如果 Step 1 已通过 API 获取到完整 JSON，此步可跳过。如果 full_json 为 null（API 未获取到），则需单独执行：

```
bun scripts/fetch-asset-by-id.ts \
  --api-url <url> --username <user> --password <pass> \
  --asset-id <id1> [--asset-id <id2> ...] \
  --out-dir <asset-dir>
```

**输出**：每个资产 `<name>.json` + `asset-manifest.json`
**下一步**：进入 Step 3。

### Step 3: 生成分析草稿骨架

**动作**：运行脚本，读取 case-data.json，计算四签名、construction_mode，生成草稿骨架。

```
bun scripts/init-analysis-draft.ts \
  --case-data <case-data.json> \
  --asset-dir <asset-dir> \
  --out-draft <draft.json> \
  --out-page <scenario-plan.md> \
  --out-notes <analysis-notes.md>
```

**输出**：`analysis-draft.json`、`scenario-plan.md`、`analysis-notes.md`
**下一步**：进入 Step 4。

### Step 4: AI 语义分析（不可跳过）

**动作**：AI 读取以下文件并完成语义分析（这是唯一的 AI 步骤，其余步骤均为脚本执行）：

1. `analysis-draft.json` — 草稿骨架
2. `case-data.json` — 字段树、变量图、脚本补丁
3. **完整候选资产 JSON** — 从 Step 2 的 `--out-dir` 输出目录读取
4. `analysis-notes.md` — 笔记模板

**AI 必须完成的工作**：
1. **匹配裁决**：读取完整候选资产 JSON，确认或否决脚本计算的匹配结果
2. **补丁增强**：为每个 ScriptPatchItem 填写 reason（≥5字符）、evidence_sources（至少1项）、confidence、field_description、required_for_execution
3. **intent_signature**：从用例描述提取测试意图
4. **business_entities**：从步骤资产提取业务实体
5. **scenario_name**：与 intent_signature 对齐的中文名称
6. **test_points**：结构化测试验证点（description + verification_method + expected_result）
7. **variable_dependencies**：确认或修正变量依赖
8. **unresolved_questions**：记录不确定结论
9. **notes**：按 Step[N] 格式填写分析笔记

**construction_mode 判定规则**：
- `asset-plus-patches`：步骤匹配到资产，用资产 + 字段补丁重建
- `inline-recipe`：步骤无匹配资产，保存完整组件配置
- `external-source`：步骤依赖外部系统
- `manual-required`：证据不足，需人工补充

**补丁 operation 类型**（13 种）：
- 字段级：`add-field`、`replace-field`、`remove-field`、`remove-field-override`
- 特殊值：`set-nosend`、`set-nocare`、`set-norecv`
- 变量绑定：`runtime-bind`（`${var}`）、`expression-bind`（`${G.func()}`）
- 变量级：`set-variable`、`remove-variable`
- 结构级：`replace-request`、`add-component`、`remove-component`
- 启发式：`version-drift`

**evidence_sources**：`declared`（资产声明）、`observed`（用例实际使用）、`documented`（接口文档）、`inferred`（AI 推断）

**下一步**：将 AI 修改后的 draft.json 保存到文件，进入 Step 5。

### Step 5: 校验与重建验证

**动作**：运行脚本，执行门禁校验 + 重建验证 + 生成 analysis-data。

```
bun scripts/validate-analysis.ts \
  --draft <draft.json> \
  --case-data <case-data.json> \
  --analysis-notes <notes.md> \
  --out-data <analysis-data.json> \
  --out-report <validation-report.md>
```

**输出**：`analysis-data.json`、`validation-report.md`
**下一步**：
- **dry-run 模式**：向用户展示 validation-report.md + analysis-data.json，然后**停止**。不执行 Step 6-7。
- **正式模式**：继续 Step 6。

**门禁列表**：

| 门禁 | 级别 | 检查内容 |
|------|------|---------|
| V1 | error | scenario_id 非空 |
| V2 | error | scenario_name 非空且非占位符 |
| V3 | error | source_cases 非空 |
| V4 | error | pattern_signature 非空 |
| V5 | error | pattern_signature 不含 setup 接口 |
| V6 | error | intent_signature 已填写 |
| V7 | error | matched 步骤的 asset_id 存在 |
| V9 | error | 每个 ScriptPatchItem 有对应 AI patch |
| V10 | error | patch.reason ≥5 字符 |
| V11 | error | patch.evidence_sources 非空 |
| V12 | error | required patch confidence 不为 unresolved |
| V13 | error | construction_mode 与 match_kind 一致 |
| V14 | error | inline-recipe 步骤有 inline_recipe 数据 |
| V15 | error | test_points 非空 |
| V17 | error | notes 文件无占位符 |
| V18 | error | reconstruction 不为 conflict |
| V19 | warning | 单用例 maturity 应为 provisional |
| V20 | error | 无重复 pattern_signature |

### Step 6: 授权

**动作**：生成授权计划。

```
bun scripts/authorize-scenario-plan.ts \
  --analysis-data <analysis-data.json> \
  --case-data <case-data.json> \
  --gbrain-list <gbrain-list-output.txt> \
  --out <authorized-plan.json>
```

### Step 7: 写入 GBrain

**动作**：安全写入 GBrain。analysis-data 采用 extend 模式（合并已有数据），scenario-plan 采用 create/overwrite 模式。

```
bun scripts/apply-scenario.ts \
  --plan <authorized-plan.json> \
  --out-report <apply-report.md> \
  --out-result <apply-result.json>
```

**安全 extend 逻辑**：写入前回读现有 analysis-data → 合并 source_cases（并集）→ 合并 steps（patches 追加不覆盖）→ 保留已有 evidence → 更新 hash。

## 禁止事项

- **禁止跳过 API 获取资产**：必须在 extract-case-data.ts 中通过 `--asset-ids` + `--asset-api-url/user/pass` 参数直接从 API 获取资产 JSON，不得依赖 GBrain 或自行搜索本地文件
- **禁止自行查找资产**：AI 不得使用 find/ls 等命令搜索 steps/ 目录或其他路径获取资产 JSON
- **禁止跳过 Step 4**：AI 必须完成全部语义分析才能进入 Step 5
- **禁止仅凭脚本分数决定匹配**：必须读取完整候选资产 JSON 后裁决
- **禁止提交无 reason 的补丁**：所有补丁必须有 reason（≥5字符）和 evidence_sources

## 使用示例

- 示例1：单用例 dry-run
  - 输入：历史用例 JSON + API 地址
  - 产出：case-data.json + draft + notes + analysis-data.json + validation-report.md
  - 执行 Step 1→2→3→4→5 后停止，不执行 6-7

- 示例2：批量用例分析
  - 输入：多个历史用例 JSON 目录
  - 同 Step 1→5，case-data 含多 case，draft 含多 scenario

- 示例3：增量入库（extend）
  - 已有场景知识页 + 新用例
  - analysis-data 安全合并（source_cases 并集、patches 追加）

## 资源索引

- 脚本：
  - [scripts/scenario-core.ts](scripts/scenario-core.ts) — 共享类型 + 字段树 + 补丁引擎 + 重建引擎 + 变量图 + 多维匹配 + GBrain CLI
  - [scripts/extract-case-data.ts](scripts/extract-case-data.ts) — 用例解析 + 字段树 + 变量图 + 脚本补丁 + 多维匹配
  - [scripts/fetch-asset-by-id.ts](scripts/fetch-asset-by-id.ts) — 批量获取资产 JSON + manifest + hash 缓存
  - [scripts/init-analysis-draft.ts](scripts/init-analysis-draft.ts) — 草稿骨架 + construction_mode + inline_recipe + 四签名
  - [scripts/validate-analysis.ts](scripts/validate-analysis.ts) — 四层验证 + 重建门禁 + analysis-data 生成
  - [scripts/apply-scenario.ts](scripts/apply-scenario.ts) — 安全 extend 合并 + GBrain 写入
  - [scripts/authorize-scenario-plan.ts](scripts/authorize-scenario-plan.ts) — 授权计划生成
  - [scripts/lookup-field-info.ts](scripts/lookup-field-info.ts) — 接口字段查询
- 参考：
  - [references/design-doc.md](references/design-doc.md) — 架构设计与变更日志
  - [references/analysis-draft-schema.md](references/analysis-draft-schema.md) — 草稿 JSON Schema
  - [references/scenario-schema.md](references/scenario-schema.md) — analysis-data 输出格式
  - [references/interface-doc-parsing.md](references/interface-doc-parsing.md) — 接口文档解析与证据模型
  - [references/execution-review-checklist.md](references/execution-review-checklist.md) — 执行审查清单
  - [references/regression-tests.md](references/regression-tests.md) — 回归测试场景
  - [references/relation-types.md](references/relation-types.md) — GBrain 关系类型定义
  - [references/write-protocol.md](references/write-protocol.md) — GBrain 写入协议

## 注意事项

- 脚本只做确定性计算（字段树、补丁 diff、重建验证），语义判断由 AI 完成。
- 重建门禁是质量保证核心：重建结果与原始步骤不一致时必须记录未解释差异。
- extend 模式不覆盖已有数据，冲突生成 unresolved_questions。
- 单用例 maturity 为 provisional，多用例验证后升级为 stable。
