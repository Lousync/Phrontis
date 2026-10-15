/**
 * 双写作面运行时探针（源码档 Monaco / 即时渲染档 CM6 + 编辑器右键菜单）
 * 方案：`docs/note-surface-dual-engine-design.md`
 *
 * 要证的事（契约脚本只能证明源码接线，这里证明**真跑起来是对的**）：
 *   P1 默认（源码档）打开笔记进编辑态 = Monaco 在场
 *   P2 源码档右键 → 应用自己的写作菜单出现（不是 Monaco 自带菜单），Esc 能关
 *   P3 切到即时渲染档（设置 + 广播）→ CM6 在场，且 **Monaco 不在场**（单写者：同文件只挂一个引擎）
 *   P4 即时渲染真的渲染了：标题/加粗/引用/任务/表格/公式/代码块各自的 DOM 在场，
 *      且**标记被隐藏**（正文里看不到 `**` 与 `| --- |`）—— 这是「即时渲染」与「淡化」的分水岭
 *   P5 光标所在块回源码：把光标放到加粗那一行，该行的 `**` 必须重新出现（否则等于不可编辑）
 *   P6 即时渲染档右键菜单同样出现，且点「插入 → 分隔线」真的落进文档并渲染成分隔线 widget
 *   P7 切回源码档 → Monaco 回来、CM6 退场（来回切不残留）
 *   P8 表格渲染态**就地编辑**：真点单元格 → 打字写回源 → Tab 换格 / Esc 退出 / 格内 Ctrl+Z 撤销，
 *      且「插入 → 表格」插完焦点直接进首格（对齐 Obsidian，2026-10-11）
 *   P9 console 零 error
 *
 * 用法（隔离实例，不动用户 dev 数据；必须先 build）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --ud "knowbase (dev probe-app)"
 *   node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs \
 *     .AGENT/scripts/notes-surface/probe-note-surface.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SHOT_DIR = join(ROOT, 'tmp', 'probe-shots')
const NOTE_REL = '写作面探针.md'

async function waitPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(1500) })
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page && page.webSocketDebuggerUrl) return page
    } catch { /* electron 未起，继续等 */ }
    await sleep(500)
  }
  throw new Error('CDP page target 未出现')
}

let ws
let msgId = 0
const pending = new Map()
const consoleErrors = []
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('evaluate 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result?.value
}
async function shot(name) {
  try {
    mkdirSync(SHOT_DIR, { recursive: true })
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const p = join(SHOT_DIR, name + '.png')
    writeFileSync(p, Buffer.from(r.data, 'base64'))
    return p
  } catch (e) { return 'shot 失败: ' + String(e.message).slice(0, 120) }
}
const results = []
function ok(cond, label, detail = '') {
  results.push({ pass: !!cond, label, detail })
  return !!cond
}
async function waitFor(expr, ms = 6000, step = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(expr)) return true } catch { /* 页面切换中 */ }
    await sleep(step)
  }
  return false
}

/** 真键盘（CDP Input）：合成 KeyboardEvent 的 target 是 window，会绕过真实焦点与捕获顺序，
 *  测不出「菜单 Esc 该不该连带把笔记关掉」这类问题。 */
async function pressEscape() {
  await pressKey('Escape', 'Escape', 27)
}

/** 通用真键盘按下（非文本键；文本用 `Input.insertText`，那才是输入法/打字的真实通路） */
async function pressKey(key, code, vk) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** 右键菜单里某个菜单项的中心点（供真鼠标移动/点击；找不到返回 null） */
async function menuItemPoint(text) {
  return evalJs(`(() => {
    const b = [...document.querySelectorAll('[data-wb="noteContextMenu"] button')].find(x => x.innerText.trim() === ${JSON.stringify(text)})
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
}

/**
 * 把（CDP）指针停到一个不压任何菜单的角落。
 * ★ 子菜单的展开跟随**悬停**（onMouseEnter），而本机物理鼠标停在哪儿是不确定的 ——
 *   菜单正好弹在物理指针下时，浏览器会补发 mouseover，把 openSub 抢到另一项上，
 *   于是「点插入、展开的却是文件格式」这种偶发红（2026-10-11 连踩两次）。
 *   探针每次开菜单前先把指针停走，结果才与物理鼠标位置无关。
 */
async function parkPointer() {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 20 })
  await sleep(150)
}

/** 切档：写设置 + 广播（SettingsContext 只在 'settings-imported' 里重拉，直接写盘不触发重渲染） */
async function setWritingMode(mode) {
  await evalJs(`(async () => {
    try { await window.api.setSetting('editorWritingMode', ${JSON.stringify(mode)}) } catch {}
    window.dispatchEvent(new Event('settings-imported'))
    return true
  })()`)
  await sleep(1200)
}

const JS_STATE = `(() => ({
  monaco: document.querySelectorAll('.monaco-editor').length,
  cm: document.querySelectorAll('.cm-editor').length,
  cmText: (document.querySelector('.cm-content')?.innerText ?? ''),
  cmLines: [...document.querySelectorAll('.cm-line')].map(l => (l.className || '-') + ' :: ' + l.textContent.slice(0, 26)),
  menu: !!document.querySelector('[data-wb="noteContextMenu"]'),
  menuLabels: [...document.querySelectorAll('[data-wb="noteContextMenu"] button')].map(b => b.innerText.trim()),
  h1: document.querySelectorAll('.kb-live-h1').length,
  strong: document.querySelectorAll('.kb-live-strong').length,
  em: document.querySelectorAll('.kb-live-em').length,
  code: document.querySelectorAll('.kb-live-code').length,
  quote: document.querySelectorAll('.kb-live-quote').length,
  task: document.querySelectorAll('.kb-live-task').length,
  table: document.querySelectorAll('.kb-live-table').length,
  katex: document.querySelectorAll('.cm-content .katex').length,
  hr: document.querySelectorAll('.kb-live-hr').length,
  codeblock: document.querySelectorAll('.kb-live-codeblock').length,
  // 代码块渲染态 = 与预览同构的卡片（.kb-md-atom pre）+ highlight.js 着色 + 语言标签
  codeCard: document.querySelectorAll('.cm-content .kb-md-atom pre').length,
  codeLang: document.querySelectorAll('.kb-live-codecard-lang').length,
  hljs: document.querySelectorAll('.cm-content [class*=hljs-]').length,
}))()`

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) p.reject(new Error(JSON.stringify(m.error)))
      else p.resolve(m.result)
      return
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('exception: ' + (m.params?.exceptionDetails?.text ?? '').slice(0, 300))
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')

  // 设置回默认档（探针可能被上一次跑残留的 live 影响）
  await evalJs(`(async () => { try { await window.api.setSetting('editorWritingMode', 'source') } catch {}; window.dispatchEvent(new Event('settings-imported')); return true })()`)
  await sleep(1500)

  // 页面内错误收集器：effect 里抛的异常不会被 React 错误边界捕获，必须从 window 层收
  await evalJs(`(() => {
    window.__probeErrors = []
    const origErr = console.error.bind(console)
    console.error = (...a) => {
      try { window.__probeErrors.push(a.map(x => (x && x.message) ? x.message : String(x)).join(' ').slice(0, 500)) } catch {}
      origErr(...a)
    }
    window.addEventListener('error', (e) => window.__probeErrors.push('window.error: ' + (e.message || e.error?.message || '')))
    window.addEventListener('unhandledrejection', (e) => window.__probeErrors.push('rejection: ' + (e.reason?.message || String(e.reason))))
    return true
  })()`)

  // ---- 打开 fixture 笔记（可复用：切档后模块会重挂，笔记要重新打开）----
  async function openNoteInEdit() {
    await evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
    await sleep(1000)
    await evalJs(`window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: ${JSON.stringify(NOTE_REL)} } }))`)
    await sleep(2500)
    // 知识库默认以阅读态打开 → 点「切换到编辑」
    const clicked = await evalJs(`(() => {
      const b = document.querySelector('button[title^="切换到编辑"]')
      if (!b) return false
      b.click()
      return true
    })()`)
    await waitFor(`!!document.querySelector('.monaco-editor, .cm-editor')`, 9000)
    await sleep(500)
    return clicked
  }

  const clickedEdit = await openNoteInEdit()
  ok(clickedEdit, 'P0 笔记以阅读态打开并点进编辑态', String(clickedEdit))
  const afterEdit = await evalJs(`(() => ({
    monaco: document.querySelectorAll('.monaco-editor').length,
    cm: document.querySelectorAll('.cm-editor').length,
    toolbarPreviewBtn: document.querySelector('button[title^="切换到编辑"], button[title^="切换到预览"]')?.getAttribute('title') ?? null,
    pagebar: !!document.querySelector('[data-wb="pagebar"]'),
  }))()`)
  console.log('[diag] 点编辑后:', JSON.stringify(afterEdit), 'errors=', JSON.stringify(consoleErrors.slice(0, 3)))

  // ---- P1 源码档 ----
  let st = await evalJs(JS_STATE)
  ok(st.monaco >= 1 && st.cm === 0, 'P1 默认源码档 = Monaco 在场、CM6 不在场', JSON.stringify({ monaco: st.monaco, cm: st.cm }))
  await shot('note-surface-01-source')

  // ---- P2 源码档右键菜单 ----
  const rightClickedSource = await evalJs(`(() => {
    const el = document.querySelector('.monaco-editor')
    if (!el) return false
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 40 }))
    return true
  })()`)
  await sleep(500)
  st = await evalJs(JS_STATE)
  ok(rightClickedSource && st.menu, 'P2a 源码档右键弹出应用自己的写作菜单', JSON.stringify(st.menuLabels.slice(0, 6)))
  ok(st.menuLabels.some((l) => l.includes('新增链接')) && st.menuLabels.some((l) => l.includes('文本格式')) && st.menuLabels.some((l) => l.includes('插入')),
    'P2b 菜单含 新增链接 / 文本格式 / 插入', JSON.stringify(st.menuLabels))
  ok(st.menuLabels.some((l) => l.includes('以纯文本形式粘贴')) && st.menuLabels.some((l) => l.includes('全选')),
    'P2c 菜单含 以纯文本形式粘贴 / 全选')
  ok(!st.menuLabels.some((l) => l.includes('新建数据库')), 'P2d 负向：不含「新建数据库」（本项目不做）')
  await shot('note-surface-02-menu-source')
  await pressEscape()
  await sleep(500)
  st = await evalJs(JS_STATE)
  ok(!st.menu, 'P2e Esc 关闭菜单（真键盘；且不连带把笔记关掉）')

  // ---- P3 切即时渲染档 ----
  // ★ 切档**不该关掉笔记**：早先即时渲染档在挂载时崩过一次（跨行替换装饰走 ViewPlugin），
  //   表象正是「设置一改，笔记页没了、中栏空白、工具栏消失」——故这里先断言「切完还在」，
  //   再（幂等地）重新打开一次，保证后续断言有确定的起点。
  await setWritingMode('live')
  await sleep(1500)
  const stillOpen = await evalJs(`(() => ({
    // ★ 用 data-wb 锚点，别按 title 文本找：顶栏改版后标题是「切换到阅读视图」，按旧文案会假红
    toolbar: document.querySelector('[data-wb="noteTopTitle"]')?.textContent ?? null,
    viewToggle: !!document.querySelector('[data-wb="noteTopViewToggle"]'),
    doc: (document.querySelector('.cm-content')?.innerText ?? '').slice(0, 20),
    engine: document.querySelectorAll('.monaco-editor, .cm-editor').length,
    cm: document.querySelectorAll('.cm-editor').length,
    liveHost: document.querySelectorAll('.kb-live-pane').length,
  }))()`)
  ok(stillOpen.toolbar !== null && stillOpen.viewToggle && stillOpen.doc.length > 0,
    'P3z ★ 切档不关笔记：顶栏与正文都还在（模块未被重挂/未崩）', JSON.stringify(stillOpen))
  ok(stillOpen.cm >= 1 && stillOpen.liveHost >= 1, 'P3y ★ 切档后当场就换成即时渲染档（无需重开笔记）', JSON.stringify(stillOpen))
  const reopened = await openNoteInEdit()
  await waitFor(`!!document.querySelector('.cm-editor')`, 10000)
  await sleep(800)
  const liveDiag = await evalJs(`(() => ({
    cm: document.querySelectorAll('.cm-editor').length,
    monaco: document.querySelectorAll('.monaco-editor').length,
    fallback: document.body.innerText.includes('即时渲染档加载中'),
    liveHost: document.querySelectorAll('.kb-live-pane').length,
    previewBtn: document.querySelector('button[title^="切换到编辑"], button[title^="切换到预览"]')?.getAttribute('title') ?? null,
  }))()`)
  const pageErrors = await evalJs(`window.__probeErrors ?? []`)
  console.log('[diag] 切 live 后重开笔记:', JSON.stringify(liveDiag), 'reopened=', reopened, 'errors=', JSON.stringify(pageErrors.slice(0, 4)))
  st = await evalJs(JS_STATE)
  ok(st.cm >= 1, 'P3a 切档后 CM6 在场', JSON.stringify({ cm: st.cm }))
  ok(st.monaco === 0, 'P3b ★ 单写者：同一文件此刻 Monaco 不在场（两引擎不同挂）', JSON.stringify({ monaco: st.monaco }))
  await shot('note-surface-03-live')

  // ---- P4 渲染与标记隐藏 ----
  console.log('[diag] live 逐行:', JSON.stringify(st.cmLines.slice(0, 24)))
  ok(st.h1 >= 1, 'P4a 标题行渲染（.kb-live-h1）', String(st.h1))
  ok(st.strong >= 1 && st.em >= 1 && st.code >= 1, 'P4b 加粗/斜体/行内代码各自上类', JSON.stringify({ s: st.strong, e: st.em, c: st.code }))
  ok(st.quote >= 1, 'P4c 引用行渲染（左条）', String(st.quote))
  ok(st.task === 2, 'P4d 两个复选框渲染成可点的 checkbox', String(st.task))
  ok(st.table >= 1, 'P4e 表格渲染成 <table>（只读渲染）', String(st.table))
  ok(st.katex >= 1, 'P4f 公式经 KaTeX 渲染', String(st.katex))
  // 代码块：2026-10-11 起改为**与预览同构的卡片 widget**（卡片 + highlight.js 着色 + 语言标签），
  // 不再是「给代码行上底色」——那版与阅读态差得远（无边框/无高亮），见 compare-live-vs-preview.mjs。
  ok(st.codeCard >= 1 && st.codeLang >= 1, 'P4g 代码块渲染成卡片 + 语言标签（.kb-md-atom pre）', JSON.stringify({ card: st.codeCard, lang: st.codeLang }))
  ok(st.hljs >= 1, 'P4g2 代码块带 highlight.js 着色 token（与预览同一套配色）', String(st.hljs))
  ok(st.codeblock === 0, 'P4g3 光标不在代码块时不留围栏底色行（整块由卡片取代）', String(st.codeblock))
  ok(!st.cmText.includes('**'), 'P4h ★ 非光标块的行内标记被隐藏（正文看不到 **）', st.cmText.slice(0, 120))
  ok(!st.cmText.includes('| --- |'), 'P4i ★ 表格分隔行被 widget 取代', st.cmText.slice(0, 160))
  // 块级公式在文档下半部，可能落在视口外 → 先滚到底再断言（可见区间只渲染视口内的块）
  await evalJs(`(() => {
    const v = window.__kbLive
    if (v) { v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight; return true }
    const s = document.querySelector('.cm-scroller')
    if (s) s.scrollTop = s.scrollHeight
    return false
  })()`)
  // ★ 等条件成立再断言，别用固定 sleep：视口投递是 rAF 延迟的，冷启动首跑会慢半拍（曾假红一次）
  await waitFor(`(() => { const t = document.querySelector('.cm-content')?.innerText ?? ''; return !t.includes('$$') })()`, 8000)
  const stBottom = await evalJs(JS_STATE)
  console.log('[diag] bottom:', JSON.stringify(await evalJs(`(() => {
    const s = document.querySelector('.cm-scroller')
    return {
      scrollTop: s ? Math.round(s.scrollTop) : null,
      scrollHeight: s ? s.scrollHeight : null,
      katex: document.querySelectorAll('.cm-content .katex').length,
      codeCard: document.querySelectorAll('.cm-content .kb-md-atom pre').length,
      head: window.__kbLive?.state?.selection?.main?.head,
    }
  })()`)))
  ok(!stBottom.cmText.includes('$$'), 'P4j ★ 块级公式标记被 widget 取代（滚到底后可见区间重算）', stBottom.cmText.slice(-160))
  ok(stBottom.katex >= 2, 'P4k 行内 + 块级公式都渲染（滚动后重算装饰）', String(stBottom.katex))

  // ---- P5 光标所在块回源码 ----
  // 先滚回顶部（上一步为了看块级公式滚到了底部；行元素虽在 DOM 里，但视口外的坐标点不落位）
  await evalJs(`(() => { const s = document.querySelector('.cm-scroller'); if (s) s.scrollTop = 0; return true })()`)
  await sleep(700)
  // 点进「这是**加粗**与…」那一行：该行的 ** 必须重新可见
  const wentToBold = await evalJs(`(() => {
    const el = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.includes('加粗'))
    if (!el) return false
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 6, clientY: r.top + r.height / 2 }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 6, clientY: r.top + r.height / 2 }))
    return true
  })()`)
  await sleep(600)
  st = await evalJs(JS_STATE)
  ok(wentToBold && st.cmText.includes('**'), 'P5 ★ 光标进入该块后回源码（标记重新可见，可编辑）', st.cmText.slice(0, 160))
  await shot('note-surface-04-live-source-block')

  // ---- P5b 代码块同一套语义：点进去回源码（围栏重新可见），移开再变回卡片 ----
  const wentToCode = await evalJs(`(() => {
    const el = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.includes('const a = 1'))
    if (!el) return false
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 6, clientY: r.top + r.height / 2 }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 6, clientY: r.top + r.height / 2 }))
    return true
  })()`)
  await sleep(600)
  const stCode = await evalJs(JS_STATE)
  ok(wentToCode && stCode.codeblock >= 1 && stCode.cmText.includes('```'),
    'P5b ★ 光标进入代码块后回源码（围栏 ``` 重新可见）', JSON.stringify({ block: stCode.codeblock, hasFence: stCode.cmText.includes('```') }))
  // 移开光标（点回加粗那一行）→ 卡片回来
  await evalJs(`(() => {
    const el = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.includes('加粗'))
    if (!el) return false
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 6, clientY: r.top + r.height / 2 }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 6, clientY: r.top + r.height / 2 }))
    return true
  })()`)
  await sleep(600)
  const stBack = await evalJs(JS_STATE)
  ok(stBack.codeCard >= 1 && stBack.codeblock === 0, 'P5c 光标移开后代码块变回卡片', JSON.stringify({ card: stBack.codeCard, block: stBack.codeblock }))

  // ---- P5d 查找面板：真键盘 Ctrl+F 打开、Esc 关闭（源码档 Monaco 的 find widget 对齐项）----
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, modifiers: 2 })
  const searchOpened = await waitFor(`!!document.querySelector('.cm-panel.cm-search')`, 4000)
  const searchInputFocused = await evalJs(`document.activeElement === document.querySelector('.cm-panel.cm-search input[name=search]')`)
  ok(searchOpened, 'P5d ★ 即时渲染档 Ctrl+F 打开查找面板（.cm-panel.cm-search）', String(searchOpened))
  ok(searchInputFocused, 'P5d2 打开后焦点落在查找输入框（可直接打字）', String(searchInputFocused))
  await pressEscape()
  const searchClosed = await waitFor(`!document.querySelector('.cm-panel.cm-search')`, 4000)
  ok(searchClosed, 'P5d3 Esc 关闭查找面板', String(searchClosed))

  // ---- P6 即时渲染档右键 + 真插入一条分隔线 ----
  await parkPointer()
  await evalJs(`(() => {
    const el = document.querySelector('.cm-content')
    if (!el) return false
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 40 }))
    return true
  })()`)
  await sleep(500)
  st = await evalJs(JS_STATE)
  ok(st.menu, 'P6a 即时渲染档右键同样弹出写作菜单', JSON.stringify(st.menuLabels.slice(0, 5)))
  // 展开「插入」子菜单 → 点「分隔线」：走**真鼠标**（悬停展开 + 真点击），见 P8h 的说明
  const insertPt6 = await menuItemPoint('插入')
  if (insertPt6) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: insertPt6.x, y: insertPt6.y }); await sleep(400) }
  const docBeforeHr = await evalJs(`window.__kbLive?.state.doc.toString() ?? '(无钩子)'`)
  const hrPt = await menuItemPoint('分隔线')
  if (hrPt) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hrPt.x, y: hrPt.y })
    await sleep(200)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hrPt.x, y: hrPt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hrPt.x, y: hrPt.y, button: 'left', clickCount: 1 })
  }
  await sleep(900)
  const clickedHr = !!hrPt
  const docAfterHr = await evalJs(`window.__kbLive?.state.doc.toString() ?? '(无钩子)'`)
  console.log('[diag] 分隔线动作前后文档:', JSON.stringify({ beforeTail: docBeforeHr.slice(-60), afterTail: docAfterHr.slice(-60), grew: docAfterHr.length - docBeforeHr.length }))
  // 插入后光标就在那条 `---` 上（该行按规则回源码），把光标挪走再看 widget
  await evalJs(`(() => {
    const el = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.includes('一级标题'))
    if (!el) return false
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 6, clientY: r.top + r.height / 2 }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 6, clientY: r.top + r.height / 2 }))
    return true
  })()`)
  await sleep(700)
  const hrDiag = await evalJs(`(() => ({
    doc: (window.__kbLive?.state.doc.toString() ?? '').replace(/\\n/g, '⏎'),
    lines: [...document.querySelectorAll('.cm-line')].map((l, i) => i + '[' + (l.className.replace('cm-line','').trim() || '-') + ']' + l.textContent.slice(0, 18)),
    hr: document.querySelectorAll('.kb-live-hr').length,
    errors: (window.__probeErrors ?? []).slice(0, 3),
  }))()`)
  console.log('[diag] 插分隔线后:', JSON.stringify(hrDiag))
  st = await evalJs(JS_STATE)
  ok(clickedHr, 'P6b 子菜单可展开并点到「分隔线」')
  ok(st.hr >= 1, 'P6c ★ 菜单动作真的落进文档并渲染成分隔线（菜单 → 动作表 → 引擎 → 装饰 全链路通）', String(st.hr))
  await shot('note-surface-05-live-insert-hr')
  // 撤销，别把 fixture 弄脏（也顺带验撤销栈可用）
  await evalJs(`(() => {
    const el = document.querySelector('.cm-content')
    if (!el) return false
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
    return true
  })()`)
  await sleep(500)

  // ---- P8 表格：渲染态就地编辑（对齐 Obsidian；2026-10-11 反馈后改）----
  // 要证：① 真点单元格能把焦点交给它（contentEditable 生效）；② 打字**写回源文本**；
  //       ③ 打字期间 DOM 不被重建（焦点不丢）；④ Tab 换格、Esc 退出；⑤ 格内 Ctrl+Z 走 CM6 撤销；
  //       ⑥ 「插入 → 表格」后焦点直接进首格。
  const cellRect = await evalJs(`(() => {
    const c = document.querySelector('.kb-live-table td[data-row="2"][data-col="0"]')
    if (!c) return null
    c.scrollIntoView({ block: 'center' })
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: c.textContent }
  })()`)
  if (cellRect) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cellRect.x, y: cellRect.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cellRect.x, y: cellRect.y, button: 'left', clickCount: 1 })
  }
  await sleep(400)
  const cellFocus = await evalJs(`(() => {
    const a = document.activeElement
    return { tag: a?.tagName ?? null, ce: a?.getAttribute?.('contenteditable') ?? null, row: a?.dataset?.row ?? null, col: a?.dataset?.col ?? null }
  })()`)
  ok(cellRect && cellFocus.ce === 'true' && cellFocus.row === '2' && cellFocus.col === '0',
    'P8a ★ 真点单元格 = 焦点进格且 contentEditable 生效（渲染表里能编辑）', JSON.stringify(cellFocus))

  await send('Input.insertText', { text: '九' })
  await sleep(500)
  const typed = await evalJs(`(() => ({
    doc: window.__kbLive?.state.doc.toString() ?? '',
    cell: document.querySelector('.kb-live-table td[data-row="2"][data-col="0"]')?.textContent ?? null,
    focused: document.activeElement?.dataset?.row === '2' && document.activeElement?.dataset?.col === '0',
  }))()`)
  ok(/1九|九1/.test(typed.doc), 'P8b ★ 格内打字写回源文本（管道符语法没让用户碰）', JSON.stringify(typed.doc.split('\n').slice(-6)))
  ok(/1九|九1/.test(typed.cell ?? ''), 'P8c 格内 DOM 同步显示（不是只改了源）', String(typed.cell))
  ok(typed.focused, 'P8d ★ 打字期间 DOM 没被重建（焦点仍在同一格 = 光标与输入法不丢）')

  await pressKey('Tab', 'Tab', 9)
  await sleep(400)
  const afterTab = await evalJs(`(() => {
    const a = document.activeElement
    return { row: a?.dataset?.row ?? null, col: a?.dataset?.col ?? null, text: a?.textContent ?? null }
  })()`)
  ok(afterTab.col === '1' && afterTab.row === '2', 'P8e Tab 换到下一格（同层右移）', JSON.stringify(afterTab))

  await pressEscape()
  await sleep(400)
  const afterEsc = await evalJs(`(() => ({ tag: document.activeElement?.tagName ?? null, cell: document.activeElement?.dataset?.row ?? null }))()`)
  ok(afterEsc.cell == null, 'P8f Esc 退出单元格（焦点还给编辑器）', JSON.stringify(afterEsc))

  // 格内 Ctrl+Z → CM6 撤销（原生 contenteditable 撤销改的是 DOM，会与源脱钩）
  const backToCell = await evalJs(`(() => {
    const c = document.querySelector('.kb-live-table td[data-row="2"][data-col="0"]')
    if (!c) return false
    c.focus()
    return document.activeElement === c
  })()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 })
  await sleep(600)
  const undone = await evalJs(`window.__kbLive?.state.doc.toString() ?? ''`)
  ok(backToCell && !/九/.test(undone), 'P8g 格内 Ctrl+Z 走 CM6 撤销（源文本回退，不与 DOM 脱钩）', JSON.stringify(undone.split('\n').slice(-6)))

  // ---- P8h 插入 → 表格：插完焦点直接进首格（对齐 Obsidian「插完就能打字」）----
  // 走**真鼠标**（移到「插入」→ 子菜单展开 → 移到「表格」→ 点击）：程序化 .click() 会绕开
  // 悬停展开这条真实路径，也会被「鼠标停在哪」影响（首版就因此偶发红）。
  const tablesBefore = await evalJs(`document.querySelectorAll('.kb-live-table').length`)
  await parkPointer()
  await evalJs(`(() => {
    const el = document.querySelector('.cm-content')
    if (!el) return false
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 40 }))
    return true
  })()`)
  await sleep(450)
  const insertPt = await menuItemPoint('插入')
  if (insertPt) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: insertPt.x, y: insertPt.y })
    await sleep(350)
  }
  const tablePt = await menuItemPoint('表格')
  if (tablePt) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tablePt.x, y: tablePt.y })
    await sleep(250)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tablePt.x, y: tablePt.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tablePt.x, y: tablePt.y, button: 'left', clickCount: 1 })
  }
  await sleep(900)
  const inserted = await evalJs(`(() => {
    const a = document.activeElement
    return {
      tables: document.querySelectorAll('.kb-live-table').length,
      menuOpen: !!document.querySelector('[data-wb="noteContextMenu"]'),
      ce: a?.getAttribute?.('contenteditable') ?? null,
      row: a?.dataset?.row ?? null, col: a?.dataset?.col ?? null, text: a?.textContent ?? null,
    }
  })()`)
  console.log('[diag] 插入表格后:', JSON.stringify({ insertPt, tablePt, ...inserted }))
  ok(!!insertPt && !!tablePt && inserted.tables === tablesBefore + 1,
    'P8h ★ 菜单「插入 → 表格」真的落进文档并渲染成表', JSON.stringify({ before: tablesBefore, after: inserted.tables, insertPt: !!insertPt, tablePt: !!tablePt }))
  ok(inserted.ce === 'true' && inserted.row === '0' && inserted.col === '0', 'P8i ★ 插完焦点直接进首格（不用再点一下）', JSON.stringify({ ce: inserted.ce, row: inserted.row, col: inserted.col, text: inserted.text }))
  await shot('note-surface-07-table-edit')
  // 撤掉这张表，别把 fixture 弄脏（顺带再走一遍格内 Ctrl+Z 通路）
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 })
  await sleep(600)
  const tablesAfterUndo = await evalJs(`document.querySelectorAll('.kb-live-table').length`)
  ok(tablesAfterUndo === tablesBefore, 'P8j 撤销后表格回到原状（fixture 不留脏数据）', JSON.stringify({ after: tablesAfterUndo }))

  // ---- P7 切回源码档 ----
  await setWritingMode('source')
  await waitFor(`!!document.querySelector('.monaco-editor')`, 10000)
  await sleep(600)
  st = await evalJs(JS_STATE)
  ok(st.monaco >= 1 && st.cm === 0, 'P7 切回源码档 = Monaco 回来、CM6 退场（来回切不残留）', JSON.stringify({ monaco: st.monaco, cm: st.cm }))
  await shot('note-surface-06-back-to-source')

  // ---- P9 console ----
  ok(consoleErrors.length === 0, 'P9 console 零 error', consoleErrors.slice(0, 3).join(' | '))

  // 结果
  const failed = results.filter((r) => !r.pass)
  console.log('\n===== 双写作面探针 =====')
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '  -> ' + r.detail : ''}`)
  console.log(`\n${results.length - failed.length} PASS / ${failed.length} FAIL`)
  ws.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('探针异常:', e)
  // 异常也要把已收集的断言打出来（否则只看到一句异常，不知道走到哪一步）
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '  -> ' + r.detail : ''}`)
  console.error('consoleErrors:', JSON.stringify(consoleErrors.slice(0, 8)))
  process.exit(1)
})
