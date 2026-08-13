# 执行效果检验清单（Execution Review Checklist）

## 目录
- [使用方式](#使用方式)
- [A. 材料完整性](#a-材料完整性)
- [B. 流程规范性](#b-流程规范性)
- [C. 产物完整性](#c-产物完整性)
- [D. 门禁结果](#d-门禁结果)
- [E. 知识页内容质量](#e-知识页内容质量)
- [F. 准确性抽查](#f-准确性抽查)
- [G. GBrain 入库验证](#g-gbrain-入库验证)
- [H. 效率与稳定性](#h-效率与稳定性)
- [检验报告输出模板](#检验报告输出模板)

## 使用方式

用户提供以下材料后，按本清单逐项检查：
1. AI 执行/思考过程记录（必需）
2. 输出目录打包文件（必需，含 case-data.json、analysis-draft.json、page-*.md 等）
3. 执行环境信息（skill 版本、GBrain 版本；缺失时主动询问）

检查顺序固定为 A → H；每步给出 PASS / FAIL / N/A + 证据（文件路径、行号、字段值）。
禁止只看最终报告下结论——必须打开产物原文核对。

## A. 材料完整性

| # | 检查项 | 通过标准 |
|---|--------|---------|
| A1 | AI 执行过程记录可读 | 能看到完整的命令调用序列与思考，而非只有结论 |
| A2 | 输出产物齐全 | 含 case-data.json、analysis-draft.json、analysis-notes.md、page-*.md、scenario-validation-report.md；执行了 Step 4/5 时还应有 scenario-plan.json、授权 plan、apply 报告 |
| A3 | 版本信息可确认 | skill 版本（SKILL.md frontmatter version）与当前最新版一致；不一致时在报告开头显著标注"非最新版执行" |

## B. 流程规范性

对照 SKILL.md 标准流程逐项核对执行记录：

| # | 检查项 | 通过标准 | 常见违规（历史案例） |
|---|--------|---------|---------------------|
| B1 | 步骤顺序 | Step 1 extract → Step 1.5 init → Step 2 AI 填空 → Step 3 validate →（可选）Step 4 authorize → Step 5 apply；无跳步、无逆序 | v0.4.0 时代 AI 跳过 validate 直接写 plan |
| B2 | 返工轮数 | validate FAIL → 修复 → 重验的循环 ≤ 2 轮为正常；≥ 3 轮必须定位根因（骨架缺陷/门禁提示不清/AI 未读参考文档） | v0.4.0 时代 21 分钟反复修改 |
| B3 | AI 输出方式 | AI 只填充骨架中的 `(AI 填写...)` 占位符；禁止从零手写 draft JSON 结构 | v0.5.0 前 param_deltas 放错层级 |
| B4 | 接口字段加载方式 | AI 用 lookup-field-info.ts 按需查询；禁止全量读取 interface-fields.json | v0.4.0 时代 AI 全量读 92K 文件 |
| B5 | 输出目录 | 带时间戳的独立子目录（cbs-scenario-analyze-<时间戳>），未污染其他目录 | 早期版本写 temp 目录 |
| B6 | 授权约束 | apply 前必须先 authorize；plan_integrity.authorized=true；无未授权写库 | — |
| B7 | AI 抱怨/异常信号 | 执行记录中无"文件太大""JSON 解析失败重试 N 次"等异常信号；出现即定位具体文件与原因 | v0.4.0 时代 page_draft JSON 转义地狱 |

## C. 产物完整性

| # | 检查项 | 通过标准 |
|---|--------|---------|
| C1 | case-data.json 结构 | 顶层含 cases/step_assets/interface_catalog/existing_scenarios/extraction_meta；**不得**内嵌 interface_fields/field_mapping（v0.5.0 起物理拆分） |
| C2 | interface-fields.json 独立存在 | 有接口文档时该文件存在且与 interface_catalog 条目数一致 |
| C3 | 匹配与 delta 统计 | 每步有 match（matched/tentative/unmatched）与 script_deltas；记录 matched/tentative/unmatched 数量分布 |
| C4 | 草稿与场景对应 | draft.scenarios 覆盖全部 source_cases；每场景 page_draft_file 指向的 md 文件存在且不重名 |
| C5 | 页面骨架来源 | page-*.md 含脚本预填的步骤编排表（与 draft.steps 一致），而非 AI 自拟结构 |

## D. 门禁结果

| # | 检查项 | 通过标准 |
|---|--------|---------|
| D1 | 最终 validate 结果 | 0 errors（FAIL 状态的产物不允许进入后续评审） |
| D2 | warnings 逐条审视 | 每条 warning 判断：合理（如 notability 单用例提示）/ 需改进（如 field_description 缺数据类型过多，>20% 视为 AI 敷衍） |
| D3 | 分析笔记真实性 | 无 `(AI 填写` 占位残留；证据链具体（引用了具体步骤、参数、接口字段），而非"已逐步核对"套话——抽查 1 个场景的笔记内容 |
| D4 | 门禁拦截记录 | 若执行中有 FAIL 轮，检查被拦问题是否真正修复（而非绕过，如删除校验项、改阈值） |

## E. 知识页内容质量

逐场景检查 page-*.md：

| # | 检查项 | 通过标准 |
|---|--------|---------|
| E1 | slug 语义化 | `cbs/scenarios/<site>/<英文 kebab-case>`；符合 `<对象>-<操作>[-<限定>]` 规范；非哈希（scenario-[0-9a-f]{8}）、非占位 | 
| E2 | slug 一致性 | 页面 frontmatter slug == plan 中 pages[].slug == draft slug_en 推导值 |
| E3 | 8 章节齐全 | 场景定义/步骤编排/参数Delta/步骤间数据流/验证点/参数变体表/无资产步骤/用例生成指引；章节名按 schema 而非自拟 |
| E4 | 步骤编排表 | 含 顺序/步骤行为/资产名/asset_id/匹配置信度 列；步骤顺序与 draft.steps 一致；读后能回答"这个场景有哪几步、怎么串联" |
| E5 | 参数 Delta 表 | 每条 delta 有业务理由；理由具体（说明为什么设这个值），"按场景需要设置"式套话占比 >50% 判 FAIL |
| E6 | 场景知识四要素 | core_business_knowledge 解释了"为什么这样构建"（引用接口语义）；preconditions/expected_results 具体可验证 |
| E7 | 数据流表 | from_param/to_param 为用例真实变量；无 AI 编造变量（历史案例：My_EXP_DATE_NEW） |
| E8 | 无资产步骤 | unmatched 步骤有组件结构描述与 missing_step_suggestions（suggested_slug 语义化） |
| E9 | 用例生成指引 | 给出可操作的重建步骤（取资产 JSON → 应用 delta → 组装），而非泛泛而谈 |

## F. 准确性抽查

抽样核对（每场景至少抽 2 条 delta + 1 个字段含义）：

| # | 检查项 | 通过标准 |
|---|--------|---------|
| F1 | delta 值真实性 | 打开用例 JSON 与资产 JSON，抽查 delta 的 case_value/asset_value 与原文一致，add/remove/modify 分类正确 |
| F2 | 字段含义准确性 | 抽查 1-2 个接口字段解释（如 OpType=5）与接口文档原文一致；AI 不得编造取值语义 |
| F3 | 场景判断依据 | 场景划分基于 实际脚本参数+接口字段含义（笔记中有证据），而非仅用例名称/描述 |
| F4 | wikilink 真实性 | 页面所有 [[slug]] 目标在 GBrain 中存在（gbrain get 或 list 验证） |
| F5 | 资产匹配正确性 | 抽查 matched/tentative 匹配：组件序列、接口模板确实吻合；AI 推翻 tentative 时有合理理由 |

## G. GBrain 入库验证

仅在执行了 apply 时检查：

| # | 检查项 | 通过标准 |
|---|--------|---------|
| G1 | 页面写入回读 | gbrain get <slug> 成功，内容与 plan 一致（脚本回读 hash 校验通过） |
| G2 | Timeline 幂等 | timeline 条目存在；重复执行无重复条目（REUSED） |
| G3 | 链接建立 | evidenced_by 等 link 经 graph-query 验证存在 |
| G4 | 健康检查 | apply 尾部健康检查 PASS（死链/孤儿/标签） |
| G5 | 真实环境命令 | 全部使用真实 CLI（put/get/list/link/timeline-add/graph-query/stats/search）；出现臆想命令（write/capture/get_page）立即 FAIL 并升级为 skill 缺陷 |

## H. 效率与稳定性

| # | 检查项 | 参考基线 |
|---|--------|---------|
| H1 | 总耗时 | 骨架驱动后单用例场景应 < 10 分钟；超过 15 分钟需分析瓶颈 |
| H2 | 脚本报错次数 | extract/init/validate 非预期报错（非门禁拦截）应为 0 |
| H3 | 上下文健康度 | AI 无"上下文不足""截断"迹象；单文件读取 >50K 需关注 |

## 检验报告输出模板

```markdown
# 执行效果检验报告

- 检验对象:<输出目录/zip 名> | skill 版本:<version> | GBrain 版本:<version>
- 执行时间:<从执行记录提取> | 场景数:<N> | 用例数:<N>

## 总体结论
<可入库 / 可入库但需关注 warnings / 需修复后重跑 / skill 缺陷需修改>

## 分项结果
| 检查区 | 结果 | 说明 |
|--------|------|------|
| A 材料完整性 | PASS/FAIL | ... |
| B 流程规范性 | PASS/FAIL | ... |
| C 产物完整性 | PASS/FAIL | ... |
| D 门禁结果 | PASS/FAIL | ... |
| E 内容质量 | PASS/FAIL | ... |
| F 准确性抽查 | PASS/FAIL | ... |
| G 入库验证 | PASS/FAIL/N/A | ... |
| H 效率稳定性 | PASS/FAIL | ... |

## 问题清单(按严重度)
| # | 严重度 | 问题 | 证据 | 处置建议 |
|---|--------|------|------|---------|
| 1 | 阻断/重要/建议 | ... | 文件:行号/字段 | 修复 skill / 重新执行 / 下一版改进 |

## skill 改进候选(若有)
<需要修改 skill 的问题,记录到 design-doc.md 变更记录>
```

## 严重度定义

- **阻断**：产物不可用或数据不可信——门禁 FAIL 未处理、delta 值与原文不符、slug 无语义、页面结构缺失、臆想内容（wikilink/变量/字段含义）
- **重要**：可用但质量受损——套话理由过多、warnings 大面积未处理、流程违规但未影响产物
- **建议**：体验与效率改进——耗时偏长、提示信息不够清晰、文档可优化
