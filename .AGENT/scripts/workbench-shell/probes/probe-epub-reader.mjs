/**
 * EPUB 阅读器端到端探针（B 段 · 二期六格式引擎，方案 §1.7）。
 * 用法（先 seed 再跑）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs .AGENT/scripts/workbench-shell/probes/probe-epub-reader.mjs --no-sandbox --disable-gpu
 *
 * 断言链（任一失败 exit 1）：
 *   1) 点 EPUB 书卡片 → [data-wb="epubReader"] 挂载，data-wb-state 落到 ready（引擎解析 + 分页成功）
 *   2) 内容帧真在渲染：正文文本在、书内外部 CSS 生效（h1 = 红）、书内图片已解码（子资源 data: 通道）
 *   3) ★ 实机不变量：内容帧 sandbox 恰为 'allow-same-origin'（契约脚本只查源码文本，这里查运行时属性）
 *   4) 左栏按引擎分发：epubRailPanel 在位、pdfRailPanel 不在位；目录树三章齐（KB_EPUB_STATE_REQ 往返）
 *      ★ 负向：面板内**不得**再出现「缩略图 / 书签」Tab 或「暂不支持」占位（2026-09-21 拍板：
 *        不支持的格式不出入口，不做中性空态占位；这条原先是 filter 排除掉这三个 Tab 名，
 *        撤 Tab 后排除即变成静默宽容 → 改成不再排除 + 显式负向）
 *   5) 划选 → 浮条 → 摘录：excerpts.json 落 kind='epub' + cfi + chapter；Overlayer 高亮真的画上
 *   5.5) 点已有高亮 → 回看卡（且不翻页）—— 这条路径曾因写成 `view.getContents()`（不存在）而失效
 *   6) 点目录「第三章」→ toolbar 章节标签变 + 内容帧真的换页（KB_EPUB_GOTO_CFI 的 href 目标可用）
 *   6.5) 侧边点击翻页：悬停边缘出**手型光标**；点左/右边缘真的翻页（跨章 + 进度双向变化）；
 *        ★ 两条负向 —— 点正中不翻页（中间留给划选）、从边缘起**拖**不翻页（拖动 = 划选）
 *        ★ 坐标基准：**宿主阅读盒**（`[data-wb="epubHost"]` 的矩形），不是帧盒宽 ——
 *          分页器按章铺多个 iframe 并平移，帧既比宿主盒宽（右侧被裁）又可能整体偏一个帧宽
 *          （实测点宿主正中时帧收到 `clientX=2767`）。app 侧同样用宿主坐标判热区。
 *        ★ 排障钩子：本步会置 `window.__kbEdgeDiag = true`，之后每个鼠标事件都写进宿主
 *          `<html data-kb-edge>`（生产默认关，零开销）；「点了没反应」先读它看 frameX/hostX/branch。
 *   7) 进度落盘：readerState.json 该书 pct > 0 **且** locator 是 epubcfi(...) 串（双轨都写了）
 *   8) 返回书架 → 重开 → 位置从 CFI 恢复（回到第三章那一页，不是回首页）
 *   9) ★ 恶意书负向：三种载荷各占一章，逐一验「载荷在 DOM 里 + 一句都没执行 + 宿主清白」
 *
 * ★ fixture 前置复位（探针**必须**自带，不能只靠 seed 脚本）：
 *   本探针读的 readerState.json / excerpts.json 是**跨格式共用**的持久文件，跑完一轮就留下进度、
 *   摘录、CFI。不复位的话第二轮会：① 一开书就恢复到上一轮的章节（「书首段落已渲染」假失败）；
 *   ② `find(e => e.kind==='epub')` 命中上一轮的**旧摘录**（chapter 断言假通过）。两种都是「测的可能不是本轮代码」。
 *   主进程侧 jsonStore 无内存缓存（每次 readJson 都落盘读，jsonStore.ts:24），故在开书前删文件即可生效。
 *
 * ★ 取内容帧为什么走 CDP 而不是 DOM/window（2026-09-21 实测定性）：
 *   foliate 用 `attachShadow({mode:'closed'})`（view.js:203 / paginator.js:422），于是
 *   ① `document.querySelector('iframe')` 查不到（closed shadow 不可穿越）；
 *   ② **`window.frames` / `window.length` 也不计它** —— 对照实验：普通 iframe → length 1、
 *      sandbox 版 → 2、放进 closed shadow root 的 iframe → 仍是 2。这条反直觉，是踩过的坑。
 *   可靠路径 = CDP：`Page.getFrameTree` 取 blob: 帧的 frameId → `Runtime.enable` 期间收集的
 *   `executionContextCreated` 里按 `auxData.frameId + isDefault` 拿**帧的默认世界**上下文再求值。
 *   ★ 必须默认世界（不能用 `Page.createIsolatedWorld`）：载荷标志位写在页面自己的世界里，
 *   隔离世界读不到 → 恶意书负向断言会假绿。
 *
 * ★ 高亮（Overlayer）为什么也只能走 CDP：paginator 把高亮 `<svg>` 挂在**自己的容器**里
 *   （`paginator.js:406` `this.#element.append(overlayer.element)`），而该容器位于 `<foliate-view>`
 *   的 closed shadow root 内 —— 既不在内容帧里（帧内查 `svg g[fill]` 恒空），宿主 `document`
 *   也查不到。走 `DOM.getDocument({pierce:true})` 穿透 shadow root 收集 `fill` 属性值。
 */
const DEBUG_PORT = Number(process.env.KB_CDP_PORT || 9222) // 端口可覆盖（见 run-probe.mjs）：默认 9222 不变
const { readFileSync, unlinkSync } = await import('node:fs')
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
/** CDP 事件（Runtime.executionContextCreated 等）——帧上下文表靠它建 */
const events = []
/**
 * 发一条 CDP 命令，返回**整条消息**（不是 `message.result`）。
 * ★ 只取 result 会在出错时变成 undefined（`message.error` 才是唯一线索），后续一读属性就
 *   TypeError 崩掉整轮 —— 而「Execution context was destroyed」在格子被预载/替换时极常见。
 */
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
/** 求值因竞态失败（上下文已销毁等）的计数：单独统计，不与断言失败混为一谈 */
let evalFailures = 0
const evalJs = async (expr) => {
  const msg = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (msg?.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description || 'eval 异常')
  if (msg?.error || !msg?.result) { evalFailures++; return undefined }
  return msg.result.result?.value
}

let failed = false
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' fail '} ${name}${cond ? '' : `  [${extra}]`}`)
  if (!cond) failed = true
}
const note = (name, extra = '') => console.log(`  --   ${name}  [${extra}]`)
const assertNotFailed = () => { if (failed) { console.error('断言链中断'); process.exit(1) } }

// ===== 内容帧访问（CDP 帧 + 默认世界上下文）=====
/** 当前帧树里的 blob: 内容帧（foliate 每个 section 一个） */
async function blobFrames() {
  const msg = await send('Page.getFrameTree')
  const tree = msg?.result?.frameTree
  if (!tree) return []
  const out = []
  const rec = (f) => {
    if ((f.frame.url || '').startsWith('blob:')) out.push(f.frame)
    for (const c of f.childFrames ?? []) rec(c)
  }
  rec(tree)
  return out
}
/** frameId → 该帧**默认世界**的执行上下文 id */
function ctxOf(frameId) {
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i]
    if (p.method === 'Runtime.executionContextCreated'
      && p.params.context?.auxData?.frameId === frameId
      && p.params.context?.auxData?.isDefault) return p.params.context.id
  }
  return null
}
async function blobCtxs() {
  const out = []
  for (const f of await blobFrames()) {
    const ctx = ctxOf(f.id)
    if (ctx !== null) out.push({ frameId: f.id, ctx, url: f.url.slice(0, 24) })
  }
  return out
}
const evalIn = async (ctx, expr) => {
  const msg = await send('Runtime.evaluate', { expression: expr, contextId: ctx, returnByValue: true, awaitPromise: true })
  if (msg?.error || !msg?.result) { evalFailures++; return undefined }
  if (msg.result.exceptionDetails) return { __err: msg.result.exceptionDetails.exception?.description || 'err' }
  return msg.result.result?.value
}
/** 当前**可见**的内容帧（分页期 foliate 会同时挂可见帧与预载帧，仅后者 display:none → clientHeight=0） */
async function visibleCtxs() {
  const all = await blobCtxs()
  const vis = []
  for (const c of all) if (await evalIn(c.ctx, `document.documentElement.clientHeight > 0`) === true) vis.push(c)
  return vis.length ? vis : all
}
/**
 * 穿透 closed shadow root 收集指定节点名的某个属性值
 * （foliate 的高亮 SVG 在 `<foliate-view>` 的 closed shadow 里，见文件头注释）
 *
 * ★ CDP 的 `Node.attributes` 是**扁平数组** `[name1, value1, name2, value2, …]`（协议如此），
 *   不是 `[{name,value}]` —— 当成对象取 `.name` 会恒 undefined，于是「明明画了高亮却查不到」。
 */
async function pierceAttrs(nodeName, attrName) {
  const msg = await send('DOM.getDocument', { depth: -1, pierce: true })
  const doc = msg?.result
  const out = []
  if (!doc?.root) return out
  // 大小写不敏感：CDP 对 HTML 元素给大写名（'IFRAME'），SVG 元素给小写（'g'）
  const want = nodeName.toLowerCase()
  const walk = (n) => {
    if (!n) return
    if ((n.nodeName ?? '').toLowerCase() === want) {
      const a = n.attributes ?? []
      for (let i = 0; i + 1 < a.length; i += 2) if (a[i] === attrName) out.push(a[i + 1])
    }
    for (const c of n.children ?? []) walk(c)
    for (const sr of n.shadowRoots ?? []) walk(sr)
    if (n.contentDocument) walk(n.contentDocument)
  }
  walk(doc.root)
  return out
}

/** 含指定文本的内容帧上下文（换章后帧可能换新，靠文本定位最稳） */
async function ctxWithText(needle) {
  for (const c of (await blobCtxs()).reverse()) {
    const t = await evalIn(c.ctx, `(document.body && document.body.textContent) || ''`)
    if (typeof t === 'string' && t.includes(needle)) return c
  }
  return null
}

// ===== 真输入事件（CDP `Input.dispatchMouseEvent`）辅助；坐标空间 = 顶层视口 =====
/**
 * 当前可见内容帧在**宿主视口**里的矩形。iframe 在 closed shadow root 内、宿主查不到，
 * 只能从**帧内**读 `frameElement.getBoundingClientRect()`（元素属父文档 → 返回的就是父视口坐标）。
 */
async function frameBox() {
  const [c] = await visibleCtxs()
  if (!c) return null
  return await evalIn(c.ctx, `(() => {
    const r = frameElement && frameElement.getBoundingClientRect()
    return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
  })()`)
}
/**
 * 逐帧报告：每个可见内容帧自报「宿主坐标 (absX,absY) 是否落在我这儿」+ 它自己的 html class +
 * 它能不能读到宿主盒（app 的 `visibleW()` 走的就是这条路）。
 * ★ 用途：CDP 派事件时，**事件进哪个帧**不由探针决定 —— 只读 `visibleCtxs()[0]` 会读到另一个帧，
 *   表象是「明明挂了类却读不到 / 类摘不掉」这种忽左忽右的假失败（踩过）。点在哪，就以哪个帧为准。
 */
async function frameReport(absX, absY) {
  const out = []
  for (const c of await visibleCtxs()) {
    const r = await evalIn(c.ctx, `(() => {
      const fr = frameElement && frameElement.getBoundingClientRect()
      if (!fr) return null
      const x = Math.round(${absX} - fr.left), y = Math.round(${absY} - fr.top)
      const inside = x >= 0 && y >= 0 && x < fr.width && y < fr.height
      const el = inside ? document.elementFromPoint(x, y) : null
      let hostW = null
      try { hostW = parent.document.querySelector('[data-wb="epubHost"]')?.clientWidth ?? null }
      catch (e) { hostW = 'ERR:' + e.name }
      return { rect: { l: Math.round(fr.left), t: Math.round(fr.top), w: Math.round(fr.width) },
        x, y, inside, hit: el ? el.tagName : null, hostW, cls: document.documentElement.className }
    })()`)
    if (r) out.push(r)
  }
  return out
}
const hostPct = () => evalJs(`Number((document.querySelector('[data-wb="epubPct"]')?.textContent || '').replace('%', ''))`)
const hostLabel = () => evalJs(`document.querySelector('[data-wb="epubChapter"]')?.textContent ?? ''`)
async function htmlCls() {
  const [c] = await visibleCtxs()
  return c ? await evalIn(c.ctx, `document.documentElement.className`) : null
}
const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', {
  type, x: Math.round(x), y: Math.round(y),
  button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
})
/** 真点击：按下 + 抬起同点（位移 0 → 过 slop 判据）；等翻页动画与 relocate 落定 */
async function clickAt(x, y) {
  await mouse('mousePressed', x, y, 1)
  await mouse('mouseReleased', x, y)
  await sleep(1200)
}
/** 摘录高亮色（与 EpubReaderView 的 HL_FILL 同源） */
const HL_FILLS = ['#efb84c', '#7fb844', '#5d9bdc', '#e0709a', '#9188e8']
/**
 * 第一个高亮 `<g>` 里 `<rect>` 的几何。x/y 相对**内容帧原点**（高亮 SVG 与内容帧同原点，
 * 因为 rects 就是帧内 `getClientRects()` 算的）→ 宿主页坐标 = frameBox + 该值。
 * 高亮 SVG 在 closed shadow 里，宿主查不到，故与 pierceAttrs 一样走穿透。
 */
async function pierceHighlightRect() {
  const msg = await send('DOM.getDocument', { depth: -1, pierce: true })
  const root = msg?.result?.root
  if (!root) return null
  let found = null
  const attrs = (n) => {
    const a = n.attributes ?? []
    const out = {}
    for (let i = 0; i + 1 < a.length; i += 2) out[a[i]] = a[i + 1]
    return out
  }
  const walk = (n) => {
    if (!n || found) return
    if ((n.nodeName ?? '').toLowerCase() === 'g') {
      const g = attrs(n)
      if (HL_FILLS.includes(String(g.fill))) {
        const r = (n.children ?? []).find((c) => (c.nodeName ?? '').toLowerCase() === 'rect')
        if (r) {
          const ra = attrs(r)
          const geo = { x: Number(ra.x), y: Number(ra.y), w: Number(ra.width), h: Number(ra.height) }
          if (Object.values(geo).every(Number.isFinite)) found = geo
        }
      }
    }
    for (const c of n.children ?? []) walk(c)
    for (const sr of n.shadowRoots ?? []) walk(sr)
    if (n.contentDocument) walk(n.contentDocument)
  }
  walk(root)
  return found
}

const FIXTURE = join(process.cwd(), 'tmp', 'vault-fixture')
const MODULES = join(FIXTURE, '.knowbase', 'modules')
const readStore = (file) => {
  try { return JSON.parse(readFileSync(join(MODULES, file), 'utf8')) } catch { return null }
}
/**
 * 复位跨轮残留（见文件头）。只删本探针会断言的模块文件，其余一概不碰。
 * 必须在**开书之前**调用：主进程每次 readJson 都落盘读，删掉即等于「这本书从没被读过」。
 */
function resetFixtureState() {
  const done = []
  for (const f of ['readerState.json', 'excerpts.json']) {
    try { unlinkSync(join(MODULES, f)); done.push(f) } catch { /* 本来就没有 */ }
  }
  note('fixture 复位（删除跨轮残留）', done.join(' ') || '（无残留）')
}
const stateOf = (name) => {
  const s = readStore('readerState.json')
  const keys = Object.keys(s?.books ?? {}).filter((k) => k.endsWith(`/.books/${name}`))
  return keys.length ? s.books[keys[0]] : null
}
const excerptsOf = (name) => {
  const s = readStore('excerpts.json')
  const keys = Object.keys(s?.books ?? {}).filter((k) => k.endsWith(`/.books/${name}`))
  return keys.length ? Object.values(s.books[keys[0]]) : []
}

const BOOK = '探针样书.epub'
const EVIL = '恶意样书.epub'

async function waitAttr(sel, attr, want, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(`document.querySelector('${sel}')?.getAttribute('${attr}') ?? null`)
    if (v === want) return true
    await sleep(250)
  }
  return false
}

async function openBookshelf() {
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="bookshelf"]')?.click(); return true })()`)
  await sleep(1000)
}

/** 点书架里某个书名卡片（title = relPath）→ 等阅读器 ready */
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
  const b = await evalJs(`(() => { const x = document.querySelector('[data-wb="epubBack"]'); if (!x) return 'no-back'; x.click(); return 'ok' })()`)
  await sleep(900)
  return b === 'ok'
}

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); return }
    if (m.method) { events.push(m); if (events.length > 400) events.shift() }
  }
  for (let i = 0; i < 24; i++) {
    if (await evalJs(`!!document.querySelector('[data-wb-bookmark="bookshelf"]')`).catch(() => false)) break
    await sleep(500)
  }
  await sleep(800)
  // Runtime.enable 会把**已存在**的上下文一并上报（状态同步域），故此处开启即够
  await send('Runtime.enable')
  await send('Page.enable')
  await evalJs(`(() => {
    window.__errs = []
    window.addEventListener('error', (e) => window.__errs.push(String(e.message || e)))
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)))
    return true
  })()`)
  const hostBase = await evalJs(`({ title: document.title, len: window.frames.length })`)
  console.log('[宿主基线]', JSON.stringify(hostBase))
  const PWNED = `({ inline: window.__kbProbePwnedInline ?? null, parent: window.__kbProbePwnedParent ?? null, onerror: window.__kbProbePwnedOnerror ?? null, parentOnerror: window.__kbProbePwnedParentOnerror ?? null, ext: window.__kbProbePwnedExt ?? null, parentExt: window.__kbProbePwnedParentExt ?? null })`

  // ===== 0) fixture 复位（必须在开书前，见文件头）=====
  resetFixtureState()

  // ===== 1) 打开 EPUB → 阅读器 ready =====
  await openBookshelf()
  ok('打开 EPUB → epubReader 挂载且 state=ready（引擎解析 + 分页成功）', await openBook(BOOK))
  assertNotFailed()
  await sleep(1200)

  // ===== 2) 内容帧真在渲染 =====
  const frames = await blobFrames()
  note('blob 内容帧数（CDP）', String(frames.length))
  const ctxs = await visibleCtxs()
  ok('内容帧可经 CDP 定位到执行上下文（closed shadow root 内的帧）', ctxs.length > 0, `blobFrames=${frames.length}`)
  assertNotFailed()
  const ctx0 = ctxs[0].ctx
  const render = await evalJs(`({ pct: document.querySelector('[data-wb="epubPct"]')?.textContent ?? null, chapter: document.querySelector('[data-wb="epubChapter"]')?.textContent ?? null })`)
  const body = await evalIn(ctx0, `(document.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 120)`)
  const h1 = await evalIn(ctx0, `(() => { const h = document.querySelector('h1'); return h ? getComputedStyle(h).color : null })()`)
  const img = await evalIn(ctx0, `(() => { const i = document.querySelector('img'); return i ? i.naturalWidth : null })()`)
  const frameW = await evalIn(ctx0, `(() => { const fe = window.frameElement; return fe ? Math.round(fe.getBoundingClientRect().width) : null })()`)
  console.log('[渲染诊断]', JSON.stringify({ render, body, h1, img, frameW }))
  ok('正文文本进入内容帧（解析 + 排版）', typeof body === 'string' && body.length > 0, String(body))
  ok('书首段落已渲染（分页第 1 页）', typeof body === 'string' && body.includes('这一段用于验证'), String(body).slice(0, 60))
  ok('书内外部 CSS 生效（h1 呈红色 rgb(204, 0, 0) = 书内 style.css 的 #c00）', h1 === 'rgb(204, 0, 0)', String(h1))
  ok('书内图片已解码（子资源 data: 通道通畅）', (img ?? 0) > 0, String(img))
  note('分页证据：内容帧元素宽 vs 阅读器宽', `frame=${frameW}px`)

  // ===== 3) ★ 运行时安全不变量（从帧内读，比契约脚本的源码文本更硬） =====
  const sandbox = await evalIn(ctx0, `(() => { const fe = window.frameElement; return fe ? fe.getAttribute('sandbox') : 'frameElement=null' })()`)
  ok('★★ 内容帧 sandbox = allow-same-origin（不含 allow-scripts）', sandbox === 'allow-same-origin', String(sandbox))
  const frameOrigin = await evalIn(ctx0, `location.origin + '|' + (location.protocol)`)
  note('内容帧源（blob: 同源证据）', String(frameOrigin))

  // ===== 4) 左栏按引擎分发 + 目录树 =====
  const rail = await evalJs(`(() => {
    const p = document.querySelector('[data-wb="epubRailPanel"]')
    return {
      epubRail: !!p, state: p?.getAttribute('data-wb-state') ?? null,
      pdfRail: !!document.querySelector('[data-wb="pdfRailPanel"]'),
      list: !!document.querySelector('[data-wb="bookshelfSideList"]'),
      // ★ 不再排除 Tab 名：撤掉三态切换头后，面板里的 button 只应是目录条目 ——
      //   一旦有人把跳「缩略图 / 书名」之类入口加回来，labels 会立刻多出这些字样（原先的排除是静默宽容）。
      labels: p ? [...p.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean) : [],
      staleTabs: p ? [...p.querySelectorAll('button')].filter((b) => /^(目录|缩略图|书签)$/.test((b.textContent || '').trim())).length : 0,
      panelText: p ? (p.textContent || '') : '',
    }
  })()`)
  console.log('[左栏诊断]', JSON.stringify(rail))
  ok('EPUB 在读 → 左栏挂 epubRailPanel 且 ready', rail.epubRail && rail.state === 'ready', JSON.stringify(rail))
  ok('EPUB 在读 → 左栏不挂 PDF 三件套 / 不挂书目列表', !rail.pdfRail && !rail.list)
  ok('目录树三章齐（KB_EPUB_STATE_REQ 往返成功）',
    ['第一章', '第二章', '第三章'].every((t) => rail.labels.some((l) => l.includes(t))), JSON.stringify(rail.labels))
  // ★★ 负向：不支持的格式不出入口（2026-09-21 拍板）—— 撤掉三态切换头后，面板里既不该有
  //    「目录 / 缩略图 / 书签」这类 Tab（目录本身也不该有，只剩条目），也不该有「暂不支持」占位文案。
  ok('★★ 左栏面板不出现切换 Tab（缩略图 / 书签 / 空态占位）',
    rail.staleTabs === 0 && !rail.panelText.includes('暂不支持'), JSON.stringify({ staleTabs: rail.staleTabs }))

  // ===== 5) 划选 → 摘录 =====
  const selRes = await evalIn(ctx0, `(() => {
    const p = [...document.querySelectorAll('p')].find((x) => (x.textContent || '').trim().length >= 24)
    if (!p || !p.firstChild) return 'no-p'
    const tn = p.firstChild
    const r = document.createRange()
    r.setStart(tn, 0)
    r.setEnd(tn, Math.min(24, tn.data.length))
    const s = getSelection()
    s.removeAllRanges(); s.addRange(r)
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
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
    return { left: Math.round(r.left), top: Math.round(r.top), inHost: !!host && r.top >= host.top - 4 && r.bottom <= host.bottom + 80 }
  })()`)
  ok('划选浮条出现（getCFI 成功 → capture 态）', !!barRect, JSON.stringify(barRect))
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
    marks = (await pierceAttrs('g', 'fill')) ?? []
    if (marks.length > 0) break
    await sleep(300)
  }
  ok('Overlayer 高亮真的画上了（draw-annotation → <g fill> 落 #efb84c）',
    Array.isArray(marks) && marks.includes('#efb84c'), JSON.stringify(marks))

  // ===== 5.5) 点已有高亮 → 回看卡（此路径曾因 `view.getContents()` 不存在而整体失效）=====
  const hl = await pierceHighlightRect()
  const box5 = await frameBox()
  ok('读到高亮 <rect> 几何（点它用的坐标）', !!hl && !!box5, JSON.stringify({ hl, box5 }))
  if (hl && box5) {
    // 点高亮**最左端**（首段首行贴着帧左边缘 → 多半落在侧边热区内）：既要出回看卡，又不能翻页
    const hx = box5.left + hl.x + 2
    const hy = box5.top + hl.y + hl.h / 2
    const pctH0 = await hostPct()
    await clickAt(hx, hy)
    const pop = await evalJs(`(() => { const p = document.querySelector('.kb-pop'); return p ? (p.textContent || '').slice(0, 40) : null })()`)
    ok('点已有高亮 → 出回看卡（走 view.renderer.getContents 取帧内 range）', !!pop, `${String(pop)} @x=${Math.round(hx - box5.left)}px`)
    ok('★ 点高亮不翻页（热区判定先让给高亮）', (await hostPct()) === pctH0, `${pctH0}% → ${await hostPct()}%`)
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('.kb-pop button')].find((x) => (x.getAttribute('title') || '') === '关闭')
      if (b) b.click(); return true
    })()`)
    await sleep(300)
  }

  // ===== 6) 目录跳转 =====
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
  let ch3 = null
  for (let i = 0; i < 12; i++) {
    ch3 = await ctxWithText('第三章')
    if (ch3) break
    await sleep(300)
  }
  ok('内容帧真的换到第三章那一页', !!ch3, ch3 ? ch3.url : 'null')

  // ===== 6.5) 侧边点击翻页 =====
  //  用 CDP Input 派**真输入事件**（命中测试 / click 合成 / 光标类都走真实链路），不用合成 DOM 事件。
  //  坐标辅助（frameBox / mouse / clickAt / hostPct …）在文件头部的模块级。
  const box = await frameBox()
  ok('读到内容帧在宿主里的矩形（热区坐标基准）', !!box && box.width > 0, JSON.stringify(box))
  if (box) {
    // ★ 坐标基准是**宿主阅读盒**，不是帧盒：分页器把 iframe 铺得比宿主盒宽（实测 1830 vs 656），
    //   超出部分被宿主 `overflow-hidden` 裁掉、看不见也点不到 → 按帧盒宽取点会点到屏幕外。
    const host = await evalJs(`(() => {
      const h = document.querySelector('[data-wb="epubHost"]')
      if (!h) return null
      const r = h.getBoundingClientRect()
      return { w: h.clientWidth, left: r.left, right: r.right, top: r.top, height: r.height }
    })()`)
    ok('读到宿主阅读盒（可见阅读宽基准）', !!host && host.w > 0, JSON.stringify(host))
    // ★ 坐标一律按**宿主阅读盒**取：帧内坐标会因分页器的跨章平移而整体偏掉（实测点宿主正中
    //   时帧收到 `clientX=2767` = 327 + 上一章宽度 2440），按帧盒宽取点必然错。
    const midY = box.top + box.height * 0.5
    // 左边缘要落在**帧**里（宿主盒比帧还往左探出 23px：实测 host.left=307、frame.left=330），
    // 取了 host.left + 12 = 319 就点在帧外 → 帧收不到事件（踩过）
    const leftX = Math.max((host?.left ?? box.left) + 12, box.left + 12)
    const midX = host ? Math.round((host.left + host.right) / 2) : box.left + box.width * 0.5
    // 右边缘向内留 30px：宿主盒右边界外还有面板容器（实测 ~950 之后再点就落不到帧上了）
    const rightX = (host?.right ?? box.left + box.width) - 30
    // 帧的**可点**右边界（横扫 elementFromPoint）：正常应 ≈ 宿主右边界；
    // 若明显更窄，说明「可见宽」还有第三个口径（宿主盒比引擎容器宽），热区基准要再改。
    const hitRight = await evalJs(`(() => {
      const top = ${Math.round(midY)}
      for (let x = ${Math.round(box.left)} + 4; x < window.innerWidth; x += 8) {
        const e = document.elementFromPoint(x, top)
        if (!e || e.tagName !== 'FOLIATE-VIEW') return x
      }
      return null
    })()`)
    note('可点右边界（null = 直到窗口右边缘都还是帧）', `${hitRight}`)
    // 热区按**帧内视口宽**算（handler 用 documentElement.clientWidth）。分栏布局下
    // 帧盒宽 / 帧内视口宽 / 可见阅读区宽三者未必相等，踩过一次，故留诊断。
    const inner = await (async () => {
      const [c] = await visibleCtxs()
      if (!c) return null
      return await evalIn(c.ctx, `(() => { const d = document.documentElement
        return { cw: d.clientWidth, sw: d.scrollWidth, ch: d.clientHeight, iw: innerWidth, cols: getComputedStyle(d).columnCount } })()`)
    })()
    // 宿主侧「这个点到底是谁的」：`elementFromPoint` 命中 iframe 时会返回其**宿主元素**
    // （closed shadow 不穿透），命中别的元素就是**有东西盖在阅读区上** —— 决定点击能不能到帧里。
    const at = await evalJs(`(() => {
      const who = (x, y) => { const e = document.elementFromPoint(x, y); return e ? (e.tagName + (e.className ? '.' + String(e.className).split(' ')[0] : '')) : 'null' }
      // ★ DOMRect 没有可枚举自有属性 → 直接序列化恒为 {}，必须显式取字段（踩过）
      const rj = (sel) => { const e = document.querySelector(sel); if (!e) return null
        const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: e.clientWidth } }
      return {
        winW: window.innerWidth, winH: window.innerHeight,
        host: rj('[data-wb="epubHost"]'),
        reader: rj('[data-wb="epubReader"]'),
        panel: rj('[data-wb="readingPanel"]'),
        who: { l: who(${Math.round(leftX)}, ${Math.round(midY)}), m: who(${Math.round(midX)}, ${Math.round(midY)}), r: who(${Math.round(rightX)}, ${Math.round(midY)}) },
      }
    })()`)
    // 打开 app 侧排障钩子：事件坐标写进宿主 <html data-kb-edge>（生产默认关，零开销）
    await evalJs(`window.__kbEdgeDiag = true`)
    note('热区诊断（帧盒 / 帧内视口 / 分栏 / 宿主点）', JSON.stringify({
      box, inner, host,
      click: { l: Math.round(leftX), m: Math.round(midX), r: Math.round(rightX) },
    }))
    note('热区诊断（宿主几何 / 三点命中）', JSON.stringify(at))

    // ① 悬停左边缘 → 内容文档 <html> 挂手型类（热区唯一可见线索）。
    //    连发两次 mousemove：真实鼠标本就连续发；单发会被帧重排吞掉（踩过）。
    //    class 只从**点落在它里面**的帧上读（`htmlCls` 读 [0] 会读到别的帧 → 假失败）。
    await mouse('mouseMoved', leftX, midY)
    await sleep(150)
    await mouse('mouseMoved', leftX, midY)
    await sleep(400)
    const repL = await frameReport(leftX, midY)
    note('逐帧报告（悬停左边缘）', JSON.stringify(repL))
    const clsL = repL.filter((r) => r.inside && r.hit).map((r) => r.cls).join(' | ')
    ok('悬停左边缘 → 内容文档挂 kb-et-l（手型光标提示热区）', clsL.includes('kb-et-l'), clsL)

    await mouse('mouseMoved', midX, midY)
    await sleep(150)
    await mouse('mouseMoved', midX, midY)
    await sleep(300)
    const repM = await frameReport(midX, midY)
    note('逐帧报告（移到正中）', JSON.stringify(repM))
    const clsM = repM.filter((r) => r.inside && r.hit).map((r) => r.cls).join(' | ')
    ok('移到正中 → 手型类摘掉（只有边缘是热区）', !clsM.includes('kb-et-'), clsM)

    // ② 点左边缘 = 上一页：跨回第二章（此时停在第三章首屏）
    const pct0 = await hostPct()
    await clickAt(leftX, midY)
    const pctL = await hostPct()
    const labelL = await hostLabel()
    ok('点左边缘 → 翻到上一页（进度回落）', Number.isFinite(pctL) && pctL < pct0, `${pct0}% → ${pctL}%`)
    ok('点左边缘 → 真跨章（toolbar 从第三章回到第二章）', String(labelL).includes('第二章'), String(labelL))
    const edgeDiag = () => evalJs(`document.documentElement.getAttribute('data-kb-edge')`)

    // ③ 点右边缘 = 下一页：翻回第三章原处
    await clickAt(rightX, midY)
    note('app 侧事件诊断（左/右边缘点击后）', String(await edgeDiag()))
    const pctR = await hostPct()
    const labelR = await hostLabel()
    ok('点右边缘 → 翻回下一页（进度回到原值附近）', Math.abs(pctR - pct0) <= 1, `${pctL}% → ${pctR}%（原 ${pct0}%）`)
    ok('点右边缘 → 回到第三章', String(labelR).includes('第三章'), String(labelR))

    // ④ ★ 负向：点正中不翻页（中间留白给划选）
    await clickAt(midX, midY)
    note('逐帧报告（点正中之后）', JSON.stringify(await frameReport(midX, midY)))
    note('app 侧事件诊断（点正中之后）', String(await edgeDiag()))
    ok('★ 负向：点正中不翻页（中间是划选区）', (await hostPct()) === pctR, `${pctR}% → ${await hostPct()}%`)

    // ⑤ ★ 负向：从边缘起拖动（= 划选）不翻页 —— 按下/抬起间距 60px > slop
    await mouse('mousePressed', leftX, midY, 1)
    await mouse('mouseReleased', leftX + 60, midY)
    await sleep(900)
    ok('★ 负向：从边缘起拖（划选）不翻页', (await hostPct()) === pctR, `${pctR}% → ${await hostPct()}%`)
    // ⑤ 可能留下选区 → 清掉，避免影响后面「返回书架」的点击
    const [cTail] = await visibleCtxs()
    if (cTail) await evalIn(cTail.ctx, `getSelection().removeAllRanges()`)
  }

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
  ok('重开该书 → 回到 ready', await openBook(BOOK))
  await sleep(1500)
  const restored = await evalJs(`({
    pct: document.querySelector('[data-wb="epubPct"]')?.textContent ?? null,
    chapter: document.querySelector('[data-wb="epubChapter"]')?.textContent ?? null,
  })`)
  const backCtx = await ctxWithText('第三章')
  console.log('[恢复诊断]', JSON.stringify(restored), '落盘 pct =', pctBefore, '第三章帧 =', !!backCtx)
  const uiPct = parseInt(String(restored.pct).replace('%', ''), 10)
  ok('重开后进度回到落盘值附近（CFI 恢复生效）', Number.isFinite(uiPct) && Math.abs(uiPct - pctBefore) <= 5, `ui=${restored.pct} disk=${pctBefore}`)
  ok('重开后停在第三章（不是回首页）', !!backCtx, String(restored.chapter))

  // ===== 9) ★ 恶意书负向 =====
  ok('点「返回书架」准备开恶意书', await backToShelf())
  ok('恶意书能正常渲染（不崩、不白屏）', await openBook(EVIL))
  await sleep(1500)
  const evilCtxs = await visibleCtxs()
  ok('恶意书内容帧可读', evilCtxs.length > 0, String(evilCtxs.length))
  const evilBody = await evalIn(evilCtxs[0].ctx, `(document.body.textContent || '').slice(0, 60)`)
  ok('恶意书正文已渲染', typeof evilBody === 'string' && evilBody.length > 0, String(evilBody))
  // 三种载荷各占一章（make-epub.mjs），逐一验「DOM 里在 + 一句没执行」
  const EVIL_CASES = [
    { toc: '第一章', anchor: '本页用', sel: 'script[src]', desc: '外部 <script src>（子资源）' },
    { toc: '第二章', anchor: '本页含内联 script', sel: 'script:not([src])', desc: '内联 <script>' },
    { toc: '第三章', anchor: '本页含 onerror', sel: 'img[onerror]', desc: 'onerror 属性' },
  ]
  for (const c of EVIL_CASES) {
    const clicked = await evalJs(`(() => {
      const p = document.querySelector('[data-wb="epubRailPanel"]')
      const b = p ? [...p.querySelectorAll('button')].find((x) => new RegExp(${JSON.stringify(c.toc)}).test(x.textContent || '')) : null
      if (!b) return 'no-item'
      b.click(); return 'ok'
    })()`)
    if (clicked !== 'ok') { ok(`恶意书目录跳到「${c.toc}」`, false, String(clicked)); continue }
    let ctx = null
    for (let i = 0; i < 12; i++) {
      ctx = await ctxWithText(c.anchor)
      if (ctx) break
      await sleep(300)
    }
    if (!ctx) { ok(`定位「${c.desc}」那一帧`, false, c.anchor); continue }
    const payload = await evalIn(ctx.ctx, `({
      alive: !!document.querySelector(${JSON.stringify(c.sel)}),
      scripts: document.querySelectorAll('script').length,
      scriptHtml: document.querySelector('script')?.outerHTML?.slice(0, 120) ?? null,
      markers: ${PWNED},
    })`)
    console.log(`[载荷诊断 ${c.desc}]`, JSON.stringify(payload))
    ok(`「${c.desc}」载荷存活在 DOM 里（上游不净化 + 加载器不删标签）`, payload?.alive === true, JSON.stringify(payload))
    ok(`★「${c.desc}」未执行（该帧标志位全 null）`,
      Object.values(payload?.markers ?? { x: 1 }).every((v) => v === null), JSON.stringify(payload?.markers))
    if (c.sel === 'script[src]') {
      // foliate 加载器还有第三条防线：`MIME.JS` 命中且 allowScript=false → loadItem 直接返回 null
      // （epub.js:794），于是既不加载也不按「子资源」通道改写成 data:。
      // 实机看到的是 `src="null"` —— replaceString 把 null 结果字符串化后照样写回属性，
      // 所以判据是「标签没被删、也没被换成可加载的 data:」（= 上游确实不净化），
      // 而不是「src 被改写成 data:」（脚本走的根本不是子资源通道）。
      note('外部脚本标签（加载器丢弃 → src 被写成字符串 "null"，更不可能加载）', String(payload?.scriptHtml))
    }
  }
  const hostAfter = await evalJs(`({ title: document.title, pwned: ${PWNED} })`)
  console.log('[宿主终态]', JSON.stringify(hostAfter))
  ok('★ 宿主 window 未被污染（六个标志位全 null）', Object.values(hostAfter.pwned).every((v) => v === null), JSON.stringify(hostAfter.pwned))
  ok('★ 宿主 document.title 未被改写', hostAfter.title === hostBase.title && hostAfter.title !== 'PWNED-INLINE', `${hostBase.title} → ${hostAfter.title}`)
  const errs = await evalJs(`(window.__errs ?? []).slice(0, 6)`)
  note('渲染层错误（应为空）', JSON.stringify(errs))
  note('CDP 求值竞态失败次数（帧被替换瞬间求值，非断言失败）', String(evalFailures))
  note('blob 内容帧数（收尾）', String((await blobFrames()).length))

  console.log(failed ? '\n存在失败断言' : '\n全部通过')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error('EPUB 阅读器探针失败:', e.message); process.exit(2) })
