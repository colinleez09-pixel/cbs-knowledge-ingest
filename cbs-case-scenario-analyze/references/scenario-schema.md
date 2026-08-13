# 场景页面 Schema

## 目录

- [概览](#概览)
- [Frontmatter 字段](#frontmatter-字段)
- [8 章节正文结构](#8-章节正文结构)
- [场景签名与增量维护](#场景签名与增量维护)
- [Timeline 格式](#timeline-格式)
- [Wikilink 使用要求](#wikilink-使用要求)
- [页面草稿位置](#页面草稿位置)
- [验证规则](#验证规则)

## 概览

CBS 场景知识页面存储在 GBrain 中，类型为 `cbs-scenario-pattern`。**按场景建页而非按用例**（十万级用例规模，同场景用例增量合入同一页面）。页面的最终消费者是"用例生成 AI"：读知识页 → 知道场景由哪几步组成（asset_id）→ 通过 API/source_path 获取步骤 JSON（template_json）→ 应用知识页记录的参数 Delta → 组装完整用例 JSON → 转 XML 用例文件。

页面必须让生成 AI 回答 4 个问题：

1. 这个场景是什么、测什么、为什么这样构建（场景定义）
2. 场景由哪几个步骤组成、每步关联哪个测试步骤资产（步骤编排）
3. 每个步骤的参数如何在通用资产基础上修改（参数 Delta）
4. 步骤与步骤之间参数如何传递（步骤间数据流）

## Frontmatter 字段

```markdown
---
slug: cbs/scenarios/<siteKey>/<scenario-slug>
type: cbs-scenario-pattern
title: <场景名称>
tags: [cbs, scenario, <siteKey>]
source: cbs-case-scenario-analyze
scenario_signature: <场景签名，见下文>
site_key: <siteKey>
---
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `slug` | 是 | `cbs/scenarios/{siteKey}/{slug_en}`；leaf 来自草稿 `slug_en` 字段（AI 提供的语义化英文 kebab-case），禁止无语义哈希 |
| `type` | 是 | 固定 `cbs-scenario-pattern` |
| `title` | 是 | 场景名称（AI 基于实际脚本行为命名，非用例标题） |
| `tags` | 是 | 至少含 `cbs`、`scenario`、`siteKey` |
| `source` | 是 | 固定 `cbs-case-scenario-analyze` |
| `scenario_signature` | 是 | 场景签名，判重与增量合并依据 |
| `site_key` | 是 | 站点标识 |

## slug_en 命名规范（GBrain 设计理念强制要求）

GBrain 中 slug 是页面主键、Markdown 文件路径、FTS 关键词索引锚点、wikilink 图谱节点——必须人类可读且可搜索。禁止 `scenario-<hash8>` 这类无语义命名。

**格式**：`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`，长度 4-48，2-6 个词

**命名模式**：`<业务对象>-<操作>[-<限定>]`

| 词性 | 推荐词汇（领域词表） |
|------|------|
| 业务对象 | freeunit（免费资源）/ balance（余额）/ credit（信用度）/ subscriber（用户）/ customer（客户）/ account（账户）/ reward（奖励金）/ autobuy（自动订购）/ feequote（费用探寻）/ pa（承诺付费） |
| 操作 | create / adjust（调账）/ expire（失效）/ reset（重置）/ query / explore / increase / decrease / open（开户）/ close |
| 限定 | optype5 / prepaid（预付费）/ postpaid（后付费）/ month-end（月结） |

**示例**：
- `freeunit-expire-reset`（免费资源失效时间重置，OpType=5）
- `subscriber-create-postpaid`（后付费开户）
- `balance-adjust-decrease`（余额调减）
- `reward-autobuy-month-end`（奖励金+AutoBuy+月结）

**校验**（validate-analysis 硬门禁）：占位值（todo-*）/ 格式非法 / 页面 frontmatter slug 与草稿 slug_en 推导结果不一致 → 全部 error。

## 8 章节正文结构

### 1. 场景定义

- 场景一句话描述、业务目的
- 测试点列表：每个测试点关联的关键参数及解释（为什么这样构建用例）
- 前置条件、预期结果

### 2. 步骤编排

| 顺序 | 步骤行为 | 资产名称 | asset_id | GBrain 页 | 匹配置信度 |
|------|----------|----------|----------|-----------|------------|
| 1 | 创建客户 | 创建客户 | 88c5af8f-... | [[cbs/steps/.../create-customer]] | 0.95 |

- asset_id 是测试资产平台真实 ID，生成用例时凭它经 API 获取步骤 JSON
- GBrain 页 slug 用 wikilink 引用（自动建链）

### 3. 参数 Delta（每步一节）

在通用步骤资产 template_json 之上的精确修改清单（脚本已预算，AI 补充业务理由）：

| 组件 | 变量 | 变更 | 资产值 | 场景值 | 业务理由 |
|------|------|------|--------|--------|----------|
| TableSetVar | My_InitBalance | modify | `${My_InitBalance}` | `0` | 后付费场景初始余额为 0 |
| TableSetVar | My_PaymentMode | add | ∅ | `1` | 标识后付费模式 |
| TableSetVar | My_AcctPaymentType | remove | `${My_AcctPaymentType}` | ∅ | 本场景不涉及 |

- 变更类型：`add` / `remove` / `modify`
- 业务理由必须解释"为什么设置这个值"，而非仅描述"值是什么"

### 4. 步骤间数据流

| 来源步骤 | 目标步骤 | 来源参数 | 目标参数 | 类型 | 说明 |
|----------|----------|----------|----------|------|------|
| 1 创建客户 | 2 调账 | My_CustomerId | My_AcctId | variable-reference | 创建输出的客户 ID 定位调账账户 |

### 5. 验证点

每个验证步骤检查什么、期望值如何从前面步骤导出。

### 6. 参数变体表（增量维护核心）

同场景不同用例的参数取值变体，增量合入而非覆盖：

| 参数 | 用例 A | 用例 B | 说明 |
|------|--------|--------|------|
| My_InitBalance | 0 | `${900*C_ChargePrecision}` | 初始余额变体 |

### 7. 无资产步骤（如有）

未匹配到资产的步骤：组件序列、接口模板、关键参数结构、入库建议（missing_step_suggestions）。

### 8. 用例生成指引

面向生成 AI 的组装说明：获取资产 JSON 的方式（API 优先，source_path 兜底）、delta 应用顺序、变量替换规则。

## 场景签名与增量维护

### scenario_signature 格式

`<主接口模板>[<关键判别参数=值>, ...]`，示例：

- `Adjustment[OpType=5,FreeUnitAdjustmentInfo]` — 免费资源失效调账
- `CreateSubscriber[PaymentMode=1]+CreatePA[]+Payment[]` — PA 承诺付费

签名由 AI 基于用例实际脚本（rTpl + 关键参数值）生成，用于：

1. **判重**：新用例分析时，AI 计算签名并与 `case-data.json` 的 `existing_scenarios` 对比
2. **merge_mode 决策**：
   - `create`：签名与所有已有场景不相似 → 新建页面
   - `extend`：签名与某已有场景一致/高度相似 → 增量合入该页（`target_scenario_slug` 指向目标页）

### extend 模式行为

- 页面 slug 沿用 `target_scenario_slug`
- 新用例的参数变体追加到"参数变体表"
- 新发现的 delta 追加到"参数 Delta"
- Timeline 追加 `extend: merged cases ...` 条目（含幂等 marker）
- 严禁覆盖已有 Compiled Truth 内容

## Timeline 格式

Timeline 位于正文 `---` 分隔符之后，追加式证据链：

```markdown
### <ISO 时间戳> | cbs-case-scenario-analyze

create: from historical cases: US-001, US-003 [idem:cbs-scenario|<hash16>]

- 计划 SHA-256：<hash 前 16 位>
```

- extend 模式条目：`extend: merged cases US-007 into existing scenario [idem:...]`
- 幂等 marker 由脚本生成，重复执行自动跳过

## Wikilink 使用要求

GBrain `put` 时自动从正文提取 `[[wikilink]]` 建链：

1. 步骤编排表中 GBrain 页 slug 必须 `[[...]]` 包裹
2. 场景间关联用 wikilink 引用
3. 不使用别名语法 `[[slug|alias]]`
4. wikilink 与 `gbrain link` 的 typed edges 互补，都不可省略

## 页面草稿位置

页面草稿**不内嵌**在 analysis-draft.json 中（避免 JSON 转义地狱），而是：

- 每个场景一个独立 md 文件：`page-<scenario_id>.md`（与 analysis-draft.json 同目录）
- 草稿 JSON 中 `scenarios[].page_draft_file` 字段记录文件名（相对路径）
- validate-analysis.ts 校验文件存在、含 `type: cbs-scenario-pattern` frontmatter、正文 ≥100 字符

## 验证规则

脚本校验页面草稿时检查：

1. frontmatter 含 `type: cbs-scenario-pattern`
2. 正文 ≥100 字符
3. 步骤编排表中已匹配资产的 slug 以 `[[...]]` 引用（warning）
4. merge_mode=extend 时 target_scenario_slug 必须存在于 GBrain 已有场景列表（error）
5. 脚本计算的每条 script_delta 必须在 AI 的 param_deltas 中出现且带业务理由（error）
6. AI 不得推翻脚本高置信匹配（matched ≥0.75 被置空 → error）

## 与步骤资产页面的关系

```
cbs/scenarios/<siteKey>/<scenario>
  --composed_of_step--> cbs/steps/<siteKey>/<step>     （仅置信度 ≥0.75）
  --evidenced_by-----> cbs/cases/<case_id>
```

步骤资产页之间：`--param_flows_to-->`（步骤间数据流，两端都有资产 slug 时创建）。
