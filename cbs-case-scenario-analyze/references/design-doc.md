# cbs-case-scenario-analyze 设计文档

> 本文档记录本 Skill 的完整设计方案、背景、关键决策与变更历史。
> 面向后续维护者与其他 AI 模型：修改本 Skill 前必须先阅读本文档；每次方案变更必须追加变更记录。

## 目录

- [1. 背景与目标](#1-背景与目标)
- [2. 总体架构](#2-总体架构)
- [3. 关键设计决策](#3-关键设计决策)
- [4. 数据结构契约](#4-数据结构契约)
- [5. GBrain 集成规范（真实 CLI）](#5-gbrain-集成规范真实-cli)
- [6. 步骤资产匹配设计](#6-步骤资产匹配设计)
- [7. 参数 Delta 计算设计](#7-参数-delta-计算设计)
- [8. 场景判重与增量维护](#8-场景判重与增量维护)
- [9. 资产 JSON 获取策略](#9-资产-json-获取策略)
- [10. 分析真实性门禁](#10-分析真实性门禁)
- [11. 输出目录策略](#11-输出目录策略)
- [12. 变更记录](#12-变更记录)

---

## 1. 背景与目标

### 1.1 业务背景

- 用户的测试资产平台中积累了 **十万级** CBS 5G 计费系统历史测试用例（JSON 格式）。
- 测试步骤资产（Step Asset）已通过 `cbs-step-asset-ingest` Skill 入库到 GBrain 知识库。
- 历史用例中的"知识"（为什么这样填参、步骤怎么组合）目前只存在于测试人员的经验中，没有被结构化沉淀。

### 1.2 最终目标（用例生成闭环）

本 Skill 是闭环的**上游（知识沉淀）**，下游是未来的"用例生成 AI"。完整闭环：

```
历史用例 JSON + 接口文档
  → (本 Skill) 场景知识页写入 GBrain
  → 生成 AI 读取场景知识页，获知：
      1) 场景由哪几个步骤组成（步骤资产 asset_id）
      2) 每个步骤在本场景下的参数 delta（添加/删除/修改哪些参数）
      3) 步骤间参数关联关系
  → 生成 AI 通过 asset_id 调用资产导出接口（或本地 source_path）获取步骤 JSON 骨架
  → 应用知识页中的 delta 完善 JSON
  → 组装完整用例 JSON → 转换为 XML 用例文件
```

**知识页设计的根本判据**：生成 AI 只读知识页 + 资产 JSON，就能准确构建出该场景的用例，不需要再回查历史用例。

### 1.3 核心约束（来自用户的明确决策）

| 编号 | 约束 | 决策来源 |
|------|------|---------|
| C1 | 用例名称和描述**不可信**（测试人员批量复制），仅作参考线索；必须以实际脚本参数和接口文档为准 | 用户反复强调 |
| C2 | 脚本做确定性计算与校验；AI 做语义分析与知识提炼。**不信任 AI 的纯文本输出**，脚本必须验证 AI 确实做了分析 | 用户明确要求 |
| C3 | 按**场景**建页，不按用例建页（十万级用例规模下用例级页面不可行）；同场景新用例增量维护而非覆盖 | 用户明确决策 |
| C4 | 资产 JSON 与 GBrain 资产页不同步时，**以资产 JSON 为准** | 用户确认 |
| C5 | 场景判重以"AI 判定为主 + Timeline 可审计"兜底 | 用户确认 |
| C6 | 输出文件不放 temp 目录；放在用例目录下带时间戳的子目录，避免互相覆盖 | 用户明确要求 |
| C7 | 运行环境为 Windows PowerShell 5.1（不支持 `&&`、不支持 `<` 重定向、ps1 需 ExecutionPolicy Bypass） | 实际执行环境 |

---

## 2. 总体架构

### 2.1 三阶段工作流

```
Phase 1 analyze:
  Step 1  extract-case-data.ts  (脚本) → case-data.json
  Step 2  AI 语义分析                    → analysis-notes.md + analysis-draft.json + page-*.md
  Step 3  validate-analysis.ts  (脚本) → scenario-plan.json + validation-report.md
Phase 2 authorize:
  authorize-scenario-plan.ts    (脚本) → plan.authorized = true（SHA-256 双 hash 防篡改）
Phase 3 apply:
  apply-scenario.ts             (脚本) → GBrain 写入 + 幂等 + 健康检查 → apply-result.json + apply-report.md
```

### 2.2 脚本与 AI 的职责分工

| 任务 | 执行者 | 理由 |
|------|--------|------|
| 用例 JSON 解析、步骤指纹提取 | 脚本 | 确定性计算 |
| 接口文档字段解析 | 脚本 | 确定性计算 |
| 步骤资产指纹匹配（名称+组件序列+rTpl） | 脚本 | 结构同源，可精确比对 |
| vars/option_parameter 级 delta 计算 | 脚本 | 字符串级精确对比 |
| 场景归属判定（新场景/已有场景） | AI | 语义判断；Timeline 记录判定理由供审计 |
| Delta 业务含义解释、测试点提炼 | AI | 需要接口文档语义理解 |
| 场景知识总结（4 要素） | AI | 知识提炼 |
| 分析真实性校验（门禁） | 脚本 | 防止 AI 胡编乱造 |
| 计划完整性（SHA-256）、授权、幂等写入 | 脚本 | 确定性计算 |

---

## 3. 关键设计决策

### D1: 混合模式而非纯脚本

纯脚本无法做语义分析（场景识别、知识提炼）；纯 AI 无法保证确定性（hash、幂等、校验）。因此采用"脚本提取 + AI 分析 + 脚本校验"三段式。

### D2: 匹配与 delta 计算脚本化（v0.3.0 重大转向）

早期版本让 AI 通过 `gbrain get` 逐个读资产页做匹配（21 分钟、confidence 不可验证）。
确认资产 JSON 与用例结构**同源**后（见 4.1/4.2），匹配与 delta 改为脚本精确计算：

- 用例 `Test_Steps[i].case_option[]` ↔ 资产 `step.template_json.case_option[]`，结构完全一致
- 指纹匹配三要素：`case_step` 名称 / `aw_alias` 组件序列 / `option_parameter.rTpl` 接口模板
- vars 变量级 delta（添加/删除/修改）为字符串解析后的集合运算

AI 只解释 delta 的业务含义。

### D3: 场景判重签名

场景签名 = 主接口操作序列 + 关键业务参数特征（如 `Adjustment[OpType=5]`）。
脚本提取签名候选，AI 结合已有场景页列表做归属判定。
误判兜底：每次 extend 合并强制写 Timeline（来源用例 + 合并理由），可审计可回查。

### D4: 分析真实性门禁（四层）

用户明确要求"不信任 AI 输出，由门禁保证 AI 确实分析了"：

1. **证据链**：AI 必须产出 `analysis-notes.md`（分析过程记录），脚本检查每个场景在其中必有分析记录
2. **交叉验证**：draft 中引用的 case_id / step_asset_slug / field_path 必须真实存在于 case-data.json
3. **质量启发式**：field_description 应含数据类型与业务语义；reason 应含 rationale 关键词
4. **一致性**：delta 的 case_value 必须与原始用例数据一致（防 AI 篡改数值）

完整性类检查（V16-V18）为 **warning 级**——避免 AI 陷入反复重写循环（实测曾导致 21 分钟执行失败）；真实性类检查为 **error 级**。

### D5: page_draft 拆分独立文件

AI 在超长 JSON 字符串中嵌入 Markdown 导致转义地狱（多次执行失败根因）。
改为：每个场景一个 `page-<slug>.md` 独立文件，draft JSON 中只存 `page_draft_file` 路径引用。

### D6: 接口字段渐进式加载

实测 case-data.json 中 interface_fields 占 77%（24.5K/31.8K 字符），稀释 AI 上下文。
脚本预过滤：只保留用例步骤 template_json 实际涉及接口的字段；全量字段写入独立文件/目录，AI 按需查阅。

---

## 4. 数据结构契约

### 4.1 用例 JSON 结构（真实样本确认）

```jsonc
{
  "Testcase_Name": "用例名称",
  "Test_Steps": [
    {
      "case_step": "创建客户",            // 步骤名称（可能与资产 name 直接相等）
      "case_option": [                     // 组件序列
        {
          "aw_alias": "TableSetVar",       // 组件名
          "option_parameter": {
            "vars": "My_A=1;My_B=${X}",    // TableSetVar 的变量赋值
            "rTpl": "@\\soap\\CreateCustomer.xml",  // SoapClient 的接口模板
            "rReq": "<xml>...</xml>",      // 请求体
            "rVars": "..."                 // 响应取值
          }
        }
      ]
    }
  ]
}
```

### 4.2 步骤资产 JSON 结构（真实样本确认）

```jsonc
{
  "step": {
    "id": "6fb88e27-b395-4046-b80c-26fbc17c9cec",  // 资产 ID（资产平台真实 UUID）
    "name": "通用调账",
    "status": "APPROVED",
    "composition": "fixed-sequence",
    "template_json": {                 // 步骤的用例脚本骨架（对象，非字符串）
      "case_step": "通用调账",
      "case_option": [
        {
          "aw_alias": "TableSetVar",
          "option_parameter": { "vars": "My_InitBalance=${My_InitBalance};..." },
          "parameter_meta": {          // 开放参数元数据（权威参数解释来源）
            "vars.My_InitBalance": {
              "description": "初始余额",
              "suggested_default": "5000000000",
              "is_open": true
            }
          }
        }
      ]
    },
    "source_context": { "product_name": "CBS", "site_id": "...", "site_version": "..." }
  }
}
```

### 4.3 GBrain 步骤资产页结构（cbs-test-step-v7，真实页面确认）

- frontmatter：`asset_id`、`site_key`、`english_business_name`、`chinese_business_name`、`interface_operation_hints`、`component_slugs`、`source_path`（本地原始 JSON 路径，fallback 用）、`definition_hash` 等
- 正文：用例生成卡片（开放参数速览）、组件流程表（含接口模板列 `@\soap\Xxx.xml`）、开放参数表、nosend 字段表、响应校验/取值字段、Timeline

### 4.4 场景知识页结构（8 章节，面向生成闭环设计）

```
---frontmatter---
slug / title / type: cbs-scenario-pattern / tags / site_key
scenario_signature       # 场景签名（判重用）
source: cbs-case-scenario-analyze
source_cases: [用例ID...]
asset_refs: [asset_id...]   # 生成用例时取资产 JSON 的依据
---
# 场景名
## 场景定义       —— 场景描述；测试点清单（测试点 ↔ 关联参数 ↔ 为什么这样设计）；前置条件（系统参数开关/站点/数据准备）
## 步骤编排       —— 步骤序列表：顺序 | 资产 slug | asset_id | variant_id | 组件链 | 接口模板 | 本场景角色
## 参数 Delta     —— 每步精确 delta 表：变量/字段 | delta类型(添加/删除/修改) | 资产默认值 | 场景值 | 业务理由
## 步骤间数据流   —— 上游产出变量 → 下游引用点
## 验证点         —— 响应码 / 数据库查询(表+条件+预期值) / 日志检查
## 参数变体表     —— 增量维护载体：参数 | 取值 | 来源用例 | 适用说明（逐行追加，不覆盖）
## 无资产步骤     —— 系统参数设置等未资产化步骤的组件结构（生成时临时构建）
## 用例生成指引   —— 明确指令：取 asset_id → 获取资产 JSON → 应用参数 Delta → 组装 → 转 XML
## Timeline       —— 每次增量维护记录（来源用例 + 合并理由）
```

### 4.5 中间产物

- `case-data.json`：用例解析结果 + 预过滤接口字段 + 资产匹配与 delta 计算结果
- `analysis-notes.md`：AI 分析过程记录（门禁证据链）
- `analysis-draft.json`：AI 分析结果（merge_mode/scenario_knowledge/delta 业务理由/page_draft_file 引用）
- `page-<slug>.md`：场景页面草稿（独立 Markdown 文件）
- `scenario-plan.json`：校验通过后的写入计划（含 SHA-256）
- `apply-result.json` / `apply-report.md`：执行结果与报告

---

## 5. GBrain 集成规范（真实 CLI）

> 版本：GBrain 0.42.57.0（用户本机实测）。**严禁使用任何未在下表列出的命令或参数形式。**

| 操作 | 真实命令 | 说明 |
|------|---------|------|
| 写页面 | `gbrain put <slug> < file.md` | stdin 重定向；frontmatter 在文件内。PowerShell: `Get-Content file.md \| gbrain put <slug>` |
| 读页面 | `gbrain get <slug>` | 文本输出（frontmatter + Markdown + Timeline），**非 JSON** |
| 列页面 | `gbrain list --type <T>` | **文本表格输出**（slug \t type \t date \t title），`--json` 在此版本不生效 |
| 关键词搜索 | `gbrain search <query>` | 文本输出 |
| 混合检索 | `gbrain query <question>` | 文本输出 |
| 建关系 | `gbrain link <from_slug> <to_slug> --link-type <T>` | 位置参数 |
| 删关系 | `gbrain unlink <from_slug> <to_slug> [--link-type <T>]` | |
| 加 Timeline | `gbrain timeline-add <slug> <date> <text>` | 位置参数；date 格式 YYYY-MM-DD |
| 图查询 | `gbrain graph-query <slug> --type <T>` | |
| 统计 | `gbrain stats` | 实测可用（Pages/Chunks/Links/Tags/Timeline + By type） |
| 健康检查 | `gbrain doctor` / `gbrain orphans` / `gbrain refs <slug>` | |

**已证伪的命令**（早期设计错误，禁止使用）：`write`、`get_page`、`capture`、`link --data`、`timeline-add --data`、`list --json`（不生效）。

---

## 6. 步骤资产匹配设计

脚本化三重指纹匹配（extract-case-data.ts 内实现）：

1. **名称匹配**：用例 `case_step` 与资产 `name`/`english_business_name` 精确或归一化后相等
2. **组件序列匹配**：`aw_alias` 序列完全一致
3. **接口模板匹配**：SoapClient 的 `option_parameter.rTpl` 相等

评分：三项全中 = 高置信直接匹配；部分命中 = 候选交 AI 裁决；全不中 = 记入 missing_step_suggestions。

匹配结果（含 asset_id）写入 case-data.json，AI 不再逐个读取资产页。

## 7. 参数 Delta 计算设计

脚本对每个已匹配步骤计算：

- **vars 变量级**：解析 `TableSetVar.option_parameter.vars`（`k=v;k=v` 格式）为集合，对比资产与用例：
  - `added`：用例有、资产无（场景特有变量）
  - `removed`：资产有、用例无（场景未用开放参数）
  - `modified`：共有但值不同（开放占位符 → 场景具体值）
- **option_parameter 键级**：其他组件的参数键集合对比
- 每条 delta 附 `parameter_meta` 中的 description/suggested_default（如有）

AI 的职责仅剩：为每条 delta 补 `reason`（业务理由，引用接口文档）。

## 8. 场景判重与增量维护

- `merge_mode: "create"`：新场景 → 新建页面
- `merge_mode: "extend"`：属于已有场景 → AI 先 `gbrain get` 读旧页 → 合并（参数变体表追加行、测试点补充、source_cases 追加）→ 整体 `gbrain put` 更新 → `timeline-add` 记录（来源用例 + 合并理由）
- 页面 frontmatter 存 `scenario_signature` 辅助判重
- 页面内容幂等：content SHA-256 比对，无变化跳过写入

## 9. 资产 JSON 获取策略

三级获取，优先级从高到低：

1. **`--step-assets-dir <dir>`**：直接读取本地目录的 `*.json`（开发与测试主路径）
2. **API（预留）**：`--asset-api-url <base_url>` + 认证信息
   - 登录：`POST {base}/api/auth/login`，body `{username, password}` → `data.token`
   - 导出：`GET {base}/api/test-steps/{asset_id}/export`，Header `Authorization: Bearer <token>`
   - 响应 `{version, type, exported_at, step: {...}}`，`step` 结构与本地 JSON 一致
   - 凭证通过环境变量/参数传入，禁止硬编码
3. **GBrain source_path fallback**：从资产页 frontmatter 的 `source_path` 读取本地原始 JSON

## 10. 分析真实性门禁

见 D4。实现于 validate-analysis.ts，规则编号 V1-V19（error/warning 分级详见 references/analysis-draft-schema.md）。

## 11. 输出目录策略

- `--out-dir` 显式指定优先
- 未指定时默认 `<用例目录>/cbs-scenario-analyze-<timestamp>/`；已存在则追加新时间戳区分
- 目录下产出 `output-dir.txt`（记录自身绝对路径，供后续脚本/AI 定位）
- 禁止使用系统 temp 目录

---

## 12. 变更记录

### v0.1.0（初始版本）
- 纯脚本分析管线（step-matcher/scenario-cluster/param-delta），后被证明无法做语义分析。

### v0.2.0（混合模式重构）
- 删除纯脚本分析管线，改为"脚本提取 + AI 分析 + 脚本校验"三段式。
- 新增 extract-case-data.ts / validate-analysis.ts / authorize-scenario-plan.ts / apply-scenario.ts。
- 新增 analysis-draft-schema.md（AI 输出契约）。

### v0.2.1（GBrain 合规与幂等）
- 三层幂等：页面 content SHA-256 比对、Timeline marker 查重、关系 graph-query 预检。
- 授权双 hash（dry_run/authorized payload SHA-256）。
- Brain-First 查重（list 已有场景页）、notability 门槛（初始为 error，后降 warning）、wikilink 建链、写入后健康检查（死链/孤儿/标签）。

### v0.2.2（真实运行问题修复）
- 接口文档解析支持中文表头（参数/数据类型/参数描述）与 `**表N ElementName**` 标签；path 缺省取 name；interface_fields 结构统一为 `{elements: []}`。实测 0 → 49 接口 / 202 字段映射。
- loadStepAssets 改 `gbrain list --type cbs-test-step`（原 search 语法不生效），三级 fallback。
- 输出目录策略（C6）：时间戳子目录 + output-dir.txt。
- Windows PowerShell 注意事项（C7）写入 SKILL.md。

### v0.2.3（分析质量与门禁）
- 新增 scenario_knowledge 四要素（core_business_knowledge / parameter_design_rationale / preconditions / expected_results）。
- 分析真实性门禁四层（证据链 analysis-notes.md / 交叉验证 / 质量启发式 / 一致性）。
- 完整性检查 V16-V19 降为 warning（避免 AI 反复重写导致 21 分钟执行失败）。
- analysis-notes.md 模板写入 SKILL.md。

### v0.3.0（真实数据驱动的重大重构，本次）
背景：获得真实 GBrain 数据、真实资产 JSON、6 个真实用例、资产导出接口示例。

1. **GBrain CLI 全面纠正**（见第 5 节）：apply-scenario.ts 命令层重写为 put/get/list/link/timeline-add 真实语法；删除不存在的 capture/stats 误用（stats 实测存在，保留）；list 输出按文本表格解析。
2. **匹配与 delta 脚本化**（D2）：依据资产 JSON 与用例结构同源的事实，extract-case-data.ts 新增指纹匹配与 vars 级 delta 计算；AI 不再逐个读资产页。
3. **资产 JSON 三级获取策略**（第 9 节）：新增 fetch-asset-by-id.ts（API 骨架，按 test_export_api.py 契约实现）。
4. **按场景建页 + create/extend 双模式**（C3/C5）：新增 scenario_signature 与 merge_mode。
5. **知识页 8 章节结构**（4.4）：面向用例生成闭环设计，新增"用例生成指引"与"参数变体表"。
6. **接口字段渐进式加载**（D6）：预过滤 + 全量独立落盘。
7. **page_draft 拆分为独立 .md 文件**（D5）。
8. **设计文档建立**（本文档）。

### v0.4.0（v0.3.0 方案落地实施 + 端到端实测修复，本次）
背景：v0.3.0 完成设计，本版本完成全部代码实施并用 6 个真实用例 + 5 个真实资产端到端验证。

实施内容：
1. scenario-core.ts 全量重写：StepAssetFile/StepMatchResult/ParamDeltaItem/AnalysisDraftScenario（merge_mode/target_scenario_slug/scenario_signature/page_draft_file）/ScenarioPlan 等类型；真实 GBrain 命令封装（gbrainPut stdin / gbrainGet 文本 / gbrainList 文本表格 / gbrainLink --link-type / gbrainTimelineAdd 位置参数 / gbrainStats 文本 / gbrainGraphQuery）；matchStepToAssets 指纹匹配器；computeParamDeltas 变量级 delta 计算器；normalizeTemplateName 统一归一化。
2. extract-case-data.ts 重写：--step-assets-dir/--asset-api-url/--out-dir 参数；资产三级加载（目录 > API > GBrain source_path）；接口字段预过滤（只保留用例 rTpl 涉及接口）；每步输出 match + script_deltas。
3. fetch-asset-by-id.ts 新建：按 test_export_api.py 契约（POST /login 取 data.tokenValue -> POST /export + satoken 头取 data 数组）；支持 --token 免重复登录；超时与错误处理。
4. validate-analysis.ts 重写：四层门禁（证据链 error / 结构 error / 一致性 error / 质量 warning）；V8 禁止推翻脚本 matched>=0.75；V9 script_deltas 全覆盖；merge_mode 与 extend 目标校验；errors>0 不写 plan 退出码 1。
5. apply-scenario.ts 全量重写：put 临时文件 + stdin 管道（PowerShell 兼容）；get 文本 hash 回读；graph-query 预检 + link；timeline-add marker 幂等；search 检索验证（warning）；健康检查（死链/孤儿/标签）；stats 文本解析。

实测发现并修复的问题：
1. **资产接口模板未归一化**：资产 JSON rTpl 为 `@\soap\Adjustment.xml` 原始形态，用例侧归一化为 `Adjustment`，导致模板匹配全失败 -> parseStepAssetJson 统一走 normalizeTemplateName。
2. **组件序列全等过严**：用例步常比资产多验证组件（DataBaseQuery x N）或少尾部校验 -> 改前缀包含计分（0.28），匹配率 4/38 -> 11/38（其余 27 步资产库确无对应资产，正确走 missing_step_suggestions）。
3. **中文场景名 slug 生成失败**：sanitizeSlugPart 剥离全部 CJK 字符后 leaf 为空抛错 -> 纯中文名回退 `scenario-<hash8>`，中英混合附加 hash6 防碰撞（如 "PA承诺付费" 与 "PA奖励" 均 sanitize 为 "pa"）。
4. **parseArgs 调用约定不一致**：core 版从索引 2 起（预期完整 process.argv），validate 误传 slice(2) 后的数组吞掉前两个参数 -> core 增加防御（首个元素以 -- 开头时从 0 起）。
5. **plan 哈希不含 notability_status**：validate 生成 plan 后 mutate notability_status 导致 authorize 双哈希校验必失败 -> 哈希计算移入 plan 构建（含全部字段）。
6. **relation-types.md / write-protocol.md 臆想命令**：旧文档含 `gbrain write`/`capture`/`get_page --json`/`link <from> <to> <type> --context` -> 全部重写为真实 CLI 契约（link 无 context 参数，上下文写入页面正文）。
7. **PS1 包装器过期**：extract-case-data.ps1 仍用已删除的 -OutFile 必填参数 -> 重写 4 个包装器 + 新增 fetch-asset-by-id.ps1。
8. **SKILL.md 全量重写**：职责分工表更新（匹配/delta 归脚本）、merge_mode 流程、真实 CLI、资源索引覆盖全部 6 个 TS + 5 个 PS1 + 6 个参考文档。

端到端验证结果（沙箱 + mock gbrain）：extract（6 用例/5 资产/11 匹配/165 deltas）-> AI 草稿样例 -> validate 正向 PASS、负向（推翻匹配/遗漏 delta）FAIL 且不写 plan -> authorize 双哈希通过 -> apply 全绿（页面写入+回读+timeline+link+健康检查 PASS），二次执行全部 REUSED 幂等。

### v0.5.0（渐进加载真正落地 + 骨架驱动流程 + 版本号机制，本次）
背景：用户实测 v0.4.0 反馈三个问题——(1) case-data.json 仍把用例+接口字段全塞一个文件（92K），AI 全量读取一个超大文件，违背此前"拆分+按需加载"设计；(2) 生成的知识页缺步骤串联顺序表，AI 自拟章节名完全不按 scenario-schema 的 8 章节；(3) AI 从零写 draft JSON 结构反复写错（param_deltas 放错层级），流程不规范。另要求每次修改更新版本号、打包带版本号。

设计变更：
1. **接口字段物理拆分**：case-data.json 不再内嵌 interface_fields/field_mapping，只保留 interface_catalog（接口名+元素数+文件指针）；明细写同目录 interface-fields.json（InterfaceFieldsFile 类型）。
2. **新增 lookup-field-info.ts**：AI 按需查询接口字段——`--list` 列接口目录 / `--interface X` 全字段 / `--interface X --field Y` 单字段 / `--search 关键词` 跨接口搜索。SKILL.md 明确纪律：禁止全量读取 interface-fields.json。
3. **新增 init-analysis-draft.ts（Step 1.5 骨架驱动）**：从 case-data.json 自动生成 AI 填空三件套——
   - analysis-draft.json：每用例一个场景骨架，steps/match/param_deltas 全部预填（delta 含资产占位符值、用例值、parameter_meta 含义作参考），AI 只补 reason/field_description/scenario_signature/knowledge
   - analysis-notes.md：证据链骨架（每场景"核对了什么/判断依据"待填）
   - page-<slug>.md：8 章节齐全，第 2 章节步骤编排表（顺序/行为/资产/asset_id/置信度）与第 3 章节参数 Delta 表已由脚本按 match/script_deltas 预填，AI 只替换 "(AI 填写)" 占位符
   - 骨架场景名用 scenario-draft-<hash8> 占位（用例名是长句超 slug 限制）
4. **门禁新增硬校验（error 级）**：
   - V1b 占位名检测：name 仍是 scenario-draft-<hash8> 报错
   - V20 步骤编排章节检测：页面必须含「## 2. 步骤编排」章节且含步骤表格（知识页必须能回答"这个场景有哪几步、顺序如何串联"）
   - 页面/笔记占位符检测：任何 "(AI 填写" 残留报错
5. **值序列化修复**：delta 对比中对象值（rRsp/rVars dict）经 String() 变 [object Object]，新增 paramValueToString 统一 JSON 序列化（>300 字符截断）。
6. **版本号机制**：SKILL.md frontmatter 维护 version 字段（语义化版本）；每次修改必须 bump；zip 打包文件名带版本号 cbs-case-scenario-analyze-v<X.Y.Z>.zip，便于用户确认手中是否最新版。

实测验证（6 用例/5 资产/接口文档）：
- extract：case-data.json 只剩用例+目录（接口字段 36K 拆出到 interface-fields.json）
- lookup-field-info：--list 11 接口目录；--search OpType 精确返回完整字段语义
- init：6 场景骨架生成，页面步骤编排表+delta 表预填
- validate：骨架原样提交 FAIL（占位名/占位符被门禁拦截）；模拟 AI 填满后 PASS（9 warning 含 notability 提示）

### v0.6.0（slug 语义化重构 + 内容真实性门禁增强，本次）
背景：用户实测 v0.5.0 知识页内容质量合格，但发现 slug 为无语义哈希（scenario-009b4635），质疑是否真正理解 GBrain 设计理念；要求调研后再改。

GBrain 设计理念调研（官方开源文档 garrytan/gbrain + 用户本地实例 46 页实证）：
1. **slug 即身份**：页面存储模型为 slug + type + frontmatter + compiled content，slug 是主键；Markdown-git 持久化模式下 slug 就是文件路径（如 people/jordan.md）
2. **slug 即搜索锚点**：混合检索 = FTS5 关键词（索引 slug/title/正文）x0.4 + 向量嵌入 x0.6 + 图谱扩展；哈希 slug 使关键词检索完全失效（搜 freeunit 永远命不中 scenario-009b4635）
3. **slug 即图谱节点**：wikilink [[slug]] 构建链接图谱，哈希节点对人类不可读
4. **MECE 目录组织**： mutually exclusive, collectively exhaustive 的命名空间（projects/<slug>、cbs/steps/<site>/<step>）
5. **用户实例铁证**：46 页全部语义化英文 kebab-case——general-adjustment（通用调账）、create-subscriber-postpaid（WS-开户-后付费）、free-resource-adjustment（免费资源调增）；中文 title 映射为有含义的英文 slug

同时发现的缺陷（用户未发现）：
- 页面 frontmatter slug 与 plan slug 不一致（页面残留骨架占位 scenario-draft-<hash>，plan 为另一个哈希）——入库后页面自身标识错乱，此前无任何一致性校验
- 数据流表存在幻觉变量（AI 编造 My_EXP_DATE_NEW，用例中实际只有 My_EXP_DATE），此前无校验
- wikilink 目标无真实性校验（本次恰好全对，但 AI 可编造不存在的 slug）

设计变更：
1. **slug_en 字段（草稿必填）**：AI 显式提供语义化英文 kebab-case slug；命名规范 <业务对象>-<操作>[-<限定>]（2-6 词），领域词表（freeunit/balance/credit/subscriber/reward/feequote + create/adjust/expire/reset/explore）写入 scenario-schema.md；generateScenarioSlug 优先使用 slug_en
2. **V1c slug 门禁（error）**：占位值 todo-scenario-english-slug / 格式非法（isValidSlugEn：^[a-z][a-z0-9]*(-[a-z0-9]+)*$，4-48 字符）→ FAIL
3. **V12e 页面 slug 一致性（error）**：page-*.md frontmatter slug 必须等于 cbs/scenarios/{site_key}/{slug_en}
4. **V12f wikilink 真实性（error）**：页面所有 [[slug]] 目标必须在已知集合（资产 slug ∪ existing_scenarios ∪ 自身页面 slug ∪ cbs/sites|cbs/products 前缀白名单），否则报"疑似臆造"
5. **V22 依赖变量真实性（error）**：dependencies 中 My_* 变量必须存在于 source_cases 的 vars 集合（fingerprint.vars ∪ script_deltas.variable_name）；字段路径形式（rRsp.字段）检查根段，警告级
6. init 骨架：slug_en 占位 todo-scenario-english-slug；页面文件名改回按用例哈希唯一（page-scenario-draft-<hash8>.md，修复 6 场景共用同名文件互相覆盖的 bug）

实测验证：骨架原样 FAIL（slug_en 占位被 V1c 拦截）；AI 填 slug_en=feequote-explore 后 PASS，plan slug = cbs/scenarios/cbs-ac3e294d/feequote-explore；臆造 wikilink FAIL；编造依赖变量 My_InitBalance（该用例不存在）FAIL。

### v0.6.1（新增执行效果检验清单）
背景：用户要求制定固定的执行效果检验流程——每次执行后提供"AI 执行过程 + 执行产物"，按统一清单检查，检查内容与用户对齐。

变更：
1. 新增 references/execution-review-checklist.md：8 个检查区 40+ 检查项（A 材料完整性 / B 流程规范性 / C 产物完整性 / D 门禁结果 / E 知识页内容质量 / F 准确性抽查 / G GBrain 入库验证 / H 效率稳定性），每区含通过标准与历史违规案例（v0.4.0 流程混乱、v0.5.0 骨架缺失、v0.6.0 slug 哈希等均沉淀为检查项）；含标准化检验报告模板与三级严重度定义（阻断/重要/建议）
2. SKILL.md 新增"执行效果检验（固定流程）"章节并加入资源索引；核心纪律：禁止只看报告下结论，必须打开产物原文核对；发现的 skill 缺陷须回本文件记录变更

### v0.6.2（执行检验清单首次实战 + 3 个阻断缺陷修复，本次）
背景：用户按 v0.6.1 检验清单流程提供 2026-08-07 01:36 执行材料要求检查。检验发现 3 个阻断问题（2 个 skill 缺陷 + 1 个引导缺陷）：

1. **V22 依赖变量校验读错字段（skill bug，v0.6.0 引入）**：validate-analysis.ts 用 `Object.keys(fingerprint?.vars ?? {})` 构建变量集，但 fingerprint 实际结构是 `variable_names: string[]` → varSet 永远为空 → 所有真实 My_* 依赖均被误判"编造"→ AI 被逼将 dependencies 清空为 [] 以绕过门禁，步骤间数据流知识丢失，与 V22 设计目标完全相反。修复：varSet 改用 `fingerprint?.variable_names` 数组（兼容旧对象格式）。实测验证：真实变量 My_InitBalance 通过、编造变量 My_FABRICATED_XYZ 被拦截。
2. **init-analysis-draft 输出文件"消失"（skill bug，v0.5.0 引入）**：`asString(args['out-dir']) ?? dirname(...)` 中 asString 未传参时返回空串 ''（非 nullish），`??` 不触发回退 → outDir='' → writeFileSync 相对路径写入进程 CWD（用户机器上是 C:\Users\l30026488）而非 case-data 所在目录；AI 在输出目录找不到文件反复重试 3 轮。修复：空串回退 dirname + 输出 resolve 后的绝对路径。
3. **资产 0 加载但流程静默继续（引导缺陷）**：AI 未传 --step-assets-dir/--asset-api-url，GBrain 6 个资产页指纹加载成功但 source_path 本地文件不存在全部丢弃，API 从未被调用（AI 不知道默认地址），extract 仅一行 stderr 警告被忽略 → 全程无资产比对（0 匹配 0 delta），用户核心诉求落空。修复：
   - extract 增加 asset_load_blocked 阻断标记：0 资产时 stdout JSON 和 extraction_meta 双写 ASSET LOAD BLOCKED，含 GBrain 发现的资产数/丢失的 source_path/三个补救命令（--step-assets-dir / --asset-api-url http://127.0.0.1:8080/api/testexport / 检查 source_path）
   - SKILL.md Step 1 改为资产来源三级决策点：必须显式选择其一，0 资产输出必须停下来补救，禁止静默继续
4. **V23 新增（页面变量真实性，warning 级）**：页面正文出现的 My_* 变量若不在（用例变量集 ∪ 资产开放参数集）中，报"页面疑似编造变量"（覆盖 AI 清空 draft.dependencies 但页面仍残留编造变量 My_EXP_DATE_NEW 的不一致问题）
5. **PS1 包装器中文乱码**：全部 ps1 增加 [Console]::OutputEncoding UTF-8 设置

检验清单本身验证有效：8 区检查项全部可执行，3 个阻断问题均被清单项捕获（B2/B4/B7/C2/C6），无需修改清单结构。

### v0.6.3（资产获取流程修正：API 优先 + 真实 API 契约，本次）
背景：用户指出两个错误——(1) 资产获取优先级错误：应是 GBrain 获取资产页 → 提取 asset_id → 调 API 获取 JSON（API 为主），而非本地目录优先；(2) API 契约全部写错，未按 test_export_api.py 真实实现。

API 契约修正（对照 test_export_api.py 原文）：
| 项 | 旧（错误） | 新（真实） |
|---|---|---|
| BASE_URL | http://127.0.0.1:8080/api/testexport | http://localhost:5000 |
| 登录 | POST /login {admin,Admin@123} → data.tokenValue | POST /api/auth/login {username,password} → data.data.token |
| 导出 | POST /export {idList:[id]} + satoken 头 | GET /api/test-steps/{id}/export + Authorization: Bearer token |
| 返回 | data 数组 | {step, version, type, exported_at} |

资产获取流程修正：
1. **第一优先级：API**——从 GBrain 资产页提取 asset_id → 调 API `GET /api/test-steps/{id}/export` 获取 JSON；默认 URL `http://localhost:5000`，GBrain 发现 asset_id 时自动启用（无需 AI 显式传 --asset-api-url）；--asset-api-url 可覆盖默认 URL
2. **第二优先级：本地目录**——--step-assets-dir 指定的目录按 asset_id 匹配 JSON 文件
3. **第三优先级（fallback）：GBrain source_path**——本地文件路径读取

阻断逻辑修正：当 GBrain 未运行（无 asset_id）且未传 --step-assets-dir 时，输出 ASSET LOAD BLOCKED 阻断标记，含三个补救命令（其中 API 默认 URL 更正为 http://localhost:5000）

fetch-asset-by-id.ts 全量重写：
- loginAsync: POST {baseUrl}/api/auth/login {username, password} → response.data.data.token
- exportAssetAsync: GET {baseUrl}/api/test-steps/{assetId}/export + Authorization: Bearer {token} → response.data
- 支持凭据参数（--api-username/--api-password，默认 l30026488/lz909321*）
- --token 参数免重复登录
- --asset-id 可传逗号分隔多个 ID 批量获取

SKILL.md 更新：Step 1 资产来源描述改为"API 优先（GBrain asset_id → API → JSON），目录次之，source_path 兜底"

### v0.6.4（修复 gbrainAssetCount 变量未定义崩溃，本次）
背景：v0.6.3 sed 批量替换变量名时误伤 main 函数中的引用路径——gbrainAssetCount/apiUrl 在 loadAssets 内定义但 main 中直接引用未通过 assetLoad. 前缀，导致 0 资产场景运行时 ReferenceError 崩溃。v0.6.3 编译通过但未测 0 资产路径漏检。

修复：main 中所有 gbrainAssetCount → assetLoad.gbrainAssetCount、apiUrl → assetLoad.apiUrl（3 处引用全部修正）；实测 0 资产场景正常输出阻断信息不崩溃、有资产场景正常加载。

### v0.6.5（修正 API 默认凭证，本次）
背景：用户指出 test_export_api.py 中已写明真实凭证（用户名 l30026488、密码 lz909321*），但 skill 中默认值仍为错误的 admin/Admin@123，导致 API 401 认证失败。

修复：extract-case-data.ts、fetch-asset-by-id.ps1、design-doc.md 中所有默认凭证修正为 l30026488/lz909321*。

### v0.6.6（PS1 bun run 修正 + 页面 title 占位符 + SKILL.md bun 命令统一）
背景：用户实测 v0.6.5 执行记录发现三个问题：(1) PS1 包装器用 `bun run` 导致 CommandNotFoundException，AI 绕过 PS1 直接 bun 又传错参数反复试；(2) AI 认为是 dry-run，骨架原样提交，11 个 error 全是占位符未填，AI 完全没参与分析；(3) 页面 title 直接用用例全名（如 "013.调用FeeQuoteV2接口做费用探寻，接口调用成功"），不是场景名称。

修复：
1. **PS1 `bun run` → `bun`**：extract-case-data.ps1/fetch-asset-by-id.ps1 中 `& bun run @args` 改为 `& bun @args`（bun 不需要 run 子命令执行 ts）；validate-analysis.ps1 中 `& bun run $tsScript` 改为 `& bun $tsScript`
2. **SKILL.md 全部 `bun run scripts/` → `bun scripts/`**（6 处）：AI 看到 SKILL.md 写 `bun run` 就照做导致报错；统一为 `bun scripts/xxx.ts`
3. **init title 占位符**：页面 frontmatter title 从 `c.basic_info.case_name`（用例全名）改为 `(AI 填写场景名称)`，场景正文标题同理；AI 必须根据分析结果填写有意义的场景名称
4. **SKILL.md 版本号同步**：frontmatter version + 正文"当前 Skill 版本"统一为 0.6.6
5. **实测验证**：骨架 title 为占位符；骨架原样提交 validate FAIL（占位符/todo-scenario 被门禁拦截），plan 不生成

### v0.7.0（canonicalize 致命 bug + source_path 引号 + step_assets 缺 parameter_meta + 校验报告计数 + rRsp/rVars delta 类型 + soap_field_paths 提取）
背景：用户质疑"是否真的仔细解压检查了执行产物"，重新逐文件深度检查 cbs-scenario-analyze-2026-08-07-03-01-01.zip 发现 6 个此前遗漏的问题。

修复：
1. **P0: canonicalize() 函数完全损坏**：`Object.keys(value)` 返回字符串数组，但 `.map(([key, v]) => ...)` 把每个字符串当元组解构 → `"component_sequence"` 被拆成 `key="c", v="o"` → 所有输入被压缩成 `{"c":"o","i":"n"}` → 全部 6 个步骤的 fingerprint_hash 完全相同（`8a8d747d...`）。同时影响 `planPayloadSha256`（计划完整性哈希）和 `scenario_signature`。修复：`Object.keys()` → `Object.entries()`，sort 也改为按 entry key 排序
2. **P0: source_path 带多余 YAML 引号**：`parseGbrainGetOutput` 的简单正则解析器不解码 YAML 单/双引号 → `'D:\GBrainNotes\...'` 存储时保留引号字符 → source_path 文件查找失败。修复：在 trim 后增加引号剥离逻辑
3. **P0: step_assets 摘要丢弃 parameter_meta**：case-data.json 中 step_assets 只保留 `asset_id/name/slug/interface_template/component_sequence/open_parameter_names/source_kind/source_path`，但 AI 分析时需要的字段描述（`parameter_meta.description`）、建议默认值（`parameter_meta.suggested_default`）、`vars` 全部丢失。AI 只能看到预计算 delta 结果，无法理解或验证参数含义。修复：step_assets 输出增加 `vars` 和 `parameter_meta` 字段
4. **P1: 校验报告步骤计数缺失 tentative**：`matched`（>=0.75）= 1，`unmatched`（无 asset_id）= 3，但 2 个 `tentative`（0.55）步骤未计入任何列 → 1+3=4 ≠ 6 总步骤。修复：场景列表表增加"待确认"列
5. **P1: rRsp/rVars delta 类型错误**：用例 `rRsp: ""` 是空字符串，delta 标记为 `modify-default`（从 `{"rsp":...}` 改为空），应为 `remove`（用例清空了资产默认值）。修复：`computeStepDelta` 中增加 `caseIsEmpty` 判断，空值走 remove 分支
6. **P2: soap_field_paths/field_to_var/field_to_literal 永远为空**：`rReq` 是 JSON 对象，`asString()` 返回 `[object Object]`，正则匹配不到。修复：改为 `typeof rReqRaw === 'string' ? rReqRaw : JSON.stringify(rReqRaw)` 后用 `"key"\s*:` 正则提取字段路径

### v0.8.0（SKILL.md 流程重设计：消除 AI 跳过分析 + 命令统一 + 资产来源自动化 + dry-run 定义）

背景：用户反馈 v0.7.0 执行中 AI 完全没参与分析，直接从 init 跳到 validate，11 个 error 全是占位符未填写。三个核心问题：

1. **AI 跳过 Step 2（AI 分析）**：SKILL.md 的 Step 2（AI 填语义）是两个脚本步骤（1.5 和 3）之间的文字描述，AI 把它当可选注释。AI 的实际流程是 extract → init → validate → 报告 FAIL，完全跳过了语义分析。根因：缺乏强制性门禁阻止 AI 在占位符未清空时运行 validate。
2. **PS1 执行策略错误导致 AI 试错**：SKILL.md 命令示例用 `.\scripts\xxx.ps1` 但未带 `-ExecutionPolicy Bypass`，AI 碰壁后自行绕路切换到 bun，浪费时间且流程不规范。
3. **AI 主动查找本地目录而非用 API**：SKILL.md 要求"向用户确认资产来源"，AI 主动查找本地 steps 目录并传 `--step-assets-dir`，虽然脚本内部正确按 API 优先加载，但 AI 的行为不符合设计意图。

修复：
1. **Step 2 改为强制性步骤**：增加 pre-validate 自检门禁——"禁止在 analysis-draft.json/analysis-notes.md/page-*.md 中存在任何 '(AI 填写)' 占位符时运行 validate-analysis.ts"。Step 2 执行清单细化为 10 项必做任务，每项明确标注"必须"。
2. **dry-run 定义**：新增章节明确"dry-run = 跳过 Phase 2/3，Phase 1 全部步骤含 AI 分析必须完成"。消除 AI 将 dry-run 误解为"跳过 AI 分析"的问题。
3. **命令统一为 bun**：所有示例从 `.ps1` 改为 `bun scripts/xxx.ts`，PS1 降级为备选（附注 `-ExecutionPolicy Bypass`）。
4. **资产来源自动化**：移除"向用户确认资产来源"步骤，明确"脚本自动按 API → 本地 → source_path 三级加载，AI 不需要手动查找或确认"。
5. **职责分工表强化**：AI 负责的 5 项核心职责（场景知识提炼/匹配确认/Delta 理由/归属判定/页面撰写）全部标注"AI（核心职责）"。

### v0.9.0（页面与 JSON 双写一致性 + tentative 裁决 + 依赖自动提取 + 校验正则放宽）

背景：v0.8.0 执行结果首次 AI 真正参与分析，页面内容质量好，但存在"页面填了、JSON 没填"的双写不一致问题。

修正说明：v0.8.0 检查报告中误报了"delta_type 全 null"和"step_name/step_summary/step_intent null"——实际字段名是 `change_type`（已正确填写），step_name/step_summary/step_intent 不在 AnalysisDraftStep schema 中。真正的问题如下：

1. **tentative 匹配未裁决**：AI 在 analysis-notes.md 中确认了两个 tentative 匹配（步骤 2 和 4），但 analysis-draft.json 中 match_status 仍为 "tentative"、match_confidence 仍 < 0.75 → validate 生成的 plan 中这些步骤仍为 tentative → 不生成 composed_of_step 链接 → GBrain 中场景与步骤资产的关联缺失。修复：SKILL.md Step 2 第 4 项改为"确认则将 match_status 改为 matched、match_confidence 设为 1.0；拒绝则清空 matched_asset_id"；validate 新增 V24 门禁——tentative match_status 视为 error（AI 必须裁决后才能通过）。

2. **dependencies 为空**：AI 在页面 Section 4 填了 5 条步骤间数据流，但 analysis-draft.json 的 dependencies=[] → plan 的 param_dependencies=[] → GBrain 无依赖链接。修复：init-analysis-draft.ts 新增 `extractCrossStepDeps()` 函数，从 script_deltas 自动提取跨步骤变量引用（步骤 A add/modify 的变量在步骤 B 的 delta 中出现 → variable-reference dependency）作为初始 dependencies 预填，AI 只需检查补充 description；SKILL.md Step 2 新增第 6 项"步骤间数据流"要求；validate 新增 V25——多步骤场景 dependencies 为空时 warning。

3. **field_description 校验正则过严**：正则 `String|Integer|字符串|数值|列表|布尔` 不匹配"整数"、"正整数"、"单位：分"等中文格式 → 40/41 warnings 为误报。修复：扩展正则增加 `整数|正整数|负整数|枚举|单位|小数|百分比|金额|数量|标识|编码|名称|日期|时间|毫秒|秒|分|元|位`。

4. **reason 校验正则过严**：正则 `为了|确保|因为...` 不匹配"去除"、"保留"、"设置"等有效业务理由词 → 误报。修复：扩展正则增加 `去除|保留|设置|使用|避免|简化|覆盖|指定|配置|需要|不需要|不支持|必须`。

### v0.10.0（确定性脚本校验兜底 — confidence 上限/复制粘贴检测/reason 强制/通用性保证）

### v0.11.0（页面中文 description + V30 frontmatter 校验）

背景：v0.10.0 审查发现页面 frontmatter 只有英文 slug 作为 title，缺少中文 description，导致 GBrain 全文检索时中文查询可能匹配不到。analysis-draft.json 有中文描述但没同步到页面。

变更内容：

1. **init-analysis-draft.ts**：页面 frontmatter 新增 `description` 字段，默认值取 analysis-draft.scenario.description 或 "(AI 填写场景描述)" 占位符。确保 GBrain search 可命中中文关键词。

2. **V30: 页面 frontmatter 中文 description 校验**（error）：读取页面 markdown frontmatter，检查 `description` 字段存在且非占位符、长度 >= 10 字符且包含中文字符。若不满足报 error "页面 frontmatter 缺少中文 description，GBrain 检索将无法命中中文查询"。通用规则。

3. **SKILL.md**：Step 2 清单增加"填写页面 frontmatter 的 description 字段（中文场景描述，>=10字符）"；门禁表增加 V30。

### v0.11.0（analysis-data 结构化数据入库 — 方案B）

背景：v0.10.x 只写入场景知识页面（markdown），但后续生成用例所需的步骤资产 ID、字段替换映射（delta）、组件序列等结构化数据仅存在于本地 analysis-draft.json。换环境后数据丢失，无法完成"知识页 → 生成用例"闭环。

设计决策（方案B）：将结构化数据作为独立知识页写入 GBrain，通过 link 建立关联，使生成用例时所有数据均可在 GBrain 中获取。

### v0.12.0（四层知识模型 + 三层签名 + business_entities）

背景：v0.11.x 的 scenario_signature 将参数组合（OpType=5 + FreeUnitType=Voice）作为场景标识，导致知识碎片化——OpType 6种 × FreeUnitType 10种 = 60个几乎相同的页面。同时 dependencies 只记录变量级数据流，缺少业务对象生命周期信息。

设计决策：

1. **四层逻辑模型**（物理实现降级为页面内章节/表格）：
   - Business Capability（导航层，schema 预留 capability 字段）
   - Scenario Pattern（测试知识核心，按步骤序列+接口调用链+验证点+业务对象变化划分）
   - Operation Variant（行为差异，如 OpType=1调增/OpType=2调减，Pattern 页面内章节）
   - Parameter Variant（参数差异，如 FreeUnitType=Voice/SMS/Data，Pattern 页面内表格行）

2. **三层签名拆分**（原 scenario_signature 拆为四个）：
   - pattern_signature：接口调用链（如 Adjustment）
   - intent_signature：业务意图（如 ExpireTimeCorrection），AI 主导填写
   - variant_signature：操作变体（如 OpType=5）
   - parameter_signature：参数变体（如 FreeUnitType=Voice）

3. **基础 business_entities**：
   - BusinessEntity 类型：{ entity, relation?, created_by?, modified_by? }
   - init 从步骤资产自动提取骨架，AI 补充语义
   - V31/V32/V33 门禁校验

4. **Pattern 判断标准五维**：步骤序列 + 接口调用链 + 验证点 + 业务对象变化 + 业务意图

**analysis-data 知识页设计：**
- slug：`{scenario-slug}/analysis-data`
- frontmatter：`kind: scenario-analysis-data`、`scenario_slug`、`scenario_name`（中文）、`step_count`、`matched_step_count`、`total_delta_count`、`source_case`
- body：JSON 结构，包含每步的 `step_index`、`behavior`、`matched_asset_id`、`matched_step_asset_slug`、`match_confidence`、`component_sequence`、`param_deltas`（含 `component_alias`、`variable_name`、`change_type`、`asset_default_value`、`case_value`）

**关联关系：**
- 场景知识页 → analysis-data 页：`has_analysis_data`
- analysis-data 页 → 步骤资产 slug：`references_step`（每个匹配步骤一个 link）

**后续生成用例的数据链路：**
1. `gbrain get <scenario-slug>` → 场景业务逻辑 + 步骤编排
2. `gbrain graph-query` → 找到 analysis-data 页 → `gbrain get <analysis-data-slug>` → JSON 结构化数据
3. 从 analysis-data 提取每步 `matched_asset_id` → API `GET /api/test-steps/{id}/export` → template_json
4. template_json + param_deltas → 应用替换 → 完整用例 JSON → XML

变更内容：
1. **validate-analysis.ts**：生成 scenario-plan.json 时，增加 analysis-data 页（markdown frontmatter + JSON body）+ has_analysis_data link + references_step links
2. **apply-scenario.ts**：无需修改（已通用处理 pages + links）
3. **SKILL.md**：Step 4 说明增加 analysis-data 页入库描述 + 生成用例数据链路说明

背景：v0.9.0 审查发现 AI 出现业务正确性错误（confidence=1.0、跨步骤变量混淆、复制粘贴错误），且仅靠 SKILL.md 规则描述无法防止 AI 遗忘或误操作。必须用确定性脚本校验兜底。所有逻辑必须通用，不针对特定用例或变量名。

变更内容：

1. **V26: tentative 确认后 confidence 上限 0.95**（error）：任何脚本原始 confidence < 0.75 的匹配，AI 确认后 match_confidence 不得超过 0.95。逻辑：遍历 case-data.json 中各步骤的 script match.confidence，若 < 0.75 但 analysis-draft 中对应步骤 match_confidence > 0.95，报 error。通用规则，不硬编码。

2. **V28: 复制粘贴检测 — reason/field_description 不得包含其他步骤的变量名**（error）：收集所有步骤的所有 variable_name 集合，对每个 delta 的 reason + field_description 检查是否包含其他步骤（非当前步骤）的 variable_name 子串。若包含，说明 AI 可能从其他步骤复制粘贴。通用规则，不硬编码特定变量名。

3. **V29: 所有 delta 的 reason 非空且 >= 6 字符**（error）：从 warning 升级为 error。每个 param_delta 必须有 reason 且长度 >= 6（排除无意义短文本如"yes"/"ok"）。通用规则。

4. **V27: 同名变量跨步骤 field_description 一致性**（warning）：如果同一个 variable_name 出现在多个步骤的 param_deltas 中，且 field_description 不同（非空），报 warning。提示 AI 检查是否混淆。通用规则。

5. **SKILL.md: match_confidence 范围 0.85-0.95**：从 "设为 1.0" 改为 "设为 0.85-0.95（确认匹配但非完美匹配）"。辅助提醒，脚本门禁 V26 为硬兜底。

6. **SKILL.md Step 2: 逐变量核对提醒**：增加"禁止从其他步骤复制 reason/field_description"提醒。辅助提醒，V28 为硬兜底。

7. **SKILL.md: 通用性声明**：增加"本 Skill 为通用技能，所有校验逻辑基于通用规则，不针对特定业务或用例"。

### v0.12.0（四层签名体系 + business_entities）

背景：v0.10.x 数据入库基本可用后，发现场景粒度偏细（每个参数组合=一个Scenario），且仅记录变量依赖不记录业务实体关系。引入四层知识模型：Business Capability → Scenario Pattern → Operation Variant → Parameter Variant。

变更内容：

1. **四签名体系**：scenario_signature 拆分为 pattern_signature（接口调用链）+ intent_signature（AI 填写业务意图）+ variant_signature（操作变体如 OpType）+ parameter_signature（参数变体如 FreeUnitType）。
2. **BusinessEntity 类型**：{entity, relation?, created_by?, modified_by?, description?}，从步骤资产推断骨架，AI 补充关系描述。
3. **OperationVariant / ParameterVariant 类型**：逻辑分层≠物理页面分层，Operation/Parameter Variant 是 Pattern 页面内章节/表格，不独立创建 GBrain 页面。
4. **capability 字段**：预留业务能力归属（如 free-resource-management），AI 可选填写。
5. **V31-V33 门禁**：intent_signature 占位符未填=error / steps>1 但 business_entities 空=warning / pattern_signature 空=error。
6. **analysis-data JSON 补全**：入库结构化 JSON 包含 business_entities、四签名、operation_variants、parameter_variants。

### v0.12.1（init-analysis-draft.ts 致命 bug 修复）

背景：v0.12.0 执行时 init-analysis-draft.ts 报 ReferenceError: computePatternSignature is not defined。

根因：v0.12.0 新增 computeSignatures() 函数但 sc 对象创建处仍引用三个不存在的独立函数（computePatternSignature/computeVariantSignature/computeParameterSignature）。同时 extractBusinessEntities 缺少 assets 参数，operation_variants/parameter_variants 字段未赋值，渲染函数字段名与接口定义不匹配。

修复内容：

1. sc 对象创建处改用 computeSignatures() 返回值，替代三个不存在的函数调用。
2. extractBusinessEntities(c.steps) → extractBusinessEntities(c.steps, caseData.step_assets)。
3. 新增 operation_variants/parameter_variants 字段赋值。
4. ComputedSignatures 接口对齐 OperationVariant/ParameterVariant 类型定义。
5. 渲染函数字段名修正：ov.operation→ov.variant_signature, ov.key_difference→ov.difference, pv.parameter→pv.parameter_name, pv.value→pv.parameter_value。
6. extractBusinessEntities 内 step.match.asset_id → step.match.matched_asset_id（与 StepMatchResult 接口一致）。
7. 新增 CaseStepWithMatch/StepAssetFile 类型别名。

### v0.12.2 (2025-08-10)

修复内容：

1. **pattern_signature 排除 setup 前置接口**：computeSignatures 增加 SETUP_INTERFACE_TEMPLATES 约定列表（CreateCustomer/CreateAccount/Login/SystemParameter/InitBalance），从 pattern_signature 中排除通用前置步骤。新增 V34 门禁检测。
2. **删除 scenario_signature**：从 AnalysisDraftScenario 接口删除废弃字段，清理 init-analysis-draft.ts/validate-analysis.ts 所有引用和计算。避免四签名与旧签名双系统并存。
3. **notes 步骤引用规范**：骨架模板改用 Step[N] 格式（N=step_index），废弃「步骤N」人类自然编号。新增 V35 门禁检测。
4. **parameter_variants 检测修复**：TableSetVar.vars 为字符串（`key=val;key=val`）时解析为对象，修复 typeof vars === 'object' 漏检导致 parameter_variants 空数组。
5. **scoreQuality reason 质量检查逻辑修正**：OR→AND（`!hasRationale && len < 15`），避免长 reason 因缺关键词被误报 warning。

### v0.12.3 (2026-08-10)

1. **variant_signature 核心操作分离**：对同一 interface_template 的多个操作步骤，仅取 step_index 最大的（核心测试目标）进入 variant_signature，其余归入 preparation_operations。OperationVariant 增加 role 字段（core/prepare）。防止 OpType=1+OpType=5 碎片化。
2. **页面 frontmatter scenario_signature 残留清理**：删除 init-analysis-draft.ts 模板中的 scenario_signature 生成（第112行 frontmatter + 第130行 正文），防止 AI 看到占位后主动填充合成值。
3. **test_points 结构化**：analysis-draft.json 增加 test_points 结构化字段（name/params/reason），页面从 JSON 渲染表格。validate 中 test_points 空→error（非 warning）。
4. **DataBaseQuery vars 变量提取**：extract-case-data.ts 增加 DataBaseQuery.vars 解析（`RESULT_COL|AliasName` → AliasName 加入 variable_names），修复 My_FREE_UNIT_ID_1 误报"疑似臆造"。
5. **V36 门禁**：variant_signature 不应含前置准备操作。
6. **V37 门禁**：场景名应与 intent_signature 语义对齐，禁止技术操作描述。
7. **SKILL.md 场景命名规范**：场景名称须与 intent_signature 使用相同业务术语。

## v0.12.4 (2026-08-10)

### 修复

1. **preparation_operations 类型修正**：从 `string` 改为 `string[]`，computeSignatures 返回数组而非 join 字符串。validate-analysis.ts 所有引用处增加 Array.isArray 兼容处理。
2. **V36 门禁升级为 error**：variant_signature 包含前置准备操作时直接报错（此前为 warning，AI 未纠正 JSON 中的错误值）。
3. **field_description 检查放宽**：rRsp/rVars 等响应模板变量豁免数据类型关键词检查；增加"响应/返回/验证/查询"等业务含义关键词。
4. **scenario-plan skill 版本号修正**：从硬编码 0.3.0 改为 0.12.4。
5. **frontmatter preparation_operations 渲染兼容**：init-analysis-draft.ts 和 validate-analysis.ts 的 frontmatter 生成处均增加 Array.isArray 安全处理。

## v0.12.5 (2026-08-10)
1. **parameter_variants.source_cases 修正**：computeSignatures 中 source_cases 从 caseName（完整用例名称）改为 case_id，与 scenario 级 source_cases 一致。
2. **V28b 新增门禁**：跨步骤 rRsp/rVars 的 case_value 完全相同时报 warning（提示可能复制粘贴未修改），仅检测 matched 步骤。
3. **scenario-plan skill 版本号**：从 0.12.4 更新为 0.12.5。

## v0.12.6（2025-08-10）

### 修复
1. **apply-scenario.ts 链接创建失败导致整体崩溃**：`applyLinks` 中 `gbrain link` 失败时直接 `throw new Error()`，导致已成功写入的页面、timeline 等后续步骤全部中断，apply-result.json 和 apply-report.md 无法生成。修复：链接失败不 throw，改为记录 failed 状态返回，main 函数汇总为 warning 而非中断。典型场景：evidenced_by 链接指向的用例页尚未在 GBrain 中创建。

## v0.12.7（2025-08-10）

### 修复
1. **移除 evidenced_by 链接生成**：原始用例数据不写入 GBrain（十万+用例量过大，GBrain 是知识库非数据仓库），因此不再生成场景页→用例页的 evidenced_by 链接。用例追溯通过 frontmatter 的 `source_cases: [case_id]` 字段轻量级记录，不依赖 GBrain 页面存在。

## v0.12.8 (2026-08-10)

### 修复
1. **页面写入回读验证不再 throw**：GBrain 存储时可能对内容做规范化（trim/normalize），导致回读 hash 与写入 hash 不匹配。改为记录 verification warning 并继续执行，不中断后续 links/timeline/report 流程。
2. **Timeline 写入失败不再 throw**：同样改为记录 warning 继续执行。

### v0.12.9
1. **修复 gbrainGet 参数类型错误**：`gbrainGet(exec, [slug])` 传了数组而非字符串（2 处），与 v0.10.2 同类 bug。
2. **增加 put/get 诊断日志**：记录 gbrain put 的 stdout/stderr 到 result，回读失败时输出完整诊断信息。
3. **区分回读不存在 vs hash 不匹配**：`readback.exists=false` 报 error "页面不存在"（含 put/get stderr），`exists=true` 但 hash 不匹配 报 warning。

### v0.13.0
1. **修复 paramValueToString 截断 bug**：`paramValueToString()` 将超过 300 字符的 JSON 值截断为 300+'…'，导致 analysis-data 中的 case_value 不完整，无法用于精准生成用例。移除 300 字符限制，保留完整 JSON 值。

## v0.12.9 (2026-08-10)

### 问题
apply-scenario.ts 写入页面后回读验证失败（hash 不匹配），且 GBrain 数据库中实际无写入数据。v0.12.8 的"改为 warning"修复方向错误——掩盖了真正的问题。

### 根因
1. **gbrainGet 参数类型错误**：getPageBodyHash 和 applyLinks 中调用 `gbrainGet(path, [slug])` 传了数组而非字符串，虽然单元素数组 toString() 后碰巧正确，但行为不可靠
2. **回读验证逻辑不精确**：当 gbrain put 静默失败（返回 exit code 0 但未写入）时，gbrain get 返回页面不存在，但代码将其误报为"hash 不一致"
3. **缺乏诊断信息**：put 命令的 stdout/stderr 未被记录，无法定位 put 为何未真正写入

### 修复
1. **修复 gbrainGet 参数**：两处 `[slug]` → `slug`
2. **精确化回读验证**：区分"页面不存在"（put 可能失败）和"hash 不匹配"（GBrain 规范化），前者记录 ERROR 级诊断信息
3. **增加诊断日志**：记录 put 命令的 stdout/stderr、get 命令的 stderr 到 result 中，当验证失败时输出完整诊断信息（put stdout、put stderr、get stderr）

## v0.13.0 (2026-08-10)

### 问题
analysis-data 中 case_value 被 300 字符省略号截断，导致生成用例时无法精准替换参数值。

### 根因
`paramValueToString()` 在 scenario-core.ts 中对超过 300 字符的值进行截断（`v.slice(0, 300) + '…'`），本意是避免 delta 过长，但截断后丢失完整数据。

### 修复
去除 `paramValueToString()` 中的 300 字符截断限制，直接返回完整字符串值。

## v0.13.1 (2026-08-11)

### 问题
analysis-data 中 SoapClient 组件的 rReq 参数 delta 完全缺失，导致生成用例时无法获取请求参数差异，无法生成准确的用例数据。

### 根因
`computeStepDelta()` 中三个问题：
1. **rReq 被显式跳过**：`skipKeys = new Set(['rReq', 'rTpl', 'url', 'iTimeOut', 'rHeader'])`，rReq 被排除在 delta 计算之外
2. **长度过滤静默丢弃**：`(assetVal!.length < 200 || caseVal!.length < 200)` 条件导致长值对长值的变化（如 rReq）被跳过
3. **DataBaseQuery/DataBaseModify 等组件无 delta 覆盖**：非 TableSetVar/SoapClient 的组件类型完全不生成 param_deltas

### 修复
1. **移除 rReq 跳过**：skipKeys 仅保留 `'rTpl', 'url', 'iTimeOut', 'rHeader'`（rTpl=接口模板名、其余=连接配置，由匹配决定非用例差异）
2. **移除长度过滤**：v0.13.0 已去除 paramValueToString 截断，此处也不应跳过长值
3. **新增 DataBaseQuery/DataBaseModify delta**：与 SoapClient 同理，对比 option_parameter 键级差异
4. **新增通用组件 delta 兜底**：对未专门处理的组件类型（如 SaveUserInfo、AssertResult 等），自动进行 option_parameter 键级对比
5. **提取通用函数 pushOptionParamDeltas**：SoapClient/DataBaseQuery/通用组件共用同一套键级对比逻辑，消除代码重复
