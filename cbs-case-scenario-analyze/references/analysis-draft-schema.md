# AI 分析草稿 Schema (v2.0)

## 目录

- [概览](#概览)
- [AnalysisDraft 顶层结构](#analysisdraft-顶层结构)
- [AnalysisDraftScenario 场景结构](#analysisdraftscenario-场景结构)
- [FieldPatch 字段补丁](#fieldpatch-字段补丁)
- [ScriptPatchItem 脚本补丁](#scriptpatchitem-脚本补丁)
- [VariableDependency 变量依赖](#variabledependency-变量依赖)
- [InlineRecipe 内联配方](#inlinerecipe-内联配方)
- [ReconstructionResult 重建结果](#reconstructionresult-重建结果)
- [construction_mode 判定规则](#construction_mode-判定规则)
- [补丁 operation 类型](#补丁-operation-类型)
- [AI 分析任务清单](#ai-分析任务清单)
- [完整示例](#完整示例)

## 概览

AI 分析草稿（`analysis-draft.json`）是 init-analysis-draft.ts 生成的骨架，AI 读取后填充语义字段。脚本做确定性工作（字段树、补丁 diff、变量图、匹配），AI 做语义工作（匹配裁决、补丁增强、意图提取、实体识别）。

### 职责分工

| 工作 | 执行者 |
|------|--------|
| 用例/接口文档/资产 JSON 解析 | 脚本（extract-case-data.ts） |
| 字段树提取（递归展开 rReq/rRsp） | 脚本 |
| 脚本补丁计算（字段级 diff） | 脚本，输出 `script_patches` |
| 变量流图构建（producer/consumer） | 脚本，输出 `variable_graph` |
| 多维匹配评分 | 脚本，输出 `score_breakdown` |
| 匹配裁决（读取完整资产 JSON 后确认/否决） | AI |
| 补丁增强（reason/evidence/confidence） | AI |
| intent_signature / scenario_name / test_points | AI |
| construction_mode 判定 | 脚本初判，AI 可修正 |
| 重建验证 | 脚本（validate-analysis.ts） |

## AnalysisDraft 顶层结构

```json
{
  "version": "2.0.0",
  "generated_at": "2026-08-11T10:00:00Z",
  "source_case_data": "case-data.json",
  "scenarios": [AnalysisDraftScenario]
}
```

## AnalysisDraftScenario 场景结构

```json
{
  "scenario_id": "freeunit-expiretime-reset",
  "scenario_name": "<AI填写：中文名称>",
  "capability": "余额和免费资源调账",
  "pattern_signature": "Adjustment",
  "intent_signature": "<AI填写>",
  "variant_signature": "OpType=5",
  "parameter_signature": "FreeUnitType|ExpireTime",
  "maturity": "provisional",
  "source_cases": ["US-20251120114137-1460730951_4444720"],
  "preparation_operations": ["OpType=1"],
  "operation_variants": [
    {
      "step_index": 3,
      "interface_template": "Adjustment",
      "op_type": "OpType=5",
      "role": "core",
      "construction_mode": "asset-plus-patches",
      "matched_asset_id": "10160",
      "matched_asset_slug": "cbs/test-steps/余额和免费资源调账",
      "match_kind": "semantic",
      "match_reason": "<AI填写>",
      "inline_recipe": null
    }
  ],
  "parameter_variants": [
    {
      "component": "SoapClient",
      "field_path": "AdjustmentRequestMsg.AdjustmentRequest.OpType",
      "operation": "replace-field",
      "asset_value": "1",
      "case_value": "5",
      "source_case": "US-20251120...",
      "confidence": "confirmed"
    }
  ],
  "test_points": [
    {
      "description": "<AI填写>",
      "verification_method": "<AI填写>",
      "expected_result": "<AI填写>"
    }
  ],
  "business_entities": [
    {
      "entity": "FreeUnitInstance",
      "relation": "operated-on",
      "created_by": "CreateCustomer",
      "modified_by": "Adjustment(OpType=5)",
      "evidence_type": "observed"
    }
  ],
  "variable_dependencies": [
    {
      "from_step": 0,
      "to_step": 3,
      "variable": "My_AcctKey",
      "producer_type": "soap-rvars",
      "consumer_location": "AdjustmentRequestMsg.AdjustmentRequest.AcctKey",
      "evidence": "Step[0] rVars.My_AcctKey -> Step[3] rReq.AcctKey",
      "confidence": "confirmed"
    }
  ],
  "steps": [
    {
      "step_index": 3,
      "step_name": "调整免费资源失效时间",
      "construction_mode": "asset-plus-patches",
      "matched_asset_id": "10160",
      "matched_asset_slug": "cbs/test-steps/余额和免费资源调账",
      "match_kind": "semantic",
      "match_reason": "<AI填写>",
      "patches": [FieldPatch],
      "inline_recipe": null,
      "reconstruction": null,
      "variable_inputs": ["My_AcctKey", "My_FUCode"],
      "variable_outputs": ["My_AdjResult"]
    }
  ],
  "unresolved_questions": ["<AI填写：不确定的分析结论>"]
}
```

## FieldPatch 字段补丁

```json
{
  "step_index": 3,
  "component": "SoapClient",
  "field_path": "AdjustmentRequestMsg.AdjustmentRequest.FreeUnitAdjustmentInfo.ExpireTime",
  "field_name": "ExpireTime",
  "operation": "replace-field",
  "asset_value": "20991231235959",
  "case_value": "${My_NewExpireTime}",
  "effective_runtime_value": "${My_NewExpireTime}",
  "field_description": "<AI填写：字段含义>",
  "reason": "<AI填写：≥5字符>",
  "evidence_sources": ["observed", "documented"],
  "confidence": "confirmed",
  "required_for_execution": true,
  "unresolved_question": null
}
```

### 字段填写规则

| 字段 | 填写者 | 要求 |
|------|--------|------|
| step_index/component/field_path/field_name/operation/asset_value/case_value | 脚本 | 自动填充 |
| effective_runtime_value | 脚本 | 自动填充（特殊值解析后的运行时实际值） |
| field_description | AI | 字段含义描述 |
| reason | AI | ≥5字符，解释为什么设置这个值 |
| evidence_sources | AI | 至少1项：declared/observed/documented/inferred |
| confidence | AI | confirmed/inferred/unresolved |
| required_for_execution | AI | true=生成用例时必须应用此补丁 |
| unresolved_question | AI | confidence=unresolved 时必须填写 |

## ScriptPatchItem 脚本补丁

脚本自动计算的补丁，不含 AI 字段。AI 必须为每个 ScriptPatchItem 提供对应的 FieldPatch。

```json
{
  "step_index": 3,
  "component": "SoapClient",
  "field_path": "AdjustmentRequestMsg.AdjustmentRequest.OpType",
  "field_name": "OpType",
  "operation": "replace-field",
  "asset_value": "1",
  "case_value": "5",
  "effective_runtime_value": "5",
  "auto_detected": true,
  "unresolved_question": null
}
```

## VariableDependency 变量依赖

```json
{
  "from_step": 0,
  "to_step": 3,
  "variable": "My_AcctKey",
  "producer_type": "soap-rvars",
  "consumer_location": "AdjustmentRequestMsg.AdjustmentRequest.AcctKey",
  "evidence": "Step[0] SoapClient.rVars.My_AcctKey -> Step[3] SoapClient.rReq.AcctKey",
  "confidence": "confirmed"
}
```

### producer_type 取值

| 类型 | 说明 | 检测方式 |
|------|------|---------|
| table-set-var | TableSetVar 组件赋值 | vars 字段 |
| soap-rvars | SoapClient 响应变量 | rVars 字段 |
| db-query-output | 数据库查询输出 | DataBaseQuery.vars |
| shell-execute | Shell 命令输出 | shellChecks |
| implicit-component | 组件隐式输出 | 未知组件标记为 unresolved |
| external-input | 外部输入 | 不在任何步骤中生产 |
| unresolved | 无法确定 | 兜底 |

## InlineRecipe 内联配方

未匹配步骤的完整配置保存：

```json
{
  "components": [
    {
      "aw_alias": "DataBaseQuery",
      "option_parameter": {
        "sql": "SELECT * FROM FREE_UNIT WHERE ACCT_KEY = '${My_AcctKey}'",
        "tableName": "FREE_UNIT",
        "connection": "CBS_DB"
      }
    }
  ],
  "variable_inputs": ["My_AcctKey"],
  "variable_outputs": ["My_FUCode", "My_FUBalance"],
  "description": "<AI填写：步骤用途>"
}
```

## ReconstructionResult 重建结果

validate-analysis.ts 自动生成，AI 无需填写：

```json
{
  "status": "semantic-equivalent",
  "key_field_coverage": 0.95,
  "total_field_coverage": 0.88,
  "unexplained_differences": [
    {
      "field_path": "AdjustmentRequestMsg.AdjustmentRequest.AdjustmentInfo._text",
      "reconstructed_value": "nocare",
      "original_value": "nocare",
      "possible_reason": "value matched after normalization"
    }
  ]
}
```

### status 取值

| 状态 | 说明 |
|------|------|
| exact | 重建结果与原始完全一致 |
| semantic-equivalent | 规范化后一致（key 排序、字符串编码差异） |
| unexplained-difference | 存在未解释的字段差异 |
| conflict | 关键字段冲突 |
| not-applicable | inline-recipe/external-source 步骤不适用 |

## construction_mode 判定规则

| 条件 | construction_mode |
|------|-------------------|
| match_kind = exact/semantic/reusable-base 且有 matched_asset_id | asset-plus-patches |
| match_kind = none/partial 且步骤有完整组件配置 | inline-recipe |
| 步骤依赖外部系统（如 DB 预置数据） | external-source |
| 证据不足，无法自动判定 | manual-required |

## 补丁 operation 类型

| operation | 检测逻辑 | 检测方式 |
|-----------|---------|---------|
| set-variable | TableSetVar.vars 中资产有占位符、用例填了实际值 | 确定性 |
| remove-variable | 资产有 vars、用例没有 | 确定性 |
| add-field | rReq 中用例有、资产没有的字段路径 | 确定性 |
| replace-field | rReq 中双方都有但值不同 | 确定性 |
| remove-field | 资产有、用例 rReq 中不存在的字段 | 确定性 |
| remove-field-override | 用例显式将字段设为空字符串或 null | 确定性 |
| set-nosend | 用例字段值 = "nosend" | 确定性 |
| set-nocare | 用例字段值 = "nocare" | 确定性 |
| set-norecv | 用例字段值 = "norecv" | 确定性 |
| runtime-bind | 用例字段值匹配 `${var}` | 确定性 |
| expression-bind | 用例字段值包含 `${G.` 或函数调用语法 | 确定性 |
| replace-request | 用例 rReq 根结构与资产完全不同 | 确定性 |
| add-component | 用例组件数 > 资产组件数 | 确定性 |
| remove-component | 用例组件数 < 资产组件数 | 确定性 |
| version-drift | 资产有字段但接口文档无定义 | 启发式 |

## AI 分析任务清单

1. 读取完整候选资产 JSON（必须）
2. 匹配裁决：确认或否决脚本匹配结果
3. 补丁增强：为每个 ScriptPatchItem 填写 reason/evidence_sources/confidence/field_description/required_for_execution
4. intent_signature 填写
5. scenario_name 填写（与 intent 对齐）
6. test_points 填写
7. business_entities 填写
8. variable_dependencies 确认或修正
9. unresolved_questions 填写
10. notes 按 Step[N] 格式填写

## 完整示例

见 `analysis-draft.json` 输出文件。每个场景包含完整的 steps[].patches 数组，每个 patch 有 13 个字段。
