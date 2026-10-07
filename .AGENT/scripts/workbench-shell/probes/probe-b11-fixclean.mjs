/**
 * B-11 第七轮：候选修法的「干净 A/B」（2026-09-22）
 *
 * 前情（第六轮已钉死）：
 *   · 竖条 = 物理 x=497..502 / y=159..275（CSS 页面左缘 x=331，从页面顶往下 77px）。
 *   · 品红鉴别：把 `br::selection` 改成品红 → 竖条那 702 个像素**变品红**（#CC2DBF），
 *     而正文那些蓝条不变 ⇒ **竖条就是用 br 自己的 `::selection` 上色的**。
 *   · 把本应用那条 `.kb-pdf-scope .pdfViewer .textLayer ::selection{rgba(0,120,255,.35)}`
 *     经 CSSOM 删掉 → br 的 `::selection` 落回上游的 `.textLayer br::selection{background:transparent}`
 *     （实算 rgba(0,0,0,0)）→ **竖条 0 像素**。
 *   · 但「先划选、再改样式」会踩 Chromium 高亮缓存的坑（P2 明明算回蓝色却仍不重绘，
 *     第四轮 T1 的截图与基线**逐字节相同**）⇒ 那种测法不可信。
 *
 * 所以本轮改用**真实条件**：样式先挂好，再重新划选（每次都是新的 selection）。
 *   F0 基线：无补丁 → 划选 → 预期竖条在
 *   F1 候选修法：`br::selection{background:transparent}`（镜像上游那条守卫，靠更高特异度生效）
 *                → 清掉旧选区 → 重新划选 → 预期**竖条消失、正文蓝条保留**
 *   F2 撤掉补丁 → 清选区 → 再划选 → 预期竖条回来（可逆）
 * 同时打印 br / span 的 ::selection 计算值（确认补丁真的落到 br 上）。
 *
 * 用法：
 *   KNOWBASE_PROBE_PORT=9333 KNOWBASE_PROBE_VAULT=演示 node \
 *     .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-b11-fixclean.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const EXPECT_VAULT = process.env.KNOWBASE_PROBE_VAULT ?? '演示'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOT_DIR = join(process.cwd(), 'tmp', 'probe-shots')

/** 候选修法（镜像上游 pdf.js 的那条 Chrome 守卫，但特异度高于本应用的蓝色规则） */
const FIX_CSS = '.kb-pdf-scope .pdfViewer .textLayer br::selection { background: transparent; }'

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

const setFix = (on) => `(() => {
  document.getElementById('b11-fix')?.remove()
  ${on ? `const s = document.createElement('style'); s.id = 'b11-fix'; s.textContent = ${JSON.stringify(FIX_CSS)}; document.head.appendChild(s)` : ''}
  return !!document.getElementById('b11-fix')
})()`

const JS_SELBG = `(() => {
  const layer = document.querySelector('.kb-pdf-scope .textLayer')
  const br = layer && layer.querySelector('br')
  const span = layer && layer.querySelector('span')
  const g = (el) => { try { return getComputedStyle(el, '::selection').backgroundColor } catch (e) { return 'throw' } }
  return { br: g(br), span: g(span), sel: String(document.getSelection() || '').slice(0, 34) }
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
    return { pageLeft: Math.round(pr.left), pageTop: Math.round(pr.top), lines: lines.slice(0, 12) }
  })()`)
  console.log('[几何] 页面 left', geo.pageLeft, 'top', geo.pageTop)
  const L = geo.lines
  if (L.length < 6) { console.error('正文行不足'); process.exit(3) }
  const clear = () => evalJs(`(() => { document.getSelection()?.removeAllRanges(); return true })()`)

  // 每次都是全新划选（避开 Chromium 高亮缓存）
  const drag = async (tag, shotName) => {
    await clear()
    await sleep(250)
    await realDrag(L[0].l + 2, L[0].cy, L[4].r - 2, L[4].cy)
    await sleep(700)
    const c = await evalJs(JS_SELBG)
    console.log(`\n===== ${tag} =====`)
    console.log('  ::selection  br=' + c.br + '  span=' + c.span)
    console.log('  选区:', JSON.stringify(c.sel))
    console.log('  截图:', await shot(shotName))
  }

  await evalJs(setFix(false))
  await drag('F0 基线（无补丁）', 'b11fix2-F0')

  await evalJs(setFix(true))
  console.log('\n[补丁已挂] ' + FIX_CSS)
  await drag('F1 挂候选修法 `br::selection{background:transparent}`（先挂后划）', 'b11fix2-F1')

  await evalJs(setFix(false))
  await drag('F2 撤掉补丁（应同 F0）', 'b11fix2-F2')

  console.log('\n[提示] 三张图交 E:/tmp/scan-b11-fix2.ps1：只认竖条带（物理 x 490..512 / y 140..300）。')
  console.log('===== 探针结束 =====')
  process.exit(0)
}

main().catch((e) => { console.error('探针异常:', e); process.exit(1) })
