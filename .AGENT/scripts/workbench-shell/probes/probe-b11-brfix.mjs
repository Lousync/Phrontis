/**
 * B-11 第四轮取证：那条浅蓝竖条 = 谁画的（A/B 打补丁，2026-09-22）
 *
 * 前三轮把范围收干：
 *   · 一二轮：全文档窄竖条 / 左带 / 层级链普查 → **DOM 里没有任何元素带那个底色**。
 *   · 第三轮：量选区的 `Range.getClientRects()` → 多行拖选时每个换行处出现一个
 *     `w=0 h=20.7` 的矩形，统统贴在文本层左缘（x=331），间距 15.1px。间距 15.1
 *     的来源是本应用自己的命中盒补白（`--kb-hit-pad`，20.7 − 5.6 ≈ 15.1）。
 *     → 结论：那是**浏览器画的选区高亮**，不是我们的元素。
 *
 * 第四轮要单独坐实「哪条 CSS 在给它上色」。已查到的两条规则：
 *   上游 pdf.js（node_modules/pdfjs-dist/web/pdf_viewer.css）：
 *     `.textLayer br::selection { background: transparent }`   ← 特异度 (0,1,1)
 *     注释写明：Avoids https://github.com/mozilla/pdf.js/issues/13840 in Chrome
 *   本应用（src/components/shared/pdf/pdfViewerTheme.css）：
 *     `.kb-pdf-scope .pdfViewer .textLayer ::selection { background: rgba(0,120,255,.35) }`  ← (0,3,0)
 *   特异度 3 类 > 1 类 + 1 标签 ⇒ **本应用的规则赢**，把上游刻意留的「换行处不着色」盖掉了。
 *
 * 所以本轮不做推理，直接 A/B：
 *   T0 拖选 5 行（复现：应出现那条竖条）→ 截图
 *   T1 注入 `br::selection { background: transparent !important }` → 截图（预期：竖条消失、正文蓝选区保留）
 *   T2 换注 `::selection { background: transparent !important }`（全部选区着色关掉）→ 截图（对照：竖条也应消失）
 *   T3 撤掉注入、回到 T0 状态 → 截图（预期：竖条回来 = 可逆、确因该规则）
 * 同时打印 br 的几何 / 补白 / 逐行矩形，以及 `getComputedStyle(br,'::selection')`（若引擎支持）。
 *
 * 用法：
 *   KNOWBASE_PROBE_PORT=9333 KNOWBASE_PROBE_VAULT=演示 node \
 *     .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-b11-brfix.mjs
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
async function shot(name) {
  try {
    mkdirSync(SHOT_DIR, { recursive: true })
    const r = await send('Page.captureScreenshot', { format: 'png' })
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
  await sleep(400)
}

/** 注入/替换一条测试样式 */
const setStyle = (id, css) => `(() => {
  document.getElementById('${id}')?.remove()
  ${css ? `const s = document.createElement('style'); s.id = '${id}'; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s)` : ''}
  return !!document.getElementById('${id}')
})()`

/** 量换行处那些 w=0 的矩形 + br 自身几何 + ::selection 计算值 */
const JS_BR = `(() => {
  const layer = document.querySelector('.kb-pdf-scope .textLayer')
  if (!layer) return { err: 'no textLayer' }
  const lr = layer.getBoundingClientRect()
  const brs = [...layer.querySelectorAll('br')].map((el) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    let selBg = 'n/a'
    try { selBg = getComputedStyle(el, '::selection').backgroundColor } catch (e) { selBg = 'throw:' + e.name }
    return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      padT: cs.paddingTop, marT: cs.marginTop, disp: cs.display, pos: cs.position,
      selBg, font: cs.fontSize + '/' + cs.lineHeight }
  })
  const sel = document.getSelection()
  const zero = []
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    for (const r of sel.getRangeAt(0).getClientRects()) {
      if (r.width < 1) zero.push([Math.round(r.left), Math.round(r.top), Math.round(r.height)])
    }
  }
  return { layerLeft: Math.round(lr.left), layerTop: Math.round(lr.top),
           brCount: brs.length, brs: brs.slice(0, 3),
           brAll: brs.map(b => b.rect), zeroWidthRects: zero,
           selText: String(sel || '').slice(0, 40) }
})()`

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

  const geo = await evalJs(`(() => {
    const page = document.querySelector('.kb-pdf-scope .pdfViewer .page')
    const pr = page.getBoundingClientRect()
    const lines = [...document.querySelectorAll('.kb-pdf-scope .textLayer span')]
      .filter(el => (el.textContent || '').trim().length > 12)
      .map(el => { const r = el.getBoundingClientRect()
        return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), cy: Math.round(r.top + r.height / 2) } })
      .filter(v => v.cy > 0 && v.cy < window.innerHeight)
    return { pageLeft: Math.round(pr.left), pageTop: Math.round(pr.top), w: Math.round(pr.width), lines: lines.slice(0, 12) }
  })()`)
  console.log('[几何] 页面 left', geo.pageLeft, 'top', geo.pageTop, 'w', geo.w)
  const L = geo.lines
  if (L.length < 6) { console.error('正文行不足 6 行'); process.exit(3) }
  const clear = () => evalJs(`(() => { document.getSelection()?.removeAllRanges(); return true })()`).catch(() => {})

  // 拖选 5 行（= 5 个换行矩形；用户截图里那条 81 CSS px 高 = 4×15.1 + 20.7，正是 5 行）
  const y1 = L[0].cy, y2 = L[4].cy
  console.log(`[拖选] 第 1..5 行  y=${y1} → ${y2}`)
  await clear()
  await realDrag(L[0].l + 2, y1, L[4].r - 2, y2)
  console.log('\n===== T0 基线（未打补丁） =====')
  console.log(JSON.stringify(await evalJs(JS_BR), null, 1))
  console.log('  截图:', await shot('b11fix-T0'))

  // T1: 只让换行处的选区恢复透明（上游原意）
  await evalJs(setStyle('b11-t1', '.kb-pdf-scope .pdfViewer .textLayer br::selection{background:transparent !important}'))
  await sleep(500)
  console.log('\n===== T1 `br::selection{background:transparent}` =====')
  console.log(JSON.stringify(await evalJs(JS_BR), null, 1))
  console.log('  截图:', await shot('b11fix-T1'))

  // T2: 关掉全部选区着色（对照：竖条也该消失，但正文蓝选区一起没）
  await evalJs(setStyle('b11-t1', ''))
  await evalJs(setStyle('b11-t2', '.kb-pdf-scope .pdfViewer .textLayer ::selection{background:transparent !important}'))
  await sleep(500)
  console.log('\n===== T2 全部选区透明（对照） =====')
  console.log('  截图:', await shot('b11fix-T2'))

  // T3: 撤掉补丁，回到基线（可逆性）
  await evalJs(setStyle('b11-t2', ''))
  await sleep(500)
  console.log('\n===== T3 撤销补丁（应与 T0 一致） =====')
  console.log('  截图:', await shot('b11fix-T3'))

  console.log('\n[提示] 四张图交给 E:\\tmp\\scan-b11fix.ps1 逐像素比对：看页面左缘外侧那条浅蓝竖条在 T0/T3 有、在 T1/T2 无。')
  console.log('===== 探针结束 =====')
  process.exit(0)
}

main().catch((e) => { console.error('探针异常:', e); process.exit(1) })
