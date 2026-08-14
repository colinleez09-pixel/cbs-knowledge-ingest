---
name: cbs-case-scenario-analyze
description: 分析 CBS 历史用例提取测试场景知识并入库 GBrain，脚本完成提取/字段级补丁/重建验证/骨架生成/门禁校验，AI 负责语义分析与证据标注；当用户需要分析历史用例提取场景、用例场景知识入库 GBrain 或按场景增量维护测试知识时使用
version: 2.0.8
mutating: true
---

# CBS 历史用例场景知识提取 (v2.0)

运行条件：Bun 1.3+、GBrain CLI 0.42.57.0+。

## 任务目标

- 本 Skill 用于：分析 CBS 5G 计费系统历史测试用例 JSON，提取测试场景知识，与 GBrain 测试步骤资产进行字段级匹配，计算字段级补丁（FieldPatch），执行重建验证，生成结构化知识页写入 GBrain。
- 触发条件：用户需要分析历史用例提取场景、场景知识入库 GBrain、按场景增量维护测试知识。

## 资产获取流程（核心机制）

脚本自动完成以下链路，**用户无需提供资产 ID**：

```
GBrain (gbrain list --type cbs-test-step)
  → 获取步骤资产页面列表（slug + title）
  → gbrain get <slug> 读取页面内容
  → 提取 frontmatter 中的 asset_id
  → 用 asset_id 调用测试资产平台 API 获取完整 JSON
  → 返回 step_assets（含 full_json）
```

API 地址和账号密码已内置（与 `test_export_api.py` 一致），无需用户填写。

## 执行流程

**严格按以下步骤顺序执行。不要跳步、不要回退、不要猜测。** dry-run 在 Step 5 后停止。

### Step 1: 提取用例数据

运行脚本，自动完成：解析用例 JSON → 查询 GBrain 获取资产 ID → 调用 API 获取完整资产 JSON → 构建字段树 → 计算脚本补丁 → 多维匹配。

```
bun scripts/extract-case-data.ts \
  --case-file <历史用例.json> \
  --out-dir <输出目录> \
  [--interface-doc <接口文档.md>] \
  [--common-structure-doc <公共结构.md>] \
  [--gbrain <gbrain路径>]
```

如果批量分析多个用例：
```
bun scripts/extract-case-data.ts \
  --case-dir <用例目录> \
  --out-dir <输出目录>
```

**输出**：`<输出目录>/cbs-scenario-analyze-<timestamp>/case-data.json`

检查 case-data.json 中 `extraction_meta.asset_source` 和 `step_assets[].full_json`。如果 `full_json` 不为 null，说明资产获取成功。

**可选覆盖**：如果 GBrain 不可用或需要指定特定资产，可通过 `--asset-ids id1,id2` 手动提供资产 ID，脚本会直接调 API 获取。

### Step 2: 生成分析草稿骨架

运行脚本，读取 case-data.json，计算四签名、construction_mode、inline_recipe，生成草稿三件套。

```
bun scripts/init-analysis-draft.ts \
  --case-data <case-data.json> \
  --out-draft <analysis-draft.json> \
  --out-page <scenario-plan.md> \
  --out-notes <analysis-notes.md>
```

**输出**：`analysis-draft.json`（草稿骨架）、`scenario-plan.md`（场景计划页）、`analysis-notes.md`（分析笔记模板）

### Step 3: AI 语义分析（不可跳过）

AI 读取以下文件并完成全部语义分析：

1. `analysis-draft.json` — 草稿骨架（含脚本计算的签名、construction_mode、patches）
2. `case-data.json` — 字段树、变量图、脚本补丁、资产数据
3. `analysis-notes.md` — 笔记模板

**AI 必须完成的工作**：
1. **匹配裁决**：确认或否决脚本计算的匹配结果（读取 case-data.json 中的 match 结果和 score_breakdown）
2. **补丁增强**：为每个 ScriptPatchItem 填写 reason（>=5字符）、evidence_sources（至少1项）、confidence、field_description、required_for_execution
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

完成后将修改后的 draft.json 保存。

### Step 4: 校验与重建验证

运行脚本，执行门禁校验 + 重建验证 + 生成 analysis-data。

```
bun scripts/validate-analysis.ts \
  --draft <analysis-draft.json> \
  --case-data <case-data.json> \
  --analysis-notes <analysis-notes.md> \
  --out-data <analysis-data.json> \
  --out-report <validation-report.md>
```

**输出**：`analysis-data.json`、`validation-report.md`

- **dry-run**：向用户展示结果后**停止**，不执行 Step 5-6。
- **正式模式**：继续 Step 5。

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
| V10 | error | patch.reason >=5 字符 |
| V11 | error | patch.evidence_sources 非空 |
| V12 | error | required patch confidence 不为 unresolved |
| V13 | error | construction_mode 与 match_kind 一致 |
| V14 | error | inline-recipe 步骤有 inline_recipe 数据 |
| V15 | error | test_points 非空 |
| V17 | error | notes 文件无占位符 |
| V18 | error | reconstruction 不为 conflict |
| V19 | warning | 单用例 maturity 应为 provisional |
| V20 | error | 无重复 pattern_signature |

### Step 5: 授权

生成授权计划。

```
bun scripts/authorize-scenario-plan.ts \
  --analysis-data <analysis-data.json> \
  --case-data <case-data.json> \
  --out <authorized-plan.json>
```

### Step 6: 写入 GBrain

安全写入 GBrain。analysis-data 采用 extend 模式（合并已有数据），scenario-plan 采用 create/overwrite 模式。

```
bun scripts/apply-scenario.ts \
  --plan <authorized-plan.json> \
  --out-report <apply-report.md> \
  --out-result <apply-result.json>
```

安全 extend 逻辑：写入前回读现有 analysis-data → 合并 source_cases（并集）→ 合并 steps（patches 追加不覆盖）→ 保留已有 evidence → 更新 hash。

## 禁止事项

- **禁止跳过 Step 3**：AI 必须完成全部语义分析才能进入 Step 4
- **禁止仅凭脚本分数决定匹配**：必须理解匹配结果后裁决
- **禁止提交无 reason 的补丁**：所有补丁必须有 reason（>=5字符）和 evidence_sources
- **禁止自行查找资产文件**：资产 JSON 由 Step 1 脚本自动获取，AI 不需要手动搜索

## 使用示例

- 示例1：单用例 dry-run
  - 输入：历史用例 JSON + 接口文档（可选）
  - 执行 Step 1→2→3→4 后停止
  - 产出：case-data.json + draft + notes + analysis-data.json + validation-report.md

- 示例2：批量用例
  - 输入：多个历史用例 JSON 目录
  - 同 Step 1→4，case-data 含多 case，draft 含多 scenario

- 示例3：增量入库（extend）
  - 已有场景知识页 + 新用例
  - analysis-data 安全合并（source_cases 并集、patches 追加）

## 资源索引

- 脚本：
  - [scripts/scenario-core.ts](scripts/scenario-core.ts) — 共享类型 + 字段树 + 补丁引擎 + 重建引擎 + 变量图 + 多维匹配 + GBrain CLI
  - [scripts/extract-case-data.ts](scripts/extract-case-data.ts) — 用例解析 + GBrain资产获取 + API调用 + 字段树 + 变量图 + 脚本补丁 + 多维匹配
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
- 资产获取是自动的：GBrain 查页面 → 提取 asset_id → 调 API 获取完整 JSON。
- 重建门禁是质量保证核心：重建结果与原始步骤不一致时必须记录未解释差异。
- extend 模式不覆盖已有数据，冲突生成 unresolved_questions。
- 单用例 maturity 为 provisional，多用例验证后升级为 stable。
