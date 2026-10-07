/**
 * B-11 第二轮取证：页面左缘那条「竖直浅蓝柱」（2026-09-22）
 *
 * 前情：第一轮 `probe-b11-pdf-edge.mjs` 只查了 `outline / border-left / box-shadow`
 * 三类「能画出一条线」的东西，结果是**全树零命中、现象未复现**。
 * 本轮用户给了一张真截图（worktree 的「截图提示」目录），对截图做了逐像素量化，得到硬数据：
 *
 *   位置 x = 64..69（6px 宽）、y = 18..139（122px 高），正好贴在**页面的左边缘**上；
 *   颜色两色：C3D4E2（占 73%）+ 90B3D6（占 27%），后者是前者的「加深版」；
 *   加深段 4 条，h≈8px，间距 ≈22.7px（而同一张图里正文选区色块是 h=25px、间距 42px）。
 *   → 关键对照：C3D4E2 与**同图正文选区的实测主色**逐字节相同（选区：C3D4E2 占 77%）。
 *
 * 所以本轮不再查「线」，改查两件第一轮**根本没查**的事：
 *   A) 带 **background**（而不是 border/outline）的窄竖条 —— 也就是「有一块底色」的元素；
 *   B) `elementsFromPoint` 在页面左缘那一列上到底命中谁（含 z 序）。
 *
 * 另补两个「第一轮没试过」的状态，因为第一轮只选了一行标题：
 *   C) 真实**多行拖选**（用户截图里正是正文六行被选中 + 摘录浮条在）；
 *   D) 把鼠标**悬停**在页面左缘（有些边缘元素只在 hover 才显形）。
 *
 * 前置：dev userData 的 currentVaultId 指向放着样书的仓库（本机 = 演示 / E:\演示）。
 *       当前该实例已是 演示，故无需改动；若自证失败会 exit(3)。
 *
 * 用法：
 *   KNOWBASE_PROBE_PORT=9333 KNOWBASE_PROBE_VAULT=演示 node \
 *     .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-b11-left-column.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const EXPECT_VAULT = process.env.KNOWBASE_PROBE_VAULT ?? '演示'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOT_DIR = join(process.cwd(), 'tmp', 'probe-shots')

async function waitPage() {
  for (let i = 0; i < 40; i++) {
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
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('evaluate 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result?.value
}
async function shot(name, clip) {
  try {
    mkdirSync(SHOT_DIR, { recursive: true })
    const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' })
    writeFileSync(join(SHOT_DIR, name + '.png'), Buffer.from(r.data, 'base64'))
    return join(SHOT_DIR, name + '.png')
  } catch (e) { return 'shot 失败 ' + e.message }
}
async function realDrag(x1, y1, x2, y2) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 1 })
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1,
      x: Math.round(x1 + (x2 - x1) * i / steps), y: Math.round(y1 + (y2 - y1) * i / steps),
    })
    await sleep(40)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1, buttons: 0 })
}

/**
 * 本轮主查询：
 *  A) 全文档「窄竖条」普查 —— 宽度 ≤ 14 且高度 ≥ 24 的元素（含 background，不限 border/outline）
 *  B) 页面左缘那一列上 elementsFromPoint 命中链（含 z 序、背景、透明度）
 *  C) 页面 / 文本层 / 选区 / 滚动宿主的几何与变换（找缩放不一致的迹象）
 */
const JS_CENSUS = `(() => {
  const scope = document.querySelector('.kb-pdf-scope')
  const pageEl = scope && scope.querySelector('.pdfViewer .page')
  const pr = pageEl ? pageEl.getBoundingClientRect() : null
  const desc = (el) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      tag: el.tagName,
      wb: el.getAttribute('data-wb') || '',
      cls: (el.className || '').toString().slice(0, 60),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      bg: cs.backgroundColor,
      bgImg: cs.backgroundImage === 'none' ? '' : cs.backgroundImage.slice(0, 60),
      border: cs.borderLeftStyle + ' ' + cs.borderLeftWidth + ' ' + cs.borderLeftColor,
      shadow: cs.boxShadow === 'none' ? '' : cs.boxShadow.slice(0, 50),
      opacity: cs.opacity,
      z: cs.zIndex,
      tf: cs.transform === 'none' ? '' : cs.transform.slice(0, 40),
      ovf: cs.overflowX + '/' + cs.overflowY,
    }
  }
  // A) 窄竖条
  const narrow = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width > 14 || r.height < 24) continue
    if (r.width === 0 || r.height === 0) continue
    const cs = getComputedStyle(el)
    const painted = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none'
      || (cs.borderLeftStyle !== 'none' && parseFloat(cs.borderLeftWidth) > 0)
    if (!painted) continue
    narrow.push(desc(el))
  }
  // A2) 左带普查 —— 窗口左侧 110px 内、自身宽度 ≤ 110px、高 ≥ 18px 的元素
  //     （用户截图里左带 x=0..63 是暖灰面板、x=64..69 是那条蓝柱，两者都要现形）
  const leftBand = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.left >= 110 || r.width > 110 || r.height < 18 || r.width === 0) continue
    leftBand.push(desc(el))
  }
  leftBand.sort((a, b) => a.rect[0] - b.rect[0] || a.rect[1] - b.rect[1])
  // B) 左缘命中原子的层链（每 60px 采一次，避开页面顶部/底部的留白）
  const probes = []
  if (pr) {
    for (const dy of [40, 120, 260, 420, 620]) {
      const x = Math.round(pr.left - 3)
      const y = Math.round(pr.top + dy)
      if (y > window.innerHeight - 4) continue
      const chain = document.elementsFromPoint(x, y).slice(0, 6).map(desc)
      probes.push({ x, y, chain })
    }
  }
  const layerGeo = (sel) => {
    const el = sel ? document.querySelector(sel) : null
    if (!el) return null
    const cs = getComputedStyle(el)
    return { rect: (() => { const r = el.getBoundingClientRect()
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })()
      , bg: cs.backgroundColor, tf: cs.transform, ovf: cs.overflowX + '/' + cs.overflowY,
      cls: (el.className || '').toString().slice(0, 50) }
  }
  return {
    win: [window.innerWidth, window.innerHeight, window.devicePixelRatio],
    page: layerGeo('.kb-pdf-scope .pdfViewer .page'),
    viewer: layerGeo('.kb-pdf-scope .pdfViewer'),
    scroll: layerGeo('.kb-pdf-scope .kb-pdf-scroll'),
    scopeEl: layerGeo('.kb-pdf-scope'),
    textLayer: layerGeo('.kb-pdf-scope .textLayer'),
    canvas: layerGeo('.kb-pdf-scope .pdfViewer .page canvas'),
    pdfRail: (() => { const el = document.querySelector('[data-wb="pdfRailPanel"]'); if (!el) return null
      const r = el.getBoundingClientRect()
      return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        cls: (el.className || '').toString().slice(0, 60) } })(),
    narrow: narrow.slice(0, 24),
    narrowTotal: narrow.length,
    leftBand: leftBand.slice(0, 30),
    leftBandTotal: leftBand.length,
    probes,
    sel: String(document.getSelection?.() || '').slice(0, 60),
  }
})()`

function dumpCensus(tag, c) {
  console.log(`\n===== ${tag} =====`)
  for (const k of ['scopeEl', 'scroll', 'viewer', 'page', 'textLayer', 'canvas', 'pdfRail']) {
    if (c[k]) console.log(`  ${k}:`, JSON.stringify(c[k]))
  }
  console.log(`  窄竖条候选 ${c.narrowTotal} 个：`)
  for (const n of c.narrow) console.log('   ·', JSON.stringify(n))
  console.log(`  左带元素 ${c.leftBandTotal} 个（按 left,top 排序）：`)
  for (const n of c.leftBand) console.log('   ◇', JSON.stringify(n))
  for (const p of c.probes) {
    console.log(`  elementsFromPoint(${p.x},${p.y}) 层链：`)
    for (const el of p.chain) console.log('      -', JSON.stringify(el))
  }
}

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')

  for (let i = 0; i < 30; i++) {
    const n = await evalJs(`document.querySelector('#root')?.children.length ?? 0`)
    if (n > 0) break
    await sleep(500)
  }
  const picker = await evalJs(`(() => {
    const txt = document.body.textContent || ''
    if (!txt.includes('选择要进入的仓库')) return 'no-picker'
    const pick = (label) => {
      const c = [...document.querySelectorAll('button,a,div,span')].filter(el => (el.textContent || '').trim() === label)
      const t = c.find(el => el.tagName === 'BUTTON') || c[c.length - 1]
      if (t) t.click(); return !!t
    }
    pick('跳过，直接进入上次使用的仓库'); return 'skip'
  })()`)
  console.log('[前置] 仓库选择浮层:', picker)
  await sleep(1500)

  const vaultName = await evalJs(`(async () => { try { const c = await window.api.workspaceGetCurrent(); return c?.name ?? null } catch { return null } })()`)
  console.log('[实例自证] vault =', vaultName, '(期望', EXPECT_VAULT + ')')
  if (vaultName !== EXPECT_VAULT) {
    console.error('不是目标仓库（样书在另一个仓库的 .books）→ 终止。请先临时改 dev settings 的 currentVaultId。')
    process.exit(3)
  }

  // 1) 书架 → 打开 PDF 样书
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="bookshelf"]')?.click(); return true })()`)
  await sleep(1500)
  const picked = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('main button')].filter(b => (b.getAttribute('title') || '').toLowerCase().endsWith('.pdf'))
    const card = cards.find(b => /Reader Sample|样书|Sample/i.test(b.getAttribute('title') || '')) || cards[0]
    if (!card) return { ok: false, titles: [...document.querySelectorAll('main button')].map(b => b.getAttribute('title')).filter(Boolean).slice(0, 8) }
    card.click()
    return { ok: true, title: card.getAttribute('title') }
  })()`)
  console.log('[打开样书]', JSON.stringify(picked))
  if (!picked?.ok) { console.error('没找到 PDF 卡片'); process.exit(3) }

  let spans = 0
  for (let i = 0; i < 40; i++) {
    spans = await evalJs(`document.querySelectorAll('.kb-pdf-scope .textLayer span').length`).catch(() => 0)
    if (spans > 30) break
    await sleep(800)
  }
  console.log('[文本层] span =', spans)
  await sleep(1500)

  const c0 = await evalJs(JS_CENSUS)
  console.log('窗口 [w,h,dpr] =', JSON.stringify(c0.win))
  dumpCensus('① 未选中状态', c0)
  console.log('[截图] 未选中:', await shot('b11col-open'))

  // 2) 真实多行拖选（用户截图的状态：正文六行蓝色选区 + 摘录浮条）
  const dragBox = await evalJs(`(() => {
    const spans = [...document.querySelectorAll('.kb-pdf-scope .textLayer span')]
      .filter(el => (el.textContent || '').trim().length > 12)
    if (spans.length < 2) return null
    const a = spans[0].getBoundingClientRect(), b = spans[Math.min(5, spans.length - 1)].getBoundingClientRect()
    return { x1: Math.round(a.left + 2), y1: Math.round(a.top + a.height / 2),
             x2: Math.round(b.right - 2), y2: Math.round(b.top + b.height / 2) }
  })()`)
  if (dragBox) {
    await realDrag(dragBox.x1, dragBox.y1, dragBox.x2, dragBox.y2)
    await sleep(900)
    const c1 = await evalJs(JS_CENSUS)
    console.log('选区:', JSON.stringify(c1.sel))
    dumpCensus('② 多行拖选后', c1)
    console.log('[截图] 选中后:', await shot('b11col-selected'))
    if (c1.page) {
      const clip = { x: Math.max(0, c1.page.rect[0] - 30), y: 40, width: 110, height: 560, scale: 3 }
      console.log('[截图] 左缘 3x:', await shot('b11col-left-edge', clip))
    }
  } else {
    console.log('[拖选] 没找到够长的 span')
  }

  // 3) 鼠标悬停在页面左缘（有些边缘元素只在 hover 显形）
  if (c0.page) {
    const hx = Math.round(c0.page.rect[0] - 3), hy = Math.round(c0.page.rect[1] + 200)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y: hy, button: 'none' })
    await sleep(700)
    console.log('\n===== ③ 悬停在页面左缘 (' + hx + ',' + hy + ') =====')
    const chain = await evalJs(`document.elementsFromPoint(${hx}, ${hy}).slice(0, 6).map(el => {
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect()
      return { tag: el.tagName, wb: el.getAttribute('data-wb') || '', cls: (el.className||'').toString().slice(0,60),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        bg: cs.backgroundColor, border: cs.borderLeftStyle + ' ' + cs.borderLeftWidth + ' ' + cs.borderLeftColor }
    })`)
    for (const el of chain) console.log('   -', JSON.stringify(el))
    console.log('[截图] 悬停后:', await shot('b11col-hover'))
  }

  console.log('\n===== 素材就绪（截图 + 上面三张表） =====')
  process.exit(0)
}

main().catch((e) => { console.error('探针异常:', e); process.exit(1) })
