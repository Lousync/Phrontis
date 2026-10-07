/**
 * B-11 第五轮取证：那条竖条到底由「哪个元素」的选区样式上色（2026-09-22）
 *
 * 第四轮结果（决定性）：
 *   · 本机复现成功：截图里那条竖条物理 x=497..502（= CSS 331.3..334.7，页面左缘 331）、
 *     y 物理 159..275（= CSS 106..183，正好从页面顶开始 77px），颜色 #C4D5E2 + #90B4D6 ——
 *     与用户截图上量到的 C3D4E2 / 90B3D6 一致。
 *   · 几何对照：多行拖选时，`Range.getClientRects()` 里那些 `w=0 h=21` 的矩形正好 5 个、
 *     落在 y=103/118/133/148/164（间距 15.1 = 命中盒补白压缩后的行高）。竖条的 106..183
 *     与之逐像素吻合 ⇒ 竖条 = **这些换行盒的选区高亮**。
 *   · 但 A/B 推翻了「br::selection 在给它上色」：
 *       T0 基线          : 记 702 个蓝像素
 *       T1 `br::selection{background:transparent!important}` : **一模一样 702 个**（md5 与 T0 相同）
 *       T2 `.textLayer ::selection{background:transparent!important}`（含全部后代）: 仍是 702 个
 *     ⇒ 换行盒的高亮**不是**按 br 自己的 `::selection` 算的。
 *
 * 由此推定的机制：这些 <br> 在 pdf.js 的文本层里是**普通流**（span 是绝对定位，br 没有
 * 定位样式），于是它们堆在文本层左缘、落在文本层的**匿名块**里。Chromium 为「匿名块里的
 * 行盒」解析 legacy `::selection` 时取的是**该块的宿主元素**——也就是 `.textLayer` 自己。
 * 而 `.textLayer ::selection`（后代选择器）**匹配不到 .textLayer 自身**，于是落到
 * 全局那条 `::selection { background-color: color-mix(in srgb, var(--accent) 40%, transparent) }`
 * （src/styles/index.css）——这就是那条浅蓝的来源。
 *
 * 本轮三个补丁，每个都单独截图，用来钉死结论：
 *   T4 `.textLayer::selection{background:transparent!important}`  ← 推定命中：竖条应消失、正文蓝选区应保留
 *   T5 `br{visibility:hidden!important}`                          ← 几何反证：竖条若消失，说明它确实长在 br 上
 *   T6 撤销全部补丁                                                ← 可逆性：竖条应回来
 * 同时打印 textLayer / span / br 的 `getComputedStyle(x,'::selection')` 与 --accent 取值。
 *
 * 用法：
 *   KNOWBASE_PROBE_PORT=9333 KNOWBASE_PROBE_VAULT=演示 node \
 *     .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-b11-whopaints.mjs
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

const setStyle = (id, css) => `(() => {
  document.getElementById('${id}')?.remove()
  ${css ? `const s = document.createElement('style'); s.id = '${id}'; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s)` : ''}
  return !!document.getElementById('${id}')
})()`

/** 打印「谁在给选区上色」的候选计算值 */
const JS_COLORS = `(() => {
  const scope = document.querySelector('.kb-pdf-scope')
  const layer = scope && scope.querySelector('.textLayer')
  if (!scope || !layer) return { err: 'no scope/layer' }
  const span = layer.querySelector('span')
  const br = layer.querySelector('br')
  const g = (el) => {
    if (!el) return null
    const out = {}
    for (const p of ['::selection', '::before']) {
      try { out[p] = getComputedStyle(el, p).backgroundColor } catch (e) { out[p] = 'throw:' + e.name }
    }
    const cs = getComputedStyle(el)
    out.bg = cs.backgroundColor
    out.opacity = cs.opacity
    out.display = cs.display
    return out
  }
  return {
    accentScope: getComputedStyle(scope).getPropertyValue('--accent').trim(),
    accentRoot: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    hitPad: getComputedStyle(layer).getPropertyValue('--kb-hit-pad').trim(),
    layer: g(layer), span: g(span), br: g(br),
    brCount: layer.querySelectorAll('br').length,
    scopeCls: (scope.className || '').toString(),
    rootCls: (document.querySelector('[data-wb="pdfReader"]')?.className || '').toString().slice(0, 80),
  }
})()`

async function patch(id, css, tag) {
  await evalJs(setStyle('b11-p', css))
  await sleep(600)
  console.log(`\n===== ${tag} =====`)
  console.log('  补丁:', css || '(无)')
  console.log('  截图:', await shot('b11wp-' + id))
  const c = await evalJs(JS_COLORS)
  console.log('  --accent(scope) =', c.accentScope, ' | --kb-hit-pad =', c.hitPad, ' | br 数 =', c.brCount)
  const fmt = (o) => o ? `bg=${o.bg} selBg=${o['::selection']} opacity=${o.opacity}` : 'null'
  console.log('  textLayer:', fmt(c.layer))
  console.log('  span     :', fmt(c.span))
  console.log('  br       :', fmt(c.br))
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

  const geo = await evalJs(`(() => {
    const page = document.querySelector('.kb-pdf-scope .pdfViewer .page')
    const pr = page.getBoundingClientRect()
    const lines = [...document.querySelectorAll('.kb-pdf-scope .textLayer span')]
      .filter(el => (el.textContent || '').trim().length > 12)
      .map(el => { const r = el.getBoundingClientRect()
        return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), cy: Math.round(r.top + r.height / 2) } })
      .filter(v => v.cy > 0 && v.cy < window.innerHeight)
    return { pageLeft: Math.round(pr.left), pageTop: Math.round(pr.top), lines: lines.slice(0, 12) }
  })()`)
  console.log('[几何] 页面 left', geo.pageLeft, 'top', geo.pageTop)
  const L = geo.lines
  if (L.length < 6) { console.error('正文行不足'); process.exit(3) }

  // 拖选 5 行（复现 5 个换行盒）
  await evalJs(`(() => { document.getSelection()?.removeAllRanges(); return true })()`)
  await realDrag(L[0].l + 2, L[0].cy, L[4].r - 2, L[4].cy)
  console.log('[选区]', JSON.stringify(await evalJs(`String(document.getSelection()||'').slice(0,40)`)))

  await patch('T0', '', 'T0 基线（未打补丁）')
  await patch('T4', '.kb-pdf-scope .pdfViewer .textLayer::selection{background:transparent !important}', 'T4 文本层自身 ::selection 透明（推定命中）')
  await patch('T5', '.kb-pdf-scope .pdfViewer .textLayer br{visibility:hidden !important}', 'T5 br 不可见（几何反证）')
  await patch('T6', '', 'T6 撤销补丁（应与 T0 一致）')

  console.log('\n[提示] 五张图交 E:\\tmp\\scan-b11fix.ps1（改 names 后）比对：T0/T6 有竖条，T4/T5 无。')
  console.log('===== 探针结束 =====')
  process.exit(0)
}

main().catch((e) => { console.error('探针异常:', e); process.exit(1) })
