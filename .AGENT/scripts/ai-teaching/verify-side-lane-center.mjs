/**
 * 契约验证：AI教学·支线中心（.claude/plans/ai-teaching-side-lane-center.md）。
 *
 * 两类断言：
 *  A. 纯函数真实实现执行 —— strip-types import `electron/lib/sideLaneMeta.ts`（零依赖），
 *     验证未读判定 / 运行态派生（未读与状态是「找不到记录」体验的核心，必须锁死）。
 *  B. 后端 + IPC + 渲染层接线静态断言 —— 防「加了口子忘了接线」（本模块此类漏接静默无报错）。
 *
 * 运行（项目根目录）：
 *   node .AGENT/scripts/ai-teaching/verify-side-lane-center.mjs [仓库路径]
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

// ---------------------------------------------------------------- A. 纯函数真实实现
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidelane-verify-'))
const tmpFile = path.join(tmpDir, 'sideLaneMeta.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(read('electron/lib/sideLaneMeta.ts'), { mode: 'strip' }))
const { computeLaneUnread, deriveLaneStatus } = await import(pathToFileURL(tmpFile).href)

console.log('\n=== 1. computeLaneUnread：未读判定 ===')
check('无消息 → 不未读', computeLaneUnread({ hasMessages: false, lastAssistantAt: '2026-10-11 10:00:00' }) === false)
check('只有用户消息（无 AI 回答）→ 不未读', computeLaneUnread({ hasMessages: true }) === false)
check('有回答 + 从未打开 → 未读', computeLaneUnread({ hasMessages: true, lastAssistantAt: '2026-10-11 10:00:00' }) === true)
check('打开时间早于回答 → 未读', computeLaneUnread({ hasMessages: true, lastAssistantAt: '2026-10-11 10:00:00', laneSeenAt: '2026-10-11 09:00:00' }) === true)
check('打开时间晚于回答 → 不未读', computeLaneUnread({ hasMessages: true, lastAssistantAt: '2026-10-11 10:00:00', laneSeenAt: '2026-10-11 11:00:00' }) === false)
check('打开时间等于回答 → 不未读（字典序 >=）', computeLaneUnread({ hasMessages: true, lastAssistantAt: '2026-10-11 10:00:00', laneSeenAt: '2026-10-11 10:00:00' }) === false)

console.log('\n=== 2. deriveLaneStatus：运行态 ===')
check('生成中 → run', deriveLaneStatus('done', 'assistant', true) === 'run')
check('存储 done 权威', deriveLaneStatus('done', 'user') === 'done')
check('存储 cut 权威', deriveLaneStatus('cut', 'assistant') === 'cut')
check('无存储 + 末条 AI → done', deriveLaneStatus(undefined, 'assistant') === 'done')
check('无存储 + 末条用户 → run', deriveLaneStatus(undefined, 'user') === 'run')
check('无存储 + 空 → run', deriveLaneStatus(undefined, '') === 'run')

// ---------------------------------------------------------------- B. 接线静态断言
console.log('\n=== 3. 主进程：agentSessionRepo ===')
const repo = read('electron/lib/agentSessionRepo.ts')
check('会话行含 lane_status / lane_seen_at', repo.includes('lane_status?:') && repo.includes('lane_seen_at?:'))
check('createSideLaneSession 初始化 lane_status=run', /lane:\s*'side',[\s\S]*?lane_status:\s*'run'/.test(repo))
check('导出 setSideLaneStatus / markSideLaneSeen', repo.includes('export function setSideLaneStatus') && repo.includes('export function markSideLaneSeen'))

console.log('\n=== 4. 主进程：agentService 投影 + 状态写入 + IPC ===')
const svc = read('electron/lib/agentService.ts')
check('引入 sideLaneMeta 纯函数', svc.includes("from './sideLaneMeta'") && svc.includes('computeLaneUnread') && svc.includes('deriveLaneStatus'))
check('buildSideLaneInfo 投影（unread/laneStatus/excerpt/anchorTitle）', svc.includes('function buildSideLaneInfo') && svc.includes('unread: computeLaneUnread(') && svc.includes('anchorTitle'))
check('listSideLanes handler 走 buildSideLaneInfo', svc.includes('.map(buildSideLaneInfo)'))
check('新增 handler agent:markSideLaneRead', svc.includes("ipcMain.handle('agent:markSideLaneRead'"))
check('聊天收尾写运行态（成功 done / 其余 cut）', svc.includes("setSideLaneStatus(sessionId, result.ok ? 'done' : 'cut')"))
check('camelRow 补 laneStatus / laneSeenAt 别名', svc.includes('laneStatus: row.lane_status') && svc.includes('laneSeenAt: row.lane_seen_at'))

console.log('\n=== 5. IPC 三处接线 ===')
check('preload 通道 agentMarkSideLaneRead', read('electron/preload/index.ts').includes("ipcRenderer.invoke('agent:markSideLaneRead'"))
check('ipc.ts 封装 agentMarkSideLaneRead', read('src/lib/ipc.ts').includes('export const agentMarkSideLaneRead'))
check('ipc.ts listSideLanes 返回 AgentSideLaneInfo', read('src/lib/ipc.ts').includes('Promise<AgentSideLaneInfo[]>'))
const types = read('src/types/index.ts')
check('types 定义 AgentSideLaneInfo（继承 AgentSessionInfo）', types.includes('export interface AgentSideLaneInfo extends AgentSessionInfo'))
check('types ElectronAPI 含 markSideLaneRead', types.includes('agentMarkSideLaneRead:'))

console.log('\n=== 6. 渲染层：SideLaneCenter + index 接线 ===')
const center = read('src/modules/ai-teaching/SideLaneCenter.tsx')
check('SideLaneCenter 存在且过滤已升格（lane!=main）', center.includes('export function SideLaneCenter') && center.includes("r.lane !== 'main'"))
check('打开即已读（agentMarkSideLaneRead）', center.includes('agentMarkSideLaneRead('))
check('搜索：标题 + 来源回答 + 摘要', center.includes('l.title +') && center.includes('anchorTitle') && center.includes('excerpt'))
check('详情复用 SideLanePanel 且带 onBack/onQuote/onFloat', center.includes('<SideLanePanel') && center.includes('onBack={back}') && center.includes('onQuote={onQuote}') && center.includes('onFloat='))
const idx = read('src/modules/ai-teaching/index.tsx')
check('index 引入 SideLaneCenter', idx.includes("import { SideLaneCenter } from './SideLaneCenter'"))
// v3.9.1 学习流 v2：右栏从两分区扩到「素材 / 支线 / 层级」三分区（方案 §三-1），
// 断言按新口径收：**三分区齐全 + 落到 localStorage + 读取时白名单**，而不是钉死旧的两态字面量。
check('右栏分区状态 railTab（三分区：进度 / 素材 / 支线）',
  /useState<'progress' \| 'sources' \| 'lanes'>\(/.test(idx) && idx.includes('aiTeach.railTab'))
check('锚点映射由会话库派生（不再 localStorage）', idx.includes('const anchorLanes = useMemo') && !idx.includes('ANCHOR_LANES_KEY'))
check('锚点 chip 走 openCenter（open/create）', idx.includes("openCenter(al ? { kind: 'open', laneId: al.laneId } : { kind: 'create'"))
check('引用回主线接 setQuotes', idx.includes('const quoteFromLane = useCallback') && idx.includes('setQuotes(prev'))
check('支线详情保留浮出能力（onFloat 可选）', read('src/modules/ai-teaching/SideLaneCenter.tsx').includes('onFloat?') && read('src/modules/ai-teaching/SideLanePanel.tsx').includes('onFloat?'))
check('右栏可切到素材库分区', idx.includes("setRailTab('sources')"))

console.log('\n=== 7. SideLanePanel 内嵌形态 ===')
const panel = read('src/modules/ai-teaching/SideLanePanel.tsx')
check('新增可选 props（onBack/onQuote/onFloat/hideTurns）', ['onBack?', 'onQuote?', 'onFloat?', 'hideTurns?'].every(s => panel.includes(s)))
check('内嵌顶栏「← 列表」', panel.includes('返回支线列表') && panel.includes('onBack ?'))
check('动作条含引用到主线 / 浮出窗口', panel.includes('引用到主线') && panel.includes('浮出窗口'))
check('首轮回执在 agentChat + refresh 之后（创建面板不提前卸载）', panel.indexOf('await agentChat(') > -1 && panel.indexOf('await refresh(laneId)') > panel.indexOf('await agentChat(') && panel.indexOf('onLaneReady?.(laneId') > panel.indexOf('await refresh(laneId)'))
check('首轮回执放在 finally（失败 / 中断也切详情）', panel.includes('} finally {') && /finally \{[\s\S]{0,260}onLaneReady\?\.\(laneId/.test(panel))
check('卸载后不再回执父级（aliveRef 守卫）', panel.includes('const aliveRef = useRef(true)') && panel.includes('aliveRef.current = false') && /aliveRef\.current\) \{[\s\S]{0,500}onLaneReady\?\.\(laneId/.test(panel))
check('doSend 依赖数组含 onLaneReady', /\[input, pending, laneId, beginStream, endStream, refresh, onLaneReady\]/.test(panel))

// ---------------------------------------------------------------- 汇总
let pass = 0, fail = 0
for (const c of checks) { if (c.pass) { pass++; console.log(`  PASS  ${c.name}`) } else { fail++; console.log(`  FAIL  ${c.name}${c.detail ? '  -- ' + c.detail : ''}`) } }
console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
