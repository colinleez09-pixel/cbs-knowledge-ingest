---
name: cbs-case-scenario-analyze
description: 分析 CBS 历史用例提取测试场景知识并入库 GBrain，脚本完成提取/字段级补丁/重建验证/骨架生成/门禁校验，AI 负责语义分析与证据标注；当用户需要分析历史用例提取场景、用例场景知识入库 GBrain 或按场景增量维护测试知识时使用
version: 2.0.0
mutating: true
---

# CBS 历史用例场景知识提取 (v2.0)

运行条件：Bun 1.3+、GBrain CLI 0.42.57.0+。前置依赖：已通过 `cbs-step-asset-ingest` 将测试步骤资产入库到 GBrain，或可访问测试资产平台 API。

## 任务目标

- 本 Skill 用于：分析 CBS 5G 计费系统历史测试用例 JSON，提取测试场景模式知识，与 GBrain 测试步骤资产进行字段级匹配，计算字段级补丁（FieldPatch），执行重建验证，生成结构化知识页写入 GBrain。
- 能力包含：用例解析、字段树提取、变量流图构建、多维匹配、字段级补丁生成、重建验证门禁、安全 extend 合并。
- 触发条件：用户需要分析历史用例提取场景、场景知识入库 GBrain、按场景增量维护测试知识。

## 前置准备

- 依赖说明：Bun 1.3+（运行 TypeScript 脚本）；GBrain CLI（入库写入）
- 输入文件：历史用例 JSON（单个或批量）、接口文档 MD（可选）、公共结构文档 MD（可选）
- 资产来源：测试资产平台 API（`--api-url`）或本地资产目录（`--asset-dir`）

## 操作步骤

### Phase 1: 分析（dry-run 在此阶段结束后停止）

#### Step 1: 提取用例数据
- 脚本解析历史用例 JSON，为每个步骤构建字段树（递归展开 rReq/rRsp/rVars），提取变量生产-消费关系图，计算脚本补丁（ScriptPatchItem），与已有步骤资产进行多维匹配。
- 脚本调用示例：
  ```
  bun scripts/extract-case-data.ts \
    --cases <case-dir-or-file> \
    --asset-dir <asset-dir> \
    [--api-url <url> --api-user <user> --api-pass <pass>] \
    [--interface-doc <doc.md>] [--common-structure <doc.md>] \
    --out <output-dir>
  ```
- 输出：`case-data.json`（含字段树、变量图、脚本补丁、匹配候选）

#### Step 1.5: 获取完整资产 JSON（必须步骤）
- AI 必须读取完整候选资产 JSON 后才能裁决匹配。脚本批量获取所有候选资产并生成 manifest。
- 脚本调用示例：
  ```
  bun scripts/fetch-asset-by-id.ts \
    --api-url <url> --username <user> --password <pass> \
    --asset-id <id1> [--asset-id <id2> ...] \
    --out-dir <asset-dir>
  ```
- 输出：每个资产 `<name>.json` + `asset-manifest.json`（含 content_hash、缓存状态）
- 缓存策略：基于 asset_id 文件名匹配，已存在且 id 一致则跳过重新下载

#### Step 2: 生成分析草稿骨架
- 脚本读取 case-data.json，调用 computeSignatures 计算四签名，为每个步骤确定 construction_mode，生成匹配/未匹配步骤的骨架。
- 脚本调用示例：
  ```
  bun scripts/init-analysis-draft.ts \
    --case-data <case-data.json> \
    --asset-dir <asset-dir> \
    --out-draft <draft.json> \
    --out-page <scenario-plan.md> \
    --out-notes <analysis-notes.md>
  ```
- 输出：`analysis-draft.json`（含步骤 patches 骨架、construction_mode、inline_recipe）、`scenario-plan.md`、`analysis-notes.md`

#### Step 3: AI 分析（必须，不可跳过）
- AI 读取以下文件后执行语义分析：
  1. `analysis-draft.json` — 草稿骨架
  2. `case-data.json` — 字段树、变量图、脚本补丁
  3. **完整候选资产 JSON**（`<asset-dir>/*.json`）— 必须读取后才能裁决匹配
  4. `analysis-notes.md` — 笔记模板

- AI 必须完成的工作：
  1. **匹配裁决**：读取完整候选资产 JSON，确认或否决脚本计算的匹配结果。如否决，说明原因并选择正确的资产或标记为 inline-recipe
  2. **补丁增强**：为每个 ScriptPatchItem 填写 reason（≥5字符）、evidence_sources（至少1项）、confidence（confirmed/inferred/unresolved）、field_description、required_for_execution
  3. **intent_signature 填写**：从用例描述、步骤备忘提取测试意图
  4. **business_entities 填写**：从步骤资产提取业务实体骨架并完善
  5. **scenario_name 填写**：与 intent_signature 对齐的中文名称
  6. **test_points 填写**：结构化测试验证点（description + verification_method + expected_result）
  7. **variable_dependencies 确认**：确认或修正脚本计算的变量依赖关系
  8. **unresolved_questions 填写**：记录所有不确定的分析结论
  9. **notes 填写**：按 Step[N] 格式填写每个步骤的分析笔记

- construction_mode 判定规则：
  - `asset-plus-patches`：步骤匹配到资产，用资产 + 字段补丁重建
  - `inline-recipe`：步骤无匹配资产，保存完整组件配置（含 option_parameter、variable_inputs、variable_outputs）
  - `external-source`：步骤依赖外部系统（如数据库预置数据），无法从用例 JSON 提取完整配置
  - `manual-required`：证据不足以自动重建，需人工补充

- 补丁 operation 类型（13 种）：
  - 字段级：`add-field`（用例有资产无）、`replace-field`（值不同）、`remove-field`（资产有用例无）、`remove-field-override`（用例显式置空）
  - 特殊值：`set-nosend`、`set-nocare`、`set-norecv`（CBS 运行时指令）
  - 变量绑定：`runtime-bind`（`${var}` 引用）、`expression-bind`（`${G.func()}` 表达式）
  - 变量级：`set-variable`（TableSetVar 赋值）、`remove-variable`
  - 结构级：`replace-request`（rReq 根结构不同）、`add-component`、`remove-component`
  - 启发式：`version-drift`（资产有接口文档无的字段，需 AI 确认）

- evidence_sources 取值：`declared`（资产 parameter_meta 声明）、`observed`（历史用例实际使用）、`documented`（接口文档定义）、`inferred`（AI 推断）

#### Step 4: 校验与重建验证
- 脚本执行四层验证：笔记证据检查、结构完整性、重建门禁、analysis-data 生成。
- 重建门禁：脚本对每个 asset-plus-patches 步骤执行补丁应用（applyPatches），将重建结果与历史用例原始步骤规范化后深度比较，输出覆盖率和未解释差异。
- 脚本调用示例：
  ```
  bun scripts/validate-analysis.ts \
    --draft <draft.json> \
    --case-data <case-data.json> \
    --analysis-notes <notes.md> \
    --out-data <analysis-data.json> \
    --out-report <validation-report.md>
  ```

- 门禁列表（V1-V20）：

| 门禁 | 级别 | 检查内容 |
|------|------|---------|
| V1 | error | scenario_id 非空 |
| V2 | error | scenario_name 非空且非占位符 |
| V3 | error | source_cases 非空 |
| V4 | error | pattern_signature 非空 |
| V5 | error | pattern_signature 不含 setup 接口（CreateCustomer/CreateAccount/Login/SystemParameter） |
| V6 | error | intent_signature 已填写（非占位符） |
| V7 | error | matched 步骤的 asset_id 在 case-data 中存在 |
| V9 | error | 每个 ScriptPatchItem 在 AI patches 中有对应项 |
| V10 | error | patch.reason 非空且 ≥5 字符 |
| V11 | error | patch.evidence_sources 非空 |
| V12 | error | required_for_execution=true 的 patch confidence 不为 unresolved |
| V13 | error | construction_mode 与 match_kind 一致 |
| V14 | error | inline-recipe 模式的步骤必须有 inline_recipe 数据 |
| V15 | error | test_points 非空 |
| V17 | error | notes 文件存在且无占位符 |
| V18 | error | reconstruction.status 不为 conflict |
| V19 | warning | 单用例 maturity 应为 provisional |
| V20 | error | 同 draft 中不允许两个 scenario 的 pattern_signature 完全相同 |

### Phase 2: 授权与写入

#### Step 5: 授权
- AI 向用户展示 dry-run 结果（validation-report.md + analysis-data.json），用户确认后生成授权计划。
- 脚本调用示例：
  ```
  bun scripts/authorize-scenario-plan.ts \
    --analysis-data <analysis-data.json> \
    --case-data <case-data.json> \
    --gbrain-list <gbrain-list-output.txt> \
    --out <authorized-plan.json>
  ```

#### Step 6: 写入 GBrain
- 脚本执行安全写入：analysis-data 页面采用 extend 模式（合并已有数据），scenario-plan 页面采用 create/overwrite 模式。
- 安全 extend 逻辑：
  1. 写入前 gbrain get 回读现有 analysis-data
  2. 合并 source_cases（并集）
  3. 合并 steps（按 step_index，patches 追加不覆盖）
  4. 保留已有 evidence 和 unresolved_questions
  5. 更新 hash
- 脚本调用示例：
  ```
  bun scripts/apply-scenario.ts \
    --plan <authorized-plan.json> \
    --out-report <apply-report.md> \
    --out-result <apply-result.json>
  ```

## 使用示例

- 示例1：单用例 dry-run 分析
  - 场景/输入：用户提供一个历史用例 JSON 文件 + 测试资产平台 API 地址
  - 预期产出：case-data.json + analysis-draft.json + analysis-notes.md + analysis-data.json + validation-report.md
  - 关键要点：AI 必须读取完整候选资产 JSON 后才能裁决匹配；所有补丁必须有 reason 和 evidence

- 示例2：批量用例分析
  - 场景/输入：用户提供一个目录包含多个历史用例 JSON
  - 预期产出：同示例1，但 case-data.json 包含多个 case，draft 包含多个 scenario
  - 关键要点：同 pattern_signature 的用例会被归入同一 scenario；不同 pattern 生成不同 scenario

- 示例3：增量入库（extend）
  - 场景/输入：GBrain 中已有某个场景的知识页，用户分析新的同场景用例
  - 预期产出：analysis-data 页面被安全合并（source_cases 并集、patches 追加）
  - 关键要点：extend 模式不覆盖已有数据；冲突生成 unresolved_questions 而非覆盖

## 资源索引

- 脚本：
  - [scripts/scenario-core.ts](scripts/scenario-core.ts) — 共享类型 + 字段树 + 补丁引擎 + 重建引擎 + 变量图 + 多维匹配 + GBrain CLI
  - [scripts/extract-case-data.ts](scripts/extract-case-data.ts) — 用例解析 + 字段树提取 + 变量图 + 脚本补丁 + 多维匹配
  - [scripts/fetch-asset-by-id.ts](scripts/fetch-asset-by-id.ts) — 批量获取资产 JSON + manifest + hash 缓存
  - [scripts/init-analysis-draft.ts](scripts/init-analysis-draft.ts) — 草稿骨架 + construction_mode + inline_recipe + 四签名
  - [scripts/validate-analysis.ts](scripts/validate-analysis.ts) — 四层验证 + 重建门禁 + analysis-data 生成
  - [scripts/apply-scenario.ts](scripts/apply-scenario.ts) — 安全 extend 合并 + GBrain 写入
  - [scripts/authorize-scenario-plan.ts](scripts/authorize-scenario-plan.ts) — 授权计划生成
  - [scripts/lookup-field-info.ts](scripts/lookup-field-info.ts) — 接口字段查询
- 参考：
  - [references/design-doc.md](references/design-doc.md) — 架构设计与变更日志（何时读取：理解设计决策时）
  - [references/analysis-draft-schema.md](references/analysis-draft-schema.md) — 草稿 JSON Schema（何时读取：填写草稿时）
  - [references/scenario-schema.md](references/scenario-schema.md) — analysis-data 输出格式（何时读取：理解输出结构时）
  - [references/interface-doc-parsing.md](references/interface-doc-parsing.md) — 接口文档解析与证据模型（何时读取：解析接口文档时）
  - [references/execution-review-checklist.md](references/execution-review-checklist.md) — 执行审查清单（何时读取：验证分析质量时）
  - [references/regression-tests.md](references/regression-tests.md) — 回归测试场景（何时读取：验证 Skill 正确性时）
  - [references/relation-types.md](references/relation-types.md) — GBrain 关系类型定义（何时读取：创建页面关系时）
  - [references/write-protocol.md](references/write-protocol.md) — GBrain 写入协议（何时读取：执行写入操作时）

## 注意事项

- AI 必须读取完整候选资产 JSON 后才能裁决匹配，不能仅凭脚本计算的分数决定。
- 所有补丁必须有 reason 和 evidence_sources，不允许空值通过门禁。
- 重建门禁是质量保证的核心：如果重建结果与原始步骤不一致，必须记录未解释差异。
- extend 模式下不覆盖已有数据，冲突生成 unresolved_questions。
- 单用例分析的 maturity 为 provisional，多用例验证后可升级为 stable。
- 充分利用智能体能力，脚只做确定性计算（字段树、补丁 diff、重建验证），语义判断由 AI 完成。
