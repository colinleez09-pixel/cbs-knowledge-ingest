#!/usr/bin/env bun
/**
 * authorize-scenario-plan.ts
 * 场景计划授权器 — 读取 dry-run 计划，验证完整性，标记为已授权
 *
 * 用法：
 *   bun authorize-scenario-plan.ts --plan <dry-run-plan.json> --out <authorized-plan.json>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { planPayloadSha256, type ScenarioPlan } from './scenario-core.ts';

interface CliArgs {
  plan: string;
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { plan: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plan') args.plan = argv[++i] ?? '';
    else if (arg === '--out') args.out = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`CBS 场景计划授权器\n\n用法：\n  bun authorize-scenario-plan.ts --plan <dry-run-plan.json> --out <authorized-plan.json>\n`);
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!args.plan) throw new Error('缺少 --plan。');
  if (!args.out) throw new Error('缺少 --out。');
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

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

  // --- Preflight checks ---

  // 1. Schema version
  if (plan.schema_version !== 'cbs-scenario-plan-v1') {
    throw new Error(`计划 schema_version 不兼容：${plan.schema_version}（期望 cbs-scenario-plan-v1）`);
  }

  // 2. Dry-run payload integrity — verify the hash recorded at dry-run time
  const dryRunExpectedHash = planPayloadSha256(plan);
  if (plan.plan_integrity.dry_run_payload_sha256 !== dryRunExpectedHash) {
    throw new Error(
      `dry_run_payload_sha256 不匹配：计划中记录为 ${plan.plan_integrity.dry_run_payload_sha256}，实际计算为 ${dryRunExpectedHash}。计划可能被篡改。`,
    );
  }

  // 3. Also verify payload_sha256 (backward compat)
  if (plan.plan_integrity.payload_sha256 !== dryRunExpectedHash) {
    throw new Error(
      `payload_sha256 不匹配：计划中记录为 ${plan.plan_integrity.payload_sha256}，实际计算为 ${dryRunExpectedHash}。`,
    );
  }

  // 4. Check not already authorized
  if (plan.plan_integrity.authorized) {
    throw new Error('计划已被授权，请勿重复授权。如需重新授权，请修改 dry-run 计划后重新执行。');
  }

  // 5. Verify apply_contract exists
  if (!plan.apply_contract) {
    throw new Error('计划缺少 apply_contract 字段，无法授权。');
  }
  if (plan.apply_contract.executor !== 'scripts/apply-scenario.ts') {
    throw new Error(`apply_contract.executor 不匹配：${plan.apply_contract.executor}（期望 scripts/apply-scenario.ts）`);
  }
  if (plan.apply_contract.authorization_entrypoint !== 'scripts/authorize-scenario-plan.ps1') {
    throw new Error(`apply_contract.authorization_entrypoint 不匹配：${plan.apply_contract.authorization_entrypoint}`);
  }

  // 6. Verify runtime policy
  const rp = plan.apply_contract.runtime_policy;
  if (rp.apply_attempts_per_user_authorization !== 1) {
    throw new Error(`runtime_policy.apply_attempts_per_user_authorization 必须为 1，当前为 ${rp.apply_attempts_per_user_authorization}`);
  }
  if (rp.on_failure !== 'stop-and-report') {
    throw new Error(`runtime_policy.on_failure 必须为 'stop-and-report'，当前为 ${rp.on_failure}`);
  }
  if (rp.agent_may_retry_automatically !== false) {
    throw new Error('runtime_policy.agent_may_retry_automatically 必须为 false');
  }

  // --- Authorize ---
  plan.plan_integrity.authorized = true;
  plan.plan_integrity.authorized_at = new Date().toISOString();
  plan.plan_integrity.authorization_method = 'exact-dry-run-plan-clone';

  // Compute authorized_payload_sha256 — hash of the plan AFTER authorization
  // This allows apply-scenario.ts to detect post-authorization tampering
  plan.plan_integrity.authorized_payload_sha256 = planPayloadSha256(plan);

  // Write authorized plan
  const outDir = dirname(args.out);
  if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(args.out, JSON.stringify(plan, null, 2), 'utf8');

  console.error(`授权计划已写入：${args.out}`);
  console.error(`  场景数：${plan.scenarios.length}`);
  console.error(`  页面数：${plan.pages.length}`);
  console.error(`  关系数：${plan.links.length}`);
  console.error(`  Timeline 数：${plan.timelines.length}`);
  console.error(`  授权方法：${plan.plan_integrity.authorization_method}`);
  console.error(`  授权时间：${plan.plan_integrity.authorized_at}`);
  console.error(`  authorized_payload_sha256：${plan.plan_integrity.authorized_payload_sha256}`);
}

main();
