/**
 * 删除书签端到端探针（2026-09-23，删书 + 删除书签一轮的 **R1 回归判据**）。
 *
 * ## 为什么必须有它（而不是只跑契约）
 * 契约脚本（`verify-reader-formats.mjs` §⑯）只能验**静态接线**：三阅读器都挂了监听、右栏都发了事件。
 * 但 R1 这条风险是**时序/内存**问题，静态断言永远绿：
 *   三个阅读器把书签存在**内存权威数组**里，而「加书签」是**整数组覆盖写**。
 *   若右栏图省事直接 `readerStatePatch({bookmarks})`，阅读器内存里的旧数组会在用户**下一次加书签**时
 *   把已删条目**写回去**（静默复活，无报错、无 Toast、磁盘上看着一切正常）。
 *   ⇒ 只有真跑一遍「删一条 → 再加一条 → 读盘」才判得出来。这正是记忆 `contract-green-locks-wrong-order`
 *     说的那类：**契约全绿 ≠ 运行期生效**。
 *
 * ## 判定面
 *   ① 工具栏加书签 → 图标态翻成「移除本段书签」（基线：确认书签真的加上了）
 *   ② 右栏 ✕ 删掉它 → 磁盘 readerState.json 该书 bookmarks 长度 0（删除真的落盘）
 *   ③ ★ 工具栏态**复位**回「收藏本段书签」（同一段：书签没了，图标就该变回加号）
 *   ④ ★★ **不复活**：换一段再加书签 → 磁盘恰好 1 条，且 `paraIndex` **不是**刚删的那条
 *      （内存数组若没跟着删，这里会是 2 条 —— 这就是 R1 的判据）
 *
 * ## 跑法（两步）
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books --ud "knowbase (dev probe-app)"
 *   node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs .AGENT/scripts/workbench-shell/probes/probe-bookmark-delete.mjs
 *
 * ★ 用 `run-probe-app.mjs`（隔离实例）而不是 `run-probe.mjs`：后者 cwd = 仓库根，userData 与**用户自己
 *   开着的 dev 窗口同一个** ⇒ 抢不到单实例锁 → 实例静默退出 → 只报「CDP page target 未出现」。
 *   隔离实例的 userData 是 `knowbase (dev probe-app)`，不必 kill 用户的窗口。细节见该脚本头注。
 * ★ 前置：`npm run build`（探针跑 `out/` 构建产物）。
 * ★ 只验 txt 引擎：三引擎共用同一事件通道与同一「内存权威数组」纪律，txt 最易自动化（段落是 DOM 元素）。
 *   foliate/pdf 的对应接线由 §⑯ 的静态断言锁；真跑三引擎成本不成比例。
 */
const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT || 9222)
const { readFileSync } = await import('node:fs')
const { join } = await import('node:path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const FIXTURE = join(process.cwd(), 'tmp', 'vault-fixture')
const BOOK_SUFFIX = '/.books/探针样书.txt'

/** 读磁盘：该书在 readerState.json 里的 bookmarks（读不到 → null，与「空数组」区分开） */
function readBookmarksFromDisk() {
  try {
    const store = JSON.parse(readFileSync(join(FIXTURE, '.knowbase', 'modules', 'readerState.json'), 'utf8'))
    const key = Object.keys(store.books ?? {}).find((k) => k.endsWith(BOOK_SUFFIX))
    if (!key) return null
    const bk = store.books[key]?.bookmarks
    return Array.isArray(bk) ? bk : []
  } catch { return null }
}

async function waitPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page && page.webSocketDebuggerUrl) return page
    } catch { /* 等 electron 起 */ }
    await sleep(500)
  }
  throw new Error('CDP page target 未出现')
}

let ws
let msgId = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常')
  return r.result?.value
}

let failed = false
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' fail '} ${name}${cond ? '' : `  [${extra}]`}`)
  if (!cond) failed = true
}

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id) }
  }
  for (let i = 0; i < 24; i++) {
    if (await evalJs(`!!document.querySelector('[data-wb-bookmark="bookshelf"]')`).catch(() => false)) break
    await sleep(500)
  }
  await sleep(800)

  // ===== 开书架 → 开 TXT 书 =====
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="bookshelf"]')?.click(); return true })()`)
  await sleep(1200)
  const opened = await evalJs(`(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => (x.getAttribute('title') || '').includes('.txt'))
    b?.click(); return !!b
  })()`)
  ok('找到并点击 TXT 书卡片', opened)
  for (let i = 0; i < 20; i++) {
    if (await evalJs(`!!document.querySelector('[data-wb="txtReader"]')`)) break
    await sleep(300)
  }
  await sleep(800)

  const scrollBox = await evalJs(`(() => {
    const sc = document.querySelector('[data-wb="txtReader"] .overflow-y-auto')
    if (!sc) return null
    const r = sc.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), max: sc.scrollHeight - sc.clientHeight }
  })()`)
  if (!scrollBox) { console.error('TXT 滚动容器不可用'); process.exit(1) }
  const wheel = (dy) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scrollBox.x, y: scrollBox.y, deltaX: 0, deltaY: dy })
  /** 真实滚轮滚到指定比例（合成 scroll 事件不触发 React onScroll，见 probe-reading-panel 教训） */
  const scrollTo = async (ratio) => {
    const target = Math.round(scrollBox.max * ratio)
    const cur = await evalJs(`(() => { const sc = document.querySelector('[data-wb="txtReader"] .overflow-y-auto'); return sc ? Math.round(sc.scrollTop) : 0 })()`)
    let delta = target - cur
    while (Math.abs(delta) > 8) {
      const step = Math.max(-240, Math.min(240, delta))
      await wheel(step)
      await sleep(40)
      delta -= step
    }
    await sleep(600) // 让 topPara 随滚动稳定下来
  }
  const toolbarTitle = () => evalJs(`document.querySelector('[data-wb="txtBookmark"]')?.getAttribute('title') ?? null`)
  const marksCount = () => evalJs(`(() => {
    const el = document.querySelector('[data-wb="readingMarks"]')
    return el ? Number(el.getAttribute('data-wb-marks')) : null
  })()`)

  // ===== ① 基线：滚到中段加一条书签 =====
  await scrollTo(0.45)
  const t0 = await toolbarTitle()
  ok('加书签前：工具栏态是「收藏本段书签」', t0 === '收藏本段书签', `title=${t0}`)
  await evalJs(`(() => { document.querySelector('[data-wb="txtBookmark"]')?.click(); return true })()`)
  await sleep(900)
  const t1 = await toolbarTitle()
  ok('① 加书签后：工具栏态翻成「移除本段书签」', t1 === '移除本段书签', `title=${t1}`)
  const bm1 = readBookmarksFromDisk()
  ok('① 基线：磁盘 readerState.json 该书 bookmarks 恰 1 条', Array.isArray(bm1) && bm1.length === 1, JSON.stringify(bm1))
  const deletedPara = bm1?.[0]?.paraIndex
  ok('① 基线：书签带 paraIndex（txt 定位口径）', typeof deletedPara === 'number', `paraIndex=${deletedPara}`)

  // ===== ② 右栏 ✕ 删掉它 =====
  await evalJs(`(() => { document.querySelector('[data-wb-rp-tab="reading"]')?.click(); return true })()`)
  await sleep(900)
  const beforeDel = await marksCount()
  ok('② 右栏书签区先看到 1 条', beforeDel === 1, `marks=${beforeDel}`)
  const delClicked = await evalJs(`(() => {
    const btn = document.querySelector('[data-wb="readingMark"] [data-wb="readingMarkDel"]')
    btn?.click(); return !!btn
  })()`)
  ok('② 点右栏书签行的 ✕', delClicked)
  await sleep(900)
  const afterDel = await marksCount()
  ok('② 右栏书签区变 0 条', afterDel === 0, `marks=${afterDel}`)
  const bm2 = readBookmarksFromDisk()
  ok('② ★ 磁盘 readerState.json bookmarks 已清空（删除真落盘）', Array.isArray(bm2) && bm2.length === 0, JSON.stringify(bm2))

  // ===== ③ 工具栏态复位（同一段，书签没了 → 图标该变回加号）=====
  const t2 = await toolbarTitle()
  ok('③ ★ 工具栏态复位回「收藏本段书签」（右栏删了，阅读器内存跟着清）', t2 === '收藏本段书签', `title=${t2}`)

  // ===== ④ ★★ 不复活：换一段再加 → 磁盘恰 1 条，且不是刚删的那条 =====
  await scrollTo(0.8)
  const t3 = await toolbarTitle()
  if (t3 === '移除本段书签') {
    // 滚到的段落恰好已有书签？磁盘上已空，不该出现——出现即状态错乱
    ok('④ 换段后工具栏应为「收藏本段书签」', false, `title=${t3}`)
  }
  await evalJs(`(() => { document.querySelector('[data-wb="txtBookmark"]')?.click(); return true })()`)
  await sleep(900)
  const bm3 = readBookmarksFromDisk()
  ok('④ ★★ 再加一条后磁盘**恰 1 条**（不是 2 条 —— 2 条即「已删书签被内存旧数组写回」）',
    Array.isArray(bm3) && bm3.length === 1, JSON.stringify(bm3))
  const keptPara = bm3?.[0]?.paraIndex
  ok('④ ★★ 保留下来的**不是**刚删的那条（无复活）', typeof keptPara === 'number' && keptPara !== deletedPara,
    `kept=${keptPara} deleted=${deletedPara}`)

  console.log(failed ? '\n存在失败断言' : '\n全部通过')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error('删除书签探针失败:', e.message); process.exit(2) })
