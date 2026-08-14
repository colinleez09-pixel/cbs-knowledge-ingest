#!/usr/bin/env bun
/**
 * fetch-asset-by-id.ts
 * 通过测试资产平台 API 按资产 ID 获取步骤资产 JSON
 *
 * API 契约（test_export_api.py 真实实现）：
 *   1. POST {base_url}/api/auth/login  body: {"username": ..., "password": ...}
 *      → response.data.success === true, token = response.data.data.token
 *   2. GET  {base_url}/api/test-steps/{asset_id}/export
 *      header: Authorization: Bearer {token}
 *      → response: {step: {id, name, template_json, ...}, version, type, exported_at, ...}
 *
 * 用法（独立 CLI）：
 *   bun fetch-asset-by-id.ts --api-url <url> --asset-id <id> [--asset-id <id2> ...]
 *     [--username <user>] [--password <pwd>] [--out-dir <dir>]
 *
 * 输出：
 *   stdout: JSON 结果 {"status": "success", "assets": {asset_id: {...}}, "saved": [...]}
 *   --out-dir 指定时同时把每个资产写入 <out-dir>/<asset_name>.json
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { asArray, asString, isRecord, sha256, type AssetFetchManifest, type AssetManifestEntry, type JsonRecord } from './scenario-core.ts';

export interface FetchAssetsOptions {
  apiUrl: string;
  username: string;
  password: string;
  assetIds: string[];
  timeoutMs?: number;
}

/**
 * 登录获取 token
 * POST {base_url}/api/auth/login {username, password} → data.data.token
 */
async function loginForToken(baseUrl: string, username: string, password: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`login HTTP ${resp.status}`);
    const data = (await resp.json()) as JsonRecord;
    if (!data.success) throw new Error(`login failed: ${data.error ?? JSON.stringify(data).slice(0, 300)}`);
    const token = isRecord(data.data) ? asString(data.data.token) : '';
    if (!token) throw new Error(`login response missing data.data.token: ${JSON.stringify(data).slice(0, 300)}`);
    return token;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 按资产 ID 导出步骤资产 JSON
 * GET {base_url}/api/test-steps/{asset_id}/export  Authorization: Bearer {token}
 */
async function exportStepById(baseUrl: string, token: string, assetId: string, timeoutMs: number): Promise<JsonRecord | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/test-steps/${assetId}/export`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (resp.status === 404) {
      console.error(`[fetch-asset] WARNING: asset ${assetId} not found (404)`);
      return null;
    }
    if (!resp.ok) throw new Error(`export HTTP ${resp.status} for ${assetId}`);
    const data = (await resp.json()) as JsonRecord;
    if (data.error) throw new Error(`export error for ${assetId}: ${data.error}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 异步实现（extract-case-data.ts 以 await 调用）
 * 按资产 ID 列表批量获取步骤资产 JSON
 */
export async function fetchAssetsByApiAsync(options: FetchAssetsOptions): Promise<Record<string, JsonRecord>> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const baseUrl = options.apiUrl.replace(/\/+$/, '');
  const token = await loginForToken(baseUrl, options.username, options.password, timeoutMs);
  const map: Record<string, JsonRecord> = {};

  for (const assetId of options.assetIds) {
    const item = await exportStepById(baseUrl, token, assetId, timeoutMs);
    if (item) {
      map[assetId] = item;
    }
  }

  const missing = options.assetIds.filter((id) => !map[id]);
  if (missing.length > 0) {
    console.error(`[fetch-asset] WARNING: API did not return ${missing.length} assets: ${missing.join(', ')}`);
  }
  return map;
}

// ─── 独立 CLI ────────────────────────────────────────────

async function mainCli(): Promise<void> {
  const argv = process.argv.slice(2);
  let apiUrl = '';
  let username = '';
  let password = '';
  let outDir: string | null = null;
  const assetIds: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--api-url') apiUrl = argv[++i] ?? '';
    else if (arg === '--asset-id') assetIds.push(argv[++i] ?? '');
    else if (arg === '--username') username = argv[++i] ?? '';
    else if (arg === '--password') password = argv[++i] ?? '';
    else if (arg === '--out-dir') outDir = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        `按资产 ID 从测试资产平台 API 获取步骤资产 JSON\n\n` +
        `API 契约（test_export_api.py）:\n` +
        `  1. POST {base_url}/api/auth/login {username, password} -> data.data.token\n` +
        `  2. GET  {base_url}/api/test-steps/{id}/export  Authorization: Bearer {token}\n\n` +
        `用法:\n` +
        `  bun fetch-asset-by-id.ts --api-url <url> --asset-id <id> [--asset-id <id2>...]\n` +
        `    [--username <user>] [--password <pwd>] [--out-dir <dir>]\n`,
      );
      process.exit(0);
    } else throw new Error(`unknown arg: ${arg}`);
  }

  if (assetIds.length === 0) throw new Error('must provide at least one --asset-id');

  // --- No-API mode: read local files and generate manifest ---
  if (!apiUrl) {
    if (!outDir) throw new Error('must provide --out-dir when no --api-url (local mode)');
    const dir = resolve(outDir);
    const assets: Record<string, JsonRecord> = {};
    const manifestEntries: AssetManifestEntry[] = [];
    let cached = 0;
    let fetched = 0;
    let failed = 0;

    // Scan local dir for JSON files
    const localFiles = existsSync(dir)
      ? readdirSync(dir).filter((f: string) => f.endsWith('.json') && f !== 'asset-manifest.json')
      : [];

    for (const assetId of assetIds) {
      let item: JsonRecord | null = null;
      let localPath: string | null = null;
      let contentHash: string | null = null;

      // Try to find by asset-${id}.json first, then scan all files for matching id
      const exactPath = join(dir, `asset-${assetId}.json`);
      if (existsSync(exactPath)) {
        try {
          const content = readFileSync(exactPath, 'utf8');
          item = JSON.parse(content) as JsonRecord;
          localPath = exactPath;
          contentHash = sha256(content);
        } catch { /* ignore */ }
      }

      if (!item) {
        // Scan all local JSON files for matching id
        for (const fname of localFiles) {
          const fpath = join(dir, fname);
          try {
            const content = readFileSync(fpath, 'utf8');
            const json = JSON.parse(content) as JsonRecord;
            const step = isRecord(json.step) ? json.step : json;
            const components = isRecord(json.step) ? (isRecord(json.step.template_json) ? json.step.template_json : json.step) : json;
            // Check by step.id or by components matching
            if (String(step.id ?? '') === assetId || String(components.asset_id ?? '') === assetId) {
              item = json;
              localPath = fpath;
              contentHash = sha256(content);
              break;
            }
          } catch { /* ignore */ }
        }
      }

      if (item) {
        assets[assetId] = item;
        cached++;
      } else {
        failed++;
      }

      const step = item && (isRecord(item.step) ? item.step : item);
      manifestEntries.push({
        asset_id: assetId,
        asset_name: step ? asString(step.name) : assetId,
        slug: null,
        local_path: localPath,
        content_hash: contentHash,
        fetched: false,
        fetch_error: item ? null : 'not found in local directory',
      });
    }

    const manifest: AssetFetchManifest = {
      generated_at: new Date().toISOString(),
      api_url: '(local)',
      total_assets: assetIds.length,
      fetched,
      cached,
      failed,
      entries: manifestEntries,
    };

    const manifestPath = join(dir, 'asset-manifest.json');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const missing = assetIds.filter((id) => !assets[id]);
    console.log(
      JSON.stringify({
        status: missing.length === 0 ? 'success' : 'partial',
        mode: 'local',
        fetched,
        cached,
        failed,
        missing,
        assets,
        manifest,
      }, null, 2),
    );
    return;
  }

  // --- API mode: fetch from API ---
  if (!username) throw new Error('must provide --username (or omit --api-url for local mode)');
  if (!password) throw new Error('must provide --password (or omit --api-url for local mode)');

  const token = await loginForToken(apiUrl, username, password, 30000);
  const assets: Record<string, JsonRecord> = {};
  const saved: string[] = [];
  const manifestEntries: AssetManifestEntry[] = [];
  let cached = 0;
  let fetched = 0;
  let failed = 0;

  for (const assetId of assetIds) {
    let item: JsonRecord | null = null;
    let localPath: string | null = null;
    let contentHash: string | null = null;
    let fromCache = false;

    // Hash-based caching: check if local file exists
    if (outDir) {
      const dir = resolve(outDir);
      // Try to find existing file by asset_id pattern
      const possiblePath = join(dir, `asset-${assetId}.json`);
      if (existsSync(possiblePath)) {
        try {
          const cachedContent = readFileSync(possiblePath, 'utf8');
          const cachedJson = JSON.parse(cachedContent) as JsonRecord;
          // Verify it's the same asset by checking id
          const step = isRecord(cachedJson.step) ? cachedJson.step : cachedJson;
          if (String(step.id ?? '') === assetId) {
            item = cachedJson;
            localPath = possiblePath;
            contentHash = sha256(cachedContent);
            fromCache = true;
            cached++;
          }
        } catch { /* cache miss, fetch from API */ }
      }
    }

    // Fetch from API if not cached
    if (!item) {
      item = await exportStepById(apiUrl, token, assetId, 30000);
      if (item) {
        fetched++;
        if (outDir) {
          const dir = resolve(outDir);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const content = JSON.stringify(item, null, 2);
          contentHash = sha256(content);
          const filePath = join(dir, `asset-${assetId}.json`);
          writeFileSync(filePath, content, 'utf8');
          localPath = filePath;
          saved.push(filePath);

          // Also save by name for human readability
          const step = isRecord(item.step) ? item.step : item;
          const name = asString(step.name) || assetId;
          const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
          const namePath = join(dir, `${safeName}.json`);
          writeFileSync(namePath, content, 'utf8');
        }
      } else {
        failed++;
      }
    }

    if (item) {
      assets[assetId] = item;
    }

    const step = item && (isRecord(item.step) ? item.step : item);
    manifestEntries.push({
      asset_id: assetId,
      asset_name: step ? asString(step.name) : assetId,
      slug: null,
      local_path: localPath,
      content_hash: contentHash,
      fetched: !fromCache,
      fetch_error: item ? null : 'API returned null or 404',
    });
  }

  // Generate manifest
  const manifest: AssetFetchManifest = {
    generated_at: new Date().toISOString(),
    api_url: apiUrl,
    total_assets: assetIds.length,
    fetched,
    cached,
    failed,
    entries: manifestEntries,
  };

  if (outDir) {
    const manifestPath = join(resolve(outDir), 'asset-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  const missing = assetIds.filter((id) => !assets[id]);
  console.log(
    JSON.stringify({
      status: missing.length === 0 ? 'success' : 'partial',
      fetched,
      cached,
      failed,
      missing,
      assets,
      saved,
      manifest,
    }, null, 2),
  );
}

// 仅在作为独立 CLI 运行时执行（被 import 时不执行）
if (import.meta.main) {
  mainCli().catch((e) => {
    console.error(`[fetch-asset] ERROR: ${e}`);
    console.log(JSON.stringify({ status: 'error', error: String(e) }));
    process.exit(1);
  });
}
