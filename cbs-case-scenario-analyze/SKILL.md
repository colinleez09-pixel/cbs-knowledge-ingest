---
name: cbs-case-scenario-analyze
description: 分析 CBS 历史用例提取测试场景知识并入库 GBrain，脚本完成提取/指纹匹配/参数Delta计算/骨架生成/门禁校验，AI 负责语义分析与知识提炼；当用户需要分析历史用例提取场景、用例场景知识入库 GBrain 或按场景增量维护测试知识时使用
version: 0.13.1
mutating: true
triggers:
  - 分析历史用例提取场景知识
  - 从历史用例提取测试场景
  - 场景知识入库到 Gbrain
  - 分析 CBS 历史用例
  - 提取用例组合模式
  - ingest CBS case scenario patterns
---

# CBS 历史用例场景知识提取

当前 Skill 版本：`0.12.8`。运行条件：OpenCode-compatible Agent、Bun 1.3+、GBrain CLI 0.42.57.0+。前置依赖：已通过 `cbs-step-asset-ingest` 将测试步骤资产入库到 GBrain。

**v0.8.0 关键变化**：
- 所有命令示例统一为 `bun scripts/xxx.ts`（不再用 PS1 包装器作为主命令，避免执行策略问题导致 AI 试错）
- 资产来源由脚本自动处理（API → 本地 → source_path），AI 不需要手动确认或查找本地目录
- **Step 2（AI 分析）改为强制性步骤**，增加 pre-validate 自检门禁，禁止在占位符未清空时运行 validate
- 明确定义 dry-run：dry-run = 跳过 Phase 2/3（授权和写入），Phase 1 全部步骤含 AI 分析必须完成

本 Skill 从 CBS/AutoSpace 历史测试用例 JSON 中提取测试场景模式知识：**脚本**完成用例解析、步骤资产加载、指纹匹配、参数 Delta 计算、骨架生成、门禁校验、GBrain 写入；**AI** 负责场景知识提炼、匹配结论确认、Delta 业务理由、场景归属判定、页面语义撰写——这是 AI 的核心职责，不可跳过。

**核心设计原则**：
- AI 负责语义和业务分析（结合接口字段含义、实际脚本参数、用例标题和描述），脚本只做确定性计算和流程控制
- 用例名称/描述不可信（测试人员批量复制），场景判定必须基于实际脚本参数与接口字段含义
- 按场景建页而非按用例（十万级用例规模），同场景新用例走 extend 增量维护
- GBrain 命令以 0.42.57.0 真实 CLI 为准：`put`/`get`/`list`/`link`/`timeline-add`/`search`/`stats`；不存在 `write`/`capture`/`get_page`

正式写入前阅读 [scenario-schema.md](references/scenario-schema.md)、[write-protocol.md](references/write-protocol.md) 和 [relation-types.md](references/relation-types.md)；生成分析草稿前阅读 [analysis-draft-schema.md](references/analysis-draft-schema.md)；接口文档解析问题查阅 [interface-doc-parsing.md](references/interface-doc-parsing.md)；设计方案与决策背景见 [design-doc.md](references/design-doc.md)。

## dry-run 定义

**dry-run = 只完成 Phase 1（分析），跳过 Phase 2（授权）和 Phase 3（写入 GBrain）。**

dry-run 不意味着跳过 AI 分析。Phase 1 包含三个步骤，其中 Step 2 是 AI 的核心分析工作，必须完成。dry-run 的产出是经过校验的 `scenario-plan.json` + `validation-report.md`，供用户审核后决定是否继续写入。

## 输出目录策略

所有中间文件放在统一工作目录，禁止使用 temp 目录：

- 默认：用例所在目录下创建 `cbs-scenario-analyze-<YYYYMMDD-HHmmss>` 子目录
- 自定义：extract 的 `--out-dir` 参数指定
- 所有阶段输出同一目录

## 脚本与 AI 的职责分工

| 环节 | 执行者 | 说明 |
|------|--------|------|
| 用例 JSON 解析 | 脚本 (extract-case-data) | Test_Steps 结构化、组件序列、参数键值 |
| 接口文档解析 | 脚本 (extract-case-data) | Markdown 表格 -> 接口字段定义；明细写 interface-fields.json |
| 接口字段按需查询 | 脚本 (lookup-field-info) | AI 按需查单接口/单字段/关键词 |
| 步骤资产加载 | 脚本 (extract-case-data) | 脚本自动按 API → 本地目录 → source_path 三级优先级加载，AI 无需干预 |
| 脚本化指纹匹配 | 脚本 (extract-case-data) | 步骤名+组件序列+接口模板三重指纹，输出 match 结果 |
| 参数 Delta 计算 | 脚本 (extract-case-data) | 变量级 add/remove/modify |
| 分析骨架生成 | 脚本 (init-analysis-draft) | draft/notes/page 三件套骨架，match/delta/步骤编排表已预填 |
| **场景知识提炼** | **AI（核心职责）** | 结合接口字段含义、实际参数、用例上下文，提炼核心业务知识/参数设计理由/前置条件/预期结果 |
| **匹配结论确认** | **AI（核心职责）** | 采纳 matched（>=0.75）；裁决 tentative；为 unmatched 匹配给出理由 |
| **Delta 业务理由** | **AI（核心职责）** | 每条 delta 补 field_description + reason（为什么设置这个值） |
| **场景归属判定** | **AI（核心职责）** | 计算 scenario_signature，决定 merge_mode: create/extend |
| **页面语义撰写** | **AI（核心职责）** | 替换骨架中所有 "(AI 填写)" 占位符为真实语义内容 |
| 草稿校验 | 脚本 (validate-analysis) | 四层门禁，确认 AI 确实分析了 |
| 计划授权 | 脚本 (authorize-scenario-plan) | SHA-256 双哈希完整性 |
| GBrain 写入 | 脚本 (apply-scenario) | put/get/link/timeline-add + 回读验证 + 幂等 + 健康检查 |

## 三阶段工作流

```
Phase 1: 分析（dry-run 在此阶段结束后停止）
    Step 1: extract-case-data.ts（脚本）— 提取用例数据 + 加载资产 + 匹配 + Delta
    Step 1.5: init-analysis-draft.ts（脚本）— 生成三件套骨架
    Step 2: AI 分析（智能体）— 填写全部语义内容，清空所有占位符【不可跳过】
    Step 3: validate-analysis.ts（脚本）— 四层门禁校验

Phase 2: 授权
    authorize-scenario-plan.ts（脚本）— SHA-256 双哈希

Phase 3: 写入
    apply-scenario.ts（脚本）— 真实 GBrain CLI 写入
```

## 输入

| 输入 | 必填 | 说明 |
|------|------|------|
| 历史用例 JSON 目录或文件 | 是 | eWindCloud 导出 XML 解析后的 JSON |
| 接口字段文档 MD | 否 | 提供字段含义，增强 AI 分析质量 |
| 公共结构文档 MD | 否 | 展开接口文档引用的公共结构 |
| 步骤资产 JSON 目录 | 否 | 仅在 API 不可用时作为 fallback，脚本自动处理 |
| 资产平台 API 地址 | 否 | 默认 http://localhost:5000，脚本自动调用 |

## 操作步骤

### Phase 1: 分析

#### Step 1: 脚本提取数据

直接运行，脚本自动按 API（默认 http://localhost:5000）→ 本地目录 → GBrain source_path 三级优先级加载步骤资产。**不需要手动查找本地目录或向用户确认资产来源**——除非脚本报 0 资产阻断警告。

```bash
bun scripts/extract-case-data.ts \
    --case-dir ./cases \
    --interface-doc ./接口.md \
    --common-structure-doc ./公共结构.md
# 单文件模式：
bun scripts/extract-case-data.ts --case-file ./case.json --interface-doc ./接口.md
```

运行后检查输出 JSON 中 `extraction_meta.step_assets_loaded`：若为 0，脚本会输出 `asset_load_blocked: true` 并打印三个补救命令。此时须向用户索要资产来源并补参重跑。**禁止在 0 资产下继续后续步骤。**

case-data.json 关键内容（AI 主读文件）：
- `cases[].steps[].match`：脚本指纹匹配结果（matched_asset_id/confidence/match_status/candidates）
- `cases[].steps[].script_deltas`：脚本计算的参数 Delta
- `step_assets[]`：加载的资产摘要（含 parameter_meta/vars，AI 可查看参数描述和默认值）
- `interface_catalog`：接口目录（明细在同目录 `interface-fields.json`）
- `existing_scenarios`：GBrain 已有场景页列表

**接口字段按需查询**（禁止全量读 interface-fields.json）：

```bash
# 查某接口全部字段
bun scripts/lookup-field-info.ts --fields-file <work>/interface-fields.json --interface AdjustmentRequest
# 查单字段 / 跨接口搜索 / 按变量名查
bun scripts/lookup-field-info.ts --fields-file <f> --interface AdjustmentRequest --field OpType
bun scripts/lookup-field-info.ts --fields-file <f> --search 失效时间
bun scripts/lookup-field-info.ts --fields-file <f> --var My_AdjType
```

#### Step 1.5: 脚本生成 AI 填空骨架

```bash
bun scripts/init-analysis-draft.ts --case-data <work>/case-data.json
```

生成三件套骨架（AI 不从零写任何 JSON/页面结构）：
- `analysis-draft.json`：steps/match/param_deltas 已按脚本结果预填；语义字段留空待填
- `analysis-notes.md`：证据链笔记骨架，每个场景一节必答问题清单
- `page-<hash>.md`：8 章节齐全，步骤编排表和 Delta 表已预填

#### Step 2: AI 分析（核心步骤，不可跳过）

**这是 AI 的核心工作。init 生成骨架后，必须立即执行本步骤，在分析全部完成后再进入 Step 3。**

**禁止在以下情况运行 validate-analysis.ts**：
- analysis-draft.json 中存在任何 "(AI 填写)" 或空必填字段
- analysis-notes.md 中存在任何 "(AI 填写)" 占位符
- page-*.md 中存在任何 "(AI 填写)" 占位符

**执行清单**（逐项完成，每项都是必须的）：

1. **读取分析材料**：读取 case-data.json（关注 steps 的 match/script_deltas/components）、analysis-draft.json、analysis-notes.md、page-*.md。按需用 lookup-field-info.ts 查接口字段含义。

2. **语义化 slug（slug_en）**：从占位值 `todo-scenario-english-slug` 改为语义化英文 kebab-case（如 `freeunit-expire-reset`），并同步修改 page-*.md frontmatter 的 slug。命名规范见 references/scenario-schema.md。

3. **场景名称与描述**：填写 name（简洁场景名，不是用例名）和 description（>=10 字符，描述场景的业务目的）。

4. **采纳脚本匹配**（必须同步修改 analysis-draft.json）：
   - match_status=matched（>=0.75）：直接采纳，不得推翻
   - match_status=tentative：AI 结合业务语义裁决——**确认则将 match_status 改为 "matched"、match_confidence 设为 0.85-0.95（确认=业务可用≠完美匹配，禁止设 1.0）；拒绝则清空 matched_asset_id 和 matched_step_asset_slug**，match_reason >=10 字符
   - match_status=unmatched：AI 认为有匹配时给出充分理由；无匹配则标记为无资产步骤

5. **Delta 业务理由**：**逐变量独立分析**（禁止跨步骤复制粘贴！V28 门禁会检测 reason 包含其他步骤变量名）。每条 param_deltas 补 field_description（用 lookup-field-info.ts 查，格式 `含义（数据类型）`）和 reason（>=6 字符，必须与该变量的实际语义匹配，如 My_ExpectBalanceAmt 的 reason 应说明"期望余额"而非"客户分类"）。

6. **步骤间数据流（dependencies）**：init 已自动提取脚本可见的跨步骤变量引用作为初始 dependencies，AI 必须检查并补充：每条 dependency 的 description 必须填写数据流含义。**analysis-draft.json 的 dependencies 必须与 page Section 4 一致**。

7. **四层签名（核心架构）**：
   - **pattern_signature**：核心业务接口调用链（脚本预填，排除 CreateCustomer/CreateAccount 等通用前置接口，如 `Adjustment`）——决定 create/extend
   - **intent_signature**：业务意图（AI 必填，如 `ExpireTimeCorrection`）——同接口不同目的时区分
   - **variant_signature**：核心操作变体（脚本预填，仅同接口最后操作，如 `OpType=5`）——前置操作归入 preparation_operations
   - **preparation_operations**：前置准备操作（如 `OpType=1`）——不在 variant_signature 中
   - **parameter_signature**：参数变体（脚本预填，如 `FreeUnitType=C_OOTB_Voice_Local`）——仅参数值不同
   - **capability**：业务能力归属（AI 填，如 `free-resource-management`）——约束 Pattern 归类
   - 与 existing_scenarios 比对：pattern+intent 相同 → `extend`；不同 → `create`

8. **业务实体（business_entities）**：init 已从步骤资产提取骨架，AI 必须检查并补充：
   - entity：业务对象名（如 Customer、FreeUnitInstance）
   - relation：与父实体关系（如 belongs_to Account）
   - created_by / modified_by：哪个步骤创建/修改该实体

9. **场景知识提炼**：scenario_knowledge 四要素——
   - core_business_knowledge（>=20 字符，这个场景测试什么业务流程）
   - parameter_design_rationale（数组，每项含 parameter/field_meaning/why_this_value）
   - preconditions（数组，执行前置条件）
   - expected_results（数组，预期结果）

10. **页面语义填写**：page-*.md 中所有 "(AI 填写)" 占位符替换为实际内容。步骤间数据流 from_param/to_param 必须使用 case-data 中真实存在的变量名。

11. **场景命名规范**：场景名称（name/title）须与 intent_signature 使用相同业务术语，使用业务语言而非技术操作描述。如 intent=FreeUnitExpireTimeReset → 场景名=免费资源失效时间重置（非"调账失效"）。

12. **证据链笔记**：analysis-notes.md 中所有 "(AI 填写)" 替换为真实分析记录。**步骤引用必须使用 `Step[N]` 格式**（N 为 step_index），如 `Step[1] 创建客户`、`Step[2] 调账新增免费资源`，禁止使用「步骤1」「步骤2」等人类自然编号。

13. **Pre-validate 自检**：运行 validate 前，扫描 analysis-draft.json + analysis-notes.md + page-*.md，确认无 "(AI 填写)" 残留、无空必填字段。如有残留，先补全再运行 validate。

**分析核心原则**：不信任用例名称/描述（测试人员批量复制），场景归属基于 Test_Steps 实际脚本参数 + 接口字段含义综合判定。AI 结合用例标题、步骤描述、接口字段含义、实际参数值进行语义分析。

#### Step 3: 脚本校验

```bash
bun scripts/validate-analysis.ts \
    --draft <work>/analysis-draft.json \
    --case-data <work>/case-data.json \
    --analysis-notes <work>/analysis-notes.md \
    --out-plan <work>/scenario-plan.json \
    --out-report <work>/validation-report.md
```

四层门禁：

| 层 | 级别 | 校验内容 |
|----|------|---------|
| 证据链 | error | analysis-notes.md 存在、>=200 字符、每个场景出现、无占位符残留 |
| 结构 | error | 必填字段、slug_en 非占位且格式合法、merge_mode 合法、scenario_signature 非空、page 无占位符残留、slug 一致性 |
| 一致性 | error | 不得推翻脚本 matched>=0.75；delta 全覆盖；tentative 必须裁决(不再残留tentative)；页面必含步骤编排章节；wikilink 真实性；依赖变量真实性 |
| 准确性 | error | V26: tentative确认后confidence上限0.95；V28: reason/field_description不得包含其他步骤的变量名(复制粘贴检测)；V28b: 跨步骤同类型delta(rRsp/rVars)值完全相同时warning；V29: 所有delta的reason非空且>=6字符；V30: 页面frontmatter必须含中文description(>=10字符)；V31: intent_signature必须非占位符；V33: pattern_signature必须非空；test_points必须非空；V35: notes中步骤引用使用Step[N]格式 |
| 质量 | warning | V27: 同名变量跨步骤field_description一致性；V32: 步骤>1但business_entities为空；V34: pattern_signature不应包含setup前置接口；V36: variant_signature不应含前置准备操作；V37: 场景名应与intent_signature语义对齐；reason含业务关键词且>=15字符；field_description含数据类型；notability>=2用例；推荐章节完整性；步骤>2时dependencies至少1条 |

errors>0 时不生成 plan，退出码 1。dry-run 到此结束，向用户展示 validation-report.md。

### Phase 2: 授权

```bash
bun scripts/authorize-scenario-plan.ts --plan <work>/scenario-plan.json --out <work>/scenario-plan-authorized.json
```

### Phase 3: 写入

```bash
bun scripts/apply-scenario.ts --plan <work>/scenario-plan-authorized.json --out-report <work>/apply-report.md --out-result <work>/apply-result.json
```

- 场景知识页：临时文件 + `gbrain put <slug>`（stdin）；已存在则 hash 比对
- 分析数据页（`<slug>/analysis-data`）：结构化 JSON，包含每步 asset_id + param_deltas（字段替换映射），供后续生成用例时使用
- Timeline：`gbrain timeline-add <slug> <date> <text>`，幂等
- 关系：`gbrain graph-query` 预检后 `gbrain link`
  - 场景知识页 → 分析数据页（`has_analysis_data`）
  - 分析数据页 → 步骤资产（`references_step`，每个匹配步骤一个 link）
- 验证：get 回读 hash、search 检索验证
- 失败即停，不自动重试

## 使用示例

- 示例1: dry-run 分析单用例
  - 场景/输入: 用户提供单个用例 JSON + 接口文档
  - 执行: Step 1 → Step 1.5 → **Step 2（AI 完整分析）** → Step 3
  - 预期产出: validation-report.md（0 errors）+ scenario-plan.json，供用户审核
  - 关键要点: dry-run 不跳过 AI 分析，Step 2 是核心工作

- 示例2: 增量维护已有场景（extend）
  - 场景/输入: 新用例经签名比对属于已有场景
  - 预期产出: merge_mode=extend 的 plan，apply 时追加参数变体行与用例证据
  - 关键要点: extend 严禁覆盖已有知识

- 示例3: 正式写入 GBrain
  - 场景/输入: dry-run 校验通过，用户确认后继续
  - 执行: Phase 2 授权 → Phase 3 写入
  - 预期产出: apply-report.md + apply-result.json

## 技术约束

1. **AI 分析是核心职责**：AI 负责语义和业务分析，脚本只做确定性计算。禁止跳过 Step 2。
2. **命令统一用 bun**：`bun scripts/xxx.ts`，Windows 下同样适用。PS1 包装器仅作备选（需 `-ExecutionPolicy Bypass`）。
3. **资产来源自动处理**：脚本按 API → 本地 → source_path 自动加载，AI 不需要手动查找或确认。
4. **SHA-256 计划完整性**：dry-run/authorized 双哈希；授权后修改在 apply preflight 停止
5. **幂等写入**：页面 hash 比对、Timeline marker 查重、关系预检
6. **不自动重试**：任何阶段失败即停
7. **Bun + TypeScript**：ES module
8. **真实 GBrain CLI**：见 write-protocol.md；禁止臆想命令
9. **Notability 门槛**：场景建议 >=2 用例支撑；单用例标记 insufficient（warning）
10. **输出目录**：用例目录下时间戳子目录，禁止 temp

## 资源索引

- 脚本 [scripts/scenario-core.ts](scripts/scenario-core.ts)：共享类型 + 工具（parseArgs/slug/哈希/gbrain 命令封装/资产解析/指纹匹配/delta 计算）
- 脚本 [scripts/extract-case-data.ts](scripts/extract-case-data.ts)：Phase 1 Step 1。参数：`--case-dir|--case-file --step-assets-dir --asset-api-url --interface-doc --common-structure-doc --out-dir --gbrain`
- 脚本 [scripts/lookup-field-info.ts](scripts/lookup-field-info.ts)：接口字段按需查询。参数：`--fields-file --interface --field --search --list`
- 脚本 [scripts/init-analysis-draft.ts](scripts/init-analysis-draft.ts)：Step 1.5 骨架生成。参数：`--case-data --out-dir`
- 脚本 [scripts/fetch-asset-by-id.ts](scripts/fetch-asset-by-id.ts)：资产平台 API 导出。参数：`--asset-id|--asset-ids --api-url --user --password --token --out`
- 脚本 [scripts/validate-analysis.ts](scripts/validate-analysis.ts)：Step 3 四层门禁。参数：`--draft --case-data --analysis-notes --out-plan --out-report`
- 脚本 [scripts/authorize-scenario-plan.ts](scripts/authorize-scenario-plan.ts)：Phase 2 授权。参数：`--plan --out`
- 脚本 [scripts/apply-scenario.ts](scripts/apply-scenario.ts)：Phase 3 写入。参数：`--plan --out-report --out-result --gbrain`
- 脚本 [scripts/*.ps1](scripts/)：Windows PowerShell 包装器（备选，需 `-ExecutionPolicy Bypass`）
- 参考 [references/analysis-draft-schema.md](references/analysis-draft-schema.md)：AI 草稿 Schema（填骨架空字段时读取）
- 参考 [references/scenario-schema.md](references/scenario-schema.md)：场景页 8 章节结构 + slug 命名规范
- 参考 [references/write-protocol.md](references/write-protocol.md)：真实 GBrain CLI 契约（Phase 3 前读取）
- 参考 [references/relation-types.md](references/relation-types.md)：关系类型定义
- 参考 [references/interface-doc-parsing.md](references/interface-doc-parsing.md)：接口文档解析规范
- 参考 [references/design-doc.md](references/design-doc.md)：设计方案与变更记录
- 参考 [references/execution-review-checklist.md](references/execution-review-checklist.md)：执行效果检验清单

## 执行效果检验

- 当用户提供"AI 执行过程记录 + 执行产物"要求检验时，按 [execution-review-checklist.md](references/execution-review-checklist.md) 逐项检查
- 检验纪律：禁止只看最终报告下结论，必须打开产物原文核对
- 发现的 skill 缺陷记录到 design-doc.md 并 bump 版本号

## 注意事项

- 仅在需要时读取参考文档，保持上下文简洁
- AI 的产物是 analysis-draft.json + analysis-notes.md + page-*.md 三类文件
- 门禁不替代 AI 分析，只确认"AI 确实分析了"；被门禁拦下时补充分析而非绕过
- extend 模式先 `gbrain get <target_scenario_slug>` 读取已有页再增量合入
