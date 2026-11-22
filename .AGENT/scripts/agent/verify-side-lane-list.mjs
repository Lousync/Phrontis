/**
 * 契约验证：跨对话旁问列表（2026-11-22 AI 教学 UI 批次，C 线）。
 *
 * 两类断言：
 *  A. 纯函数真实执行 —— strip-types import `electron/lib/sideLaneMeta.ts`，
 *     验证 list-all 的**筛选条件**（lane='side' && source='aiTeaching'）与 **updated_at 倒序**。
 *  B. 接线静态断言 —— buildSideLaneInfo 的 parentTitle join、handler / preload / types / ipc.ts 四处接线，
 *     以及 createSideLane 的「位置参数 + 旧 payload 对象」双形态兼容。
 *
 * 运行（项目根目录）：
 *   node .AGENT/scripts/agent/verify-side-lane-list.mjs [仓库路径]
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------- A. 纯函数真实执行
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidelane-list-verify-'))
const tmpFile = path.join(tmpDir, 'sideLaneMeta.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(read('electron/lib/sideLaneMeta.ts'), { mode: 'strip' }))
const { selectAllSideLanes } = await import(pathToFileURL(tmpFile).href)

const row = (id, lane, source, updated_at) => ({ id, lane, source, updated_at })
const ALL = [
  row('a', 'side', 'aiTeaching', '2026-11-20 10:00:00'),
  row('b', 'side', 'aiTeaching', '2026-11-22 09:30:00'),
  row('c', 'main', 'aiTeaching', '2026-11-22 12:00:00'), // 已升格 → 不算旁问
  row('d', 'side', 'assistant', '2026-11-22 13:00:00'),  // 非教学来源 → 不混入
  row('e', 'side', 'aiTeaching', '2026-11-21 23:59:59'),
  row('f', 'main', 'assistant', '2026-11-19 08:00:00'),
  row('g', 'side', undefined, '2026-11-22 14:00:00'),    // 无 source 的存量行 → 不混入
]

console.log('\n=== 1. selectAllSideLanes：筛选条件 ===')
const picked = selectAllSideLanes(ALL)
check('只留 lane=side 且 source=aiTeaching', picked.map((r) => r.id).join(',') === 'b,e,a', `实际 ${picked.map((r) => r.id).join(',')}`)
check('排除已升格（lane=main）', !picked.some((r) => r.id === 'c' || r.id === 'f'))
check('排除非教学来源（source=assistant）', !picked.some((r) => r.id === 'd'))
check('排除缺 source 的存量行', !picked.some((r) => r.id === 'g'))

console.log('\n=== 2. selectAllSideLanes：updated_at 倒序 ===')
const stamp = picked.map((r) => r.updated_at)
check('严格倒序', stamp.every((t, i) => i === 0 || stamp[i - 1] >= t), stamp.join(' > '))
check('最新的一条排第一', picked[0]?.id === 'b')
check('最旧的一条排最后', picked[picked.length - 1]?.id === 'a')

console.log('\n=== 3. selectAllSideLanes：边界 ===')
check('空数组 → 空数组', Array.isArray(selectAllSideLanes([])) && selectAllSideLanes([]).length === 0)
check('不修改入参行对象（纯函数）', (() => {
  const one = [row('x', 'side', 'aiTeaching', '2026-01-01 00:00:00')]
  const snap = JSON.stringify(one)
  selectAllSideLanes(one)
  return JSON.stringify(one) === snap
})())
check('不改变输入数组长度', (() => {
  const input = ALL.slice()
  selectAllSideLanes(input)
  return input.length === ALL.length
})())

// ---------------------------------------------------------------- B. 接线静态断言
console.log('\n=== 4. 主进程：repo 查询 + 派生字段 ===')
const repo = read('electron/lib/agentSessionRepo.ts')
const svc = read('electron/lib/agentService.ts')
check('repo 导出 listAllAiTeachingSideLanes', repo.includes('export function listAllAiTeachingSideLanes'))
check('repo 走纯函数口径（selectAllSideLanes(readSessions())）', repo.includes('return selectAllSideLanes(readSessions())'))
check('buildSideLaneInfo join 父会话标题（parentTitle）',
  svc.includes('const parentTitle = row.parentSessionId') && svc.includes('getAgentSession(row.parentSessionId)?.title'))
check('buildSideLaneInfo 返回体含 parentTitle', /return \{[\s\S]{0,120}parentTitle,/.test(svc))

console.log('\n=== 5. 主进程：handler 接线 ===')
check('新增 handler agent:listAllSideLanes', svc.includes("ipcMain.handle('agent:listAllSideLanes'"))
check('list-all 走 buildSideLaneInfo 投影',
  /ipcMain\.handle\('agent:listAllSideLanes', \(\) => listAllAiTeachingSideLanes\(\)\.map\(buildSideLaneInfo\)\)/.test(svc))
check('createSideLane 兼容旧 payload 对象', /const legacy = !!first && typeof first === 'object'/.test(svc))
check('createSideLane 支持位置参数标题（titleIn 优先）', /const titleIn = legacy \? '' : String\(d \?\? ''\)\.trim\(\)/.test(svc) && /title: titleIn \|\|/.test(svc))
check('createSideLane 返回 id 与 laneSessionId 双别名', /id: lane\.id, laneSessionId: lane\.id/.test(svc))

console.log('\n=== 6. IPC 三处接线 ===')
const preload = read('electron/preload/index.ts')
const ipc = read('src/lib/ipc.ts')
const types = read('src/types/index.ts')
check('preload 通道 agent:listAllSideLanes', preload.includes("ipcRenderer.invoke('agent:listAllSideLanes')"))
check('preload agentCreateSideLane 转发四参',
  /agentCreateSideLane: \(first: unknown, branchFromMessageId\?: unknown, sideScope\?: unknown, title\?: unknown\)[\s\S]{0,140}ipcRenderer\.invoke\('agent:createSideLane', first, branchFromMessageId, sideScope, title\)/.test(preload))
check('ipc.ts 导出 agentListAllSideLanes', ipc.includes('export const agentListAllSideLanes = (): Promise<AgentSideLaneInfo[]>'))
check('ipc.ts agentCreateSideLane 双形态重载',
  ipc.includes('export function agentCreateSideLane(\n  parentSessionId: string,') &&
  ipc.includes('payload: { parentSessionId: string; anchorMessageId: string; contextTurns?: number }'))
check('types AgentSideLaneInfo 含 parentTitle',
  /export interface AgentSideLaneInfo extends AgentSessionInfo \{[\s\S]*?parentTitle\?: string/.test(types))
check('types ElectronAPI 含 agentListAllSideLanes', types.includes('agentListAllSideLanes: () => Promise<AgentSideLaneInfo[]>'))
check('types agentCreateSideLane 双形态重载',
  /agentCreateSideLane: \{[\s\S]{0,320}\(parentSessionId: string, branchFromMessageId\?: string \| null/.test(types) &&
  types.includes('(payload: { parentSessionId: string; anchorMessageId: string; contextTurns?: number }): Promise<AgentSideLaneCreateResult>'))
check('types AgentSideLaneCreateResult 含 id 别名', /export interface AgentSideLaneCreateResult \{[\s\S]{0,220}id\?: string/.test(types))

// ---------------------------------------------------------------- 汇总
let pass = 0, fail = 0
for (const c of checks) {
  if (c.pass) { pass++; console.log(`  PASS  ${c.name}`) }
  else { fail++; console.log(`  FAIL  ${c.name}${c.detail ? '  -- ' + c.detail : ''}`) }
}
console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
