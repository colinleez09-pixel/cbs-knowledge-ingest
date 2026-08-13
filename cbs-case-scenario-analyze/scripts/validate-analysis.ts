#!/usr/bin/env bun
/**
 * validate-analysis.ts
 * Phase 1 Step 3: 验证 AI 分析草稿（analysis-draft.json）与脚本提取数据（case-data.json）的一致性
 *
 * 校验职责（分析真实性门禁）：
 * - 证据链：--analysis-notes 文件必须存在，且每个场景在其中有分析记录
 * - 一致性：AI 的匹配结论不得推翻脚本高置信匹配（matched 被置空 → error）
 * - 覆盖性：脚本计算的每条 script_delta 必须在 AI param_deltas 中出现且带业务理由
 * - 完整性：scenario_knowledge / test_points / page_draft_file 等必填项检查
 * - merge_mode：extend 模式必须有 target_scenario_slug 且目标页存在于 GBrain 已有场景列表
 *
 * 校验通过 → 生成 scenario-plan.json（含 SHA-256 完整性哈希）
 * 校验失败 → 只生成校验报告，退出码 1
 *
 * 用法：
 *   bun validate-analysis.ts --draft <analysis-draft.json> --case-data <case-data.json>
 *     --analysis-notes <analysis-notes.md> --out-plan <scenario-plan.json> --out-report <report.md>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import {
  generateScenarioSlug,
  isPlaceholderSlugEn,
  isValidSlugEn,
  planPayloadSha256,
  sha256,
  parseArgs,
  type AnalysisDraft,
  type AnalysisDraftScenario,
  type CaseDataFile,
  type ScenarioPattern,
  type ScenarioPlan,
  type ScenarioPlanLink,
  type ScenarioPlanPage,
  type ScenarioPlanTimeline,
} from './scenario-core.ts';

// ─── Types ───────────────────────────────────────────────

interface ValidationIssue {
  scenario_id: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

// ─── 工具 ────────────────────────────────────────────────

function pushIssue(
  list: ValidationIssue[],
  scenarioId: string,
  field: string,
  message: string,
  severity: 'error' | 'warning',
): void {
  list.push({ scenario_id: scenarioId, field, message, severity });
}

// ─── Layer 1: 证据链门禁（analysis-notes.md） ────────────

function validateAnalysisNotes(
  draft: AnalysisDraft,
  notesPath: string,
  errors: ValidationIssue[],
): void {
  if (!notesPath || !existsSync(notesPath)) {
    pushIssue(errors, '(global)', 'analysis-notes', `analysis-notes 文件不存在: ${notesPath || '(未提供 --analysis-notes)'}`, 'error');
    return;
  }
  const content = readFileSync(notesPath, 'utf8');
  if (content.trim().length < 200) {
    pushIssue(errors, '(global)', 'analysis-notes', 'analysis-notes.md 内容过短（<200字符），无法证明执行了真实分析', 'error');
    return;
  }
  const notesPlaceholders = (content.match(/\(AI 填写/g) ?? []).length;
  if (notesPlaceholders > 0) {
    pushIssue(errors, '(global)', 'analysis-notes', `analysis-notes.md 仍有 ${notesPlaceholders} 处「(AI 填写)」占位符未填写——证据链必须完整回答每个问题`, 'error');
  }
  for (const scenario of draft.scenarios) {
    const hasId = scenario.scenario_id && content.includes(scenario.scenario_id);
    const hasName = scenario.name && content.includes(scenario.name);
    const hasCaseRef = scenario.source_cases.some((c) => content.includes(c));
    if (!hasId && !hasName && !hasCaseRef) {
      pushIssue(
        errors,
        scenario.scenario_id || '(unknown)',
        'analysis-notes',
        `analysis-notes.md 中未找到场景「${scenario.name || scenario.scenario_id}」的任何分析记录（scenario_id/name/source_cases 均未出现）`,
        'error',
      );
    }
  }
}

// ─── Layer 2: 结构一致性校验 ─────────────────────────────

function validateScenarioStructure(
  scenario: AnalysisDraftScenario,
  caseData: CaseDataFile,
  draftDir: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): { pageContent: string | null } {
  const sid = scenario.scenario_id || '(empty)';
  const existingSlugs = new Set(caseData.existing_scenarios.map((s) => s.slug));

  // V1: scenario_id
  if (!scenario.scenario_id || scenario.scenario_id.trim().length === 0) {
    pushIssue(errors, '(empty)', 'scenario_id', 'scenario_id is required and must not be empty', 'error');
  }

  // V2: name
  if (!scenario.name || scenario.name.trim().length < 4) {
    pushIssue(errors, sid, 'name', 'name is required (>= 4 chars)', 'error');
  }

  // V3: description
  if (!scenario.description || scenario.description.trim().length < 10) {
    pushIssue(errors, sid, 'description', 'description must be at least 10 characters', 'error');
  }

  // V4: source_cases exist
  const caseIds = new Set(caseData.cases.map((c) => c.case_id));
  for (const caseId of scenario.source_cases ?? []) {
    if (!caseIds.has(caseId)) {
      pushIssue(errors, sid, 'source_cases', `case_id '${caseId}' not found in case-data.json`, 'error');
    }
  }
  if (!scenario.source_cases || scenario.source_cases.length === 0) {
    pushIssue(errors, sid, 'source_cases', 'source_cases must not be empty', 'error');
  }

  // V1b: 骨架占位符未替换检测（init-analysis-draft 生成的占位内容 AI 必须改写）
  if (/^scenario-draft-[0-9a-f]{8}$/i.test(scenario.name ?? '')) {
    pushIssue(errors, sid, 'name', `name 仍是 init 骨架占位名 '${scenario.name}'：必须改写为简洁场景名（如 "免费资源调账失效场景"）`, 'error');
  }

  // V1c: slug_en 语义化英文 slug 强制校验（GBrain 设计理念：slug 即身份/搜索锚点/图谱节点，禁止无语义哈希）
  const slugEn = (scenario.slug_en ?? '').trim();
  if (!slugEn || isPlaceholderSlugEn(slugEn)) {
    pushIssue(
      errors,
      sid,
      'slug_en',
      `slug_en 缺失或仍是占位值 '${slugEn || '(空)'}'：AI 必须提供语义化英文 slug（如 freeunit-expire-reset），命名规范 <对象>-<操作>[-<限定>]，见 references/scenario-schema.md`,
      'error',
    );
  } else if (!isValidSlugEn(slugEn)) {
    pushIssue(
      errors,
      sid,
      'slug_en',
      `slug_en '${slugEn}' 格式非法：必须是小写 kebab-case（^[a-z][a-z0-9]*(-[a-z0-9]+)*$），长度 4-48，如 freeunit-expire-reset`,
      'error',
    );
  }

  // V5: merge_mode
  if (scenario.merge_mode !== 'create' && scenario.merge_mode !== 'extend') {
    pushIssue(errors, sid, 'merge_mode', `merge_mode must be 'create' or 'extend', got '${scenario.merge_mode}'`, 'error');
  } else if (scenario.merge_mode === 'extend') {
    if (!scenario.target_scenario_slug) {
      pushIssue(errors, sid, 'target_scenario_slug', "merge_mode='extend' requires target_scenario_slug", 'error');
    } else if (!existingSlugs.has(scenario.target_scenario_slug)) {
      pushIssue(
        errors,
        sid,
        'target_scenario_slug',
        `target scenario '${scenario.target_scenario_slug}' not found in existing GBrain scenarios (${existingSlugs.size} known)`,
        'error',
      );
    }
  } else if (scenario.merge_mode === 'create') {
    // create 模式兜底：若已有场景页与 pattern_signature 相同的线索存在，AI 应说明
    if (!scenario.similar_existing_scenarios || scenario.similar_existing_scenarios.length === 0) {
      if (caseData.existing_scenarios.length > 0) {
        pushIssue(
          warnings,
          sid,
          'similar_existing_scenarios',
          `GBrain 已有 ${caseData.existing_scenarios.length} 个场景页，但 AI 未给出 similar_existing_scenarios 判重说明`,
          'warning',
        );
      }
    }
  }

  // V6: pattern_signature 必须非空（核心签名，由脚本自动计算排除 setup 步骤后的接口调用链）
  if (!scenario.pattern_signature) {
    pushIssue(errors, sid, 'pattern_signature', 'pattern_signature 必须提供（脚本自动计算，排除 CreateCustomer 等 setup 步骤）', 'error');
  }

  // V34: pattern_signature 不应包含 setup 接口（防退化碎片化）
  const SETUP_INTERFACE_TEMPLATES = ['CreateCustomer', 'CreateAccount', 'Login', 'SystemParameter', 'InitBalance', 'PrepareData', 'Setup', 'Initialize'];
  for (const setup of SETUP_INTERFACE_TEMPLATES) {
    if (scenario.pattern_signature.includes(setup)) {
      pushIssue(warnings, sid, 'pattern_signature', `pattern_signature 包含 setup 接口「${setup}」，应仅包含核心业务接口（如 Adjustment），前置准备步骤由 precondition_flow 承载`, 'warning');
      break;  // 一次 warning 足够
    }
  }

  // V7: 步骤匹配引用存在性（asset_id 校验）
  const assetIds = new Set(caseData.step_assets.map((a) => a.asset_id));
  for (const step of scenario.steps ?? []) {
    if (step.matched_asset_id && !assetIds.has(step.matched_asset_id)) {
      pushIssue(errors, sid, 'steps', `step ${step.step_index}: matched_asset_id '${step.matched_asset_id}' not found in case-data step_assets`, 'error');
    }
  }

  // V8: AI 匹配结论与脚本匹配的一致性
  for (const step of scenario.steps ?? []) {
    const caseStep = caseData.cases
      .flatMap((c) => c.steps)
      .find((cs) => scenario.source_cases.includes(caseData.cases.find((cc) => cc.steps.includes(cs))?.case_id ?? '') && cs.step_index === step.step_index);
    if (!caseStep) continue;
    const scriptMatch = caseStep.match;
    if (scriptMatch.match_status === 'matched' && scriptMatch.confidence >= 0.75) {
      // 脚本高置信匹配，AI 不得置空或改判
      if (!step.matched_asset_id) {
        pushIssue(
          errors,
          sid,
          'steps',
          `step ${step.step_index}「${step.behavior}」: 脚本已高置信匹配资产 ${scriptMatch.matched_asset_name}（${scriptMatch.confidence.toFixed(2)}），但 AI 未采纳`,
          'error',
        );
      } else if (step.matched_asset_id !== scriptMatch.matched_asset_id) {
        pushIssue(
          errors,
          sid,
          'steps',
          `step ${step.step_index}: 脚本匹配 ${scriptMatch.matched_asset_name} 但 AI 改判为其他资产（match_reason 必须充分说明，当前: ${step.match_reason || '(空)'}）`,
          scriptMatch.confidence >= 0.9 ? 'error' : 'warning',
        );
      }
    }
    if (scriptMatch.match_status === 'unmatched' && step.matched_asset_id && (!step.match_reason || step.match_reason.length < 10)) {
      pushIssue(
        warnings,
        sid,
        'steps',
        `step ${step.step_index}: 脚本未匹配但 AI 匹配了资产，match_reason 不充分（<10字符）`,
        'warning',
      );
    }
  }

  // V9: 脚本 delta 覆盖校验 — 每条 script_delta 必须在 AI param_deltas 中出现且带理由
  for (const step of scenario.steps ?? []) {
    const caseStep = caseData.cases
      .flatMap((c) => c.steps)
      .find((cs) => scenario.source_cases.includes(caseData.cases.find((cc) => cc.steps.includes(cs))?.case_id ?? '') && cs.step_index === step.step_index);
    if (!caseStep || caseStep.script_deltas.length === 0) continue;

    const aiDeltaKeys = new Set(
      step.param_deltas.map((pd) => `${pd.component_alias}::${pd.variable_name}`),
    );
    for (const sd of caseStep.script_deltas) {
      const key = `${sd.component_alias}::${sd.variable_name}`;
      if (!aiDeltaKeys.has(key)) {
        const fmtVal = (v: unknown): string => {
          if (v === null || v === undefined || v === '') return '∅';
          if (typeof v === 'string') return v.length > 40 ? v.slice(0, 40) + '…' : v;
          const j = JSON.stringify(v);
          return j.length > 40 ? j.slice(0, 40) + '…' : j;
        };
        pushIssue(
          errors,
          sid,
          'param_deltas',
          `step ${step.step_index}: 脚本计算的 delta「${key}」（${sd.delta_type}: ${fmtVal(sd.asset_value)} → ${fmtVal(sd.case_value)}）在 AI param_deltas 中缺失`,
          'error',
        );
      } else {
        const aiDelta = step.param_deltas.find((pd) => `${pd.component_alias}::${pd.variable_name}` === key);
        if (aiDelta && (!aiDelta.reason || aiDelta.reason.trim().length < 5)) {
          pushIssue(
            warnings,
            sid,
            'param_deltas',
            `step ${step.step_index}: delta「${key}」的 reason 过短，缺少业务理由`,
            'warning',
          );
        }
      }
    }
  }

  // V10: dependencies 引用存在
  const stepIndexes = new Set((scenario.steps ?? []).map((s) => s.step_index));
  for (const dep of scenario.dependencies ?? []) {
    if (!stepIndexes.has(dep.from_step)) {
      pushIssue(errors, sid, 'dependencies', `dependency from_step ${dep.from_step} not found in scenario steps`, 'error');
    }
    if (!stepIndexes.has(dep.to_step)) {
      pushIssue(errors, sid, 'dependencies', `dependency to_step ${dep.to_step} not found in scenario steps`, 'error');
    }
  }

  // V24: tentative 匹配必须由 AI 裁决（match_status 仍为 tentative → AI 未完成分析步骤）
  for (const step of scenario.steps ?? []) {
    if (step.match_status === 'tentative') {
      pushIssue(
        errors,
        sid,
        'steps',
        `step ${step.step_index}「${step.behavior}」: match_status 仍为 tentative，AI 必须确认（改为 matched）或推翻（清空 matched_asset_id/matched_step_asset_slug）`,
        'error',
      );
    }
  }

  // V25: dependencies 为空时提醒（多步骤场景应该有数据流）
  if ((scenario.dependencies ?? []).length === 0 && (scenario.steps ?? []).length > 1) {
    const hasMatched = (scenario.steps ?? []).some((s) => s.matched_asset_id);
    if (hasMatched) {
      pushIssue(
        warnings,
        sid,
        'dependencies',
        `场景有 ${(scenario.steps ?? []).length} 个步骤但 dependencies 为空，请填写步骤间数据流（与页面 Section 4 保持一致）`,
        'warning',
      );
    }
  }

  // V26: tentative 匹配确认后 confidence 上限 0.95（通用规则：脚本计算的 <0.75 匹配，AI 确认后最高 0.95，禁止设为 1.0）
  for (const step of scenario.steps ?? []) {
    if (step.match_status === 'matched' && step.match_confidence !== null && step.match_confidence !== undefined) {
      // 查找脚本原始 confidence
      const sourceCase = caseData.cases.find((c) => scenario.source_cases.includes(c.case_id));
      const scriptStep = sourceCase?.steps.find((s) => s.step_name === step.behavior);
      const scriptConf = scriptStep?.match?.confidence ?? 1.0;
      if (scriptConf < 0.75 && step.match_confidence > 0.95) {
        pushIssue(
          errors,
          sid,
          'steps',
          `step ${step.step_index}「${step.behavior}」: 脚本原始 confidence=${scriptConf.toFixed(2)}（tentative），AI 确认后 confidence=${step.match_confidence} 超过上限 0.95。AI 确认=业务可用≠完美匹配，建议设 0.85-0.95`,
          'error',
        );
      }
    }
  }

  // V27: 同名变量跨步骤 field_description 一致性（通用规则：同一变量在不同步骤的描述应相同，否则可能是复制粘贴错误）
  {
    const descByVar = new Map<string, { step: number; desc: string }[]>();
    for (const step of scenario.steps ?? []) {
      for (const pd of step.param_deltas ?? []) {
        const key = pd.variable_name;
        if (!key || !pd.field_description) continue;
        const arr = descByVar.get(key) ?? [];
        arr.push({ step: step.step_index, desc: pd.field_description });
        descByVar.set(key, arr);
      }
    }
    for (const [varName, entries] of descByVar) {
      if (entries.length < 2) continue;
      const descs = new Set(entries.map((e) => e.desc));
      if (descs.size > 1) {
        pushIssue(
          warnings,
          sid,
          'param_deltas',
          `变量 ${varName} 在不同步骤的 field_description 不一致: ${entries.map((e) => `step${e.step}="${e.desc.substring(0, 30)}"`).join(', ')}`,
          'warning',
        );
      }
    }
  }

  // V28: reason/field_description 不得包含其他步骤的变量名（通用规则：防止跨步骤复制粘贴错误）
  {
    // 收集每步骤的变量名集合
    const stepVarNames = new Map<number, Set<string>>();
    for (const step of scenario.steps ?? []) {
      const vars = new Set<string>();
      for (const pd of step.param_deltas ?? []) {
        if (pd.variable_name) vars.add(pd.variable_name);
      }
      stepVarNames.set(step.step_index, vars);
    }
    // 检查每个 delta 的 reason/field_description 是否包含其他步骤的变量名
    const allVarNames = new Set<string>();
    for (const vs of stepVarNames.values()) for (const v of vs) allVarNames.add(v);
    for (const step of scenario.steps ?? []) {
      const ownVars = stepVarNames.get(step.step_index) ?? new Set<string>();
      for (const pd of step.param_deltas ?? []) {
        const combined = `${pd.reason ?? ''} ${pd.field_description ?? ''}`;
        if (!combined) continue;
        for (const otherVar of allVarNames) {
          if (ownVars.has(otherVar)) continue; // 属于本步骤的变量，合法
          if (combined.includes(otherVar)) {
            pushIssue(
              errors,
              sid,
              'param_deltas',
              `step ${step.step_index}「${step.behavior}」${pd.variable_name}: reason/field_description 包含其他步骤的变量 ${otherVar}，疑似跨步骤复制粘贴错误`,
              'error',
            );
            break; // 每个delta只报一次
          }
        }
      }
    }
  }

  // V28b: 跨步骤 rRsp/rVars delta 值完全相同检测（通用规则：不同步骤的响应模板应有差异，完全相同可能是复制粘贴）
  {
    const respDeltas = new Map<string, { step: number; behavior: string; value: string }[]>();
    for (const step of scenario.steps ?? []) {
      for (const pd of step.param_deltas ?? []) {
        const alias = pd.component_alias ?? '';
        if (alias !== 'rRsp' && alias !== 'rVars') continue;
        const val = pd.case_value ?? '';
        if (!val || val.length < 20) continue; // 忽略空值和极短值
        const key = `${alias}::${pd.variable_name}`;
        const arr = respDeltas.get(key) ?? [];
        arr.push({ step: step.step_index, behavior: step.behavior ?? '', value: val });
        respDeltas.set(key, arr);
      }
    }
    for (const [key, entries] of respDeltas) {
      if (entries.length < 2) continue;
      // 检查是否有两个不同步骤的值完全相同
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          if (entries[i].value === entries[j].value && entries[i].step !== entries[j].step) {
            pushIssue(
              warnings,
              sid,
              'param_deltas',
              `${key}: Step[${entries[i].step}]与Step[${entries[j].step}]的响应值完全相同，可能为复制粘贴——不同步骤的响应模板通常应存在差异`,
              'warning',
            );
            break;
          }
        }
      }
    }
  }

  // V29: reason 非空且 >= 6字符（通用规则：所有 delta 必须有业务理由）
  for (const step of scenario.steps ?? []) {
    for (const pd of step.param_deltas ?? []) {
      const r = pd.reason ?? '';
      if (r.length === 0 || r === '(AI 填写)') {
        pushIssue(
          errors,
          sid,
          'param_deltas',
          `step ${step.step_index}「${step.behavior}」${pd.component_alias}::${pd.variable_name}: reason 未填写（每个参数变更必须有业务理由）`,
          'error',
        );
      } else if (r.length < 6) {
        pushIssue(
          warnings,
          sid,
          'param_deltas',
          `step ${step.step_index}「${step.behavior}」${pd.component_alias}::${pd.variable_name}: reason 过短（"${r}"），建议补充完整业务理由`,
          'warning',
        );
      }
    }
  }

  // V22: dependencies 变量真实性（防 AI 臆造变量名）——from_param/to_param 中的变量必须在源用例变量集合中
  const scenarioVarSet = new Set<string>();
  {
    const varSet = scenarioVarSet;
    const sourceCases = caseData.cases.filter((c) => scenario.source_cases.includes(c.case_id));
    for (const c of sourceCases) {
      for (const s of c.steps) {
        // fingerprint.variable_names 是数组（extract 生成的真实结构）；历史版本曾有 vars 字典，兼容两者
        const fp = s.fingerprint as unknown as { variable_names?: unknown; vars?: unknown } | undefined;
        if (Array.isArray(fp?.variable_names)) for (const v of fp.variable_names) varSet.add(String(v));
        else if (fp?.vars && typeof fp.vars === 'object') for (const k of Object.keys(fp.vars)) varSet.add(k);
        for (const sd of s.script_deltas ?? []) varSet.add(sd.variable_name);
      }
    }
    const rootOf = (p: string) => p.trim().split('.')[0].trim();
    const isVarRef = (p: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(rootOf(p));
    for (const dep of scenario.dependencies ?? []) {
      for (const [which, param] of [['from_param', dep.from_param], ['to_param', dep.to_param]] as const) {
        if (!param || !param.trim()) {
          pushIssue(errors, sid, 'dependencies', `dependency ${dep.from_step}->${dep.to_step}: ${which} is empty（数据流描述必须指明具体变量/字段）`, 'error');
          continue;
        }
        if (!isVarRef(param)) continue; // 表达式/说明性文字不强制
        const root = rootOf(param);
        if (!varSet.has(root)) {
          pushIssue(
            errors,
            sid,
            'dependencies',
            `dependency ${dep.from_step}->${dep.to_step}: ${which} 变量 '${root}' 在源用例变量集合中不存在（疑似臆造）——数据流只能引用用例脚本中真实出现的变量（如 My_InitBalance），当前用例共有 ${varSet.size} 个变量`,
            'error',
          );
        }
      }
    }
  }

  // V11: page_draft_file 存在且含 frontmatter
  let pageContent: string | null = null;
  if (!scenario.page_draft_file) {
    pushIssue(errors, sid, 'page_draft_file', 'page_draft_file is required（页面草稿独立 md 文件路径）', 'error');
  } else {
    const pagePath = isAbsolute(scenario.page_draft_file)
      ? scenario.page_draft_file
      : resolve(draftDir, scenario.page_draft_file);
    if (!existsSync(pagePath)) {
      pushIssue(errors, sid, 'page_draft_file', `page draft file not found: ${pagePath}`, 'error');
    } else {
      pageContent = readFileSync(pagePath, 'utf8');
      if (pageContent.trim().length < 100) {
        pushIssue(errors, sid, 'page_draft_file', 'page draft content too short (<100 chars)', 'error');
      } else {
        if (!/^---\n[\s\S]*?type:\s*cbs-scenario-pattern[\s\S]*?\n---/.test(pageContent)) {
          pushIssue(errors, sid, 'page_draft_file', 'page draft frontmatter must contain "type: cbs-scenario-pattern"', 'error');
        }
        // V12: wikilink 检查（warning）
        const matchedSlugs = (scenario.steps ?? [])
          .map((s) => s.matched_step_asset_slug)
          .filter((s): s is string => !!s);
        for (const slug of matchedSlugs) {
          if (!pageContent.includes(`[[${slug}]]`)) {
            pushIssue(warnings, sid, 'page_draft_file', `page draft 未使用 wikilink 引用步骤资产 [[${slug}]]`, 'warning');
          }
        }
        // V12b: 「步骤编排」章节强制校验（error）——知识页核心，读者必须能按顺序重建用例
        const orchMatch = pageContent.match(/^(#{2,3})\s*(\d+\.\s*)?步骤(编排|串联|顺序).*$/m);
        if (!orchMatch) {
          pushIssue(errors, sid, 'page_draft_file', '页面缺少「步骤编排」章节（如：## 2. 步骤编排）——读者无法获知场景有哪几步、顺序如何串联，必须补上', 'error');
        } else {
          // 提取该章节内容（到下一个同级标题为止），检查步骤表格行数 >= 场景步骤数
          const startIdx = pageContent.indexOf(orchMatch[0]);
          const rest = pageContent.slice(startIdx + orchMatch[0].length);
          const nextHeading = rest.search(/^#{2,3}\s/m);
          const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
          const dataRows = (section.match(/^\|.*\|$/gm) ?? []).filter(
            (r) => !/^\|\s*顺序/.test(r) && !/^\|[\s\-|]+\|$/.test(r),
          );
          const stepCount = (scenario.steps ?? []).length;
          if (dataRows.length < stepCount) {
            pushIssue(errors, sid, 'page_draft_file', `「步骤编排」章节步骤表数据行数(${dataRows.length})少于场景步骤数(${stepCount})——必须每步一行（含资产/asset_id/wikilink/置信度）`, 'error');
          }
        }
        // V12c: 推荐章节（warning）
        const recommendedSections: [RegExp, string][] = [
          [/参数\s*Delta|参数Delta/, '3. 参数 Delta'],
          [/步骤间数据流|数据流/, '4. 步骤间数据流'],
          [/验证点|预期结果/, '5. 验证点'],
          [/用例生成指引|生成指引/, '8. 用例生成指引'],
        ];
        for (const [re, label] of recommendedSections) {
          if (!re.test(pageContent)) {
            pushIssue(warnings, sid, 'page_draft_file', `页面建议包含「${label}」章节（见 references/scenario-schema.md 8 章节结构）`, 'warning');
          }
        }
        // V12d: AI 占位符未填写检测（error）
        const placeholderCount = (pageContent.match(/\(AI 填写/g) ?? []).length;
        if (placeholderCount > 0) {
          pushIssue(errors, sid, 'page_draft_file', `页面仍有 ${placeholderCount} 处「(AI 填写)」占位符未填写——骨架中的每个占位符都必须替换为实际分析内容`, 'error');
        }
        // V30: 页面 frontmatter 必须包含 description 字段（中文场景描述，便于 GBrain 全文检索命中）
        const fmDescMatch = pageContent.match(/^description:\s*(.+)$/m);
        if (!fmDescMatch || fmDescMatch[1].trim().length < 10) {
          pushIssue(errors, sid, 'page_draft_file', '页面 frontmatter 缺少 description 字段（需 >=10 字中文场景描述，便于 GBrain 检索）——请将 analysis-draft.description 同步到页面 frontmatter', 'error');
        } else {
          // description 应含中文（GBrain FTS 中文检索依赖）
          if (!/[\u4e00-\u9fff]/.test(fmDescMatch[1])) {
            pushIssue(errors, sid, 'page_draft_file', '页面 frontmatter description 应包含中文描述（当前全英文，GBrain 中文检索无法命中）', 'error');
          }
        }
        // V31: intent_signature 必须已填写（error）——业务意图是 Pattern 身份核心维度
        const intentSig = scenario.intent_signature;
        if (!intentSig || intentSig.includes('AI 填写') || intentSig === 'todo-business-intent') {
          pushIssue(errors, sid, 'intent_signature', 'intent_signature 未填写——业务意图是 Pattern 身份核心维度，决定场景归属（如 ExpireTimeCorrection vs BalanceAdjustment）', 'error');
        }
        // V32: business_entities 非空（warning）——有步骤操作至少产生一个业务实体
        const bizEntities = scenario.business_entities ?? [];
        if (bizEntities.length === 0 && (scenario.steps ?? []).length > 1) {
          pushIssue(warnings, sid, 'business_entities', 'business_entities 为空——多步骤场景应至少识别一个业务实体（如 Customer/Account/FreeUnitInstance），AI 需补充', 'warning');
        }
        // V33: pattern_signature 非空（error）——Pattern 签名是场景判重基础
        if (!scenario.pattern_signature) {
          pushIssue(errors, sid, 'pattern_signature', 'pattern_signature 为空——Pattern 签名是场景判重基础（从接口调用链提取，如 Adjustment）', 'error');
        }

        // V34: pattern_signature 不应包含 setup 前置接口（warning）——前置步骤（CreateCustomer/CreateAccount 等）是通用准备，不属于 Pattern 核心流程
        const SETUP_INTERFACE_TEMPLATES = ['CreateCustomer', 'CreateAccount', 'Login', 'SystemParameter', 'InitBalance'];
        const patternParts = scenario.pattern_signature.split('+');
        const setupParts = patternParts.filter(p => SETUP_INTERFACE_TEMPLATES.some(s => p.includes(s)));
        if (setupParts.length > 0) {
          pushIssue(warnings, sid, 'pattern_signature', `pattern_signature 包含前置准备接口 [${setupParts.join(', ')}]——应只保留核心业务接口（前置步骤由 intent_signature/operation_variants 语义覆盖）`, 'warning');
        }

        // V35: analysis-notes 步骤引用应使用 Step[N] 格式（warning）——避免人类自然编号导致索引错位
        const notesContent = scenario.analysis_notes ?? '';
        const badStepRef = notesContent.match(/步骤\s*\d+/g);
        if (badStepRef) {
          pushIssue(warnings, sid, 'analysis_notes', `notes 中存在「步骤N」引用 [${badStepRef.join(', ')}]——应使用 Step[N] 格式（N 为 step_index）以确保索引准确`, 'warning');
        }

        // V36: variant_signature 应仅含核心操作，不应包含前置准备操作（error）
        const variantOps = scenario.variant_signature.split(',').filter(Boolean);
        const prepareOpsRaw = scenario.preparation_operations;
        const prepareOps = Array.isArray(prepareOpsRaw) ? prepareOpsRaw : (typeof prepareOpsRaw === 'string' ? prepareOpsRaw.split(',').filter(Boolean) : []);
        for (const pv of variantOps) {
          if (prepareOps.includes(pv)) {
            pushIssue(errors, sid, 'variant_signature', `variant_signature 包含前置准备操作 [${pv}]——应仅含核心操作，前置操作归入 preparation_operations`, 'error');
          }
        }

        // V37: scenario name 应与 intent_signature 语义对齐（warning）——场景名应使用业务语言而非技术操作
        if (scenario.name && scenario.intent_signature && scenario.intent_signature !== '(AI 填写业务意图，如 ExpireTimeCorrection)') {
          // 简单检测：如果 name 包含"调账"但 intent 不含"调账"，可能命名不当
          const nameHasTechOp = /调账|新增|修改|删除/.test(scenario.name) && !/调账/.test(scenario.intent_signature);
          if (nameHasTechOp) {
            pushIssue(warnings, sid, 'name', `场景名「${scenario.name}」含技术操作词，建议与 intent_signature「${scenario.intent_signature}」对齐使用业务语言`, 'warning');
          }
        }

        // V12e: 页面 frontmatter slug 与草稿 slug_en 一致性（error）——入库后页面自身标识必须与 plan slug 一致
        const expectedSlug = generateScenarioSlug(scenario.name, scenario.site_key, scenario.slug_en);
        const fmSlugMatch = pageContent.match(/^slug:\s*(\S+)\s*$/m);
        if (!fmSlugMatch) {
          pushIssue(errors, sid, 'page_draft_file', 'page draft frontmatter 缺少 slug 字段', 'error');
        } else if (fmSlugMatch[1] !== expectedSlug) {
          pushIssue(
            errors,
            sid,
            'page_draft_file',
            `页面 frontmatter slug '${fmSlugMatch[1]}' 与草稿 slug_en 推导的最终 slug '${expectedSlug}' 不一致——请将页面 slug 改为 '${expectedSlug}'（init 骨架的 todo 占位必须同步更新）`,
            'error',
          );
        }
        // V12f: wikilink 真实性校验（error）——禁止臆造不存在的 GBrain 页面 slug
        const knownSlugs = new Set<string>([
          ...caseData.step_assets.map((a) => a.slug).filter((s): s is string => !!s),
          ...caseData.existing_scenarios.map((e) => e.slug),
          expectedSlug,
        ]);
        const wikilinks = pageContent.match(/\[\[([^\]]+)\]\]/g) ?? [];
        for (const wl of wikilinks) {
          const target = wl.slice(2, -2).split('|')[0].trim(); // 支持 [[slug|显示名]] 形式
          if (knownSlugs.has(target)) continue;
          if (/^cbs\/(sites|products)\//.test(target)) continue; // 结构页豁免（site/product 页由平台维护）
          pushIssue(
            errors,
            sid,
            'page_draft_file',
            `wikilink [[${target}]] 不在已知 slug 集合中（步骤资产 ${knownSlugs.size} 个已知）——禁止臆造不存在的 GBrain 页面；若为资产页请核对 case-data step_assets[].slug`,
            'error',
          );
        }
        // V23: 页面正文 My_* 变量真实性（warning）——页面残留编造变量是已发生过的真实事故（My_EXP_DATE_NEW）
        const assetVarNames = new Set<string>();
        for (const a of caseData.step_assets) for (const v of a.open_parameter_names ?? []) assetVarNames.add(v);
        for (const sd of (scenario.steps ?? []).flatMap((s) => s.param_deltas ?? [])) {
          if (sd.variable_name) assetVarNames.add(sd.variable_name);
        }
        const pageVars = new Set((pageContent.match(/\bMy_[A-Za-z0-9_]+/g) ?? []));
        const fabricated = [...pageVars].filter((v) => !scenarioVarSet.has(v) && !assetVarNames.has(v));
        if (fabricated.length > 0) {
          pushIssue(
            warnings,
            sid,
            'page_draft_file',
            `页面正文中 ${fabricated.length} 个变量在源用例/资产变量集合中不存在（疑似臆造）：${fabricated.slice(0, 5).join(', ')}——请核对数据流/参数表，改用用例脚本中真实变量`,
            'warning',
          );
        }
      }
    }
  }

  // V13: notability（warning）
  if ((scenario.source_cases ?? []).length < 2) {
    pushIssue(
      warnings,
      sid,
      'source_cases',
      `notability: only ${(scenario.source_cases ?? []).length} source case(s). Recommend >= 2 for a reproducible pattern.`,
      'warning',
    );
  }

  // V14: similar_existing_scenarios 结构
  for (const sim of scenario.similar_existing_scenarios ?? []) {
    if (!sim.slug || !sim.similarity_reason) {
      pushIssue(errors, sid, 'similar_existing_scenarios', 'similar_existing_scenarios entries require slug + similarity_reason', 'error');
    }
  }

  // V15: scenario_knowledge 完整性
  const sk = scenario.scenario_knowledge;
  if (!sk) {
    pushIssue(errors, sid, 'scenario_knowledge', 'scenario_knowledge is required', 'error');
  } else {
    if (!sk.core_business_knowledge || sk.core_business_knowledge.trim().length < 20) {
      pushIssue(errors, sid, 'scenario_knowledge.core_business_knowledge', 'core_business_knowledge must be >= 20 chars', 'error');
    }
    if (!Array.isArray(sk.parameter_design_rationale) || sk.parameter_design_rationale.length === 0) {
      pushIssue(errors, sid, 'scenario_knowledge.parameter_design_rationale', 'parameter_design_rationale must be a non-empty array', 'error');
    } else {
      for (const [i, item] of sk.parameter_design_rationale.entries()) {
        if (!item.parameter || !item.field_meaning || !item.why_this_value) {
          pushIssue(
            errors,
            sid,
            'scenario_knowledge.parameter_design_rationale',
            `entry[${i}] missing required fields (parameter/field_meaning/why_this_value)`,
            'error',
          );
        }
      }
    }
    if (!Array.isArray(sk.preconditions) || sk.preconditions.length === 0) {
      pushIssue(errors, sid, 'scenario_knowledge.preconditions', 'preconditions must be a non-empty array', 'error');
    }
    if (!Array.isArray(sk.expected_results) || sk.expected_results.length === 0) {
      pushIssue(errors, sid, 'scenario_knowledge.expected_results', 'expected_results must be a non-empty array', 'error');
    }
  }

  // V16: test_points（warning）
  if (!Array.isArray(scenario.test_points) || scenario.test_points.length === 0) {
    pushIssue(errors, sid, 'test_points', 'test_points is empty（必须列出测试点及关联参数）', 'error');
  }

  return { pageContent };
}

// ─── Layer 3: 质量启发式（warning） ──────────────────────

function scoreQuality(scenario: AnalysisDraftScenario, warnings: ValidationIssue[]): void {
  const sid = scenario.scenario_id;
  for (const step of scenario.steps ?? []) {
    for (const pd of step.param_deltas ?? []) {
      if (pd.field_description) {
        // 响应模板变量（rRsp/rVars）和技术构造的描述可能不含数据类型关键词，放宽检查
        const isResponseVar = /^(rRsp|rVars|My_.*Rsp|My_.*Vars?)\b/i.test(pd.variable_name);
        const hasDataType = /String|Long|List|Integer|Boolean|Number|Double|Float|字符串|数值|列表|布尔|整数|正整数|负整数|枚举|单位|小数|百分比|金额|数量|标识|编码|名称|日期|时间|毫秒|秒|分|元|位/.test(pd.field_description);
        const hasBusinessMeaning = /响应|返回|结果|输出|验证|查询|保存|组件|接口|请求|参数|配置|模板/.test(pd.field_description);
        if ((!hasDataType && !hasBusinessMeaning && !isResponseVar) || pd.field_description.length <= 10) {
          pushIssue(
            warnings,
            sid,
            'param_deltas',
            `step ${step.step_index} param '${pd.variable_name}' field_description 缺少数据类型或业务含义`,
            'warning',
          );
        }
      }
      if (pd.reason) {
        const hasRationale = /为了|确保|因为|用于|目的是|以便|使得|通过|实现|触发|模拟|验证|去除|保留|设置|使用|避免|简化|覆盖|指定|配置|需要|不需要|不支持|必须/.test(pd.reason);
        if (!hasRationale && pd.reason.length < 15) {
          pushIssue(
            warnings,
            sid,
            'param_deltas',
            `step ${step.step_index} param '${pd.variable_name}' reason 缺少业务理由`,
            'warning',
          );
        }
      }
    }
  }
}

// ─── Main ───────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const draftPath = args.draft;
  const caseDataPath = args['case-data'];
  const notesPath = args['analysis-notes'];
  const outPlanPath = args['out-plan'];
  const outReportPath = args['out-report'];

  if (!draftPath || !caseDataPath || !outPlanPath || !outReportPath) {
    console.error('Usage: bun validate-analysis.ts --draft <path> --case-data <path> --analysis-notes <path> --out-plan <path> --out-report <path>');
    process.exit(1);
  }

  const draft = JSON.parse(readFileSync(draftPath, 'utf8')) as AnalysisDraft;
  const caseData = JSON.parse(readFileSync(caseDataPath, 'utf8')) as CaseDataFile;
  const draftDir = dirname(resolve(draftPath));

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Layer 1: 证据链门禁
  validateAnalysisNotes(draft, notesPath, errors);

  // Layer 2 + 3
  const pageContents = new Map<string, string>();
  for (const scenario of draft.scenarios) {
    const { pageContent } = validateScenarioStructure(scenario, caseData, draftDir, errors, warnings);
    if (pageContent) pageContents.set(scenario.scenario_id, pageContent);
    scoreQuality(scenario, warnings);
  }

  // ─── Build plan ─────────────────────────────────────

  const now = new Date().toISOString();
  const scenarios: ScenarioPattern[] = [];
  const pages: ScenarioPlanPage[] = [];
  const links: ScenarioPlanLink[] = [];
  const timelines: ScenarioPlanTimeline[] = [];

  for (const scenario of draft.scenarios) {
    const pageContent = pageContents.get(scenario.scenario_id);
    if (!pageContent) continue; // 无页面内容（已有 error）

    // extend 模式沿用目标 slug；create 模式生成新 slug
    const scenarioSlug =
      scenario.merge_mode === 'extend' && scenario.target_scenario_slug
        ? scenario.target_scenario_slug
        : generateScenarioSlug(scenario.name, scenario.site_key, scenario.slug_en);

    const pattern: ScenarioPattern = {
      scenario_id: scenario.scenario_id,
      scenario_slug: scenarioSlug,
      scenario_name: scenario.name,
      description: scenario.description,
      site_key: scenario.site_key,
      site_id: scenario.site_id,
      site_name: scenario.site_name,
      product_slug: scenario.product_slug,
      merge_mode: scenario.merge_mode,
      target_scenario_slug: scenario.target_scenario_slug ?? null,
      pattern_signature: scenario.pattern_signature ?? null,
      intent_signature: scenario.intent_signature ?? null,
      variant_signature: scenario.variant_signature ?? null,
      preparation_operations: Array.isArray(scenario.preparation_operations) ? scenario.preparation_operations : (typeof scenario.preparation_operations === 'string' ? scenario.preparation_operations.split(',').filter(Boolean) : []),
      parameter_signature: scenario.parameter_signature ?? null,
      capability: scenario.capability ?? null,
      business_entities: scenario.business_entities ?? [],
      steps: (scenario.steps ?? []).map((s) => ({
        step_index: s.step_index,
        step_name: s.behavior,
        role: 'core' as const,
        matched_step_slug: s.matched_step_asset_slug,
        matched_asset_id: s.matched_asset_id ?? null,
        matched_step_name: null,
        confidence: s.match_confidence,
        match_status: s.matched_asset_id ? (s.match_confidence >= 0.75 ? 'matched' as const : 'tentative' as const) : 'unmatched' as const,
        behavior: s.behavior,
      })),
      param_deltas: (scenario.steps ?? []).flatMap((s) => s.param_deltas ?? []),
      param_dependencies: scenario.dependencies ?? [],
      source_cases: scenario.source_cases ?? [],
      missing_step_suggestions: scenario.missing_step_suggestions ?? [],
      variant_suggestions: scenario.variant_suggestions ?? [],
      scenario_knowledge: scenario.scenario_knowledge,
    };
    scenarios.push(pattern);

    pages.push({
      slug: scenarioSlug,
      kind: 'scenario-pattern',
      content: pageContent,
      content_sha256: sha256(pageContent),
      immutable: false,
      natural_key: scenarioSlug,
      merge_mode: scenario.merge_mode,
    });

    // --- analysis-data page: structured JSON for use-case generation ---
    const analysisDataSlug = `${scenarioSlug}/analysis-data`;
    const matchedSteps = (scenario.steps ?? []).filter((s) => s.matched_asset_id);
    const allDeltas = (scenario.steps ?? []).flatMap((s) => s.param_deltas ?? []);
    const analysisDataJson = {
      pattern_signature: scenario.pattern_signature ?? '',
      intent_signature: scenario.intent_signature ?? '',
      variant_signature: scenario.variant_signature ?? '',
      preparation_operations: Array.isArray(scenario.preparation_operations) ? scenario.preparation_operations : (typeof scenario.preparation_operations === 'string' ? scenario.preparation_operations.split(',').filter(Boolean) : []),
      parameter_signature: scenario.parameter_signature ?? '',
      capability: scenario.capability ?? '',
      business_entities: scenario.business_entities ?? [],
      operation_variants: scenario.operation_variants ?? [],
      parameter_variants: scenario.parameter_variants ?? [],
      steps: (scenario.steps ?? []).map((s) => ({
        step_index: s.step_index,
        behavior: s.behavior,
        matched_asset_id: s.matched_asset_id ?? null,
        matched_step_asset_slug: s.matched_step_asset_slug ?? null,
        match_confidence: s.match_confidence ?? null,
        component_sequence: s.component_sequence ?? [],
        param_deltas: (s.param_deltas ?? []).map((pd) => ({
          component_alias: pd.component_alias,
          variable_name: pd.variable_name,
          change_type: pd.change_type,
          asset_default_value: pd.asset_default_value ?? '',
          case_value: pd.case_value ?? '',
        })),
      })),
    };
    const analysisDataContent = [
      '---',
      `kind: scenario-analysis-data`,
      `scenario_slug: ${scenarioSlug}`,
      `scenario_name: ${scenario.name ?? ''}`,
      `pattern_signature: ${scenario.pattern_signature ?? ''}`,
      `intent_signature: ${scenario.intent_signature ?? ''}`,
      `variant_signature: ${scenario.variant_signature ?? ''}`,
      `preparation_operations: ${(Array.isArray(scenario.preparation_operations) ? scenario.preparation_operations : (typeof scenario.preparation_operations === 'string' ? scenario.preparation_operations.split(',').filter(Boolean) : [])).join(',')}`,
      `parameter_signature: ${scenario.parameter_signature ?? ''}`,
      `capability: ${scenario.capability ?? ''}`,
      `step_count: ${(scenario.steps ?? []).length}`,
      `matched_step_count: ${matchedSteps.length}`,
      `total_delta_count: ${allDeltas.length}`,
      `source_cases: ${(scenario.source_cases ?? []).join(', ')}`,
      '---',
      '',
      '```json',
      JSON.stringify(analysisDataJson, null, 2),
      '```',
    ].join('\n');
    pages.push({
      slug: analysisDataSlug,
      kind: 'scenario-analysis-data',
      content: analysisDataContent,
      content_sha256: sha256(analysisDataContent),
      immutable: true,
      natural_key: analysisDataSlug,
      merge_mode: scenario.merge_mode,
    });
    // link: scenario → analysis-data
    links.push({
      from_slug: scenarioSlug,
      to_slug: analysisDataSlug,
      link_type: 'has_analysis_data',
      context: `structured delta data for use-case generation`,
    });
    // links: analysis-data → each matched step asset
    for (const step of matchedSteps) {
      if (step.matched_step_asset_slug) {
        links.push({
          from_slug: analysisDataSlug,
          to_slug: step.matched_step_asset_slug,
          link_type: 'references_step',
          context: `step ${step.step_index}: ${step.behavior} (asset: ${step.matched_asset_id})`,
        });
      }
    }

    for (const step of scenario.steps ?? []) {
      if (step.matched_step_asset_slug && step.match_confidence >= 0.75) {
        links.push({
          from_slug: scenarioSlug,
          to_slug: step.matched_step_asset_slug,
          link_type: 'composed_of_step',
          context: `step ${step.step_index}: ${step.behavior} (confidence: ${step.match_confidence.toFixed(2)})`,
        });
      }
    }

    // evidenced_by links to original case pages are intentionally omitted:
    // GBrain is a knowledge base, not a test data repository. source_cases
    // in frontmatter provides lightweight traceability via case_id without
    // requiring case pages to exist in GBrain.

    for (const dep of scenario.dependencies ?? []) {
      const fromStep = (scenario.steps ?? []).find((s) => s.step_index === dep.from_step);
      const toStep = (scenario.steps ?? []).find((s) => s.step_index === dep.to_step);
      if (fromStep?.matched_step_asset_slug && toStep?.matched_step_asset_slug) {
        links.push({
          from_slug: fromStep.matched_step_asset_slug,
          to_slug: toStep.matched_step_asset_slug,
          link_type: 'param_flows_to',
          context: `${dep.from_param} -> ${dep.to_param} (${dep.type}): ${dep.description}`,
        });
      }
    }

    const idemMarker = `cbs-scenario|${sha256(`${scenarioSlug}|${(scenario.source_cases ?? []).slice().sort().join(',')}`).slice(0, 16)}`;
    timelines.push({
      slug: scenarioSlug,
      date: now.slice(0, 10),
      entry:
        scenario.merge_mode === 'extend'
          ? `extend: merged cases ${(scenario.source_cases ?? []).join(', ')} into existing scenario [idem:${idemMarker}]`
          : `create: from historical cases: ${(scenario.source_cases ?? []).join(', ')} [idem:${idemMarker}]`,
      idempotency_marker: idemMarker,
    });
  }

  const plan: ScenarioPlan = {
    schema_version: 'cbs-scenario-plan-v1',
    skill: { name: 'cbs-case-scenario-analyze', version: '0.13.0' },
    generated_at: now,
    input: {
      case_files: caseData.cases.map((c) => c.source_file),
      interface_doc: caseData.extraction_meta.interface_doc_provided ? 'provided' : null,
      common_structure_doc: caseData.extraction_meta.common_structure_doc_provided ? 'provided' : null,
    },
    scenarios,
    pages,
    links,
    timelines,
    apply_contract: {
      executor: 'scripts/apply-scenario.ts',
      authorization_entrypoint: 'scripts/authorize-scenario-plan.ps1',
      runtime_policy: {
        apply_attempts_per_user_authorization: 1,
        on_failure: 'stop-and-report',
        agent_may_retry_automatically: false,
        agent_may_modify_skill_or_plan: false,
        agent_may_create_workaround_scripts: false,
        agent_may_bypass_executor_with_manual_writes: false,
      },
    },
    plan_integrity: {
      authorized: false,
      payload_sha256: '',
      dry_run_payload_sha256: '',
      authorized_payload_sha256: null,
      authorization_method: null,
      authorized_at: null,
    },
  };

  // notability_status 必须参与哈希计算（否则授权时重算哈希会不匹配）
  const hasNotabilityWarning = warnings.some((w) => w.field === 'source_cases');
  (plan as unknown as Record<string, unknown>).notability_status = hasNotabilityWarning ? 'insufficient' : 'sufficient';

  plan.plan_integrity.payload_sha256 = planPayloadSha256(plan);
  plan.plan_integrity.dry_run_payload_sha256 = plan.plan_integrity.payload_sha256;

  // ─── Write outputs ────────────────────────────────────

  const errorCount = errors.length;
  const warningCount = warnings.length;

  if (errorCount === 0) {
    const planDir = dirname(outPlanPath);
    if (planDir && !existsSync(planDir)) mkdirSync(planDir, { recursive: true });
    writeFileSync(outPlanPath, JSON.stringify(plan, null, 2), 'utf8');
  }

  // ─── Report ────────────────────────────────────────────

  const reportLines: string[] = [];
  reportLines.push('# CBS 场景分析校验报告');
  reportLines.push('');
  reportLines.push(`> 校验时间: ${now}`);
  reportLines.push(`> 草稿文件: ${draftPath}`);
  reportLines.push(`> 数据文件: ${caseDataPath}`);
  reportLines.push(`> 分析笔记: ${notesPath ?? '(未提供)'}`);
  reportLines.push('');
  reportLines.push('## 校验摘要');
  reportLines.push('');
  reportLines.push('| 项目 | 数量 |');
  reportLines.push('|------|------|');
  reportLines.push(`| 场景数 | ${scenarios.length} |`);
  reportLines.push(`| 页面数 | ${pages.length} |`);
  reportLines.push(`| 关系数 | ${links.length} |`);
  reportLines.push(`| Timeline 数 | ${timelines.length} |`);
  reportLines.push(`| 错误数 | ${errorCount} |`);
  reportLines.push(`| 警告数 | ${warningCount} |`);
  reportLines.push(`| create 模式 | ${scenarios.filter((s) => s.merge_mode === 'create').length} |`);
  reportLines.push(`| extend 模式 | ${scenarios.filter((s) => s.merge_mode === 'extend').length} |`);
  reportLines.push('');

  if (errorCount > 0) {
    reportLines.push('## 错误详情');
    reportLines.push('');
    reportLines.push('| 场景 | 字段 | 消息 |');
    reportLines.push('|------|------|------|');
    for (const err of errors) {
      reportLines.push(`| ${err.scenario_id} | ${err.field} | ${err.message} |`);
    }
    reportLines.push('');
  }

  if (warningCount > 0) {
    reportLines.push('## 警告详情');
    reportLines.push('');
    reportLines.push('| 场景 | 字段 | 消息 |');
    reportLines.push('|------|------|------|');
    for (const warn of warnings) {
      reportLines.push(`| ${warn.scenario_id} | ${warn.field} | ${warn.message} |`);
    }
    reportLines.push('');
  }

  reportLines.push('## 场景列表');
  reportLines.push('');
  reportLines.push('| 序号 | 场景名称 | Slug | 模式 | 步骤数 | 用例数 | 已匹配 | 待确认 | 未匹配 |');
  reportLines.push('|------|---------|------|------|--------|--------|--------|--------|--------|');
  scenarios.forEach((s, i) => {
    const matched = s.steps.filter((st) => st.match_status === 'matched').length;
    const tentative = s.steps.filter((st) => st.match_status === 'tentative').length;
    const unmatched = s.steps.filter((st) => st.match_status === 'unmatched').length;
    reportLines.push(`| ${i + 1} | ${s.scenario_name} | ${s.scenario_slug} | ${s.merge_mode} | ${s.steps.length} | ${s.source_cases.length} | ${matched} | ${tentative} | ${unmatched} |`);
  });
  reportLines.push('');

  if (errorCount > 0) {
    reportLines.push('## 校验结果: FAIL');
    reportLines.push('');
    reportLines.push('存在错误，计划文件未生成。请修正 analysis-draft.json 后重新校验。');
  } else if (warningCount > 0) {
    reportLines.push('## 校验结果: PASS (with warnings)');
    reportLines.push('');
    reportLines.push('校验通过，但存在警告。计划文件已生成，请审阅警告详情后决定是否授权。');
  } else {
    reportLines.push('## 校验结果: PASS');
    reportLines.push('');
    reportLines.push('所有校验项通过。可以执行授权。');
  }

  const reportDir = dirname(outReportPath);
  if (reportDir && !existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  writeFileSync(outReportPath, reportLines.join('\n'), 'utf8');

  console.error('');
  console.error('=== validation complete ===');
  console.error(`  scenarios: ${scenarios.length}`);
  console.error(`  pages: ${pages.length}`);
  console.error(`  links: ${links.length}`);
  console.error(`  timelines: ${timelines.length}`);
  console.error(`  errors: ${errorCount}`);
  console.error(`  warnings: ${warningCount}`);
  console.error(`  plan: ${outPlanPath}`);
  console.error(`  report: ${outReportPath}`);
  if (errorCount > 0) {
    console.error('  STATUS: FAIL');
    process.exit(1);
  }
  console.error('  STATUS: PASS');
}

main();
