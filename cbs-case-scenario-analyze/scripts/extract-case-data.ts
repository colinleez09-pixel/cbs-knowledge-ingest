#!/usr/bin/env bun
/**
 * extract-case-data.ts
 * Phase 1 Step 1: 从历史用例 JSON 提取结构化中间数据
 *
 * 职责（确定性）：
 * - 解析历史用例 JSON 文件，提取 Basic_Info 和 Test_Steps
 * - 解析接口文档和公共结构文档，构建 Element 定义表和字段路径映射
 * - 接口字段预过滤：仅保留用例实际调用接口（rTpl）相关的 Element 表，控制 case-data.json 体量
 * - 加载步骤资产 JSON（三级策略：--step-assets-dir 目录 → API（预留）→ GBrain 页 source_path 本地文件）
 * - 脚本化指纹匹配：case_step 名称 + 组件序列 + 接口模板（rTpl）三重指纹
 * - 脚本化参数 Delta 计算：用例步骤与资产步骤的变量级对比（add/remove/modify）
 * - 从 GBrain 列出已有场景页（Brain-First 判重依据）
 *
 * 用法：
 *   bun extract-case-data.ts --case-dir <dir> [--case-file <file>]
 *     [--interface-doc <md>] [--common-structure-doc <md>]
 *     [--step-assets-dir <dir>] [--asset-api-url <url>] [--asset-api-user <u>] [--asset-api-pass <p>]
 *     [--out <case-data.json>] [--out-dir <dir>] [--gbrain <gbrain>]
 *
 * 输出目录策略：
 *   - 如果指定 --out，直接写入该文件
 *   - 如果指定 --out-dir，在该目录下创建 case-data.json
 *   - 如果都未指定，在用例文件所在目录下创建 cbs-scenario-analyze-<timestamp>/case-data.json
 *   - 脚本会在输出目录下同时写入 output-dir.txt，记录实际路径
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import {
  asArray,
  asNullableString,
  asString,
  buildFieldTree,
  buildVariableGraph,
  canonicalJson,
  computeFieldPatches,
  deepClone,
  extractVariableName,
  gbrainGet,
  gbrainList,
  isExpression,
  isRecord,
  detectSpecialValue,
  isVariableRef,
  matchStepToAssets,
  normalizeTemplateName,
  parseGbrainGetOutput,
  parseStepAssetJson,
  parseVarsString,
  sha256,
  siteKeyFromId,
  type CaseBasicInfo,
  type CaseComponent,
  type CaseDataFile,
  type CaseStep,
  type FieldTreeEntry,
  type InterfaceFieldsFile,
  type JsonRecord,
  type ParsedCase,
  type ScriptPatchItem,
  type StepAssetJson,
  type StepFingerprint,
  type StepMatchResult,
  type VariableGraph,
} from './scenario-core.ts';
import { fetchAssetsByApiAsync } from './fetch-asset-by-id.ts';

// API 配置（与 test_export_api.py 一致，写死默认值）
const DEFAULT_API_URL = 'http://localhost:5000';
const DEFAULT_API_USER = 'l30026488';
const DEFAULT_API_PASS = 'lz909321*';

interface CliArgs {
  caseDir: string | null;
  caseFile: string | null;
  interfaceDoc: string | null;
  commonStructureDoc: string | null;
  stepAssetsDir: string | null;
  assetApiUrl: string | null;
  assetApiUser: string | null;
  assetApiPass: string | null;
  assetIds: string | null;
  out: string | null;
  outDir: string | null;
  gbrain: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    caseDir: null,
    caseFile: null,
    interfaceDoc: null,
    commonStructureDoc: null,
    stepAssetsDir: null,
    assetApiUrl: null,
    assetApiUser: null,
    assetApiPass: null,
    assetIds: null,
    out: null,
    outDir: null,
    gbrain: 'gbrain',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--case-dir') args.caseDir = argv[++i] ?? '';
    else if (arg === '--case-file') args.caseFile = argv[++i] ?? '';
    else if (arg === '--interface-doc') args.interfaceDoc = argv[++i] ?? '';
    else if (arg === '--common-structure-doc') args.commonStructureDoc = argv[++i] ?? '';
    else if (arg === '--step-assets-dir') args.stepAssetsDir = argv[++i] ?? '';
    else if (arg === '--asset-api-url') args.assetApiUrl = argv[++i] ?? '';
    else if (arg === '--asset-api-user') args.assetApiUser = argv[++i] ?? '';
    else if (arg === '--asset-api-pass') args.assetApiPass = argv[++i] ?? '';
    else if (arg === '--asset-ids') args.assetIds = argv[++i] ?? '';
    else if (arg === '--out') args.out = argv[++i] ?? '';
    else if (arg === '--out-dir') args.outDir = argv[++i] ?? '';
    else if (arg === '--gbrain') args.gbrain = argv[++i] ?? 'gbrain';
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        `CBS 用例数据提取器\n\n用法:\n  bun extract-case-data.ts --case-dir <dir> [--case-file <file>] [--interface-doc <md>] [--common-structure-doc <md>] [--step-assets-dir <dir>] [--asset-api-url <url>] [--out <case-data.json>] [--out-dir <dir>] [--gbrain <gbrain>]\n`,
      );
      process.exit(0);
    } else throw new Error(`unknown arg: ${arg}`);
  }
  if (!args.caseDir && !args.caseFile) throw new Error('must provide --case-dir or --case-file');
  return args;
}

// ─── 输出路径计算 ─────────────────────────────────────────

function resolveOutputPath(args: CliArgs, caseFilePaths: string[]): string {
  if (args.out) return resolve(args.out);

  let baseDir: string;
  if (args.outDir) {
    baseDir = resolve(args.outDir);
  } else {
    if (caseFilePaths.length > 0) {
      baseDir = dirname(caseFilePaths[0]);
    } else if (args.interfaceDoc) {
      baseDir = dirname(resolve(args.interfaceDoc));
    } else {
      baseDir = resolve('.');
    }
  }

  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outDir = join(baseDir, `cbs-scenario-analyze-${timestamp}`);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return join(outDir, 'case-data.json');
}

// ─── 用例 JSON 解析 ──────────────────────────────────────

function parseCaseFile(filePath: string): ParsedCase {
  const raw = readFileSync(filePath, 'utf8');
  const sourceHash = sha256(raw);
  const data = JSON.parse(raw);

  const caseId = asString(data.Testcase_ID);
  const caseName = asString(data.Testcase_Name);

  const bi = isRecord(data.Basic_Info) ? data.Basic_Info : {};
  const basicInfo: CaseBasicInfo = {
    case_id: caseId,
    case_name: caseName,
    case_description: asString(bi['Testcase_Design Description'] ?? bi.Testcase_Design_Description ?? ''),
    product_name: asString(bi.product_name),
    product_id: asString(bi.product_id),
    site_name: asString(bi.site_name),
    site_id: asString(bi.site_id),
    site_version: asString(bi.site_version),
    based_on_baseline_version: asNullableString(bi.based_on_baseline_version),
    exported_at: asNullableString(bi.exported_at),
    handler: asString(bi.Testcase_Handler),
    designer: asString(bi.Testcase_Designer),
    test_steps_description: asString(bi['Testcase_Test Steps'] ?? bi.Testcase_Test_Steps ?? ''),
    expected_result: asString(bi['Testcase_Expected Result'] ?? bi.Testcase_Expected_Result ?? ''),
    result: asString(bi.Testcase_Result),
  };

  const rawSteps = asArray(data.Test_Steps);
  const steps: CaseStep[] = rawSteps.map((rawStep, idx) => {
    const stepRec = isRecord(rawStep) ? rawStep : {};
    const rawComponents = asArray(stepRec.case_option);
    const components: CaseComponent[] = rawComponents
      .filter((c) => isRecord(c))
      .map((c) => {
        const comp = c as JsonRecord;
        return {
          aw_alias: asString(comp.aw_alias),
          is_commented: Boolean(comp.is_commented),
          is_old_aw: Boolean(comp.is_old_aw),
          aw_step: Number(comp.aw_step ?? 0),
          option_parameter: isRecord(comp.option_parameter) ? comp.option_parameter : {},
        };
      });

    return {
      case_step: asString(stepRec.case_step),
      step_memo: asNullableString(stepRec.step_memo),
      components,
      step_index: idx,
    };
  });

  return {
    case_id: caseId,
    case_name: caseName,
    basic_info: basicInfo,
    steps,
    source_file: filePath.split(/[\\/]/).pop() ?? filePath,
    source_path: filePath,
    source_hash: sourceHash,
  };
}

// ─── 步骤指纹生成 ─────────────────────────────────────────

function generateStepFingerprint(step: CaseStep): StepFingerprint {
  const componentSequence: string[] = [];
  const variableNames: string[] = [];
  const soapFieldPaths: string[] = [];
  const fieldToVar: Record<string, string> = {};
  const fieldToLiteral: Record<string, string> = {};
  let interfaceTemplate: string | null = null;
  let interfaceEndpoint: string | null = null;

  for (const comp of step.components) {
    componentSequence.push(comp.aw_alias);

    if (comp.aw_alias === 'TableSetVar') {
      const parsed = parseVarsString(asString(comp.option_parameter.vars));
      for (const [name, value] of Object.entries(parsed)) {
        variableNames.push(name);
        if (value && isVariableRef(value)) {
          fieldToVar[`vars.${name}`] = extractVariableName(value) ?? value;
        } else if (value) {
          fieldToLiteral[`vars.${name}`] = value;
        }
      }
    }

    if (comp.aw_alias === 'SoapClient') {
      const rTpl = asString(comp.option_parameter.rTpl);
      if (rTpl) {
        interfaceTemplate = normalizeTemplateName(rTpl);
      }
      // rReq: build full field tree with dot-notation paths
      const rReqRaw = comp.option_parameter.rReq;
      if (rReqRaw != null) {
        const rReqObj = typeof rReqRaw === 'string' ? (() => { try { return JSON.parse(rReqRaw); } catch { return null; } })() : rReqRaw;
        if (rReqObj && typeof rReqObj === 'object') {
          const tree = buildFieldTree(rReqObj);
          for (const [path, val] of tree) {
            if (!soapFieldPaths.includes(path)) soapFieldPaths.push(path);
            if (isVariableRef(val)) {
              fieldToVar[`rReq.${path}`] = extractVariableName(val) ?? val;
              const varName = extractVariableName(val);
              if (varName && !variableNames.includes(varName)) variableNames.push(varName);
            } else if (val) {
              fieldToLiteral[`rReq.${path}`] = val;
            }
          }
        }
      }
      // rRsp: extract field paths for fingerprint matching
      const rRspRaw = comp.option_parameter.rRsp;
      if (rRspRaw != null) {
        const rRspObj = typeof rRspRaw === 'string' ? (() => { try { return JSON.parse(rRspRaw); } catch { return null; } })() : rRspRaw;
        if (rRspObj && typeof rRspObj === 'object') {
          const tree = buildFieldTree(rRspObj);
          for (const [path, val] of tree) {
            if (!soapFieldPaths.includes(path)) soapFieldPaths.push(path);
            if (isVariableRef(val)) {
              fieldToVar[`rRsp.${path}`] = extractVariableName(val) ?? val;
              const varName = extractVariableName(val);
              if (varName && !variableNames.includes(varName)) variableNames.push(varName);
            }
          }
        }
      }
      // rVars: extract variable references
      const rVarsStr = asString(comp.option_parameter.rVars);
      if (rVarsStr) {
        for (const m of rVarsStr.matchAll(/\$\{([^}]+)\}/g)) {
          if (!variableNames.includes(m[1])) variableNames.push(m[1]);
        }
      }
    }

    if (comp.aw_alias === 'DataBaseQuery' || comp.aw_alias === 'DataBaseModify') {
      const tableName = asString(comp.option_parameter.tableName);
      if (tableName) interfaceEndpoint = tableName;
      const varsStr = asString(comp.option_parameter.vars);
      if (varsStr) {
        for (const part of varsStr.split(';')) {
          const pipeIdx = part.indexOf('|');
          if (pipeIdx > 0) {
            const alias = part.slice(pipeIdx + 1).trim();
            if (alias && !variableNames.includes(alias)) variableNames.push(alias);
          }
        }
      }
      // Extract variable references from sql
      const sql = asString(comp.option_parameter.sql);
      if (sql) {
        for (const m of sql.matchAll(/\$\{([^}]+)\}/g)) {
          if (!variableNames.includes(m[1])) variableNames.push(m[1]);
          fieldToVar[`sql`] = m[1];
        }
      }
    }

    if (comp.aw_alias === 'ShellExecute') {
      const cmd = asString(comp.option_parameter.cmd);
      if (cmd) {
        for (const m of cmd.matchAll(/\$\{([^}]+)\}/g)) {
          if (!variableNames.includes(m[1])) variableNames.push(m[1]);
        }
      }
      const shellChecks = comp.option_parameter.shellChecks;
      if (Array.isArray(shellChecks)) {
        for (const check of shellChecks) {
          const checkStr = JSON.stringify(check);
          for (const m of checkStr.matchAll(/\$\{([^}]+)\}/g)) {
            if (!variableNames.includes(m[1])) variableNames.push(m[1]);
          }
        }
      }
    }

    // Generic: scan all option_parameter string values for ${...} references
    for (const [key, val] of Object.entries(comp.option_parameter)) {
      if (typeof val === 'string') {
        for (const m of val.matchAll(/\$\{([^}]+)\}/g)) {
          if (!variableNames.includes(m[1])) variableNames.push(m[1]);
        }
      }
    }
  }

  const fingerprintHash = sha256(
    canonicalJson({
      component_sequence: componentSequence,
      interface_template: interfaceTemplate,
      interface_endpoint: interfaceEndpoint,
    }),
  );

  return {
    step_name: step.case_step,
    component_sequence: componentSequence,
    interface_template: interfaceTemplate,
    interface_endpoint: interfaceEndpoint,
    variable_names: [...new Set(variableNames)],
    soap_field_paths: [...new Set(soapFieldPaths)],
    field_to_var: fieldToVar,
    field_to_literal: fieldToLiteral,
    fingerprint_hash: fingerprintHash,
  };
}

// normalizeTemplateName 统一由 scenario-core.ts 提供

// ─── 接口文档解析 ────────────────────────────────────────

function parseInterfaceDoc(docPath: string, commonStructurePath: string | null): {
  interfaceFields: InterfaceFieldsFile['interface_fields'];
  fieldMapping: Record<string, string>;
} {
  const content = readFileSync(docPath, 'utf8');
  const interfaceFields: InterfaceFieldsFile['interface_fields'] = {};
  const fieldMapping: Record<string, string> = {};

  const commonElements: InterfaceFieldsFile['interface_fields'] = {};
  if (commonStructurePath && existsSync(commonStructurePath)) {
    const commonContent = readFileSync(commonStructurePath, 'utf8');
    parseElementTables(commonContent, commonElements, fieldMapping);
  }

  parseElementTables(content, interfaceFields, fieldMapping);

  for (const [name, data] of Object.entries(commonElements)) {
    if (!interfaceFields[name]) {
      interfaceFields[name] = data;
    }
  }

  for (const [, ifaceData] of Object.entries(interfaceFields)) {
    for (const elem of ifaceData.elements) {
      const varName = elem.name;
      if (varName && !fieldMapping[varName]) {
        fieldMapping[varName] = elem.path;
      }
    }
  }

  return { interfaceFields, fieldMapping };
}

function parseElementTables(
  content: string,
  target: InterfaceFieldsFile['interface_fields'],
  fieldMapping: Record<string, string>,
): void {
  const lines = content.split('\n');
  let currentInterface = '';
  let inTable = false;
  let headers: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    const headerMatch = trimmed.match(/^#+\s*(.+)/);
    if (headerMatch) {
      const title = headerMatch[1].trim();
      if (!title.includes('|')) {
        currentInterface = title;
      }
    }

    const tableLabelMatch = trimmed.match(/^\*+\s*(?:表\s*\d+\s*)?(?:Element\s+)?(.+?)\s*\*+$/);
    if (tableLabelMatch) {
      const label = tableLabelMatch[1].trim();
      if (label && !label.includes('|')) {
        currentInterface = label;
      }
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
      if (!inTable) {
        headers = cells;
        inTable = true;
        continue;
      }
      if (cells.every((c) => /^[-:]+$/.test(c))) continue;

      if (headers.length >= 2 && cells.length >= 2) {
        const nameIdx = headers.findIndex((h) => /name|element|参数|字段/i.test(h));
        const pathIdx = headers.findIndex((h) => /path|xpath|field\s*path|node|路径/i.test(h));
        const typeIdx = headers.findIndex((h) => /type|data\s*type|数据类型|类型/i.test(h));
        const descIdx = headers.findIndex((h) => /desc|description|meaning|remark|参数描述|描述|说明/i.test(h));

        const name = nameIdx >= 0 ? cells[nameIdx] : cells[0];
        const type = typeIdx >= 0 ? cells[typeIdx] : (cells[1] ?? '');
        const desc = descIdx >= 0 ? cells[descIdx] : '';
        const path = pathIdx >= 0 ? cells[pathIdx] : name;

        if (name) {
          const key = currentInterface || 'default';
          if (!target[key]) target[key] = { elements: [] };
          target[key].elements.push({ name, path, type, description: desc });
          if (name.startsWith('My_') || name.startsWith('Var_')) {
            fieldMapping[name] = path;
          }
        }
      }
    } else {
      inTable = false;
      headers = [];
    }
  }
}

// 接口字段预过滤：只保留用例 rTpl 涉及的接口 Element 表
function filterRelevantInterfaceFields(
  interfaceFields: InterfaceFieldsFile['interface_fields'],
  usedTemplates: Set<string>,
): InterfaceFieldsFile['interface_fields'] {
  if (usedTemplates.size === 0) return interfaceFields;
  const normalizedUsed = new Set([...usedTemplates].map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const result: InterfaceFieldsFile['interface_fields'] = {};
  for (const [name, data] of Object.entries(interfaceFields)) {
    const normKey = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const matched =
      [...normalizedUsed].some((t) => normKey.includes(t) || t.includes(normKey)) ||
      // 字段名重叠兜底：接口表中有 >=3 个字段名出现在用例字段路径中
      data.elements.filter((e) => normalizedUsed.has(e.name.toLowerCase().replace(/[^a-z0-9]/g, ''))).length >= 3;
    if (matched) result[name] = data;
  }
  return result;
}

// ─── 步骤资产加载（三级策略） ─────────────────────────────
// 优先级：API（用 GBrain 提取的 asset_id）> --step-assets-dir 目录 > GBrain 页 source_path 本地文件

interface AssetLoadResult {
  assets: StepAssetJson[];
  assetSlugs: Record<string, string>; // asset_id -> gbrain slug
  source: CaseDataFile['extraction_meta']['asset_source'];
  gbrainAssetCount: number;
  gbrainAssetIds: string[];
  apiUrl: string | null;
}

function loadAssetsFromDir(dir: string): StepAssetJson[] {
  const resolved = resolve(dir);
  if (!existsSync(resolved)) {
    console.error(`[extract] WARNING: step-assets dir not found: ${resolved}`);
    return [];
  }
  const files = readdirSync(resolved).filter((f) => f.endsWith('.json'));
  const assets: StepAssetJson[] = [];
  for (const file of files) {
    const filePath = join(resolved, file);
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!isRecord(raw)) continue;
      assets.push(parseStepAssetJson(raw, { sourceKind: 'dir', sourceFile: file }));
    } catch (e) {
      console.error(`[extract] WARNING: failed to parse asset file ${file}: ${e}`);
    }
  }
  console.error(`[extract] loaded ${assets.length} step assets from dir: ${resolved}`);
  return assets;
}

// 从 GBrain 页 frontmatter 提取 asset_id / source_path，并建立 asset_id -> slug 映射
function loadAssetMetaFromGbrain(gbrain: string): {
  slugToMeta: Record<string, { asset_id: string; source_path: string | null }>;
  assetIdToSlug: Record<string, string>;
} {
  const slugToMeta: Record<string, { asset_id: string; source_path: string | null }> = {};
  const assetIdToSlug: Record<string, string> = {};

  const prefixes = ['cbs/test-step', 'cbs-test-step', 'test-step'];
  let items: { slug: string; title: string }[] = [];
  for (const pfx of prefixes) {
    const result = gbrainList(gbrain, pfx);
    console.error(`[extract] gbrain list "${pfx}": ${result.items.length} pages`);
    if (result.items.length > 0) {
      items = result.items;
      break;
    }
  }

  for (const item of items) {
    try {
      const getResult = gbrainGet(gbrain, item.slug);
      if (!getResult.success) continue;
      const { frontmatter } = parseGbrainGetOutput(getResult.stdout);
      const assetId = asString(frontmatter.asset_id);
      const sourcePath = asNullableString(frontmatter.source_path);
      slugToMeta[item.slug] = { asset_id: assetId, source_path: sourcePath };
      if (assetId) assetIdToSlug[assetId] = item.slug;
    } catch (e) {
      console.error(`[extract] WARNING: gbrain get ${item.slug} failed: ${e}`);
    }
  }
  return { slugToMeta, assetIdToSlug };
}

async function loadAssets(args: CliArgs): Promise<AssetLoadResult> {
  // 先建立 GBrain slug 映射（无论资产从哪加载，slug 映射都用于页面 wikilink）
  let assetIdToSlug: Record<string, string> = {};
  let slugToMeta: Record<string, { asset_id: string; source_path: string | null }> = {};
  try {
    const meta = loadAssetMetaFromGbrain(args.gbrain);
    assetIdToSlug = meta.assetIdToSlug;
    slugToMeta = meta.slugToMeta;
  } catch (e) {
    console.error(`[extract] WARNING: failed to load asset meta from GBrain: ${e}`);
  }

  const gbrainAssetIds = Object.keys(assetIdToSlug);
  const gbrainAssetCount = gbrainAssetIds.length;

  // 策略 0（最高优先级）：--asset-ids 直接指定 ID → 调 API 获取
  const apiUrl = args.assetApiUrl || DEFAULT_API_URL;
  const apiUser = args.assetApiUser || DEFAULT_API_USER;
  const apiPass = args.assetApiPass || DEFAULT_API_PASS;
  const cliAssetIds = args.assetIds ? args.assetIds.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (cliAssetIds.length > 0) {
    console.error(`[extract] --asset-ids provided: ${cliAssetIds.length} IDs, fetching from API (${apiUrl})`);
    try {
      const apiAssets = await fetchAssetsByApiAsync({
        apiUrl,
        username: apiUser,
        password: apiPass,
        assetIds: cliAssetIds,
      });
      const assets: StepAssetJson[] = [];
      for (const assetId of cliAssetIds) {
        const raw = apiAssets[assetId];
        if (!isRecord(raw)) {
          console.error(`[extract] WARNING: API returned no data for asset_id ${assetId}`);
          continue;
        }
        try {
          assets.push(
            parseStepAssetJson(raw, {
              sourceKind: 'api',
              sourceFile: `api:${assetId}`,
              sourcePath: assetIdToSlug[assetId] ? slugToMeta[assetIdToSlug[assetId]]?.source_path ?? null : null,
            }),
          );
        } catch (e) {
          console.error(`[extract] WARNING: failed to parse API asset ${assetId}: ${e}`);
        }
      }
      if (assets.length > 0) {
        console.error(`[extract] loaded ${assets.length} step assets from API via --asset-ids (${apiUrl})`);
        return { assets, assetSlugs: assetIdToSlug, source: 'api', gbrainAssetCount, gbrainAssetIds, apiUrl };
      }
      console.error(`[extract] --asset-ids API fetch returned 0 parseable assets`);
    } catch (e) {
      console.error(`[extract] WARNING: --asset-ids API fetch failed (${apiUrl}): ${e}`);
    }
  }

  // 策略 1：GBrain 获取 asset_id → 调 API 获取 JSON
  if (gbrainAssetIds.length > 0) {
    try {
      const apiAssets = await fetchAssetsByApiAsync({
        apiUrl,
        username: apiUser,
        password: apiPass,
        assetIds: gbrainAssetIds,
      });
      const assets: StepAssetJson[] = [];
      for (const [assetId, raw] of Object.entries(apiAssets)) {
        if (!isRecord(raw)) continue;
        try {
          assets.push(
            parseStepAssetJson(raw, {
              sourceKind: 'api',
              sourceFile: `api:${assetId}`,
              sourcePath: slugToMeta[assetIdToSlug[assetId]]?.source_path ?? null,
            }),
          );
        } catch (e) {
          console.error(`[extract] WARNING: failed to parse API asset ${assetId}: ${e}`);
        }
      }
      if (assets.length > 0) {
        console.error(`[extract] loaded ${assets.length} step assets from API (${apiUrl})`);
        return { assets, assetSlugs: assetIdToSlug, source: 'api', gbrainAssetCount, gbrainAssetIds, apiUrl };
      }
      console.error(`[extract] API returned no parseable assets, falling through to --step-assets-dir`);
    } catch (e) {
      console.error(`[extract] WARNING: API fetch failed (${apiUrl}): ${e}`);
      console.error(`[extract] falling through to --step-assets-dir / source_path`);
    }
  } else {
    console.error(`[extract] no asset_ids from GBrain pages, API strategy skipped`);
  }

  // 策略 2：--step-assets-dir 本地目录（fallback）
  if (args.stepAssetsDir) {
    const assets = loadAssetsFromDir(args.stepAssetsDir);
    if (assets.length > 0) {
      console.error(`[extract] loaded ${assets.length} step assets from local dir: ${args.stepAssetsDir}`);
      return { assets, assetSlugs: assetIdToSlug, source: 'dir', gbrainAssetCount, gbrainAssetIds, apiUrl };
    }
    console.error('[extract] step-assets dir empty or no valid JSON files');
  }

  // 策略 3：GBrain 页 frontmatter 的 source_path 本地文件（最终 fallback）
  const assets: StepAssetJson[] = [];
  for (const [slug, meta] of Object.entries(slugToMeta)) {
    if (!meta.source_path) continue;
    try {
      if (!existsSync(meta.source_path)) {
        console.error(`[extract] WARNING: source_path not found: ${meta.source_path} (${slug})`);
        continue;
      }
      const raw = JSON.parse(readFileSync(meta.source_path, 'utf8'));
      if (!isRecord(raw)) continue;
      assets.push(
        parseStepAssetJson(raw, {
          sourceKind: 'gbrain-source-path',
          sourceFile: meta.source_path,
          sourcePath: meta.source_path,
        }),
      );
    } catch (e) {
      console.error(`[extract] WARNING: failed to load asset from source_path ${meta.source_path}: ${e}`);
    }
  }
  if (assets.length > 0) {
    console.error(`[extract] loaded ${assets.length} step assets from GBrain source_path`);
    return { assets, assetSlugs: assetIdToSlug, source: 'gbrain-source-path', gbrainAssetCount, gbrainAssetIds, apiUrl };
  }

  console.error('[extract] WARNING: no step assets loaded from any source');
  console.error(`[extract] GBrain found ${gbrainAssetCount} asset pages with asset_ids: ${gbrainAssetIds.length > 0 ? gbrainAssetIds.map(id => id.slice(0,8) + '...').join(', ') : '(none)'}`);
  return { assets: [], assetSlugs: assetIdToSlug, source: 'none', gbrainAssetCount, gbrainAssetIds, apiUrl };
}

// ─── Brain-First: 列出已有场景页面 ──────────────────────

function listExistingScenarios(gbrain: string, siteKey: string | null): CaseDataFile['existing_scenarios'] {
  const scenarios: CaseDataFile['existing_scenarios'] = [];
  try {
    const { items } = gbrainList(gbrain, 'cbs-scenario-pattern');
    for (const item of items) {
      if (siteKey && !item.slug.includes(siteKey)) continue;
      scenarios.push({ slug: item.slug, title: item.title || item.slug });
    }
    console.error(`[extract] found ${scenarios.length} existing scenario pages in GBrain`);
  } catch (e) {
    console.error(`[extract] WARNING: failed to list existing scenarios: ${e}`);
  }
  return scenarios;
}

// ─── 主流程 ──────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let caseFilePaths: string[] = [];
  if (args.caseFile) {
    caseFilePaths = [resolve(args.caseFile)];
  } else if (args.caseDir) {
    const dir = resolve(args.caseDir);
    if (!existsSync(dir)) throw new Error(`case directory not found: ${dir}`);
    caseFilePaths = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(dir, f));
  }

  if (caseFilePaths.length === 0) {
    throw new Error('no case JSON files found');
  }

  console.error(`[extract] found ${caseFilePaths.length} case files`);

  const outPath = resolveOutputPath(args, caseFilePaths);
  const outDirPath = dirname(outPath);
  if (!existsSync(outDirPath)) mkdirSync(outDirPath, { recursive: true });
  console.error(`[extract] output directory: ${outDirPath}`);

  const parsedCases = caseFilePaths.map((fp) => {
    if (!existsSync(fp)) throw new Error(`case file not found: ${fp}`);
    return parseCaseFile(fp);
  });

  let primarySiteKey: string | null = null;
  if (parsedCases.length > 0) {
    const first = parsedCases[0];
    primarySiteKey = siteKeyFromId(first.basic_info.site_id, first.basic_info.site_name);
  }
  console.error(`[extract] site key: ${primarySiteKey ?? 'unknown'}`);

  let interfaceFields: InterfaceFieldsFile['interface_fields'] = {};
  let fieldMapping: Record<string, string> = {};

  if (args.interfaceDoc && existsSync(args.interfaceDoc)) {
    console.error('[extract] parsing interface doc...');
    const parsed = parseInterfaceDoc(args.interfaceDoc, args.commonStructureDoc);
    interfaceFields = parsed.interfaceFields;
    fieldMapping = parsed.fieldMapping;
    console.error(`[extract] parsed ${Object.keys(interfaceFields).length} interfaces, ${Object.keys(fieldMapping).length} field mappings`);
  } else {
    console.error('[extract] no interface doc provided, skipping field mapping');
  }

  // 加载步骤资产（三级策略）
  console.error('[extract] loading step assets...');
  const assetLoad = await loadAssets(args);
  const assets = assetLoad.assets;
  console.error(`[extract] step assets: ${assets.length} (source: ${assetLoad.source})`);

  // 收集用例实际调用的接口模板（用于接口字段预过滤与匹配）
  const usedTemplates = new Set<string>();
  for (const c of parsedCases) {
    for (const s of c.steps) {
      const fp = generateStepFingerprint(s);
      if (fp.interface_template) usedTemplates.add(fp.interface_template);
    }
  }

  // 接口字段预过滤
  if (Object.keys(interfaceFields).length > 0) {
    const before = Object.keys(interfaceFields).length;
    interfaceFields = filterRelevantInterfaceFields(interfaceFields, usedTemplates);
    console.error(
      `[extract] interface field pre-filter: ${before} -> ${Object.keys(interfaceFields).length} interfaces (used templates: ${[...usedTemplates].join(', ') || 'none'})`,
    );
  }

  // Brain-First: 已有场景页
  const existingScenarios = listExistingScenarios(args.gbrain, primarySiteKey);

  // 构建 case-data（含脚本化匹配与 delta）
  const caseData: CaseDataFile = {
    extraction_meta: {
      extracted_at: new Date().toISOString(),
      case_count: parsedCases.length,
      step_asset_count: assets.length,
      existing_scenario_count: existingScenarios.length,
      interface_doc_provided: Boolean(args.interfaceDoc && existsSync(args.interfaceDoc)),
      common_structure_doc_provided: Boolean(args.commonStructureDoc && existsSync(args.commonStructureDoc)),
      asset_source: assetLoad.source,
      asset_load_warning: assetLoad.assets.length === 0
        ? `未加载到任何步骤资产 JSON。GBrain 发现 ${assetLoad.gbrainAssetCount} 个资产页，API（${assetLoad.apiUrl}）获取失败或返回空，--step-assets-dir 未提供或为空，source_path 本地文件不存在。正确流程：GBrain 获取 asset_id → 调 API 获取 JSON。请检查：(1) 资产平台 API 是否运行在 ${assetLoad.apiUrl}；(2) 或通过 --step-assets-dir 提供本地资产 JSON 目录；(3) 或通过 --asset-api-url 指定正确的 API 地址。禁止在 0 资产下继续后续步骤。`
        : null,
    },
    cases: parsedCases.map((c) => ({
      case_id: c.case_id,
      basic_info: {
        case_name: c.basic_info.case_name,
        case_description: c.basic_info.case_description,
        product_name: c.basic_info.product_name,
        product_id: c.basic_info.product_id,
        site_name: c.basic_info.site_name,
        site_id: c.basic_info.site_id,
        site_version: c.basic_info.site_version,
        handler: c.basic_info.handler,
        designer: c.basic_info.designer,
        test_steps_description: c.basic_info.test_steps_description,
        expected_result: c.basic_info.expected_result,
        result: c.basic_info.result,
      },
      steps: c.steps.map((s) => {
        const fingerprint = generateStepFingerprint(s);
        // Multi-dimensional matching with score breakdown
        const match: StepMatchResult = matchStepToAssets(
          s.case_step,
          fingerprint.component_sequence,
          fingerprint.interface_template,
          fingerprint.soap_field_paths,
          assets,
          assetLoad.assetSlugs,
        );
        match.step_index = s.step_index;

        // Field-level patch computation (replaces old block-level delta)
        let scriptPatches: ScriptPatchItem[] = [];
        if (match.matched_asset_id) {
          const asset = assets.find((a) => a.asset_id === match.matched_asset_id);
          if (asset) scriptPatches = computeFieldPatches(s, asset);
        }

        // Build field trees for each component
        const fieldTrees: Record<string, FieldTreeEntry[]> = {};
        for (const comp of s.components) {
          const entries: FieldTreeEntry[] = [];
          for (const [key, val] of Object.entries(comp.option_parameter)) {
            if (val != null && typeof val === 'object' && !Array.isArray(val)) {
              const tree = buildFieldTree(val);
              for (const [path, strVal] of tree) {
                entries.push({
                  path: `${key}.${path}`,
                  value: strVal,
                  is_variable_ref: isVariableRef(strVal),
                  variable_name: extractVariableName(strVal),
                  is_special_value: detectSpecialValue(strVal),
                  is_expression: isExpression(strVal),
                });
              }
            } else if (typeof val === 'string') {
              entries.push({
                path: key,
                value: val,
                is_variable_ref: isVariableRef(val),
                variable_name: extractVariableName(val),
                is_special_value: detectSpecialValue(val),
                is_expression: isExpression(val),
              });
            }
          }
          fieldTrees[comp.aw_alias] = entries;
        }

        return {
          step_index: s.step_index,
          step_name: s.case_step,
          step_memo: s.step_memo,
          components: s.components.map((comp) => ({
            aw_alias: comp.aw_alias,
            is_commented: comp.is_commented,
            is_old_aw: comp.is_old_aw,
            aw_step: comp.aw_step,
            option_parameter: comp.option_parameter,
          })),
          fingerprint,
          match,
          script_patches: scriptPatches,
          field_trees: fieldTrees,
          variable_inputs: [],
          variable_outputs: [],
        };
      }),
      source_file: c.source_file,
      source_hash: c.source_hash,
    })),
    step_assets: assets.map((a) => ({
      asset_id: a.asset_id,
      name: a.name,
      slug: assetLoad.assetSlugs[a.asset_id] ?? null,
      interface_template: a.interface_template,
      component_sequence: a.component_sequence,
      open_parameter_names: Object.entries(a.parameter_meta)
        .filter(([, v]) => v.is_open === true)
        .map(([k]) => k),
      vars: a.vars,
      parameter_meta: a.parameter_meta,
      source_kind: a.source_kind,
      source_path: a.source_path,
      full_json: deepClone(a) as JsonRecord,
    })),
    variable_graph: { nodes: [], dependencies: [], unresolved_variables: [] } as VariableGraph,
    interface_catalog: Object.entries(interfaceFields).map(([name, data]) => ({
      interface: name,
      element_count: data.elements.length,
    })),
    interface_fields_file: Object.keys(interfaceFields).length > 0 ? 'interface-fields.json' : null,
    existing_scenarios: existingScenarios,
  };

  writeFileSync(outPath, JSON.stringify(caseData, null, 2), 'utf8');

  // 接口字段明细写到独立文件（AI 禁止全量读取，用 lookup-field-info.ts 按需查询）
  if (Object.keys(interfaceFields).length > 0) {
    const fieldsFile: InterfaceFieldsFile = {
      generated_at: new Date().toISOString(),
      interface_count: Object.keys(interfaceFields).length,
      interface_fields: interfaceFields,
      field_mapping: fieldMapping,
    };
    writeFileSync(join(outDirPath, 'interface-fields.json'), JSON.stringify(fieldsFile, null, 2), 'utf8');
  }

  const outputDirFile = join(outDirPath, 'output-dir.txt');
  writeFileSync(outputDirFile, outDirPath, 'utf8');

  const matchedCount = caseData.cases.reduce(
    (sum, c) => sum + c.steps.filter((s) => s.match.match_status !== 'none').length,
    0,
  );
  const totalSteps = caseData.cases.reduce((sum, c) => sum + c.steps.length, 0);
  const patchCount = caseData.cases.reduce((sum, c) => sum + c.steps.reduce((s2, st) => s2 + st.script_patches.length, 0), 0);

  console.error('');
  console.error('=== extraction complete ===');
  console.error(`  cases: ${caseData.cases.length}`);
  console.error(`  total steps: ${totalSteps}`);
  console.error(`  matched steps: ${matchedCount}/${totalSteps}`);
  console.error(`  script patches: ${patchCount}`);
  console.error(`  step assets: ${caseData.step_assets.length} (source: ${assetLoad.source})`);
  console.error(`  existing scenarios: ${existingScenarios.length}`);
  console.error(`  interface catalog: ${caseData.interface_catalog.length} interfaces`);
  console.error(`  output: ${outPath}`);
  if (assets.length === 0) {
    console.error('');
    console.error('[extract] !!!!! 阻断级警告：未加载到任何步骤资产 !!!!!');
    console.error(`[extract] GBrain 发现 ${assetLoad.gbrainAssetCount} 个资产页，但 API（${assetLoad.apiUrl}）获取失败，--step-assets-dir 未提供，source_path 本地文件不存在。`);
    console.error('[extract] 正确流程：GBrain 获取资产页 → 提取 asset_id → 调 API 获取 JSON 数据进行比对。');
    console.error('[extract] 必须先确认资产来源并补参重跑本脚本，禁止继续后续步骤：');
    console.error('[extract]   方式1（推荐）: 确认资产平台 API 运行在 ' + assetLoad.apiUrl + '（脚本自动按 GBrain asset_id 调 API 拉取 JSON）');
    console.error('[extract]   方式2: --asset-api-url <正确API地址>（如 API 不在默认地址）');
    console.error('[extract]   方式3: --step-assets-dir <本地资产JSON目录>（离线 fallback）');
  }
  console.error('');
  console.error('[extract] NEXT: 运行 init-analysis-draft.ts 生成 AI 填空骨架（analysis-draft.json + analysis-notes.md + page-*.md）');
  console.log(JSON.stringify({
    output_file: outPath,
    output_dir: outDirPath,
    matched_steps: matchedCount,
    total_steps: totalSteps,
    step_assets_loaded: assets.length,
    asset_load_blocked: assets.length === 0,
    asset_load_warning: assets.length === 0
      ? `0 个步骤资产已加载：GBrain 发现 ${assetLoad.gbrainAssetCount} 个资产页但 API（${assetLoad.apiUrl}）获取失败，source_path 本地文件不存在。正确流程：GBrain asset_id → API JSON。请确认 API 地址或提供 --step-assets-dir 后重跑。`
      : null,
    interface_fields_file: caseData.interface_fields_file,
  }));
}

main().catch((e) => {
  console.error(`[extract] FATAL: ${e}`);
  process.exit(1);
});
