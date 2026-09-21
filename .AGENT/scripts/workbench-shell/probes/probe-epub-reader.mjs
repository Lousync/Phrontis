/**
 * EPUB 阅读器端到端探针（B 段 · 二期六格式引擎，方案 §1.7）。
 * 用法（先 seed 再跑）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs .AGENT/scripts/workbench-shell/probes/probe-epub-reader.mjs --no-sandbox --disable-gpu
 *
 * 断言链（任一失败 exit 1）：
 *   1) 点 EPUB 书卡片 → [data-wb="epubReader"] 挂载，data-wb-state 落到 ready（引擎解析 + 分页成功）
 *   2) 内容帧真在渲染：同源 blob: 帧可读 → 正文文本在、书内外部 CSS 生效（h1 = 红）、书内图片已解码
 *   3) ★ 实机不变量：内容帧 sandbox 恰为 'allow-same-origin'（契约脚本只查源码文本，这里查运行时真实属性）
 *   4) 左栏按引擎分发：epubRailPanel 在位、pdfRailPanel 不在位；目录树三章齐（KB_EPUB_STATE_REQ 往返）
 *   5) 点目录「第三章」→ toolbar 章节标签变（KB_EPUB_GOTO_CFI 的 href 目标可用）
 *   6) 进度落盘：readerState.json 该书 pct > 0 **且** locator 是 epubcfi(...) 串（双轨都写了）
 *   7) 划选 → 浮条 → 摘录：excerpts.json 落 kind='epub' + cfi + chapter；正文帧出现 Overlayer 高亮
 *   8) 返回书架 → 重开 → 位置从 CFI 恢复（回到第三章那一页，不是回首页）
 *   9) ★ 恶意书负向：渲染成功不崩 + 宿主 window 未被污染 + document.title 未被改；
 *      并且载荷**仍在 DOM 里**（证明防线是 CSP + sandbox，而不是「上游净化掉了」）
 *
 * 为什么用 window.frames 而不是 DOM 查询：foliate 用 `attachShadow({mode:'closed'})`
 * （view.js:203 / paginator.js:422），外部拿不到 shadowRoot；但内容帧是**同源 blob:** 的同级
 * 浏览上下文，`window.frames[i].document` 依然可读 —— 这正是铁律 10 电子书例外的直接证据。
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
const note = (name, extra = '') => console.log(`  --   ${name}  [${extra}]`)
const assertNotFailed = () => { if (failed) { console.error('断言链中断'); process.exit(1) } }

/** foliate 内容帧访问器（宿主主世界；只返回可序列化的原始值） */
const INSTALL_HELPERS = `(() => {
  const alldocs = () => {
    const out = []
    for (const f of Array.from(window.frames)) {
      try { if (f.document && f.document.body) out.push(f.document) } catch (e) { /* 跨源帧不该出现 */ }
    }
    return out
  }
  const visible = () => alldocs().filter((d) => {
    try { return d.defaultView.frameElement.style.display !== 'none' } catch (e) { return true }
  })
  window.__kbProbe = {
    frames: () => alldocs().length,
    sandbox: () => { const d = alldocs()[0]; try { return d.defaultView.frameElement.getAttribute('sandbox') } catch (e) { return 'ERR:' + String(e) } },
    texts: () => visible().map((d) => (d.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 80)),
    /** 当前页（可见帧）里第一个可划选的段落文本 —— 选区/摘录断言用它，别依赖「第 N 段」在哪一页 */
    firstP: () => { const d = visible()[0]; if (!d) return null; const p = [...d.querySelectorAll('p')].find((x) => (x.textContent || '').trim().length >= 24); return p ? (p.textContent || '').slice(0, 24) : null },
    h1: () => { const d = visible()[0]; if (!d) return null; const h = d.querySelector('h1'); return h ? d.defaultView.getComputedStyle(h).color : null },
    img: () => { const d = visible()[0]; if (!d) return null; const i = d.querySelector('img'); return i ? { w: i.naturalWidth, src: String(i.currentSrc || i.src).slice(0, 6) } : null },
    marks: () => { const d = visible()[0]; if (!d) return []; return [...d.querySelectorAll('svg g[fill]')].map((g) => g.getAttribute('fill')) },
    payload: () => { const d = visible()[0]; if (!d) return null; const w = d.defaultView; return { inline: w.__kbProbePwnedInline ?? null, onerror: w.__kbProbePwnedOnerror ?? null, ext: w.__kbProbePwnedExt ?? null, hasScript: d.querySelectorAll('script').length, hasOnerror: !!d.querySelector('img[onerror]') } },
    pick: (needle) => visible().some((d) => (d.body.textContent || '').includes(needle)),
  }
  return { frames: alldocs().length, visible: visible().length }
})()`

const FIXTURE = join(process.cwd(), 'tmp', 'vault-fixture')
const readStore = (file) => {
  try { return JSON.parse(readFileSync(join(FIXTURE, '.knowbase', 'modules', file), 'utf8')) } catch { return null }
}
/** readerState.json 里某本书的状态（键以 `/.books/<name>` 结尾） */
const stateOf = (name) => {
  const s = readStore('readerState.json')
  const keys = Object.keys(s?.books ?? {}).filter((k) => k.endsWith(`/.books/${name}`))
  return keys.length ? s.books[keys[0]] : null
}
/** excerpts.json 里某本书的摘录数组 */
const excerptsOf = (name) => {
  const s = readStore('excerpts.json')
  const keys = Object.keys(s?.books ?? {}).filter((k) => k.endsWith(`/.books/${name}`))
  return keys.length ? Object.values(s.books[keys[0]]) : []
}

const BOOK = '探针样书.epub'
const EVIL = '恶意样书.epub'

/** 等 [data-wb=X] 的某个属性到达期望值 */
async function waitAttr(sel, attr, want, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(`document.querySelector('${sel}')?.getAttribute('${attr}') ?? null`)
    if (v === want) return true
    await sleep(250)
  }
  return false
}

/** 打开书架标签（幂等：已在书架则只等它就绪） */
async function openBookshelf() {
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="bookshelf"]')?.click(); return true })()`)
  await sleep(1000)
}

/** 点书架里某个书名卡片（title = relPath） */
async function openBook(name) {
  const clicked = await evalJs(`(() => {
    const re = new RegExp(${JSON.stringify(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))} + '$')
    const b = [...document.querySelectorAll('main button[title]')].find((x) => re.test(x.getAttribute('title') || ''))
    if (!b) return 'no-card'
    b.scrollIntoView({ block: 'center' })
    b.click()
    return 'ok'
  })()`)
  ok(`找到并点击「${name}」卡片`, clicked === 'ok', String(clicked))
  if (clicked !== 'ok') {
    const diag = await evalJs(`[...document.querySelectorAll('main button[title]')].map((b) => b.getAttribute('title')).slice(0, 20)`)
    console.error('书架卡片清单:', JSON.stringify(diag))
    return false
  }
  return waitAttr('[data-wb="epubReader"]', 'data-wb-state', 'ready')
}

async function backToShelf() {
  const b = await evalJs(`(() => {
    const x = document.querySelector('[data-wb="epubBack"]')
    if (!x) return 'no-back'
    x.click(); return 'ok'
  })()`)
  await sleep(900)
  return b === 'ok'
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
  // 宿主基线：恶意书断言要对比「开书前」的取值
  const hostBefore = await evalJs(`({ title: document.title, pwned: { inline: window.__kbProbePwnedInline ?? null, parent: window.__kbProbePwnedParent ?? null, onerror: window.__kbProbePwnedOnerror ?? null, parentOnerror: window.__kbProbePwnedParentOnerror ?? null, ext: window.__kbProbePwnedExt ?? null, parentExt: window.__kbProbePwnedParentExt ?? null } })`)
  console.log('[宿主基线]', JSON.stringify(hostBefore))

  // ===== 1) 打开 EPUB → 阅读器 ready =====
  await openBookshelf()
  const ready = await openBook(BOOK)
  ok('打开 EPUB → epubReader 挂载且 state=ready（引擎解析 + 分页成功）', ready)
  assertNotFailed()
  await sleep(1200)

  // ===== 2) 内容帧真在渲染（同源 blob: 可读 + 子资源 data: 通道 + 分页） =====
  const help = await evalJs(INSTALL_HELPERS)
  console.log('[帧清单]', JSON.stringify(help))
  ok('内容帧存在（window.frames 可见同源 blob: 帧）', (help?.frames ?? 0) > 0, JSON.stringify(help))
  const render = await evalJs(`(() => ({
    texts: window.__kbProbe.texts(),
    h1: window.__kbProbe.h1(),
    img: window.__kbProbe.img(),
    pct: document.querySelector('[data-wb="epubPct"]')?.textContent ?? null,
    rail: !!document.querySelector('[data-wb="epubRailPanel"]'),
    para: window.__kbProbe.pick('这一段用于验证'),
  }))()`)
  console.log('[渲染诊断]', JSON.stringify(render))
  ok('正文文本进入内容帧（解析 + 排版）', (render.texts ?? []).join(' ').length > 0, JSON.stringify(render.texts))
  ok('书首段落已渲染（分页第 1 页）', render.para === true, String(render.para))
  ok('书内外部 CSS 生效（h1 呈红色 rgb(192, 0, 0)）', render.h1 === 'rgb(192, 0, 0)', String(render.h1))
  ok('书内图片已解码（子资源 data: 通道通畅）', (render.img?.w ?? 0) > 0, JSON.stringify(render.img))
  assertNotFailed()

  // ===== 3) ★ 运行时安全不变量：sandbox 恰为 allow-same-origin =====
  const sandbox = await evalJs(`window.__kbProbe.sandbox()`)
  ok('★★ 内容帧 sandbox = allow-same-origin（不含 allow-scripts）', sandbox === 'allow-same-origin', String(sandbox))

  // ===== 4) 左栏按引擎分发 + 目录树 =====
  const rail = await evalJs(`(() => {
    const p = document.querySelector('[data-wb="epubRailPanel"]')
    return {
      epubRail: !!p, state: p?.getAttribute('data-wb-state') ?? null,
      pdfRail: !!document.querySelector('[data-wb="pdfRailPanel"]'),
      list: !!document.querySelector('[data-wb="bookshelfSideList"]'),
      labels: p ? [...p.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter((t) => t && t !== '目录' && t !== '缩略图' && t !== '书签') : [],
    }
  })()`)
  console.log('[左栏诊断]', JSON.stringify(rail))
  ok('EPUB 在读 → 左栏挂 epubRailPanel 且 ready', rail.epubRail && rail.state === 'ready', JSON.stringify(rail))
  ok('EPUB 在读 → 左栏不挂 PDF 三件套 / 不挂书目列表', !rail.pdfRail && !rail.list)
  ok('目录树三章齐（KB_EPUB_STATE_REQ 往返成功）',
    ['第一章', '第二章', '第三章'].every((t) => rail.labels.some((l) => l.includes(t))), JSON.stringify(rail.labels))

  // ===== 5) 划选 → 摘录（在书首页做：此时正文停在第一章第 1 页） =====
  const selRes = await evalJs(`(() => {
    const d = (() => {
      for (const f of Array.from(window.frames)) {
        try { if (f.document && /这一段用于验证/.test(f.document.body.textContent || '')) return f.document } catch (e) {}
      }
      return null
    })()
    if (!d) return 'no-frame'
    const p = [...d.querySelectorAll('p')].find((x) => (x.textContent || '').trim().length >= 24)
    if (!p || !p.firstChild) return 'no-p'
    const tn = p.firstChild
    const r = d.createRange()
    r.setStart(tn, 0)
    r.setEnd(tn, Math.min(24, tn.data.length))
    const s = d.getSelection()
    s.removeAllRanges(); s.addRange(r)
    p.dispatchEvent(new d.defaultView.MouseEvent('mouseup', { bubbles: true }))
    return 'ok:' + s.toString().slice(0, 16)
  })()`)
  ok('内容帧内程序化划选 + mouseup 派发', String(selRes).startsWith('ok:'), String(selRes))
  await sleep(500)
  const barRect = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('title') || '').startsWith('存为摘录'))
    if (!b) return null
    const bar = b.closest('div')
    const r = (bar ?? b).getBoundingClientRect()
    const host = document.querySelector('[data-wb="epubReader"]')?.getBoundingClientRect()
    return { left: Math.round(r.left), top: Math.round(r.top), inHost: !!host && r.top >= host.top - 4 && r.bottom <= host.bottom + 60 }
  })()`)
  ok('划选浮条出现（getCFI 成功 → capture 态）', !!barRect?.left || barRect?.left === 0, JSON.stringify(barRect))
  // 浮条定位依赖 frameElement 偏移（同源才拿得到）→ 落在阅读器区域内即为证据
  ok('浮条落在阅读器区域内（frameElement 偏移可用 = 同源）', barRect?.inHost === true, JSON.stringify(barRect))
  const clickedEx = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('title') || '').startsWith('存为摘录'))
    if (!b) return false
    b.click(); return true
  })()`)
  ok('点击「存为摘录」', clickedEx === true)
  await sleep(1200)
  const exList = excerptsOf(BOOK)
  const epubEx = exList.find((e) => e.kind === 'epub')
  console.log('[摘录诊断]', JSON.stringify(exList).slice(0, 300))
  ok('excerpts.json 落盘 kind=epub 摘录', !!epubEx)
  ok('摘录带 CFI（跳回原文的依据）', !!epubEx?.cfi && String(epubEx.cfi).startsWith('epubcfi('), String(epubEx?.cfi))
  ok('摘录带 chapter（导出分组用）', !!epubEx?.chapter && epubEx.chapter.includes('第一章'), String(epubEx?.chapter))
  let marks = []
  for (let i = 0; i < 12; i++) {
    marks = (await evalJs(`window.__kbProbe.marks()`)) ?? []
    if (marks.length > 0) break
    await sleep(300)
  }
  ok('正文出现 Overlayer 高亮（draw-annotation → 高亮真的画上了）', marks.includes('#efb84c'), JSON.stringify(marks))

  // ===== 6) 目录跳转：点「第三章」 =====
  const tocClick = await evalJs(`(() => {
    const p = document.querySelector('[data-wb="epubRailPanel"]')
    if (!p) return 'no-panel'
    const b = [...p.querySelectorAll('button')].find((x) => /第三章/.test(x.textContent || ''))
    if (!b) return 'no-item'
    b.click(); return 'ok'
  })()`)
  ok('左栏目录点到「第三章」', tocClick === 'ok', String(tocClick))
  let chap = null
  for (let i = 0; i < 16; i++) {
    chap = await evalJs(`document.querySelector('[data-wb="epubChapter"]')?.textContent ?? null`)
    if (chap && chap.includes('第三章')) break
    await sleep(300)
  }
  ok('目录跳转生效（toolbar 章节标签变成第三章）', !!chap && chap.includes('第三章'), String(chap))
  const ch3 = await evalJs(`window.__kbProbe.pick('第三') /* 内容帧里 h1 文本 */`)
  ok('内容帧已换到第三章那一页', ch3 === true, String(ch3))
  assertNotFailed()

  // ===== 7) 进度落盘（pct + CFI 双轨） =====
  await sleep(1800)
  const st1 = stateOf(BOOK)
  console.log('[readerState 诊断]', JSON.stringify(st1))
  ok('readerState.json 有该书状态', !!st1)
  ok('进度已落盘且 > 0（翻到第三章）', (st1?.pct ?? 0) > 0, `pct=${st1?.pct}`)
  ok('locator 为 EPUB CFI 串（精确位置，不只是百分比）',
    typeof st1?.locator === 'string' && st1.locator.startsWith('epubcfi('), String(st1?.locator))

  // ===== 8) 返回书架 → 重开 → 从 CFI 恢复 =====
  ok('点「返回书架」退出 EPUB 阅读', await backToShelf())
  const railBack = await evalJs(`(() => ({
    reader: !!document.querySelector('[data-wb="epubReader"]'),
    list: !!document.querySelector('[data-wb="bookshelfSideList"]'),
  }))()`)
  ok('退出后 epubReader 卸载、左栏回到书目列表', !railBack.reader && railBack.list, JSON.stringify(railBack))
  const pctBefore = st1?.pct ?? 0
  const reopened = await openBook(BOOK)
  ok('重开该书 → 回到 ready', reopened)
  await sleep(1500)
  await evalJs(INSTALL_HELPERS)
  const restored = await evalJs(`(() => ({
    pct: document.querySelector('[data-wb="epubPct"]')?.textContent ?? null,
    chapter: document.querySelector('[data-wb="epubChapter"]')?.textContent ?? null,
    texts: window.__kbProbe.texts(),
  }))()`)
  console.log('[恢复诊断]', JSON.stringify(restored), '落盘 pct =', pctBefore)
  const uiPct = parseInt(String(restored.pct).replace('%', ''), 10)
  ok('重开后进度回到落盘值附近（CFI 恢复生效）', Number.isFinite(uiPct) && Math.abs(uiPct - pctBefore) <= 5, `ui=${restored.pct} disk=${pctBefore}`)
  ok('重开后停在第三章（不是回首页）', typeof restored.chapter === 'string' && restored.chapter.includes('第三章'), String(restored.chapter))

  // ===== 9) ★ 恶意书负向 =====
  ok('点「返回书架」准备开恶意书', await backToShelf())
  const evilReady = await openBook(EVIL)
  ok('恶意书能正常渲染（不崩、不白屏）', evilReady)
  await sleep(1200)
  await evalJs(INSTALL_HELPERS)
  const evilRender = await evalJs(`({ frames: window.__kbProbe.frames(), texts: window.__kbProbe.texts(), pct: document.querySelector('[data-wb="epubPct"]')?.textContent ?? null })`)
  console.log('[恶意书渲染]', JSON.stringify(evilRender))
  ok('恶意书正文已渲染', (evilRender.texts ?? []).length > 0, JSON.stringify(evilRender.texts))
  // 跳到第二章（内联 <script> 那页）——载荷必须「DOM 里在、执行没发生」
  const evilToc = await evalJs(`(() => {
    const p = document.querySelector('[data-wb="epubRailPanel"]')
    const b = p ? [...p.querySelectorAll('button')].find((x) => /第二章/.test(x.textContent || '')) : null
    if (!b) return 'no-item'
    b.click(); return 'ok'
  })()`)
  ok('恶意书目录可跳到第二章', evilToc === 'ok', String(evilToc))
  await sleep(1600)
  const payload = await evalJs(`window.__kbProbe.payload()`)
  console.log('[载荷诊断]', JSON.stringify(payload))
  ok('载荷存活在 DOM 里（innerHTML 未被净化 —— 证明防线是 CSP+sandbox）',
    (payload?.hasScript ?? 0) > 0, JSON.stringify(payload))
  ok('★ 内容帧内载荷未执行（inline/ext 均为 undefined）',
    payload?.inline === null && payload?.ext === null && payload?.onerror === null, JSON.stringify(payload))
  const hostAfter = await evalJs(`({ title: document.title, pwned: { inline: window.__kbProbePwnedInline ?? null, parent: window.__kbProbePwnedParent ?? null, onerror: window.__kbProbePwnedOnerror ?? null, parentOnerror: window.__kbProbePwnedParentOnerror ?? null, ext: window.__kbProbePwnedExt ?? null, parentExt: window.__kbProbePwnedParentExt ?? null } })`)
  console.log('[宿主终态]', JSON.stringify(hostAfter))
  ok('★ 宿主 window 未被污染（六个标志位全 null）',
    Object.values(hostAfter.pwned).every((v) => v === null), JSON.stringify(hostAfter.pwned))
  ok('★ 宿主 document.title 未被改写',
    hostAfter.title === hostBefore.title && hostAfter.title !== 'PWNED-INLINE', `${hostBefore.title} → ${hostAfter.title}`)
  const errs = await evalJs(`(window.__errs ?? []).slice(0, 6)`)
  note('渲染层错误（应为空）', JSON.stringify(errs))

  console.log(failed ? '\n存在失败断言' : '\n全部通过')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error('EPUB 阅读器探针失败:', e.message); process.exit(2) })
