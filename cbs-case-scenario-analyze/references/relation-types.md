# 关系类型定义

## 目录

- [新增关系类型](#新增关系类型)
- [已有关系类型](#已有关系类型来自-cbs-step-asset-ingest)
- [关系创建规则](#关系创建规则)

## 新增关系类型

### composed_of_step

| 属性 | 值 |
|------|-----|
| from | cbs-scenario-pattern 页面 |
| to | cbs-test-step 页面 |
| 方向 | scenario -> step |
| 含义 | 场景由该步骤组成（角色/置信度写在场景页"步骤编排"章节） |

```bash
gbrain link cbs/scenarios/{siteKey}/{scenario} cbs/steps/{siteKey}/{step} --link-type composed_of_step
```

### evidenced_by

| 属性 | 值 |
|------|-----|
| from | cbs-scenario-pattern 页面 |
| to | cbs/cases/{case_id} 证据页 slug |
| 方向 | scenario -> evidence |
| 含义 | 场景由该历史用例支撑（用例 ID 同时记录在场景页"场景定义"章节 source_cases） |

```bash
gbrain link cbs/scenarios/{siteKey}/{scenario} cbs/cases/{case_id} --link-type evidenced_by
```

### param_flows_to

| 属性 | 值 |
|------|-----|
| from | cbs-test-step 页面（源步骤） |
| to | cbs-test-step 页面（目标步骤） |
| 方向 | source -> target |
| 含义 | 步骤间参数依赖（参数映射详情写在场景页"步骤间数据流"章节） |

```bash
gbrain link cbs/steps/{siteKey}/create-subscriber-postpaid cbs/steps/{siteKey}/general-adjustment --link-type param_flows_to
```

**注意**：真实 GBrain CLI 的 `link` 命令不支持 context/note 参数（`gbrain link <from> <to> [--link-type T] [--link-source S]`），关系的上下文信息必须写入场景知识页正文对应章节。

## 已有关系类型（来自 cbs-step-asset-ingest）

以下关系类型已由步骤资产入库 Skill 创建，场景分析 Skill 不重复创建：

| 关系类型 | 说明 |
|---------|------|
| `uses_component` | 步骤 -> 组件 |
| `accepts_parameter` | 步骤 -> 参数 |
| `variant_of` | 变体 -> 步骤 |
| `belongs_to_site` | 步骤 -> 局点 |
| `belongs_to_product` | 局点 -> 产品 |
| `version_of_site` | 版本 -> 局点 |
| `observed_in_version` | 步骤 -> 版本 |
| `derived_from` | 步骤 -> 原始数据 |
| `requires_step` | 步骤 -> 前置步骤 |
| `supports_parameter` | 变体 -> 参数 |

## 关系创建规则

1. `composed_of_step`：每个场景的每个已匹配步骤创建一条；角色和置信度写在场景页正文中
2. `evidenced_by`：每个场景的每个支持用例创建一条
3. `param_flows_to`：每对有参数依赖的已匹配步骤创建一条；参数映射写在场景页正文
4. 幂等：创建前用 `gbrain graph-query <from_slug> --type <link_type>` 查询已有边，已存在（同 from + to + type）则标记 `reused` 跳过
