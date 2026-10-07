/**
 * B-11 复现探针：PDF 阅读器「页面左边缘的勾画痕迹」（2026-09-22）
 *
 * 前情：`probe-b11-scroll-focus.mjs` 已用三个独立实验**证伪** B-11 的「主推定位 A = 滚动容器聚焦虚框」——
 *   ① 真鼠标点可滚 div → 焦点留在 BODY（不给滚动容器）；
 *   ② 点击后按 PageDown → 容器**确实滚了**（scrolled=210）但焦点仍在 BODY（键盘滚动也不聚焦）；
 *   ③ Tab → 根本不把滚动容器当停留点（首个子节点里的可滚 div 被跳过）。
 *   → 本探针改为**去看真实画面**：打开样书 PDF，做真实拖选，截图 + 逐元素读 outline/border，
 *     让「那条线到底是什么」有直接证据，而不是继续推测。
 *
 * 前置（**必须**，由调用方在探针外执行，跑完复原）：
 *   把 dev userData 的 settings.json 里 currentVaultId 临时指向放着样书的仓库（本机 = 演示 / E:\演示）
 *   因为 `.books` 是**每仓库**的，当前 dev 仓库（生活与记录）里没有 PDF。
 *
 * 用法：
 *   KNOWBASE_PROBE_PORT=9333 KNOWBASE_PROBE_VAULT=演示 node \
 *     .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-b11-pdf-edge.mjs
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
async function realClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
}
/** 真拖选（按下 → 分步移动 → 松开），驱动 textLayer 选区 */
async function realDrag(x1, y1, x2, y2) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 1 })
  const steps = 6
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1,
      x: Math.round(x1 + (x2 - x1) * i / steps), y: Math.round(y1 + (y2 - y1) * i / steps),
    })
    await sleep(40)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1, buttons: 0 })
}

/** PDF 区域逐元素读「可能画出一条线」的东西：outline / border / box-shadow */
const JS_EDGE = `(() => {
  const scope = document.querySelector('.kb-pdf-scope') || document.body
  const rows = []
  for (const el of scope.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    const w = cs.borderLeftWidth, st = cs.borderLeftStyle
    const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
    const hasBorder = st !== 'none' && parseFloat(w) > 0 && cs.borderLeftColor !== 'rgba(0, 0, 0, 0)'
    const hasShadow = cs.boxShadow !== 'none'
    if (!hasOutline && !hasBorder && !hasShadow) continue
    const r = el.getBoundingClientRect()
    rows.push({
      cls: (el.className || '').toString().slice(0, 56),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      outline: hasOutline ? cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor + ' off=' + cs.outlineOffset : '',
      borderLeft: hasBorder ? st + ' ' + w + ' ' + cs.borderLeftColor : '',
      shadow: hasShadow ? cs.boxShadow.slice(0, 70) : '',
    })
  }
  const q = (s) => { const el = scope.querySelector(s); if (!el) return null
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect()
    return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
      border: cs.borderLeftStyle + ' ' + cs.borderLeftWidth + ' ' + cs.borderLeftColor,
      borderTop: cs.borderTopStyle + ' ' + cs.borderTopWidth + ' ' + cs.borderTopColor,
      shadow: cs.boxShadow.slice(0, 60), bg: cs.backgroundColor } }
  return {
    rows: rows.slice(0, 14),
    total: rows.length,
    page: q('.pdfViewer .page'),
    viewer: q('.pdfViewer'),
    scroll: q('.kb-pdf-scroll'),
    textLayer: q('.textLayer'),
    activeEl: (() => { const a = document.activeElement
      if (!a || a === document.body) return 'BODY'
      const cs = getComputedStyle(a)
      return a.tagName + '.' + (a.className || '').toString().slice(0, 40) + ' :focus-visible=' + a.matches(':focus-visible') + ' outline=' + cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor })(),
    sel: String(document.getSelection?.() || '').slice(0, 40),
  }
})()`

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

  // 2) 等文本层
  let spans = 0
  for (let i = 0; i < 40; i++) {
    spans = await evalJs(`document.querySelectorAll('.kb-pdf-scope .textLayer span').length`).catch(() => 0)
    if (spans > 30) break
    await sleep(800)
  }
  console.log('[文本层] span =', spans)
  await sleep(1200)

  const shotFull = await shot('b11-pdf-open')
  console.log('[截图] 打开后:', shotFull)
  const st0 = await evalJs(JS_EDGE)
  console.log('\n--- 打开后（未选中）左边缘候选 ---')
  console.log('activeElement:', st0.activeEl, '| sel:', JSON.stringify(st0.sel))
  console.log('page:', JSON.stringify(st0.page))
  console.log('scroll:', JSON.stringify(st0.scroll))
  console.log('textLayer:', JSON.stringify(st0.textLayer))
  console.log('候选元素数:', st0.total)
  for (const r of st0.rows) console.log('  ', JSON.stringify(r))

  // 左边缘放大截图（3x），便于肉眼判虚线/实线
  const clipLeft = {
    x: Math.max(0, (st0.page?.rect?.[0] ?? 100) - 40), y: 90,
    width: 120, height: 520, scale: 3,
  }
  const shotLeft0 = await shot('b11-pdf-left-edge-unselected', clipLeft)
  console.log('[截图] 左边缘放大（未选中）:', shotLeft0)

  // 3) 真实拖选一行文字 → 再取证（用户截图里正是「有选区」的状态）
  const lineBox = await evalJs(`(() => {
    const s = [...document.querySelectorAll('.kb-pdf-scope .textLayer span')].find(el => (el.textContent || '').trim().length > 12)
    if (!s) return null
    const r = s.getBoundingClientRect()
    return { x1: Math.round(r.left + 2), x2: Math.round(r.right - 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (lineBox) {
    await realDrag(lineBox.x1, lineBox.y, lineBox.x2, lineBox.y)
    await sleep(700)
    const sel = await evalJs(`String(document.getSelection?.() || '').slice(0, 60)`)
    console.log('\n[拖选] 选区文本:', JSON.stringify(sel))
    const st1 = await evalJs(JS_EDGE)
    console.log('activeElement:', st1.activeEl)
    console.log('候选元素数:', st1.total)
    for (const r of st1.rows) console.log('  ', JSON.stringify(r))
    const shotFull1 = await shot('b11-pdf-after-select')
    const shotLeft1 = await shot('b11-pdf-left-edge-selected', clipLeft)
    console.log('[截图] 选中后:', shotFull1, '| 左边缘放大:', shotLeft1)
  } else {
    console.log('[拖选] 没找到够长的 span')
  }

  console.log('\n===== 结论素材已就绪（人工看截图 + 上面的候选元素表即可定性） =====')
  process.exit(0)
}

main().catch((e) => { console.error('探针异常:', e); process.exit(1) })
