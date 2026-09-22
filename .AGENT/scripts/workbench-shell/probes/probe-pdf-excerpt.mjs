/**
 * PDF 划选摘录探针（摘录先行批次 · PDF 分支取证，2026-09-20）。
 * 用法（隔离实例，勿与用户 dev 抢单实例锁）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books --ud "knowbase (dev probe-app)"
 *   cd tmp/probe-app && node <仓库根>/.AGENT/scripts/workbench-shell/probes/run-probe.mjs ^
 *     <仓库根>/.AGENT/scripts/workbench-shell/probes/probe-pdf-excerpt.mjs --no-sandbox --disable-gpu
 *
 * 断言链：
 *   1) 书架点 PDF 样书 → 文本层 span 渲染出来（数量 > 30）
 *   2) span 的 computed user-select = text（白名单生效）
 *   3) 真实鼠标拖选一行 → TextSelectionBar 出现（复制 + 摘录按钮）
 *   4) 点「摘录」→ excerpts.json 落 pdf 条目 + 页面出现 .kb-excerpt-hl 高亮块
 */
const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const { readFileSync } = await import('node:fs')
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
// 仓库根由脚本位置推导（勿写死盘符：在 worktree 里跑会静默读主仓 → 假 PASS）
const PROJ = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
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
const consoleMsgs = []
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
    // 渲染层 console 取证（pdf.js 报错走 console，不进 window.__errs）
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type !== 'debug') {
      const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
      if (text) consoleMsgs.push(text.slice(0, 160))
    }
  }
  await send('Runtime.enable')
  for (let i = 0; i < 24; i++) {
    const ready = await evalJs(`!!document.querySelector('[data-wb-bookmark="bookshelf"]')`).catch(() => false)
    if (ready) break
    await sleep(500)
  }
  await sleep(800)
  await evalJs(`(() => {
    window.__errs = []
    window.addEventListener('error', (e) => window.__errs.push(String(e.message || e)))
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)))
    return true
  })()`)

  // 兜底：启动选择器（startupVaultPicker）若仍在，JS 直点当前仓库条目进入
  for (let i = 0; i < 6; i++) {
    const up = await evalJs(`!!document.querySelector('.vault-picker-step')`)
    if (!up) break
    await evalJs(`(() => {
      const row = [...document.querySelectorAll('button, [role=button], .cursor-pointer')].find((x) => (x.textContent || '').includes('探针测试仓库'))
      row?.click(); return true
    })()`)
    await sleep(500)
  }
  // （按钮（下一步/完成/跳过）不在 .onboarding-step 内，按全文可见按钮匹配）
  for (let i = 0; i < 12; i++) {
    const step = await evalJs(`!!document.querySelector('.onboarding-step')`)
    if (!step) break
    await evalJs(`(() => {
      const vis = (b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const b = [...document.querySelectorAll('button')].filter(vis).find((x) => /下一步|完成|跳过/.test(x.textContent || ''))
      b?.click(); return true
    })()`)
    await sleep(400)
  }

  // 实例自证：必须是 build 产物（file:）+ 当前仓库 = 探针 fixture——防止 CDP 连到别的实例
  const ident = await evalJs(`(() => ({
    proto: location.protocol,
    vault: null,
  }))()`)
  const vaultName = await evalJs(`(async () => {
    try { const cur = await window.api.workspaceGetCurrent(); return cur?.name ?? null } catch { return null }
  })()`)
  console.log('[实例自证]', JSON.stringify({ ...ident, vaultName }))
  if (ident.proto !== 'file:' || vaultName !== '探针测试仓库') {
    console.error('CDP 连接的不是隔离探针实例（proto/vault 不符），终止以防误伤')
    process.exit(3)
  }

  // 1) 打开书架 → 点 PDF 样书
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="bookshelf"]')?.click(); return true })()`)
  await sleep(1200)
  const clicked = await evalJs(`(() => {
    const card = [...document.querySelectorAll('main button')].find((b) => (b.getAttribute('title') || '').includes('.pdf'))
    card?.click(); return !!card
  })()`)
  ok('找到并点击 PDF 样书卡片', clicked)

  // 2) 等文本层渲染（pdfjs renderTextLayer；沙箱实例渲染偏慢，窗口放宽到 ~30s）
  //    阈值 >10：文本层只挂紧集合页（设计如此），单页 ≈ 20-24 span
  let spans = 0
  for (let i = 0; i < 60; i++) {
    // 2026-09-21 换官方 pdf.js viewer 后：页盒 = .pdfViewer .page[data-page-number]，文本层 = .textLayer
    spans = await evalJs(`document.querySelectorAll('.pdfViewer .page .textLayer span').length`)
    if (spans > 10) break
    await sleep(500)
  }
  const diag = await evalJs(`(() => ({
    canvases: document.querySelectorAll('.pdfViewer .page canvas').length,
    pages: document.querySelectorAll('.pdfViewer .page').length,
    pageNos: [...document.querySelectorAll('.pdfViewer .page')].slice(0, 6).map((e) => e.dataset.pageNumber),
    frames: document.querySelectorAll('.pdfViewer .page .textLayer').length,
    frameSpans: document.querySelectorAll('.pdfViewer .page .textLayer span').length,
    toolbar: (document.querySelector('.kb-fit-pdfread')?.textContent || '').slice(0, 100),
    failText: (document.body.textContent.match(/打开失败|加载失败|正在准备/g) || []).slice(0, 3),
    errs: (window.__errs ?? []).slice(0, 6),
  }))()`)
  console.log('[渲染诊断]', JSON.stringify(diag))
  console.log('[console 取证]', JSON.stringify(consoleMsgs.slice(-10)))
  // 渲染池内部状态三次采样（看 tight/rendered/inflight 动向与是否在无限重渲染）
  for (let k = 0; k < 3; k++) {
    const st = await evalJs(`window.__kbPdf?.state ?? null`)
    console.log('[池状态' + k + ']', JSON.stringify(st))
    await sleep(700)
  }
  ok('文本层 span 渲染（>10）', spans > 10, `spans=${spans}`)
  assertFailed()

  // 3) user-select 白名单取证
  const sel = await evalJs(`(() => {
    const sp = [...document.querySelectorAll('.pdfViewer .page .textLayer span')].find((x) => (x.textContent || '').length > 8)
    if (!sp) return { noSpan: true }
    const cs = getComputedStyle(sp)
    const r = sp.getBoundingClientRect()
    return { userSelect: cs.userSelect, ws: getComputedStyle(sp).webkitUserSelect, text: sp.textContent.slice(0, 40), rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
  })()`)
  console.log('[取证]', JSON.stringify(sel))
  ok('span user-select = text', sel.userSelect === 'text' || sel.ws === 'text', JSON.stringify(sel.userSelect))
  assertFailed()

  // 4) 真实鼠标拖选一行（先把目标 span 滚进视口——否则 CDP 坐标落在视口外、拖不中任何字）
  const dragRect = await evalJs(`(() => {
    const sp = [...document.querySelectorAll('.pdfViewer .page .textLayer span')].find((x) => (x.textContent || '').length > 8)
    if (!sp) return null
    sp.scrollIntoView({ block: 'center' })
    const r = sp.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), inView: r.top > 0 && r.bottom < window.innerHeight }
  })()`)
  await sleep(500)
  if (!dragRect || !dragRect.inView) { console.error('拖选目标不在视口内:', JSON.stringify(dragRect)); process.exit(1) }
  const drag = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
  const x0 = dragRect.x + 2
  const x1 = dragRect.x + Math.max(40, dragRect.w - 4)
  const y = dragRect.y + dragRect.h / 2
  await drag('mousePressed', x0, y)
  for (let i = 1; i <= 8; i++) {
    await drag('mouseMoved', Math.round(x0 + (x1 - x0) * i / 8), y)
    await sleep(30)
  }
  await drag('mouseReleased', x1, y)
  await sleep(500)
  const hit = await evalJs(`(() => {
    const el = document.elementFromPoint(${x0}, ${y})
    const chain = []
    let cur = el
    while (cur && cur !== document.body && chain.length < 8) {
      const wb = cur.getAttribute?.('data-wb') || cur.getAttribute?.('data-wb-bookmark') || cur.id || ''
      chain.push(cur.tagName.toLowerCase() + (wb ? '[' + wb + ']' : '') + '.' + String(cur.className).slice(0, 40))
      cur = cur.parentElement
    }
    const r = el?.getBoundingClientRect()
    return { at0: el?.tagName + '.' + String(el.className).slice(0, 60), text: (el?.textContent || '').slice(0, 40), rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null, chain, innerH: window.innerHeight, innerW: window.innerWidth }
  })()`)
  console.log('[命中点]', JSON.stringify(hit), 'drag@', x0, y, '→', x1, y)
  const bar = await evalJs(`(() => {
    const copy = [...document.querySelectorAll('button')].some((b) => (b.getAttribute('title') || '') === '复制选中文本')
    const excerpt = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('存为摘录'))
    const selText = window.getSelection()?.toString().slice(0, 60) ?? ''
    const globalFloat = !!document.querySelector('[data-sel-float]')
    return { copy, hasExcerpt: !!excerpt, selText, globalFloat }
  })()`)
  console.log('[拖选后]', JSON.stringify(bar))
  ok('真实拖选后出现 TextSelectionBar（复制按钮）', bar.copy)
  ok('浮条含「摘录」按钮', bar.hasExcerpt)
  ok('全局「问 AI」浮钮已在阅读域让位（唯一菜单）', !bar.globalFloat)
  assertFailed()

  // 5) 点「摘录」→ 落盘 + 高亮
  await evalJs(`(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('存为摘录'))?.click(); return true })()`)
  await sleep(900)
  let pdfEntries = []
  try {
    const store = JSON.parse(readFileSync(join(PROJ, 'tmp', 'vault-fixture', '.knowbase', 'modules', 'excerpts.json'), 'utf8'))
    for (const book of Object.values(store.books ?? {})) {
      pdfEntries.push(...Object.values(book).filter((e) => e.kind === 'pdf'))
    }
  } catch { /* 未落盘 */ }
  ok('excerpts.json 落 pdf 条目', pdfEntries.length > 0, JSON.stringify(pdfEntries).slice(0, 160))
  const hl = await evalJs(`(() => {
    const overlays = document.querySelectorAll('.kb-excerpt-hl').length
    const text = window.getSelection()?.toString() ?? ''
    return { overlays, selText: text.slice(0, 40) }
  })()`)
  console.log('[摘录后]', JSON.stringify(hl))
  ok('页面出现 .kb-excerpt-hl 高亮块', hl.overlays > 0, `overlays=${hl.overlays}`)
  // 多色高亮：高亮块带 data-ehc（色板单源落地；点「摘录」缺省回落首色 y）
  const ehc = await evalJs(`(() => {
    const all = document.querySelectorAll('.kb-excerpt-hl').length
    const withEhc = document.querySelectorAll('.kb-excerpt-hl[data-ehc]').length
    const y = document.querySelectorAll('.kb-excerpt-hl[data-ehc="y"]').length
    return { all, withEhc, y }
  })()`)
  ok('PDF 高亮块带 data-ehc（多色落地）', ehc.withEhc > 0, JSON.stringify(ehc))
  const errs = await evalJs(`window.__errs ?? []`)
  if (errs.length) console.log('[window errors]', JSON.stringify(errs.slice(0, 5)))

  // ===== 5) 缩放快捷操作：Ctrl+滚轮 / Ctrl+= → pdfZoom 百分比变化 =====
  // wheel 取证：renderer 是否收到 wheel、ctrlKey 是否带到位
  await evalJs(`(() => {
    window.__wl = []
    window.addEventListener('wheel', (e) => { window.__wl.push({ c: e.ctrlKey, dy: e.deltaY, defaultPrevented: e.defaultPrevented }) }, { capture: true, passive: true })
    return true
  })()`)
  const zoomBefore = await evalJs(`document.querySelector('[data-wb="pdfZoom"]')?.textContent ?? null`)
  // Ctrl+滚轮：reader 中心向上滚（modifiers bit2 = Ctrl）
  const wheelAt = await evalJs(`(() => {
    const root = document.querySelector('[data-sel-float-ignore]')
    const r = root?.getBoundingClientRect()
    if (!r) return null
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (wheelAt) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheelAt.x, y: wheelAt.y, deltaX: 0, deltaY: -240, modifiers: 2 })
    await sleep(700)
  }
  const zoomAfterWheel = await evalJs(`document.querySelector('[data-wb="pdfZoom"]')?.textContent ?? null`)
  const wl = await evalJs(`window.__wl ?? []`)
  console.log('[wheel 取证]', JSON.stringify(wl))
  ok('Ctrl+滚轮 → PDF 页面缩放变化', !!zoomBefore && !!zoomAfterWheel && zoomBefore !== zoomAfterWheel, `before=${zoomBefore} after=${zoomAfterWheel}`)
  // Ctrl+=：键盘路径（modifiers bit2 = Ctrl；key '='）
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: '=', windowsVirtualKeyCode: 187, code: 'Equal' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: '=', windowsVirtualKeyCode: 187, code: 'Equal' })
  await sleep(700)
  const zoomAfterKey = await evalJs(`document.querySelector('[data-wb="pdfZoom"]')?.textContent ?? null`)
  ok('Ctrl+= → PDF 页面缩放变化（界面缩放已仲裁让位）', !!zoomAfterKey && zoomAfterKey !== zoomAfterWheel, `before=${zoomAfterWheel} after=${zoomAfterKey}`)

  console.log(failed ? '\n存在失败断言' : '\n全部通过')
  process.exit(failed ? 1 : 0)
}
function assertFailed() { if (failed) { console.error('断言链中断'); process.exit(1) } }
main().catch((e) => { console.error('PDF 摘录探针失败:', e.message); process.exit(2) })
