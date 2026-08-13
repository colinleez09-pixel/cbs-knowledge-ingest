#!/usr/bin/env bun
/**
 * scenario-core.ts
 * CBS 历史用例场景分析 - 共享类型与工具函数
 *
 * 职责：
 * - 基础工具函数（SHA-256、slug 规范化、JSON 规范化等）
 * - 历史用例解析类型定义
 * - 步骤资产 JSON 类型定义（以资产 JSON 为准）
 * - 脚本化指纹匹配（名称/组件序列/接口模板三重指纹）
 * - 脚本化参数 Delta 计算（变量级对比）
 * - 场景分析草稿类型定义（AI 输出格式）
 * - 场景计划类型定义（授权与写入）
 * - GBrain 真实 CLI 封装（0.42.57.0：put/get/list/link/timeline-add/stats 文本协议）
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// ─── 基础工具 ──────────────────────────────────────────────

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

/** 参数值序列化：字符串原样返回；对象/数组 JSON 序列化（避免 [object Object]）；null 返回 fallback */
export function paramValueToString(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try {
      const s = JSON.stringify(value);
      return s;
    } catch {
      return fallback;
    }
  }
  return String(value);
}

export function asNullableString(value: unknown): string | null {
  const text = asString(value).trim();
  return text || null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => [key, canonicalize(v)]),
  );
}

export function sanitizeSlugPart(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function shortStableId(value: string): string {
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return compact.slice(0, 8) || sha256(value).slice(0, 8);
}

const ENGLISH_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeScenarioSlug(value: string): string {
  let leaf = sanitizeSlugPart(value);
  // 纯中文等非 ASCII 名称：sanitize 后无有效字母，退化为稳定哈希叶子
  if (!ENGLISH_SLUG_RE.test(leaf) || !/[a-z]/.test(leaf)) {
    leaf = `scenario-${sha256(value).slice(0, 8)}`;
  } else if (/[一-鿿]/.test(value)) {
    // 中英混合：不同中文名可能 sanitize 为相同 ASCII 前缀（如 "PA承诺付费"/"PA奖励" -> "pa"），附加短哈希防碰撞
    leaf = `${leaf}-${sha256(value).slice(0, 6)}`;
  }
  if (UUID_RE.test(leaf) || leaf.length > 96) {
    throw new Error(`Scenario slug must be concise English, not UUID or oversized: ${value}`);
  }
  return leaf;
}

export function scopedScenarioSlug(siteKey: string, scenarioSlug: string): string {
  const leaf = normalizeScenarioSlug(scenarioSlug);
  return `cbs/scenarios/${siteKey}/${leaf}`;
}

export function siteKeyFromId(siteId: string, siteName: string): string {
  const sitePart = sanitizeSlugPart(siteName) || 'site';
  return `${sitePart}-${shortStableId(siteId)}`;
}

// 调用方须传入 process.argv.slice(2)（即纯参数列表）
export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

// GBrain 设计理念：slug 是页面主键 / Markdown 文件路径 / FTS 关键词索引锚点 / wikilink 图谱节点，
// 必须语义化可读（如 freeunit-expire-reset），禁止无语义哈希（scenario-<hash> 仅作历史兜底，门禁会拦截新草稿）。
const SLUG_EN_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isValidSlugEn(value: string): boolean {
  return SLUG_EN_RE.test(value) && value.length >= 4 && value.length <= 48;
}

export function isPlaceholderSlugEn(value: string): boolean {
  const v = value.trim().toLowerCase();
  return !v || v.includes('todo') || v.includes('tbd') || v.includes('placeholder')
    || v.startsWith('scenario-draft-') || v.startsWith('scenario-2') && /^scenario-[0-9a-f]{8}$/.test(v)
    || /^scenario-[0-9a-f]{6,}$/.test(v) || /^[0-9a-f]{6,}$/.test(v);
}

export function generateScenarioSlug(scenarioName: string, siteKey: string, slugEn?: string): string {
  // 优先使用 AI 提供的语义化英文 slug；缺失时退回名称派生（含哈希兜底）
  const leaf = slugEn && isValidSlugEn(slugEn.trim()) && !isPlaceholderSlugEn(slugEn.trim())
    ? slugEn.trim().toLowerCase()
    : normalizeScenarioSlug(scenarioName);
  return scopedScenarioSlug(siteKey, leaf);
}

// ─── 历史用例解析类型 ────────────────────────────────────

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

// ─── 步骤指纹 ────────────────────────────────────────────

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

// ─── 步骤资产 JSON 类型（以资产 JSON 为准） ──────────────
// 真实结构见 samples/step-assets/创建客户.json

export interface AssetParamMeta {
  description?: string;
  suggested_default?: string;
  is_open?: boolean;
}

export interface AssetComponent {
  aw_alias: string;
  option_parameter: JsonRecord;
  parameter_meta?: Record<string, AssetParamMeta>;
}

export interface StepAssetJson {
  asset_id: string;            // step.id
  name: string;                // step.name
  description: string;
  status: string;
  site_id: string;             // source_context.site_id
  site_version: string;        // source_context.site_version
  product_name: string;        // source_context.product_name
  components: AssetComponent[];      // template_json.case_option
  component_sequence: string[];      // aw_alias 序列
  interface_template: string | null; // SoapClient.option_parameter.rTpl
  interface_endpoint: string | null; // SoapClient.option_parameter.url
  vars: Record<string, string>;      // TableSetVar.option_parameter.vars 解析结果
  parameter_meta: Record<string, AssetParamMeta>; // 合并所有组件的 parameter_meta
  source_path: string | null;  // GBrain 页 frontmatter 的 source_path（若从 GBrain 加载）
  source_kind: 'dir' | 'api' | 'gbrain-source-path';
  source_file: string;
  source_hash: string;
}

// 解析资产 JSON 文件（{ step: {...} } 结构）
export function parseStepAssetJson(
  raw: JsonRecord,
  meta: { sourceKind: StepAssetJson['source_kind']; sourceFile: string; sourcePath?: string | null },
): StepAssetJson {
  const step = isRecord(raw.step) ? raw.step : raw;
  const templateJson = isRecord(step.template_json) ? step.template_json : {};
  const caseOption = asArray(templateJson.case_option).filter(isRecord) as unknown as AssetComponent[];
  const sourceContext = isRecord(step.source_context) ? step.source_context : {};

  const components = caseOption;
  const componentSequence = components.map((c) => asString(c.aw_alias)).filter(Boolean);

  const soap = components.find((c) => asString(c.aw_alias) === 'SoapClient');
  const soapParams = isRecord(soap?.option_parameter) ? soap!.option_parameter : {};

  const tableSetVar = components.find((c) => asString(c.aw_alias) === 'TableSetVar');
  const tableParams = isRecord(tableSetVar?.option_parameter) ? tableSetVar!.option_parameter : {};
  const vars = parseVarsString(asString(tableParams.vars));

  const parameterMeta: Record<string, AssetParamMeta> = {};
  for (const comp of components) {
    if (isRecord(comp.parameter_meta)) {
      for (const [key, value] of Object.entries(comp.parameter_meta)) {
        if (isRecord(value)) parameterMeta[key] = value as AssetParamMeta;
      }
    }
  }

  const content = JSON.stringify(raw);
  return {
    asset_id: asString(step.id),
    name: asString(step.name),
    description: asString(step.description),
    status: asString(step.status),
    site_id: asString(sourceContext.site_id),
    site_version: asString(sourceContext.site_version),
    product_name: asString(sourceContext.product_name),
    components,
    component_sequence: componentSequence,
    interface_template: normalizeTemplateName(asNullableString(soapParams.rTpl)) || null,
    interface_endpoint: asNullableString(soapParams.url),
    vars,
    parameter_meta: parameterMeta,
    source_path: meta.sourcePath ?? null,
    source_kind: meta.sourceKind,
    source_file: meta.sourceFile,
    source_hash: sha256(content),
  };
}

// ─── vars 字符串解析 ─────────────────────────────────────
// 格式: "My_A=1;\nMy_B=${expr};\nMy_C=x"（分号分隔，可换行）

export function parseVarsString(varsText: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!varsText) return result;
  for (const rawPart of varsText.split(';')) {
    const part = rawPart.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

// ─── 脚本化指纹匹配 ──────────────────────────────────────
// 三重指纹：case_step 名称 / 组件序列 / 接口模板（rTpl）

// 归一化接口模板名："@\soap\Adjustment.xml" / "@/soap/Adjustment.xml" -> "Adjustment"
export function normalizeTemplateName(rTpl: string | null | undefined): string {
  if (!rTpl) return '';
  const base = rTpl.replace(/\\/g, '/').split('/').pop() ?? rTpl;
  return base.replace(/\.xml$/i, '');
}

// 组件序列分级相似度：
// 1.0 完全一致；0.8 互为前缀（用例在资产后追加校验组件，或用例省略资产尾部组件）；
// 0.6 互为连续子序列；0.4 前 2 个核心组件一致（如 TableSetVar>SoapClient）；0.2 首组件一致；0 完全不同
export function componentSeqScore(caseSeq: string[], assetSeq: string[]): number {
  if (caseSeq.length === 0 || assetSeq.length === 0) return 0;
  const c = caseSeq.join('>');
  const a = assetSeq.join('>');
  if (c === a) return 1;
  if (c.startsWith(a + '>') || a.startsWith(c + '>')) return 0.8;
  if (c.includes(a) || a.includes(c)) return 0.6;
  const coreLen = Math.min(2, caseSeq.length, assetSeq.length);
  let coreEq = 0;
  for (let i = 0; i < coreLen; i++) if (caseSeq[i] === assetSeq[i]) coreEq++;
  if (coreLen >= 2 && coreEq === coreLen) return 0.4;
  if (caseSeq[0] === assetSeq[0]) return 0.2;
  return 0;
}

export interface StepMatchCandidate {
  asset: StepAssetJson;
  score: number;             // 0-1
  name_match: boolean;
  component_match: boolean;
  template_match: boolean;
  field_coverage: number;    // 用例 field_mappings 在资产请求字段中的覆盖率
}

export interface StepMatchResult {
  step_index: number;
  step_name: string;
  matched_asset_id: string | null;
  matched_asset_name: string | null;
  matched_slug: string | null;   // GBrain 页 slug（若资产从 GBrain 关联加载则有值）
  confidence: number;
  match_status: 'matched' | 'tentative' | 'unmatched';
  match_reason: string;
  candidates: { asset_id: string; name: string; score: number }[];
}

export function matchStepToAssets(
  caseStepName: string,
  caseComponentSeq: string[],
  caseTemplate: string | null,
  caseFieldPaths: string[],
  assets: StepAssetJson[],
  assetSlugs: Record<string, string>, // asset_id -> gbrain slug
): StepMatchResult {
  const candidates: StepMatchCandidate[] = assets.map((asset) => {
    const nameMatch =
      normalizeName(caseStepName) === normalizeName(asset.name) ? true : fuzzyNameMatch(caseStepName, asset.name);
    const componentScore = componentSeqScore(caseComponentSeq, asset.component_sequence);
    const componentMatch = componentScore >= 0.6;
    const caseTpl = normalizeTemplateName(caseTemplate).toLowerCase();
    const assetTpl = normalizeTemplateName(asset.interface_template).toLowerCase();
    const templateMatch = !!caseTpl && !!assetTpl && caseTpl === assetTpl;

    // 字段覆盖率：用例字段路径在资产 rReq/rVars 文本中的出现率
    let fieldCoverage = 0;
    if (caseFieldPaths.length > 0) {
      const assetText = JSON.stringify(asset.components);
      const hit = caseFieldPaths.filter((p) => {
        const leaf = p.split('.').pop() || p;
        return assetText.includes(leaf);
      }).length;
      fieldCoverage = hit / caseFieldPaths.length;
    }

    let score = 0;
    if (nameMatch === true && normalizeName(caseStepName) === normalizeName(asset.name)) score += 0.4;
    else if (nameMatch) score += 0.2;
    score += 0.35 * componentScore;
    if (templateMatch) score += 0.2;
    score += fieldCoverage * 0.05;

    return {
      asset,
      score: Math.min(1, score),
      name_match: nameMatch,
      component_match: componentMatch,
      template_match: templateMatch,
      field_coverage: fieldCoverage,
    };
  });

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  if (!best || best.score < 0.3) {
    return {
      step_index: -1,
      step_name: caseStepName,
      matched_asset_id: null,
      matched_asset_name: null,
      matched_slug: null,
      confidence: 0,
      match_status: 'unmatched',
      match_reason: '无候选资产满足最低匹配阈值（组件序列与接口模板均不一致）',
      candidates: candidates.slice(0, 3).map((c) => ({ asset_id: c.asset.asset_id, name: c.asset.name, score: c.score })),
    };
  }

  const status: StepMatchResult['match_status'] =
    best.score >= 0.75 ? 'matched' : best.score >= 0.45 ? 'tentative' : 'unmatched';
  const reasons: string[] = [];
  if (best.name_match) reasons.push('步骤名称匹配');
  if (best.component_match) reasons.push('组件序列一致或互为前缀/子序列');
  if (best.template_match) reasons.push(`接口模板一致（${normalizeTemplateName(best.asset.interface_template)}）`);
  if (best.field_coverage > 0.5) reasons.push(`字段覆盖率 ${(best.field_coverage * 100).toFixed(0)}%`);

  return {
    step_index: -1,
    step_name: caseStepName,
    matched_asset_id: status === 'unmatched' ? null : best.asset.asset_id,
    matched_asset_name: status === 'unmatched' ? null : best.asset.name,
    matched_slug: status === 'unmatched' ? null : assetSlugs[best.asset.asset_id] ?? null,
    confidence: best.score,
    match_status: status,
    match_reason: reasons.join('；') || '匹配度低于阈值',
    candidates: candidates.slice(0, 3).map((c) => ({ asset_id: c.asset.asset_id, name: c.asset.name, score: c.score })),
  };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s\-_（）()]+/g, '');
}

function fuzzyNameMatch(caseName: string, assetName: string): boolean {
  const a = normalizeName(caseName);
  const b = normalizeName(assetName);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

// ─── 脚本化参数 Delta 计算 ───────────────────────────────
// 对比用例步骤与资产步骤的参数差异，计算 delta

/** option_parameter 键级对比通用函数（用于 SoapClient/DataBaseQuery 等组件） */
function pushOptionParamDeltas(
  deltas: ScriptDeltaItem[],
  componentAlias: string,
  caseParams: Record<string, unknown>,
  assetParams: Record<string, unknown>,
  skipKeys: Set<string>,
  parameterMeta: Record<string, AssetParamMeta>,
): void {
  const allParamKeys = unique([...Object.keys(assetParams), ...Object.keys(caseParams)]);
  for (const key of allParamKeys) {
    if (skipKeys.has(key)) continue;
    const inAsset = key in assetParams;
    const inCase = key in caseParams;
    // 值可能是对象（rRsp/rVars/rReq 为 dict），对象需 JSON 序列化而非 String()
    const assetVal = inAsset ? paramValueToString(assetParams[key]) : null;
    const caseVal = inCase ? paramValueToString(caseParams[key]) : null;
    // 用例值为空字符串时视为"用例未设置该参数"，按 remove 处理
    const caseIsEmpty = caseVal === null || caseVal === '';
    const metaKey = `${componentAlias}.${key}`;
    const meta = parameterMeta[metaKey] ?? parameterMeta[key] ?? {};
    const isOpen = meta.is_open === true;

    if (inAsset && inCase && !caseIsEmpty && assetVal !== caseVal) {
      deltas.push({
        component_alias: componentAlias,
        variable_name: key,
        delta_type: 'modify',
        asset_value: assetVal,
        case_value: caseVal,
        is_open_param: isOpen,
        param_description: asString(meta.description),
        suggested_default: asString(meta.suggested_default),
      });
    } else if (inAsset && inCase && caseIsEmpty && assetVal && assetVal.length > 0) {
      // 用例清空了资产的默认值 → remove
      deltas.push({
        component_alias: componentAlias,
        variable_name: key,
        delta_type: 'remove',
        asset_value: assetVal,
        case_value: null,
        is_open_param: isOpen,
        param_description: asString(meta.description),
        suggested_default: asString(meta.suggested_default),
      });
    } else if (inCase && !inAsset && !caseIsEmpty) {
      deltas.push({
        component_alias: componentAlias,
        variable_name: key,
        delta_type: 'add',
        asset_value: null,
        case_value: caseVal,
        is_open_param: false,
        param_description: '',
        suggested_default: '',
      });
    } else if (inAsset && !inCase) {
      deltas.push({
        component_alias: componentAlias,
        variable_name: key,
        delta_type: 'remove',
        asset_value: assetVal,
        case_value: null,
        is_open_param: isOpen,
        param_description: asString(meta.description),
        suggested_default: asString(meta.suggested_default),
      });
    }
  }
}

export type ScriptDeltaType = 'add' | 'remove' | 'modify';

export interface ScriptDeltaItem {
  component_alias: string;
  variable_name: string;
  delta_type: ScriptDeltaType;
  asset_value: string | null;   // 资产中的值（开放占位符或默认值）
  case_value: string | null;    // 用例中的值
  is_open_param: boolean;       // 是否为资产定义的开放参数
  param_description: string;    // parameter_meta.description（若有）
  suggested_default: string;    // parameter_meta.suggested_default（若有）
}

export function computeStepDelta(caseStep: CaseStep, asset: StepAssetJson): ScriptDeltaItem[] {
  const deltas: ScriptDeltaItem[] = [];

  // 1. TableSetVar vars 变量级对比
  const caseTableSetVar = caseStep.components.find((c) => c.aw_alias === 'TableSetVar');
  const caseVars = parseVarsString(asString(caseTableSetVar?.option_parameter?.vars));
  const assetVars = asset.vars;

  const allKeys = unique([...Object.keys(assetVars), ...Object.keys(caseVars)]);
  for (const key of allKeys) {
    const inAsset = key in assetVars;
    const inCase = key in caseVars;
    const metaKey = `vars.${key}`;
    const meta = asset.parameter_meta[metaKey] ?? asset.parameter_meta[key] ?? {};

    if (inAsset && inCase) {
      const assetVal = assetVars[key];
      const caseVal = caseVars[key];
      // 资产值为开放占位符（${My_X} 形式且与变量同名）时用例值视为"填写开放参数"，也记录为 modify
      if (assetVal !== caseVal) {
        deltas.push({
          component_alias: 'TableSetVar',
          variable_name: key,
          delta_type: 'modify',
          asset_value: assetVal,
          case_value: caseVal,
          is_open_param: meta.is_open === true || isOpenPlaceholder(assetVal, key),
          param_description: asString(meta.description),
          suggested_default: asString(meta.suggested_default),
        });
      }
    } else if (inCase && !inAsset) {
      deltas.push({
        component_alias: 'TableSetVar',
        variable_name: key,
        delta_type: 'add',
        asset_value: null,
        case_value: caseVars[key],
        is_open_param: false,
        param_description: '',
        suggested_default: '',
      });
    } else if (inAsset && !inCase) {
      deltas.push({
        component_alias: 'TableSetVar',
        variable_name: key,
        delta_type: 'remove',
        asset_value: assetVars[key],
        case_value: null,
        is_open_param: meta.is_open === true || isOpenPlaceholder(assetVars[key], key),
        param_description: asString(meta.description),
        suggested_default: asString(meta.suggested_default),
      });
    }
  }

  // 2. SoapClient option_parameter 键级对比（rReq/rRsp/rVars 等全部参数均参与对比）
  const caseSoap = caseStep.components.find((c) => c.aw_alias === 'SoapClient');
  const assetSoap = asset.components.find((c) => asString(c.aw_alias) === 'SoapClient');
  if (caseSoap && assetSoap) {
    const caseParams = isRecord(caseSoap.option_parameter) ? caseSoap.option_parameter : {};
    const assetParams = isRecord(assetSoap.option_parameter) ? assetSoap.option_parameter : {};
    // rTpl=接口模板名, url/iTimeOut/rHeader=连接配置，这些由匹配决定而非用例差异
    const skipKeys = new Set(['rTpl', 'url', 'iTimeOut', 'rHeader']);
    pushOptionParamDeltas(deltas, 'SoapClient', caseParams, assetParams, skipKeys, asset.parameter_meta);
  }

  // 3. DataBaseQuery / DataBaseModify option_parameter 键级对比
  for (const alias of ['DataBaseQuery', 'DataBaseModify'] as const) {
    const caseComp = caseStep.components.find((c) => c.aw_alias === alias);
    const assetComp = asset.components.find((c) => asString(c.aw_alias) === alias);
    if (caseComp && assetComp) {
      const caseParams = isRecord(caseComp.option_parameter) ? caseComp.option_parameter : {};
      const assetParams = isRecord(assetComp.option_parameter) ? assetComp.option_parameter : {};
      // iTimeOut=超时配置，非业务差异
      const skipKeys = new Set(['iTimeOut']);
      pushOptionParamDeltas(deltas, alias, caseParams, assetParams, skipKeys, asset.parameter_meta);
    }
  }

  // 4. 其他组件类型 option_parameter 键级对比（已处理 TableSetVar/SoapClient/DataBaseQuery/DataBaseModify 除外）
  const handledAliases = new Set(['TableSetVar', 'SoapClient', 'DataBaseQuery', 'DataBaseModify']);
  const caseAliases = new Set(caseStep.components.map((c) => c.aw_alias));
  const assetAliases = new Set(asset.components.map((c) => asString(c.aw_alias)));
  for (const alias of caseAliases) {
    if (handledAliases.has(alias)) continue;
    const caseComp = caseStep.components.find((c) => c.aw_alias === alias);
    const assetComp = asset.components.find((c) => asString(c.aw_alias) === alias);
    if (caseComp && assetComp) {
      const caseParams = isRecord(caseComp.option_parameter) ? caseComp.option_parameter : {};
      const assetParams = isRecord(assetComp.option_parameter) ? assetComp.option_parameter : {};
      pushOptionParamDeltas(deltas, alias, caseParams, assetParams, new Set(), asset.parameter_meta);
    }
  }

  return deltas;
}

function isOpenPlaceholder(value: string, varName: string): boolean {
  return value.trim() === '${' + varName + '}';
}

// ─── 场景签名（用于按场景判重） ──────────────────────────
// 主接口操作 + 关键业务参数特征，如 "Adjustment[OpType=5]"

export function buildScenarioSignature(mainInterface: string, keyParams: Record<string, string>): string {
  const paramPart = Object.entries(keyParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return paramPart ? `${mainInterface}[${paramPart}]` : mainInterface;
}

// ─── 参数依赖类型 ────────────────────────────────────────

export type DependencyType = 'variable-reference' | 'env-var-passing' | 'query-output';

export interface ParamDependency {
  from_step: number;
  to_step: number;
  from_param: string;
  to_param: string;
  type: DependencyType;
  description: string;
}

// ─── 参数 Delta 类型（AI 输出，含业务理由） ──────────────

export type DeltaType = 'add' | 'remove' | 'modify-default' | 'modify-binding';

export interface ParamDeltaItem {
  step_index: number;
  change_type: DeltaType;
  component_alias: string;
  variable_name: string;
  field_path: string;
  field_description: string;
  case_value: string;
  asset_default_value: string | null;
  reason: string;
}

// ─── 场景知识 ────────────────────────────────────────────

export interface ScenarioKnowledge {
  core_business_knowledge: string;
  parameter_design_rationale: {
    parameter: string;
    field_path: string;
    case_value: string;
    field_meaning: string;
    why_this_value: string;
    business_context: string;
  }[];
  preconditions: string[];
  expected_results: string[];
  key_decision_points: {
    parameter: string;
    field_path: string;
    decision_impact: string;
    alternative_values: { value: string; meaning: string }[];
  }[];
}

// ─── AI 分析草稿类型 ─────────────────────────────────────

export type MergeMode = 'create' | 'extend';

export interface AnalysisDraftStep {
  step_index: number;
  behavior: string;
  matched_step_asset_slug: string | null;
  matched_asset_id: string | null;
  match_confidence: number;
  match_status: 'matched' | 'tentative' | 'unmatched';  // AI 必须裁决 tentative → matched 或 unmatched
  match_reason: string;
  param_deltas: ParamDeltaItem[];  // AI 基于脚本 delta 补业务理由后的版本
  source_case_refs: { case_id: string; step_index: number }[];
}

// ─── 业务实体（v0.12.0 四层签名模型） ──────────────────────

export interface BusinessEntity {
  entity: string;            // 业务对象名（如 Customer, FreeUnitInstance）
  relation?: string;         // 与父实体的关系（如 "belongs_to Account"）
  created_by?: string;       // 创建该实体的步骤（如 "create-customer"）
  modified_by?: string;      // 修改该实体的步骤（如 "Adjustment OpType=5"）
  description?: string;     // 实体说明
}

export interface OperationVariant {
  variant_signature: string;  // 操作签名（如 "OpType=5"）
  description: string;       // 中文描述（如 "失效时间重置"）
  difference?: string;       // 与 Pattern 默认流程的差异说明
  role?: 'core' | 'prepare'; // v0.12.3+: core=核心测试目标, prepare=前置准备操作
}

export interface ParameterVariant {
  parameter_signature: string;  // 参数签名（如 "FreeUnitType=C_OOTB_Voice_Local"）
  parameter_name: string;       // 参数名（如 "FreeUnitType"）
  parameter_value: string;      // 参数值（如 "C_OOTB_Voice_Local"）
  description: string;          // 中文描述（如 "本地语音"）
  source_cases: string[];       // 来源用例ID列表
}

export interface AnalysisDraftScenario {
  scenario_id: string;
  name: string;
  slug_en: string;                       // 语义化英文 slug 叶子（kebab-case），AI 必填
  description: string;
  site_key: string;
  site_id: string;
  site_name: string;
  product_slug: string;
  source_cases: string[];
  merge_mode: MergeMode;               // create=新建场景页 / extend=增量合并进已有页
  target_scenario_slug: string | null; // extend 模式时的目标已有场景页 slug
  // 四层签名模型（v0.12.0+）
  pattern_signature: string;           // 接口调用链签名（如 "Adjustment"），脚本自动计算（排除 setup 步骤）
  intent_signature: string;            // 业务意图签名（如 "ExpireTimeCorrection"），AI 必填
  variant_signature: string;           // 操作变体签名（如 "OpType=5"），脚本自动计算（仅核心操作）
  preparation_operations: string[];     // 前置准备操作（如 ["OpType=1"]），不在 variant 中
  parameter_signature: string;         // 参数变体签名（如 "FreeUnitType=C_OOTB_Voice_Local"），脚本自动计算
  capability: string | null;           // 业务能力归属（如 "free-resource-management"），AI 可选填写
  test_points: {                        // 测试点清单
    test_point: string;
    related_parameters: string[];
    design_reason: string;
  }[];
  business_entities: BusinessEntity[];   // 业务实体关系（v0.12.0），AI 必填
  operation_variants: OperationVariant[]; // 操作变体（Pattern 页面内章节），脚本预填 + AI 确认
  parameter_variants: ParameterVariant[]; // 参数变体（Pattern 页面内表格），脚本预填
  steps: AnalysisDraftStep[];
  dependencies: ParamDependency[];
  missing_step_suggestions: {
    step_index: number;
    step_name: string;
    component_sequence: string[];
    interface_template: string | null;
    suggested_slug: string;
    reason: string;
  }[];
  variant_suggestions: {
    step_slug: string;
    step_name: string;
    variant_description: string;
    key_param_changes: string[];
    reason: string;
  }[];
  page_draft_file: string;   // 页面 Markdown 草稿的独立文件路径（不再内嵌 JSON）
  scenario_knowledge: ScenarioKnowledge;
  similar_existing_scenarios?: {
    slug: string;
    title: string;
    similarity_reason: string;
  }[];
}

export interface AnalysisDraft {
  schema_version: 'cbs-scenario-analysis-v1';
  analyzed_at: string;
  source_case_data: string;
  scenarios: AnalysisDraftScenario[];
}

// ─── 场景计划（Plan）类型 ────────────────────────────────

export interface ScenarioPlanPage {
  slug: string;
  kind: 'scenario-pattern';
  content: string;
  content_sha256: string;
  immutable: boolean;
  natural_key: string;
  merge_mode: MergeMode;
}

export interface ScenarioPlanLink {
  from_slug: string;
  to_slug: string;
  link_type: 'composed_of_step' | 'evidenced_by' | 'param_flows_to';
  context: string;
}

export interface ScenarioPlanTimeline {
  slug: string;
  date: string;
  entry: string;
  idempotency_marker: string;
}

export interface ScenarioPattern {
  scenario_id: string;
  scenario_slug: string;
  scenario_name: string;
  description: string;
  site_key: string;
  site_id: string;
  site_name: string;
  product_slug: string;
  merge_mode: MergeMode;
  target_scenario_slug: string | null;
  scenario_signature: string;
  steps: {
    step_index: number;
    step_name: string;
    role: 'core' | 'recommended' | 'conditional';
    matched_step_slug: string | null;
    matched_asset_id: string | null;
    matched_step_name: string | null;
    confidence: number;
    match_status: 'matched' | 'tentative' | 'unmatched';
    behavior: string;
  }[];
  param_deltas: ParamDeltaItem[];
  param_dependencies: ParamDependency[];
  source_cases: string[];
  missing_step_suggestions: {
    step_index: number;
    step_name: string;
    component_sequence: string[];
    interface_template: string | null;
    suggested_slug: string;
    reason: string;
  }[];
  variant_suggestions: {
    step_slug: string;
    step_name: string;
    variant_description: string;
    key_param_changes: string[];
    reason: string;
  }[];
  scenario_knowledge: ScenarioKnowledge;
}

export interface ScenarioPlan {
  schema_version: 'cbs-scenario-plan-v1';
  skill: { name: 'cbs-case-scenario-analyze'; version: string };
  generated_at: string;
  input: {
    case_files: string[];
    interface_doc: string | null;
    common_structure_doc: string | null;
  };
  scenarios: ScenarioPattern[];
  pages: ScenarioPlanPage[];
  links: ScenarioPlanLink[];
  timelines: ScenarioPlanTimeline[];
  apply_contract: {
    executor: string;
    authorization_entrypoint: string;
    runtime_policy: {
      apply_attempts_per_user_authorization: number;
      on_failure: string;
      agent_may_retry_automatically: boolean;
      agent_may_modify_skill_or_plan: boolean;
      agent_may_create_workaround_scripts: boolean;
      agent_may_bypass_executor_with_manual_writes: boolean;
    };
  };
  plan_integrity: {
    authorized: boolean;
    payload_sha256: string;
    dry_run_payload_sha256: string | null;
    authorized_payload_sha256: string | null;
    authorization_method: string | null;
    authorized_at: string | null;
  };
}

export function planPayloadSha256(plan: ScenarioPlan): string {
  const payload = { ...plan } as Record<string, unknown>;
  delete payload.plan_integrity;
  return sha256(canonicalJson(payload));
}

// ─── case-data.json 类型 ────────────────────────────────

export interface CaseDataFile {
  extraction_meta: {
    extracted_at: string;
    case_count: number;
    step_asset_count: number;
    existing_scenario_count: number;
    interface_doc_provided: boolean;
    common_structure_doc_provided: boolean;
    asset_source: 'dir' | 'api' | 'gbrain-source-path' | 'none';
    /** step_asset_count=0 时的阻断级警告与修复指引；有资产时为 null */
    asset_load_warning: string | null;
  };
  cases: {
    case_id: string;
    basic_info: {
      case_name: string;
      case_description: string;
      product_name: string;
      product_id: string;
      site_name: string;
      site_id: string;
      site_version: string;
      handler: string;
      designer: string;
      test_steps_description: string;
      expected_result: string;
      result: string;
    };
    steps: {
      step_index: number;
      step_name: string;
      step_memo: string | null;
      components: {
        aw_alias: string;
        is_commented: boolean;
        is_old_aw: boolean;
        aw_step: number;
        option_parameter: JsonRecord;
      }[];
      fingerprint: StepFingerprint;
      // 脚本化匹配结果（AI 只做确认或歧义裁决）
      match: StepMatchResult;
      // 脚本化 delta（AI 只补业务理由）
      script_deltas: ScriptDeltaItem[];
    }[];
    source_file: string;
    source_hash: string;
  }[];
  // 步骤资产概要（含 GBrain slug 关联，供页面 wikilink 使用）
  step_assets: {
    asset_id: string;
    name: string;
    slug: string | null;
    interface_template: string | null;
    component_sequence: string[];
    open_parameter_names: string[];
    source_kind: StepAssetJson['source_kind'];
    source_path: string | null;
  }[];
  // 接口字段目录（只列接口名与元素数，不含明细）
  // 明细在同目录 interface-fields.json，AI 按需用 lookup-field-info.ts 查询，禁止全量读取
  interface_catalog: {
    interface: string;
    element_count: number;
  }[];
  // 接口字段明细文件名（相对 case-data.json 所在目录）；无接口文档时为 null
  interface_fields_file: string | null;
  existing_scenarios: {
    slug: string;
    title: string;
    scenario_signature?: string; // 从已有页 frontmatter 提取（若有）
  }[];
}

// 接口字段明细独立文件（interface-fields.json）格式
// AI 不直接全量读此文件，通过 lookup-field-info.ts 按需查询
export interface InterfaceFieldsFile {
  generated_at: string;
  interface_count: number;
  // 接口名 -> 字段元素表
  interface_fields: {
    [interface_name: string]: {
      elements: {
        name: string;
        path: string;
        type: string;
        description: string;
      }[];
    };
  };
  // 变量名 -> 字段路径 映射
  field_mapping: Record<string, string>;
}

// ─── GBrain 真实 CLI 封装（0.42.57.0） ───────────────────
// 真实命令（实测）：
//   gbrain list [--type T]            → 文本表格: slug\ttype\tdate\ttitle
//   gbrain get <slug>                 → 文本: frontmatter + 正文 + Timeline
//   gbrain put <slug> < file          → stdin 写入（frontmatter 在内容内）
//   gbrain link <from> <to> --link-type T
//   gbrain timeline-add <slug> <date> <text>
//   gbrain graph-query <slug> [--type T]
//   gbrain stats                      → 文本统计
//   gbrain search <query> / gbrain query <question>
// 不存在：capture、stats --json、write_page、get_page、--json 有效输出

export interface GbrainResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

export function runGbrain(gbrainPath: string, args: string[], options?: { stdin?: string }): GbrainResult {
  const result = spawnSync(gbrainPath, args, {
    encoding: 'utf-8',
    timeout: 60000,
    input: options?.stdin,
    shell: false,
  });
  const stdout = asString(result.stdout);
  const stderr = asString(result.stderr);
  const exitCode = result.status ?? -1;
  return { exitCode, stdout, stderr, success: exitCode === 0 && !result.error };
}

// gbrain put <slug>（通过 stdin 传入内容，跨平台：PowerShell 也支持 stdin）
export function gbrainPut(gbrainPath: string, slug: string, content: string): GbrainResult {
  return runGbrain(gbrainPath, ['put', slug], { stdin: content });
}

// gbrain get <slug> → 返回原始文本（frontmatter + 正文）
export function gbrainGet(gbrainPath: string, slug: string): GbrainResult {
  return runGbrain(gbrainPath, ['get', slug]);
}

// gbrain list --type T → 文本表格解析
export interface GbrainListItem {
  slug: string;
  type: string;
  date: string;
  title: string;
}

export function gbrainList(gbrainPath: string, type?: string): { items: GbrainListItem[]; raw: GbrainResult } {
  const args = type ? ['list', '--type', type] : ['list'];
  const raw = runGbrain(gbrainPath, args);
  const items: GbrainListItem[] = [];
  if (raw.success) {
    for (const line of raw.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\t|\s{2,}/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2 && parts[0].includes('/')) {
        items.push({
          slug: parts[0],
          type: parts[1] ?? '',
          date: parts[2] ?? '',
          title: parts.slice(3).join(' ') ?? '',
        });
      }
    }
  }
  return { items, raw };
}

// gbrain link <from> <to> --link-type T
export function gbrainLink(gbrainPath: string, from: string, to: string, linkType: string): GbrainResult {
  return runGbrain(gbrainPath, ['link', from, to, '--link-type', linkType]);
}

// gbrain timeline-add <slug> <date> <text>
export function gbrainTimelineAdd(gbrainPath: string, slug: string, date: string, text: string): GbrainResult {
  return runGbrain(gbrainPath, ['timeline-add', slug, date, text]);
}

// gbrain graph-query <slug> --type T
export function gbrainGraphQuery(gbrainPath: string, slug: string, type?: string): GbrainResult {
  const args = type ? ['graph-query', slug, '--type', type] : ['graph-query', slug];
  return runGbrain(gbrainPath, args);
}

// gbrain stats
export function gbrainStats(gbrainPath: string): GbrainResult {
  return runGbrain(gbrainPath, ['stats']);
}

// 从 gbrain get 的文本输出中解析 frontmatter
export function parseGbrainGetOutput(text: string): { frontmatter: JsonRecord; body: string } {
  const frontmatter: JsonRecord = {};
  let body = text;
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match) {
    body = match[2];
    for (const line of match[1].split('\n')) {
      const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (kv) {
        let value: unknown = kv[2].trim();
        // 剥离 YAML 单引号或双引号包裹
        if (typeof value === 'string' && value.length >= 2) {
          if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
            value = value.slice(1, -1);
          }
        }
        // 简单 YAML 数组: [a, b]
        if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
          value = value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
        }
        frontmatter[kv[1]] = value;
      }
    }
  }
  return { frontmatter, body };
}
