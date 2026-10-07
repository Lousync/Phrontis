/**
 * foliate 系阅读器探针公共套件（阶段 2a · 2026-09-22）。
 *
 * 为什么要抽这一层：epub / fb2 / fbz 三种格式**共用同一个阅读器组件**（`EpubReaderView`
 * 是引擎系命名，见 bookFormats 的 `ENGINE_BY_EXT`），因此它们的探针**除了「造什么书、
 * 断言什么」之外完全一样**：CDP 引导、closed shadow root 里的内容帧访问、真输入事件、
 * fixture 读写、开书/返回。
 *
 * 抽出来的直接收益有两个，都不是「少写点字」：
 *   ① 内容帧只能走 CDP 取（帧在 closed shadow root 里，`window.frames` / `querySelector`
 *      都数不到它 —— 手法与踩坑记录见 `probe-epub-reader.mjs` 头注）。这套取帧逻辑
 *      每复制一份就多一份「下次改坐标基准时漏改一处」的机会。
 *   ② 三种格式的**锚点选择器是同一套**（`data-wb="epubReader"` 等，名字里的 epub 是历史
 *      遗留、已冻结不改名）。抽成常量后，真到了改锚点那天只改一处。
 *
 * ★ 抽取原则：**逐字搬运、不改行为**。搬完必须复跑 `probe-epub-reader.mjs` 全绿 ——
 *   它是本套件的回归证据（探针自己也是被测对象）。
 *
 * 用法：
 *   import { connect, READER } from './lib/reader-probe-kit.mjs'
 *   const K = await connect()            // 连 CDP、等宿主就绪、开 Runtime/Page 域
 *   await K.openBookshelf(); await K.openBook('探针样书.fb2')
 */

import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** foliate 系阅读器锚点（三种格式共用；名字里的 epub 是历史遗留，已冻结不改名） */
export const READER = {
  reader: '[data-wb="epubReader"]',
  host: '[data-wb="epubHost"]',
  rail: '[data-wb="epubRailPanel"]',
  pct: '[data-wb="epubPct"]',
  chapter: '[data-wb="epubChapter"]',
  back: '[data-wb="epubBack"]',
}

/** 摘录高亮色（与 EpubReaderView 的 HL_FILL 同源） */
export const HL_FILLS = ['#efb84c', '#7fb844', '#5d9bdc', '#e0709a', '#9188e8']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export { sleep }

/** 断言器：失败只记账 + 打印，由探针决定何时 `assertNotFailed()` 中断 */
export function createAssertions() {
  const st = { failed: false }
  const ok = (name, cond, extra = '') => {
    console.log(`${cond ? '  ok  ' : ' fail '} ${name}${cond ? '' : `  [${extra}]`}`)
    if (!cond) st.failed = true
  }
  const note = (name, extra = '') => console.log(`  --   ${name}  [${extra}]`)
  const assertNotFailed = () => { if (st.failed) { console.error('断言链中断'); process.exit(1) } }
  const finish = () => { console.log(st.failed ? '\n存在失败断言' : '\n全部通过'); process.exit(st.failed ? 1 : 0) }
  return { ok, note, assertNotFailed, failed: () => st.failed, finish }
}

/**
 * 连上 CDP + 等宿主就绪，返回一套绑定好的辅助函数。
 *
 * @param {{port?:number, readySelector?:string, bootTimeoutMs?:number}} o
 *   `readySelector` = 宿主就绪判据（默认书架标签按钮）；探针若另有锚点可覆盖。
 */
export async function connect(o = {}) {
  const DEBUG_PORT = Number(o.port ?? process.env.KNOWBASE_PROBE_PORT ?? 9222)
  const readySelector = o.readySelector ?? '[data-wb-bookmark="bookshelf"]'
  const bootTimeoutMs = o.bootTimeoutMs ?? 12000

  // ===== CDP 引导 =====
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
   * （foliate 的高亮 SVG 在 `<foliate-view>` 的 closed shadow 里，见 probe 头注）
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
        try { hostW = parent.document.querySelector('${READER.host}')?.clientWidth ?? null }
        catch (e) { hostW = 'ERR:' + e.name }
        return { rect: { l: Math.round(fr.left), t: Math.round(fr.top), w: Math.round(fr.width) },
          x, y, inside, hit: el ? el.tagName : null, hostW, cls: document.documentElement.className }
      })()`)
      if (r) out.push(r)
    }
    return out
  }
  const hostPct = () => evalJs(`Number((document.querySelector('${READER.pct}')?.textContent || '').replace('%', ''))`)
  const hostLabel = () => evalJs(`document.querySelector('${READER.chapter}')?.textContent ?? ''`)
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

  // ===== fixture 读写 =====
  const FIXTURE = join(process.cwd(), 'tmp', 'vault-fixture')
  const MODULES = join(FIXTURE, '.knowbase', 'modules')
  const readStore = (file) => {
    try { return JSON.parse(readFileSync(join(MODULES, file), 'utf8')) } catch { return null }
  }
  /**
   * 复位跨轮残留（进度 / 摘录 / CFI）。只删探针会断言的模块文件，其余一概不碰。
   * 必须在**开书之前**调用：主进程每次 readJson 都落盘读，删掉即等于「这本书从没被读过」。
   */
  function resetFixtureState(files = ['readerState.json', 'excerpts.json']) {
    const done = []
    for (const f of files) {
      try { unlinkSync(join(MODULES, f)); done.push(f) } catch { /* 本来就没有 */ }
    }
    return done
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

  // ===== 宿主操作 =====
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
  /**
   * 点书架里某个书名卡片（title = relPath）→ 等阅读器 ready。
   * ★ 匹配用 `名称 + $` 锚定**完整 relPath 尾部**：书架卡片 title 就是 relPath，
   *   而 fixture 里同时有「探针样书.epub / .fb2 / .txt」这类同前缀不同后缀的书 ——
   *   用 `includes('探针样书')` 会命中**第一张**卡（可能是别的格式）→ 挂错阅读器、等到超时。
   *   （2026-09-22 实际踩过：excerpt 导出探针因此假失败一轮。）
   */
  async function openBook(name) {
    const clicked = await evalJs(`(() => {
      const re = new RegExp(${JSON.stringify(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))} + '$')
      const b = [...document.querySelectorAll('main button[title]')].find((x) => re.test(x.getAttribute('title') || ''))
      if (!b) return 'no-card'
      b.scrollIntoView({ block: 'center' })
      b.click()
      return 'ok'
    })()`)
    if (clicked !== 'ok') {
      const diag = await evalJs(`[...document.querySelectorAll('main button[title]')].map((b) => b.getAttribute('title')).slice(0, 20)`)
      console.error('书架卡片清单:', JSON.stringify(diag))
      return false
    }
    return waitAttr(READER.reader, 'data-wb-state', 'ready')
  }
  async function backToShelf() {
    const b = await evalJs(`(() => { const x = document.querySelector('${READER.back}'); if (!x) return 'no-back'; x.click(); return 'ok' })()`)
    await sleep(900)
    return b === 'ok'
  }

  // ===== 连接 =====
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); return }
    if (m.method) { events.push(m); if (events.length > 400) events.shift() }
  }
  const deadline = Date.now() + bootTimeoutMs
  while (Date.now() < deadline) {
    if (await evalJs(`!!document.querySelector('${readySelector}')`).catch(() => false)) break
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

  return {
    // CDP
    send, evalJs, evalIn, events,
    evalFailures: () => evalFailures,
    // 帧
    blobFrames, blobCtxs, visibleCtxs, ctxWithText, frameBox, frameReport, pierceAttrs, pierceHighlightRect,
    // 宿主读数
    hostPct, hostLabel, htmlCls,
    // 输入
    mouse, clickAt,
    // fixture
    FIXTURE, MODULES, readStore, resetFixtureState, stateOf, excerptsOf,
    // 宿主操作
    waitAttr, openBookshelf, openBook, backToShelf,
    // 杂项
    sleep, port: DEBUG_PORT,
  }
}
