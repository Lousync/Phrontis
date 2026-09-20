/**
 * 阅读侧栏端到端探针（书架升级全格式阅读器一期，方案 §S8）。
 * 用法（先 seed 再跑）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs .AGENT/scripts/workbench-shell/probes/probe-reading-panel.mjs --no-sandbox --disable-gpu
 *
 * 断言链（任一失败 exit 1）：
 *   1) 点左栏「书架」书签 → 书架打开，[data-wb="readingPanel"] 不存在（无书在读无阅读 Tab）
 *   2) 点第一本书卡片 → [data-wb="txtReader"] 存在 → 右栏出现 [data-wb-rp-tab="reading"]
 *   3) 点阅读 Tab → [data-wb="readingPanel"] 可见，右栏已展开（宽度 > 0）
 *   4) 关书架标签（页面条 ✕）→ [data-wb-rp-tab="reading"] 从 DOM 消失，激活 Tab 回落 widgets/ai
 *   5) 重开书架、打开书、真实滚动到约 50% → 主进程侧读 readerState.json 断言 pct ∈ [40, 60]
 */
const DEBUG_PORT = 9222
const { readFileSync } = await import('node:fs')
const { join } = await import('node:path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page && page.webSocketDebuggerUrl) return page
    } catch { /* 等 electron */ }
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
const assertNotFailed = () => { if (failed) { console.error('断言链中断'); process.exit(1) } }

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id) }
  }
  // 等外壳就绪（左栏书签可点）
  for (let i = 0; i < 24; i++) {
    const ready = await evalJs(`!!document.querySelector('[data-wb-bookmark="bookshelf"]')`).catch(() => false)
    if (ready) break
    await sleep(500)
  }
  await sleep(800)
  // 全局错误捕获（渲染异常不会进 stdout，挂 window 监听取证）
  await evalJs(`(() => {
    window.__errs = []
    window.addEventListener('error', (e) => window.__errs.push(String(e.message || e)))
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)))
    return true
  })()`)

  // ===== 1) 打开书架 → readingPanel 不存在 =====
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="bookshelf"]')?.click(); return true })()`)
  await sleep(1200)
  const step1 = await evalJs(`(() => ({
    tab: !!document.querySelector('[data-wb="tab"][data-wb-tab="bookshelf"]'),
    panel: !!document.querySelector('[data-wb="readingPanel"]'),
    readingTab: !!document.querySelector('[data-wb-rp-tab="reading"]'),
  }))()`)
  ok('书架标签已打开', step1.tab)
  ok('未读书时 readingPanel 不存在', !step1.panel)
  ok('未读书时右栏无阅读 Tab', !step1.readingTab)
  assertNotFailed()

  // ===== 2) 点第一本书 → txtReader 出现 + 阅读 Tab 出现 =====
  // 封面网格的卡片 = 书架主区 button（title = relPath，含 .txt）
  const clicked = await evalJs(`(() => {
    const main = document.querySelector('[data-wb="txtReader"]') ? null : [...document.querySelectorAll('main button')].find((b) => (b.getAttribute('title') || '').includes('.txt'))
    main?.click(); return !!main
  })()`)
  ok('找到并点击 TXT 书卡片', clicked)
  let txtReader = false
  for (let i = 0; i < 20; i++) {
    txtReader = await evalJs(`!!document.querySelector('[data-wb="txtReader"]')`)
    if (txtReader) break
    await sleep(300)
  }
  ok('[data-wb="txtReader"] 出现（TXT 阅读器挂载）', txtReader)
  await sleep(600)
  const readingTabOn = await evalJs(`(() => {
    const rp = document.querySelector('[data-wb="rightPanel"]')
    const tabs = [...document.querySelectorAll('[data-wb-rp-tab]')].map((b) => b.getAttribute('data-wb-rp-tab'))
    return {
      on: tabs.includes('reading'),
      tabs,
      rpExists: !!rp,
      rpParentHtml: rp?.parentElement?.innerHTML?.slice(0, 160) ?? '(no parent)',
      bodyHasErr: /出错了|渲染出错|ErrorBoundary/i.test(document.body.textContent.slice(0, 5000)),
      errs: (window.__errs ?? []).slice(0, 6),
    }
  })()`)
  console.log('[step2 诊断]', JSON.stringify(readingTabOn))
  ok('有书在读 → 右栏出现阅读 Tab', readingTabOn.on === true)
  assertNotFailed()

  // ===== 3) 点阅读 Tab → readingPanel 可见 + 右栏已展开 =====
  await evalJs(`(() => { document.querySelector('[data-wb-rp-tab="reading"]')?.click(); return true })()`)
  await sleep(700)
  const step3 = await evalJs(`(() => {
    const p = document.querySelector('[data-wb="readingPanel"]')
    if (!p) return { panel: false }
    const r = p.getBoundingClientRect()
    const card = document.querySelector('[data-wb="rightPanel"]')?.getBoundingClientRect()
    return { panel: true, visible: r.width > 0 && r.height > 0, rightWidth: Math.round(card?.width ?? 0) }
  })()`)
  ok('[data-wb="readingPanel"] 存在且可见', step3.panel && step3.visible, JSON.stringify(step3))
  ok('右栏已被强制展开（宽度 > 0）', (step3.rightWidth ?? 0) > 0, `width=${step3.rightWidth}`)
  assertNotFailed()

  // ===== 4) 关书架标签 → 阅读 Tab 消失 + 回落 widgets/ai =====
  await evalJs(`(() => { document.querySelector('[data-wb="tab"][data-wb-tab="bookshelf"] button[title="关闭标签页"]')?.click(); return true })()`)
  await sleep(900)
  const step4 = await evalJs(`(() => ({
    readingTab: !!document.querySelector('[data-wb-rp-tab="reading"]'),
    panel: !!document.querySelector('[data-wb="readingPanel"]'),
    active: document.querySelector('[data-wb-rp-active="1"]')?.getAttribute('data-wb-rp-tab') ?? null,
  }))()`)
  ok('关书架标签 → 阅读 Tab 从 DOM 消失', !step4.readingTab)
  ok('readingPanel 一并消失', !step4.panel)
  ok('右栏激活 Tab 回落 widgets/ai', step4.active === 'widgets' || step4.active === 'ai', `active=${step4.active}`)
  assertNotFailed()

  // ===== 5) 真实滚动到 ~50% → readerState.json pct ∈ [40, 60] =====
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="bookshelf"]')?.click(); return true })()`)
  await sleep(1000)
  await evalJs(`(() => {
    const main = [...document.querySelectorAll('main button')].find((b) => (b.getAttribute('title') || '').includes('.txt'))
    main?.click(); return true
  })()`)
  for (let i = 0; i < 20; i++) {
    if (await evalJs(`!!document.querySelector('[data-wb="txtReader"]')`)) break
    await sleep(300)
  }
  await sleep(600)
  // 诊断：重开链路状态（若 txtReader/书卡片缺失，是环境时序而非滚动问题）
  const reopen = await evalJs(`(() => ({
    reader: !!document.querySelector('[data-wb="txtReader"]'),
    scrollBox: !!document.querySelector('[data-wb="txtReader"] .overflow-y-auto'),
    bookBtns: [...document.querySelectorAll('main button')].filter((b) => (b.getAttribute('title') || '').includes('.txt')).length,
    head: (() => { const h = document.querySelector('[data-wb="txtReader"]'); return { len: h?.innerHTML.length ?? 0, text: (h?.textContent ?? '').slice(0, 200) } })(),
  }))()`)
  console.log('[step5 重开诊断]', JSON.stringify(reopen))
  // 真实滚动：合成 dispatchEvent 不触发 React onScroll（实测 pctText 恒 0%）——
  // 用 CDP Input.dispatchMouseEvent 的 mouseWheel（真实输入事件链），分多次滚动到约一半
  const box = await evalJs(`(() => {
    const sc = document.querySelector('[data-wb="txtReader"] .overflow-y-auto')
    if (!sc) return null
    const r = sc.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), max: sc.scrollHeight - sc.clientHeight }
  })()`)
  if (!box || box.max <= 0) { console.error('滚动容器不可用:', JSON.stringify(box)); process.exit(1) }
  const wheel = (dy) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: dy })
  const total = Math.round(box.max * 0.5)
  for (let done = 0; done < total; done += 240) {
    await wheel(Math.min(240, total - done))
    await sleep(40)
  }
  // 防抖 400ms + 写盘，等 1.6s 再读文件
  await sleep(1600)
  const pctText = await evalJs(`document.querySelector('[data-wb="txtPct"]')?.textContent ?? null`)
  console.log('[step5 诊断] UI pct =', pctText)
  const fixture = join(process.cwd(), 'tmp', 'vault-fixture')
  let pct = null
  try {
    const store = JSON.parse(readFileSync(join(fixture, '.knowbase', 'modules', 'readerState.json'), 'utf8'))
    const keys = Object.keys(store.books ?? {}).filter((k) => k.endsWith('/.books/探针样书.txt'))
    if (keys.length > 0) pct = store.books[keys[0]].pct
  } catch { /* 文件未落 → pct=null */ }
  ok('滚动 50% → readerState.json pct ∈ [40, 60]', pct !== null && pct >= 40 && pct <= 60, `pct=${pct}`)

  // ===== 6) TXT 划选摘录：程序化选区 → mouseup → 浮条「摘录」→ 落盘 + 高亮 + 右栏列表 =====
  // （原生 document mouseup 监听可被 dispatchEvent 触发——React 合成 onScroll 不行，见上一步教训）
  const selOk = await evalJs(`(() => {
    const p = document.querySelector('[data-wb="txtReader"] p[data-p="3"]')
    if (!p || !p.firstChild) return false
    const range = document.createRange()
    const tn = p.firstChild
    range.setStart(tn, 4)
    range.setEnd(tn, Math.min(40, tn.data.length))
    const s = window.getSelection()
    s.removeAllRanges()
    s.addRange(range)
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return true
  })()`)
  ok('程序化选区 + mouseup 派发', selOk)
  await sleep(300)
  const barOn = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('存为摘录'))
    if (!btn) return false
    btn.click()
    return true
  })()`)
  ok('划选浮条出现并点击「摘录」', barOn)
  await sleep(900)
  const exStore = (() => {
    try {
      const store = JSON.parse(readFileSync(join(fixture, '.knowbase', 'modules', 'excerpts.json'), 'utf8'))
      const keys = Object.keys(store.books ?? {}).filter((k) => k.endsWith('/.books/探针样书.txt'))
      return keys.length > 0 ? Object.values(store.books[keys[0]]) : []
    } catch { return [] }
  })()
  ok('excerpts.json 落盘（该书 ≥1 条 txt 摘录）', exStore.length > 0, JSON.stringify(exStore).slice(0, 160))
  const hlOn = await evalJs(`(() => {
    // excerpt 广播回流 → TxtReaderView 高亮 mark 渲染
    const marks = document.querySelectorAll('[data-wb="txtReader"] mark[data-eid]')
    return marks.length > 0
  })()`)
  ok('正文出现 <mark> 高亮', hlOn)
  const panelOn = await evalJs(`(() => {
    // 右栏摘录列表出现摘文（ReadingSidePanel 经 useDataChanged('excerpt') 刷新）
    const panel = document.querySelector('[data-wb="readingPanel"]')
    return !!panel && panel.textContent.includes('摘录') && panel.textContent.includes('段')
  })()`)
  ok('右栏摘录列表出现条目', panelOn)

  console.log(failed ? '\n存在失败断言' : '\n全部通过')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error('阅读侧栏探针失败:', e.message); process.exit(2) })
