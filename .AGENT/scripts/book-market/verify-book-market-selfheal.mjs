// 契约验证：书市 S6 元数据自愈的静态接线
// （方案 `.claude/plans/s6-metadata-selfheal.md`）
//
// 分工：本脚本验**静态接线** —— 「漏了就静默降级」的东西：
//   ① 核心函数 `bookMetaPruneOrphans` 仍在（含扫盘 + 比孤儿 + 删孤儿封面 + 删无引用封面四步）
//   ② workspaceManager：import + 一个 helper，且在**三个仓库打开点**各调一次
//      （启动恢复 loadVaults / 换库 adoptVaultDirectory / 按 id 打开 ws:openById）
//   ③ fsWatcher：import + 节流常量（≥30s）+ flush() 内「涉及 .books/ 才触发」
//   ④ 关键不变量：`.books` 不在 IGNORED_SEGMENTS 里 —— 否则事件根本到不了 flush，自愈**静默死掉**
//   ⑤ 负向：零新 IPC（无 prune/selfheal 通道）+ 零新 UI（渲染层不碰 prune 函数）
//
// 运行（仓库根目录）：
//   node .AGENT/scripts/book-market/verify-book-market-selfheal.mjs
// 期望：全部 ok + exit=0

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const code = (rel) => stripComments(read(rel))

const META_REPO = 'electron/lib/kbStore/vaultBookMetaRepo.ts'
const SCHEMA = 'electron/lib/kbStore/bookMarketSchema.ts'
const WS = 'electron/lib/workspaceManager.ts'
const WATCHER = 'electron/lib/fsWatcher.ts'

/* ================= ① 核心函数仍在且四步齐全 ================= */
console.log('\n--- ① bookMetaPruneOrphans 核心实现 ---')
const metaRepo = code(META_REPO)
check('导出 bookMetaPruneOrphans', /export function bookMetaPruneOrphans\s*\(/.test(metaRepo))
const fnStart = metaRepo.indexOf('export function bookMetaPruneOrphans')
const fnBody = fnStart >= 0 ? metaRepo.slice(fnStart, metaRepo.indexOf('\n}', fnStart) + 2) : ''
check('扫盘取现存清单（scanVaultBooks）', /scanVaultBooks\(/.test(fnBody))
check('比孤儿（pruneOrphanMeta）', /pruneOrphanMeta\(/.test(fnBody))
check('回收孤儿条目引用的封面（bookCoverDelete）', /bookCoverDelete\(/.test(fnBody))
check('回收无引用封面（bookCoverDeleteUnreferenced）', /bookCoverDeleteUnreferenced\(/.test(fnBody))
check('无孤儿时提前返回（不空写盘）', /removedCount\s*===\s*0/.test(fnBody))
check('pruneOrphanMeta 在 schema 里导出（纯函数层）', /export function pruneOrphanMeta\s*\(/.test(code(SCHEMA)))

/* ================= ② workspaceManager：import + helper + 三个打开点 ================= */
console.log('\n--- ② workspaceManager 三处仓库打开点 ---')
const ws = code(WS)
check('import bookMetaPruneOrphans', /import\s*\{[^}]*bookMetaPruneOrphans[^}]*\}\s*from\s*'\.\/kbStore\/vaultBookMetaRepo'/.test(ws))

const HELPER = 'pruneOrphanBookMetaQuiet'
const helperDef = new RegExp(`function ${HELPER}\\s*\\(`).test(ws)
check(`定义 helper ${HELPER}`, helperDef)
check('helper 内调用 bookMetaPruneOrphans', helperDef && /bookMetaPruneOrphans\(\)/.test(ws))

// helper 调用点：必须恰好 3 处，且每处紧跟 syncVaultWatcher()
const wsLines = ws.split(/\r?\n/)
const callSites = []
wsLines.forEach((l, i) => { if (new RegExp(`${HELPER}\\(\\)`).test(l) && !/function/.test(l)) callSites.push(i) })
check('helper 恰好 3 处调用', callSites.length === 3, `count=${callSites.length}`)
const eachAfterSync = callSites.every((i) => {
  for (let j = i - 1; j >= Math.max(0, i - 6); j--) if (/syncVaultWatcher\(\)/.test(wsLines[j])) return true
  return false
})
check('三处调用都紧跟 syncVaultWatcher()（仓库打开后）', callSites.length > 0 && eachAfterSync)

// 覆盖三个函数：loadVaults / adoptVaultDirectory / ws:openById（一律用行号，避免 CRLF 下的字符位错位）
const lineOf = (re) => wsLines.findIndex((l) => re.test(l))
const loadV = lineOf(/function loadVaults\s*\(/)
const adoptV = lineOf(/function adoptVaultDirectory\s*\(/)
const openById = lineOf(/ipcMain\.handle\(\s*'ws:openById'/)
const inSpan = (from, to) => from >= 0 && callSites.some((i) => i > from && (to < 0 || i < to))
check('loadVaults（启动恢复）内有调用', inSpan(loadV, adoptV))
check('adoptVaultDirectory（换库）内有调用', inSpan(adoptV, openById))
check('ws:openById（按 id 打开）内有调用', inSpan(openById, -1))

/* ================= ③ fsWatcher：import + 节流 + .books/ 触发 ================= */
console.log('\n--- ③ fsWatcher 实时节流 ---')
const watcher = code(WATCHER)
check('import bookMetaPruneOrphans', /import\s*\{[^}]*bookMetaPruneOrphans[^}]*\}\s*from\s*'\.\/kbStore\/vaultBookMetaRepo'/.test(watcher))
const throttleMatch = watcher.match(/PRUNE_THROTTLE_MS\s*=\s*([\d_]+)/)
const throttleMs = throttleMatch ? Number(throttleMatch[1].replace(/_/g, '')) : 0
check('节流常量 PRUNE_THROTTLE_MS ≥ 30_000', throttleMs >= 30000, `=${throttleMs}ms`)
check('节流状态变量 lastPruneAt', /let\s+lastPruneAt\s*=\s*0/.test(watcher))
check('flush 内按 .books/ 前缀判定（不是全量触发）', /\.books\//.test(watcher) && /startsWith\(['"]\.books\//.test(watcher))
check('触发前做节流比较（now - lastPruneAt >= PRUNE_THROTTLE_MS）', /now\s*-\s*lastPruneAt\s*>=\s*PRUNE_THROTTLE_MS/.test(watcher))
// 触发必须在 flush() 内
const flushStart = watcher.indexOf('function flush(')
const flushBody = flushStart >= 0 ? watcher.slice(flushStart, watcher.indexOf('\n}', flushStart)) : ''
check('触发落在 flush() 内', /bookMetaPruneOrphans\(\)/.test(flushBody))

/* ================= ④ 关键不变量：.books 不在忽略集里 ================= */
console.log('\n--- ④ 事件可达性不变量 ---')
const ignoredMatch = watcher.match(/IGNORED_SEGMENTS\s*=\s*new Set\(\[([^\]]*)\]\)/)
const ignored = ignoredMatch ? ignoredMatch[1] : ''
check('IGNORED_SEGMENTS 存在', !!ignoredMatch)
check('★ .books 不在 IGNORED_SEGMENTS（否则 .books/ 事件被吞、自愈静默失效）',
  !!ignoredMatch && !/['"]\.books['"]/.test(ignored), ignored.trim().slice(0, 80))

/* ================= ⑤ 负向：零新 IPC / 零新 UI ================= */
console.log('\n--- ⑤ 负向断言 ---')
const walk = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) acc.push(p)
  }
  return acc
}
const electronFiles = walk(join(ROOT, 'electron'))
const ipcLeak = electronFiles.filter((f) => /bookMarket:(prune|selfheal|meta-prune)|selfheal/.test(stripComments(readFileSync(f, 'utf8'))))
check('零新 IPC 通道（无 bookMarket:prune / selfheal 字样）', ipcLeak.length === 0, ipcLeak.map((f) => f.replace(ROOT, '')).join(','))
const srcFiles = walk(join(ROOT, 'src'))
const uiLeak = srcFiles.filter((f) => /bookMetaPruneOrphans/.test(stripComments(readFileSync(f, 'utf8'))))
check('零新 UI（渲染层不碰 prune 函数）', uiLeak.length === 0, uiLeak.map((f) => f.replace(ROOT, '')).join(','))

/* ================= 结尾 ================= */
console.log('\n========================================')
if (!existsSync(join(ROOT, META_REPO))) {
  console.log('❌ 找不到 vaultBookMetaRepo.ts —— 请从仓库根目录运行')
  process.exit(1)
}
if (pass) {
  console.log('✅ 书市 S6 元数据自愈静态接线契约全部通过')
  process.exit(0)
}
console.log('❌ 有断言失败 —— 见上面的 fail 行')
process.exit(1)
