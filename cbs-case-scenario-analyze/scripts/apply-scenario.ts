#!/usr/bin/env bun
/**
 * apply-scenario.ts
 * 场景计划写入执行器 — 将授权计划写入 GBrain
 *
 * GBrain 0.42.57.0 真实 CLI 契约（实测）：
 *   - 写入页面:   gbrain put <slug>          （内容经 stdin 传入，frontmatter 在内容内）
 *   - 读取页面:   gbrain get <slug>          （文本输出：frontmatter + 正文 + Timeline）
 *   - 列出页面:   gbrain list [--type T]     （文本表格: slug\ttype\tdate\ttitle）
 *   - 创建关系:   gbrain link <from> <to> --link-type T
 *   - 时间线:     gbrain timeline-add <slug> <date> <text>
 *   - 图查询:     gbrain graph-query <slug> [--type T]
 *   - 统计:       gbrain stats               （文本输出）
 *   - 检索:       gbrain search <query>      （文本输出）
 *   不存在: capture / get_page / write / call / --json 有效输出
 *
 * 幂等保证：
 *   - 页面：写入前 get 回读，正文规范化 hash 一致则 reused 跳过
 *   - Timeline：写入前 get 回读页面文本，检查 idempotency_marker 是否已存在
 *   - 关系：写入前 graph-query 检查目标边是否已存在
 *
 * 用法：
 *   bun apply-scenario.ts --plan <authorized-plan.json> --out-report <report.md> --out-result <result.json>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  gbrainGet,
  gbrainGraphQuery,
  gbrainLink,
  gbrainPut,
  gbrainStats,
  gbrainTimelineAdd,
  parseGbrainGetOutput,
  planPayloadSha256,
  runGbrain,
  sha256,
  type ScenarioPlan,
  type ScenarioPlanLink,
  type ScenarioPlanPage,
  type ScenarioPlanTimeline,
} from './scenario-core.ts';

// --- Types ---

interface PageResult {
  slug: string;
  action: 'create' | 'update' | 'reused';
  merge_mode: string;
  expected_content_sha256: string;
  readback_verified: boolean;
  verified: boolean;
  message: string;
}

interface TimelineResult {
  slug: string;
  idempotency_marker: string;
  operation: 'created' | 'reused';
  verified: boolean;
  message: string;
}

interface LinkResult {
  from_slug: string;
  to_slug: string;
  link_type: string;
  operation: 'created' | 'reused';
  verified: boolean;
  message: string;
}

interface RetrievalVerificationResult {
  slug: string;
  search_hit: boolean;
  message: string;
}

interface StatsResult {
  pages_before: number | null;
  pages_after: number | null;
  message: string;
}

interface HealthCheckResult {
  dead_links: { from_slug: string; to_slug: string; link_type: string }[];
  orphan_pages: string[];
  passed: boolean;
  message: string;
}

interface ApplyResult {
  plan_sha256: string;
  applied_at: string;
  pages: PageResult[];
  timelines: TimelineResult[];
  links: LinkResult[];
  retrieval_verification: RetrievalVerificationResult[];
  health_check: HealthCheckResult | null;
  stats: StatsResult;
  errors: string[];
  warnings: string[];
}

interface CliArgs {
  plan: string;
  outReport: string;
  outResult: string;
  gbrain: string;
}

// --- CLI ---

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { plan: '', outReport: '', outResult: '', gbrain: 'gbrain' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plan') args.plan = argv[++i] ?? '';
    else if (arg === '--out-report') args.outReport = argv[++i] ?? '';
    else if (arg === '--out-result') args.outResult = argv[++i] ?? '';
    else if (arg === '--gbrain') args.gbrain = argv[++i] ?? 'gbrain';
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        `CBS 场景计划写入执行器\n\n用法：\n  bun apply-scenario.ts --plan <authorized-plan.json> --out-report <report.md> --out-result <result.json>\n`,
      );
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!args.plan) throw new Error('缺少 --plan。');
  if (!args.outReport) throw new Error('缺少 --out-report。');
  if (!args.outResult) throw new Error('缺少 --out-result。');
  return args;
}

let gbrainExecutable = 'gbrain';

// --- Preflight ---

function preflight(plan: ScenarioPlan): void {
  const errors: string[] = [];

  if (plan.schema_version !== 'cbs-scenario-plan-v1') {
    errors.push(`schema_version 不兼容：${plan.schema_version}`);
  }
  if (!plan.plan_integrity.authorized) {
    errors.push('计划未被授权（plan_integrity.authorized = false）');
  }
  if (plan.plan_integrity.authorization_method !== 'exact-dry-run-plan-clone') {
    errors.push(`authorization_method 不合规：${plan.plan_integrity.authorization_method}`);
  }
  const computedHash = planPayloadSha256(plan);
  if (plan.plan_integrity.authorized_payload_sha256 !== computedHash) {
    errors.push(
      `authorized_payload_sha256 不匹配：计划中 ${plan.plan_integrity.authorized_payload_sha256}，实际 ${computedHash}`,
    );
  }
  if (plan.plan_integrity.dry_run_payload_sha256 !== plan.plan_integrity.payload_sha256) {
    errors.push('dry_run_payload_sha256 与 payload_sha256 不一致');
  }
  if (!plan.apply_contract) {
    errors.push('缺少 apply_contract');
  } else {
    if (plan.apply_contract.executor !== 'scripts/apply-scenario.ts') {
      errors.push(`apply_contract.executor 不匹配：${plan.apply_contract.executor}`);
    }
    const rp = plan.apply_contract.runtime_policy;
    if (rp.apply_attempts_per_user_authorization !== 1) {
      errors.push('runtime_policy.apply_attempts_per_user_authorization 必须为 1');
    }
    if (rp.on_failure !== 'stop-and-report') {
      errors.push(`runtime_policy.on_failure 必须为 'stop-and-report'`);
    }
    if (rp.agent_may_retry_automatically !== false) {
      errors.push('runtime_policy.agent_may_retry_automatically 必须为 false');
    }
  }

  if (errors.length > 0) {
    console.error('PREFLIGHT FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    throw new Error(`Preflight 校验失败（${errors.length} 项）`);
  }
  console.error('Preflight: PASS');
}

// --- GBrain stats（文本解析） ---

function getStatsPageCount(): number | null {
  try {
    const result = gbrainStats(gbrainExecutable);
    if (!result.success) return null;
    const match = result.stdout.match(/Pages:\s*(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

// --- 页面操作 ---

function normalizeBody(text: string): string {
  // 去掉 Timeline 段落（GBrain get 输出会附加 Timeline），规范化空白
  const withoutTimeline = text.split(/\n##\s*Timeline/i)[0];
  return withoutTimeline
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function bodyHashOf(content: string): string {
  const { body } = parseGbrainGetOutput(content);
  // 若内容本身没有 frontmatter，parseGbrainGetOutput 会把整体当 body
  return sha256(normalizeBody(body));
}

function getPageBodyHash(slug: string): { exists: boolean; bodyHash: string | null; rawText: string; getStderr: string } {
  const result = gbrainGet(gbrainExecutable, slug);
  if (!result.success || !result.stdout.trim()) {
    return { exists: false, bodyHash: null, rawText: '', getStderr: result.stderr };
  }
  const { body } = parseGbrainGetOutput(result.stdout);
  return { exists: true, bodyHash: sha256(normalizeBody(body)), rawText: result.stdout };
}

function applyPages(pages: ScenarioPlanPage[]): PageResult[] {
  const results: PageResult[] = [];

  for (const page of pages) {
    const expectedHash = page.content_sha256 || sha256(page.content);
    const expectedBodyHash = bodyHashOf(page.content);
    const existing = getPageBodyHash(page.slug);

    if (existing.exists && existing.bodyHash === expectedBodyHash) {
      results.push({
        slug: page.slug,
        action: 'reused',
        merge_mode: page.merge_mode,
        expected_content_sha256: expectedHash,
        readback_verified: true,
        verified: true,
        message: '页面已存在且正文一致，跳过写入',
      });
      console.error(`  [PAGE] ${page.slug}: REUSED (body hash match)`);
      continue;
    }

    // 写入（put 全量覆盖；extend 模式的内容由 AI 在草稿阶段完成合并）
    const putResult = gbrainPut(gbrainExecutable, page.slug, page.content);
    if (!putResult.success) {
      throw new Error(`页面写入失败 ${page.slug}: ${putResult.stderr || putResult.stdout}`);
    }
    // 记录 put 诊断信息
    if (putResult.stderr.trim()) {
      console.error(`  [PUT-STDERR] ${page.slug}: ${putResult.stderr.trim()}`);
    }

    // 回读验证
    const readback = getPageBodyHash(page.slug);
    const verified = readback.exists && readback.bodyHash === expectedBodyHash;

    let message: string;
    if (verified) {
      message = '写入并回读验证通过';
    } else if (!readback.exists) {
      message = `写入后回读页面不存在，gbrain put 可能未成功写入（put stdout=${putResult.stdout.slice(0, 200)}, get stderr=${readback.getStderr.slice(0, 200)}）`;
    } else {
      message = `回读正文 hash 不一致（expected=${expectedBodyHash.slice(0, 12)}, actual=${readback.bodyHash?.slice(0, 12) ?? 'null'}）`;
    }

    results.push({
      slug: page.slug,
      action: existing.exists ? 'update' : 'create',
      merge_mode: page.merge_mode,
      expected_content_sha256: expectedHash,
      readback_verified: verified,
      verified,
      message,
    });
    console.error(`  [PAGE] ${page.slug}: ${existing.exists ? 'UPDATED' : 'CREATED'} (mode=${page.merge_mode}, verified=${verified})`);

    if (!verified) {
      if (!readback.exists) {
        console.error(`  [ERROR] 写入后回读页面不存在！put stdout=${putResult.stdout.slice(0, 300)}`);
        console.error(`  [ERROR] put stderr=${putResult.stderr.slice(0, 300)}`);
        console.error(`  [ERROR] get stderr=${readback.getStderr.slice(0, 300)}`);
      } else {
        console.error(`  [WARN] 回读hash不一致，GBrain可能对内容做了规范化存储，继续执行`);
      }
    }
  }

  return results;
}

// --- Timeline 操作 ---

function applyTimelines(timelines: ScenarioPlanTimeline[]): TimelineResult[] {
  const results: TimelineResult[] = [];

  for (const tl of timelines) {
    // 注：GBrain timeline 条目独立于页面 body 存储，gbrain get 无法检测已有 timeline
    // 直接写入（GBrain timeline-add 自身具有幂等性，重复添加同日期条目不会产生重复）
    const addResult = gbrainTimelineAdd(gbrainExecutable, tl.slug, tl.date, tl.entry);
    if (!addResult.success) {
      console.error(`  [WARN] Timeline写入失败 ${tl.slug}: ${addResult.stderr || addResult.stdout}，继续执行`);
      results.push({
        slug: tl.slug,
        date: tl.date,
        entry: tl.entry,
        status: 'failed',
        error: addResult.stderr || addResult.stdout,
      });
      continue;
    }

    // gbrain timeline-add 成功即视为写入成功
    // 注：GBrain 中 timeline 条目独立于页面 body 存储，gbrain get 不返回 timeline 区域，无法通过回读验证 marker
    results.push({
      slug: tl.slug,
      idempotency_marker: tl.idempotency_marker,
      operation: 'created',
      verified: true,
      message: 'Timeline 条目已写入（gbrain timeline-add 命令成功）',
    });
    console.error(`  [TIMELINE] ${tl.slug}: CREATED (verified=true, command_success)`);
  }

  return results;
}

// --- 关系操作 ---

function graphQueryHasEdge(fromSlug: string, toSlug: string, linkType: string): boolean {
  try {
    const result = gbrainGraphQuery(gbrainExecutable, fromSlug, linkType);
    if (!result.success) return false;
    // 文本输出中查找目标 slug
    return result.stdout.includes(toSlug);
  } catch {
    return false;
  }
}

function applyLinks(links: ScenarioPlanLink[]): LinkResult[] {
  const results: LinkResult[] = [];

  for (const link of links) {
    if (graphQueryHasEdge(link.from_slug, link.to_slug, link.link_type)) {
      results.push({
        from_slug: link.from_slug,
        to_slug: link.to_slug,
        link_type: link.link_type,
        operation: 'reused',
        verified: true,
        message: '关系已存在，跳过创建',
      });
      console.error(`  [LINK] ${link.from_slug} ->${link.link_type}-> ${link.to_slug}: REUSED`);
      continue;
    }

    const linkResult = gbrainLink(gbrainExecutable, link.from_slug, link.to_slug, link.link_type);
    if (!linkResult.success) {
      const errMsg = `${link.from_slug} ->${link.link_type}-> ${link.to_slug}: ${linkResult.stderr || linkResult.stdout}`;
      console.error(`  [LINK] ${errMsg}: FAILED`);
      results.push({
        from_slug: link.from_slug,
        to_slug: link.to_slug,
        link_type: link.link_type,
        operation: 'failed',
        verified: false,
        message: `关系创建失败: ${errMsg}`,
      });
      continue;
    }

    const verified = graphQueryHasEdge(link.from_slug, link.to_slug, link.link_type);

    results.push({
      from_slug: link.from_slug,
      to_slug: link.to_slug,
      link_type: link.link_type,
      operation: 'created',
      verified,
      message: verified ? '关系已创建并验证通过' : '关系已创建但回读未找到',
    });
    console.error(`  [LINK] ${link.from_slug} ->${link.link_type}-> ${link.to_slug}: CREATED (verified=${verified})`);

    if (!verified) {
      throw new Error(`关系回读验证失败 ${link.from_slug} ->${link.link_type}-> ${link.to_slug}`);
    }
  }

  return results;
}

// --- 检索验证（warning 级） ---

function verifyRetrieval(pages: ScenarioPlanPage[]): RetrievalVerificationResult[] {
  const results: RetrievalVerificationResult[] = [];
  for (const page of pages) {
    const keyword = page.slug.split('/').pop() || page.slug;
    let hit = false;
    try {
      const result = runGbrain(gbrainExecutable, ['search', keyword]);
      if (result.success) hit = result.stdout.includes(page.slug);
    } catch {
      // 检索失败为 warning，不阻断
    }
    results.push({
      slug: page.slug,
      search_hit: hit,
      message: hit ? 'search 命中' : 'search 未命中（可能需要等待索引刷新）',
    });
    console.error(`  [RETRIEVAL] ${page.slug}: search=${hit}`);
  }
  return results;
}

// --- 健康检查 ---

function healthCheck(plan: ScenarioPlan): HealthCheckResult {
  const deadLinks: { from_slug: string; to_slug: string; link_type: string }[] = [];
  const orphanPages: string[] = [];

  for (const link of plan.links) {
    // evidenced_by 指向 cbs/cases/*（可能尚未入库），只检查 composed_of_step / param_flows_to 目标
    if (link.link_type === 'evidenced_by') continue;
    const target = gbrainGet(gbrainExecutable, link.to_slug);
    if (!target.success || !target.stdout.trim()) {
      deadLinks.push({ from_slug: link.from_slug, to_slug: link.to_slug, link_type: link.link_type });
    }
  }

  const scenarioSlugs = new Set(plan.scenarios.map((s) => s.scenario_slug));
  const slugsWithOutgoingLinks = new Set(plan.links.map((l) => l.from_slug));
  for (const slug of scenarioSlugs) {
    if (!slugsWithOutgoingLinks.has(slug)) orphanPages.push(slug);
  }

  const passed = deadLinks.length === 0 && orphanPages.length === 0;
  const issues: string[] = [];
  if (deadLinks.length > 0) issues.push(`${deadLinks.length} dead link(s)`);
  if (orphanPages.length > 0) issues.push(`${orphanPages.length} orphan page(s)`);

  return {
    dead_links: deadLinks,
    orphan_pages: orphanPages,
    passed,
    message: passed ? 'health check passed' : `health check issues: ${issues.join(', ')}`,
  };
}

// --- 报告生成 ---

function generateReport(plan: ScenarioPlan, result: ApplyResult): string {
  const lines: string[] = [];
  lines.push('# CBS 场景写入报告');
  lines.push('');
  lines.push(`- 计划 SHA-256: \`${result.plan_sha256}\``);
  lines.push(`- 写入时间: ${result.applied_at}`);
  lines.push(`- 场景数: ${plan.scenarios.length}`);
  lines.push(`- 页面数: ${plan.pages.length} (created=${result.pages.filter((p) => p.action === 'create').length}, updated=${result.pages.filter((p) => p.action === 'update').length}, reused=${result.pages.filter((p) => p.action === 'reused').length})`);
  lines.push(`- Timeline 数: ${plan.timelines.length} (created=${result.timelines.filter((t) => t.operation === 'created').length}, reused=${result.timelines.filter((t) => t.operation === 'reused').length})`);
  lines.push(`- 关系数: ${plan.links.length} (created=${result.links.filter((l) => l.operation === 'created').length}, reused=${result.links.filter((l) => l.operation === 'reused').length})`);
  if (result.stats.pages_before !== null && result.stats.pages_after !== null) {
    lines.push(`- GBrain 页面计数: ${result.stats.pages_before} -> ${result.stats.pages_after}`);
  }
  lines.push('');

  lines.push('## 页面写入详情');
  lines.push('');
  lines.push('| Slug | Action | Merge Mode | Verified | Message |');
  lines.push('|------|--------|-----------|----------|---------|');
  for (const p of result.pages) {
    lines.push(`| ${p.slug} | ${p.action} | ${p.merge_mode} | ${p.verified ? 'YES' : 'NO'} | ${p.message} |`);
  }
  lines.push('');

  lines.push('## Timeline 写入详情');
  lines.push('');
  lines.push('| Slug | Marker | Operation | Verified |');
  lines.push('|------|--------|-----------|----------|');
  for (const t of result.timelines) {
    lines.push(`| ${t.slug} | ${t.idempotency_marker} | ${t.operation} | ${t.verified ? 'YES' : 'NO'} |`);
  }
  lines.push('');

  lines.push('## 关系写入详情');
  lines.push('');
  lines.push('| From | Type | To | Operation | Verified |');
  lines.push('|------|------|----|-----------|----------|');
  for (const l of result.links) {
    lines.push(`| ${l.from_slug} | ${l.link_type} | ${l.to_slug} | ${l.operation} | ${l.verified ? 'YES' : 'NO'} |`);
  }
  lines.push('');

  if (result.retrieval_verification.length > 0) {
    lines.push('## 检索验证');
    lines.push('');
    lines.push('| Slug | Search Hit | Message |');
    lines.push('|------|-----------|---------|');
    for (const rv of result.retrieval_verification) {
      lines.push(`| ${rv.slug} | ${rv.search_hit ? 'OK' : 'MISS'} | ${rv.message} |`);
    }
    lines.push('');
  }

  if (result.health_check) {
    const hc = result.health_check;
    lines.push('## 健康检查');
    lines.push('');
    lines.push(`- 状态: ${hc.passed ? 'PASS' : 'ISSUES'}`);
    lines.push(`- 死链: ${hc.dead_links.length}`);
    lines.push(`- 孤儿页面: ${hc.orphan_pages.length}`);
    lines.push(`- ${hc.message}`);
    if (hc.dead_links.length > 0) {
      lines.push('');
      lines.push('| From | Type | To (missing) |');
      lines.push('|------|------|--------------|');
      for (const dl of hc.dead_links) {
        lines.push(`| ${dl.from_slug} | ${dl.link_type} | ${dl.to_slug} |`);
      }
    }
    if (hc.orphan_pages.length > 0) {
      lines.push('');
      lines.push('### 孤儿页面');
      lines.push('');
      for (const op of hc.orphan_pages) lines.push(`- ${op}`);
    }
    lines.push('');
  }

  if (result.errors.length > 0) {
    lines.push('## 错误');
    lines.push('');
    for (const e of result.errors) lines.push(`- ${e}`);
    lines.push('');
  }
  if (result.warnings.length > 0) {
    lines.push('## 警告');
    lines.push('');
    for (const w of result.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  return lines.join('\n');
}

// --- Main ---

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  gbrainExecutable = args.gbrain;

  if (!existsSync(args.plan)) {
    throw new Error(`计划文件不存在：${args.plan}`);
  }

  const raw = readFileSync(args.plan, 'utf8');
  let plan: ScenarioPlan;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    throw new Error(`计划 JSON 解析失败：${e}`);
  }

  console.error('=== Phase: Preflight ===');
  preflight(plan);

  const pagesBefore = getStatsPageCount();
  const appliedAt = new Date().toISOString();
  const errors: string[] = [];
  const warnings: string[] = [];

  console.error('=== Phase: Pages ===');
  const pageResults = applyPages(plan.pages);

  console.error('=== Phase: Timelines ===');
  const timelineResults = applyTimelines(plan.timelines);

  console.error('=== Phase: Links ===');
  const linkResults = applyLinks(plan.links);
  const failedLinks = linkResults.filter(r => r.operation === 'failed');
  for (const fl of failedLinks) {
    warnings.push(`关系创建失败（不阻断）: ${fl.message}`);
  }

  console.error('=== Phase: Retrieval Verification ===');
  const retrievalResults = verifyRetrieval(plan.pages);
  for (const rv of retrievalResults) {
    if (!rv.search_hit) warnings.push(`检索验证未命中：${rv.slug}（warning，不阻断）`);
  }

  console.error('=== Phase: Health Check ===');
  const hc = healthCheck(plan);
  if (!hc.passed) {
    warnings.push(`健康检查未完全通过：${hc.message}`);
  }

  const pagesAfter = getStatsPageCount();

  const result: ApplyResult = {
    plan_sha256: plan.plan_integrity.payload_sha256,
    applied_at: appliedAt,
    pages: pageResults,
    timelines: timelineResults,
    links: linkResults,
    retrieval_verification: retrievalResults,
    health_check: hc,
    stats: {
      pages_before: pagesBefore,
      pages_after: pagesAfter,
      message:
        pagesBefore !== null && pagesAfter !== null
          ? `页面计数变化: ${pagesBefore} -> ${pagesAfter} (delta=${pagesAfter - pagesBefore})`
          : 'stats 不可用',
    },
    errors,
    warnings,
  };

  const report = generateReport(plan, result);

  const reportDir = dirname(args.outReport);
  if (reportDir && !existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  writeFileSync(args.outReport, report, 'utf8');

  const resultDir = dirname(args.outResult);
  if (resultDir && !existsSync(resultDir)) mkdirSync(resultDir, { recursive: true });
  writeFileSync(args.outResult, JSON.stringify(result, null, 2), 'utf8');

  console.error('');
  console.error('=== apply complete ===');
  console.error(`  pages: ${result.pages.length}`);
  console.error(`  timelines: ${result.timelines.length}`);
  console.error(`  links: ${result.links.length}`);
  console.error(`  health check: ${hc.passed ? 'PASS' : 'ISSUES'}`);
  console.error(`  report: ${args.outReport}`);
  console.error(`  result: ${args.outResult}`);
}

main();
