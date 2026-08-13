#!/usr/bin/env bun
/**
 * lookup-field-info.ts
 * 接口字段明细按需查询工具。AI 在分析过程中需要字段含义时调用，禁止全量读取 interface-fields.json。
 *
 * 用法：
 *   bun lookup-field-info.ts --fields-file <interface-fields.json>                          # 列出接口目录
 *   bun lookup-field-info.ts --fields-file <f> --interface AdjustmentRequest                # 该接口全部字段
 *   bun lookup-field-info.ts --fields-file <f> --interface AdjustmentRequest --field OpType # 单字段详情
 *   bun lookup-field-info.ts --fields-file <f> --search 失效时间                             # 跨接口关键词搜索
 *   bun lookup-field-info.ts --fields-file <f> --var My_AdjType                              # 按用例变量名查映射字段
 * 输出：JSON（stdout）
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  isRecord,
  parseArgs,
  asString,
  type InterfaceFieldsFile,
} from './scenario-core.ts';

interface FieldHit {
  interface: string;
  name: string;
  path: string;
  type: string;
  description: string;
}

function main(): void {
  const args = parseArgs(process.argv);
  const fieldsFile = asString(args['fields-file']);
  const interfaceName = asString(args['interface']);
  const fieldQuery = asString(args['field']);
  const searchKw = asString(args['search']);
  const varName = asString(args['var']);

  if (!fieldsFile) {
    console.error('Usage: bun lookup-field-info.ts --fields-file <interface-fields.json> [--interface <name>] [--field <name>] [--search <keyword>] [--var <变量名>]');
    process.exit(1);
  }
  if (!existsSync(fieldsFile)) {
    console.error(JSON.stringify({ error: `fields file not found: ${fieldsFile}` }));
    process.exit(1);
  }

  const raw: unknown = JSON.parse(readFileSync(fieldsFile, 'utf8'));
  if (!isRecord(raw) || !isRecord(raw.interface_fields)) {
    console.error(JSON.stringify({ error: 'invalid interface-fields.json format' }));
    process.exit(1);
  }
  const data = raw as unknown as InterfaceFieldsFile;

  // 模式1：列出接口目录
  if (!interfaceName && !searchKw && !varName) {
    console.log(JSON.stringify({
      interface_count: data.interface_count,
      interfaces: Object.entries(data.interface_fields).map(([name, d]) => ({
        interface: name,
        element_count: d.elements.length,
      })),
      hint: '用 --interface <name> 查看字段明细；--field <name> 查单字段；--search <关键词> 跨接口搜索；--var <变量名> 按用例变量查映射',
    }, null, 2));
    return;
  }

  // 模式2：按用例变量名查映射字段
  if (varName) {
    const mappedPath = data.field_mapping[varName];
    if (!mappedPath) {
      console.log(JSON.stringify({ var: varName, found: false, hint: '该变量无字段映射，可尝试 --search <关键词>' }, null, 2));
      return;
    }
    const hits: FieldHit[] = [];
    for (const [iface, d] of Object.entries(data.interface_fields)) {
      for (const el of d.elements) {
        if (el.path === mappedPath || el.name === mappedPath || el.path.endsWith('/' + mappedPath)) {
          hits.push({ interface: iface, name: el.name, path: el.path, type: el.type, description: el.description });
        }
      }
    }
    console.log(JSON.stringify({ var: varName, mapped_path: mappedPath, found: hits.length > 0, fields: hits }, null, 2));
    return;
  }

  // 模式3：跨接口关键词搜索（字段名/路径/描述）
  if (searchKw) {
    const kw = searchKw.toLowerCase();
    const hits: FieldHit[] = [];
    for (const [iface, d] of Object.entries(data.interface_fields)) {
      for (const el of d.elements) {
        if (
          el.name.toLowerCase().includes(kw) ||
          el.path.toLowerCase().includes(kw) ||
          el.description.toLowerCase().includes(kw)
        ) {
          hits.push({ interface: iface, name: el.name, path: el.path, type: el.type, description: el.description });
        }
      }
    }
    console.log(JSON.stringify({ search: searchKw, hit_count: hits.length, fields: hits.slice(0, 50) }, null, 2));
    return;
  }

  // 模式4/5：指定接口
  const ifaceData = data.interface_fields[interfaceName!];
  if (!ifaceData) {
    const similar = Object.keys(data.interface_fields).filter((n) => n.toLowerCase().includes(interfaceName!.toLowerCase()));
    console.log(JSON.stringify({
      error: `interface not found: ${interfaceName}`,
      similar: similar.length > 0 ? similar : undefined,
      available: similar.length > 0 ? undefined : Object.keys(data.interface_fields),
    }, null, 2));
    process.exit(1);
  }

  if (fieldQuery) {
    const q = fieldQuery.toLowerCase();
    const hits = ifaceData.elements
      .filter((el) => el.name.toLowerCase().includes(q) || el.path.toLowerCase().includes(q))
      .map((el) => ({ interface: interfaceName, name: el.name, path: el.path, type: el.type, description: el.description }));
    console.log(JSON.stringify({ interface: interfaceName, query: fieldQuery, hit_count: hits.length, fields: hits }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    interface: interfaceName,
    element_count: ifaceData.elements.length,
    elements: ifaceData.elements,
  }, null, 2));
}

main();
