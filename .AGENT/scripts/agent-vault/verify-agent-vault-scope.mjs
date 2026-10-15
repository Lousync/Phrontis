#!/usr/bin/env node
/**
 * 契约验证：AI 会话「随仓库走」（2026-10-13 拍板，docs/agent-sessions-vault-plan.md）。
 *
 * 为什么需要它：这次改动**改错了也不报错**，失败模式全是静默的 ——
 *   1. 会话仍写全局目录  -> 表象只是「切仓库还能看到别的仓库的对话」，功能照常；
 *   2. 认领器没接上      -> 老会话凭空消失（用户以为数据丢了），无异常无日志；
 *   3. 认领器接上了但挂错位置 -> 只有「启动恢复」那一条路径生效，打开/导入仓库时漏掉；
 *   4. 无仓库守卫漏掉    -> 往空路径写，消息丢掉且不报错；
 *   5. 渲染层仍静默失败  -> 用户看到的是「点了没反应」，无从判断缺前提还是坏了。
 * 所以这里锁的是**结构与接线**，不是「代码能不能跑」：跑得通恰恰是这次改动的假阴性来源。
 *
 * 配套的行为验证在 verify-agent-session-migrate.mjs（真跑一遍认领）。
 *
 * 运行（项目根目录）：
 *   node .AGENT/scripts/agent-vault/verify-agent-vault-scope.mjs
 * 期望：末行 PASS 且 exit=0
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`[OK]   ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`)
  }
}

function read(rel) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf-8')
}

const REPO = 'electron/lib/agentSessionRepo.ts'
const MIGRATE = 'electron/lib/agentSessionMigrate.ts'
const NOTICE = 'electron/lib/agentAdoptNotice.ts'
const SERVICE = 'electron/lib/agentService.ts'
const WS = 'electron/lib/workspaceManager.ts'
const PRELOAD = 'electron/preload/index.ts'
const TYPES = 'src/types/index.ts'
const IPC = 'src/lib/ipc.ts'
const WRAP = 'src/lib/agentSession.ts'
const APP = 'src/App.tsx'
const CHAT = 'src/components/shared/AssistantPanel/useAssistantChat.ts'
const TEACH = 'src/modules/ai-teaching/index.tsx'
const PLAN = 'docs/agent-sessions-vault-plan.md'

console.log('=== 1. 会话存储落在仓库（不再走全局目录） ===')
{
  const src = read(REPO)
  check('agentSessionRepo.ts 存在', !!src)
  check('不再 import globalJsonStore 的读写函数', !!src && !/globalReadJson|globalWriteJson/.test(src))
  // globalDataDir 只允许出现在认领处（它是**源**目录），绝不能当会话存储基目录用
  const gddUses = src ? (src.match(/globalDataDir\s*\(\)/g) || []).length : 0
  check('globalDataDir() 只在认领时出现一次（不再作为存储基目录）', gddUses === 1, `出现 ${gddUses} 次`)
  check('消息层调用一律不带 globalDataDir()', !!src && !/(appendMessage|getMessagesPage|readMessages|deleteMessagesFile|storeUpdateMessageContent|deleteMessageById|deleteMessagesAfterId|migrateLegacyMessages)\(globalDataDir\(\)/.test(src))
  check('会话索引目录段为 agent', !!src && /const AGENT_DIR = 'agent'/.test(src))
  check('索引文件名不再叫 agent-sessions.json', !!src && /const SESSIONS_FILE = 'sessions\.json'/.test(src))
  check('读索引走 readJson(AGENT_DIR, SESSIONS_FILE, ...)', !!src && /readJson<AgentSessionRow\[\]>\(AGENT_DIR, SESSIONS_FILE/.test(src))
  check('写索引走 writeJsonOrThrow(AGENT_DIR, SESSIONS_FILE, ...)', !!src && /writeJsonOrThrow\(AGENT_DIR, SESSIONS_FILE/.test(src))
  check('回填（读路径顺带写）用静默 writeJson', !!src && /if \(n > 0\) writeJson\(AGENT_DIR, SESSIONS_FILE, sessions\)/.test(src))
  check('导出 vaultAgentDir() 且由 getVaultKbRoot() 派生', !!src && /export function vaultAgentDir\(\): string \| null \{[\s\S]{0,200}getVaultKbRoot\(\)/.test(src))
  check('消息层基目录经 requireAgentDir()/vaultAgentDir()（无 globalDataDir 残留）', !!src && /requireAgentDir\(\)/.test(src))
}

console.log('=== 2. 无仓库时的读写口径（读空、写响） ===')
{
  const src = read(REPO)
  check('requireAgentDir 无仓库抛错，不静默', !!src && /尚未打开仓库，无法读写 AI 会话/.test(src))
  check('getAgentMessages 无仓库返回空数组', !!src && /return dir \? getMessagesPage\(dir, sessionId\) : \[\]/.test(src))
  check('getMessageById 无仓库返回 null', !!src && /if \(!dir\) return null/.test(src))
  check('ensureMigrated 无仓库时不置位（否则本进程再也不迁）', !!src && /if \(!dir\) return \/\/ 无仓库：\*\*不置位\*\*/.test(src))
}

console.log('=== 3. 迁移器（纯模块，可被 node 直接加载） ===')
{
  const src = read(MIGRATE)
  check('agentSessionMigrate.ts 存在', !!src)
  // 关键约束：node 的 ESM 不做扩展名补全，内部一旦出现相对 import 就 ERR_MODULE_NOT_FOUND
  check('零相对 import（否则契约脚本无法 import）', !!src && !/from '\.\//.test(src))
  check('只依赖 fs / path 内建', !!src && /from 'fs'/.test(src) && /from 'path'/.test(src))
  check('路径全部由调用方注入（不 import app 级模块）', !!src && !/from '\.\.?\//.test(src) && !/electron/.test(src))
  check('导出 adoptLegacyGlobalAgentStore', !!src && /export function adoptLegacyGlobalAgentStore/.test(src))
  check('幂等闸门 = 全局索引不存在即返回未认领', !!src && /if \(!existsSync\(srcSessions\)\) return \{ adopted: false, sessions: 0, messages: 0 \}/.test(src))
  check('索引损坏时抛错而不是搬走（搬走 = 数据搬没）', !!src && /拒绝认领（原文件保留）/.test(src))
  check('认领前校验每条会话都落盘', !!src && /认领校验失败：会话/.test(src))
  check('消息 jsonl 正常路径按字节拷贝并校验大小（不解析正文）', !!src && /拷贝校验失败（大小不一致）/.test(src))
  check('合并路径遇损坏行抛错（不静默丢消息）', !!src && /拒绝合并以免丢消息/.test(src))
  check('全局侧改名留存而非删除', !!src && /\.migrated\.json/.test(src) && !/rmSync|rmdirSync/.test(src))
  check('迁移器目标消息目录 = messages', !!src && /const MESSAGES_DIR_DST = 'messages'/.test(src))
  // 写读两端的目录名必须一致：不一致 = 认领成功但消息全看不见（无报错）
  const store = read('electron/lib/agentMessageStore.ts')
  check('读端消息目录同名（不可只改一端）', !!store && /const MESSAGES_DIR = 'messages'/.test(store))
  check('读端常量注释指向这条约束', !!store && /必须与 agentSessionMigrate 的 MESSAGES_DIR_DST 一致/.test(store))
}

console.log('=== 4. 认领的触发点（覆盖全部「进入仓库」入口） ===')
{
  const ws = read(WS)
  const src = read(REPO)
  check('workspaceManager 引入认领函数', !!ws && /import \{ adoptLegacyAgentSessionsToVault \} from '\.\/agentSessionRepo'/.test(ws))
  check('认领挂在 runLayoutMigrations 内（启动/打开/导入三处共用）', !!ws && /runLayoutMigrations[\s\S]{0,1200}adoptLegacyAgentSessionsToVault\(\)/.test(ws))
  const callSites = ws ? (ws.match(/runLayoutMigrations\(/g) || []).length : 0
  check('runLayoutMigrations 仍是「进入仓库」的收口（>=4 次出现：定义 + 3 调用）', callSites >= 4, `实际 ${callSites}`)
  check('repo 侧认领函数进程内只试一次', !!src && /let adoptTried = false/.test(src) && /if \(adoptTried\) return null/.test(src))
  check('repo 侧无仓库时不置位', !!src && /if \(!dir \|\| !cur\) return null/.test(src))
  check('repo 侧认领后立刻拆分 v1 全量文件', !!src && /migrateLegacyMessages\(dir\)/.test(src))
}

console.log('=== 5. 一次性告知（跨整窗重载不丢） ===')
{
  const notice = read(NOTICE)
  check('agentAdoptNotice.ts 存在', !!notice)
  check('告知落成待取文件（不是当场广播）', !!notice && /agent-adopt-notice\.json/.test(notice))
  check('取走即删 + 删不掉宁可重复展示', !!notice && /takeAdoptNotice/.test(notice) && /宁可重复一次/.test(notice))
  check('文件名唯一真相源在此模块（读端不另写一份）', !!notice && (read(SERVICE) || '').includes("from './agentAdoptNotice'"))
  const svc = read(SERVICE)
  check('IPC agent:takeAdoptNotice 已注册', !!svc && /ipcMain\.handle\('agent:takeAdoptNotice'/.test(svc))
  check('IPC agent:newSession 有无仓库守卫', !!svc && /agent:newSession'[\s\S]{0,400}getCurrentVault\(\)/.test(svc))
  check('preload 暴露 agentTakeAdoptNotice', (read(PRELOAD) || '').includes("agent:takeAdoptNotice"))
  check('types 声明 agentTakeAdoptNotice', (read(TYPES) || '').includes('agentTakeAdoptNotice'))
  check('ipc.ts 有 wrapper', (read(IPC) || '').includes('export const agentTakeAdoptNotice'))
  check('App.tsx 启动后取一次并 Toast', !!read(APP) && /agentTakeAdoptNotice\(\)/.test(read(APP)) && /历史会话归入仓库/.test(read(APP)))
}

console.log('=== 6. 渲染层：新建会话不再静默失败 ===')
{
  const wrap = read(WRAP)
  check('src/lib/agentSession.ts 存在', !!wrap)
  check('包装层先问当前仓库再建会话', !!wrap && /workspaceGetCurrent\(\)/.test(wrap) && /agentNewSession\(/.test(wrap))
  check('无仓库给可读提示', !!wrap && /请先打开仓库/.test(wrap))
  const chat = read(CHAT)
  const teach = read(TEACH)
  check('useAssistantChat 走包装层', !!chat && /newAgentSession\(/.test(chat))
  check('useAssistantChat 不再直接调 agentNewSession(...).catch', !!chat && !/agentNewSession\([^)]*\)\.catch/.test(chat))
  check('ai-teaching 走包装层', !!teach && /newAgentSession\(/.test(teach))
  check('ai-teaching 不再直接调 agentNewSession(...).catch', !!teach && !/agentNewSession\([^)]*\)\.catch/.test(teach))
}

console.log('=== 7. 文档同步（口径矛盾必须一起修掉） ===')
{
  const plan = read(PLAN)
  check('方案文档在库里', !!plan)
  check('方案已记录决策三项（版本/用量/润色）', !!plan && /决策记录（2026-10-13 已定/.test(plan))
  const master = read('docs/rework-master-plan.md')
  check('重构总纲架构图数据层补了 .knowbase/agent/', !!master && /\.knowbase\/agent\//.test(master))
  // 数据边界表是「仓库级 | 设备级」两列——一行含两列，判定必须按列拆（按整行判会永远自相矛盾）
  const cellsOf = (needle) => {
    const line = master ? (master.split('\n').find((l) => l.includes(needle)) || '') : ''
    const cells = line.split('|').map((c) => c.trim())
    return { left: cells[1] || '', right: cells[2] || '' }
  }
  const lockRow = cellsOf('锁屏密码')
  check('插件安装状态与配置归到设备级一列（右列）', /插件安装状态与配置/.test(lockRow.right))
  check('右列不再混着 AI 会话历史', !/AI 会话历史/.test(lockRow.right))
  const sessRow = cellsOf('AI 会话历史')
  check('AI 会话历史在仓库级一列（左列）并注明变更', /AI 会话历史/.test(sessRow.left) && /随仓库/.test(sessRow.left) && /2026-10-13/.test(sessRow.left))
  check('AI 会话历史不再出现在设备级一列', !/AI 会话历史/.test(sessRow.right))
  const rowR3 = master ? (master.split('\n').find((l) => l.includes('R3 数据层推广')) || '') : ''
  check('R3 行记下 agent 由全局改为随仓库', /改为\*\*随仓库\*\*/.test(rowR3) && /agent-sessions-vault-plan\.md/.test(rowR3))
}

console.log('')
if (fail === 0) {
  console.log(`PASS  ${pass} 项断言全部通过`)
  process.exit(0)
}
console.log(`FAIL  ${fail} 项失败 / 共 ${pass + fail} 项`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(1)
