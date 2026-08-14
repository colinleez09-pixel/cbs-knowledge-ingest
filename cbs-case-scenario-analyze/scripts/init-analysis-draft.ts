#!/usr/bin/env bun
/**
 * init-analysis-draft.ts  (v2.0)
 * 从 case-data.json 生成 AI 填空骨架三件套：
 *   1. analysis-draft.json  — 结构符合 v2.0 schema，steps 含 construction_mode/patches/inline_recipe
 *   2. analysis-notes.md    — 证据链笔记骨架（每个场景一节，含必答问题清单）
 *   3. page-<slug>.md       — 每个场景一个页面骨架，章节齐全，步骤编排表/补丁表已预填
 *
 * 用法：
 *   bun init-analysis-draft.ts --case-data <case-data.json> [--out-dir <dir>]
 * 输出：JSON（stdout）{ draft_file, notes_file, page_files[] }
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  asString,
  computeSignatures,
  extractBusinessEntities,
  sha256,
  siteKeyFromId,
  type AnalysisDraft,
  type AnalysisDraftScenario,
  type CaseDataFile,
  type ConstructionMode,
  type FieldPatch,
  type InlineRecipe,
  type ScriptPatchItem,
} from './scenario-core.ts';

type CaseStepWithMatch = CaseDataFile['cases'][number]['steps'][number];
type StepAssetFile = CaseDataFile['step_assets'][number];

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith('--')) {
      args[argv[i]!.slice(2)] = argv[++i] ?? '';
    }
  }
  return args;
}

// ─── construction mode determination ──────────────────────

function determineConstructionMode(step: CaseStepWithMatch): ConstructionMode {
  if (step.match.matched_asset_id && step.match.match_status !== 'none') {
    return 'asset-plus-patches';
  }
  if (step.components.length > 0 && step.components.some((c) => !c.is_commented)) {
    return 'inline-recipe';
  }
  return 'manual-required';
}

function buildInlineRecipe(step: CaseStepWithMatch): InlineRecipe | null {
  const activeComps = step.components.filter((c) => !c.is_commented);
  if (activeComps.length === 0) return null;
  const inputs: string[] = [];
  const outputs: string[] = [];
  for (const comp of activeComps) {
    const paramStr = JSON.stringify(comp.option_parameter);
    for (const m of paramStr.matchAll(/\$\{([^}]+)\}/g)) {
      if (!inputs.includes(m[1]!)) inputs.push(m[1]!);
    }
    if (comp.aw_alias === 'TableSetVar') {
      const varsStr = asString(comp.option_parameter.vars);
      if (varsStr) {
        for (const part of varsStr.split(';')) {
          const eq = part.indexOf('=');
          if (eq > 0) {
            const name = part.slice(0, eq).trim();
            if (name && !outputs.includes(name)) outputs.push(name);
          }
        }
      }
    }
    if (comp.aw_alias === 'DataBaseQuery' || comp.aw_alias === 'DataBaseModify') {
      const varsStr = asString(comp.option_parameter.vars);
      if (varsStr) {
        for (const part of varsStr.split(';')) {
          const pipe = part.indexOf('|');
          if (pipe > 0) {
            const alias = part.slice(pipe + 1).trim();
            if (alias && !outputs.includes(alias)) outputs.push(alias);
          }
        }
      }
    }
  }
  return {
    components: activeComps.map((c) => ({ aw_alias: c.aw_alias, option_parameter: c.option_parameter })),
    variable_inputs: inputs,
    variable_outputs: outputs,
    description: '(AI 填写：该步骤的业务目的和组件配置说明)',
  };
}

function toFieldPatch(sp: ScriptPatchItem): FieldPatch {
  return {
    step_index: sp.step_index,
    component: sp.component,
    field_path: sp.field_path,
    field_name: sp.field_name,
    operation: sp.operation,
    asset_value: sp.asset_value,
    case_value: sp.case_value,
    effective_runtime_value: sp.effective_runtime_value,
    field_description: '(AI 填写：字段业务含义)',
    reason: '(AI 必填：为什么设置这个值/做这个修改)',
    evidence_sources: ['observed'],
    confidence: 'confirmed',
    required_for_execution: true,
    unresolved_question: sp.unresolved_question,
  };
}

// ─── page skeleton renderer ───────────────────────────────

function renderPageSkeleton(
  sc: AnalysisDraftScenario,
  caseData: CaseDataFile,
  slug: string,
  title: string,
): string {
  const L: string[] = [];
  L.push('---');
  L.push('type: cbs-scenario-pattern');
  L.push(`title: ${title}`);
  L.push(`slug: ${slug}`);
  L.push('name_cn: "(AI 填写中文场景名)"');
  L.push('description: "(AI 填写中文场景描述)"');
  L.push('tags:');
  L.push('  - cbs');
  L.push('  - scenario-pattern');
  L.push(`created_at: ${new Date().toISOString()}`);
  L.push(`updated_at: ${new Date().toISOString()}`);
  L.push(`maturity: ${sc.maturity}`);
  L.push('source_cases:');
  for (const cid of sc.source_cases) L.push(`  - ${cid}`);
  L.push(`pattern_signature: "${sc.pattern_signature || ''}"`);
  L.push(`intent_signature: "${sc.intent_signature || ''}"`);
  L.push(`variant_signature: "${sc.variant_signature || ''}"`);
  L.push(`parameter_signature: "${sc.parameter_signature || ''}"`);
  L.push(`preparation_operations: [${sc.preparation_operations.map((p) => `"${p}"`).join(', ')}]`);
  if (sc.capability) L.push(`capability: "${sc.capability}"`);
  L.push('---');
  L.push('');
  L.push(`# ${title}`);
  L.push('');
  L.push('> **中文场景名**：(AI 填写)  |  **场景描述**：(AI 填写)');
  L.push('');

  // 1. 场景定义
  L.push('## 1. 场景定义');
  L.push('');
  L.push('<!-- AI 填写：场景描述、业务目的、测试点、前置条件、预期结果 -->');
  L.push('');
  L.push('**测试点**：');
  L.push('');
  L.push('| 测试点 | 验证方式 | 预期结果 |');
  L.push('|--------|----------|----------|');
  for (const tp of sc.test_points) {
    L.push(`| ${tp.description} | ${tp.verification_method} | ${tp.expected_result} |`);
  }
  if (sc.test_points.length === 0) L.push('| (AI 填写) | | |');
  L.push('');

  // 2. 步骤编排
  L.push('## 2. 步骤编排');
  L.push('');
  L.push('| 顺序 | 步骤行为 | 构建方式 | 资产名称 | asset_id | 匹配类型 | 匹配置由 |');
  L.push('|------|----------|----------|----------|----------|----------|----------|');
  for (const st of sc.steps) {
    const asset = caseData.step_assets.find((a) => a.asset_id === st.matched_asset_id);
    L.push(`| ${st.step_index + 1} | ${st.step_name} | ${st.construction_mode} | ${asset?.name ?? '(无资产)'} | ${st.matched_asset_id ?? '-'} | ${st.match_kind} | ${st.match_reason} |`);
  }
  L.push('');

  // 3. 字段补丁（每步一节）
  L.push('## 3. 字段补丁 (Field Patches)');
  L.push('');
  for (const st of sc.steps) {
    if (st.patches.length === 0 && !st.inline_recipe) continue;
    const asset = caseData.step_assets.find((a) => a.asset_id === st.matched_asset_id);
    L.push(`### Step[${st.step_index}]：${st.step_name}（资产：${asset?.name ?? '无'}，构建：${st.construction_mode}）`);
    L.push('');
    if (st.patches.length > 0) {
      L.push('| 组件 | 字段路径 | 操作 | 资产值 | 用例值 | 运行时值 | 业务理由 | 证据 | 置信度 |');
      L.push('|------|----------|------|--------|--------|----------|----------|------|--------|');
      for (const p of st.patches) {
        const av = p.asset_value === null ? '-' : `\`${p.asset_value}\``;
        const cv = p.case_value === null ? '-' : `\`${p.case_value}\``;
        const rv = p.effective_runtime_value === null ? '-' : `\`${p.effective_runtime_value}\``;
        L.push(`| ${p.component} | ${p.field_path} | ${p.operation} | ${av} | ${cv} | ${rv} | ${p.reason} | ${p.evidence_sources.join(',')} | ${p.confidence} |`);
      }
      L.push('');
    }
    if (st.inline_recipe) {
      L.push('**内联配方 (Inline Recipe)**：');
      L.push(`- 组件：${st.inline_recipe.components.map((c) => c.aw_alias).join(', ')}`);
      L.push(`- 变量输入：${st.inline_recipe.variable_inputs.join(', ') || '无'}`);
      L.push(`- 变量输出：${st.inline_recipe.variable_outputs.join(', ') || '无'}`);
      L.push(`- 说明：${st.inline_recipe.description}`);
      L.push('');
    }
    if (st.reconstruction) {
      L.push(`**重建验证**：${st.reconstruction.status}（覆盖率：${(st.reconstruction.total_field_coverage * 100).toFixed(0)}%）`);
      if (st.reconstruction.unexplained_differences.length > 0) {
        L.push('');
        L.push('| 字段路径 | 重建值 | 原始值 | 可能原因 |');
        L.push('|----------|--------|--------|----------|');
        for (const diff of st.reconstruction.unexplained_differences) {
          L.push(`| ${diff.field_path} | ${diff.reconstructed_value ?? '-'} | ${diff.original_value ?? '-'} | ${diff.possible_reason} |`);
        }
      }
      L.push('');
    }
  }

  // 4. 步骤间数据流
  L.push('## 4. 步骤间数据流');
  L.push('');
  if (sc.variable_dependencies.length > 0) {
    L.push('| 来源步骤 | 目标步骤 | 变量 | 生产类型 | 消费位置 | 证据 | 置信度 |');
    L.push('|----------|----------|------|----------|----------|------|--------|');
    for (const dep of sc.variable_dependencies) {
      L.push(`| Step[${dep.from_step}] | Step[${dep.to_step}] | ${dep.variable} | ${dep.producer_type} | ${dep.consumer_location} | ${dep.evidence} | ${dep.confidence} |`);
    }
  } else {
    L.push('<!-- AI 填写：步骤间变量传递关系 -->');
  }
  L.push('');

  // 5. 业务实体关系
  L.push('## 5. 业务实体关系');
  L.push('');
  if (sc.business_entities.length > 0) {
    L.push('| Entity | Relation | Created By | Modified By | Evidence |');
    L.push('|--------|----------|------------|-------------|----------|');
    for (const be of sc.business_entities) {
      L.push(`| ${be.entity} | ${be.relation || '-'} | ${be.created_by || '-'} | ${be.modified_by || '-'} | ${be.evidence_type} |`);
    }
  } else {
    L.push('<!-- AI 填写：核心业务实体 -->');
  }
  L.push('');

  // 6. 操作变体
  L.push('## 6. 操作变体 (Operation Variants)');
  L.push('');
  if (sc.operation_variants.length > 0) {
    L.push('| Step | Interface | OpType | Role | 构建方式 | 资产 | 匹配类型 | 匹配置由 |');
    L.push('|------|-----------|--------|------|----------|------|----------|----------|');
    for (const ov of sc.operation_variants) {
      L.push(`| ${ov.step_index} | ${ov.interface_template} | ${ov.op_type} | ${ov.role} | ${ov.construction_mode} | ${ov.matched_asset_id ?? '-'} | ${ov.match_kind} | ${ov.match_reason} |`);
    }
  } else {
    L.push('<!-- AI 填写 -->');
  }
  L.push('');

  // 7. 参数变体
  L.push('## 7. 参数变体 (Parameter Variants)');
  L.push('');
  if (sc.parameter_variants.length > 0) {
    L.push('| 组件 | 字段路径 | 操作 | 资产值 | 用例值 | 来源用例 | 置信度 |');
    L.push('|------|----------|------|--------|--------|----------|--------|');
    for (const pv of sc.parameter_variants) {
      L.push(`| ${pv.component} | ${pv.field_path} | ${pv.operation} | ${pv.asset_value ?? '-'} | ${pv.case_value ?? '-'} | ${pv.source_case} | ${pv.confidence} |`);
    }
  } else {
    L.push('<!-- AI 填写 -->');
  }
  L.push('');

  // 8. 用例生成指引
  L.push('## 8. 用例生成指引');
  L.push('');
  L.push('1. asset-plus-patches 步骤：凭 asset_id 经 API 获取资产 JSON -> 按补丁表逐条应用');
  L.push('2. inline-recipe 步骤：直接使用内联配方中的组件配置');
  L.push('3. 按步骤间数据流串联变量引用');
  L.push('4. 组装完整用例 JSON 后转 XML');
  L.push('');

  // 9. 待解决问题
  if (sc.unresolved_questions.length > 0) {
    L.push('## 9. 待解决问题');
    L.push('');
    for (const q of sc.unresolved_questions) L.push(`- ${q}`);
    L.push('');
  }

  return L.join('\n');
}

// ─── notes skeleton renderer ──────────────────────────────

function renderNotesSkeleton(draft: AnalysisDraft, caseData: CaseDataFile): string {
  const L: string[] = [];
  L.push('# Analysis Notes');
  L.push('');
  L.push(`Generated: ${draft.generated_at}`);
  L.push(`Source: ${draft.source_case_data}`);
  L.push('');
  L.push('<!--');
  L.push('  AI 必须为每个场景回答以下问题，答案将作为场景知识页的语义内容来源。');
  L.push('  每个问题都不能跳过——validate-analysis.ts 会检查是否填写。');
  L.push('  ★ 步骤引用必须使用 Step[N] 格式（N 为 step_index）。');
  L.push('  ★ 匹配确认：对 reusable-base/partial/ambiguous 匹配的步骤，必须说明裁决依据。');
  L.push('  ★ 补丁理由：每个非 remove 补丁必须说明为什么设置这个值。');
  L.push('-->');
  L.push('');

  for (const sc of draft.scenarios) {
    L.push(`## 场景：${sc.scenario_name}（${sc.scenario_id}）`);
    L.push('');
    L.push(`**来源用例**：${sc.source_cases.join(', ')}`);
    L.push('');
    L.push('1. **这个场景测什么业务点？**');
    L.push('   (AI 填写)');
    L.push('');
    L.push('2. **步骤串联逻辑**：为什么按这个顺序执行？步骤间数据如何传递？');
    L.push('   (AI 填写)');
    L.push('');
    L.push('3. **关键参数为什么这样设置**：');
    for (const st of sc.steps) {
      const interesting = st.patches.filter((p) => p.operation !== 'remove-field' && p.operation !== 'remove-variable').slice(0, 5);
      for (const p of interesting) {
        L.push(`   - Step[${st.step_index}] \`${p.field_path}\` = \`${p.case_value}\`：(AI 填写原因)`);
      }
    }
    L.push('');
    L.push('4. **匹配确认**：对非 exact 匹配的步骤，确认或推翻脚本结论的依据是什么？');
    for (const st of sc.steps) {
      if (st.match_kind !== 'exact' && st.match_kind !== 'none') {
        L.push(`   - Step[${st.step_index}]「${st.step_name}」（匹配类型 ${st.match_kind}）：(AI 填写)`);
      }
    }
    L.push('');
    L.push('5. **变量依赖确认**：以下变量依赖是否准确？有无遗漏？');
    for (const dep of sc.variable_dependencies) {
      L.push(`   - Step[${dep.from_step}] -> Step[${dep.to_step}] 变量 \`${dep.variable}\`（${dep.producer_type}）：(AI 确认/修正)`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ─── main ─────────────────────────────────────────────────

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
  const outDirArg = asString(args['out-dir']).trim();
  const outDir = outDirArg || dirname(caseDataPath.replace(/\\/g, '/')) || '.';
  console.error(`[init-draft] out-dir: ${resolve(outDir)}`);
  const caseData = JSON.parse(readFileSync(caseDataPath, 'utf8')) as CaseDataFile;

  const scenarios: AnalysisDraftScenario[] = [];
  const pageFiles: string[] = [];

  for (const c of caseData.cases) {
    const siteKey = siteKeyFromId(c.basic_info.site_id, c.basic_info.site_name);
    const scenarioId = `SCN-${sha256(c.case_id).slice(0, 6).toUpperCase()}`;
    const skeletonName = `scenario-draft-${sha256(c.case_id).slice(0, 8)}`;
    const slugEnPlaceholder = 'todo-scenario-english-slug';
    const slug = `cbs/scenarios/${siteKey}/${slugEnPlaceholder}`;
    const pageFileName = `page-scenario-draft-${sha256(c.case_id).slice(0, 8)}.md`;

    // 四签名
    const sigs = computeSignatures(c.steps);

    // 步骤映射
    const steps = c.steps.map((s) => {
      const cm = determineConstructionMode(s);
      const matchKind = s.match.match_status;
      return {
        step_index: s.step_index,
        step_name: s.step_name,
        construction_mode: cm,
        matched_asset_id: s.match.matched_asset_id,
        matched_asset_slug: null,
        match_kind: matchKind,
        match_reason: s.match.match_reason,
        patches: s.script_patches.map((sp) => toFieldPatch(sp)),
        inline_recipe: cm === 'inline-recipe' ? buildInlineRecipe(s) : null,
        reconstruction: null,
        variable_inputs: s.variable_inputs,
        variable_outputs: s.variable_outputs,
      };
    });

    // 操作变体
    const operation_variants = steps
      .filter((st) => {
        const fp = c.steps.find((s) => s.step_index === st.step_index)?.fingerprint;
        return fp?.interface_template;
      })
      .map((st) => {
        const fp = c.steps.find((s) => s.step_index === st.step_index)!.fingerprint;
        const opType = st.patches.find((p) => p.field_name === 'OpType' || p.field_name === 'ActionType' || p.field_name === 'OperType');
        return {
          step_index: st.step_index,
          interface_template: fp.interface_template || '',
          op_type: opType?.case_value ?? '(default)',
          role: 'core' as const,
          construction_mode: st.construction_mode,
          matched_asset_id: st.matched_asset_id,
          matched_asset_slug: st.matched_asset_slug,
          match_kind: st.match_kind,
          match_reason: st.match_reason,
          inline_recipe: st.inline_recipe,
        };
      });

    // 参数变体
    const parameter_variants = steps.flatMap((st) =>
      st.patches
        .filter((p) => p.operation === 'set-variable' || p.operation === 'runtime-bind' || p.operation === 'replace-field')
        .map((p) => ({
          component: p.component,
          field_path: p.field_path,
          operation: p.operation,
          asset_value: p.asset_value,
          case_value: p.case_value,
          source_case: c.case_id,
          confidence: p.confidence,
        })),
    );

    // 变量依赖
    const variable_dependencies = caseData.variable_graph.dependencies;

    // 业务实体
    const business_entities = extractBusinessEntities(c.steps, caseData.step_assets);

    // 待解决问题
    const unresolved_questions: string[] = [];
    for (const s of c.steps) {
      if (s.script_patches.some((sp) => sp.unresolved_question)) {
        for (const sp of s.script_patches) {
          if (sp.unresolved_question) unresolved_questions.push(`Step[${s.step_index}] ${sp.field_path}: ${sp.unresolved_question}`);
        }
      }
    }

    const sc: AnalysisDraftScenario = {
      scenario_id: scenarioId,
      scenario_name: skeletonName,
      capability: '',
      pattern_signature: sigs.pattern_signature,
      intent_signature: '(AI 填写业务意图)',
      variant_signature: sigs.variant_signature,
      parameter_signature: sigs.parameter_signature,
      maturity: 'provisional',
      source_cases: [c.case_id],
      preparation_operations: sigs.preparation_operations,
      operation_variants,
      parameter_variants,
      test_points: [{ description: '(AI 填写)', verification_method: '(AI 填写)', expected_result: '(AI 填写)' }],
      business_entities,
      variable_dependencies,
      steps,
      unresolved_questions,
    };
    scenarios.push(sc);

    const pageContent = renderPageSkeleton(sc, caseData, slug, '(AI 填写场景名称)');
    writeFileSync(join(outDir, pageFileName), pageContent, 'utf8');
    pageFiles.push(join(outDir, pageFileName));
  }

  const draft: AnalysisDraft = {
    version: 'cbs-scenario-analysis-v2',
    generated_at: new Date().toISOString(),
    source_case_data: caseDataPath,
    scenarios,
  };
  const draftPath = join(outDir, 'analysis-draft.json');
  writeFileSync(draftPath, JSON.stringify(draft, null, 2), 'utf8');

  const notesPath = join(outDir, 'analysis-notes.md');
  writeFileSync(notesPath, renderNotesSkeleton(draft, caseData), 'utf8');

  for (const f of [draftPath, notesPath, ...pageFiles]) {
    if (!existsSync(f)) {
      console.error(`[init-draft] FATAL: file not found after write: ${f}`);
      process.exit(1);
    }
  }
  console.error(`[init-draft] scenarios: ${scenarios.length}`);
  console.error(`[init-draft] outDir: ${outDir}`);
  console.error('[init-draft] NEXT: AI fills semantic fields (reason/evidence/confidence/intent/page content)');
  console.log(JSON.stringify({
    out_dir: resolve(outDir),
    draft_file: draftPath,
    notes_file: notesPath,
    page_files: pageFiles,
    scenario_count: scenarios.length,
  }));
}

main();
