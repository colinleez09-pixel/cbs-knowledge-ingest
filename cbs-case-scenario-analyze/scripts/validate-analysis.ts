#!/usr/bin/env bun
/**
 * validate-analysis.ts  (v2.0)
 * Phase 1 Step 4: 验证 AI 分析草稿 + 重建门禁 + 生成 analysis-data.json
 *
 * 用法：
 *   bun validate-analysis.ts --draft <analysis-draft.json> --case-data <case-data.json>
 *     --analysis-notes <analysis-notes.md> --out-data <analysis-data.json> --out-report <report.md>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyPatches,
  canonicalJson,
  compareReconstructed,
  deepClone,
  sha256,
  siteKeyFromId,
  type AnalysisDraft,
  type AnalysisDraftScenario,
  type CaseDataFile,
  type CaseDataStep,
  type FieldPatch,
  type ReconstructionResult,
} from './scenario-core.ts';

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith('--')) args[argv[i]!.slice(2)] = argv[++i] ?? '';
  }
  return args;
}

interface ValidationIssue {
  scenario_id: string;
  gate: string;
  message: string;
  severity: 'error' | 'warning';
}

function pushIssue(list: ValidationIssue[], sid: string, gate: string, msg: string, sev: 'error' | 'warning'): void {
  list.push({ scenario_id: sid, gate, message: msg, severity: sev });
}

const SETUP_TEMPLATES = ['CreateCustomer', 'CreateAccount', 'Login', 'SystemParameter', 'InitBalance', 'PrepareData', 'Setup', 'Initialize'];

// ─── Layer 1: Notes evidence gate ─────────────────────────

function validateNotes(draft: AnalysisDraft, notesPath: string, issues: ValidationIssue[]): void {
  if (!notesPath || !existsSync(notesPath)) {
    pushIssue(issues, '(global)', 'V17', `analysis-notes 文件不存在: ${notesPath || '(未提供)'}`, 'error');
    return;
  }
  const content = readFileSync(notesPath, 'utf8');
  if (content.trim().length < 200) {
    pushIssue(issues, '(global)', 'V17', 'analysis-notes.md 内容过短（<200字符）', 'error');
  }
  const placeholders = (content.match(/\(AI 填写/g) ?? []).length;
  if (placeholders > 0) {
    pushIssue(issues, '(global)', 'V17', `analysis-notes.md 仍有 ${placeholders} 处占位符未填写`, 'error');
  }
  for (const sc of draft.scenarios) {
    const found = content.includes(sc.scenario_id) || content.includes(sc.scenario_name) || sc.source_cases.some((c) => content.includes(c));
    if (!found) {
      pushIssue(issues, sc.scenario_id, 'V17', `analysis-notes.md 中未找到场景「${sc.scenario_name}」的分析记录`, 'error');
    }
  }
}

// ─── Layer 4: analysis-data JSON generator ────────────────

function generateAnalysisData(
  draft: AnalysisDraft,
  caseData: CaseDataFile,
): unknown {
  const scenarios = draft.scenarios.map((sc) => {
    const siteKey = caseData.cases.find((c) => sc.source_cases.includes(c.case_id))?.basic_info;
    const sk = siteKey ? siteKeyFromId(siteKey.site_id, siteKey.site_name) : 'unknown';
    const scenarioId = sc.scenario_id;
    return {
      slug: `cbs/scenarios/${sk}/${scenarioId}/analysis-data`,
      scenario_id: scenarioId,
      scenario_name: sc.scenario_name,
      capability: sc.capability,
      maturity: sc.maturity,
      signatures: {
        pattern: sc.pattern_signature,
        intent: sc.intent_signature,
        variant: sc.variant_signature,
        parameter: sc.parameter_signature,
      },
      preparation_operations: sc.preparation_operations,
      source_cases: sc.source_cases,
      business_entities: sc.business_entities,
      variable_dependencies: sc.variable_dependencies,
      operation_variants: sc.operation_variants,
      parameter_variants: sc.parameter_variants,
      test_points: sc.test_points,
      steps: sc.steps.map((st) => {
        const caseStep = findCaseStep(caseData, sc, st.step_index);
        return {
          step_index: st.step_index,
          step_name: st.step_name,
          construction_mode: st.construction_mode,
          matched_asset_id: st.matched_asset_id,
          match_kind: st.match_kind,
          match_reason: st.match_reason,
          patches: st.patches,
          inline_recipe: st.inline_recipe,
          reconstruction: st.reconstruction,
          variable_inputs: st.variable_inputs ?? caseStep?.variable_inputs ?? [],
          variable_outputs: st.variable_outputs ?? caseStep?.variable_outputs ?? [],
        };
      }),
      unresolved_questions: sc.unresolved_questions,
      hash: sha256(canonicalJson({
        signatures: { pattern: sc.pattern_signature, intent: sc.intent_signature, variant: sc.variant_signature, parameter: sc.parameter_signature },
        steps: sc.steps.map((s) => s.patches),
      })),
    };
  });

  return {
    version: 'cbs-analysis-data-v2',
    generated_at: new Date().toISOString(),
    scenarios,
  };
}

// ─── Report generator ─────────────────────────────────────

function generateReport(draft: AnalysisDraft, issues: ValidationIssue[]): string {
  const L: string[] = [];
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  L.push('# Validation Report');
  L.push('');
  L.push(`Errors: ${errors.length}  |  Warnings: ${warnings.length}`);
  L.push('');
  if (errors.length > 0) {
    L.push('## Errors');
    L.push('');
    for (const e of errors) {
      L.push(`- [${e.gate}] ${e.scenario_id}: ${e.message}`);
    }
    L.push('');
  }
  if (warnings.length > 0) {
    L.push('## Warnings');
    L.push('');
    for (const w of warnings) {
      L.push(`- [${w.gate}] ${w.scenario_id}: ${w.message}`);
    }
    L.push('');
  }
  // Summary per scenario
  L.push('## Scenario Summary');
  L.push('');
  L.push('| Scenario | Steps | Patches | Construction Modes | Maturity |');
  L.push('|----------|-------|---------|---------------------|----------|');
  for (const sc of draft.scenarios) {
    const patchCount = sc.steps.reduce((sum, s) => sum + s.patches.length, 0);
    const cms = [...new Set(sc.steps.map((s) => s.construction_mode))].join(', ');
    L.push(`| ${sc.scenario_name} | ${sc.steps.length} | ${patchCount} | ${cms} | ${sc.maturity} |`);
  }
  L.push('');
  return L.join('\n');
}

// ─── main ─────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv);
  const draftPath = args['draft'];
  const caseDataPath = args['case-data'];
  const notesPath = args['analysis-notes'];
  const outData = args['out-data'] || 'analysis-data.json';
  const outReport = args['out-report'] || 'validation-report.md';

  if (!draftPath || !caseDataPath) {
    console.error('Usage: bun validate-analysis.ts --draft <draft.json> --case-data <case-data.json> --analysis-notes <notes.md> --out-data <out.json> --out-report <report.md>');
    process.exit(1);
  }

  const draft = JSON.parse(readFileSync(draftPath, 'utf8')) as AnalysisDraft;
  const caseData = JSON.parse(readFileSync(caseDataPath, 'utf8')) as CaseDataFile;

  const issues: ValidationIssue[] = [];

  // Layer 1: Notes evidence
  validateNotes(draft, notesPath, issues);

  // Build pattern_signature index for V20
  const allPatternSigs = new Map<string, string[]>();
  for (const sc of draft.scenarios) {
    const arr = allPatternSigs.get(sc.pattern_signature) ?? [];
    arr.push(sc.scenario_id);
    allPatternSigs.set(sc.pattern_signature, arr);
  }

  // Layer 2: Structure validation
  for (const sc of draft.scenarios) {
    validateScenario(sc, caseData, allPatternSigs, issues);
  }

  // Layer 3: Reconstruction gate
  for (const sc of draft.scenarios) {
    runReconstructionGate(sc, caseData, issues);
  }

  // Generate report
  const report = generateReport(draft, issues);
  writeFileSync(outReport, report, 'utf8');

  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    console.error(`[validate] FAILED: ${errors.length} errors, ${issues.filter((i) => i.severity === 'warning').length} warnings`);
    console.error(`[validate] Report: ${resolve(outReport)}`);
    console.log(JSON.stringify({ status: 'failed', errors: errors.length, warnings: issues.filter((i) => i.severity === 'warning').length, report: outReport }));
    process.exit(1);
  }

  // Generate analysis-data
  const analysisData = generateAnalysisData(draft, caseData);
  writeFileSync(outData, JSON.stringify(analysisData, null, 2), 'utf8');

  console.error(`[validate] PASSED: ${issues.filter((i) => i.severity === 'warning').length} warnings`);
  console.error(`[validate] analysis-data: ${resolve(outData)}`);
  console.error(`[validate] report: ${resolve(outReport)}`);
  console.log(JSON.stringify({
    status: 'passed',
    warnings: issues.filter((i) => i.severity === 'warning').length,
    analysis_data: outData,
    report: outReport,
    scenario_count: draft.scenarios.length,
  }));
}

main();

// ─── Layer 2: Scenario structure validation ───────────────

function findCaseStep(caseData: CaseDataFile, scenario: AnalysisDraftScenario, stepIndex: number): CaseDataStep | null {
  for (const c of caseData.cases) {
    if (scenario.source_cases.includes(c.case_id)) {
      const found = c.steps.find((s) => s.step_index === stepIndex);
      if (found) return found;
    }
  }
  return null;
}

function validateScenario(
  scenario: AnalysisDraftScenario,
  caseData: CaseDataFile,
  allPatternSigs: Map<string, string[]>,
  issues: ValidationIssue[],
): void {
  const sid = scenario.scenario_id || '(empty)';
  const assetIds = new Set(caseData.step_assets.map((a) => a.asset_id));

  // V1: scenario_id
  if (!scenario.scenario_id?.trim()) pushIssue(issues, '(empty)', 'V1', 'scenario_id is required', 'error');

  // V2: scenario_name not placeholder
  if (!scenario.scenario_name?.trim() || /^scenario-draft-[0-9a-f]{8}$/i.test(scenario.scenario_name)) {
    pushIssue(issues, sid, 'V2', `scenario_name 仍是占位名 '${scenario.scenario_name}'：必须改写为简洁场景名`, 'error');
  }

  // V3: source_cases
  if (!scenario.source_cases?.length) {
    pushIssue(issues, sid, 'V3', 'source_cases must not be empty', 'error');
  } else {
    const caseIds = new Set(caseData.cases.map((c) => c.case_id));
    for (const cid of scenario.source_cases) {
      if (!caseIds.has(cid)) pushIssue(issues, sid, 'V3', `case_id '${cid}' not found in case-data`, 'error');
    }
  }

  // V4: pattern_signature
  if (!scenario.pattern_signature?.trim()) {
    pushIssue(issues, sid, 'V4', 'pattern_signature must not be empty', 'error');
  }

  // V5: pattern excludes setup interfaces
  for (const setup of SETUP_TEMPLATES) {
    if (scenario.pattern_signature?.includes(setup)) {
      pushIssue(issues, sid, 'V5', `pattern_signature contains setup interface '${setup}'`, 'error');
      break;
    }
  }

  // V6: intent_signature filled
  if (!scenario.intent_signature?.trim() || scenario.intent_signature.includes('(AI')) {
    pushIssue(issues, sid, 'V6', 'intent_signature must be filled with business intent (not placeholder)', 'error');
  }

  // V7: steps asset_id validity
  for (const step of scenario.steps) {
    if (step.matched_asset_id && !assetIds.has(step.matched_asset_id)) {
      pushIssue(issues, sid, 'V7', `Step[${step.step_index}]: asset_id '${step.matched_asset_id}' not found in case-data`, 'error');
    }
  }

  // V8: match consistency
  for (const step of scenario.steps) {
    const caseStep = findCaseStep(caseData, scenario, step.step_index);
    if (!caseStep) continue;
    const scriptMatch = caseStep.match;
    if (scriptMatch.match_status === 'exact' || (scriptMatch.score >= 0.75 && scriptMatch.matched_asset_id)) {
      if (!step.matched_asset_id) {
        pushIssue(issues, sid, 'V8', `Step[${step.step_index}]: script matched ${scriptMatch.matched_asset_name} (score ${scriptMatch.score.toFixed(2)}) but AI cleared match`, 'error');
      } else if (step.matched_asset_id !== scriptMatch.matched_asset_id) {
        pushIssue(issues, sid, 'V8', `Step[${step.step_index}]: script matched ${scriptMatch.matched_asset_name} but AI chose different asset (reason: ${step.match_reason || '(empty)'})`, scriptMatch.score >= 0.9 ? 'error' : 'warning');
      }
    }
  }

  // V9: patch coverage — every script patch must appear in AI patches
  for (const step of scenario.steps) {
    const caseStep = findCaseStep(caseData, scenario, step.step_index);
    if (!caseStep || caseStep.script_patches.length === 0) continue;
    const aiKeys = new Set(step.patches.map((p) => `${p.component}::${p.field_path}::${p.operation}`));
    for (const sp of caseStep.script_patches) {
      const key = `${sp.component}::${sp.field_path}::${sp.operation}`;
      if (!aiKeys.has(key)) {
        pushIssue(issues, sid, 'V9', `Step[${step.step_index}]: script patch '${key}' (${sp.operation}: ${sp.asset_value ?? '-'} -> ${sp.case_value ?? '-'}) missing from AI patches`, 'error');
      }
    }
  }

  // V10: patch reason non-empty
  for (const step of scenario.steps) {
    for (const p of step.patches) {
      if (!p.reason || p.reason.trim().length < 5 || p.reason.includes('(AI')) {
        pushIssue(issues, sid, 'V10', `Step[${step.step_index}] ${p.field_path}: patch reason missing or too short`, 'warning');
      }
    }
  }

  // V11: evidence_sources non-empty
  for (const step of scenario.steps) {
    for (const p of step.patches) {
      if (!p.evidence_sources || p.evidence_sources.length === 0) {
        pushIssue(issues, sid, 'V11', `Step[${step.step_index}] ${p.field_path}: evidence_sources empty`, 'warning');
      }
    }
  }

  // V12: required_for_execution patches must not be unresolved
  for (const step of scenario.steps) {
    for (const p of step.patches) {
      if (p.required_for_execution && p.confidence === 'unresolved') {
        pushIssue(issues, sid, 'V12', `Step[${step.step_index}] ${p.field_path}: required patch is unresolved`, 'error');
      }
    }
  }

  // V13: construction_mode matches match_kind
  for (const step of scenario.steps) {
    if (step.construction_mode === 'asset-plus-patches' && !step.matched_asset_id) {
      pushIssue(issues, sid, 'V13', `Step[${step.step_index}]: construction_mode=asset-plus-patches but no matched_asset_id`, 'error');
    }
    if (step.construction_mode === 'inline-recipe' && !step.inline_recipe) {
      pushIssue(issues, sid, 'V14', `Step[${step.step_index}]: construction_mode=inline-recipe but no inline_recipe`, 'error');
    }
  }

  // V15: test_points non-empty
  if (!scenario.test_points || scenario.test_points.length === 0) {
    pushIssue(issues, sid, 'V15', 'test_points must not be empty', 'error');
  } else {
    for (const tp of scenario.test_points) {
      if (!tp.description?.trim() || tp.description.includes('(AI')) {
        pushIssue(issues, sid, 'V15', 'test_point has placeholder description', 'error');
      }
    }
  }

  // V18: reconstruction status
  for (const step of scenario.steps) {
    if (step.reconstruction && step.reconstruction.status === 'conflict') {
      pushIssue(issues, sid, 'V18', `Step[${step.step_index}]: reconstruction status is 'conflict' — patches do not reconstruct the original step`, 'error');
    }
    if (step.reconstruction && step.reconstruction.status === 'unexplained-difference') {
      pushIssue(issues, sid, 'V18', `Step[${step.step_index}]: reconstruction has ${step.reconstruction.unexplained_differences.length} unexplained differences`, 'warning');
    }
  }

  // V19: maturity check
  if (scenario.source_cases.length === 1 && scenario.maturity !== 'provisional') {
    pushIssue(issues, sid, 'V19', `single source_case but maturity='${scenario.maturity}' — should be 'provisional'`, 'warning');
  }

  // V20: duplicate pattern_signature
  const sigScenarios = allPatternSigs.get(scenario.pattern_signature) ?? [];
  if (sigScenarios.length > 1) {
    pushIssue(issues, sid, 'V20', `pattern_signature '${scenario.pattern_signature}' shared by ${sigScenarios.length} scenarios: ${sigScenarios.join(', ')}`, 'error');
  }
}

// ─── Layer 3: Reconstruction gate ─────────────────────────

function runReconstructionGate(
  scenario: AnalysisDraftScenario,
  caseData: CaseDataFile,
  issues: ValidationIssue[],
): void {
  for (const step of scenario.steps) {
    if (step.construction_mode !== 'asset-plus-patches' || !step.matched_asset_id) continue;
    const caseStep = findCaseStep(caseData, scenario, step.step_index);
    if (!caseStep) continue;

    // Get asset full_json
    const asset = caseData.step_assets.find((a) => a.asset_id === step.matched_asset_id);
    if (!asset?.full_json) {
      pushIssue(issues, scenario.scenario_id, 'RG', `Step[${step.step_index}]: asset full_json not available — cannot run reconstruction`, 'warning');
      continue;
    }

    // Apply patches to a deep clone of the asset's components
    const reconstructed = applyPatches(deepClone(asset.full_json), step.patches);

    // Get original step components from case data
    const original = caseStep.components;

    // Compare
    const result = compareReconstructed(reconstructed, original);
    step.reconstruction = result;

    if (result.status === 'conflict') {
      pushIssue(issues, scenario.scenario_id, 'RG', `Step[${step.step_index}]: reconstruction conflict — ${result.unexplained_differences.length} differences`, 'error');
    } else if (result.status === 'unexplained-difference') {
      pushIssue(issues, scenario.scenario_id, 'RG', `Step[${step.step_index}]: ${result.unexplained_differences.length} unexplained differences (coverage: ${(result.total_field_coverage * 100).toFixed(0)}%)`, 'warning');
    }
  }
}
