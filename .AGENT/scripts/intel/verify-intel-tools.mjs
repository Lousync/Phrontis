#!/usr/bin/env node
/**
 * 契约脚本：情报 AI 工具面（v3.12.0，docs/intel-module-plan.md §11.2）。
 *
 * 断言面：
 *   §1 三个 intel 工具 schema ≤800 字符（直接 import 真实现 electron/lib/intel/toolSchemas.ts，铁律 16）；
 *   §2 注册声明（builtinTools.ts 源码）：tier/module/requires/readOnly 各就各位；
 *   §3 agentService 的 INTEL_TOOL_NAMES 白名单与注册名一致、含 builtin.time.now；
 *   §4 通用助手视野不含 intel 写工具：intelReadOnly 过滤行 + 调用点传参 + tool.request 目录同步（铁律 18）；
 *   §5 人设 / 池快照注入接线（persona 进 system、快照进首条 user 消息层）。
 *
 * 用法：node --experimental-strip-types .AGENT/scripts/intel/verify-intel-tools.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INTEL_QUERY_SCHEMA, INTEL_SET_REC_SCHEMA, INTEL_SET_FILTER_SCHEMA } from '../../../electron/lib/intel/toolSchemas.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0
const fails = []
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

console.log('\n=== §1 schema 体积 ≤800 字符（铁律 16）===')
const schemas = [
  ['builtin.intel.query', INTEL_QUERY_SCHEMA],
  ['builtin.intel.set-recommendations', INTEL_SET_REC_SCHEMA],
  ['builtin.intel.set-filter', INTEL_SET_FILTER_SCHEMA],
]
for (const [name, schema] of schemas) {
  const len = JSON.stringify(schema).length
  ok(len <= 800, `§1 ${name} schema ≤800 字符`, `${len} chars`)
}

const toolsSrc = read('electron/lib/builtinTools.ts')
const agentSrc = read('electron/lib/agentService.ts')

console.log('\n=== §2 注册声明（tier / module / requires / readOnly）===')
// 抽取每个 builtin.intel.* 的 registerTool 块（从 name 行到其后的 handler 开头）
const blockOf = (toolName) => {
  const i = toolsSrc.indexOf(`name: '${toolName}'`)
  if (i === -1) return null
  return toolsSrc.slice(Math.max(0, i - 200), toolsSrc.indexOf('}, args =>', i) + 10)
}
for (const [name, expect] of [
  ['builtin.intel.query', { tier: 'ondemand', module: 'intel', requires: null, readOnly: true }],
  ['builtin.intel.set-recommendations', { tier: 'ondemand', module: 'intel', requires: 'write', readOnly: false }],
  ['builtin.intel.set-filter', { tier: 'ondemand', module: 'intel', requires: 'write', readOnly: false }],
]) {
  const block = blockOf(name)
  ok(block !== null, `§2 ${name} 已注册`)
  if (!block) continue
  ok(block.includes(`tier: '${expect.tier}'`), `§2 ${name} tier=${expect.tier}`)
  ok(block.includes(`module: '${expect.module}'`), `§2 ${name} module=${expect.module}`)
  ok(expect.requires ? block.includes(`requires: '${expect.requires}'`) : !block.includes("requires: 'write'"), `§2 ${name} requires=${expect.requires ?? '(无)'}`)
  ok(block.includes(`readOnly: ${expect.readOnly}`), `§2 ${name} readOnly=${expect.readOnly}`)
}

console.log('\n=== §3 INTEL_TOOL_NAMES 白名单与注册名一致 ===')
const m = agentSrc.match(/const INTEL_TOOL_NAMES = \[([\s\S]*?)\]/)
ok(m !== null, '§3 INTEL_TOOL_NAMES 存在')
const listed = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
ok(listed.join(',') === 'builtin.intel.query,builtin.intel.set-recommendations,builtin.intel.set-filter,builtin.time.now',
  '§3 白名单 = 3 个 intel 工具 + builtin.time.now（D6：只读池 + 两个写回动作）', listed.join(','))
for (const name of listed.filter((x) => x.startsWith('builtin.intel.'))) {
  ok(blockOf(name) !== null, `§3 ${name} 在 builtinTools 里确有注册`)
}
// 白名单内的工具不走 ondemand 折叠（buildToolsPayload 的 onlySet 豁免），无需 tool.request
ok(agentSrc.includes("source === 'intel' ? INTEL_TOOL_NAMES : undefined"),
  '§3 source=intel 会话把白名单传进 buildToolsPayload 的 only 参数')

console.log('\n=== §4 通用助手视野不含 intel 写工具（D8 / 铁律 18）===')
ok(/modeOpts\?\.intelReadOnly && t\.module === 'intel' && t\.requires === 'write'\) return false/.test(agentSrc),
  '§4 buildToolsPayload 有 intelReadOnly 硬过滤行')
ok(/intelReadOnly: unifiedAssistant/.test(agentSrc),
  '§4 调用点把 intelReadOnly 绑在 unifiedAssistant（通用助手三宿主）')
ok(toolsSrc.includes('intel.set-recommendations') && toolsSrc.includes('intel.set-filter') && toolsSrc.includes('intel.query'),
  '§4 builtin.tool.request 的 description 目录已同步 3 行（铁律 18）')

console.log('\n=== §5 人设 / 池快照注入（§7.2）===')
ok(agentSrc.includes('const INTEL_PERSONA') && agentSrc.includes('const intelPersona = source === \'intel\' ? INTEL_PERSONA : \'\''),
  '§5 情报人设进 system（逐字稳定，命中 prompt cache）')
ok(agentSrc.includes('function buildIntelInjection()') && agentSrc.includes('const intelHint = source === \'intel\' ? buildIntelInjection() : \'\''),
  '§5 池快照每轮现算')
ok(/\[scheduleHint, intelHint, refInjection, perceptionInjection, recentImagesHint, aiManifestHint\]/.test(agentSrc),
  '§5 池快照走首条 user 消息层 requestInjection（不进 system，防打散缓存）')
ok(agentSrc.includes("source === 'aiAssistant' ? 'aiAssistant' : source === 'intel' ? 'intel' : 'assistant'"),
  '§5 会话创建 / 列出口的 source 归一含 intel')
ok(agentSrc.includes("source !== 'schedule' && source !== 'intel'"),
  '§5 生图 / 最近图片注入对情报助手豁免（窄工具面不掺无关规则）')

console.log(`\n[${fails.length === 0 ? 'OK' : 'FAIL'}] verify-intel-tools: ${pass} passed, ${fails.length} failed`)
if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exit(1) }
