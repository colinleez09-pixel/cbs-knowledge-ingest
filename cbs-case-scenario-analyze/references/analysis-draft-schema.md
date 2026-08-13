# AI 分析草稿 Schema

## 目录

- [概览](#概览)
- [AnalysisDraft 顶层结构](#analysisdraft-顶层结构)
- [AnalysisDraftScenario 场景结构](#analysisdraftscenario-场景结构)
- [AnalysisDraftStep 步骤结构](#analysisdraftstep-步骤结构)
- [ParamDeltaItem 参数 Delta](#paramdeltaitem-参数-delta)
- [ParamDependency 参数依赖](#paramdependency-参数依赖)
- [ScenarioKnowledge 场景知识](#scenarioknowledge-场景知识)
- [merge_mode 与场景判重](#merge_mode-与场景判重)
- [AI 分析任务清单](#ai-分析任务清单)
- [校验规则](#校验规则)
- [完整示例](#完整示例)

## 概览

AI 分析草稿（`analysis-draft.json`）是 AI 读取 `case-data.json` 后按本 Schema 生成的结构化分析结果，是 AI 与校验脚本之间的契约。

**职责分工**（脚本做确定性工作，AI 做语义工作）：

| 工作 | 执行者 |
|------|--------|
| 用例/接口文档/资产 JSON 解析 | 脚本（extract-case-data.ts） |
| 步骤指纹匹配（名称+组件序列+接口模板） | 脚本，输出 `match` 结果与置信度 |
| 参数 Delta 计算（变量级 add/remove/modify） | 脚本，输出 `script_deltas` |
| 匹配结论确认/修正（tentative 需 AI 裁决） | AI，不得推翻脚本 matched ≥0.75 的结论 |
| Delta 业务理由（为什么设置这个值） | AI，基于接口文档字段含义 |
| 场景归属判定（merge_mode + scenario_signature） | AI，基于已有场景列表判重 |
| 场景知识提炼（knowledge 四要素） | AI |
| 步骤间数据流分析 | AI |
| 页面草稿撰写（独立 md 文件） | AI |

核心原则：

- AI 基于用例**实际脚本参数**分析，用例名称/描述仅作参考线索（测试人员可能批量复制）
- AI 必须结合接口文档字段含义理解参数业务语义
- **脚本 delta 全覆盖**：脚本计算的每条 `script_deltas` 必须在 AI 的 `param_deltas` 中出现并附业务理由
- 页面草稿放在**独立 md 文件**（`page_draft_file` 引用），不内嵌 JSON（避免转义问题）

## AnalysisDraft 顶层结构

```json
{
  "schema_version": "cbs-scenario-analysis-v1",
  "analyzed_at": "2026-08-06T00:00:00.000Z",
  "source_case_data": "case-data.json",
  "scenarios": [AnalysisDraftScenario, ...]
}
```

## AnalysisDraftScenario 场景结构

```json
{
  "scenario_id": "SCN-FREEUNIT-EXPIRE",
  "name": "免费资源调账失效场景",
  "slug_en": "freeunit-expire-reset",
  "description": "客户存在未失效免费资源时，通过 Adjustment 接口 OpType=5 设置失效时间使其到期失效",
  "site_key": "cbs-ac3e294d",
  "site_id": "ac3e294d-35dc-49f2-bfe6-42a19055600f",
  "site_name": "CBS基线",
  "product_slug": "cbs/products/cbs",
  "source_cases": ["US-20251120114137-1460730951_4444720"],
  "merge_mode": "create",
  "target_scenario_slug": null,
  "scenario_signature": "Adjustment[OpType=5,FreeUnitAdjustmentInfo]",
  "test_points": [
    {
      "test_point": "免费资源到达设定失效时间后失效",
      "related_parameters": ["My_ExpirationTime", "OpType"],
      "design_reason": "验证 OpType=5 设置的失效时间生效后免费资源实例状态变更"
    }
  ],
  "steps": [AnalysisDraftStep, ...],
  "dependencies": [ParamDependency, ...],
  "missing_step_suggestions": [...],
  "variant_suggestions": [...],
  "scenario_knowledge": { ScenarioKnowledge },
  "similar_existing_scenarios": [
    {"slug": "cbs/scenarios/.../adjust-general", "title": "通用调账", "similarity_reason": "主接口相同但 OpType 不同，业务目的不同"}
  ],
  "page_draft_file": "page-SCN-FREEUNIT-EXPIRE.md"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| scenario_id | string | 是 | 场景标识（建议 `SCN-<英文缩写>`），analysis-notes.md 中必须出现 |
| name | string | 是 | 场景名（≥4 字符），基于实际行为命名 |
| slug_en | string | 是 | 语义化英文 kebab-case slug（4-48 字符），禁止占位值；最终页面 slug 为 `cbs/scenarios/{site_key}/{slug_en}`，页面 frontmatter slug 必须与其一致；命名规范见 scenario-schema.md「slug_en 命名规范」 |
| description | string | 是 | ≥10 字符，业务目的+典型流程 |
| site_key / site_id / site_name | string | 是 | 从 case-data 的 basic_info 获取 |
| product_slug | string | 是 | 产品 slug |
| source_cases | string[] | 是 | 用例 ID 列表，必须在 case-data 中存在；<2 触发 notability warning |
| merge_mode | string | 是 | `create` / `extend` |
| target_scenario_slug | string\|null | extend 必填 | extend 时目标已有场景页 slug，必须在 `existing_scenarios` 中 |
| scenario_signature | string | 是 | 场景签名，见下文格式 |
| test_points | array | 建议 | 测试点+关联参数+设计理由（空则 warning） |
| steps | AnalysisDraftStep[] | 是 | 步骤列表 |
| dependencies | ParamDependency[] | 是 | 可为空数组；引用的 step_index 必须存在 |
| missing_step_suggestions | array | 是 | 可为空数组 |
| variant_suggestions | array | 是 | 可为空数组 |
| scenario_knowledge | object | 是 | 见下文 |
| similar_existing_scenarios | array | 否 | 判重说明；GBrain 已有场景但本字段为空时 warning |
| page_draft_file | string | 是 | 页面草稿 md 文件路径（相对草稿文件目录或绝对路径） |

## AnalysisDraftStep 步骤结构

```json
{
  "step_index": 1,
  "behavior": "创建客户",
  "matched_step_asset_slug": "cbs/steps/cbs-ac3e294d/create-customer",
  "matched_asset_id": "88c5af8f-14d1-4f51-8370-cbfebf101735",
  "match_confidence": 0.95,
  "match_reason": "脚本指纹匹配：步骤名称+组件序列+接口模板三重一致",
  "source_case_refs": [{"case_id": "US-...", "step_index": 1}],
  "param_deltas": [ParamDeltaItem, ...]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| step_index | 是 | 与 case-data 中步骤的 step_index 对应 |
| behavior | 是 | 步骤行为描述 |
| matched_asset_id | 条件 | 匹配资产的 UUID；脚本 matched≥0.75 时不得为空 |
| matched_step_asset_slug | 可空 | 资产 GBrain 页 slug（case-data 的 match.matched_slug） |
| match_confidence | 是 | 采纳脚本值或 AI 修正值 |
| match_reason | 是 | 脚本 unmatched 但 AI 匹配时，必须 ≥10 字符充分说明 |
| source_case_refs | 是 | 来源用例步骤引用 |
| param_deltas | 是 | 见下文；可为空数组 |

## ParamDeltaItem 参数 Delta

**脚本已算好 delta 清单（case-data 的 `script_deltas`），AI 的职责是全覆盖并补业务理由：**

```json
{
  "step_index": 1,
  "change_type": "modify-default",
  "component_alias": "TableSetVar",
  "variable_name": "My_InitBalance",
  "field_path": "CreateCustomerRequest.Body.InitBalance",
  "field_description": "账户初始余额（Long，单位：货币精度最小单位）",
  "case_value": "0",
  "asset_default_value": "${My_InitBalance}",
  "reason": "后付费场景初始余额为 0，因为后付费用户先使用后付费，开户时无需预存"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| step_index | 是 | 所属步骤 |
| change_type | 是 | `add` / `remove` / `modify-default` / `modify-binding` |
| component_alias | 是 | 与 script_deltas 的 component_alias 一致（覆盖校验键） |
| variable_name | 是 | 与 script_deltas 的 variable_name 一致（覆盖校验键） |
| field_path | 建议 | 接口字段路径（从接口文档查得） |
| field_description | 建议 | 字段含义，含数据类型（String/Long/List 等）；缺失类型触发 warning |
| case_value | 是 | 场景实际值 |
| asset_default_value | 可空 | 资产默认值（占位符） |
| reason | 是 | 业务理由：解释**为什么设置这个值**；<15 字符或缺业务词触发 warning |

## ParamDependency 参数依赖

```json
{
  "from_step": 1,
  "to_step": 2,
  "from_param": "My_CustomerId",
  "to_param": "My_AcctId",
  "type": "variable-reference",
  "description": "创建客户输出的客户 ID 用于调账步骤的账户定位"
}
```

`type` 枚举：`variable-reference` / `env-var-passing` / `query-output`。

## ScenarioKnowledge 场景知识

**必填**。从历史用例+接口文档提炼的知识，让生成 AI 理解"为什么"：

```json
{
  "core_business_knowledge": "Adjustment 接口 OpType=5 用于设置免费资源失效时间，需前置系统参数 ar.adjust.modifyEffdate.supportType=Y，否则报错 503605064",
  "parameter_design_rationale": [
    {
      "parameter": "OpType",
      "field_path": "AdjustmentRequest.Body.OpType",
      "case_value": "5",
      "field_meaning": "调账操作类型（String）",
      "why_this_value": "5 表示设置免费资源失效时间",
      "business_context": "免费资源失效场景的核心操作标识"
    }
  ],
  "preconditions": ["系统参数已开启", "客户已创建且存在未失效免费资源"],
  "expected_results": ["到达失效时间后免费资源失效", "ChgAmt=0"],
  "key_decision_points": [
    {
      "parameter": "OpType",
      "field_path": "AdjustmentRequest.Body.OpType",
      "decision_impact": "决定调账操作的业务语义",
      "alternative_values": [{"value": "1", "meaning": "余额调增"}, {"value": "5", "meaning": "免费资源失效"}]
    }
  ]
}
```

| 子字段 | 必填 | 校验 |
|--------|------|------|
| core_business_knowledge | 是 | ≥20 字符（error） |
| parameter_design_rationale | 是 | 非空数组；每项含 parameter/field_meaning/why_this_value（error） |
| preconditions | 是 | 非空数组（error） |
| expected_results | 是 | 非空数组（error） |
| key_decision_points | 建议 | 关键参数的取值决策说明 |

## merge_mode 与场景判重

**按场景建页而非按用例**（十万级用例规模）：

1. AI 基于用例实际脚本计算 `scenario_signature`：`<主接口模板>[<关键判别参数=值>,...]`
2. 与 case-data 的 `existing_scenarios` 比对：
   - 无相似 → `merge_mode: "create"`
   - 签名一致/高度相似 → `merge_mode: "extend"` + `target_scenario_slug` 指向已有页
3. extend 模式：新用例的参数变体增量合入已有页（参数变体表），严禁覆盖

## AI 分析任务清单

1. 读 case-data.json：cases（含每步 match + script_deltas）、step_assets、existing_scenarios、interface_fields
2. 对每个用例：基于实际脚本+接口字段含义判定场景归属（签名判重）
3. 对每步：确认/修正脚本匹配（tentative 裁决），采纳 matched≥0.75
4. 对每条 script_delta：补 field_description（查接口文档）+ reason（业务理由）
5. 提炼 scenario_knowledge 四要素
6. 分析步骤间数据流 dependencies
7. 撰写页面草稿到独立 md 文件（8 章节结构见 scenario-schema.md）
8. 全程在 analysis-notes.md 记录分析证据（每个场景的 scenario_id/name/用例 ID 必须出现）

## 校验规则

validate-analysis.ts 的四层门禁（详见 SKILL.md）：

- **证据链（error）**：--analysis-notes 存在、≥200 字符、每个场景有记录
- **结构（error）**：必填字段、source_cases 存在、merge_mode 合法、extend 目标存在、signature 非空、page_draft_file 存在且含 frontmatter
- **一致性（error）**：AI 不得推翻脚本 matched≥0.75；script_deltas 全覆盖
- **质量（warning）**：field_description 含数据类型；reason 含业务理由词；notability ≥2 用例；wikilink 引用

**errors>0 时不生成 scenario-plan.json，退出码 1。**

## 完整示例

见本文档各章节内联示例。最小可过检草稿要求：1 个场景 + 全部必填字段 + 页面草稿文件 + analysis-notes.md。
