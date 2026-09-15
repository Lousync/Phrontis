/**
 * 契约验证：仓库文件监听的「忽略规则 / 自写抑制 / 防抖聚合 / 生命周期与降级」。
 *
 * 为什么需要它：
 *   v3.2.0 条目 ④（文件树实时反映外部变更）有一类**不报错、只是永远错**的静默缺陷，
 *   且都在「边界条件」上，重构时极易被写回去：
 *     ① 忽略规则漏掉 `.knowbase/` → jsonStore 每次原子写都触发广播，知识库模块自己把自己的
 *        索引刷掉（抖动）；漏掉 `.kb-tmp-*` → 编辑器每次保存都多刷一轮（原子写的中间物）。
 *     ② **自写抑制写漏 = 本项最刺眼的 bug**：应用内保存被监听器当成外部修改 → 自己弹
 *        「文件已被外部修改」三选。这条一旦回归，用户每天都会撞到。
 *     ③ 防抖窗口内的事件必须**合并成一次**广播且路径去重（否则 git checkout 会打爆渲染层）。
 *     ④ 切仓库窗口期到达的旧仓库事件必须丢弃（否则新仓库的树被旧仓库的改动刷）。
 *     ⑤ 降级路径（仓库被移走 / 网络盘）只能**如实上报一次**，且不得掀翻主进程。
 *   另外「广播通道」这条协议横跨 4 个文件（主进程广播表 / preload / ipc 封装 / 类型声明），
 *   改一处漏三处同样是不报错的静默失效 —— 一并纳入回归。
 *
 * 做法（与 verify-update-stall.mjs 一致）：从 electron/lib/fsWatcher.ts 切出**整段真实实现**
 *   （stripTypeScriptTypes 剥类型 → 写临时 .mjs → import），只 stub 副作用依赖：
 *   fs.watch 替身（事件由用例手工投递）、getCurrentVault（可控当前仓库）、
 *   broadcast / broadcastDataChanged（录调用）、两个 invalidate（计数）。
 *   验的是真实 onFsEvent / flush / markSelfWrite / syncVaultWatcher，不是复刻品。
 *
 * 运行（项目根目录，无需 --experimental-strip-types）：
 *   node --no-warnings .AGENT/scripts/editor/verify-fs-watcher.mjs [仓库路径]
 * 期望：全部 PASS 且 exit=0
 *
 * 注：自写抑制的过期用例把 SELF_WRITE_TTL_MS 按比例缩小到 60ms（等真实 1500ms 太慢），
 *     其余用例用未打补丁的真实 DEBOUNCE_MS（300ms）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const SRC_FS = path.join(ROOT, 'electron/lib/fsWatcher.ts')
const src = fs.readFileSync(SRC_FS, 'utf8')

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

const readIfExists = (rel) => {
  const p = path.join(ROOT, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}
const windowBus = readIfExists('electron/main/windowBus.ts')
const preload = readIfExists('electron/preload/index.ts')
const ipcLib = readIfExists('src/lib/ipc.ts')
const typeDecl = readIfExists('src/types/index.ts')
const wsMgr = readIfExists('electron/lib/workspaceManager.ts')
const mainIdx = readIfExists('electron/main/index.ts')
const editorIdx = readIfExists('src/modules/editor/index.tsx')
const aiTeachIdx = readIfExists('src/modules/ai-teaching/index.tsx')
const aiTeachTree = readIfExists('src/modules/ai-teaching/AiTeachFileTree.tsx')

// ---------------------------------------------------------------- 静态：协议四处 + 接线清单
check('广播表声明 wsFsChanged 通道', /wsFsChanged:\s*'ws:fs-changed'/.test(windowBus))
check('preload 订阅 ws:fs-changed', /ipcRenderer\.on\('ws:fs-changed'/.test(preload))
check('preload 暴露 onWsFsChanged', /onWsFsChanged:\s*\(cb/.test(preload))
check('ipc.ts 导出 onWsFsChanged 封装', /export const onWsFsChanged\b/.test(ipcLib))
check('types/index.ts 声明 onWsFsChanged', /onWsFsChanged:\s*\(cb/.test(typeDecl))
check('preload 暴露 workspaceRefreshVault', /workspaceRefreshVault:\s*\(\)/.test(preload))
check('ipc.ts 导出 workspaceRefreshVault 封装', /export const workspaceRefreshVault\b/.test(ipcLib))
check('types/index.ts 声明 workspaceRefreshVault', /workspaceRefreshVault:\s*\(\)/.test(typeDecl))

// 主进程：IPC + 挂载点 + 退出 + 自写登记
check('主进程注册 ws:refreshVault', /ipcMain\.handle\('ws:refreshVault'/.test(wsMgr))
check('手动刷新做归档清单 prune（复用 gcArchiveEntries）',
  /pruned = gcArchiveEntries\(\)/.test(wsMgr) && /gcArchiveEntries/.test(wsMgr))
check('watcher 路径同样做归档清单 prune（双路径都要有）', /gcArchiveEntries\(\)/.test(src))
check('手动刷新广播 knowledge', /broadcastDataChanged\('knowledge'\)/.test(wsMgr))
const syncCalls = (wsMgr.match(/syncVaultWatcher\(\)/g) || []).length
check('仓库登记/切换/删除/退出均重挂或关闭监听（≥5 处）', syncCalls >= 5, `实际 ${syncCalls} 处`)
check('writeWorkspaceFile 落盘前登记自写', /markSelfWrite\(absPath\)/.test(wsMgr))
check('应用内改名同时登记新旧两条路径',
  /markSelfWrite\(from\)[\s\S]{0,80}markSelfWrite\(to\)/.test(wsMgr))
check('应用内删除登记自写（不误弹「已在磁盘上被删除」）', /markSelfWrite\(abs\)/.test(wsMgr))
check('before-quit 关闭监听', /closeVaultWatcher\(\)/.test(mainIdx))

// 渲染层：编辑器 + AI 教学
check('编辑器消费 ws:fs-changed', /onWsFsChanged\(/.test(editorIdx))
check('编辑器窗口聚焦兜底重扫', /addEventListener\('focus', onFocus\)/.test(editorIdx))
check('编辑器手动刷新按钮（RefreshCw + 标题）',
  /RefreshCw/.test(editorIdx) && /title="刷新资源管理器"/.test(editorIdx))
check('编辑器刷新走口径 b 全量（workspaceRefreshVault）', /workspaceRefreshVault\(\)/.test(editorIdx))
check('编辑器刷新不动视图态（未清 dirCache / 未复位 expanded）',
  !/setDirCache\(\{\}\)[\s\S]{0,200}refreshExplorer/.test(editorIdx))
check('AI 教学消费 ws:fs-changed', /onWsFsChanged\(/.test(aiTeachIdx))
check('AI 教学左栏对称刷新按钮', /title="刷新资源管理器"/.test(aiTeachIdx) && /RefreshCw/.test(aiTeachIdx))
check('AiTeachFileTree 接受 refreshSeq 原始类型 prop',
  /refreshSeq\?:\s*number/.test(aiTeachTree) && /refreshSeq\b/.test(aiTeachIdx))

// ---------------------------------------------------------------- 切出真实实现
/**
 * 整段切片：从第一个常量注释起到文件末尾（含全部状态与函数）。
 * 这一段里没有 import（外部依赖全在文件头），因此把头部替换成 stub 即可独立运行。
 */
function buildHarness(ttlMs) {
  const bodyStart = src.indexOf('/** 防抖窗口')
  if (bodyStart < 0) throw new Error('未找到切片起点（/** 防抖窗口）')
  let body = src.slice(bodyStart)
  const realTtl = /const SELF_WRITE_TTL_MS = (\d+)/.exec(body)
  if (!realTtl) throw new Error('未找到 SELF_WRITE_TTL_MS')
  if (ttlMs != null) {
    body = body.replace(`const SELF_WRITE_TTL_MS = ${realTtl[1]}`, `const SELF_WRITE_TTL_MS = ${ttlMs}`)
    if (!body.includes(`const SELF_WRITE_TTL_MS = ${ttlMs}`)) throw new Error('TTL 补丁未生效')
  }
  return `
import { relative } from 'node:path'

// ---- 副作用替身（唯一被替换的部分）----
export const __ctl = {
  vault: null,            // 当前仓库：{ rootId, rootPath }
  events: [],             // broadcast / broadcastDataChanged 调用记录
  indexInvalidated: 0,
  graphInvalidated: 0,
  archivePruned: 0,
}
export function getCurrentVault() { return __ctl.vault }
export function invalidateKnowledgeIndex() { __ctl.indexInvalidated++ }
export function invalidateGraphIndex() { __ctl.graphInvalidated++ }
export function gcArchiveEntries() { __ctl.archivePruned++; return 0 }
export function broadcast(channel, payload) { __ctl.events.push({ kind: 'channel', channel, payload }) }
export function broadcastDataChanged(scope) { __ctl.events.push({ kind: 'data', scope }) }
export const BROADCAST_CHANNEL = { wsFsChanged: 'ws:fs-changed' }

// fs.watch 替身：记录监听目标；事件由用例经 __watch.fire 手工投递
export const __watch = { target: null, opts: null, closed: 0, handlers: {}, last: null }
function watch(target, opts) {
  __watch.target = target
  __watch.opts = opts
  __watch.handlers = {}
  const w = {
    on(ev, cb) { __watch.handlers[ev] = cb; return w },
    close() { __watch.closed++ },
  }
  __watch.last = w
  return w
}

${body}

// 源码里只有对外契约函数带 export；内部件（忽略判定 / 事件入口 / 状态表）在此补导出，
// 好在用例里直接验它们（仍是被测的真实实现，不是复刻）
export { isIgnoredRel, relOf, onFsEvent, flush, pending, selfWritePaths }
`
}

const tmpFiles = []
async function loadHarness(ttlMs) {
  const ts = buildHarness(ttlMs)
  let js
  try {
    js = stripTypeScriptTypes(ts, { mode: 'transform', sourceMap: false })
  } catch (e) {
    const dump = path.join(os.tmpdir(), `phrontis-fs-watcher-${process.pid}-${ttlMs ?? 'real'}.dump.ts`)
    fs.writeFileSync(dump, ts, 'utf8')
    throw new Error(`${e?.message}（装配源码已写到 ${dump}）`)
  }
  const file = path.join(os.tmpdir(), `phrontis-fs-watcher-${process.pid}-${ttlMs ?? 'real'}.mjs`)
  fs.writeFileSync(file, js, 'utf8')
  tmpFiles.push(file)
  return import(pathToFileURL(file).href)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 等一个防抖周期 + 余量（DEBOUNCE_MS 未打补丁 = 300ms） */
const FLUSH_WAIT = 480

/** 当前仓库 A / B（relOf 与忽略规则都以 rootPath 为基准） */
const VAULT_A = { rootId: 'root-A', rootPath: path.join(ROOT, '__watcher_probe_a') }
const VAULT_B = { rootId: 'root-B', rootPath: path.join(ROOT, '__watcher_probe_b') }

async function run() {
  const H = await loadHarness(null)
  const { __ctl, __watch } = H

  // ---------------- 1. 忽略规则（纯函数）----------------
  const ignored = ['.knowbase/modules/knowledge/a.json', '.git/HEAD', 'node_modules/pkg/index.js',
    'docs/.kb-tmp-3f2a', 'notes/draft.tmp', 'a/b/.git/config', '.DS_Store']
  const kept = ['notes/a.md', '.ignore', 'web/04-list.html', 'a/.kb-tmp.md']
  const badIgnored = ignored.filter((p) => H.isIgnoredRel(p) !== true)
  const badKept = kept.filter((p) => H.isIgnoredRel(p) !== false)
  check('忽略规则命中 .knowbase/.git/node_modules/*.tmp/.kb-tmp-*',
    badIgnored.length === 0, badIgnored.length ? `漏判：${badIgnored.join(', ')}` : '')
  check('忽略规则不误伤 .md / 网页文件 / .ignore（不用 .ignore 规则过滤）',
    badKept.length === 0, badKept.length ? `误判：${badKept.join(', ')}` : '')

  // ---------------- 2. relOf：仓库内 posix / 仓库外空串 ----------------
  const inside = H.relOf(VAULT_A.rootPath, path.join(VAULT_A.rootPath, 'web', '04-list.html'))
  const outside = H.relOf(VAULT_A.rootPath, path.join(ROOT, '..', 'elsewhere.md'))
  check('relOf 归一为 posix 相对路径', inside === 'web/04-list.html', `得到 ${JSON.stringify(inside)}`)
  check('relOf 对仓库外路径返回空串', outside === '', `得到 ${JSON.stringify(outside)}`)

  // ---------------- 3. 防抖聚合 + 路径去重 + 索引联动 ----------------
  __ctl.vault = VAULT_A
  H.syncVaultWatcher()
  check('同步监听：按当前仓库挂 watch 且 recursive',
    __watch.target === VAULT_A.rootPath && __watch.opts?.recursive === true,
    `target=${__watch.target}`)
  const watchCountBefore = __watch.closed
  H.syncVaultWatcher()
  check('重复同步是幂等的（不重挂）', __watch.closed === watchCountBefore && __watch.target === VAULT_A.rootPath)

  __ctl.events.length = 0
  __ctl.indexInvalidated = 0
  __ctl.graphInvalidated = 0
  __ctl.archivePruned = 0
  __watch.handlers.change?.(null, 'notes/a.md')
  __watch.handlers.change?.(null, 'notes\\b.md')
  __watch.handlers.change?.(null, 'notes/a.md')
  __watch.handlers.change?.(null, '.knowbase/modules/knowledge/x.json')
  await sleep(FLUSH_WAIT)
  const fsEvents = __ctl.events.filter((e) => e.kind === 'channel' && e.channel === 'ws:fs-changed')
  const relPaths = fsEvents[0]?.payload?.relPaths ?? []
  check('防抖窗口内多次事件合并为一次广播', fsEvents.length === 1, `实际 ${fsEvents.length} 次`)
  check('relPaths 去重且归一 posix（忽略项不入列）',
    relPaths.length === 2 && relPaths.includes('notes/a.md') && relPaths.includes('notes/b.md'),
    JSON.stringify(relPaths))
  check('命中级联索引失效 + 知识库刷新',
    __ctl.indexInvalidated === 1 && __ctl.graphInvalidated === 1 &&
    __ctl.events.some((e) => e.kind === 'data' && e.scope === 'knowledge'))
  check('watcher 路径也清理归档清单僵尸条目（外部删除已归档文件）', __ctl.archivePruned === 1,
    `实际 ${__ctl.archivePruned} 次`)

  // ---------------- 4. 全是忽略项时不广播（jsonStore 自写不抖动）----------------
  __ctl.events.length = 0
  __watch.handlers.change?.(null, '.knowbase/modules/schedule/todos.json')
  __watch.handlers.change?.(null, 'a/.kb-tmp-9')
  await sleep(FLUSH_WAIT)
  check('只有被忽略的路径时不产生广播（.knowbase 自写零抖动）', __ctl.events.length === 0,
    JSON.stringify(__ctl.events))

  // ---------------- 5. 自写抑制（本项最刺眼的 bug 的护栏）----------------
  __ctl.events.length = 0
  H.markSelfWrite(path.join(VAULT_A.rootPath, 'notes/a.md'))
  __watch.handlers.change?.(null, 'notes/a.md')
  await sleep(FLUSH_WAIT)
  check('自写抑制：应用内保存的路径不触发广播（不误弹「已被外部修改」）', __ctl.events.length === 0,
    JSON.stringify(__ctl.events))

  // 同一次事件里混入一条真实外部改动 → 只广播未被抑制的那条
  __ctl.events.length = 0
  H.markSelfWrite(path.join(VAULT_A.rootPath, 'notes/a.md'))
  __watch.handlers.change?.(null, 'notes/a.md')
  __watch.handlers.change?.(null, 'notes/c.md')
  await sleep(FLUSH_WAIT)
  const mixed = __ctl.events.find((e) => e.kind === 'channel' && e.channel === 'ws:fs-changed')
  check('自写抑制只吞自己的那条（同批外部改动照常广播）',
    (mixed?.payload?.relPaths ?? []).join(',') === 'notes/c.md',
    JSON.stringify(mixed?.payload?.relPaths ?? null))

  // 仓库外路径不登记（防把外部路径写进抑制表）
  H.markSelfWrite(path.join(ROOT, '..', 'outside.md'))
  check('仓库外路径不进入自写抑制表', ![...H.selfWritePaths.keys()].some((k) => k.startsWith('..')))

  // ---------------- 6. 切仓库：旧仓库事件丢弃 + 新仓库接管 ----------------
  __ctl.vault = VAULT_B
  H.syncVaultWatcher()
  check('切仓库后 watch 指向新仓库', __watch.target === VAULT_B.rootPath, `target=${__watch.target}`)
  __ctl.events.length = 0
  __watch.handlers.change?.(null, 'notes/a.md') // 旧仓库语义的事件（当前已切到 B）
  await sleep(FLUSH_WAIT)
  check('切仓库窗口期到达的旧事件被丢弃', __ctl.events.length === 0, JSON.stringify(__ctl.events))

  // ---------------- 7. filename 为 null：语义「可能有任意变化」也要刷 ----------------
  __ctl.events.length = 0
  __watch.handlers.change?.(null, null)
  await sleep(FLUSH_WAIT)
  const nullEvt = __ctl.events.find((e) => e.kind === 'channel' && e.channel === 'ws:fs-changed')
  check('filename 缺失时仍广播（relPaths=[] = 可能有任意变化）',
    Array.isArray(nullEvt?.payload?.relPaths) && nullEvt.payload.relPaths.length === 0)

  // ---------------- 8. 降级：只上报一次、不掀翻进程 ----------------
  __ctl.events.length = 0
  const closedBefore = __watch.closed
  __watch.handlers.error?.(new Error('EPERM: watch failed'))
  const degraded = __ctl.events.filter((e) => e.kind === 'channel' && e.channel === 'ws:fs-changed')
  check('watcher 报错 → 关闭监听并如实上报一次',
    __watch.closed === closedBefore + 1 && degraded.length === 1 && !!degraded[0].payload?.watcherError,
    `closed=${__watch.closed} events=${degraded.length}`)
  __ctl.events.length = 0
  __watch.handlers.error?.(new Error('again'))
  check('降级提示不重复轰炸（同一次会话只报一次）', __ctl.events.length === 0)

  // ---------------- 9. 退出：closeVaultWatcher 关掉句柄且可重挂 ----------------
  H.closeVaultWatcher()
  const closedAfterExit = __watch.closed
  H.syncVaultWatcher()
  check('关闭后仍可重挂（退出→重开同一仓库不丢监听）',
    __watch.closed === closedAfterExit && __watch.target === VAULT_B.rootPath)

  // ---------------- 10. 自写抑制会过期（不能永久吞事件）----------------
  const H2 = await loadHarness(60)
  H2.__ctl.vault = VAULT_A
  H2.syncVaultWatcher()
  H2.markSelfWrite(path.join(VAULT_A.rootPath, 'notes/a.md'))
  H2.__watch.handlers.change?.(null, 'notes/a.md')
  await sleep(FLUSH_WAIT)
  const firstWave = H2.__ctl.events.length
  H2.__ctl.events.length = 0
  H2.__watch.handlers.change?.(null, 'notes/a.md') // TTL(60ms) 早已过期
  await sleep(FLUSH_WAIT)
  check('自写抑制有 TTL：过期后同一路径照常广播（不永久静音）',
    firstWave === 0 && H2.__ctl.events.length > 0,
    `抑制窗内=${firstWave} 过期后=${H2.__ctl.events.length}`)
  H2.closeVaultWatcher()
}

try {
  await run()
} catch (e) {
  check('用例执行未抛异常', false, e?.stack || String(e))
} finally {
  if (!process.env.KEEP_HARNESS) {
    for (const f of tmpFiles) { try { fs.unlinkSync(f) } catch { /* ignore */ } }
  } else {
    for (const f of tmpFiles) console.log('保留临时模块:', f)
  }
}

// ---------------------------------------------------------------- 汇总
const failed = checks.filter((c) => !c.pass)
console.log('\n=== verify-fs-watcher ===')
console.log(`源文件: ${SRC_FS}`)
console.log(`断言: ${checks.length - failed.length} PASS / ${failed.length} FAIL（共 ${checks.length}）\n`)
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  → ' + c.detail : ''}`)
}
if (failed.length) {
  console.log(`\nFAILED: ${failed.map((c) => c.name).join(' | ')}`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
