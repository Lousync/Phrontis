/**
 * 排版一致性探针：**即时渲染档 vs 预览（阅读态）** —— 同一篇笔记、逐元素断言两边样式相等。
 *
 * 为什么需要它：两侧是两套渲染器（CM6 装饰 + `.kb-live-*` / react-markdown + `.prose-content`），
 * 数值一旦分头维护就会悄悄漂移。2026-10-11 首轮实测抓到：基准字号 13 vs 16、H1 无/有下划线、
 * 代码块无/有语法高亮、表格宽度与表头底色不同、行内代码底色不同、链接下划线相反……
 * 治理办法是「共享排版令牌（`--md-*`）+ 共用原子作用域（`.kb-md-atom`）」，**由本脚本锁住结果**。
 *
 * 断言口径：把两边**同一批 computedStyle**逐项比对（字号/字重/行高/边框/底色/圆角/内边距/颜色），
 * 不等即 FAIL。少数差异是**有意的**，列在 EXEMPT 里并注明理由（例如任务复选框：编辑态要能点、阅读态不能点）。
 *
 * 用法（隔离实例，不动用户 dev 数据；必须先 build，跑的是 out/ 产物）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --ud "knowbase (dev probe-app)"
 *   node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs \
 *     .AGENT/scripts/notes-surface/compare-live-vs-preview.mjs
 *
 * 产出：tmp/probe-shots/cmp-{live,preview}-{top,bottom}.png 与 cmp-styles.json（人工复核用）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9333)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SHOT_DIR = join(ROOT, 'tmp', 'probe-shots')
const NOTE_REL = '写作面对比.md'

let fails = 0
let passes = 0
function ok(cond, label, detail = '') {
  if (cond) { passes++; console.log(`  PASS ${label}`) }
  else { fails++; console.error(`  FAIL ${label}${detail ? ' -- ' + detail : ''}`) }
}

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
async function waitFor(expr, ms = 8000, step = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(expr)) return true } catch { /* 页面切换中 */ }
    await sleep(step)
  }
  return false
}

/** 两边共用的取样式属性集（口径一致，差异才有可比性） */
const PROPS = [
  'fontSize', 'fontWeight', 'fontStyle', 'color', 'lineHeight',
  'marginTop', 'marginBottom', 'paddingTop', 'paddingBottom', 'paddingLeft',
  'borderBottomWidth', 'borderBottomColor', 'borderBottomStyle',
  'borderLeftWidth', 'borderLeftColor', 'borderLeftStyle',
  'borderTopWidth', 'borderTopColor',
  'backgroundColor', 'borderRadius', 'fontFamily', 'textDecorationLine',
  'listStyleType', 'textAlign', 'borderCollapse', 'boxShadow', 'width', 'maxWidth',
]

/**
 * 取一次全量快照。档位由调用方**显式传入**：PageEditor 的编辑区是保活结构，切到预览时
 * `.cm-editor` 仍在 DOM 里（只是被隐藏），用「谁在场」判档位会把预览读成 live（首轮踩过）。
 */
const snapFor = (mode) => `(() => {
  const live = ${JSON.stringify(mode)} === 'live'
  const cs = (el) => {
    if (!el) return null
    const c = getComputedStyle(el)
    const o = {}
    for (const p of ${JSON.stringify(PROPS)}) o[p] = c[p]
    const r = el.getBoundingClientRect()
    o._w = Math.round(r.width); o._h = Math.round(r.height)
    o._text = (el.textContent || '').trim().slice(0, 20)
    return o
  }
  const byText = (sel, t) => [...document.querySelectorAll(sel)].find(e => (e.textContent || '').includes(t)) || null
  /** 取**最后一个**文本命中：阅读态的嵌套 li 会把子项文字也算进父 li 的 textContent */
  const byTextLast = (sel, t) => {
    const all = [...document.querySelectorAll(sel)].filter(e => (e.textContent || '').includes(t))
    return all.length ? all[all.length - 1] : null
  }
  const q = (s) => document.querySelector(s)
  const prose = q('.prose-content')
  const base = cs(live ? q('.cm-content') : prose)
  const scroller = live ? q('.cm-scroller') : (prose?.closest('.overflow-y-auto') ?? prose?.parentElement)
  const taskLi = [...document.querySelectorAll('.prose-content li')].find(l => l.querySelector('input[type=checkbox]'))
  const taskLine = [...document.querySelectorAll('.cm-line')].find(l => (l.textContent || '').includes('待办一'))
  const bullets = [...document.querySelectorAll('.kb-live-bullet')].map(b => b.textContent)
  const firstHljs = (live ? q('.cm-content') : prose)?.querySelector('[class*=hljs-]')
  // 「相对缩进」= 列表内容相对**普通段落**的缩进量。两侧量法不同（编辑器看 padding-left，
  // 阅读态看真实文本左边界），但表达的是同一件事，故可直接比对。
  const textLeft = (el) => {
    if (!el) return null
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      if ((n.nodeValue || '').trim()) {
        const r = document.createRange(); r.selectNodeContents(n)
        const b = r.getBoundingClientRect()
        if (b.width > 0) return Math.round(b.left)
      }
    }
    return null
  }
  const paraEl = live ? byText('.cm-line', '普通段落') : byText('.prose-content p', '普通段落')
  const relIndent = (el) => {
    if (!el || !paraEl) return null
    if (live) return Math.round(parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(paraEl).paddingLeft))
    const a = textLeft(el); const b = textLeft(paraEl)
    return (a == null || b == null) ? null : a - b
  }
  const liEl0 = live ? byText('.cm-line', '无序一') : byText('.prose-content li', '无序一')
  const liEl1 = live ? byText('.cm-line', '嵌套一项') : byTextLast('.prose-content li', '嵌套一项')
  const imgEl = live ? q('.kb-live-img img') : q('.prose-content img')
  return {
    live,
    dpr: window.devicePixelRatio,
    docHeight: scroller ? scroller.scrollHeight : null,
    base: { fontSize: base?.fontSize, fontFamily: base?.fontFamily, lineHeight: base?.lineHeight, color: base?.color },
    h1: cs(live ? q('.cm-line.kb-live-h1') : q('.prose-content h1')),
    h2: cs(live ? q('.cm-line.kb-live-h2') : q('.prose-content h2')),
    h3: cs(live ? q('.cm-line.kb-live-h3') : q('.prose-content h3')),
    h4: cs(live ? q('.cm-line.kb-live-h4') : q('.prose-content h4')),
    h5: cs(live ? q('.cm-line.kb-live-h5') : q('.prose-content h5')),
    h6: cs(live ? q('.cm-line.kb-live-h6') : q('.prose-content h6')),
    p: cs(live ? byText('.cm-line', '普通段落') : byText('.prose-content p', '普通段落')),
    strong: cs(live ? q('.kb-live-strong') : q('.prose-content strong')),
    em: cs(live ? q('.kb-live-em') : q('.prose-content em')),
    del: cs(live ? q('.kb-live-strike') : q('.prose-content del')),
    code: cs(live ? q('.kb-live-code') : q('.prose-content code')),
    link: cs(live ? q('.kb-live-link') : q('.prose-content a')),
    quote: cs(live ? q('.cm-line.kb-live-quote') : q('.prose-content blockquote')),
    table: cs(live ? q('.kb-live-table-wrap table') : q('.prose-content table')),
    th: cs(live ? q('.kb-live-table-wrap th') : q('.prose-content th')),
    pre: cs(live ? q('.kb-md-atom pre') : q('.prose-content pre')),
    preCode: cs(live ? q('.kb-md-atom pre code') : q('.prose-content pre code')),
    katex: cs(live ? q('.cm-content .katex') : q('.prose-content .katex')),
    hr: cs(live ? q('.kb-live-hr') : q('.prose-content hr')),
    liLine: cs(live ? q('.cm-line.kb-live-li') : q('.prose-content li')),
    img: cs(imgEl),
    imgLoaded: imgEl ? (imgEl.complete && imgEl.naturalWidth > 0) : null,
    relIndent0: relIndent(liEl0),
    relIndent1: relIndent(liEl1),
    langTag: (live ? q('.kb-live-codecard-lang') : null)?.textContent ?? null,
    previewLangTag: (prose?.querySelector('pre')?.querySelector('span') ?? null)?.textContent ?? null,
    hljsColor: firstHljs ? getComputedStyle(firstHljs).color : null,
    hljsCount: (live ? q('.cm-content') : prose)?.querySelectorAll('[class*=hljs-]').length ?? 0,
    bullets,
    taskLiListStyle: taskLi ? getComputedStyle(taskLi).listStyleType : null,
    taskLineText: taskLine ? (taskLine.textContent || '').trim() : null,
    nestedUlStyle: q('.prose-content ul ul') ? getComputedStyle(q('.prose-content ul ul')).listStyleType : null,
    pageTitleH1: !!prose?.parentElement?.querySelector('h1.text-xl'),
    // 诊断：快照时刻的光标与渲染态（写进 JSON，便于判断「某块为什么显示成源码」）
    selHead: live ? (window.__kbLive?.state?.selection?.main?.head ?? null) : null,
    mathBlocks: (live ? q('.cm-content') : prose)?.querySelectorAll('.kb-live-math-block').length ?? 0,
    mathInline: (live ? q('.cm-content') : prose)?.querySelectorAll('.kb-live-math:not(.kb-live-math-block)').length ?? 0,
    // 判「公式真的渲染了」只看**可见行里还有没有 $$ 围栏** —— 不能用 textContent 找 TeX 源码：
    // KaTeX 会同时输出 MathML，其 <annotation> 里本来就带着原始 TeX（首轮误判过一次）。
    rawMathFence: live ? [...document.querySelectorAll('.cm-line')].some((l) => (l.textContent || '').includes('$$')) : false,
  }
})()`

/** 逐项比对表：[标签, 取值函数]；两边取值不等即 FAIL */
const CHECKS = [
  ['基准字号', (s) => s.base?.fontSize],
  ['基准字体', (s) => s.base?.fontFamily],
  ['H1 字号', (s) => s.h1?.fontSize], ['H1 字重', (s) => s.h1?.fontWeight], ['H1 下划线', (s) => s.h1?.borderBottomWidth],
  ['H2 字号', (s) => s.h2?.fontSize], ['H2 下划线', (s) => s.h2?.borderBottomWidth],
  ['H3 字号', (s) => s.h3?.fontSize],
  ['H4 字号', (s) => s.h4?.fontSize], ['H4 字重', (s) => s.h4?.fontWeight],
  ['H5 字号', (s) => s.h5?.fontSize],
  ['H6 字号', (s) => s.h6?.fontSize], ['H6 颜色', (s) => s.h6?.color],
  ['标题行高', (s) => s.h1?.lineHeight],
  ['段落字号', (s) => s.p?.fontSize], ['段落行高', (s) => s.p?.lineHeight],
  ['加粗字重', (s) => s.strong?.fontWeight],
  ['斜体颜色', (s) => s.em?.color], ['斜体样式', (s) => s.em?.fontStyle],
  ['删除线颜色', (s) => s.del?.color], ['删除线样式', (s) => s.del?.textDecorationLine],
  ['行内代码底色', (s) => s.code?.backgroundColor],
  ['行内代码圆角', (s) => s.code?.borderRadius],
  ['行内代码字号', (s) => s.code?.fontSize],
  ['行内代码内边距', (s) => s.code?.paddingLeft],
  ['行内代码字体', (s) => s.code?.fontFamily],
  ['链接颜色', (s) => s.link?.color], ['链接下划线', (s) => s.link?.textDecorationLine],
  ['引用条宽', (s) => s.quote?.borderLeftWidth], ['引用条色', (s) => s.quote?.borderLeftColor],
  ['引用左内边距', (s) => s.quote?.paddingLeft], ['引用文字色', (s) => s.quote?.color],
  ['引用行高', (s) => s.quote?.lineHeight], ['列表行高', (s) => s.liLine?.lineHeight],
  ['图片圆角', (s) => s.img?.borderRadius], ['图片最大宽', (s) => s.img?.maxWidth],
  ['图片外边距', (s) => s.img?.marginTop],
  ['表格边框合并', (s) => s.table?.borderCollapse], ['表格字号', (s) => s.table?.fontSize],
  ['表头底色', (s) => s.th?.backgroundColor], ['表头内边距', (s) => s.th?.paddingTop],
  ['代码卡底色', (s) => s.pre?.backgroundColor], ['代码卡圆角', (s) => s.pre?.borderRadius],
  ['代码卡内边距', (s) => s.pre?.paddingTop], ['代码卡边框', (s) => s.pre?.borderTopWidth],
  ['代码卡阴影', (s) => s.pre?.boxShadow], ['代码卡内 code 底色', (s) => s.preCode?.backgroundColor],
  ['代码高亮色', (s) => s.hljsColor],
  ['公式字号', (s) => s.katex?.fontSize],
  ['分隔线颜色', (s) => s.hr?.borderTopColor],
]

/** 有意保留的差异（不是漂移，写在这里防被误当 bug 回改） */
const EXEMPT = [
  ['任务复选框可点性', '编辑态可点（勾选写回正文）/ 阅读态 pointer-events:none —— 有意'],
  ['预览顶部页面标题', '阅读态额外渲染页面标题 h1，编辑态标题在页面条上 —— 有意'],
  ['文档总高度', '编辑器必须显示空行（可点到、可输入），阅读态空行折叠成段间距 —— 有意'],
  ['列表缩进的 ±2px', '两侧量法不同（编辑器量 padding、阅读态量文本左边界），容差 2px —— 有意'],
]

/** 把当前档位的滚动容器拨到顶/底（CM6 是 .cm-scroller，预览是外层 overflow-y-auto） */
async function scrollTo(mode, where) {
  const js = mode === 'live'
    ? `(() => { const s = document.querySelector('.cm-scroller'); if (s) s.scrollTop = ${where === 'top' ? 0 : 's.scrollHeight'}; return s ? s.scrollTop : -1 })()`
    : `(() => { const p = document.querySelector('.prose-content'); const s = p && p.closest('.overflow-y-auto'); if (s) s.scrollTop = ${where === 'top' ? 0 : 's.scrollHeight'}; return s ? s.scrollTop : -1 })()`
  const v = await evalJs(js)
  await sleep(500)
  return v
}

/**
 * 把块级公式滚进视口（**不动光标** —— 动光标会让该块按「回源码」规则显示，就验不到渲染了）。
 * 用 CM6 自己的高度表算目标位置：`lineBlockAt(公式起点).top`，比按比例瞎滚可靠。
 */
async function scrollToMath() {
  const moved = await evalJs(`(() => {
    const v = window.__kbLive
    if (!v) return false
    const idx = v.state.doc.toString().indexOf('\\\\int_0^1')
    if (idx < 0) return false
    const block = v.lineBlockAt(idx)
    v.scrollDOM.scrollTop = Math.max(0, block.top - 60)
    return true
  })()`)
  const shown = await waitFor(`document.querySelectorAll('.cm-content .kb-live-math-block').length >= 1`, 6000)
  await sleep(300)
  return moved && shown
}

/** 数值型样式容差 0.5px：编辑器侧的 computed 值是**设备像素对齐后的 used 值**（DPR 1.5 下
 *  1px → 0.667px、3px → 2.667px），与阅读态同一份 CSS 却读出差值 —— 环境差异，不是样式差异。 */
const asNum = (v) => {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && /^-?[\d.]+px$/.test(v)) return parseFloat(v)
  return null
}
const sameStyle = (a, b) => {
  const na = asNum(a); const nb = asNum(b)
  if (na != null && nb != null) return Math.abs(na - nb) <= 0.5
  return a === b
}
/** 取第一个非空值：CM6 只装饰视口内的块，单张快照覆盖不全 → 顶/底两张合起来看 */
const firstOf = (snaps, get) => {
  for (const s of snaps) { const v = get(s); if (v != null) return v }
  return null
}

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

  async function openNoteInEdit() {
    await evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
    await sleep(1000)
    await evalJs(`window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: ${JSON.stringify(NOTE_REL)} } }))`)
    await sleep(2500)
    await evalJs(`(() => { const b = document.querySelector('button[title^="切换到编辑"]'); if (b) b.click(); return true })()`)
    await waitFor(`!!document.querySelector('.monaco-editor, .cm-editor')`, 9000)
    await sleep(600)
  }
  async function setWritingMode(mode) {
    await evalJs(`(async () => {
      try { await window.api.setSetting('editorWritingMode', ${JSON.stringify(mode)}) } catch {}
      window.dispatchEvent(new Event('settings-imported'))
      return true
    })()`)
    await sleep(1200)
  }

  await setWritingMode('source')
  await openNoteInEdit()

  // ---- 即时渲染档 ----
  await setWritingMode('live')
  await openNoteInEdit()
  const liveOk = await waitFor(`!!document.querySelector('.cm-editor')`, 9000)
  await sleep(1400)
  await scrollTo('live', 'top')
  await sleep(800)
  const liveShotTop = await shot('cmp-live-top')
  const liveSnap = await evalJs(snapFor('live'))
  await scrollTo('live', 'bottom')
  await sleep(1200)
  const liveShot = await shot('cmp-live-bottom')
  const liveBottom = await evalJs(snapFor('live'))
  // 块级公式在文档中段：单独滚到它再断言「视口内必须真的渲染」
  const mathShown = await scrollToMath()
  const liveMath = await evalJs(snapFor('live'))

  // ---- 同篇的预览（阅读态）----
  const toPreview = await evalJs(`(() => {
    const b = document.querySelector('button[title^="切换到预览"]')
    if (!b) return false
    b.click(); return true
  })()`)
  const prevOk = await waitFor(`!!document.querySelector('.prose-content')`, 8000)
  await sleep(1400)
  await scrollTo('preview', 'top')
  await sleep(800)
  const prevShotTop = await shot('cmp-preview-top')
  const prevSnap = await evalJs(snapFor('preview'))
  await scrollTo('preview', 'bottom')
  await sleep(1200)
  const prevShot = await shot('cmp-preview-bottom')
  const prevBottom = await evalJs(snapFor('preview'))

  mkdirSync(SHOT_DIR, { recursive: true })
  writeFileSync(join(SHOT_DIR, 'cmp-styles.json'),
    JSON.stringify({ live: liveSnap, preview: prevSnap, liveBottom, liveMath, previewBottom: prevBottom }, null, 2), 'utf8')

  console.log('\nS1 两侧都在场')
  ok(liveOk && liveSnap?.live === true, '即时渲染档：CM6 在场', String(liveSnap?.live))
  ok(toPreview && prevOk && prevSnap?.live === false, '预览：prose-content 在场且档位判定正确', String(prevSnap?.live))
  console.log(`  [diag] live 光标 head=${liveSnap?.selHead} DPR=${liveSnap?.dpr}`)

  console.log('\nS2 逐项排版一致（computedStyle 比对；数值容差 0.5px = 设备像素对齐）')
  for (const [label, get] of CHECKS) {
    // 顶/底两张快照取并集：CM6 只装饰视口内的块，单张覆盖不全（hr / 代码卡 / 公式在下方）
    const a = firstOf([liveSnap, liveBottom, liveMath], get)
    const b = firstOf([prevSnap, prevBottom], get)
    ok(a != null && sameStyle(a, b), label, `即时渲染=${a} / 预览=${b}`)
  }

  console.log('\nS3 代码块：卡片结构 + 语法高亮（预览有的写作面也得有）')
  ok(liveSnap?.hljsCount > 0, '即时渲染档代码块有 highlight.js 着色 token', `token=${liveSnap?.hljsCount}`)
  ok(liveSnap?.langTag === 'js', '即时渲染档代码卡显示语言标签', String(liveSnap?.langTag))
  ok(prevSnap?.hljsCount > 0 && prevSnap?.previewLangTag === 'js', '预览侧同样有着色与语言标签',
    JSON.stringify({ n: prevSnap?.hljsCount, tag: prevSnap?.previewLangTag }))

  console.log('\nS3b 视口内必须真的渲染（滚到块级公式时不许留源码）')
  console.log(`  [diag] math: 滚到位=${mathShown} 块公式=${liveMath?.mathBlocks} 行内公式=${liveMath?.mathInline} 残留围栏=${liveMath?.rawMathFence}`)
  ok(mathShown && liveMath?.mathBlocks >= 1, '块级公式在视口内时渲染为公式（不是 $$ 源码）', `渲染数=${liveMath?.mathBlocks}`)
  ok(liveMath?.rawMathFence === false, '可见行里不残留 $$ 围栏', String(liveMath?.rawMathFence))

  console.log('\nS4 列表：标记 / 重编号 / 缩进 / 任务行')
  const bulletsLive = firstOf([liveSnap, liveBottom, liveMath], (s) => s.bullets?.length ? s.bullets : null)
  ok(JSON.stringify(bulletsLive) === JSON.stringify(['•', '•', '○', '1.', '2.', 'a.']),
    '即时渲染档：无序按层换标记（• / ○）+ 有序重编号并按层换 a.', JSON.stringify(bulletsLive))
  ok(prevSnap?.nestedUlStyle === 'circle', '预览侧嵌套无序为 circle（与写作面同层同形）', String(prevSnap?.nestedUlStyle))
  const taskText = firstOf([liveSnap, liveBottom, liveMath], (s) => s.taskLineText)
  ok(taskText != null && !/[•\-*]/.test(taskText.slice(0, 2)),
    '任务行不再画项目符号（修「• ☐ 文本」双标记）', String(taskText))
  ok(prevSnap?.taskLiListStyle === 'none', '预览侧任务 li 同样去掉项目符号', String(prevSnap?.taskLiListStyle))
  const r0l = firstOf([liveSnap, liveBottom, liveMath], (s) => s.relIndent0)
  const r0p = firstOf([prevSnap, prevBottom], (s) => s.relIndent0)
  const r1l = firstOf([liveSnap, liveBottom, liveMath], (s) => s.relIndent1)
  const r1p = firstOf([prevSnap, prevBottom], (s) => s.relIndent1)
  console.log(`  [diag] 相对段落缩进: live=${r0l}/${r1l}  prev=${r0p}/${r1p}`)
  ok(r0l != null && r0p != null && Math.abs(r0l - r0p) <= 2,
    '顶层列表相对段落的缩进与阅读态一致（±2px）', `live=${r0l} prev=${r0p}`)
  ok(r1l != null && r1p != null && Math.abs(r1l - r1p) <= 2,
    '嵌套列表相对段落的缩进与阅读态一致（±2px）', `live=${r1l} prev=${r1p}`)

  console.log('\nS4b 图片')
  const imgL = firstOf([liveSnap, liveBottom, liveMath], (s) => s.imgLoaded)
  const imgP = firstOf([prevSnap, prevBottom], (s) => s.imgLoaded)
  ok(imgL === true && imgP === true, '两侧图片都真的加载出来（naturalWidth > 0）', JSON.stringify({ live: imgL, prev: imgP }))

  console.log('\nS5 运行时零错误')
  ok(consoleErrors.length === 0, 'console 无 error / 无未捕获异常', JSON.stringify(consoleErrors.slice(0, 3)))

  console.log('\nS6 有意保留的差异（不计入失败）')
  for (const [k, why] of EXEMPT) console.log(`  NOTE ${k}：${why}`)

  console.log(`\n截图：${liveShotTop} / ${liveShot}\n      ${prevShotTop} / ${prevShot}`)
  console.log(`JSON：${join(SHOT_DIR, 'cmp-styles.json')}`)
  console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}  ${passes} 通过 / ${fails} 失败`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针异常:', e.message); process.exit(1) })
