#!/usr/bin/env bun
/**
 * scenario-core.ts  (v2.0)
 * 共享类型定义 + 工具函数 + 字段级补丁引擎 + 重建引擎 + 变量图 + 多维匹配
 *
 * 所有其他脚本均从此文件导入类型与函数。
 */

import { execSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';

// ════════════════════════════════════════════════════════════
//  Section 1: Basic Utilities
// ════════════════════════════════════════════════════════════

export type JsonRecord = Record<string, unknown>;

export function isRecord(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

export function asNullableString(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function canonicalJson(obj: unknown): string {
  if (obj == null) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(obj as JsonRecord).sort();
  return `{${keys.map((k) => `"${k}":${canonicalJson((obj as JsonRecord)[k])}`).join(',')}}`;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// ════════════════════════════════════════════════════════════
//  Section 2: Core Type Definitions
// ════════════════════════════════════════════════════════════

// ─── Case parsing types ─────────────────────────────────────

export interface CaseBasicInfo {
  case_id: string;
  case_name: string;
  case_description: string;
  product_name: string;
  product_id: string;
  site_name: string;
  site_id: string;
  site_version: string;
  based_on_baseline_version: string | null;
  exported_at: string | null;
  handler: string;
  designer: string;
  test_steps_description: string;
  expected_result: string;
  result: string;
}

export interface CaseComponent {
  aw_alias: string;
  is_commented: boolean;
  is_old_aw: boolean;
  aw_step: number;
  option_parameter: JsonRecord;
}

export interface CaseStep {
  case_step: string;
  step_memo: string | null;
  components: CaseComponent[];
  step_index: number;
}

export interface ParsedCase {
  case_id: string;
  case_name: string;
  basic_info: CaseBasicInfo;
  steps: CaseStep[];
  source_file: string;
  source_path: string;
  source_hash: string;
}

// ─── Step fingerprint ───────────────────────────────────────

export interface StepFingerprint {
  step_name: string;
  component_sequence: string[];
  interface_template: string | null;
  interface_endpoint: string | null;
  variable_names: string[];
  soap_field_paths: string[];
  field_to_var: Record<string, string>;
  field_to_literal: Record<string, string>;
  fingerprint_hash: string;
}

// ─── Step asset types ───────────────────────────────────────

export type AssetSourceKind = 'api' | 'dir' | 'gbrain-source-path';

export interface AssetSource {
  source_kind: AssetSourceKind;
  source_file: string;
  source_path: string | null;
}

export interface StepAssetJson {
  asset_id: string;
  name: string;
  interface_template: string | null;
  component_sequence: string[];
  components: { aw_alias: string; option_parameter: JsonRecord }[];
  vars: Record<string, string>;
  parameter_meta: Record<string, {
    is_open: boolean;
    description: string;
    required: boolean;
    default_value: string;
  }>;
  source: AssetSource;
}

// ─── Interface fields ───────────────────────────────────────

export interface InterfaceElement {
  name: string;
  path: string;
  type: string;
  description: string;
}

export interface InterfaceFieldsFile {
  generated_at: string;
  interface_count: number;
  interface_fields: Record<string, { elements: InterfaceElement[] }>;
  field_mapping: Record<string, string>;
}

// ─── Field tree & value classification ──────────────────────

export type FieldTree = Map<string, string>;

export type SpecialValue = 'nosend' | 'nocare' | 'norecv';

export interface FieldTreeEntry {
  path: string;
  value: string;
  is_variable_ref: boolean;
  variable_name: string | null;
  is_special_value: SpecialValue | null;
  is_expression: boolean;
}

// ─── Patch operation types ──────────────────────────────────

export type PatchOperation =
  | 'set-variable'
  | 'remove-variable'
  | 'add-field'
  | 'replace-field'
  | 'remove-field'
  | 'remove-field-override'
  | 'set-nosend'
  | 'set-nocare'
  | 'set-norecv'
  | 'runtime-bind'
  | 'expression-bind'
  | 'replace-request'
  | 'add-component'
  | 'remove-component'
  | 'version-drift';

export type EvidenceProvenance = 'declared' | 'observed' | 'documented' | 'inferred';
export type PatchConfidence = 'confirmed' | 'inferred' | 'unresolved';

export interface ScriptPatchItem {
  step_index: number;
  component: string;
  field_path: string;
  field_name: string;
  operation: PatchOperation;
  asset_value: string | null;
  case_value: string | null;
  effective_runtime_value: string | null;
  auto_detected: boolean;
  unresolved_question: string | null;
}

export interface FieldPatch {
  step_index: number;
  component: string;
  field_path: string;
  field_name: string;
  operation: PatchOperation;
  asset_value: string | null;
  case_value: string | null;
  effective_runtime_value: string | null;
  field_description: string;
  reason: string;
  evidence_sources: EvidenceProvenance[];
  confidence: PatchConfidence;
  required_for_execution: boolean;
  unresolved_question: string | null;
}

// ─── Variable flow graph ────────────────────────────────────

export type ProducerType =
  | 'table-set-var'
  | 'soap-rvars'
  | 'db-query-output'
  | 'shell-execute'
  | 'implicit-component'
  | 'external-input'
  | 'unresolved';

export interface VariableFlowNode {
  variable: string;
  step_index: number;
  role: 'producer' | 'consumer';
  producer_type?: ProducerType;
  consumer_location?: string;
  evidence: string;
  confidence: PatchConfidence;
}

export interface VariableDependency {
  from_step: number;
  to_step: number;
  variable: string;
  producer_type: ProducerType;
  consumer_location: string;
  evidence: string;
  confidence: PatchConfidence;
}

export interface VariableGraph {
  nodes: VariableFlowNode[];
  dependencies: VariableDependency[];
  unresolved_variables: string[];
}

// ─── Match types ────────────────────────────────────────────

export type MatchKind = 'exact' | 'semantic' | 'reusable-base' | 'partial' | 'ambiguous' | 'none';

export interface MatchScoreBreakdown {
  overall: number;
  interface_template: number;
  component_structure: number;
  request_structure: number;
  request_values: number;
  response_structure: number;
  variable_behavior: number;
  top1_top2_gap: number;
}

export interface StepMatchResult {
  step_index: number;
  step_name: string;
  matched_asset_id: string | null;
  matched_asset_name: string | null;
  matched_asset_slug: string | null;
  match_status: MatchKind;
  score: number;
  score_breakdown: MatchScoreBreakdown | null;
  candidates: {
    asset_id: string;
    asset_name: string;
    score: number;
    score_breakdown: MatchScoreBreakdown;
  }[];
  match_reason: string;
}

// ─── Construction mode & inline recipe ──────────────────────

export type ConstructionMode = 'asset-plus-patches' | 'inline-recipe' | 'external-source' | 'manual-required';

export interface InlineRecipeComponent {
  aw_alias: string;
  option_parameter: JsonRecord;
}

export interface InlineRecipe {
  components: InlineRecipeComponent[];
  variable_inputs: string[];
  variable_outputs: string[];
  description: string;
}

// ─── Reconstruction ─────────────────────────────────────────

export interface ReconstructionDiff {
  field_path: string;
  reconstructed_value: string | null;
  original_value: string | null;
  possible_reason: string;
}

export interface ReconstructionResult {
  status: 'exact' | 'semantic-equivalent' | 'unexplained-difference' | 'conflict' | 'not-applicable';
  key_field_coverage: number;
  total_field_coverage: number;
  unexplained_differences: ReconstructionDiff[];
}

// ─── Scenario maturity & business entity ────────────────────

export type ScenarioMaturity = 'provisional' | 'stable';

export interface BusinessEntity {
  entity: string;
  relation: string;
  created_by: string;
  modified_by: string;
  evidence_type: EvidenceProvenance;
}

// ─── Draft scenario types ───────────────────────────────────

export interface OperationVariant {
  step_index: number;
  interface_template: string;
  op_type: string;
  role: 'core' | 'prepare';
  construction_mode: ConstructionMode;
  matched_asset_id: string | null;
  matched_asset_slug: string | null;
  match_kind: MatchKind;
  match_reason: string;
  inline_recipe: InlineRecipe | null;
}

export interface ParameterVariant {
  component: string;
  field_path: string;
  operation: PatchOperation;
  asset_value: string | null;
  case_value: string | null;
  source_case: string;
  confidence: PatchConfidence;
}

export interface AnalysisDraftScenario {
  scenario_id: string;
  scenario_name: string;
  capability: string;
  pattern_signature: string;
  intent_signature: string;
  variant_signature: string;
  parameter_signature: string;
  maturity: ScenarioMaturity;
  source_cases: string[];
  preparation_operations: string[];
  operation_variants: OperationVariant[];
  parameter_variants: ParameterVariant[];
  test_points: {
    description: string;
    verification_method: string;
    expected_result: string;
  }[];
  business_entities: BusinessEntity[];
  variable_dependencies: VariableDependency[];
  steps: {
    step_index: number;
    step_name: string;
    construction_mode: ConstructionMode;
    matched_asset_id: string | null;
    matched_asset_slug: string | null;
    match_kind: MatchKind;
    match_reason: string;
    patches: FieldPatch[];
    inline_recipe: InlineRecipe | null;
    reconstruction: ReconstructionResult | null;
    variable_inputs: string[];
    variable_outputs: string[];
  }[];
  unresolved_questions: string[];
}

export interface AnalysisDraft {
  version: string;
  generated_at: string;
  source_case_data: string;
  scenarios: AnalysisDraftScenario[];
}

// ─── Scenario plan page ─────────────────────────────────────

export interface ScenarioPlanPage {
  title: string;
  description: string;
  capability: string;
  pattern_signature: string;
  intent_signature: string;
  variant_signature: string;
  parameter_signature: string;
  maturity: ScenarioMaturity;
  source_cases: string[];
  preparation_operations: string[];
  analysis_data_slug: string;
}

// ─── Case data file (extract output) ────────────────────────

export interface CaseDataStep {
  step_index: number;
  step_name: string;
  step_memo: string | null;
  components: CaseComponent[];
  fingerprint: StepFingerprint;
  match: StepMatchResult;
  script_patches: ScriptPatchItem[];
  field_trees: Record<string, FieldTreeEntry[]>;
  variable_inputs: string[];
  variable_outputs: string[];
}

export interface CaseDataCase {
  case_id: string;
  basic_info: CaseBasicInfo;
  steps: CaseDataStep[];
  source_file: string;
  source_hash: string;
}

export interface CaseDataFile {
  extraction_meta: {
    extracted_at: string;
    case_count: number;
    step_asset_count: number;
    existing_scenario_count: number;
    interface_doc_provided: boolean;
    common_structure_doc_provided: boolean;
    asset_source: AssetSourceKind;
    asset_load_warning: string | null;
  };
  cases: CaseDataCase[];
  step_assets: {
    asset_id: string;
    name: string;
    slug: string | null;
    interface_template: string | null;
    component_sequence: string[];
    open_parameter_names: string[];
    vars: Record<string, string>;
    parameter_meta: Record<string, {
      is_open: boolean;
      description: string;
      required: boolean;
      default_value: string;
    }>;
    source_kind: AssetSourceKind;
    source_path: string | null;
    full_json: JsonRecord | null;
  }[];
  variable_graph: VariableGraph;
  interface_catalog: { interface: string; element_count: number }[];
  interface_fields_file: string | null;
  existing_scenarios: { slug: string; title: string }[];
}

// ─── Asset fetch manifest ───────────────────────────────────

export interface AssetManifestEntry {
  asset_id: string;
  asset_name: string;
  slug: string | null;
  local_path: string | null;
  content_hash: string | null;
  fetched: boolean;
  fetch_error: string | null;
}

export interface AssetFetchManifest {
  generated_at: string;
  api_url: string;
  total_assets: number;
  fetched: number;
  cached: number;
  failed: number;
  entries: AssetManifestEntry[];
}

// ─── Write executor types (apply-scenario.ts) ──────────────

export interface WritablePage {
  slug: string;
  content: string;
  content_sha256: string;
  merge_mode: 'create' | 'extend' | 'overwrite';
}

export interface ScenarioPlanLink {
  from_slug: string;
  to_slug: string;
  link_type: string;
}

export interface ScenarioPlanTimeline {
  slug: string;
  date: string;
  entry: string;
  idempotency_marker: string;
}

export interface ScenarioPlanScenario {
  scenario_slug: string;
  scenario_plan_slug: string;
  analysis_data_slug: string;
}

export interface ScenarioPlan {
  schema_version: string;
  plan_integrity: {
    authorized: boolean;
    authorization_method: string;
    authorized_payload_sha256: string;
    payload_sha256: string;
    dry_run_payload_sha256: string;
  };
  apply_contract: {
    executor: string;
    runtime_policy: {
      apply_attempts_per_user_authorization: number;
      on_failure: string;
      agent_may_retry_automatically: boolean;
    };
  } | null;
  scenarios: ScenarioPlanScenario[];
  pages: WritablePage[];
  timelines: ScenarioPlanTimeline[];
  links: ScenarioPlanLink[];
}

export function planPayloadSha256(plan: { pages: WritablePage[]; timelines: ScenarioPlanTimeline[]; links: ScenarioPlanLink[]; scenarios: ScenarioPlanScenario[] }): string {
  return sha256(canonicalJson({
    pages: plan.pages.map((p) => ({ slug: p.slug, sha: p.content_sha256 })),
    timelines: plan.timelines.map((t) => ({ slug: t.slug, marker: t.idempotency_marker })),
    links: plan.links.map((l) => ({ from: l.from_slug, to: l.to_slug, type: l.link_type })),
    scenarios: plan.scenarios.map((s) => ({ slug: s.scenario_slug })),
  }));
}

// ════════════════════════════════════════════════════════════
//  Section 3: Slug Utilities
// ════════════════════════════════════════════════════════════

export function siteKeyFromId(siteId: string, siteName: string): string {
  const raw = (siteId || siteName || '').trim();
  if (!raw) return 'unknown';
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

export function scenarioSlug(siteKey: string, scenarioId: string): string {
  return `cbs/scenarios/${siteKey}/${scenarioId}`;
}

export function analysisDataSlug(siteKey: string, scenarioId: string): string {
  return `cbs/scenarios/${siteKey}/${scenarioId}/analysis-data`;
}

export function scenarioPlanSlug(siteKey: string, scenarioId: string): string {
  return `cbs/scenarios/${siteKey}/${scenarioId}/scenario-plan`;
}

export function normalizeTemplateName(raw: string): string {
  return raw.trim().replace(/\.json$/i, '');
}

export function parseVarsString(varsStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!varsStr) return result;
  for (const part of varsStr.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (name) result[name] = value;
    }
  }
  return result;
}

// ════════════════════════════════════════════════════════════
//  Section 4: GBrain CLI
// ════════════════════════════════════════════════════════════

export interface GbrainListItem {
  slug: string;
  title: string;
}

export interface GbrainGetResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

export function execSyncSafe(cmd: string): SpawnSyncReturns<string> {
  try {
    const result = execSync(cmd, {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { status: 0, stdout: result, stderr: '', pid: 0, signal: null } as unknown as SpawnSyncReturns<string>;
  } catch (e: any) {
    return {
      status: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(e),
      pid: e.pid ?? 0,
      signal: e.signal ?? null,
    } as unknown as SpawnSyncReturns<string>;
  }
}

export function gbrainList(gbrain: string, tag: string): { items: GbrainListItem[] } {
  const r = execSyncSafe(`"${gbrain}" list --tag "${tag}"`);
  const items: GbrainListItem[] = [];
  const stdout = r.stdout || '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^- \[(.+?)\]\s*(.*)$/);
    if (m) {
      items.push({ slug: m[1], title: m[2] || m[1] });
    }
  }
  return { items };
}

export function gbrainGet(gbrain: string, slug: string): GbrainGetResult {
  const r = execSyncSafe(`"${gbrain}" get "${slug}"`);
  return { success: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function gbrainPut(gbrain: string, slug: string, content: string): GbrainGetResult {
  const escaped = content.replace(/'/g, "'\\''");
  const r = execSyncSafe(`echo '${escaped}' | "${gbrain}" put "${slug}"`);
  return { success: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function gbrainLink(gbrain: string, sourceSlug: string, targetSlug: string, linkType: string): GbrainGetResult {
  const r = execSyncSafe(`"${gbrain}" link "${sourceSlug}" "${targetSlug}" "${linkType}"`);
  return { success: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function gbrainTimelineAdd(gbrain: string, slug: string, timestamp: string, content: string): GbrainGetResult {
  const escaped = content.replace(/'/g, "'\\''");
  const r = execSyncSafe(`"${gbrain}" timeline-add "${slug}" "${timestamp}" '${escaped}'`);
  return { success: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function parseGbrainGetOutput(stdout: string): { frontmatter: JsonRecord; body: string } {
  const fmMatch = stdout.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return { frontmatter: {}, body: stdout };
  const fmRaw = fmMatch[1];
  const body = fmMatch[2];
  const frontmatter: JsonRecord = {};
  for (const line of fmRaw.split('\n')) {
    const m = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (m) {
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      frontmatter[m[1]] = val;
    }
  }
  return { frontmatter, body };
}

// ════════════════════════════════════════════════════════════
//  Section 5: Field Tree & Value Classification
// ════════════════════════════════════════════════════════════

const SPECIAL_VALUES = new Set(['nosend', 'nocare', 'norecv']);

export function isVariableRef(val: string): boolean {
  return val.includes('${') && val.includes('}');
}

export function extractVariableName(val: string): string | null {
  const m = val.match(/\$\{([^}]+)\}/);
  return m ? m[1] : null;
}

export function isExpression(val: string): boolean {
  return val.includes('${G.') || /\$\{[^}]*\([^)]*\)[^}]*\}/.test(val);
}

export function detectSpecialValue(val: string): SpecialValue | null {
  const trimmed = val.trim().toLowerCase();
  if (SPECIAL_VALUES.has(trimmed)) return trimmed as SpecialValue;
  return null;
}

export function flattenValue(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return JSON.stringify(val);
}

export function buildFieldTree(obj: unknown, prefix: string = ''): FieldTree {
  const tree: FieldTree = new Map();
  function walk(val: unknown, path: string) {
    if (val == null) {
      if (path) tree.set(path, '');
      return;
    }
    if (typeof val === 'object' && !Array.isArray(val)) {
      const rec = val as JsonRecord;
      for (const key of Object.keys(rec)) {
        walk(rec[key], path ? `${path}.${key}` : key);
      }
    } else if (Array.isArray(val)) {
      val.forEach((item, idx) => walk(item, `${path}[${idx}]`));
    } else {
      tree.set(path, flattenValue(val));
    }
  }
  walk(obj, prefix);
  return tree;
}

export function buildFieldTreeEntries(obj: unknown, prefix: string = ''): FieldTreeEntry[] {
  const tree = buildFieldTree(obj, prefix);
  const entries: FieldTreeEntry[] = [];
  for (const [path, value] of tree) {
    entries.push({
      path,
      value,
      is_variable_ref: isVariableRef(value),
      variable_name: extractVariableName(value),
      is_special_value: detectSpecialValue(value),
      is_expression: isExpression(value),
    });
  }
  return entries;
}

// ════════════════════════════════════════════════════════════
//  Section 6: Field-Level Patch Computation
// ════════════════════════════════════════════════════════════

const SETUP_INTERFACE_TEMPLATES = new Set([
  'CreateCustomer', 'CreateAccount', 'Login', 'SystemParameter',
]);

const SKIP_OPTION_KEYS = new Set(['rTpl', 'url', 'iTimeOut', 'rHeader']);

function classifyOperation(
  caseVal: string | null,
  assetVal: string | null,
  isInCase: boolean,
  isInAsset: boolean,
): PatchOperation {
  if (!isInCase && isInAsset) return 'remove-field';
  if (isInCase && !isInAsset) return 'add-field';
  if (caseVal === assetVal) return 'replace-field'; // no-op, won't be recorded
  if (caseVal != null) {
    const special = detectSpecialValue(caseVal);
    if (special === 'nosend') return 'set-nosend';
    if (special === 'nocare') return 'set-nocare';
    if (special === 'norecv') return 'set-norecv';
    if (isVariableRef(caseVal)) return 'runtime-bind';
    if (isExpression(caseVal)) return 'expression-bind';
    if (caseVal === '' || caseVal === 'null') return 'remove-field-override';
  }
  return 'replace-field';
}

function pushOptionParamPatches(
  stepIndex: number,
  componentAlias: string,
  caseParams: JsonRecord,
  assetParams: JsonRecord | undefined,
  patches: ScriptPatchItem[],
): void {
  const assetP = assetParams ?? {};
  const allKeys = new Set([...Object.keys(caseParams), ...Object.keys(assetP)]);
  for (const key of allKeys) {
    if (SKIP_OPTION_KEYS.has(key)) continue;
    const inCase = key in caseParams;
    const inAsset = key in assetP;
    const caseRaw = inCase ? caseParams[key] : null;
    const assetRaw = inAsset ? assetP[key] : null;
    const caseVal = inCase ? flattenValue(caseRaw) : null;
    const assetVal = inAsset ? flattenValue(assetRaw) : null;
    if (inCase && inAsset && caseVal === assetVal) continue;
    const op = classifyOperation(caseVal, assetVal, inCase, inAsset);
    if (op === 'replace-field' && caseVal === assetVal) continue;
    let effectiveRuntime: string | null = caseVal;
    if (op === 'remove-field') effectiveRuntime = null;
    if (op === 'remove-field-override') effectiveRuntime = '';
    patches.push({
      step_index: stepIndex,
      component: componentAlias,
      field_path: key,
      field_name: key,
      operation: op,
      asset_value: assetVal,
      case_value: caseVal,
      effective_runtime_value: effectiveRuntime,
      auto_detected: true,
      unresolved_question: null,
    });
  }
}

function pushNestedFieldPatches(
  stepIndex: number,
  componentAlias: string,
  paramKey: string,
  caseObj: unknown,
  assetObj: unknown,
  patches: ScriptPatchItem[],
): void {
  const caseTree = buildFieldTree(caseObj);
  const assetTree = buildFieldTree(assetObj);
  const allPaths = new Set([...caseTree.keys(), ...assetTree.keys()]);
  for (const path of allPaths) {
    const inCase = caseTree.has(path);
    const inAsset = assetTree.has(path);
    const caseVal = inCase ? caseTree.get(path)! : null;
    const assetVal = inAsset ? assetTree.get(path)! : null;
    if (inCase && inAsset && caseVal === assetVal) continue;
    const op = classifyOperation(caseVal, assetVal, inCase, inAsset);
    if (op === 'replace-field' && caseVal === assetVal) continue;
    let effectiveRuntime: string | null = caseVal;
    if (op === 'remove-field') effectiveRuntime = null;
    if (op === 'remove-field-override') effectiveRuntime = '';
    const fieldPath = `${paramKey}.${path}`;
    patches.push({
      step_index: stepIndex,
      component: componentAlias,
      field_path: fieldPath,
      field_name: path.split('.').pop() || path,
      operation: op,
      asset_value: assetVal,
      case_value: caseVal,
      effective_runtime_value: effectiveRuntime,
      auto_detected: true,
      unresolved_question: null,
    });
  }
}

export function computeFieldPatches(
  step: CaseStep,
  asset: StepAssetJson | null,
): ScriptPatchItem[] {
  const patches: ScriptPatchItem[] = [];
  const stepIdx = step.step_index;
  const assetComps = asset?.components ?? [];
  const assetCompMap = new Map<string, JsonRecord>();
  for (const ac of assetComps) assetCompMap.set(ac.aw_alias, ac.option_parameter);

  // Component-level diff: check for add-component / remove-component
  const caseAliases = step.components.map((c) => c.aw_alias);
  const assetAliases = assetComps.map((c) => c.aw_alias);
  for (const alias of caseAliases) {
    if (!assetAliases.includes(alias)) {
      patches.push({
        step_index: stepIdx,
        component: alias,
        field_path: '',
        field_name: '',
        operation: 'add-component',
        asset_value: null,
        case_value: null,
        effective_runtime_value: null,
        auto_detected: true,
        unresolved_question: 'Component exists in case but not in asset. AI should determine if this is a new component or a version difference.',
      });
    }
  }
  for (const alias of assetAliases) {
    if (!caseAliases.includes(alias)) {
      patches.push({
        step_index: stepIdx,
        component: alias,
        field_path: '',
        field_name: '',
        operation: 'remove-component',
        asset_value: null,
        case_value: null,
        effective_runtime_value: null,
        auto_detected: true,
        unresolved_question: 'Component exists in asset but not in case. AI should determine if this is intentional removal or version difference.',
      });
    }
  }

  // Per-component field-level diff
  for (const comp of step.components) {
    const alias = comp.aw_alias;
    const assetParams = assetCompMap.get(alias);
    const caseParams = comp.option_parameter;

    if (alias === 'TableSetVar') {
      const caseVars = parseVarsString(asString(caseParams.vars));
      const assetVars = assetParams ? parseVarsString(asString(assetParams.vars)) : {};
      const allVarNames = new Set([...Object.keys(caseVars), ...Object.keys(assetVars)]);
      for (const varName of allVarNames) {
        const inCase = varName in caseVars;
        const inAsset = varName in assetVars;
        const caseVal = inCase ? caseVars[varName] : null;
        const assetVal = inAsset ? assetVars[varName] : null;
        if (inCase && inAsset && caseVal === assetVal) continue;
        const op = inCase && !inAsset ? 'set-variable' : !inCase && inAsset ? 'remove-variable' : 'set-variable';
        patches.push({
          step_index: stepIdx,
          component: alias,
          field_path: `vars.${varName}`,
          field_name: varName,
          operation: op,
          asset_value: assetVal,
          case_value: caseVal,
          effective_runtime_value: caseVal,
          auto_detected: true,
          unresolved_question: null,
        });
      }
    } else if (alias === 'SoapClient') {
      // Nested field-level diff for rReq, rRsp, rVars
      for (const nestedKey of ['rReq', 'rRsp', 'rVars']) {
        const caseVal = caseParams[nestedKey];
        const assetVal = assetParams?.[nestedKey];
        if (caseVal != null || assetVal != null) {
          // Check for replace-request (root structure completely different)
          if (nestedKey === 'rReq' && caseVal != null && assetVal != null) {
            const caseRoots = isRecord(caseVal) ? Object.keys(caseVal) : [];
            const assetRoots = isRecord(assetVal) ? Object.keys(assetVal) : [];
            const overlap = caseRoots.filter((r) => assetRoots.includes(r));
            if (caseRoots.length > 0 && assetRoots.length > 0 && overlap.length === 0) {
              patches.push({
                step_index: stepIdx,
                component: alias,
                field_path: nestedKey,
                field_name: nestedKey,
                operation: 'replace-request',
                asset_value: flattenValue(assetVal),
                case_value: flattenValue(caseVal),
                effective_runtime_value: flattenValue(caseVal),
                auto_detected: true,
                unresolved_question: 'Root structure of rReq differs completely between case and asset. AI should confirm this is a different request type.',
              });
              continue;
            }
          }
          pushNestedFieldPatches(stepIdx, alias, nestedKey, caseVal, assetVal, patches);
        }
      }
      // Other SoapClient option_parameter keys (excluding nested ones handled above + skip keys)
      for (const key of Object.keys(caseParams)) {
        if (key === 'rReq' || key === 'rRsp' || key === 'rVars' || SKIP_OPTION_KEYS.has(key)) continue;
        const assetP = assetParams ?? {};
        if (!(key in assetP) || flattenValue(caseParams[key]) !== flattenValue(assetP[key])) {
          const inAsset = key in assetP;
          patches.push({
            step_index: stepIdx,
            component: alias,
            field_path: key,
            field_name: key,
            operation: inAsset ? 'replace-field' : 'add-field',
            asset_value: inAsset ? flattenValue(assetP[key]) : null,
            case_value: flattenValue(caseParams[key]),
            effective_runtime_value: flattenValue(caseParams[key]),
            auto_detected: true,
            unresolved_question: null,
          });
        }
      }
    } else if (alias === 'DataBaseQuery' || alias === 'DataBaseModify') {
      // Diff all option_parameter keys (sql, tableName, connection, vars, expectResult, etc.)
      pushOptionParamPatches(stepIdx, alias, caseParams, assetParams, patches);
    } else {
      // Generic fallback for any other component type
      pushOptionParamPatches(stepIdx, alias, caseParams, assetParams, patches);
    }
  }

  // Version drift heuristic: fields in asset not in case and not already flagged
  const caseFieldPaths = new Set(patches.filter((p) => p.operation !== 'add-field' && p.operation !== 'add-component').map((p) => `${p.component}.${p.field_path}`));
  for (const ac of assetComps) {
    const alias = ac.aw_alias;
    if (!caseAliases.includes(alias)) continue;
    if (alias === 'SoapClient') {
      for (const nestedKey of ['rReq', 'rRsp']) {
        const assetVal = ac.option_parameter[nestedKey];
        if (assetVal == null) continue;
        const tree = buildFieldTree(assetVal);
        for (const [path] of tree) {
          const fullKey = `${alias}.${nestedKey}.${path}`;
          if (!caseFieldPaths.has(fullKey)) {
            // Field exists in asset but not in case - could be version drift or intentional omission
            // Only flag if it's not already captured by remove-field
            const alreadyFlagged = patches.some((p) => p.component === alias && p.field_path === `${nestedKey}.${path}` && p.operation === 'remove-field');
            if (!alreadyFlagged) {
              patches.push({
                step_index: stepIdx,
                component: alias,
                field_path: `${nestedKey}.${path}`,
                field_name: path.split('.').pop() || path,
                operation: 'version-drift',
                asset_value: tree.get(path)!,
                case_value: null,
                effective_runtime_value: null,
                auto_detected: true,
                unresolved_question: `Field exists in asset ${nestedKey} but not in case rReq/rRsp. Could be version drift or intentional omission. AI should check interface doc.`,
              });
            }
          }
        }
      }
    }
  }

  return patches;
}

// ════════════════════════════════════════════════════════════
//  Section 7: Reconstruction Engine
// ════════════════════════════════════════════════════════════

function setNestedValue(obj: JsonRecord, path: string, value: string): void {
  const parts = path.split('.');
  let current: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current == null || typeof current !== 'object' || Array.isArray(current)) return;
    const rec = current as JsonRecord;
    if (rec[part] == null || typeof rec[part] !== 'object') {
      rec[part] = {};
    }
    current = rec[part];
  }
  const lastPart = parts[parts.length - 1];
  if (current != null && typeof current === 'object' && !Array.isArray(current)) {
    (current as JsonRecord)[lastPart] = value;
  }
}

function removeNestedKey(obj: JsonRecord, path: string): void {
  const parts = path.split('.');
  let current: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current == null || typeof current !== 'object' || Array.isArray(current)) return;
    current = (current as JsonRecord)[parts[i]];
  }
  if (current != null && typeof current === 'object' && !Array.isArray(current)) {
    delete (current as JsonRecord)[parts[parts.length - 1]];
  }
}

export function applyPatches(
  assetComponents: { aw_alias: string; option_parameter: JsonRecord }[],
  patches: FieldPatch[],
): { aw_alias: string; option_parameter: JsonRecord }[] {
  const reconstructed = deepClone(assetComponents);
  for (const patch of patches) {
    const comp = reconstructed.find((c) => c.aw_alias === patch.component);
    if (!comp) {
      // add-component: add new component
      if (patch.operation === 'add-component') {
        reconstructed.push({ aw_alias: patch.component, option_parameter: {} });
      }
      continue;
    }
    const params = comp.option_parameter;
    switch (patch.operation) {
      case 'set-variable':
      case 'replace-field': {
        if (patch.field_path.includes('.')) {
          setNestedValue(params, patch.field_path, patch.case_value ?? '');
        } else {
          params[patch.field_path] = patch.case_value ?? '';
        }
        break;
      }
      case 'add-field': {
        if (patch.field_path.includes('.')) {
          setNestedValue(params, patch.field_path, patch.case_value ?? '');
        } else {
          params[patch.field_path] = patch.case_value ?? '';
        }
        break;
      }
      case 'remove-field':
      case 'remove-field-override': {
        if (patch.field_path.includes('.')) {
          removeNestedKey(params, patch.field_path);
        } else {
          delete params[patch.field_path];
        }
        break;
      }
      case 'set-nosend':
      case 'set-nocare':
      case 'set-norecv': {
        const val = patch.operation.replace('set-', '');
        if (patch.field_path.includes('.')) {
          setNestedValue(params, patch.field_path, val);
        } else {
          params[patch.field_path] = val;
        }
        break;
      }
      case 'runtime-bind':
      case 'expression-bind': {
        if (patch.field_path.includes('.')) {
          setNestedValue(params, patch.field_path, patch.case_value ?? '');
        } else {
          params[patch.field_path] = patch.case_value ?? '';
        }
        break;
      }
      case 'replace-request': {
        params[patch.field_path] = JSON.parse(patch.case_value ?? '{}');
        break;
      }
      case 'remove-component': {
        const idx = reconstructed.findIndex((c) => c.aw_alias === patch.component);
        if (idx >= 0) reconstructed.splice(idx, 1);
        break;
      }
      case 'version-drift':
        // Informational only, no patch application
        break;
    }
  }
  return reconstructed;
}

function normalizeForCompare(obj: unknown): string {
  if (obj == null) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(normalizeForCompare).join(',')}]`;
  const rec = obj as JsonRecord;
  const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
  return `{${keys.map((k) => `"${k}":${normalizeForCompare(rec[k])}`).join(',')}}`;
}

export function compareReconstructed(
  reconstructed: { aw_alias: string; option_parameter: JsonRecord }[],
  original: { aw_alias: string; option_parameter: JsonRecord }[],
): ReconstructionResult {
  const diffs: ReconstructionDiff[] = [];
  let totalFields = 0;
  let matchedFields = 0;

  const origMap = new Map(original.map((c) => [c.aw_alias, c.option_parameter]));
  for (const comp of reconstructed) {
    const origParams = origMap.get(comp.aw_alias);
    if (!origParams) {
      diffs.push({
        field_path: comp.aw_alias,
        reconstructed_value: JSON.stringify(comp.option_parameter),
        original_value: null,
        possible_reason: 'Component in reconstruction but not in original',
      });
      continue;
    }
    const reconTree = buildFieldTree(comp.option_parameter);
    const origTree = buildFieldTree(origParams);
    const allPaths = new Set([...reconTree.keys(), ...origTree.keys()]);
    for (const path of allPaths) {
      totalFields++;
      const reconVal = reconTree.get(path) ?? null;
      const origVal = origTree.get(path) ?? null;
      if (reconVal === origVal) {
        matchedFields++;
      } else {
        diffs.push({
          field_path: `${comp.aw_alias}.${path}`,
          reconstructed_value: reconVal,
          original_value: origVal,
          possible_reason: 'Value mismatch after patch application',
        });
      }
    }
  }
  // Check for components in original but not reconstructed
  for (const comp of original) {
    if (!reconstructed.find((c) => c.aw_alias === comp.aw_alias)) {
      diffs.push({
        field_path: comp.aw_alias,
        reconstructed_value: null,
        original_value: JSON.stringify(comp.option_parameter),
        possible_reason: 'Component in original but not in reconstruction',
      });
    }
  }

  const coverage = totalFields > 0 ? matchedFields / totalFields : 1;
  const status: ReconstructionResult['status'] =
    diffs.length === 0 ? 'exact' :
    coverage >= 0.95 ? 'semantic-equivalent' :
    coverage >= 0.8 ? 'unexplained-difference' : 'conflict';

  return {
    status,
    key_field_coverage: coverage,
    total_field_coverage: coverage,
    unexplained_differences: diffs,
  };
}

// ════════════════════════════════════════════════════════════
//  Section 8: Variable Flow Graph
// ════════════════════════════════════════════════════════════

export function detectProducers(step: CaseStep): VariableFlowNode[] {
  const nodes: VariableFlowNode[] = [];
  const idx = step.step_index;
  for (const comp of step.components) {
    if (comp.aw_alias === 'TableSetVar') {
      const vars = parseVarsString(asString(comp.option_parameter.vars));
      for (const [name, value] of Object.entries(vars)) {
        nodes.push({
          variable: name, step_index: idx, role: 'producer',
          producer_type: 'table-set-var', evidence: `TableSetVar.vars[${name}=${value}]`, confidence: 'confirmed',
        });
      }
    }
    if (comp.aw_alias === 'SoapClient') {
      const rVars = comp.option_parameter.rVars;
      if (rVars != null) {
        const tree = buildFieldTree(rVars);
        for (const [path, value] of tree) {
          const varName = value.trim();
          if (varName) {
            nodes.push({
              variable: varName, step_index: idx, role: 'producer',
              producer_type: 'soap-rvars', evidence: `SoapClient.rVars.${path}=${varName}`, confidence: 'confirmed',
            });
          }
        }
      }
    }
    if (comp.aw_alias === 'DataBaseQuery' || comp.aw_alias === 'DataBaseModify') {
      const varsStr = asString(comp.option_parameter.vars);
      if (varsStr) {
        for (const part of varsStr.split(';')) {
          const pipeIdx = part.indexOf('|');
          if (pipeIdx > 0) {
            const alias = part.slice(pipeIdx + 1).trim();
            if (alias) {
              nodes.push({
                variable: alias, step_index: idx, role: 'producer',
                producer_type: 'db-query-output', evidence: `${comp.aw_alias}.vars[${part}]`, confidence: 'confirmed',
              });
            }
          }
        }
      }
    }
    if (comp.aw_alias === 'ShellExecute') {
      const shellChecks = comp.option_parameter.shellChecks;
      if (shellChecks != null) {
        const tree = buildFieldTree(shellChecks);
        for (const [path, value] of tree) {
          const varMatch = value.match(/(?:set|export)\s+(\w+)/);
          if (varMatch) {
            nodes.push({
              variable: varMatch[1], step_index: idx, role: 'producer',
              producer_type: 'shell-execute', evidence: `ShellExecute.shellChecks.${path}`, confidence: 'inferred',
            });
          }
        }
      }
    }
    // Implicit component output (SaveUserInfo, etc.)
    const knownProducers = new Set(['TableSetVar', 'SoapClient', 'DataBaseQuery', 'DataBaseModify', 'ShellExecute']);
    if (!knownProducers.has(comp.aw_alias) && !comp.aw_alias.startsWith('#')) {
      // Extract any ${} references as potential implicit outputs
      const allVals = JSON.stringify(comp.option_parameter);
      for (const m of allVals.matchAll(/\$\{([^}]+)\}/g)) {
        // These are consumers, not producers - but we mark the component as having implicit output
      }
      // Heuristic: if component name suggests saving (SaveUserInfo, SaveAccountInfo, etc.)
      if (/save|store|create/i.test(comp.aw_alias)) {
        nodes.push({
          variable: `__implicit__${comp.aw_alias}`, step_index: idx, role: 'producer',
          producer_type: 'implicit-component', evidence: `${comp.aw_alias} (implicit output - unresolved)`, confidence: 'unresolved',
        });
      }
    }
  }
  return nodes;
}

export function detectConsumers(step: CaseStep): VariableFlowNode[] {
  const nodes: VariableFlowNode[] = [];
  const idx = step.step_index;
  for (const comp of step.components) {
    const params = comp.option_parameter;
    // Walk all option_parameter values looking for ${...} references
    const flat = buildFieldTreeEntries(params);
    for (const entry of flat) {
      if (entry.is_variable_ref && entry.variable_name) {
        // Could be multiple variables in one value
        for (const m of entry.value.matchAll(/\$\{([^}]+)\}/g)) {
          nodes.push({
            variable: m[1], step_index: idx, role: 'consumer',
            consumer_location: `${comp.aw_alias}.${entry.path}`,
            evidence: `${comp.aw_alias}.${entry.path}=${entry.value}`, confidence: 'confirmed',
          });
        }
      }
    }
  }
  return nodes;
}

export function buildVariableGraph(steps: CaseStep[]): VariableGraph {
  const allNodes: VariableFlowNode[] = [];
  const producersByVar = new Map<string, VariableFlowNode[]>();
  const consumersByVar = new Map<string, VariableFlowNode[]>();

  for (const step of steps) {
    const producers = detectProducers(step);
    const consumers = detectConsumers(step);
    allNodes.push(...producers, ...consumers);
    for (const p of producers) {
      const arr = producersByVar.get(p.variable) ?? [];
      arr.push(p);
      producersByVar.set(p.variable, arr);
    }
    for (const c of consumers) {
      const arr = consumersByVar.get(c.variable) ?? [];
      arr.push(c);
      consumersByVar.set(c.variable, arr);
    }
  }

  // Build dependencies: for each consumer, find the closest preceding producer
  const dependencies: VariableDependency[] = [];
  const unresolved: string[] = [];
  for (const [varName, consumers] of consumersByVar) {
    const producers = producersByVar.get(varName);
    if (!producers || producers.length === 0) {
      // Check if it's an external input (starts with C_ or is a known constant prefix)
      if (!varName.startsWith('C_') && !varName.startsWith('__implicit__')) {
        unresolved.push(varName);
      }
      continue;
    }
    for (const consumer of consumers) {
      // Find the closest producer that comes before the consumer
      let bestProducer: VariableFlowNode | null = null;
      for (const producer of producers) {
        if (producer.step_index < consumer.step_index ||
            (producer.step_index === consumer.step_index)) {
          if (!bestProducer || producer.step_index > bestProducer.step_index) {
            bestProducer = producer;
          }
        }
      }
      if (bestProducer) {
        dependencies.push({
          from_step: bestProducer.step_index,
          to_step: consumer.step_index,
          variable: varName,
          producer_type: bestProducer.producer_type ?? 'unresolved',
          consumer_location: consumer.consumer_location ?? '',
          evidence: `${bestProducer.evidence} -> ${consumer.evidence}`,
          confidence: bestProducer.confidence === 'confirmed' && consumer.confidence === 'confirmed' ? 'confirmed' : 'inferred',
        });
      }
    }
  }

  return { nodes: allNodes, dependencies, unresolved_variables: [...new Set(unresolved)] };
}

// ════════════════════════════════════════════════════════════
//  Section 9: Multi-Dimensional Asset Matching
// ════════════════════════════════════════════════════════════

export function parseStepAssetJson(
  raw: JsonRecord,
  source: AssetSource,
): StepAssetJson {
  const step = isRecord(raw.step) ? raw.step : raw;
  const assetId = asString(step.id || raw.id);
  const name = asString(step.name || raw.name);
  const templateJson = isRecord(step.template_json) ? step.template_json : (isRecord(raw.template_json) ? raw.template_json : {});
  const componentsRaw = asArray(templateJson.components || templateJson.case_option || step.components);
  const components = componentsRaw
    .filter((c) => isRecord(c))
    .map((c) => {
      const comp = c as JsonRecord;
      return {
        aw_alias: asString(comp.aw_alias),
        option_parameter: isRecord(comp.option_parameter) ? comp.option_parameter : {},
      };
    });
  const componentSequence = components.map((c) => c.aw_alias);
  let interfaceTemplate: string | null = null;
  for (const c of components) {
    if (c.aw_alias === 'SoapClient') {
      const rTpl = asString(c.option_parameter.rTpl);
      if (rTpl) { interfaceTemplate = normalizeTemplateName(rTpl); break; }
    }
  }
  // Extract vars from TableSetVar
  const vars: Record<string, string> = {};
  for (const c of components) {
    if (c.aw_alias === 'TableSetVar') {
      Object.assign(vars, parseVarsString(asString(c.option_parameter.vars)));
    }
  }
  // Extract parameter_meta from template_json if available
  const parameterMeta = isRecord(templateJson.parameter_meta) ? templateJson.parameter_meta as Record<string, { is_open: boolean; description: string; required: boolean; default_value: string }> : {};
  return { asset_id: assetId, name, interface_template: interfaceTemplate, component_sequence: componentSequence, components, vars, parameter_meta: parameterMeta, source };
}

function compareFieldTrees(treeA: FieldTree, treeB: FieldTree): { structure: number; values: number } {
  const pathsA = new Set(treeA.keys());
  const pathsB = new Set(treeB.keys());
  const allPaths = new Set([...pathsA, ...pathsB]);
  const commonPaths = [...pathsA].filter((p) => pathsB.has(p));
  const structure = allPaths.size > 0 ? commonPaths.length / allPaths.size : 0;
  let valueMatches = 0;
  for (const p of commonPaths) {
    if (treeA.get(p) === treeB.get(p)) valueMatches++;
  }
  const values = commonPaths.length > 0 ? valueMatches / commonPaths.length : 0;
  return { structure, values };
}

export function computeMatchScore(
  caseStep: CaseStep,
  fingerprint: StepFingerprint,
  asset: StepAssetJson,
): MatchScoreBreakdown {
  // 1. Interface template match
  const tplScore = (fingerprint.interface_template && asset.interface_template &&
    fingerprint.interface_template.toLowerCase() === asset.interface_template.toLowerCase()) ? 1.0 :
    (fingerprint.interface_template && asset.interface_template &&
     fingerprint.interface_template.toLowerCase().includes(asset.interface_template.toLowerCase())) ? 0.5 : 0;

  // 2. Component structure match
  const caseSeq = fingerprint.component_sequence;
  const assetSeq = asset.component_sequence;
  const maxLen = Math.max(caseSeq.length, assetSeq.length);
  let structMatches = 0;
  for (let i = 0; i < Math.min(caseSeq.length, assetSeq.length); i++) {
    if (caseSeq[i] === assetSeq[i]) structMatches++;
  }
  const structScore = maxLen > 0 ? structMatches / maxLen : 0;

  // 3. Request structure & values (rReq field tree comparison)
  let reqStruct = 0;
  let reqValues = 0;
  const caseSoapClient = caseStep.components.find((c) => c.aw_alias === 'SoapClient');
  const assetSoapClient = asset.components.find((c) => c.aw_alias === 'SoapClient');
  if (caseSoapClient && assetSoapClient) {
    const caseReq = caseSoapClient.option_parameter.rReq;
    const assetReq = assetSoapClient.option_parameter.rReq;
    if (caseReq != null && assetReq != null) {
      const cmp = compareFieldTrees(buildFieldTree(caseReq), buildFieldTree(assetReq));
      reqStruct = cmp.structure;
      reqValues = cmp.values;
    } else if (caseReq == null && assetReq == null) {
      reqStruct = 1; reqValues = 1;
    }
  } else if (!caseSoapClient && !assetSoapClient) {
    reqStruct = 1; reqValues = 1;
  }

  // 4. Response structure (rRsp)
  let rspStruct = 0;
  if (caseSoapClient && assetSoapClient) {
    const caseRsp = caseSoapClient.option_parameter.rRsp;
    const assetRsp = assetSoapClient.option_parameter.rRsp;
    if (caseRsp != null && assetRsp != null) {
      rspStruct = compareFieldTrees(buildFieldTree(caseRsp), buildFieldTree(assetRsp)).structure;
    } else if (caseRsp == null && assetRsp == null) {
      rspStruct = 1;
    }
  } else if (!caseSoapClient && !assetSoapClient) {
    rspStruct = 1;
  }

  // 5. Variable behavior (variable names overlap)
  const caseVars = new Set(fingerprint.variable_names);
  const assetVars = new Set(Object.keys(asset.vars));
  // Also extract rVars from asset SoapClient
  for (const ac of asset.components) {
    if (ac.aw_alias === 'SoapClient' && ac.option_parameter.rVars != null) {
      for (const [, val] of buildFieldTree(ac.option_parameter.rVars)) {
        if (val.trim()) assetVars.add(val.trim());
      }
    }
  }
  const varOverlap = caseVars.size + assetVars.size > 0
    ? [...caseVars].filter((v) => assetVars.has(v)).length / Math.max(caseVars.size, assetVars.size)
    : 0;

  // Weighted overall score
  const overall = Math.round(
    (tplScore * 0.25 + structScore * 0.20 + reqStruct * 0.20 + reqValues * 0.10 + rspStruct * 0.10 + varOverlap * 0.15) * 1000,
  ) / 1000;

  return {
    overall,
    interface_template: tplScore,
    component_structure: structScore,
    request_structure: reqStruct,
    request_values: reqValues,
    response_structure: rspStruct,
    variable_behavior: varOverlap,
    top1_top2_gap: 0, // filled in matchStepToAssets
  };
}

export function matchStepToAssets(
  stepName: string,
  componentSequence: string[],
  interfaceTemplate: string | null,
  soapFieldPaths: string[],
  assets: StepAssetJson[],
  assetSlugs: Record<string, string>,
  caseStep?: CaseStep,
): StepMatchResult {
  // Build candidates with scores
  const candidates: { asset_id: string; asset_name: string; score: number; score_breakdown: MatchScoreBreakdown }[] = [];
  for (const asset of assets) {
    let breakdown: MatchScoreBreakdown;
    if (caseStep) {
      // Use full multi-dimensional scoring
      const dummyFp: StepFingerprint = {
        step_name: stepName,
        component_sequence: componentSequence,
        interface_template: interfaceTemplate,
        interface_endpoint: null,
        variable_names: [],
        soap_field_paths: soapFieldPaths,
        field_to_var: {},
        field_to_literal: {},
        fingerprint_hash: '',
      };
      breakdown = computeMatchScore(caseStep, dummyFp, asset);
    } else {
      // Fallback: simple scoring (backward compat)
      const tplScore = (interfaceTemplate && asset.interface_template &&
        interfaceTemplate.toLowerCase() === asset.interface_template.toLowerCase()) ? 1 : 0;
      const maxLen = Math.max(componentSequence.length, asset.component_sequence.length);
      let structMatches = 0;
      for (let i = 0; i < Math.min(componentSequence.length, asset.component_sequence.length); i++) {
        if (componentSequence[i] === asset.component_sequence[i]) structMatches++;
      }
      breakdown = {
        overall: Math.round((tplScore * 0.5 + (maxLen > 0 ? structMatches / maxLen : 0) * 0.5) * 1000) / 1000,
        interface_template: tplScore,
        component_structure: maxLen > 0 ? structMatches / maxLen : 0,
        request_structure: 0, request_values: 0, response_structure: 0, variable_behavior: 0, top1_top2_gap: 0,
      };
    }
    candidates.push({
      asset_id: asset.asset_id,
      asset_name: asset.name,
      score: breakdown.overall,
      score_breakdown: breakdown,
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  // Determine match kind
  let matchedAssetId: string | null = null;
  let matchedAssetName: string | null = null;
  let matchStatus: MatchKind = 'none';
  let matchReason = 'No matching asset found';

  if (candidates.length > 0) {
    const top = candidates[0];
    const second = candidates[1];
    const gap = second ? top.score - second.score : 1;
    if (top.score_breakdown) top.score_breakdown.top1_top2_gap = gap;

    if (top.score >= 0.85 && gap >= 0.15) {
      matchStatus = 'exact';
      matchedAssetId = top.asset_id;
      matchedAssetName = top.asset_name;
      matchReason = `High confidence match (score=${top.score.toFixed(3)}, gap=${gap.toFixed(3)})`;
    } else if (top.score >= 0.7) {
      matchStatus = 'semantic';
      matchedAssetId = top.asset_id;
      matchedAssetName = top.asset_name;
      matchReason = `Good match (score=${top.score.toFixed(3)}), AI should verify after reading full asset JSON`;
    } else if (top.score >= 0.5) {
      matchStatus = 'reusable-base';
      matchedAssetId = top.asset_id;
      matchedAssetName = top.asset_name;
      matchReason = `Partial match (score=${top.score.toFixed(3)}), asset usable as base with significant patches`;
    } else if (top.score >= 0.3 && candidates.length >= 2) {
      matchStatus = 'ambiguous';
      matchReason = `Low confidence (score=${top.score.toFixed(3)}), multiple weak candidates - AI must read full JSONs to decide`;
    } else {
      matchStatus = 'none';
      matchReason = `No suitable asset (best score=${top.score.toFixed(3)}), inline-recipe required`;
    }
  }

  const matchedSlug = matchedAssetId ? (assetSlugs[matchedAssetId] ?? null) : null;

  return {
    step_index: 0,
    step_name: stepName,
    matched_asset_id: matchedAssetId,
    matched_asset_name: matchedAssetName,
    matched_asset_slug: matchedSlug,
    match_status: matchStatus,
    score: candidates.length > 0 ? candidates[0].score : 0,
    score_breakdown: candidates.length > 0 ? candidates[0].score_breakdown : null,
    candidates: candidates.slice(0, 5),
    match_reason: matchReason,
  };
}

// ─── Signature computation ──────────────────────────────────

export function computeSignatures(
  steps: CaseDataStep[],
): {
  pattern_signature: string;
  variant_signature: string;
  parameter_signature: string;
  preparation_operations: string[];
} {
  // Pattern: interface call chain (excluding SETUP_INTERFACE_TEMPLATES)
  const patternParts: string[] = [];
  const allOps: string[] = [];
  const preparationOps: string[] = [];

  for (const step of steps) {
    const tpl = step.fingerprint.interface_template;
    if (!tpl) continue;
    if (SETUP_INTERFACE_TEMPLATES.has(tpl)) {
      // Preparation operation
      const opType = step.components
        .find((c) => c.aw_alias === 'SoapClient')
        ?.option_parameter;
      let opStr = tpl;
      if (opType) {
        const req = opType.rReq;
        if (req) {
          const tree = buildFieldTree(req);
          for (const [path, val] of tree) {
            if (path.endsWith('.OpType')) {
              opStr = `${tpl}[OpType=${val}]`;
              break;
            }
          }
        }
      }
      preparationOps.push(opStr);
      continue;
    }
    if (!patternParts.includes(tpl)) patternParts.push(tpl);

    // Collect operation type for variant signature
    const soapComp = step.components.find((c) => c.aw_alias === 'SoapClient');
    if (soapComp) {
      const req = soapComp.option_parameter.rReq;
      if (req) {
        const tree = buildFieldTree(req);
        for (const [path, val] of tree) {
          if (path.endsWith('.OpType') || path.endsWith('.ActionType') || path.endsWith('.OperType') || path.endsWith('.OperationType')) {
            allOps.push(`${tpl}[${path.split('.').pop()}=${val}]`);
            break;
          }
        }
      }
    }
  }

  // Variant: core operations only (last OpType per interface)
  const variantParts: string[] = [];
  const byInterface = new Map<string, string>();
  for (const op of allOps) {
    const tpl = op.split('[')[0];
    byInterface.set(tpl, op);
  }
  for (const op of byInterface.values()) variantParts.push(op);

  // Parameter signature: resource parameters from patches
  const paramParts: string[] = [];
  for (const step of steps) {
    for (const patch of step.script_patches) {
      if (patch.operation === 'set-variable' || patch.operation === 'runtime-bind' || patch.operation === 'expression-bind') {
        const part = `${patch.component}.${patch.field_name}`;
        if (!paramParts.includes(part)) paramParts.push(part);
      }
    }
  }

  return {
    pattern_signature: patternParts.join(' -> '),
    variant_signature: variantParts.join(' + '),
    parameter_signature: paramParts.join(', ') || 'none',
    preparation_operations: preparationOps,
  };
}

export function extractBusinessEntities(
  steps: CaseDataStep[],
  assets: { asset_id: string; name: string; parameter_meta: Record<string, { description: string }> }[],
): BusinessEntity[] {
  const entities: BusinessEntity[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    for (const patch of step.script_patches) {
      const key = `${patch.component}.${patch.field_path}`;
      if (seen.has(key)) continue;
      if (patch.operation === 'set-variable' || patch.operation === 'runtime-bind' || patch.operation === 'expression-bind') {
        seen.add(key);
        const asset = step.match.matched_asset_id
          ? assets.find((a) => a.asset_id === step.match.matched_asset_id)
          : null;
        const desc = asset?.parameter_meta?.[patch.field_name]?.description ?? '';
        entities.push({
          entity: patch.field_name,
          relation: patch.operation,
          created_by: patch.case_value ?? '',
          modified_by: patch.case_value ?? '',
          evidence_type: 'observed',
        });
      }
    }
  }
  return entities;
}