/**
 * B-11 第三轮取证：页面左缘那条 4×81 竖条到底是谁画的（2026-09-22）
 *
 * 前两轮结论：
 *   · 第一轮（probe-b11-pdf-edge）只查 outline / border-left / box-shadow → 全树零命中。
 *   · 第二轮（probe-b11-left-column）按背景普查全文档窄竖条 + elementsFromPoint 左缘层链
 *     → 仍未命中；且逐像素量化认定：那条东西是**硬边实心矩形**（截图 6×122 px，
 *     dpr=1.5 → 4×81 CSS px），紧贴页面左边缘（窗口 x 327..331，页面左缘 331）。
 *   · 关键排除：本仓 演示 仓库里 3 条 pdf 摘录全在第 1 页、rects 规整（l≈0.107），
 *     且第二轮的实例根本没在视口里画过任何 .kb-excerpt-hl → 不是摘录叠加层。
 *
 * 于是问题收敛成：**浏览器自己画的选区高亮**。浏览器只画 selection range 的 client rects，
 * 所以不需要截图解码 —— 直接把每一段拖选后的 `getClientRects()` 打出来就能定性：
 * 若某个 rect 是「宽 ≤ 12 且高 ≥ 30、且 left 贴着页面左缘」，那条竖条就是它。
 *
 * 本轮唯一自变量 = **按下鼠标的位置**（前两轮都是「从正文 span 起拖」，用户那张截图多半不是）：
 *   A 从正文第一行 span 里起拖（对照：前两轮复现不出）
 *   B 从**页面左缘外侧的空白（页面左缘 - 3px）**起拖 —— 命中 .page 而不是 .textLayer span
 *   C 从 PDF 滚动区更外侧的灰底（页面左缘 - 30px）起拖
 *   D 从页面左缘起拖、但起点竖直落在页面中部（页面顶 + 300）
 *
 * 用法：
 *   KNOWBASE_PROBE_PORT=9333 KNOWBASE_PROBE_VAULT=演示 node \
 *     .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-b11-dragrects.mjs
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
      const page = (await res.json()).find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* electron 未起 */ }
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
    return 'tmp/probe-shots/' + name + '.png'
  } catch (e) { return 'shot 失败 ' + e.message }
}
async function realDrag(x1, y1, x2, y2) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 1 })
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1,
      x: Math.round(x1 + (x2 - x1) * i / steps), y: Math.round(y1 + (y2 - y1) * i / steps),
    })
    await sleep(35)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(500)
}

/** 读出当前选区的 client rects（浏览器就是按这些矩形画高亮的） */
const JS_SELRects = `(() => {
  const sel = document.getSelection()
  const page = document.querySelector('.kb-pdf-scope .pdfViewer .page')
  const layer = document.querySelector('.kb-pdf-scope .pdfViewer .page .textLayer')
  const pr = page ? page.getBoundingClientRect() : null
  const lr = layer ? layer.getBoundingClientRect() : null
  const out = { pageLeft: pr ? Math.round(pr.left) : null, pageTop: pr ? Math.round(pr.top) : null,
                layerLeft: lr ? Math.round(lr.left) : null, layerTop: lr ? Math.round(lr.top) : null,
                text: '', rects: [], anchor: null }
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return out
  out.text = String(sel).slice(0, 50)
  const rc = sel.getRangeAt(0)
  const sc = rc.startContainer
  const el = sc instanceof Element ? sc : sc.parentElement
  out.anchor = el ? { tag: el.tagName, cls: (el.className || '').toString().slice(0, 50),
                      inTextLayer: !!(layer && layer.contains(el)), inPage: !!(page && page.contains(el)) } : null
  out.rects = [...rc.getClientRects()].map((r) => ({
    l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
  }))
  return out
})()`

function report(tag, s, shotName) {
  console.log(`\n===== ${tag} =====`)
  if (!s) { console.log('  (无选区)'); return }
  console.log(`  页面左缘 x=${s.pageLeft} 顶 y=${s.pageTop}；textLayer 左缘 x=${s.layerLeft} 顶 y=${s.layerTop}`)
  console.log('  选中文本:', JSON.stringify(s.text))
  console.log('  startContainer:', JSON.stringify(s.anchor))
  console.log(`  client rects 共 ${s.rects.length} 个：`)
  for (const r of s.rects) {
    const odd = r.w <= 12 && r.h >= 30 ? '   ★ 窄高条（疑似 B-11 那条）' : ''
    const wide = r.w >= 200 && r.h <= 40 ? '' : '   ← 非整行'
    console.log(`    x=${r.l} y=${r.t} w=${r.w} h=${r.h}${odd}${wide}`)
  }
  if (shotName) console.log('  截图:', shotName)
}

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
    }
  }
  await send('Runtime.enable'); await send('Page.enable')
  for (let i = 0; i < 30; i++) {
    const n = await evalJs(`document.querySelector('#root')?.children.length ?? 0`)
    if (n > 0) break
    await sleep(500)
  }
  await evalJs(`(() => {
    const txt = document.body.textContent || ''
    if (!txt.includes('选择要进入的仓库')) return 'no-picker'
    const c = [...document.querySelectorAll('button,a,div,span')].filter(el => (el.textContent || '').trim() === '跳过，直接进入上次使用的仓库')
    const t = c.find(el => el.tagName === 'BUTTON') || c[c.length - 1]
    if (t) t.click(); return 'skip'
  })()`)
  await sleep(1500)
  const vaultName = await evalJs(`(async () => { try { const c = await window.api.workspaceGetCurrent(); return c?.name ?? null } catch { return null } })()`)
  console.log('[实例自证] vault =', vaultName)
  if (vaultName !== EXPECT_VAULT) { console.error('不是目标仓库 → 终止'); process.exit(3) }

  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="bookshelf"]')?.click(); return true })()`)
  await sleep(1500)
  const picked = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('main button')].filter(b => (b.getAttribute('title') || '').toLowerCase().endsWith('.pdf'))
    const card = cards.find(b => /Reader Sample|样书|Sample/i.test(b.getAttribute('title') || '')) || cards[0]
    if (!card) return { ok: false }
    card.click(); return { ok: true, title: card.getAttribute('title') }
  })()`)
  console.log('[打开样书]', JSON.stringify(picked))
  if (!picked?.ok) process.exit(3)
  let spans = 0
  for (let i = 0; i < 40; i++) {
    spans = await evalJs(`document.querySelectorAll('.kb-pdf-scope .textLayer span').length`).catch(() => 0)
    if (spans > 30) break
    await sleep(800)
  }
  console.log('[文本层] span =', spans)
  await sleep(1200)

  // 取页面几何 + 正文行坐标（供四种起拖点使用）
  const geo = await evalJs(`(() => {
    const page = document.querySelector('.kb-pdf-scope .pdfViewer .page')
    const pr = page.getBoundingClientRect()
    const lines = [...document.querySelectorAll('.kb-pdf-scope .textLayer span')]
      .filter(el => (el.textContent || '').trim().length > 12)
      .map(el => { const r = el.getBoundingClientRect()
        return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), cy: Math.round(r.top + r.height / 2) } })
      .filter(v => v.cy > 0 && v.cy < window.innerHeight)
    return { pageLeft: Math.round(pr.left), pageTop: Math.round(pr.top), pageRight: Math.round(pr.right), lines: lines.slice(0, 12) }
  })()`)
  console.log('[几何] 页面 x', geo.pageLeft, '..', geo.pageRight, ' 顶 y', geo.pageTop)
  console.log('[几何] 正文行:', JSON.stringify(geo.lines.slice(0, 8)))
  const L = geo.lines
  if (L.length < 4) { console.error('正文行不足'); process.exit(3) }
  const clear = () => evalJs(`(() => { document.getSelection()?.removeAllRanges(); return true })()`).catch(() => {})

  // A) 从正文第一行 span 里起拖（对照）
  await clear()
  await realDrag(L[0].l + 2, L[0].cy, L[3].r - 2, L[3].cy)
  report('A 从正文 span 起拖（对照）', await evalJs(JS_SELRects), await shot('b11drag-A'))

  // B) 从页面左缘外侧 3px 起拖（落在 .page 上，不在 textLayer span 上）
  await clear()
  await realDrag(geo.pageLeft - 3, L[0].cy, L[3].r - 2, L[3].cy)
  report('B 从页面左缘 -3px 起拖', await evalJs(JS_SELRects), await shot('b11drag-B'))

  // C) 从更外侧的灰底（页面左缘 -30px）起拖
  await clear()
  await realDrag(geo.pageLeft - 30, L[0].cy, L[3].r - 2, L[3].cy)
  report('C 从页面左缘 -30px（灰底）起拖', await evalJs(JS_SELRects), await shot('b11drag-C'))

  // D) 从页面左缘起拖，起点竖直落在页面中部（模拟用户「从边缘往下拉」）
  await clear()
  const yMid = Math.round(geo.pageTop + 300)
  await realDrag(geo.pageLeft - 3, yMid, L[L.length - 1].r - 2, L[L.length - 1].cy)
  report('D 从页面左缘 -3px、页面中部起拖', await evalJs(JS_SELRects), await shot('b11drag-D'))

  // E) 从页面左缘、页面顶部（+30）起拖 —— 与截图里那条竖条的 y 起点最接近的猜测
  await clear()
  await realDrag(geo.pageLeft - 3, geo.pageTop + 30, L[3].r - 2, L[3].cy)
  report('E 从页面左缘 -3px、页面顶 +30 起拖', await evalJs(JS_SELRects), await shot('b11drag-E'))

  console.log('\n===== 探针结束 =====')
  process.exit(0)
}

main().catch((e) => { console.error('探针异常:', e); process.exit(1) })
