#!/usr/bin/env bun
/**
 * init-analysis-draft.ts
 * 从 case-data.json 生成 AI 填空骨架三件套：
 *   1. analysis-draft.json  — 结构 100% 符合 schema，steps/match/param_deltas 已按脚本结果预填，AI 只补语义字段
 *   2. analysis-notes.md    — 证据链笔记骨架（每个场景一节，含必答问题清单）
 *   3. page-<slug>.md       — 每个场景一个页面骨架，8 章节齐全，步骤编排表/参数Delta表已预填
 *
 * 设计目的：AI 不从零写 JSON/页面结构（容易写错层级导致反复修改），只填写业务语义内容。
 *
 * 用法：
 *   bun init-analysis-draft.ts --case-data <case-data.json> [--out-dir <dir>]
 * 输出：JSON（stdout）{ draft_file, notes_file, page_files[] }
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  asString,
  parseArgs,
  sha256,
  siteKeyFromId,
  type AnalysisDraft,
  type AnalysisDraftScenario,
  type CaseDataFile,
  type ParamDeltaItem,
  type ParamDependency,
  type ScriptDeltaItem,
  type OperationVariant,
  type ParameterVariant,
  type BusinessEntity,
} from './scenario-core.ts';

// ─── 本地类型别名 ───
type CaseStepWithMatch = CaseDataFile['cases'][number]['steps'][number];
type StepAssetFile = CaseDataFile['step_assets'][number];

// ─── 跨步骤变量依赖自动提取 ───
// 从 script_deltas 中识别：步骤 A 设置的变量 My_X 在步骤 B 的 delta 中被引用 → 生成初始 dependencies
function extractCrossStepDeps(steps: CaseDataFile['cases'][number]['steps']): ParamDependency[] {
  // 收集每步"设置"的变量（add/modify-default 类型的 variable_name）
  const stepSets: Map<number, Set<string>> = new Map();
  for (const s of steps) {
    const sets = new Set<string>();
    for (const sd of s.script_deltas) {
      if (sd.delta_type === 'add' || sd.delta_type === 'modify') {
        sets.add(sd.variable_name);
      }
    }
    stepSets.set(s.step_index, sets);
  }
  // 收集每步"引用"的变量（所有 delta 中出现的 variable_name，不含本步设置的）
  const deps: ParamDependency[] = [];
  for (const s of steps) {
    const thisSets = stepSets.get(s.step_index) ?? new Set();
    for (const sd of s.script_deltas) {
      if (thisSets.has(sd.variable_name)) continue; // 本步设置的，不是引用
      // 查找哪一步设置了这个变量
      for (const [fromIdx, fromSets] of stepSets) {
        if (fromIdx >= s.step_index) continue; // 只看前面的步骤
        if (fromSets.has(sd.variable_name)) {
          // 去重：同一 from→to+variable 只加一次
          const dup = deps.some(d => d.from_step === fromIdx && d.to_step === s.step_index && d.from_param === sd.variable_name);
          if (!dup) {
            deps.push({
              from_step: fromIdx,
              to_step: s.step_index,
              from_param: sd.variable_name,
              to_param: sd.variable_name,
              type: 'variable-reference',
              description: '',  // AI 必填：说明数据流含义
            });
          }
        }
      }
    }
  }
  return deps;
}

// ─── delta 映射：脚本 delta → 草稿 param_delta（AI 补 reason） ───
function toParamDelta(stepIndex: number, sd: ScriptDeltaItem): ParamDeltaItem {
  return {
    step_index: stepIndex,
    change_type: sd.delta_type === 'modify' ? 'modify-default' : sd.delta_type,
    component_alias: sd.component_alias,
    variable_name: sd.variable_name,
    field_path: '',
    field_description: sd.param_description ?? '',
    case_value: sd.case_value ?? '',
    asset_default_value: sd.asset_value,
    reason: '',  // AI 必填：为什么这样设置
  };
}

// ─── 页面骨架（8 章节，步骤编排表/参数Delta表预填） ───
function renderPageSkeleton(sc: AnalysisDraftScenario, caseData: CaseDataFile, slug: string, title: string): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('type: cbs-scenario-pattern');
  lines.push(`title: ${title}`);
  lines.push(`slug: ${slug}`);
  lines.push(`name_cn: "(AI 填写中文场景名)"`);
  lines.push(`description: "(AI 填写中文场景描述：一句话概括场景业务目的和测试目标)"`);
  lines.push('tags:');
  lines.push('  - cbs');
  lines.push('  - scenario-pattern');
  lines.push(`created_at: ${new Date().toISOString()}`);
  lines.push(`updated_at: ${new Date().toISOString()}`);
  lines.push('source_cases:');
  for (const cid of sc.source_cases) lines.push(`  - ${cid}`);
  lines.push(`merge_mode: ${sc.merge_mode}`);
  lines.push(`pattern_signature: "${sc.pattern_signature || ''}"`);
  lines.push(`intent_signature: "${sc.intent_signature || ''}"`);
  lines.push(`variant_signature: "${sc.variant_signature || ''}"`);
  const prepOps = Array.isArray(sc.preparation_operations) ? sc.preparation_operations.join(',') : (sc.preparation_operations || '');
  lines.push(`preparation_operations: "${prepOps}"`);
  lines.push(`parameter_signature: "${sc.parameter_signature || ''}"`);
  if (sc.capability) lines.push(`capability: "${sc.capability}"`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${title}`);
  lines.push('');
  lines.push('> **中文场景名**：(AI 填写中文场景名)  |  **场景描述**：(AI 填写中文场景描述：一句话概括场景业务目的和测试目标)');
  lines.push('');

  // 1. 场景定义
  lines.push('## 1. 场景定义');
  lines.push('');
  lines.push('<!-- AI 填写：场景一句话描述、业务目的、测试点（每个测试点关联关键参数及为什么）、前置条件、预期结果 -->');
  lines.push('');
  lines.push('');
  lines.push('**测试点**：');
  lines.push('');
  lines.push('| 测试点 | 关联关键参数 | 为什么这样构建 |');
  lines.push('|--------|-------------|----------------|');
  for (const tp of sc.test_points) {
    lines.push(`| ${tp.test_point} | ${tp.related_parameters.join(', ')} | ${tp.design_reason} |`);
  }
  if (sc.test_points.length === 0) {
    lines.push('| (AI 填写) | | |');
  }
  lines.push('');
  lines.push('**前置条件**：(AI 填写)');
  lines.push('');
  lines.push('**预期结果**：(AI 填写)');
  lines.push('');

  // 2. 步骤编排（预填）
  lines.push('## 2. 步骤编排');
  lines.push('');
  lines.push('| 顺序 | 步骤行为 | 资产名称 | asset_id | GBrain 页 | 匹配置信度 |');
  lines.push('|------|----------|----------|----------|-----------|------------|');
  for (const st of sc.steps) {
    const asset = caseData.step_assets.find((a) => a.asset_id === st.matched_asset_id);
    const assetName = asset?.name ?? '(无资产)';
    const assetId = st.matched_asset_id ?? '-';
    const wikilink = st.matched_step_asset_slug ? `[[${st.matched_step_asset_slug}]]` : '-';
    lines.push(`| ${st.step_index + 1} | ${st.behavior} | ${assetName} | ${assetId} | ${wikilink} | ${st.match_confidence.toFixed(2)} |`);
  }
  lines.push('');
  lines.push('<!-- 说明：asset_id 是测试资产平台真实 ID，生成用例时凭它经 API 获取步骤 JSON；GBrain 页用 wikilink 引用 -->');
  lines.push('');

  // 3. 参数 Delta（每步一节，预填）
  lines.push('## 3. 参数 Delta');
  lines.push('');
  for (const st of sc.steps) {
    if (st.param_deltas.length === 0) continue;
    const asset = caseData.step_assets.find((a) => a.asset_id === st.matched_asset_id);
    lines.push(`### 步骤 ${st.step_index + 1}：${st.behavior}（资产：${asset?.name ?? '无'}）`);
    lines.push('');
    lines.push('| 组件 | 变量 | 变更 | 资产值 | 场景值 | 业务理由 |');
    lines.push('|------|------|------|--------|--------|----------|');
    for (const pd of st.param_deltas) {
      const av = pd.asset_default_value === null ? '∅' : `\`${pd.asset_default_value}\``;
      const cv = pd.change_type === 'remove' ? '∅' : `\`${pd.case_value}\``;
      lines.push(`| ${pd.component_alias} | ${pd.variable_name} | ${pd.change_type} | ${av} | ${cv} | (AI 填写${pd.field_description ? '，参考：' + pd.field_description : ''}) |`);
    }
    lines.push('');
  }
  lines.push('<!-- 业务理由必须解释"为什么设置这个值"，而非仅描述"值是什么"；字段含义可用 lookup-field-info.ts 按需查询 -->');
  lines.push('');

  // 4. 步骤间数据流
  lines.push('## 4. 步骤间数据流');
  lines.push('');
  lines.push('| 来源步骤 | 目标步骤 | 来源参数 | 目标参数 | 类型 | 说明 |');
  lines.push('|----------|----------|----------|----------|------|------|');
  lines.push('| (AI 填写，如：1 创建客户 | 2 调账 | My_CustomerId | My_AcctId | variable-reference | 创建输出定位后续账户) | | | | |');
  lines.push('');

  // 5. 验证点
  lines.push('## 5. 验证点');
  lines.push('');
  lines.push('<!-- AI 填写：每个验证步骤检查什么、期望值如何从前面步骤导出 -->');
  lines.push('');

  // 6. 参数变体表
  lines.push('## 6. 参数变体表');
  lines.push('');
  lines.push('| 参数 | ' + sc.source_cases.join(' | ') + ' | 说明 |');
  lines.push('|------|' + sc.source_cases.map(() => '---').join('|') + '|------|');
  lines.push('| (增量维护：同场景新用例的不同取值在此追加列) | | |');
  lines.push('');

  // 7. 无资产步骤
  lines.push('## 7. 无资产步骤');
  lines.push('');
  const noAsset = sc.steps.filter((st) => !st.matched_asset_id);
  if (noAsset.length === 0) {
    lines.push('（本场景全部步骤均已匹配资产）');
  } else {
    for (const st of noAsset) {
      lines.push(`- 步骤 ${st.step_index + 1}「${st.behavior}」：未匹配资产。<!-- AI 填写：组件结构说明 + 入库建议 -->`);
    }
  }
  lines.push('');

  // 8. 用例生成指引
  lines.push('## 8. 用例生成指引');
  lines.push('');
  lines.push('1. 按「步骤编排」表顺序，凭 asset_id 经资产平台 API（或 source_path 兜底）获取各步骤 template_json');
  lines.push('2. 按「参数 Delta」逐条应用 add/remove/modify 修改');
  lines.push('3. 按「步骤间数据流」串联步骤间变量引用');
  lines.push('4. 组装完整用例 JSON 后转 XML 用例文件');
  lines.push('<!-- AI 补充：本场景特有的生成注意事项 -->');
  lines.push('');

  // 9. 业务实体关系
  lines.push('## 9. 业务实体关系');
  lines.push('');
  if (sc.business_entities && sc.business_entities.length > 0) {
    lines.push('| Entity | Relation | Created By | Modified By |');
    lines.push('|--------|----------|------------|-------------|');
    for (const be of sc.business_entities) {
      lines.push(`| ${be.entity} | ${be.relation || '-'} | ${be.created_by || '-'} | ${be.modified_by || '-'} |`);
    }
  } else {
    lines.push('<!-- AI 填写：识别本场景涉及的核心业务实体（如 Customer/Account/FreeUnitInstance），及其创建/修改来源 -->');
  }
  lines.push('');

  // 10. Operation Variants
  lines.push('## 10. 操作变体 (Operation Variants)');
  lines.push('');
  if (sc.operation_variants && sc.operation_variants.length > 0) {
    lines.push('| Operation | Role | Description | Key Difference |');
    lines.push('|-----------|------|-------------|----------------|');
    for (const ov of sc.operation_variants) {
      lines.push(`| ${ov.variant_signature} | ${ov.role || 'unknown'} | ${ov.description || '(AI 填写)'} | ${ov.difference || '-'} |`);
    }
  } else {
    lines.push('<!-- AI 填写：同一 Pattern 下不同的操作变体（如 OpType=1 调增 vs OpType=2 调减），若无则填"无" -->');
  }
  lines.push('');

  // 11. Parameter Variants
  lines.push('## 11. 参数变体 (Parameter Variants)');
  lines.push('');
  if (sc.parameter_variants && sc.parameter_variants.length > 0) {
    lines.push('| Parameter | Value | Source Cases |');
    lines.push('|-----------|-------|-------------|');
    for (const pv of sc.parameter_variants) {
      lines.push(`| ${pv.parameter_name} | ${pv.parameter_value} | ${pv.source_cases.join(', ') || '(当前用例)'} |`);
    }
  } else {
    lines.push('<!-- AI 填写：仅参数值不同不影响步骤序列的变体（如 FreeUnitType=Voice/SMS/Data），若无则填"无" -->');
  }
  lines.push('');

  return lines.join('\n');
}

// ─── 笔记骨架 ───
function renderNotesSkeleton(draft: AnalysisDraft, caseData: CaseDataFile): string {
  const lines: string[] = [];
  lines.push('# 分析笔记（证据链）');
  lines.push('');
  lines.push('<!-- 本文件是"AI 确实分析了"的证据。每个场景必须有一节，包含对下列问题的回答。');
  lines.push('     禁止留空或只写套话——validate-analysis.ts 会检查每节是否包含场景关键步骤名。');
  lines.push('     ★ 步骤引用必须使用 Step[N] 格式（N 为 step_index），如 Step[1] 创建客户、Step[3] 调账新增。');
  lines.push('     ★ 禁止使用自然编号如"步骤1""第一步"——会导致引用与 step_index 不一致。 -->');
  lines.push('');
  for (const sc of draft.scenarios) {
    lines.push(`## 场景：${sc.name}（${sc.scenario_id}）`);
    lines.push('');
    lines.push(`**来源用例**：${sc.source_cases.join(', ')}`);
    lines.push('');
    lines.push('1. **这个场景测什么业务点？**（结合用例脚本实际调用的接口与参数，而非仅看用例名称）');
    lines.push('   (AI 填写)');
    lines.push('');
    lines.push('2. **步骤串联逻辑**：为什么按这个顺序执行？步骤间数据如何传递？');
    lines.push('   (AI 填写)');
    lines.push('');
    lines.push('3. **关键参数为什么这样设置**：');
    for (const st of sc.steps) {
      const interesting = st.param_deltas.filter((pd) => pd.change_type !== 'remove').slice(0, 5);
      for (const pd of interesting) {
        lines.push(`   - Step[${st.step_index}] \`${pd.variable_name}\` = \`${pd.case_value}\`：(AI 填写原因)`);
      }
    }
    lines.push('');
    lines.push('4. **匹配确认**：对 tentative 匹配的步骤，确认或推翻脚本结论的依据是什么？');
    for (const st of sc.steps) {
      if (st.match_confidence > 0 && st.match_confidence < 0.75) {
        lines.push(`   - Step[${st.step_index}]「${st.behavior}」（置信度 ${st.match_confidence.toFixed(2)}）：(AI 填写)`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main(): void {
  const args = parseArgs(process.argv);
  const caseDataPath = asString(args['case-data']);
  if (!caseDataPath) {
    console.error('Usage: bun init-analysis-draft.ts --case-data <case-data.json> [--out-dir <dir>]');
    process.exit(1);
  }
  if (!existsSync(caseDataPath)) {
    console.error(JSON.stringify({ error: `case-data not found: ${caseDataPath}` }));
    process.exit(1);
  }
  // 修复 out-dir 空串 bug：asString 缺失时返回 ''（非 null），?? 不触发回退，导致文件写入进程 CWD
  const outDirArg = asString(args['out-dir']).trim();
  const outDir = outDirArg || dirname(caseDataPath.replace(/\\/g, '/')) || '.';
  console.error(`[init-draft] out-dir: ${resolve(outDir)}`);
  const caseData = JSON.parse(readFileSync(caseDataPath, 'utf8')) as CaseDataFile;

  const scenarios: AnalysisDraftScenario[] = [];
  const pageFiles: string[] = [];

  for (const c of caseData.cases) {
    const siteKey = siteKeyFromId(c.basic_info.site_id, c.basic_info.site_name);
    const scenarioId = `SCN-${sha256(c.case_id).slice(0, 6).toUpperCase()}`;
    // 骨架场景名：用例名常是长句（超 slug 96 字符限制且非场景名），
    // 骨架用短哈希占位名，AI 必须改写为简洁场景名（validate V1 会校验 name 非空且 generateScenarioSlug 会兜底）
    const skeletonName = `scenario-draft-${sha256(c.case_id).slice(0, 8)}`;
    // slug_en 占位：AI 必须改写为语义化英文 kebab-case（如 freeunit-expire-reset）
    // GBrain 设计理念：slug 即身份/搜索锚点/图谱节点，禁止无语义哈希
    const slugEnPlaceholder = `todo-scenario-english-slug`;
    const slug = `cbs/scenarios/${siteKey}/${slugEnPlaceholder}`;
    // 页面文件名按用例哈希唯一命名（占位 slug 各场景相同，不能直接用于文件名，否则多场景互相覆盖）
    const pageFileName = `page-scenario-draft-${sha256(c.case_id).slice(0, 8)}.md`;

    // 四签名 + 变体：脚本自动从步骤数据提取
    const sigs = computeSignatures(c.steps, c.case_id);

    const sc: AnalysisDraftScenario = {
      scenario_id: scenarioId,
      name: skeletonName,  // 占位名：AI 必须改写为简洁场景名（如 "免费资源调账失效场景"）
      slug_en: slugEnPlaceholder,  // 占位：AI 必填语义化英文 slug（如 freeunit-expire-reset）
      description: '',
      site_key: siteKey,
      site_id: c.basic_info.site_id ?? '',
      site_name: c.basic_info.site_name ?? '',
      product_slug: '',
      source_cases: [c.case_id],
      merge_mode: 'create',
      target_scenario_slug: null,
      // 四层签名（v0.12.0+）：scenario_signature 已删除，由 pattern+intent+variant+parameter 四签名替代
      pattern_signature: sigs.pattern_signature,   // 接口调用链（排除 setup 步骤）→ 如 "Adjustment"
      intent_signature: sigs.intent_signature,      // 占位：AI 必填 → 如 "ExpireTimeCorrection"
      variant_signature: sigs.variant_signature,    // 操作变体（仅核心操作）→ 如 "OpType=5"
      preparation_operations: sigs.preparation_operations,  // 前置准备操作 → 如 "OpType=1"
      parameter_signature: sigs.parameter_signature, // 参数变体 → 如 "FreeUnitType=C_OOTB_Voice_Local"
      capability: null,  // AI 可选：业务能力归属 → 如 "free-resource-management"
      test_points: [{ test_point: '(AI 填写)', related_parameters: [], design_reason: '(AI 填写)' }],  // AI 必填测试点
      steps: c.steps.map((s) => ({
        step_index: s.step_index,
        behavior: s.step_name,
        matched_step_asset_slug: s.match.matched_slug ?? null,
        matched_asset_id: s.match.matched_asset_id ?? null,
        match_confidence: s.match.confidence ?? 0,
        match_status: (s.match.match_status === 'matched' || (s.match.confidence ?? 0) >= 0.75) ? 'matched' as const
          : (s.match.match_status === 'tentative' || (s.match.confidence ?? 0) > 0) ? 'tentative' as const
          : 'unmatched' as const,
        match_reason: s.match.match_reason ?? '',
        param_deltas: s.script_deltas.map((sd) => toParamDelta(s.step_index, sd)),
        source_case_refs: [{ case_id: c.case_id, step_index: s.step_index }],
      })),
      dependencies: extractCrossStepDeps(c.steps),
      business_entities: extractBusinessEntities(c.steps, caseData.step_assets),  // 骨架：实体名+操作，AI 补充 relation
      operation_variants: sigs.operation_variants,   // 操作变体（Pattern 页面内章节）
      parameter_variants: sigs.parameter_variants,   // 参数变体（Pattern 页面内表格）
      missing_step_suggestions: c.steps
        .filter((s) => s.match.match_status === 'unmatched' && s.fingerprint.component_sequence.length > 0)
        .map((s) => ({
          step_index: s.step_index,
          step_name: s.step_name,
          component_sequence: s.fingerprint.component_sequence,
          interface_template: s.fingerprint.interface_template,
          suggested_slug: '',
          reason: '',  // AI 填写入库建议理由
        })),
      variant_suggestions: [],
      page_draft_file: pageFileName,
      scenario_knowledge: {
        core_business_knowledge: '',
        parameter_design_rationale: [],
        preconditions: [],
        expected_results: [],
        key_decision_points: [],
      },
      similar_existing_scenarios: (caseData.existing_scenarios ?? []).slice(0, 5).map((es) => ({
        slug: es.slug,
        title: es.title,
        similarity_reason: '',  // AI 判断：相似则说明并考虑 extend
      })),
    };
    scenarios.push(sc);

    // 页面骨架
    const pageContent = renderPageSkeleton(sc, caseData, slug, '(AI 填写场景名称)');
    writeFileSync(join(outDir, pageFileName), pageContent, 'utf8');
    pageFiles.push(join(outDir, pageFileName));
  }

  const draft: AnalysisDraft = {
    schema_version: 'cbs-scenario-analysis-v1',
    analyzed_at: new Date().toISOString(),
    source_case_data: caseDataPath,
    scenarios,
  };
  const draftPath = join(outDir, 'analysis-draft.json');
  writeFileSync(draftPath, JSON.stringify(draft, null, 2), 'utf8');

  const notesPath = join(outDir, 'analysis-notes.md');
  writeFileSync(notesPath, renderNotesSkeleton(draft, caseData), 'utf8');

  // 写入自检：Windows 下路径分隔符异常会导致文件落到错误目录，必须验证
  for (const f of [draftPath, notesPath, ...pageFiles]) {
    if (!existsSync(f)) {
      console.error(`[init-draft] FATAL: 文件写入后不存在: ${f}`);
      process.exit(1);
    }
  }
  console.error(`[init-draft] scenarios: ${scenarios.length}`);
  console.error(`[init-draft] outDir: ${outDir}`);
  console.error('[init-draft] NEXT: AI 只填写语义内容（reason/knowledge/页面 AI 填写区），禁止改动 JSON 结构');
  console.log(JSON.stringify({
    out_dir: resolve(outDir),
    draft_file: draftPath,
    notes_file: notesPath,
    page_files: pageFiles,
    scenario_count: scenarios.length,
  }));
}

// ── signature computation ───────────────────────────────────────────
interface ComputedSignatures {
  pattern_signature: string;
  intent_signature: string;
  variant_signature: string;
  parameter_signature: string;
  preparation_operations: string[];  // 前置准备操作（不在 variant_signature 中）
  operation_variants: OperationVariant[];
  parameter_variants: ParameterVariant[];
}

function computeSignatures(
  steps: CaseStepWithMatch[],
  caseId: string,
): ComputedSignatures {
  // ── Setup interface templates: 通用前置/准备步骤，不属于 Pattern 核心业务流 ──
  // 这些接口出现在几乎所有 CBS 用例中，纳入 pattern_signature 会导致同业务不同前置步骤被拆为不同 Pattern
  const SETUP_INTERFACE_TEMPLATES = new Set([
    'CreateCustomer', 'CreateAccount', 'Login', 'SystemParameter',
    'InitBalance', 'PrepareData', 'Setup', 'Initialize',
  ]);

  // pattern_signature: unique interface templates across steps (sorted), excluding setup steps
  const interfaceTemplates = [...new Set(
    steps
      .map((s) => s.fingerprint?.interface_template)
      .filter((t): t is string => !!t)
      .filter((t) => !SETUP_INTERFACE_TEMPLATES.has(t)),
  )].sort();
  const patternSig = interfaceTemplates.length > 0
    ? interfaceTemplates.join('+')
    : 'unknown';

  // variant_signature: operation-type parameters (OpType/ActionType/OperType etc.)
  // 对同一 interface_template 的多个操作步骤，只取 step_index 最大的（核心操作），
  // 其余归入 preparation_operations（前置操作）——防止 OpType=1+OpType=5 碎片化
  const opTypeKeys = ['OpType', 'ActionType', 'OperType', 'OperationType', 'opType', 'actionType'];
  // 收集每步的 OpType + 关联 interface_template
  const stepOps: { step_index: number; opKey: string; interface_template: string }[] = [];
  for (const step of steps) {
    let found = false;
    const rReq = step.components?.find((c) => c.option_parameter?.rReq)?.option_parameter?.rReq;
    if (rReq && typeof rReq === 'object') {
      for (const key of opTypeKeys) {
        const val = findInNested(rReq as Record<string, unknown>, key);
        if (val !== undefined) {
          stepOps.push({ step_index: step.step_index, opKey: `${key}=${val}`, interface_template: step.fingerprint?.interface_template || '' });
          found = true;
        }
      }
    }
    // Also check TableSetVar for OpType
    const tsv = step.components?.find((c) => c.aw_alias === 'TableSetVar')?.option_parameter;
    const tsvVars = typeof tsv?.vars === 'object' ? tsv!.vars as Record<string, unknown>
      : typeof tsv?.vars === 'string' ? Object.fromEntries(
          (tsv!.vars as string).split(';').filter(Boolean).map((kv: string) => {
            const i = kv.indexOf('=');
            return i > 0 ? [kv.slice(0, i), kv.slice(i + 1)] : null;
          }).filter((x): x is [string, string] => x !== null),
        )
      : null;
    if (tsvVars) {
      for (const key of opTypeKeys) {
        if (tsvVars[key] !== undefined) {
          stepOps.push({ step_index: step.step_index, opKey: `${key}=${tsvVars[key]}`, interface_template: step.fingerprint?.interface_template || '' });
          found = true;
        }
      }
    }
  }
  // 按接口分组：同一 interface_template 只保留 step_index 最大的作为 core，其余为 prepare
  const byInterface = new Map<string, typeof stepOps>();
  for (const op of stepOps) {
    const key = op.interface_template || '_unknown';
    if (!byInterface.has(key)) byInterface.set(key, []);
    byInterface.get(key)!.push(op);
  }
  const coreOps: string[] = [];
  const prepareOps: string[] = [];
  for (const [, ops] of byInterface) {
    ops.sort((a, b) => a.step_index - b.step_index);
    // 最后一个（step_index 最大）= 核心操作；其余 = 前置操作
    for (let i = 0; i < ops.length; i++) {
      if (i === ops.length - 1) coreOps.push(ops[i].opKey);
      else prepareOps.push(ops[i].opKey);
    }
  }
  const variantSig = [...new Set(coreOps)].sort().join(',');
  const preparationOps = [...new Set(prepareOps)].sort();  // string[] — 不 join，保持数组类型
  const allOps = [...new Set([...coreOps, ...prepareOps])];  // 全部操作（用于 operation_variants 表）

  // parameter_signature: resource-type parameters (FreeUnitType/FUCode/ResourceType etc.)
  // CBS 实际变量名：My_FUCode / FUCode / FreeUnitType / My_FreeUnitType 等
  const resTypeKeys = [
    'FreeUnitType', 'ResourceType', 'OfferingType', 'freeUnitType', 'resourceType',
    'FUCode', 'My_FUCode', 'FreeUnitCode', 'My_FreeUnitType', 'My_FreeUnitCode',
  ];
  const paramParts: string[] = [];
  for (const step of steps) {
    const tsv = step.components?.find((c) => c.aw_alias === 'TableSetVar')?.option_parameter;
    const tsvVars = typeof tsv?.vars === 'object' ? tsv!.vars as Record<string, unknown>
      : typeof tsv?.vars === 'string' ? Object.fromEntries(
          (tsv!.vars as string).split(';').filter(Boolean).map((kv: string) => {
            const i = kv.indexOf('=');
            return i > 0 ? [kv.slice(0, i), kv.slice(i + 1)] : null;
          }).filter((x): x is [string, string] => x !== null),
        )
      : null;
    if (tsvVars) {
      for (const key of resTypeKeys) {
        if (tsvVars[key] !== undefined) {
          const displayKey = key.startsWith('My_') ? key.slice(3) : key;  // My_FUCode → FUCode
          paramParts.push(`${displayKey}=${tsvVars[key]}`);
        }
      }
    }
  }
  const paramSig = [...new Set(paramParts)].sort().join(',');

  // operation_variants: what OpType values exist (for the Operation Variants table)
  // 每个操作标注 role: core（核心测试目标）或 prepare（前置准备操作）
  const coreOpSet = new Set(coreOps);
  const operationVariants: OperationVariant[] = allOps.map((op) => ({
    variant_signature: op,
    description: '(AI 填写操作描述)',
    role: coreOpSet.has(op) ? 'core' as const : 'prepare' as const,
  }));

  // parameter_variants: what resource type values exist
  const parameterVariants: ParameterVariant[] = [...new Set(paramParts)].map((pp) => ({
    parameter_signature: pp,
    parameter_name: pp.split('=')[0],
    parameter_value: pp.split('=')[1] || '',
    description: '(AI 填写参数描述)',
    source_cases: [caseId],
  }));

  return {
    pattern_signature: patternSig,
    intent_signature: '(AI 填写业务意图，如 ExpireTimeCorrection)',
    variant_signature: variantSig,
    parameter_signature: paramSig,
    preparation_operations: preparationOps,
    operation_variants: operationVariants,
    parameter_variants: parameterVariants,
  };
}

function findInNested(obj: Record<string, unknown>, key: string): unknown {
  if (obj[key] !== undefined) return obj[key];
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = findInNested(v as Record<string, unknown>, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// ── business entity extraction ──────────────────────────────────────
interface BusinessEntitySkel {
  entity: string;
  relation?: string;
  created_by?: string;
  modified_by?: string;
}

function extractBusinessEntities(
  steps: CaseStepWithMatch[],
  assets: StepAssetFile[],
): BusinessEntitySkel[] {
  const entities: BusinessEntitySkel[] = [];
  const seen = new Set<string>();

  for (const step of steps) {
    const matchedAsset = step.match?.matched_asset_id
      ? assets.find((a) => a.asset_id === step.match!.matched_asset_id)
      : null;
    if (!matchedAsset) continue;

    const assetName = matchedAsset.name || '';
    // Infer entity from asset name (e.g., "创建客户" → Customer, "通用调账" → Adjustment)
    // Script provides skeleton, AI refines
    const entityName = assetName;
    const stepLabel = step.step_name || `step${step.step_index}`;

    // Determine if this step creates or modifies
    const isCreate = /创建|新增|添加|开户|注册|create|add/i.test(stepLabel);
    const isModify = /修改|调账|调整|更新|变更|失效|重置|modify|update|adjust|reset/i.test(stepLabel);

    if (!seen.has(entityName)) {
      seen.add(entityName);
      entities.push({
        entity: entityName,
        created_by: isCreate ? stepLabel : undefined,
        modified_by: isModify ? stepLabel : undefined,
      });
    } else {
      const existing = entities.find((e) => e.entity === entityName);
      if (existing && isCreate && !existing.created_by) existing.created_by = stepLabel;
      if (existing && isModify && !existing.modified_by) existing.modified_by = stepLabel;
    }
  }
  return entities;
}

main();
