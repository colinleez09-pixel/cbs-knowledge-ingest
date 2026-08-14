# 场景页面 Schema (v2.0)

## 目录

- [概览](#概览)
- [页面类型](#页面类型)
- [scenario-plan 页面](#scenario-plan-页面)
- [analysis-data 页面](#analysis-data-页面)
- [安全 extend 合并规则](#安全-extend-合并规则)
- [Timeline 格式](#timeline-格式)

## 概览

CBS 场景知识页面存储在 GBrain 中，按场景建页。每个场景包含两个页面：
- **scenario-plan**：人类可读的场景计划页（Markdown + frontmatter）
- **analysis-data**：机器可读的结构化数据页（JSON in code block）

页面消费者是用例生成 AI：读 analysis-data → 获取步骤 recipe（asset_id + patches 或 inline_recipe）→ 通过 API 获取步骤 JSON → 应用 patches → 组装完整用例 JSON → 转 XML。

## 页面类型

### scenario-plan 页面

**slug 格式**：`cbs/scenarios/<site-key>/<scenario-id>/scenario-plan`

**frontmatter**:
```yaml
---
title: <中文场景名>
description: <一句话描述>
capability: <业务能力>
pattern_signature: <模式签名>
intent_signature: <意图签名>
variant_signature: <变体签名>
parameter_signature: <参数签名>
maturity: provisional | stable
source_cases: [case-id-1, case-id-2]
preparation_operations: [OpType=1]
analysis_data_slug: cbs/scenarios/<site-key>/<scenario-id>/analysis-data
---
```

**正文**：Operation Variants 表格 + Parameter Variants 表格 + Test Points 表格 + Business Entities + Notes

### analysis-data 页面

**slug 格式**：`cbs/scenarios/<site-key>/<scenario-id>/analysis-data`

**内容**：JSON code block，结构如下：

```json
{
  "schema_version": "2.0.0",
  "scenario_id": "<scenario-id>",
  "scenario_name": "<中文名>",
  "capability": "<业务能力>",
  "signatures": {
    "pattern": "<pattern_signature>",
    "intent": "<intent_signature>",
    "variant": "<variant_signature>",
    "parameter": "<parameter_signature>"
  },
  "maturity": "provisional",
  "source_cases": ["case-id-1"],
  "preparation_operations": ["OpType=1"],
  "operation_variants": [
    {
      "step_index": 3,
      "interface_template": "Adjustment",
      "op_type": "OpType=5",
      "role": "core",
      "construction_mode": "asset-plus-patches",
      "matched_asset_id": "10160",
      "matched_asset_slug": "cbs/test-steps/...",
      "match_kind": "semantic",
      "match_reason": "<AI填写>",
      "inline_recipe": null
    }
  ],
  "parameter_variants": [
    {
      "component": "SoapClient",
      "field_path": "...OpType",
      "operation": "replace-field",
      "asset_value": "1",
      "case_value": "5",
      "source_case": "case-id-1",
      "confidence": "confirmed"
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
      "consumer_location": "...AcctKey",
      "evidence": "Step[0] -> Step[3]",
      "confidence": "confirmed"
    }
  ],
  "test_points": [
    {
      "description": "...",
      "verification_method": "...",
      "expected_result": "..."
    }
  ],
  "steps": [
    {
      "step_index": 3,
      "step_name": "...",
      "construction_mode": "asset-plus-patches",
      "matched_asset_id": "10160",
      "matched_asset_slug": "cbs/test-steps/...",
      "match_kind": "semantic",
      "match_reason": "<AI填写>",
      "patches": [
        {
          "component": "SoapClient",
          "field_path": "...OpType",
          "field_name": "OpType",
          "operation": "replace-field",
          "asset_value": "1",
          "case_value": "5",
          "effective_runtime_value": "5",
          "field_description": "<AI填写>",
          "reason": "<AI填写>",
          "evidence_sources": ["observed", "documented"],
          "confidence": "confirmed",
          "required_for_execution": true,
          "unresolved_question": null
        }
      ],
      "inline_recipe": null,
      "reconstruction": {
        "status": "semantic-equivalent",
        "key_field_coverage": 0.95,
        "total_field_coverage": 0.88,
        "unexplained_differences": []
      },
      "variable_inputs": ["My_AcctKey"],
      "variable_outputs": ["My_AdjResult"]
    }
  ],
  "unresolved_questions": []
}
```

## 安全 extend 合并规则

写入 analysis-data 前必须执行：

1. **回读**：`gbrain get` 读取现有 analysis-data 页面
2. **解析**：解析已有 JSON 结构
3. **合并规则**：

| 字段 | 合并策略 |
|------|---------|
| source_cases | 并集 |
| signatures | 不变（同场景才 extend） |
| maturity | 取最高值（stable > provisional） |
| operation_variants | 并集（按 step_index + op_type 去重） |
| parameter_variants | 并集（按 component + field_path + operation 去重） |
| steps | 按 step_index 合并；patches 追加（不覆盖已有 patch） |
| steps.reconstruction | 保留最新 |
| business_entities | 并集（按 entity 去重） |
| variable_dependencies | 并集 |
| test_points | 并集 |
| unresolved_questions | 并集，永不删除 |

4. **冲突处理**：同 step_index + 同 field_path 但不同 case_value → 保留两者，生成 unresolved_question
5. **写入**：写入合并后的 JSON

## Timeline 格式

```json
{
  "slug": "cbs/scenarios/<site-key>/<scenario-id>/scenario-plan",
  "date": "2026-08-11",
  "entry": "ingest case US-20251120... (v2.0.0)",
  "idempotency_marker": "sha256:<hash-of-source-case>"
}
```
